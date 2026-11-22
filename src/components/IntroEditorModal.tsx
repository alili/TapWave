import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Film,
  Mic,
  Minus,
  MousePointer,
  Music,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { AuxAudioSlot, DEFAULT_BGM_FADE_MS, HighlightMuteInterval, PodcastProjectState, SpeakerTrack } from '../types/podcast';
import {
  computeColdOpenDurationSec,
  computeIntroBgmDuckMultiplier,
  computeIntroBgmDurationSec,
  formatMmSs,
  IntroBgmVoiceWindow,
  resolveColdOpenClipWindows,
  resolveEffectiveHighlightGapSec,
  TimelineComputation,
} from '../engine/timelineEngine';
import { audioPreview } from '../engine/audioPreviewEngine';
import { BgmSourceTrimmer } from './BgmSourceTrimmer';
import {
  computeLegacyPeaksCalibration,
  HiResWaveformEnvelope,
  loadTrackHiResEnvelope,
  sampleCalibratedWaveformPoint,
} from '../engine/waveformEnvelopeLoader';

interface IntroEditorModalProps {
  open: boolean;
  embedded?: boolean;
  state: PodcastProjectState;
  timeline: TimelineComputation;
  onClose: () => void;
  onUpdateState: (updater: (prev: PodcastProjectState) => PodcastProjectState) => void;
  onImportBgm: (slot: AuxAudioSlot) => void;
  onSeekMainPlayhead: (sec: number) => void;
  onNotify?: (msg: string) => void;
}

type EditorToolMode = 'edit' | 'mute_range';

type DragAction =
  | {
      kind: 'move_hl';
      hlId: string;
      startClientX: number;
      origStartSec: number;
    }
  | {
      kind: 'trim_hl_left';
      hlId: string;
      startClientX: number;
      origIntroStartSec: number;
      origSourceStartMs: number;
      origSourceEndMs: number;
      origDurationSec: number;
    }
  | {
      kind: 'trim_hl_right';
      hlId: string;
      startClientX: number;
      origSourceStartMs: number;
      origDurationSec: number;
      maxSourceMs: number;
    }
  | {
      kind: 'move_vo';
      startClientX: number;
      origStartOffsetSec: number;
    }
  | {
      kind: 'trim_bgm_right';
      startClientX: number;
      origDurationSec: number;
      maxDurationSec: number;
    }
  | {
      kind: 'trim_bgm_left';
      startClientX: number;
      origStartSec: number;
      origDurationSec: number;
    }
  | {
      kind: 'move_bgm';
      startClientX: number;
      origStartSec: number;
    }
  | {
      kind: 'mute_range';
      trackId: string;
      startSec: number;
      endSec: number;
    }
  | {
      kind: 'scrub';
      rectLeft: number;
      rectWidth: number;
    };

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return `rgba(168, 85, 247, ${alpha})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lightenHex(hex: string, amount = 42): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return `rgb(216, 180, 254)`;
  const r = Math.min(255, ((num >> 16) & 255) + amount);
  const g = Math.min(255, ((num >> 8) & 255) + amount);
  const b = Math.min(255, (num & 255) + amount);
  return `rgb(${r}, ${g}, ${b})`;
}

interface HiResClipWaveformCanvasProps {
  hiRes?: HiResWaveformEnvelope;
  legacyPeaks: number[];
  durationMs: number;
  sliceStartMs: number;
  sliceEndMs: number;
  color: string;
  dimmed?: boolean;
  gainLinear?: number;
  sharedRefCeiling?: number;
  gainFn?: (relSec: number) => number;
}

const HiResClipWaveformCanvas: React.FC<HiResClipWaveformCanvasProps> = React.memo(
  ({
    hiRes,
    legacyPeaks,
    durationMs,
    sliceStartMs,
    sliceEndMs,
    color,
    dimmed = false,
    gainLinear = 1.0,
    sharedRefCeiling: sharedRefCeilingProp,
    gainFn,
  }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [boxSize, setBoxSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const updateSize = () => {
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width));
        const h = Math.max(1, Math.round(rect.height));
        setBoxSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
      };
      updateSize();
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(updateSize);
        ro.observe(canvas);
        return () => ro.disconnect();
      }
    }, []);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const W = Math.max(1, Math.round(rect.width));
      const H = Math.max(1, Math.round(rect.height));
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const safeDurMs = Math.max(1, durationMs || hiRes?.durationMs || sliceEndMs || 1000);
      const calibration = hiRes ?? computeLegacyPeaksCalibration(legacyPeaks);
      const sharedRefCeiling = sharedRefCeilingProp || calibration.p992Peak || 0.72;
      const yMid = H / 2;
      const maxHalfAmp = Math.max(4, H * 0.43);
      const spanMs = Math.max(1, sliceEndMs - sliceStartMs);
      const stepPx = 1;
      const halfWinRatio = Math.max(0.0001, ((spanMs / W) * 0.5) / safeDurMs);

      // Center 0-crossing axis (matching WaveformEditorBar)
      ctx.strokeStyle = hexToRgba(color, dimmed ? 0.08 : 0.24);
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(yMid) + 0.5);
      ctx.lineTo(W, Math.round(yMid) + 0.5);
      ctx.stroke();

      // Subtle -6dB reference lines
      if (H >= 34) {
        const subOffset = maxHalfAmp * 0.5;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(0, Math.round(yMid - subOffset) + 0.5);
        ctx.lineTo(W, Math.round(yMid - subOffset) + 0.5);
        ctx.moveTo(0, Math.round(yMid + subOffset) + 0.5);
        ctx.lineTo(W, Math.round(yMid + subOffset) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const samples: Array<{
        x: number;
        posAmpPx: number;
        negAmpPx: number;
        rmsAmpPx: number;
        yUpper: number;
        yLower: number;
        yRmsUpper: number;
        yRmsLower: number;
        isVoiced: boolean;
      }> = [];

      for (let x = 0; x < W; x += stepPx) {
        const tMs = sliceStartMs + (x / W) * spanMs;
        const ratio = Math.max(0, Math.min(0.999999, tMs / safeDurMs));
        const pt = sampleCalibratedWaveformPoint(
          hiRes,
          legacyPeaks,
          ratio,
          halfWinRatio,
          gainLinear,
          calibration,
          sharedRefCeiling
        );
        const g = gainFn ? gainFn((tMs - sliceStartMs) / 1000) : 1.0;
        const posNorm = pt.posPeak * g;
        const negNorm = pt.negPeak * g;
        const rmsNorm = pt.rms * g;
        const posAmpPx = posNorm * maxHalfAmp;
        const negAmpPx = negNorm * maxHalfAmp;
        const rmsAmpPx = Math.min(rmsNorm * maxHalfAmp, Math.max(posAmpPx, negAmpPx) * 0.92);
        const isVoiced = !dimmed && Math.max(posNorm, negNorm) >= 0.018;

        samples.push({
          x,
          posAmpPx,
          negAmpPx,
          rmsAmpPx,
          yUpper: yMid - posAmpPx,
          yLower: yMid + negAmpPx,
          yRmsUpper: yMid - rmsAmpPx,
          yRmsLower: yMid + rmsAmpPx,
          isVoiced,
        });
      }

      if (samples.length >= 2) {
        // Pass 1: Subtle baseline vertical excursions
        ctx.save();
        ctx.strokeStyle = hexToRgba(color, dimmed ? 0.18 : 0.24);
        ctx.lineWidth = 0.85;
        ctx.beginPath();
        for (let i = 0; i < samples.length; i++) {
          const p = samples[i];
          if (p.posAmpPx > 0.35 || p.negAmpPx > 0.35) {
            const xAligned = Math.round(p.x) + 0.5;
            ctx.moveTo(xAligned, p.yUpper);
            ctx.lineTo(xAligned, p.yLower);
          }
        }
        ctx.stroke();
        ctx.restore();

        if (!dimmed) {
          const coreLineColor = lightenHex(color, 36);
          const rmsCoreColor = lightenHex(color, 68);

          // Pass 2: Voiced Audition Peak Transient Layer (zigzag envelope per voiced run)
          ctx.save();
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.strokeStyle = coreLineColor;
          ctx.globalAlpha = 0.78;
          ctx.lineWidth = 0.95;
          ctx.beginPath();
          let inPeakRun = false;
          for (let i = 0; i < samples.length; i++) {
            const p = samples[i];
            if (!p.isVoiced) {
              inPeakRun = false;
              continue;
            }
            const nextX =
              i + 1 < samples.length ? (p.x + samples[i + 1].x) * 0.5 : p.x + stepPx * 0.5;
            const flip = (i & 1) === 0;
            if (!inPeakRun) {
              ctx.moveTo(p.x, flip ? p.yUpper : p.yLower);
              ctx.lineTo(nextX, flip ? p.yLower : p.yUpper);
              inPeakRun = true;
            } else {
              ctx.lineTo(p.x, flip ? p.yUpper : p.yLower);
              ctx.lineTo(nextX, flip ? p.yLower : p.yUpper);
            }
          }
          ctx.stroke();
          ctx.restore();

          // Pass 3: Voiced Audition Bright RMS Loudness Core
          ctx.save();
          let runStart = -1;
          const drawRmsIsland = (sIdx: number, eIdx: number) => {
            if (eIdx > sIdx) {
              ctx.fillStyle = rmsCoreColor;
              ctx.globalAlpha = 0.52;
              ctx.beginPath();
              for (let j = sIdx; j <= eIdx; j++) {
                const pt = samples[j];
                if (j === sIdx) ctx.moveTo(pt.x, pt.yRmsUpper);
                else ctx.lineTo(pt.x, pt.yRmsUpper);
              }
              for (let j = eIdx; j >= sIdx; j--) {
                const pt = samples[j];
                ctx.lineTo(pt.x, pt.yRmsLower);
              }
              ctx.closePath();
              ctx.fill();
            }

            ctx.strokeStyle = rmsCoreColor;
            ctx.globalAlpha = 0.85;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let j = sIdx; j <= eIdx; j++) {
              const pt = samples[j];
              const rx = Math.round(pt.x) + 0.5;
              ctx.moveTo(rx, pt.yRmsUpper);
              ctx.lineTo(rx, pt.yRmsLower);
            }
            ctx.stroke();
          };

          for (let i = 0; i < samples.length; i++) {
            const p = samples[i];
            const rmsActive = p.isVoiced && p.rmsAmpPx >= 0.6;
            if (rmsActive) {
              if (runStart < 0) runStart = i;
            } else if (runStart >= 0) {
              drawRmsIsland(runStart, i - 1);
              runStart = -1;
            }
          }
          if (runStart >= 0) {
            drawRmsIsland(runStart, samples.length - 1);
          }
          ctx.restore();
        }
      }

      ctx.restore();
    }, [hiRes, legacyPeaks, durationMs, sliceStartMs, sliceEndMs, color, dimmed, gainLinear, sharedRefCeilingProp, gainFn, boxSize]);

    return <canvas ref={canvasRef} className="w-full h-full block pointer-events-none" />;
  }
);

interface IntroWordAnnotation {
  text: string;
  speakerId: string;
  editedStartSec: number;
  editedEndSec: number;
  isSubCharSplit?: boolean;
  isFiller?: boolean;
}

interface IntroWordRulerBandProps {
  annotations: IntroWordAnnotation[];
  totalSec: number;
  trackColorBySpeaker: Map<string, string>;
}

const IntroWordRulerBand: React.FC<IntroWordRulerBandProps> = React.memo(
  ({ annotations, totalSec, trackColorBySpeaker }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [boxWidth, setBoxWidth] = useState(0);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const update = () => {
        const w = Math.max(1, Math.round(canvas.getBoundingClientRect().width));
        setBoxWidth((prev) => (prev === w ? prev : w));
      };
      update();
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(update);
        ro.observe(canvas);
        return () => ro.disconnect();
      }
    }, []);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const W = Math.max(1, Math.round(rect.width));
      const H = Math.max(1, Math.round(rect.height));
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0c0c11';
      ctx.fillRect(0, 0, W, H);

      const safeTotal = Math.max(0.01, totalSec);
      const bandTop = 1;
      const bandBot = H - 1;
      const barTop = H - 3;
      const bandMidY = bandTop + (barTop - bandTop) * 0.5;
      let lastRightX = -999;
      let prevAnn: { ax1: number; editedEndSec: number } | null = null;

      for (let idx = 0; idx < annotations.length; idx++) {
        const ann = annotations[idx];
        const ax0 = (ann.editedStartSec / safeTotal) * W;
        const ax1 = (ann.editedEndSec / safeTotal) * W;
        const nextAnn = idx + 1 < annotations.length ? annotations[idx + 1] : null;
        const nextAx0 = nextAnn ? (nextAnn.editedStartSec / safeTotal) * W : W + 200;
        const spColor = trackColorBySpeaker.get(ann.speakerId) ?? '#38bdf8';

        if (prevAnn !== null) {
          const gapSec = ann.editedStartSec - prevAnn.editedEndSec;
          const gapPx = ax0 - prevAnn.ax1;
          if (gapSec >= 0.015 && gapPx >= 36) {
            const gLabel = gapSec < 1 ? `${Math.round(gapSec * 1000)}ms` : `${gapSec.toFixed(2)}s`;
            ctx.font = '500 9px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.textBaseline = 'middle';
            const gtw = ctx.measureText(gLabel).width;
            const gx = (Math.max(0, prevAnn.ax1) + Math.min(W, ax0)) * 0.5;
            const gxLeft = gx - gtw * 0.5;
            if (
              gtw + 8 <= gapPx &&
              gxLeft >= Math.max(prevAnn.ax1 + 3, lastRightX + 3) &&
              gx + gtw * 0.5 + 3 <= ax0 &&
              gx > 10 &&
              gx < W - 10
            ) {
              ctx.fillStyle = 'rgba(161, 161, 170, 0.78)';
              ctx.fillText(gLabel, gxLeft, bandMidY + 0.5);
              lastRightX = Math.max(lastRightX, gx + gtw * 0.5 + 2);
            }
          }
        }

        const visX0 = Math.max(0, ax0);
        const visX1 = Math.min(W, ax1);
        const visW = visX1 - visX0;
        if (visW >= 0.5) {
          ctx.fillStyle = hexToRgba(spColor, ann.isFiller ? 0.16 : 0.11);
          ctx.fillRect(visX0, bandTop, visW, Math.max(2, barTop - bandTop));
          ctx.fillStyle = hexToRgba(spColor, ann.isFiller ? 0.52 : 0.78);
          ctx.fillRect(visX0, barTop, visW, 2);
        }

        if (ax0 >= 0 && ax0 <= W) {
          const tickX = Math.round(ax0) + 0.5;
          ctx.save();
          if (ann.isSubCharSplit) {
            ctx.setLineDash([2, 2]);
            ctx.strokeStyle = hexToRgba(spColor, 0.45);
          } else {
            ctx.strokeStyle = hexToRgba(spColor, 0.85);
          }
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(tickX, bandTop);
          ctx.lineTo(tickX, bandBot);
          ctx.stroke();
          ctx.restore();
        }

        const nextGapSec = nextAnn ? nextAnn.editedStartSec - ann.editedEndSec : Infinity;
        if (ax1 >= 0 && ax1 <= W && nextGapSec >= 0.012) {
          const endTickX = Math.round(ax1) - 0.5;
          ctx.strokeStyle = hexToRgba(spColor, 0.55);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(endTickX, H - 9);
          ctx.lineTo(endTickX, bandBot);
          ctx.stroke();
        }

        const labelStartX = Math.max(2, ax0 + 2, lastRightX + 2);
        const spanReachX = Math.max(ax0 + 4, ax1 - 4);
        if (labelStartX < spanReachX && labelStartX < W - 10) {
          const nextGapPx = nextAnn ? nextAx0 - ax1 : Infinity;
          let maxRightX = W - 2;
          if (nextAnn && nextAnn.speakerId !== ann.speakerId) {
            maxRightX = Math.min(maxRightX, nextAx0 - 2);
          } else if (nextAnn && nextGapSec >= 0.015 && nextGapPx >= 18) {
            const gapCap = nextGapPx >= 36 ? nextAx0 - nextGapPx * 0.5 - 16 : nextAx0 - 2;
            maxRightX = Math.min(maxRightX, Math.max(ax1 + 4, gapCap));
          }
          const availW = maxRightX - labelStartX;
          if (availW >= 10) {
            ctx.font = '600 11.5px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
            ctx.textBaseline = 'middle';
            const tWidth = ctx.measureText(ann.text).width;
            const drawW = Math.min(availW, tWidth + 1);
            ctx.save();
            ctx.beginPath();
            ctx.rect(labelStartX, bandTop, drawW, barTop - bandTop);
            ctx.clip();
            ctx.fillStyle = ann.isFiller ? '#fde68a' : '#fafafa';
            ctx.fillText(ann.text, labelStartX, bandMidY);
            ctx.restore();
            lastRightX = labelStartX + Math.min(tWidth, availW);
          }
        }

        prevAnn = prevAnn && prevAnn.editedEndSec > ann.editedEndSec ? prevAnn : { ax1, editedEndSec: ann.editedEndSec };
      }

      ctx.restore();
    }, [annotations, totalSec, trackColorBySpeaker, boxWidth]);

    return <canvas ref={canvasRef} className="w-full h-full block pointer-events-none" />;
  }
);

export const IntroEditorModal: React.FC<IntroEditorModalProps> = ({
  open,
  embedded = false,
  state,
  timeline,
  onClose,
  onUpdateState,
  onImportBgm,
  onSeekMainPlayhead,
  onNotify,
}) => {
  const [zoom, setZoom] = useState(1);
  const [toolMode, setToolMode] = useState<EditorToolMode>('edit');
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [selectedHlId, setSelectedHlId] = useState<string | null>(null);
  const [dragAction, setDragAction] = useState<DragAction | null>(null);
  const hiResEnvelopesRef = useRef<Map<string, HiResWaveformEnvelope>>(new Map());
  const [hiResRev, setHiResRev] = useState(0);

  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const trackAreaRef = useRef<HTMLDivElement | null>(null);
  const playheadLineRef = useRef<HTMLDivElement | null>(null);
  const timeReadoutRef = useRef<HTMLSpanElement | null>(null);
  const playheadRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

  const speakerTracks = useMemo(
    () =>
      state.tracks.some((t) => !t.isRef)
        ? state.tracks.filter((t) => !t.isRef)
        : state.tracks,
    [state.tracks]
  );

  const gapSec = resolveEffectiveHighlightGapSec(state);
  const clipWindows = useMemo(
    () => resolveColdOpenClipWindows(state.highlights, gapSec),
    [state.highlights, gapSec]
  );

  const coldDurationSec = computeColdOpenDurationSec(state);
  const introVoDurationSec = state.introVoiceover?.enabled
    ? Math.max(1, Number((state.introVoiceover.durationSec ?? 5).toFixed(2)))
    : 0;
  const introVoStartSec = state.introVoiceover?.enabled
    ? typeof state.introVoiceover.startOffsetSec === 'number' &&
      state.introVoiceover.startOffsetSec >= 0
      ? state.introVoiceover.startOffsetSec
      : coldDurationSec
    : coldDurationSec;

  const voiceContentEndSec = Math.max(
    coldDurationSec,
    state.introVoiceover?.enabled ? introVoStartSec + introVoDurationSec : 0
  );
  const rawIntroBgmDurationSec = computeIntroBgmDurationSec(state);
  const hasCustomBgmDur =
    typeof state.introBgm?.customDurationSec === 'number' && state.introBgm.customDurationSec > 0;
  const introBgmDurationSec =
    !hasCustomBgmDur && voiceContentEndSec > 0
      ? Math.min(rawIntroBgmDurationSec, voiceContentEndSec)
      : rawIntroBgmDurationSec;

  const totalIntroSec = Math.max(
    4,
    coldDurationSec,
    state.introVoiceover?.enabled ? introVoStartSec + introVoDurationSec : 0,
    introBgmDurationSec
  );
  const timelineSpanSec = totalIntroSec;

  const introWordAnnotations = useMemo<IntroWordAnnotation[]>(() => {
    const out: IntroWordAnnotation[] = [];
    for (const { highlight: hl, startSec, endSec } of clipWindows) {
      const clipDur = Math.max(0.05, endSec - startSec);
      const srcSpanMs = Math.max(1, hl.sourceEndMs - hl.sourceStartMs);
      const matchedTokens = state.blocks.flatMap((b) =>
        b.tokens
          .filter(
            (t) =>
              !t.deleted &&
              t.type === 'word' &&
              t.sourceEndMs > hl.sourceStartMs - 60 &&
              t.sourceStartMs < hl.sourceEndMs + 60 &&
              t.text.trim().length > 0
          )
          .map((t) => ({ token: t, speakerId: b.speakerId || hl.speakerId }))
      );

      if (matchedTokens.length > 0) {
        for (const { token, speakerId } of matchedTokens) {
          const tStartRel = Math.max(0, (token.sourceStartMs - hl.sourceStartMs) / srcSpanMs);
          const tEndRel = Math.min(1, (token.sourceEndMs - hl.sourceStartMs) / srcSpanMs);
          if (tEndRel <= tStartRel) continue;
          const tStartSec = startSec + tStartRel * clipDur;
          const tEndSec = startSec + tEndRel * clipDur;
          const raw = token.text.trim();
          const hasCjk = /[\u4e00-\u9fff]/.test(raw);
          const chars = hasCjk ? Array.from(raw) : [raw];
          const step = (tEndSec - tStartSec) / Math.max(1, chars.length);
          for (let ci = 0; ci < chars.length; ci++) {
            out.push({
              text: chars[ci],
              speakerId,
              editedStartSec: tStartSec + ci * step,
              editedEndSec: tStartSec + (ci + 1) * step,
              isSubCharSplit: ci > 0,
              isFiller: token.fillerTag === 'pure',
            });
          }
        }
      } else {
        const cleaned = hl.text.trim();
        const units = /[\u4e00-\u9fff]/.test(cleaned)
          ? Array.from(cleaned).filter((c) => c.trim().length > 0)
          : cleaned.split(/\s+/).filter(Boolean);
        const step = clipDur / Math.max(1, units.length);
        for (let ci = 0; ci < units.length; ci++) {
          out.push({
            text: units[ci],
            speakerId: hl.speakerId,
            editedStartSec: startSec + ci * step,
            editedEndSec: startSec + (ci + 1) * step,
            isSubCharSplit: ci > 0,
          });
        }
      }
    }
    return out.sort((a, b) => a.editedStartSec - b.editedStartSec);
  }, [clipWindows, state.blocks]);

  useEffect(() => {
    if (!open) {
      if (isPlaying) {
        audioPreview.pauseMultiTrackPlayback();
        setIsPlaying(false);
      }
      return;
    }
    audioPreview.preloadTracks(stateRef.current);

    let cancelled = false;
    const loadAssetEnvelope = (id: string, filePath?: string, audioUrl?: string, peaks: number[] = [], durationMs = 0) => {
      if (!filePath && !audioUrl) return;
      const pseudoTrack: SpeakerTrack = {
        id,
        name: id,
        role: 'host',
        roleLabel: '',
        color: '#a855f7',
        filePath,
        audioUrl,
        durationMs,
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 0,
        peaks,
        solo: false,
        muted: false,
      };
      void loadTrackHiResEnvelope(pseudoTrack).then((env) => {
        if (cancelled || !env) return;
        if (hiResEnvelopesRef.current.get(id) !== env) {
          hiResEnvelopesRef.current.set(id, env);
          setHiResRev((v) => v + 1);
        }
      });
    };

    speakerTracks.forEach((tr) =>
      loadAssetEnvelope(tr.id, tr.filePath, tr.audioUrl, tr.peaks, tr.durationMs)
    );
    if (state.introVoiceover?.enabled) {
      loadAssetEnvelope(
        '__intro_vo__',
        state.introVoiceover.filePath,
        state.introVoiceover.audioUrl,
        state.introVoiceover.peaks ?? [],
        (state.introVoiceover.durationSec ?? 5) * 1000
      );
    }
    const introBgmPath = state.introBgm?.filePath || state.bgmWavPath;
    if (state.introBgm?.enabled && (introBgmPath || state.introBgm?.audioUrl)) {
      loadAssetEnvelope(
        '__intro_bgm__',
        introBgmPath,
        state.introBgm.audioUrl,
        state.introBgm.peaks ?? [],
        (state.introBgm.durationSec ?? 10) * 1000
      );
    }
    return () => {
      cancelled = true;
    };
  }, [open, speakerTracks, state.introVoiceover, state.introBgm, state.bgmWavPath]);

  const updatePlayheadDom = (sec: number) => {
    const pct = Math.max(0, Math.min(100, (sec / timelineSpanSec) * 100));
    if (playheadLineRef.current) {
      playheadLineRef.current.style.left = `${pct}%`;
    }
    const formatted = `${formatMmSs(sec)}.${Math.floor((sec % 1) * 10)}`;
    if (timeReadoutRef.current) {
      timeReadoutRef.current.textContent = formatted;
    }
  };

  // Ultra-smooth 60fps playhead loop updating DOM directly (0 React re-renders during playback!)
  useEffect(() => {
    if (!open || !isPlaying) return;
    let rafId = 0;
    let lastMs = performance.now();

    const tick = (nowMs: number) => {
      const dt = Math.min(0.1, Math.max(0, (nowMs - lastMs) / 1000));
      lastMs = nowMs;

      const curState = stateRef.current;
      const curTl = timelineRef.current;
      const stopBound = Math.max(1, totalIntroSec);
      const { nextPlayheadSec } = audioPreview.advanceAndSyncPlayback(
        curState,
        curTl,
        playheadRef.current,
        dt
      );
      if (nextPlayheadSec >= stopBound) {
        playheadRef.current = 0;
        updatePlayheadDom(0);
        setPlayheadSec(0);
        setIsPlaying(false);
        audioPreview.pauseMultiTrackPlayback();
        return;
      }
      playheadRef.current = nextPlayheadSec;
      updatePlayheadDom(nextPlayheadSec);
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
      setPlayheadSec(Number(playheadRef.current.toFixed(3)));
    };
  }, [open, isPlaying, totalIntroSec, timelineSpanSec]);

  const togglePlayRef = useRef<() => void>(() => {});

  // Ctrl/Cmd + Wheel zoom & Spacebar play/pause inside Intro View
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        if ((target as HTMLInputElement).type !== 'range' && (target as HTMLInputElement).type !== 'checkbox') {
          return;
        }
      }
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) {
          if (target && (tag === 'BUTTON' || tag === 'INPUT')) target.blur();
          togglePlayRef.current();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  // Ctrl/Cmd + Wheel zoom inside Intro Editor
  useEffect(() => {
    const vp = scrollViewportRef.current;
    if (!open || !vp) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = vp.getBoundingClientRect();
        const localX = Math.max(0, Math.min(vp.clientWidth, e.clientX - rect.left));
        const anchorNorm = (vp.scrollLeft + localX) / Math.max(1, vp.scrollWidth);
        const factor = Math.exp(-e.deltaY * 0.008);
        setZoom((z) => {
          const nextZoom = Math.max(1, Math.min(MAX_INTRO_ZOOM, Number((z * factor).toFixed(2))));
          requestAnimationFrame(() => {
            const totalWidth = vp.clientWidth * nextZoom;
            vp.scrollLeft = Math.max(0, anchorNorm * totalWidth - localX);
          });
          return nextZoom;
        });
      }
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [open]);

  useEffect(() => {
    if (!dragAction) return;

    const handleMove = (e: PointerEvent) => {
      const container = trackAreaRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const pxPerSec = Math.max(1, rect.width / timelineSpanSec);
      const snap = (v: number) => Math.round(v * 20) / 20;

      if (dragAction.kind === 'scrub') {
        const ratio = Math.max(0, Math.min(1, (e.clientX - dragAction.rectLeft) / Math.max(1, dragAction.rectWidth)));
        const sec = Number((ratio * timelineSpanSec).toFixed(2));
        playheadRef.current = sec;
        setPlayheadSec(sec);
        updatePlayheadDom(sec);
        audioPreview.requestSeek();
        if (isPlaying) {
          audioPreview.syncMultiTrackPlayback(stateRef.current, timelineRef.current, sec, true);
        }
        return;
      }

      if (dragAction.kind === 'mute_range') {
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
        const curSec = snap(ratio * timelineSpanSec);
        setDragAction((prev) => (prev && prev.kind === 'mute_range' ? { ...prev, endSec: curSec } : prev));
        return;
      }

      const deltaSec = (e.clientX - dragAction.startClientX) / pxPerSec;

      if (dragAction.kind === 'move_hl') {
        const nextStart = Math.max(0, snap(dragAction.origStartSec + deltaSec));
        onUpdateState((prev) => ({
          ...prev,
          highlights: prev.highlights.map((h) =>
            h.id === dragAction.hlId ? { ...h, introStartSec: nextStart } : h
          ),
        }));
      } else if (dragAction.kind === 'trim_hl_left') {
        const minDur = 0.4;
        const maxTrimSec = dragAction.origDurationSec - minDur;
        const minTrimSec = -(dragAction.origSourceStartMs / 1000);
        const clampedTrimSec = Math.max(
          Math.max(minTrimSec, -dragAction.origIntroStartSec),
          Math.min(maxTrimSec, snap(deltaSec))
        );
        const nextIntroStart = Number((dragAction.origIntroStartSec + clampedTrimSec).toFixed(2));
        const nextSourceStartMs = Math.max(
          0,
          Math.round(dragAction.origSourceStartMs + clampedTrimSec * 1000)
        );
        const nextDur = Number(
          Math.max(minDur, (dragAction.origSourceEndMs - nextSourceStartMs) / 1000).toFixed(2)
        );
        onUpdateState((prev) => ({
          ...prev,
          highlights: prev.highlights.map((h) =>
            h.id === dragAction.hlId
              ? {
                  ...h,
                  introStartSec: nextIntroStart,
                  sourceStartMs: nextSourceStartMs,
                  durationSec: nextDur,
                }
              : h
          ),
        }));
      } else if (dragAction.kind === 'trim_hl_right') {
        const minDur = 0.4;
        const maxDur =
          dragAction.maxSourceMs > dragAction.origSourceStartMs
            ? (dragAction.maxSourceMs - dragAction.origSourceStartMs) / 1000
            : 60;
        const nextDur = Number(
          Math.max(minDur, Math.min(maxDur, snap(dragAction.origDurationSec + deltaSec))).toFixed(2)
        );
        const nextSourceEndMs = Math.round(dragAction.origSourceStartMs + nextDur * 1000);
        onUpdateState((prev) => ({
          ...prev,
          highlights: prev.highlights.map((h) =>
            h.id === dragAction.hlId
              ? { ...h, sourceEndMs: nextSourceEndMs, durationSec: nextDur }
              : h
          ),
        }));
      } else if (dragAction.kind === 'move_vo') {
        const nextOffset = Math.max(0, snap(dragAction.origStartOffsetSec + deltaSec));
        onUpdateState((prev) =>
          prev.introVoiceover
            ? {
                ...prev,
                introVoiceover: { ...prev.introVoiceover, startOffsetSec: nextOffset },
              }
            : prev
        );
      } else if (dragAction.kind === 'trim_bgm_right') {
        const nextDur = Number(
          Math.max(1.0, Math.min(dragAction.maxDurationSec, snap(dragAction.origDurationSec + deltaSec))).toFixed(2)
        );
        onUpdateState((prev) =>
          prev.introBgm
            ? {
                ...prev,
                introBgm: { ...prev.introBgm, customDurationSec: nextDur },
              }
            : prev
        );
      } else if (dragAction.kind === 'trim_bgm_left') {
        const origEnd = dragAction.origStartSec + dragAction.origDurationSec;
        const nextStart = Math.max(0, Math.min(origEnd - 1.0, snap(dragAction.origStartSec + deltaSec)));
        const nextDur = Number(Math.max(1.0, origEnd - nextStart).toFixed(2));
        onUpdateState((prev) =>
          prev.introBgm
            ? {
                ...prev,
                introBgm: { ...prev.introBgm, startOffsetSec: nextStart, customDurationSec: nextDur },
              }
            : prev
        );
      } else if (dragAction.kind === 'move_bgm') {
        const nextStart = Math.max(0, snap(dragAction.origStartSec + deltaSec));
        onUpdateState((prev) =>
          prev.introBgm
            ? {
                ...prev,
                introBgm: { ...prev.introBgm, startOffsetSec: nextStart },
              }
            : prev
        );
      }
    };

    const handleUp = () => {
      if (dragAction.kind === 'mute_range') {
        const rStart = Math.min(dragAction.startSec, dragAction.endSec);
        const rEnd = Math.max(dragAction.startSec, dragAction.endSec);
        if (rEnd - rStart >= 0.08) {
          let applied = 0;
          onUpdateState((prev) => {
            const g = resolveEffectiveHighlightGapSec(prev);
            const wins = resolveColdOpenClipWindows(prev.highlights, g);
            return {
              ...prev,
              highlights: prev.highlights.map((h) => {
                const win = wins.find((w) => w.highlight.id === h.id);
                if (!win) return h;
                const ovStart = Math.max(win.startSec, rStart);
                const ovEnd = Math.min(win.endSec, rEnd);
                if (ovEnd - ovStart < 0.05) return h;
                applied++;
                const pmStartMs = Math.round(h.sourceStartMs + (ovStart - win.startSec) * 1000);
                const pmEndMs = Math.round(h.sourceStartMs + (ovEnd - win.startSec) * 1000);
                const nextPm: HighlightMuteInterval = {
                  id: `pm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  trackId: dragAction.trackId,
                  sourceStartMs: pmStartMs,
                  sourceEndMs: pmEndMs,
                  label: '片头段落静音',
                };
                return {
                  ...h,
                  partiallyMutedRanges: [...(h.partiallyMutedRanges ?? []), nextPm],
                };
              }),
            };
          });
          if (applied > 0) {
            onNotify?.(`🔇 已对该音轨选定段落 (${rStart.toFixed(1)}s–${rEnd.toFixed(1)}s) 添加静音`);
          }
        }
      }
      setDragAction(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [dragAction, timelineSpanSec, isPlaying, onUpdateState, onNotify]);

  if (!open) return null;

  const trackColorBySpeaker = new Map(state.tracks.map((t) => [t.id, t]));

  const seekIntroToSec = (sec: number) => {
    const clamped = Math.max(0, Math.min(timelineSpanSec, Number(sec.toFixed(2))));
    playheadRef.current = clamped;
    setPlayheadSec(clamped);
    updatePlayheadDom(clamped);
    audioPreview.requestSeek();
    if (isPlaying) {
      audioPreview.syncMultiTrackPlayback(stateRef.current, timelineRef.current, clamped, true);
    }
  };

  const togglePlay = () => {
    if (isPlaying) {
      audioPreview.pauseMultiTrackPlayback();
      setIsPlaying(false);
      return;
    }
    const maxIntro = Math.max(1, timeline.prefixDurationSec > 0 ? timeline.prefixDurationSec : totalIntroSec);
    let startAt = playheadRef.current;
    if (startAt >= maxIntro - 0.05) {
      startAt = 0;
      playheadRef.current = 0;
      setPlayheadSec(0);
      updatePlayheadDom(0);
    }
    audioPreview.startFromUserGesture(state, timeline, startAt, onNotify);
    setIsPlaying(true);
  };
  togglePlayRef.current = togglePlay;

  const resetSequentialHighlights = () => {
    onUpdateState((prev) => ({
      ...prev,
      highlights: prev.highlights.map(({ introStartSec: _removed, ...rest }) => rest),
    }));
    onNotify?.('✨ 已恢复金句片段默认顺序排布');
  };

  const toggleTrackSolo = (trackId: string) => {
    onUpdateState((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) => (t.id === trackId ? { ...t, solo: !t.solo } : t)),
    }));
  };

  const toggleTrackMute = (trackId: string) => {
    onUpdateState((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) => (t.id === trackId ? { ...t, muted: !t.muted } : t)),
    }));
  };

  const removePartialMuteRange = (hlId: string, pmId: string) => {
    onUpdateState((prev) => ({
      ...prev,
      highlights: prev.highlights.map((h) =>
        h.id === hlId
          ? { ...h, partiallyMutedRanges: (h.partiallyMutedRanges ?? []).filter((p) => p.id !== pmId) }
          : h
      ),
    }));
    onNotify?.('🔊 已恢复该音轨段落声音');
  };

  const toggleHighlightTrackMute = (hlId: string, trackId: string) => {
    onUpdateState((prev) => ({
      ...prev,
      highlights: prev.highlights.map((h) => {
        if (h.id !== hlId) return h;
        const cur = h.mutedTrackIds ?? [];
        const next = cur.includes(trackId) ? cur.filter((id) => id !== trackId) : [...cur, trackId];
        return { ...h, mutedTrackIds: next };
      }),
    }));
  };

  const visibleSec = timelineSpanSec / zoom;
  const tickStep = visibleSec <= 4 ? 0.5 : visibleSec <= 12 ? 1 : visibleSec <= 30 ? 2 : 5;
  const rulerTicks: number[] = [];
  for (let t = 0; t <= timelineSpanSec + 0.001; t += tickStep) {
    rulerTicks.push(Number(t.toFixed(2)));
  }

  const introFadeInMs = state.introBgm?.fadeInMs ?? DEFAULT_BGM_FADE_MS;
  const introFadeOutMs = state.introBgm?.fadeOutMs ?? DEFAULT_BGM_FADE_MS;
  const introFadeInSec = introFadeInMs / 1000;
  const introFadeOutSec = introFadeOutMs / 1000;

  const updateIntroBgmFade = (patch: { fadeInMs?: number; fadeOutMs?: number }) => {
    onUpdateState((prev) => ({
      ...prev,
      introBgm: {
        ...(prev.introBgm ?? { fileName: '片头 BGM', enabled: false }),
        ...patch,
      },
    }));
  };

  const duckPct = Math.max(10, Math.min(85, 100 - Math.abs(state.bgmDuckDb ?? -18) * 2.5));

  const sharedTrackCeiling = useMemo(() => {
    let maxCeiling = 0;
    for (const tr of speakerTracks) {
      const env = hiResEnvelopesRef.current.get(tr.id);
      const cal = env ?? computeLegacyPeaksCalibration(tr.peaks);
      const c = cal.p992Peak || 0.72;
      if (c > maxCeiling) maxCeiling = c;
    }
    return maxCeiling || 0.72;
  }, [speakerTracks, hiResRev]);

  const introVoiceWindows = useMemo<IntroBgmVoiceWindow[]>(() => {
    const wins: IntroBgmVoiceWindow[] = [];
    if (state.coldOpenEnabled && clipWindows.length > 0) {
      for (const w of clipWindows) {
        wins.push({ startSec: w.startSec, endSec: w.endSec });
      }
    }
    if (state.introVoiceover?.enabled && introVoDurationSec > 0) {
      wins.push({
        startSec: introVoStartSec,
        endSec: introVoStartSec + introVoDurationSec,
      });
    }
    return wins;
  }, [state.coldOpenEnabled, clipWindows, state.introVoiceover?.enabled, introVoDurationSec, introVoStartSec]);

  const MAX_INTRO_ZOOM = 16;
  const zoomToSliderVal = (z: number) =>
    Math.round((Math.log(Math.max(1, Math.min(MAX_INTRO_ZOOM, z))) / Math.log(MAX_INTRO_ZOOM)) * 1000);
  const sliderValToZoom = (val: number) =>
    Number(Math.exp((Math.max(0, Math.min(1000, val)) / 1000) * Math.log(MAX_INTRO_ZOOM)).toFixed(2));

  const applyIntroZoom = (nextZoomRaw: number) => {
    const nextZoom = Math.max(1, Math.min(MAX_INTRO_ZOOM, Number(nextZoomRaw.toFixed(2))));
    const vp = scrollViewportRef.current;
    const centerNorm = vp
      ? (vp.scrollLeft + vp.clientWidth * 0.5) / Math.max(1, vp.scrollWidth)
      : 0.5;
    setZoom(nextZoom);
    requestAnimationFrame(() => {
      const curVp = scrollViewportRef.current;
      if (!curVp) return;
      const totalWidth = curVp.clientWidth * nextZoom;
      const anchorX = centerNorm * totalWidth;
      curVp.scrollLeft = Math.max(0, anchorX - curVp.clientWidth * 0.5);
    });
  };

  const playheadPct = Math.max(0, Math.min(100, (playheadSec / timelineSpanSec) * 100));

  const wrapperClass = embedded
    ? 'flex-1 min-w-0 h-full flex flex-col bg-zinc-950 overflow-hidden px-3 py-2'
    : 'fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4';
  const cardClass = embedded
    ? 'w-full h-full flex flex-col overflow-hidden gap-1.5'
    : 'w-full max-w-6xl bg-zinc-900 border border-zinc-700/80 rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-[92vh] p-3 gap-2';

  return (
    <div className={wrapperClass}>
      <div className={cardClass}>
        {/* 顶部文本框区：与音轨视图顶部发言卡片完全一致，展示片头金句片段与固定口播 */}
        <div className="shrink-0 rounded-xl border border-zinc-800/90 bg-zinc-900/55 px-3 py-2 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-purple-400" />
              <span className="font-semibold text-zinc-100">片头金句与口播文案预览</span>
              <span className="px-2 py-0.5 rounded-full bg-purple-500/15 border border-purple-500/35 font-mono text-[10px] text-purple-300">
                共 {clipWindows.length} 段金句 · 总片头 {totalIntroSec.toFixed(1)}s
              </span>
              <span className="text-[11px] text-zinc-500 hidden md:inline">
                按 Space 空格播放预览片头 · 单击卡片定位游标
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (isPlaying) {
                    audioPreview.pauseMultiTrackPlayback();
                    setIsPlaying(false);
                  }
                  onSeekMainPlayhead(playheadRef.current);
                  onClose();
                }}
                className="px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[11px] text-zinc-200 flex items-center gap-1 cursor-pointer"
              >
                {embedded ? (
                  <span>返回音轨</span>
                ) : (
                  <>
                    <X className="w-3 h-3" />
                    <span>关闭</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* 水平金句文本框卡片流 */}
          <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
            {clipWindows.length === 0 ? (
              <div className="px-3 py-2 rounded-lg border border-dashed border-zinc-700/80 text-xs text-zinc-500 flex items-center gap-2">
                <Film className="w-3.5 h-3.5 text-zinc-500" />
                <span>暂未添加金句片段，可在左侧金句栏或正片波形框选「加入金句」</span>
              </div>
            ) : (
              clipWindows.map(({ highlight: hl, startSec, endSec }, idx) => {
                const tr = trackColorBySpeaker.get(hl.speakerId);
                const color = tr?.color || '#a855f7';
                const isActive = playheadSec >= startSec && playheadSec <= endSec;
                const isSelected = selectedHlId === hl.id;
                return (
                  <div
                    key={hl.id}
                    onClick={() => {
                      setSelectedHlId(hl.id);
                      seekIntroToSec(startSec);
                    }}
                    className={`w-64 shrink-0 rounded-lg border px-2.5 py-2 cursor-pointer transition flex flex-col justify-between gap-1 ${
                      isActive
                        ? 'border-emerald-500/80 bg-emerald-950/30 ring-1 ring-emerald-400/35'
                        : isSelected
                        ? 'border-purple-400/80 bg-purple-950/25'
                        : 'border-zinc-800 bg-zinc-950/75 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5 text-[11px]">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className="w-1.5 h-3.5 rounded-full shrink-0"
                          style={{ backgroundColor: color }}
                        />
                        <span className="font-semibold text-zinc-100 truncate">
                          #{idx + 1} {hl.speakerName}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-purple-300 shrink-0">
                        @{startSec.toFixed(1)}s ({hl.durationSec.toFixed(1)}s)
                      </span>
                    </div>
                    <p className="text-xs text-zinc-200 leading-snug line-clamp-2">
                      “{hl.text}”
                    </p>
                  </div>
                );
              })
            )}

            {state.introVoiceover?.enabled && (state.introVoiceover.filePath || state.introVoiceover.audioUrl) && (
              <div
                onClick={() => seekIntroToSec(introVoStartSec)}
                className={`w-56 shrink-0 rounded-lg border px-2.5 py-2 cursor-pointer transition flex flex-col justify-between gap-1 ${
                  playheadSec >= introVoStartSec && playheadSec <= introVoStartSec + introVoDurationSec
                    ? 'border-amber-400 bg-amber-950/35 ring-1 ring-amber-400/40'
                    : 'border-amber-500/40 bg-amber-950/15 hover:border-amber-400/70'
                }`}
              >
                <div className="flex items-center justify-between gap-1 text-[11px]">
                  <span className="font-semibold text-amber-200 flex items-center gap-1 truncate">
                    <Mic className="w-3 h-3 text-amber-400 shrink-0" />
                    <span>固定口播</span>
                  </span>
                  <span className="font-mono text-[10px] text-amber-300 shrink-0">
                    @{introVoStartSec.toFixed(1)}s ({introVoDurationSec.toFixed(1)}s)
                  </span>
                </div>
                <p className="text-[11px] text-amber-100/80 truncate">
                  {state.introVoiceover.fileName}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 工具栏：与音轨视图一致的控制条 */}
        <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 px-1 py-0.5 text-xs">
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg bg-zinc-900 border border-zinc-800 p-0.5">
              <button
                type="button"
                onClick={() => setToolMode('edit')}
                className={`px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 cursor-pointer transition ${
                  toolMode === 'edit'
                    ? 'bg-purple-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <MousePointer className="w-3 h-3" />
                <span>移动/缩放</span>
              </button>
              <button
                type="button"
                onClick={() => setToolMode('mute_range')}
                title="在任意音轨上横向框选一段区域将其静音（可单击已静音区恢复）"
                className={`px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 cursor-pointer transition ${
                  toolMode === 'mute_range'
                    ? 'bg-rose-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <VolumeX className="w-3 h-3" />
                <span>段落静音</span>
              </button>
            </div>

            <label className="flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={state.coldOpenEnabled}
                onChange={(e) =>
                  onUpdateState((p) => ({ ...p, coldOpenEnabled: e.target.checked }))
                }
                className="rounded accent-purple-500"
              />
              <span>挂载片头金句</span>
            </label>

            <button
              type="button"
              onClick={resetSequentialHighlights}
              className="px-2 py-1 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-[11px] text-zinc-300 cursor-pointer"
            >
              自动顺序排列
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg bg-zinc-950/90 border border-zinc-800">
              <button
                type="button"
                onClick={() => seekIntroToSec(0)}
                title="回到 00:00"
                className="p-1 text-zinc-400 hover:text-zinc-100 rounded hover:bg-zinc-800 cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={togglePlay}
                title="播放 / 暂停片头预览 (Space)"
                className={`px-2.5 py-0.5 rounded font-semibold flex items-center gap-1 cursor-pointer transition ${
                  isPlaying
                    ? 'bg-amber-500 text-zinc-950'
                    : 'bg-purple-600 hover:bg-purple-500 text-white'
                }`}
              >
                {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                <span>{isPlaying ? '暂停' : '试听片头'}</span>
              </button>
            </div>

            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-zinc-950/90 border border-zinc-800 text-[11px] text-zinc-300">
              <Volume2 className="w-3 h-3 text-blue-400" />
              <span>避让</span>
              <input
                type="range"
                min={-30}
                max={-6}
                step={1}
                value={state.bgmDuckDb ?? -18}
                onChange={(e) =>
                  onUpdateState((p) => ({ ...p, bgmDuckDb: Number(e.target.value) }))
                }
                className="w-16 accent-blue-500 cursor-pointer"
              />
              <span className="font-mono text-blue-300 w-9 text-right">
                {state.bgmDuckDb ?? -18}dB
              </span>
            </div>

            <div
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-zinc-950/90 border border-zinc-800 text-[11px] text-zinc-300"
              title="设置片头 BGM 淡入时间（秒）"
            >
              <span className="text-cyan-400">淡入</span>
              <input
                type="range"
                min={0.1}
                max={5.0}
                step={0.1}
                value={Number(introFadeInSec.toFixed(1))}
                onChange={(e) =>
                  updateIntroBgmFade({ fadeInMs: Math.round(Number(e.target.value) * 1000) })
                }
                className="w-14 accent-cyan-500 cursor-pointer"
              />
              <span className="font-mono text-cyan-300 w-8 text-right">
                {introFadeInSec.toFixed(1)}s
              </span>
            </div>

            <div
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-zinc-950/90 border border-zinc-800 text-[11px] text-zinc-300"
              title="设置片头 BGM 淡出时间（秒）"
            >
              <span className="text-cyan-400">淡出</span>
              <input
                type="range"
                min={0.1}
                max={5.0}
                step={0.1}
                value={Number(introFadeOutSec.toFixed(1))}
                onChange={(e) =>
                  updateIntroBgmFade({ fadeOutMs: Math.round(Number(e.target.value) * 1000) })
                }
                className="w-14 accent-cyan-500 cursor-pointer"
              />
              <span className="font-mono text-cyan-300 w-8 text-right">
                {introFadeOutSec.toFixed(1)}s
              </span>
            </div>

            <div className="flex items-center gap-1.5 bg-zinc-950/90 border border-zinc-800 rounded-lg px-2 py-0.5 text-zinc-400">
              <button
                type="button"
                onClick={() => applyIntroZoom(1)}
                disabled={zoom <= 1.01}
                title="还原片头 1x 全览"
                className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-900 hover:bg-zinc-800 text-zinc-300 disabled:opacity-35 cursor-pointer disabled:cursor-default"
              >
                全览
              </button>
              <button
                type="button"
                onClick={() => applyIntroZoom(zoom / 1.5)}
                disabled={zoom <= 1}
                title="缩小片头时间轴"
                className="p-0.5 hover:text-zinc-100 disabled:opacity-35 cursor-pointer disabled:cursor-default"
              >
                <Minus className="w-3 h-3" />
              </button>
              <input
                type="range"
                min={0}
                max={1000}
                step={1}
                value={zoomToSliderVal(zoom)}
                onChange={(e) => applyIntroZoom(sliderValToZoom(Number(e.target.value)))}
                onKeyDown={(e) => {
                  if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                    togglePlay();
                  }
                }}
                title={`对数无级标尺缩放（1x ~ ${MAX_INTRO_ZOOM}x，也可 Ctrl/Cmd+滚轮）`}
                className="w-20 accent-purple-500 cursor-pointer"
              />
              <button
                type="button"
                onClick={() => applyIntroZoom(zoom * 1.5)}
                disabled={zoom >= MAX_INTRO_ZOOM}
                title="放大片头时间轴"
                className="p-0.5 hover:text-zinc-100 disabled:opacity-35 cursor-pointer disabled:cursor-default"
              >
                <Plus className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => applyIntroZoom(1)}
                title="点击重置为 1.0x"
                className="font-mono text-[10.5px] text-zinc-200 hover:text-white w-9 text-center cursor-pointer"
              >
                {zoom.toFixed(1)}x
              </button>
            </div>

            <div className="px-2.5 py-0.5 rounded-lg bg-zinc-950/90 border border-zinc-800 font-mono tabular-nums text-zinc-400">
              <span ref={timeReadoutRef} className="text-zinc-100 font-semibold">
                {formatMmSs(playheadSec)}.{Math.floor((playheadSec % 1) * 10)}
              </span>
              <span className="mx-1 text-zinc-600">/</span>
              <span className="text-purple-400 font-semibold">{totalIntroSec.toFixed(1)}s</span>
            </div>
          </div>
        </div>

        {/* 多轨 DAW 视图：左 176px 音轨头 + 右可缩放时间标尺/逐字文字带/音轨画布，与音轨视图完全一致 */}
        <div className="flex-1 min-h-0 flex rounded-xl border border-zinc-800/90 bg-zinc-950 overflow-hidden shadow-inner">
          {/* Left Track Headers (176px, matching WaveformEditorBar) */}
          <div className="w-[176px] shrink-0 border-r border-zinc-800/90 bg-zinc-900/75 flex flex-col">
            <div className="h-[22px] shrink-0 border-b border-zinc-800/90 px-2.5 flex items-center justify-between text-[10px] font-mono text-zinc-500">
              <span>音轨</span>
              <span>片头时间轴</span>
            </div>
            <div className="h-[24px] shrink-0 border-b border-zinc-800/90 px-2.5 flex items-center text-[10px] font-mono text-zinc-400 bg-[#0c0c11]">
              <span>逐字文案</span>
            </div>

            <div className="flex-1 min-h-0 flex flex-col">
              {speakerTracks.map((tr) => (
                <div
                  key={tr.id}
                  className="flex-1 min-h-[54px] border-b border-zinc-800/60 px-2.5 py-1.5 flex flex-col justify-center gap-1"
                >
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-1.5 h-3.5 rounded-full shrink-0"
                        style={{ backgroundColor: tr.color }}
                      />
                      <span className="text-[11px] font-semibold text-zinc-100 truncate">
                        {tr.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => toggleTrackSolo(tr.id)}
                        title="独奏此轨 (Solo)"
                        className={`w-[16px] h-[16px] rounded text-[9px] font-mono font-bold flex items-center justify-center cursor-pointer ${
                          tr.solo
                            ? 'bg-amber-500 text-zinc-950'
                            : 'bg-zinc-800/90 text-zinc-400 hover:text-white'
                        }`}
                      >
                        S
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleTrackMute(tr.id)}
                        title="静音此轨 (Mute)"
                        className={`w-[16px] h-[16px] rounded text-[9px] font-mono font-bold flex items-center justify-center cursor-pointer ${
                          tr.muted
                            ? 'bg-red-500/90 text-white'
                            : 'bg-zinc-800/90 text-zinc-400 hover:text-white'
                        }`}
                      >
                        M
                      </button>
                    </div>
                  </div>
                  <div className="text-[10px] text-zinc-500 truncate">
                    {tr.roleLabel}
                  </div>
                </div>
              ))}

              {/* 固定口播紧凑轨头 */}
              <div className="h-[44px] shrink-0 border-b border-zinc-800/60 px-2.5 flex items-center justify-between gap-1 bg-zinc-900/40">
                <div className="min-w-0">
                  <div className="flex items-center gap-1 text-[11px] font-semibold text-amber-200 truncate">
                    <Mic className="w-3 h-3 text-amber-400 shrink-0" />
                    <span>固定口播</span>
                  </div>
                  <div className="text-[9px] text-zinc-500 truncate">
                    {state.introVoiceover?.enabled ? `@${introVoStartSec.toFixed(1)}s` : '未启用'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onImportBgm('intro_vo')}
                  title="导入或更换固定口播音频"
                  className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer shrink-0"
                >
                  <Upload className="w-3 h-3" />
                </button>
              </div>

              {/* 片头 BGM 紧凑轨头 */}
              <div className="h-[44px] shrink-0 px-2.5 flex items-center justify-between gap-1 bg-zinc-900/40 border-t border-cyan-500/20">
                <div className="min-w-0">
                  <div className="flex items-center gap-1 text-[11px] font-semibold text-cyan-300 truncate">
                    <Music className="w-3 h-3 text-cyan-400 shrink-0" />
                    <span>片头 BGM</span>
                  </div>
                  <div className="text-[9px] text-zinc-500 truncate">
                    {state.introBgm?.enabled ? `固定 ${introBgmDurationSec.toFixed(1)}s · 智能避让` : '未启用'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onImportBgm('intro')}
                  title="导入或更换片头 BGM"
                  className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer shrink-0"
                >
                  <Upload className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>

          {/* Right Scrollable Multi-Track Canvas Area */}
          <div ref={scrollViewportRef} className="flex-1 overflow-x-auto relative select-none bg-[#0f1218]">
            <div
              ref={trackAreaRef}
              style={{ width: `${zoom * 100}%`, minWidth: '100%' }}
              className="relative h-full flex flex-col"
            >
              {/* Ruler (22px) */}
              <div
                onPointerDown={(e) => {
                  const el = trackAreaRef.current;
                  if (!el) return;
                  const rect = el.getBoundingClientRect();
                  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
                  const sec = Number((ratio * timelineSpanSec).toFixed(2));
                  seekIntroToSec(sec);
                  setDragAction({ kind: 'scrub', rectLeft: rect.left, rectWidth: rect.width });
                }}
                onDoubleClick={() => applyIntroZoom(1)}
                title="点击或横向拖动调整试听游标 · 双击重置 1x · Ctrl/Cmd+滚轮缩放时间轴"
                className="h-[22px] shrink-0 border-b border-white/10 bg-[#12161f] relative cursor-pointer"
              >
                {rulerTicks.map((t) => (
                  <div
                    key={t}
                    style={{ left: `${(t / timelineSpanSec) * 100}%` }}
                    className="absolute top-0 bottom-0 border-l border-white/15 pl-1 flex items-center text-[10px] font-mono text-zinc-400 pointer-events-none"
                  >
                    {t}s
                  </div>
                ))}
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] font-mono text-zinc-500 pointer-events-none">
                  空格播放 · 滚轮缩放 · 拖动片段调整 · 段落静音框选区间
                </span>
              </div>

              {/* 逐字文字带 (24px, matching WaveformEditorBar wordTimelineMode) */}
              <div
                onPointerDown={(e) => {
                  const el = trackAreaRef.current;
                  if (!el) return;
                  const rect = el.getBoundingClientRect();
                  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
                  const sec = Number((ratio * timelineSpanSec).toFixed(2));
                  seekIntroToSec(sec);
                  setDragAction({ kind: 'scrub', rectLeft: rect.left, rectWidth: rect.width });
                }}
                title="逐字对齐时间轴（单击或拖动定位播放游标）"
                className="h-[24px] shrink-0 border-b border-white/10 bg-[#0c0c11] relative cursor-pointer"
              >
                <IntroWordRulerBand
                  annotations={introWordAnnotations}
                  totalSec={timelineSpanSec}
                  trackColorBySpeaker={new Map(speakerTracks.map((t) => [t.id, t.color]))}
                />
              </div>

              <div className="flex-1 min-h-0 flex flex-col">
                {speakerTracks.map((tr, trIdx) => {
                  const isTrackMuted = tr.muted;
                  return (
                    <div
                      key={tr.id}
                      onPointerDown={(e) => {
                        if (toolMode === 'mute_range' || e.shiftKey) {
                          const el = trackAreaRef.current;
                          if (!el) return;
                          const rect = el.getBoundingClientRect();
                          const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
                          const sec = Math.round(ratio * timelineSpanSec * 20) / 20;
                          setDragAction({ kind: 'mute_range', trackId: tr.id, startSec: sec, endSec: sec });
                        }
                      }}
                      className={`flex-1 min-h-[54px] border-b border-white/[0.07] relative ${
                        trIdx % 2 === 1 ? 'bg-white/[0.015]' : 'bg-transparent'
                      } ${toolMode === 'mute_range' ? 'cursor-crosshair' : ''}`}
                    >
                      {/* Center 0dB reference line & right scale labels (matching WaveformEditorBar) */}
                      <div
                        className="absolute left-0 right-0 top-1/2 h-px pointer-events-none opacity-25"
                        style={{ backgroundColor: tr.color }}
                      />
                      <span className="absolute right-1.5 top-1 text-[8px] font-mono text-zinc-500/70 pointer-events-none">
                        0dB
                      </span>
                      <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[8px] font-mono text-zinc-500/60 pointer-events-none">
                        -6
                      </span>

                      {clipWindows.map(({ highlight: hl, startSec, endSec }) => {
                        const leftPct = (startSec / timelineSpanSec) * 100;
                        const widthPct = Math.max(0.8, ((endSec - startSec) / timelineSpanSec) * 100);
                        const isSelected = selectedHlId === hl.id;
                        const isPrimarySpeaker = hl.speakerId === tr.id;
                        const isClipMuted = isTrackMuted || Boolean(hl.mutedTrackIds?.includes(tr.id));
                        const trEnv = hiResEnvelopesRef.current.get(tr.id);
                        void hiResRev;

                        return (
                          <div
                            key={`${tr.id}_${hl.id}`}
                            style={{
                              left: `${leftPct}%`,
                              width: `${widthPct}%`,
                              borderColor: isSelected ? '#ffffff' : tr.color,
                              backgroundColor: isClipMuted
                                ? 'rgba(39,39,42,0.42)'
                                : `${tr.color}18`,
                            }}
                            onPointerDown={(e) => {
                              if (toolMode === 'mute_range' || e.shiftKey) return;
                              e.stopPropagation();
                              setSelectedHlId(hl.id);
                              setDragAction({
                                kind: 'move_hl',
                                hlId: hl.id,
                                startClientX: e.clientX,
                                origStartSec: startSec,
                              });
                            }}
                            title={
                              toolMode === 'mute_range'
                                ? `在 ${tr.name} 轨横向框选静音区间`
                                : `${isPrimarySpeaker ? '主讲金句' : '同段副轨'} · ${startSec.toFixed(1)}s–${endSec.toFixed(1)}s · 拖动调整位置 / 左右边缘修剪 · ${hl.text}`
                            }
                            className={`absolute top-1 bottom-1 rounded border overflow-hidden flex flex-col justify-between px-1.5 py-0.5 shadow-sm ${
                              toolMode === 'mute_range'
                                ? 'cursor-crosshair'
                                : 'cursor-grab active:cursor-grabbing'
                            }`}
                          >
                            {toolMode === 'edit' && (
                              <div
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  setSelectedHlId(hl.id);
                                  setDragAction({
                                    kind: 'trim_hl_left',
                                    hlId: hl.id,
                                    startClientX: e.clientX,
                                    origIntroStartSec: startSec,
                                    origSourceStartMs: hl.sourceStartMs,
                                    origSourceEndMs: hl.sourceEndMs,
                                    origDurationSec: hl.durationSec,
                                  });
                                }}
                                title="左右拖动修剪金句开头（不改变原音频）"
                                className="absolute left-0 top-0 bottom-0 w-1.5 bg-white/20 hover:bg-white/75 cursor-ew-resize z-10"
                              />
                            )}
                            {toolMode === 'edit' && (
                              <div
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  setSelectedHlId(hl.id);
                                  setDragAction({
                                    kind: 'trim_hl_right',
                                    hlId: hl.id,
                                    startClientX: e.clientX,
                                    origSourceStartMs: hl.sourceStartMs,
                                    origDurationSec: hl.durationSec,
                                    maxSourceMs: tr.durationMs ?? hl.sourceEndMs + 30000,
                                  });
                                }}
                                title="左右拖动扩展或缩短金句结尾"
                                className="absolute right-0 top-0 bottom-0 w-1.5 bg-white/20 hover:bg-white/75 cursor-ew-resize z-10"
                              />
                            )}

                            {/* Top compact clip badge (word-by-word captions rendered in top word band) */}
                            <div className="flex items-center justify-between gap-1 text-[9.5px] z-10 pl-0.5 pr-0.5 leading-tight">
                              <span
                                className={`truncate pointer-events-none font-mono ${
                                  isClipMuted ? 'text-zinc-400' : isPrimarySpeaker ? 'text-zinc-200' : 'text-zinc-400'
                                }`}
                              >
                                {isPrimarySpeaker
                                  ? `🎙️ ${startSec.toFixed(1)}–${endSec.toFixed(1)}s`
                                  : `副轨 ${startSec.toFixed(1)}–${endSec.toFixed(1)}s`}
                              </span>
                              <button
                                type="button"
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleHighlightTrackMute(hl.id, tr.id);
                                }}
                                title={isClipMuted ? '点击恢复此音轨该金句声音' : '点击静音此音轨该金句'}
                                className={`px-1 py-px rounded text-[9px] shrink-0 cursor-pointer transition ${
                                  isClipMuted
                                    ? 'bg-zinc-800/95 text-zinc-200 border border-zinc-600/70'
                                    : isPrimarySpeaker
                                    ? 'bg-purple-950/80 text-purple-200 hover:bg-purple-900/80'
                                    : 'bg-emerald-950/80 text-emerald-200 hover:bg-emerald-900/80'
                                }`}
                              >
                                {isClipMuted ? '🔇 静音' : isPrimarySpeaker ? '🔊 主讲' : '🔊 原声'}
                              </button>
                            </div>

                            <div className="flex-1 min-h-0 w-full pointer-events-none">
                              <HiResClipWaveformCanvas
                                hiRes={trEnv}
                                legacyPeaks={tr.peaks}
                                durationMs={tr.durationMs || trEnv?.durationMs || hl.sourceEndMs}
                                sliceStartMs={Math.max(
                                  0,
                                  hl.sourceStartMs -
                                    (state.recordingMode !== 'same_room_sync' ? tr.syncOffsetMs || 0 : 0)
                                )}
                                sliceEndMs={Math.max(
                                  0,
                                  hl.sourceEndMs -
                                    (state.recordingMode !== 'same_room_sync' ? tr.syncOffsetMs || 0 : 0)
                                )}
                                color={tr.color}
                                dimmed={isClipMuted}
                                gainLinear={
                                  state.loudnessAligned
                                    ? Math.pow(10, Math.min(8, Math.max(-12, tr.autoGainDb)) / 20)
                                    : 1.0
                                }
                                sharedRefCeiling={sharedTrackCeiling}
                              />
                            </div>

                            {(hl.partiallyMutedRanges ?? [])
                              .filter((pm) => pm.trackId === tr.id)
                              .map((pm) => {
                                const pmLeftPct =
                                  ((pm.sourceStartMs - hl.sourceStartMs) /
                                    Math.max(1, hl.sourceEndMs - hl.sourceStartMs)) *
                                  100;
                                const pmWidthPct =
                                  ((pm.sourceEndMs - pm.sourceStartMs) /
                                    Math.max(1, hl.sourceEndMs - hl.sourceStartMs)) *
                                  100;
                                return (
                                  <button
                                    key={pm.id}
                                    type="button"
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      removePartialMuteRange(hl.id, pm.id);
                                    }}
                                    style={{
                                      left: `${Math.max(0, pmLeftPct)}%`,
                                      width: `${Math.min(100, Math.max(4, pmWidthPct))}%`,
                                    }}
                                    title="已静音该音轨段落（点击恢复声音）"
                                    className="absolute inset-y-0 bg-zinc-950/75 border-x border-dashed border-zinc-400/70 flex items-start justify-start p-0.5 z-20 cursor-pointer hover:bg-zinc-900/85"
                                  >
                                    <span className="px-1 py-px rounded bg-zinc-800/95 text-[9px] font-semibold text-zinc-200 leading-none">
                                      🔇 静音
                                    </span>
                                  </button>
                                );
                              })}
                          </div>
                        );
                      })}

                      {dragAction?.kind === 'mute_range' && dragAction.trackId === tr.id && (
                        <div
                          style={{
                            left: `${(Math.min(dragAction.startSec, dragAction.endSec) / timelineSpanSec) * 100}%`,
                            width: `${(Math.abs(dragAction.endSec - dragAction.startSec) / timelineSpanSec) * 100}%`,
                          }}
                          className="absolute inset-y-1 bg-rose-500/25 border border-rose-400 pointer-events-none z-30"
                        />
                      )}
                    </div>
                  );
                })}

                {/* 固定口播紧凑轨 */}
                <div className="h-[44px] shrink-0 border-b border-white/[0.07] relative bg-white/[0.01]">
                  {state.introVoiceover?.enabled && (state.introVoiceover.filePath || state.introVoiceover.audioUrl) ? (
                    <div
                      style={{
                        left: `${(introVoStartSec / timelineSpanSec) * 100}%`,
                        width: `${Math.max(1.2, (introVoDurationSec / timelineSpanSec) * 100)}%`,
                      }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setDragAction({
                          kind: 'move_vo',
                          startClientX: e.clientX,
                          origStartOffsetSec: introVoStartSec,
                        });
                      }}
                      title="左右拖动调整固定片头口播起播时间"
                      className="absolute top-1 bottom-1 rounded border border-amber-400/75 bg-amber-500/12 cursor-grab active:cursor-grabbing overflow-hidden px-1.5 py-0.5 flex flex-col justify-between shadow-sm"
                    >
                      <span className="text-[9.5px] font-semibold text-amber-200 truncate pointer-events-none z-10 leading-none">
                        🎙️ 固定口播 · @{introVoStartSec.toFixed(1)}s ({introVoDurationSec.toFixed(1)}s) · 可左右拖动
                      </span>
                      <div className="flex-1 min-h-0 w-full pointer-events-none">
                        <HiResClipWaveformCanvas
                          hiRes={hiResEnvelopesRef.current.get('__intro_vo__')}
                          legacyPeaks={state.introVoiceover.peaks ?? []}
                          durationMs={introVoDurationSec * 1000}
                          sliceStartMs={0}
                          sliceEndMs={introVoDurationSec * 1000}
                          color="#fbbf24"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-[11px] text-zinc-600">
                      未开启固定口播（点击左侧上传按钮导入）
                    </div>
                  )}
                </div>

                {/* 片头 BGM 紧凑轨（支持拖动起止位置、截取长度与闪避包络） */}
                <div className="h-[44px] shrink-0 relative border-t border-cyan-500/25 bg-cyan-500/[0.02]">
                  {state.introBgm?.enabled && (state.introBgm.filePath || state.introBgm.audioUrl || state.bgmWavPath) ? (
                    (() => {
                      const bgmStartSec = Math.max(0, state.introBgm.startOffsetSec ?? 0);
                      const bgmSrcStartSec = Math.max(0, state.introBgm.sourceStartSec ?? 0);
                      return (
                    <div
                      style={{
                        left: `${Math.min(98, (bgmStartSec / timelineSpanSec) * 100)}%`,
                        width: `${Math.min(100, (introBgmDurationSec / timelineSpanSec) * 100)}%`,
                      }}
                      onPointerDown={(e) => {
                        if (toolMode !== 'edit') return;
                        e.stopPropagation();
                        setDragAction({
                          kind: 'move_bgm',
                          startClientX: e.clientX,
                          origStartSec: bgmStartSec,
                        });
                      }}
                      title={`片头 BGM · ${bgmStartSec.toFixed(1)}s–${(bgmStartSec + introBgmDurationSec).toFixed(1)}s (${introBgmDurationSec.toFixed(1)}s) · 拖动平移或调整左右边缘`}
                      className={`absolute top-1 bottom-1 rounded border border-cyan-500/45 bg-cyan-500/[0.06] overflow-hidden px-1.5 py-0.5 flex flex-col justify-between ${
                        toolMode === 'edit' ? 'cursor-grab active:cursor-grabbing' : ''
                      }`}
                    >
                      <div className="absolute top-0 left-0 right-0 h-[1.5px] bg-cyan-400/60 pointer-events-none" />
                      {toolMode === 'edit' && (
                        <div
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            setDragAction({
                              kind: 'trim_bgm_left',
                              startClientX: e.clientX,
                              origStartSec: bgmStartSec,
                              origDurationSec: introBgmDurationSec,
                            });
                          }}
                          title="左右拖动调整片头 BGM 开始位置"
                          className="absolute left-0 top-0 bottom-0 w-1.5 bg-cyan-300/30 hover:bg-cyan-300/80 cursor-ew-resize z-10"
                        />
                      )}
                      {toolMode === 'edit' && (
                        <div
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            setDragAction({
                              kind: 'trim_bgm_right',
                              startClientX: e.clientX,
                              origDurationSec: introBgmDurationSec,
                              maxDurationSec: Math.max(
                                30,
                                state.introBgm?.durationSec ?? introBgmDurationSec + 30
                              ),
                            });
                          }}
                          title="左右拖动调整片头 BGM 结束位置与时长"
                          className="absolute right-0 top-0 bottom-0 w-1.5 bg-cyan-300/30 hover:bg-cyan-300/80 cursor-ew-resize z-10"
                        />
                      )}
                      <span className="text-[9.5px] font-semibold text-cyan-300 truncate pointer-events-none z-10 leading-none">
                        🎬 片头 BGM · {bgmStartSec.toFixed(1)}s–{(bgmStartSec + introBgmDurationSec).toFixed(1)}s (避让 {state.bgmDuckDb ?? -18}dB)
                      </span>
                      <div className="flex-1 min-h-0 w-full pointer-events-none">
                        <HiResClipWaveformCanvas
                          hiRes={hiResEnvelopesRef.current.get('__intro_bgm__')}
                          legacyPeaks={state.introBgm.peaks ?? []}
                          durationMs={(state.introBgm.durationSec ?? introBgmDurationSec) * 1000}
                          sliceStartMs={bgmSrcStartSec * 1000}
                          sliceEndMs={(bgmSrcStartSec + introBgmDurationSec) * 1000}
                          color="#06b6d4"
                          gainFn={(relT) => {
                            const t = bgmStartSec + relT;
                            const duck = computeIntroBgmDuckMultiplier(
                              t,
                              introVoiceWindows,
                              introFadeInSec,
                              introFadeOutSec,
                              duckPct / 100
                            );
                            let fade = 1.0;
                            if (introFadeInSec > 0 && relT < introFadeInSec) {
                              fade = Math.min(1.0, Math.max(0, relT / introFadeInSec));
                            }
                            if (introFadeOutSec > 0 && relT > introBgmDurationSec - introFadeOutSec) {
                              fade = Math.min(
                                fade,
                                Math.max(0, (introBgmDurationSec - relT) / introFadeOutSec)
                              );
                            }
                            return duck * fade;
                          }}
                        />
                      </div>
                    </div>
                      );
                    })()
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-[11px] text-zinc-600">
                      未开启片头 BGM（点击左侧上传按钮导入）
                    </div>
                  )}
                </div>
              </div>

              {/* Playhead vertical line */}
              <div
                ref={playheadLineRef}
                style={{ left: `${playheadPct}%` }}
                className="absolute top-0 bottom-0 w-0.5 bg-red-500 pointer-events-none z-20 shadow-[0_0_8px_rgba(239,68,68,0.85)]"
              >
                <div className="w-2.5 h-2.5 -ml-[4px] bg-red-500 rotate-45 rounded-xs" />
              </div>
            </div>
          </div>
        </div>

        {/* 片头 BGM 文件拖拽截取条 */}
        <BgmSourceTrimmer
          label="片头 BGM"
          accentColor="cyan"
          asset={state.introBgm}
          resolvedDurationSec={
            hiResEnvelopesRef.current.get('__intro_bgm__')?.durationMs
              ? hiResEnvelopesRef.current.get('__intro_bgm__')!.durationMs / 1000
              : undefined
          }
          onChangeSlice={(patch) =>
            onUpdateState((prev) =>
              prev.introBgm ? { ...prev, introBgm: { ...prev.introBgm, ...patch } } : prev
            )
          }
          onApplyDuration={(sliceDur) =>
            onUpdateState((prev) =>
              prev.introBgm
                ? { ...prev, introBgm: { ...prev.introBgm, customDurationSec: sliceDur } }
                : prev
            )
          }
        />
      </div>
    </div>
  );
};
