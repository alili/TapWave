import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Minus,
  Music,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Upload,
  Volume2,
} from 'lucide-react';
import { AuxAudioSlot, PodcastProjectState } from '../types/podcast';
import {
  computeIntroBgmDuckMultiplier,
  formatMmSs,
  IntroBgmVoiceWindow,
  TimelineComputation,
} from '../engine/timelineEngine';
import { audioPreview, resolveEditedPlayheadToSource } from '../engine/audioPreviewEngine';
import {
  computeLegacyPeaksCalibration,
  computeSharedReferenceCeiling,
  computeTrackLinearGain,
  HiResWaveformEnvelope,
  loadTrackHiResEnvelope,
  sampleCalibratedWaveformPoint,
} from '../engine/waveformEnvelopeLoader';
import { BgmSourceTrimmer } from './BgmSourceTrimmer';

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return `rgba(16, 185, 129, ${alpha})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lightenHex(hex: string, amount: number): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return hex;
  const r = Math.min(255, ((num >> 16) & 255) + amount);
  const g = Math.min(255, ((num >> 8) & 255) + amount);
  const b = Math.min(255, (num & 255) + amount);
  return `rgb(${r}, ${g}, ${b})`;
}

interface OutroEditorViewProps {
  state: PodcastProjectState;
  timeline: TimelineComputation;
  onClose: () => void;
  onUpdateState: (updater: (prev: PodcastProjectState) => PodcastProjectState) => void;
  onImportBgm: (slot: AuxAudioSlot) => void;
  onSeekMainPlayhead: (sec: number) => void;
}

const MAX_OUTRO_ZOOM = 16;

export const OutroEditorView: React.FC<OutroEditorViewProps> = ({
  state,
  timeline,
  onClose,
  onUpdateState,
  onImportBgm,
  onSeekMainPlayhead,
}) => {
  const speakerTracks = useMemo(
    () => (state.tracks.some((t) => !t.isRef) ? state.tracks.filter((t) => !t.isRef) : state.tracks),
    [state.tracks]
  );

  const [hiResRev, setHiResRev] = useState<number>(0);
  const hiResEnvelopesRef = useRef<Map<string, HiResWaveformEnvelope>>(new Map());
  const [dragAction, setDragAction] = useState<
    | null
    | { kind: 'scrub'; rectLeft: number; rectWidth: number }
    | { kind: 'move_outro'; startClientX: number; origStartSec: number; pxPerSec: number }
    | {
        kind: 'trim_outro_left';
        startClientX: number;
        origStartSec: number;
        origDurSec: number;
        origSourceStartSec: number;
        origSourceEndSec: number;
        pxPerSec: number;
      }
    | { kind: 'trim_outro_right'; startClientX: number; origDurSec: number; pxPerSec: number }
  >(null);
  const frozenViewRef = useRef<{ startSec: number; spanSec: number } | null>(null);

  const totalEditedSec = Math.max(10, timeline.totalEditedDurationSec);
  const hiResOutroEnv = hiResEnvelopesRef.current.get('__outro_bgm__');
  void hiResRev;
  const bgmTotalDur = Math.max(
    1,
    hiResOutroEnv?.durationMs
      ? hiResOutroEnv.durationMs / 1000
      : state.outroBgm?.durationSec ?? 30
  );
  const bgmSliceStart = Math.max(0, Math.min(bgmTotalDur - 0.5, state.outroBgm?.sourceStartSec ?? 0));
  const bgmSliceEnd = Math.max(
    bgmSliceStart + 0.5,
    Math.min(bgmTotalDur, state.outroBgm?.sourceEndSec ?? bgmTotalDur)
  );
  const bgmSliceDur = Math.max(0.5, bgmSliceEnd - bgmSliceStart);
  const defaultOutroDur = state.outroBgm?.enabled
    ? Number((bgmSliceDur * 1.2).toFixed(1))
    : Math.min(20, Math.max(6, totalEditedSec * 0.18));
  const outroDurSec =
    typeof state.outroBgm?.customDurationSec === 'number' && state.outroBgm.customDurationSec > 0
      ? state.outroBgm.customDurationSec
      : defaultOutroDur;
  const outroStartSec =
    typeof state.outroBgm?.startOffsetSec === 'number' && state.outroBgm.startOffsetSec >= 0
      ? Math.min(Math.max(0, totalEditedSec - 0.5), state.outroBgm.startOffsetSec)
      : Math.max(0, totalEditedSec - outroDurSec);
  const outroEndSec = outroStartSec + outroDurSec;

  // 视窗展示播客尾部区域：随片尾 BGM 长度增加自动扩展展示长度（拖拽过程中锁定坐标系避免跳动）
  const displayEndSec = Math.max(totalEditedSec, outroEndSec);
  const computedViewStartSec = Math.max(0, Math.min(outroStartSec - 4, totalEditedSec - 14));
  const computedViewSpanSec = Math.max(24, displayEndSec - computedViewStartSec);
  const viewStartSec = dragAction && frozenViewRef.current ? frozenViewRef.current.startSec : computedViewStartSec;
  const viewSpanSec = dragAction && frozenViewRef.current ? frozenViewRef.current.spanSec : computedViewSpanSec;

  const [playheadSec, setPlayheadSec] = useState<number>(outroStartSec);
  const playheadRef = useRef<number>(outroStartSec);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [zoom, setZoom] = useState<number>(1);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const trackAreaRef = useRef<HTMLDivElement | null>(null);
  const playheadLineRef = useRef<HTMLDivElement | null>(null);
  const timeReadoutRef = useRef<HTMLSpanElement | null>(null);
  const bgmCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const speakerCanvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());

  const outroFadeInMs = state.outroBgm?.fadeInMs ?? 1000;
  const outroFadeOutMs = state.outroBgm?.fadeOutMs ?? 2000;
  const outroFadeInSec = outroFadeInMs / 1000;
  const outroFadeOutSec = outroFadeOutMs / 1000;
  const duckPct = Math.max(10, Math.min(85, 100 - Math.abs(state.bgmDuckDb ?? -18) * 2.5));

  // 提取片尾视窗内的人声活跃窗口与文稿参考（卡片 + 逐字条）
  const { outroVoiceWindows, tailWords, tailTurnCards } = useMemo(() => {
    const wins: IntroBgmVoiceWindow[] = [];
    const words: Array<{
      id: string;
      text: string;
      speakerId: string;
      editedStartSec: number;
      editedEndSec: number;
    }> = [];
    const cards: Array<{
      id: string;
      speakerId: string;
      speakerName: string;
      color: string;
      startSec: number;
      endSec: number;
      text: string;
    }> = [];
    const trackById = new Map(speakerTracks.map((t) => [t.id, t]));

    for (const mt of timeline.mappedTokens) {
      if (mt.token.deleted || mt.token.type !== 'word') continue;
      if (mt.editedEndSec < viewStartSec || mt.editedStartSec > displayEndSec) continue;

      const lastWin = wins[wins.length - 1];
      if (lastWin && mt.editedStartSec - lastWin.endSec <= 0.45) {
        lastWin.endSec = Math.max(lastWin.endSec, mt.editedEndSec);
      } else {
        wins.push({ startSec: mt.editedStartSec, endSec: mt.editedEndSec });
      }

      words.push({
        id: mt.token.id,
        text: mt.token.text,
        speakerId: mt.speakerId,
        editedStartSec: mt.editedStartSec,
        editedEndSec: mt.editedEndSec,
      });

      const lastCard = cards[cards.length - 1];
      const tr = trackById.get(mt.speakerId);
      if (
        lastCard &&
        lastCard.speakerId === mt.speakerId &&
        mt.editedStartSec - lastCard.endSec <= 1.2 &&
        lastCard.text.length < 48
      ) {
        lastCard.endSec = mt.editedEndSec;
        lastCard.text += mt.token.text;
      } else {
        cards.push({
          id: mt.token.id,
          speakerId: mt.speakerId,
          speakerName: tr?.name ?? mt.speakerId,
          color: tr?.color ?? '#10b981',
          startSec: mt.editedStartSec,
          endSec: mt.editedEndSec,
          text: mt.token.text,
        });
      }
    }
    return { outroVoiceWindows: wins, tailWords: words, tailTurnCards: cards };
  }, [timeline.mappedTokens, speakerTracks, viewStartSec, displayEndSec]);

  useEffect(() => {
    let cancelled = false;
    speakerTracks.forEach((tr) => {
      if (!tr.filePath && !tr.audioUrl) return;
      void loadTrackHiResEnvelope({
        id: tr.id,
        filePath: tr.filePath,
        audioUrl: tr.audioUrl,
        durationMs: tr.durationMs ?? totalEditedSec * 1000,
      }).then((env) => {
        if (cancelled || !env) return;
        hiResEnvelopesRef.current.set(tr.id, env);
        setHiResRev((v) => v + 1);
      });
    });
    if (state.outroBgm?.enabled && (state.outroBgm.filePath || state.outroBgm.audioUrl)) {
      void loadTrackHiResEnvelope({
        id: '__outro_bgm__',
        filePath: state.outroBgm.filePath,
        audioUrl: state.outroBgm.audioUrl,
        durationMs: (state.outroBgm.durationSec ?? 20) * 1000,
      }).then((env) => {
        if (cancelled || !env) return;
        hiResEnvelopesRef.current.set('__outro_bgm__', env);
        setHiResRev((v) => v + 1);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [speakerTracks, totalEditedSec, state.outroBgm]);

  const updatePlayheadDom = (sec: number) => {
    const pct = Math.max(0, Math.min(100, ((sec - viewStartSec) / viewSpanSec) * 100));
    if (playheadLineRef.current) {
      playheadLineRef.current.style.left = `${pct}%`;
    }
    if (timeReadoutRef.current) {
      timeReadoutRef.current.textContent = `${formatMmSs(sec)}.${Math.floor((sec % 1) * 10)}`;
    }
  };

  const stateRef = useRef(state);
  stateRef.current = state;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

  const seekOutroToSec = (sec: number) => {
    const clamped = Math.max(viewStartSec, Math.min(displayEndSec, sec));
    playheadRef.current = clamped;
    setPlayheadSec(clamped);
    updatePlayheadDom(clamped);
    if (isPlaying) {
      audioPreview.syncMultiTrackPlayback(stateRef.current, timelineRef.current, clamped, true);
    }
  };

  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;
    let cancelled = false;
    let lastMs = performance.now();
    const tick = (nowMs: number) => {
      if (cancelled) return;
      const dt = Math.min(0.1, Math.max(0, (nowMs - lastMs) / 1000));
      lastMs = nowMs;
      const { nextPlayheadSec } = audioPreview.advanceAndSyncPlayback(
        stateRef.current,
        timelineRef.current,
        playheadRef.current,
        dt
      );
      if (nextPlayheadSec >= totalEditedSec) {
        playheadRef.current = outroStartSec;
        updatePlayheadDom(outroStartSec);
        setPlayheadSec(outroStartSec);
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
      cancelled = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [isPlaying, totalEditedSec, outroStartSec]);

  const togglePlay = () => {
    if (isPlaying) {
      audioPreview.pauseMultiTrackPlayback();
      setIsPlaying(false);
      return;
    }
    const startAt =
      playheadRef.current < viewStartSec || playheadRef.current >= totalEditedSec - 0.1
        ? outroStartSec
        : playheadRef.current;
    playheadRef.current = startAt;
    setPlayheadSec(startAt);
    updatePlayheadDom(startAt);
    audioPreview.startFromUserGesture(stateRef.current, timelineRef.current, startAt);
    setIsPlaying(true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.code === 'Space' || e.key === ' ') && !e.repeat) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 绘制人声轨尾部波形预览（与音轨视图完全一致的三层 DAW 波形渲染 + 0dB/-6dB 参考线）
  useEffect(() => {
    const sharedTrackCeiling = computeSharedReferenceCeiling(
      speakerTracks.map((tr) => {
        const env = hiResEnvelopesRef.current.get(tr.id);
        const cal = env ?? computeLegacyPeaksCalibration(tr.peaks ?? []);
        return {
          p992Peak: cal.p992Peak || 0.72,
          gainLinear: computeTrackLinearGain(tr.autoGainDb, state.loudnessAligned),
        };
      })
    );

    for (const tr of speakerTracks) {
      const canvas = speakerCanvasRefs.current.get(tr.id);
      if (!canvas) continue;
      const rect = canvas.getBoundingClientRect();
      const W = Math.max(1, Math.round(rect.width));
      const H = Math.max(1, Math.round(rect.height));
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const yMid = H / 2;
      const maxAmp = Math.max(6, H * 0.43);
      const env = hiResEnvelopesRef.current.get(tr.id);
      const peaks = tr.peaks ?? [];
      const calibration = env ?? computeLegacyPeaksCalibration(peaks);
      const durMs = Math.max(1000, tr.durationMs ?? env?.durationMs ?? totalEditedSec * 1000);
      const trackOffsetMs = state.recordingMode !== 'same_room_sync' ? tr.syncOffsetMs || 0 : 0;
      const gainLinear = computeTrackLinearGain(tr.autoGainDb, state.loudnessAligned);
      const halfWinRatio = Math.max(0.0001, (((viewSpanSec * 1000) / W) * 0.5) / durMs);
      const isMuted = Boolean(tr.muted);

      // Center 0-crossing axis
      ctx.strokeStyle = hexToRgba(tr.color, isMuted ? 0.08 : 0.24);
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(yMid) + 0.5);
      ctx.lineTo(W, Math.round(yMid) + 0.5);
      ctx.stroke();

      // Subtle -6dB reference lines
      if (H >= 34) {
        const subOffset = maxAmp * 0.5;
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

      for (let x = 0; x < W; x += 1) {
        const tSec = viewStartSec + (x / W) * viewSpanSec;
        if (tSec > totalEditedSec) continue;
        const mapped = resolveEditedPlayheadToSource(state, timeline, tSec);
        if (mapped.sourceSec === null) continue;
        const srcMs = Math.max(0, mapped.sourceSec * 1000 - trackOffsetMs);
        const ratio = Math.max(0, Math.min(0.999999, srcMs / durMs));
        const pt = sampleCalibratedWaveformPoint(
          env,
          peaks,
          ratio,
          halfWinRatio,
          gainLinear,
          calibration,
          sharedTrackCeiling
        );
        const posAmpPx = pt.posPeak * maxAmp;
        const negAmpPx = pt.negPeak * maxAmp;
        const rmsAmpPx = Math.min(pt.rms * maxAmp, Math.max(posAmpPx, negAmpPx) * 0.92);
        const isVoiced = !isMuted && Math.max(pt.posPeak, pt.negPeak) >= 0.018;
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
        ctx.strokeStyle = hexToRgba(tr.color, isMuted ? 0.18 : 0.24);
        ctx.lineWidth = 0.85;
        ctx.beginPath();
        for (let i = 0; i < samples.length; i++) {
          const p = samples[i];
          if (p.posAmpPx > 0.35 || p.negAmpPx > 0.35) {
            const xa = Math.round(p.x) + 0.5;
            ctx.moveTo(xa, p.yUpper);
            ctx.lineTo(xa, p.yLower);
          }
        }
        ctx.stroke();
        ctx.restore();

        if (!isMuted) {
          const coreLineColor = lightenHex(tr.color, 36);
          const rmsCoreColor = lightenHex(tr.color, 68);

          // Pass 2: Voiced Peak Transient Layer
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
            const nextX = i + 1 < samples.length ? (p.x + samples[i + 1].x) * 0.5 : p.x + 0.5;
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

          // Pass 3: Voiced Bright RMS Loudness Core
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
            if (p.isVoiced && p.rmsAmpPx >= 0.6) {
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
    }
  }, [speakerTracks, state, timeline, viewStartSec, viewSpanSec, totalEditedSec, zoom, hiResRev]);

  // 绘制片尾 BGM 波形（含截取区间、避让包络与淡入淡出）
  useEffect(() => {
    const canvas = bgmCanvasRef.current;
    if (!canvas || !state.outroBgm?.enabled) return;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width));
    const H = Math.max(1, Math.round(rect.height));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const hiRes = hiResEnvelopesRef.current.get('__outro_bgm__');
    const peaks = state.outroBgm.peaks ?? [];
    const calibration = hiRes ?? computeLegacyPeaksCalibration(peaks);
    const sharedRefCeiling = calibration.p992Peak || 0.72;
    const totalBgmDurMs = Math.max(1000, (state.outroBgm.durationSec ?? outroDurSec) * 1000);
    const srcStartMs = Math.max(0, (state.outroBgm.sourceStartSec ?? 0) * 1000);
    const srcEndMs =
      typeof state.outroBgm.sourceEndSec === 'number' && state.outroBgm.sourceEndSec * 1000 > srcStartMs + 500
        ? state.outroBgm.sourceEndSec * 1000
        : totalBgmDurMs;
    const sliceSpanMs = Math.max(500, srcEndMs - srcStartMs);
    const yMid = H / 2;
    const maxAmp = Math.max(4, H * 0.42);

    ctx.strokeStyle = state.outroBgm.muted ? 'rgba(161,161,170,0.3)' : '#10b981';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < W; x += 1) {
      const relSec = (x / W) * outroDurSec;
      const absSec = outroStartSec + relSec;
      const tMsInSlice = srcStartMs + relSec * 1000;
      if (tMsInSlice > srcEndMs) {
        continue;
      }
      const ratio = Math.max(0, Math.min(0.999999, tMsInSlice / totalBgmDurMs));
      const pt = sampleCalibratedWaveformPoint(
        hiRes,
        peaks,
        ratio,
        0.001,
        1.0,
        calibration,
        sharedRefCeiling
      );
      const duck = computeIntroBgmDuckMultiplier(
        absSec,
        outroVoiceWindows,
        outroFadeInSec,
        outroFadeOutSec,
        duckPct / 100
      );
      let fade = 1.0;
      if (outroFadeInSec > 0 && relSec < outroFadeInSec) {
        fade = Math.min(1.0, Math.max(0, relSec / outroFadeInSec));
      }
      if (outroFadeOutSec > 0 && relSec > outroDurSec - outroFadeOutSec) {
        fade = Math.min(fade, Math.max(0, (outroDurSec - relSec) / outroFadeOutSec));
      }
      const g = duck * fade;
      const up = pt.posPeak * g * maxAmp;
      const dn = pt.negPeak * g * maxAmp;
      ctx.moveTo(x + 0.5, yMid - up);
      ctx.lineTo(x + 0.5, yMid + dn);
    }
    ctx.stroke();
    ctx.restore();
  }, [
    state.outroBgm,
    outroStartSec,
    outroDurSec,
    outroFadeInSec,
    outroFadeOutSec,
    duckPct,
    outroVoiceWindows,
    hiResRev,
    zoom,
  ]);

  useEffect(() => {
    if (!dragAction) {
      frozenViewRef.current = null;
      return;
    }
    const onMove = (e: PointerEvent) => {
      if (dragAction.kind === 'scrub') {
        const ratio = Math.max(0, Math.min(1, (e.clientX - dragAction.rectLeft) / Math.max(1, dragAction.rectWidth)));
        seekOutroToSec(viewStartSec + ratio * viewSpanSec);
        return;
      }
      const deltaSec = (e.clientX - dragAction.startClientX) / Math.max(1, dragAction.pxPerSec);
      const snap = (v: number) => Math.round(v * 10) / 10;

      if (dragAction.kind === 'move_outro') {
        const nextStart = Math.max(
          0,
          Math.min(Math.max(0, totalEditedSec - 1.0), snap(dragAction.origStartSec + deltaSec))
        );
        onUpdateState((prev) =>
          prev.outroBgm ? { ...prev, outroBgm: { ...prev.outroBgm, startOffsetSec: nextStart } } : prev
        );
      } else if (dragAction.kind === 'trim_outro_left') {
        // 维持右侧结束位置不变，同步移动 sourceStartSec，不重复补齐片头
        const origEnd = dragAction.origStartSec + dragAction.origDurSec;
        const minStartBySource = dragAction.origStartSec - dragAction.origSourceStartSec;
        const maxStartByDur = origEnd - 1.0;
        const maxStartBySource =
          dragAction.origStartSec + (dragAction.origSourceEndSec - dragAction.origSourceStartSec - 0.5);
        const minStart = Math.max(0, minStartBySource);
        const maxStart = Math.max(minStart, Math.min(maxStartByDur, maxStartBySource));
        const nextStart = Math.max(minStart, Math.min(maxStart, snap(dragAction.origStartSec + deltaSec)));
        const trimDelta = nextStart - dragAction.origStartSec;
        const nextDur = Number(Math.max(1.0, origEnd - nextStart).toFixed(1));
        const nextSourceStart = Number(
          Math.max(0, Math.min(dragAction.origSourceEndSec - 0.5, dragAction.origSourceStartSec + trimDelta)).toFixed(1)
        );
        onUpdateState((prev) =>
          prev.outroBgm
            ? {
                ...prev,
                outroBgm: {
                  ...prev.outroBgm,
                  startOffsetSec: nextStart,
                  customDurationSec: nextDur,
                  sourceStartSec: nextSourceStart,
                  sourceEndSec: dragAction.origSourceEndSec,
                },
              }
            : prev
        );
      } else if (dragAction.kind === 'trim_outro_right') {
        const maxDur = Math.max(totalEditedSec - outroStartSec + 30, bgmSliceDur * 2, 60);
        const nextDur = Number(Math.max(1.0, Math.min(maxDur, snap(dragAction.origDurSec + deltaSec))).toFixed(1));
        onUpdateState((prev) =>
          prev.outroBgm ? { ...prev, outroBgm: { ...prev.outroBgm, customDurationSec: nextDur } } : prev
        );
      }
    };
    const onUp = () => {
      frozenViewRef.current = null;
      setDragAction(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragAction, viewSpanSec, viewStartSec, totalEditedSec, outroStartSec, bgmSliceDur, onUpdateState]);

  const zoomToSliderVal = (z: number) =>
    Math.round((Math.log(Math.max(1, Math.min(MAX_OUTRO_ZOOM, z))) / Math.log(MAX_OUTRO_ZOOM)) * 1000);
  const sliderValToZoom = (val: number) =>
    Number(Math.exp((Math.max(0, Math.min(1000, val)) / 1000) * Math.log(MAX_OUTRO_ZOOM)).toFixed(2));
  const applyOutroZoom = (nextZoomRaw: number) => {
    const nextZoom = Math.max(1, Math.min(MAX_OUTRO_ZOOM, Number(nextZoomRaw.toFixed(2))));
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

  const updateOutroFade = (patch: { fadeInMs?: number; fadeOutMs?: number }) => {
    onUpdateState((prev) => ({
      ...prev,
      outroBgm: {
        ...(prev.outroBgm ?? { fileName: '片尾 BGM', enabled: false }),
        ...patch,
      },
    }));
  };

  const visibleSec = viewSpanSec / zoom;
  const tickStep = visibleSec <= 4 ? 0.5 : visibleSec <= 12 ? 1 : visibleSec <= 30 ? 2 : 5;
  const rulerTicks: number[] = [];
  for (let t = Math.ceil(viewStartSec / tickStep) * tickStep; t <= displayEndSec + 0.001; t += tickStep) {
    rulerTicks.push(Number(t.toFixed(2)));
  }

  const playheadPct = Math.max(0, Math.min(100, ((playheadSec - viewStartSec) / viewSpanSec) * 100));
  const outroLeftPct = Math.max(0, ((outroStartSec - viewStartSec) / viewSpanSec) * 100);
  const outroWidthPct = Math.max(1, ((outroEndSec - outroStartSec) / viewSpanSec) * 100);

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col bg-zinc-950 overflow-hidden px-3 py-2 gap-1.5">
      {/* 顶部概览与片尾文稿参考卡片流 */}
      <div className="shrink-0 rounded-xl border border-zinc-800/90 bg-zinc-900/55 px-3 py-2 flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
            <span className="font-semibold text-zinc-100">片尾 BGM 与人声文稿参考</span>
            <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/35 font-mono text-[10px] text-emerald-300">
              片尾窗口 {formatMmSs(outroStartSec)} ~ {formatMmSs(outroEndSec)} ({outroDurSec.toFixed(1)}s · 1.2x)
            </span>
            <span className="px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 font-mono text-[10px] text-cyan-300">
              自动音量 · -16.0 LUFS / -1.0 dBTP 广播标准
            </span>
          </div>

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
            className="px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[11px] text-zinc-200 cursor-pointer"
          >
            返回音轨视图
          </button>
        </div>

        {/* 水平片尾文稿参考卡片流 */}
        <div className="flex items-stretch gap-2 overflow-x-auto pb-0.5">
          {tailTurnCards.length === 0 ? (
            <div className="px-3 py-1.5 rounded-lg border border-dashed border-zinc-700/80 text-xs text-zinc-500">
              片尾窗口内暂无人声文稿（可作为纯音乐片尾收束）
            </div>
          ) : (
            tailTurnCards.map((card) => {
              const isActive = playheadSec >= card.startSec && playheadSec <= card.endSec;
              return (
                <div
                  key={card.id}
                  onClick={() => seekOutroToSec(card.startSec)}
                  className={`w-56 shrink-0 rounded-lg border px-2.5 py-1.5 cursor-pointer transition flex flex-col justify-between gap-1 ${
                    isActive
                      ? 'border-emerald-500/80 bg-emerald-950/30 ring-1 ring-emerald-400/35'
                      : 'border-zinc-800 bg-zinc-950/75 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1 text-[10.5px]">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="w-1.5 h-3 rounded-full shrink-0" style={{ backgroundColor: card.color }} />
                      <span className="font-semibold text-zinc-100 truncate">{card.speakerName}</span>
                    </div>
                    <span className="font-mono text-[10px] text-emerald-300 shrink-0">
                      @{formatMmSs(card.startSec)}
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-300 leading-snug line-clamp-2">“{card.text}”</p>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 工具栏 */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 px-1 py-0.5 text-xs">
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg bg-zinc-950/90 border border-zinc-800">
            <button
              type="button"
              onClick={() => seekOutroToSec(outroStartSec)}
              title="回到片尾 BGM 起点"
              className="p-1 text-zinc-400 hover:text-zinc-100 rounded hover:bg-zinc-800 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.currentTarget.blur();
                togglePlay();
              }}
              title="播放 / 暂停片尾预览 (Space)"
              className={`px-2.5 py-0.5 rounded font-semibold flex items-center gap-1 cursor-pointer transition ${
                isPlaying ? 'bg-amber-500 text-zinc-950' : 'bg-emerald-600 hover:bg-emerald-500 text-white'
              }`}
            >
              {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              <span>{isPlaying ? '暂停' : '试听片尾'}</span>
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
              onChange={(e) => onUpdateState((p) => ({ ...p, bgmDuckDb: Number(e.target.value) }))}
              className="w-16 accent-blue-500 cursor-pointer"
            />
            <span className="font-mono text-blue-300 w-9 text-right">{state.bgmDuckDb ?? -18}dB</span>
          </div>

          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-zinc-950/90 border border-zinc-800 text-[11px] text-zinc-300">
            <span className="text-emerald-400">淡入</span>
            <input
              type="range"
              min={0.1}
              max={5.0}
              step={0.1}
              value={Number(outroFadeInSec.toFixed(1))}
              onChange={(e) => updateOutroFade({ fadeInMs: Math.round(Number(e.target.value) * 1000) })}
              className="w-14 accent-emerald-500 cursor-pointer"
            />
            <span className="font-mono text-emerald-300 w-8 text-right">{outroFadeInSec.toFixed(1)}s</span>
          </div>

          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-zinc-950/90 border border-zinc-800 text-[11px] text-zinc-300">
            <span className="text-emerald-400">淡出</span>
            <input
              type="range"
              min={0.1}
              max={5.0}
              step={0.1}
              value={Number(outroFadeOutSec.toFixed(1))}
              onChange={(e) => updateOutroFade({ fadeOutMs: Math.round(Number(e.target.value) * 1000) })}
              className="w-14 accent-emerald-500 cursor-pointer"
            />
            <span className="font-mono text-emerald-300 w-8 text-right">{outroFadeOutSec.toFixed(1)}s</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* 标尺缩放操作组件 */}
          <div className="flex items-center gap-1.5 bg-zinc-950/90 border border-zinc-800 rounded-lg px-2 py-0.5 text-zinc-400">
            <button
              type="button"
              onClick={() => applyOutroZoom(1)}
              disabled={zoom <= 1.01}
              title="还原片尾 1x 全览"
              className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-900 hover:bg-zinc-800 text-zinc-300 disabled:opacity-35 cursor-pointer disabled:cursor-default"
            >
              全览
            </button>
            <button
              type="button"
              onClick={() => applyOutroZoom(zoom / 1.5)}
              disabled={zoom <= 1}
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
              onChange={(e) => applyOutroZoom(sliderValToZoom(Number(e.target.value)))}
              className="w-20 accent-emerald-500 cursor-pointer"
            />
            <button
              type="button"
              onClick={() => applyOutroZoom(zoom * 1.5)}
              disabled={zoom >= MAX_OUTRO_ZOOM}
              className="p-0.5 hover:text-zinc-100 disabled:opacity-35 cursor-pointer disabled:cursor-default"
            >
              <Plus className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => applyOutroZoom(1)}
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
            <span className="text-emerald-400 font-semibold">{formatMmSs(totalEditedSec)}</span>
          </div>
        </div>
      </div>

      {/* 多轨 DAW 视图 */}
      <div className="flex-1 min-h-0 flex rounded-xl border border-zinc-800/90 bg-zinc-950 overflow-hidden shadow-inner">
        {/* Left Track Headers */}
        <div className="w-[176px] shrink-0 border-r border-zinc-800/90 bg-zinc-900/75 flex flex-col">
          <div className="h-[22px] shrink-0 border-b border-zinc-800/90 px-2.5 flex items-center justify-between text-[10px] font-mono text-zinc-500">
            <span>音轨</span>
            <span>片尾时间轴</span>
          </div>
          <div className="h-[24px] shrink-0 border-b border-zinc-800/90 px-2.5 flex items-center text-[10px] font-mono text-zinc-400 bg-[#0c0c11]">
            <span>逐字文案</span>
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            {speakerTracks.map((tr) => (
              <div
                key={tr.id}
                className="flex-1 min-h-[50px] border-b border-zinc-800/60 px-2.5 py-1.5 flex flex-col justify-center gap-0.5"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="w-1.5 h-3.5 rounded-full shrink-0" style={{ backgroundColor: tr.color }} />
                  <span className="text-[11px] font-semibold text-zinc-100 truncate">{tr.name}</span>
                </div>
                <div className="text-[10px] text-zinc-500 truncate">{tr.roleLabel} (参考人声)</div>
              </div>
            ))}

            {/* 片尾 BGM 轨头 */}
            <div className="h-[64px] shrink-0 px-2.5 flex items-center justify-between gap-1 bg-zinc-900/40 border-t border-emerald-500/20">
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-[11px] font-semibold text-emerald-300 truncate">
                  <Music className="w-3 h-3 text-emerald-400 shrink-0" />
                  <span>片尾 BGM</span>
                </div>
                <div className="text-[9px] text-zinc-500 truncate">
                  {state.outroBgm?.enabled ? `${outroDurSec.toFixed(1)}s · 自动音量` : '未启用'}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {state.outroBgm?.enabled && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateState((p) =>
                          p.outroBgm ? { ...p, outroBgm: { ...p.outroBgm, solo: !p.outroBgm.solo } } : p
                        )
                      }
                      className={`w-[16px] h-[16px] rounded text-[9px] font-mono font-bold flex items-center justify-center cursor-pointer ${
                        state.outroBgm.solo ? 'bg-amber-500 text-zinc-950' : 'bg-zinc-800 text-zinc-400 hover:text-white'
                      }`}
                    >
                      S
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateState((p) =>
                          p.outroBgm ? { ...p, outroBgm: { ...p.outroBgm, muted: !p.outroBgm.muted } } : p
                        )
                      }
                      className={`w-[16px] h-[16px] rounded text-[9px] font-mono font-bold flex items-center justify-center cursor-pointer ${
                        state.outroBgm.muted ? 'bg-red-500 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-white'
                      }`}
                    >
                      M
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => onImportBgm('outro')}
                  title="导入或更换片尾 BGM"
                  className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer"
                >
                  <Upload className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right Scrollable Multi-Track Canvas */}
        <div ref={scrollViewportRef} className="flex-1 overflow-x-auto relative select-none bg-[#0f1218]">
          <div
            ref={trackAreaRef}
            style={{ width: `${zoom * 100}%`, minWidth: '100%' }}
            className="relative h-full flex flex-col"
          >
            {/* Ruler */}
            <div
              onPointerDown={(e) => {
                const el = trackAreaRef.current;
                if (!el) return;
                const rect = el.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
                seekOutroToSec(viewStartSec + ratio * viewSpanSec);
                setDragAction({ kind: 'scrub', rectLeft: rect.left, rectWidth: rect.width });
              }}
              onDoubleClick={() => applyOutroZoom(1)}
              title="点击或横向拖动调整试听游标 · 双击重置 1x"
              className="h-[22px] shrink-0 border-b border-white/10 bg-[#12161f] relative cursor-pointer"
            >
              {rulerTicks.map((t) => (
                <div
                  key={t}
                  style={{ left: `${((t - viewStartSec) / viewSpanSec) * 100}%` }}
                  className="absolute top-0 bottom-0 border-l border-zinc-700/70 pl-1 text-[9px] font-mono text-zinc-400 flex items-center pointer-events-none"
                >
                  {formatMmSs(t)}
                </div>
              ))}
            </div>

            {/* 逐字文案时间带 (24px) */}
            <div className="h-[24px] shrink-0 border-b border-white/10 bg-[#0c0c11] relative overflow-hidden">
              {tailWords.map((w) => {
                const leftPct = Math.max(0, ((w.editedStartSec - viewStartSec) / viewSpanSec) * 100);
                const widthPct = Math.max(0.4, ((w.editedEndSec - w.editedStartSec) / viewSpanSec) * 100);
                const isSpoken = playheadSec >= w.editedStartSec && playheadSec <= w.editedEndSec;
                return (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => seekOutroToSec(w.editedStartSec)}
                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                    title={`${w.text} (${formatMmSs(w.editedStartSec)})`}
                    className={`absolute top-0.5 bottom-0.5 px-0.5 rounded text-[10px] truncate text-left cursor-pointer transition ${
                      isSpoken
                        ? 'bg-emerald-500/25 text-emerald-200 font-semibold'
                        : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200'
                    }`}
                  >
                    {w.text}
                  </button>
                );
              })}
            </div>

            {/* Speaker Tracks (tail context) */}
            <div className="flex-1 min-h-0 flex flex-col">
              {speakerTracks.map((tr, idx) => (
                <div
                  key={tr.id}
                  className={`flex-1 min-h-[50px] border-b border-white/[0.07] relative ${
                    idx % 2 === 1 ? 'bg-white/[0.015]' : ''
                  }`}
                >
                  <canvas
                    ref={(el) => {
                      if (el) speakerCanvasRefs.current.set(tr.id, el);
                      else speakerCanvasRefs.current.delete(tr.id);
                    }}
                    className="w-full h-full block pointer-events-none"
                  />
                </div>
              ))}

              {/* 片尾 BGM 轨 */}
              <div className="h-[64px] shrink-0 relative border-t border-emerald-500/25 bg-emerald-500/[0.02]">
                {state.outroBgm?.enabled && (state.outroBgm.filePath || state.outroBgm.audioUrl) ? (
                  <div
                    style={{ left: `${outroLeftPct}%`, width: `${outroWidthPct}%` }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      const rect = trackAreaRef.current?.getBoundingClientRect();
                      const pxPerSec = rect ? rect.width / viewSpanSec : 20;
                      frozenViewRef.current = { startSec: viewStartSec, spanSec: viewSpanSec };
                      setDragAction({ kind: 'move_outro', startClientX: e.clientX, origStartSec: outroStartSec, pxPerSec });
                    }}
                    title="拖动平移片尾 BGM 起止位置，或拖动左右边缘调整时长"
                    className="absolute top-1 bottom-1 rounded border border-emerald-500/50 bg-emerald-500/[0.08] overflow-hidden px-1.5 py-0.5 flex flex-col justify-between cursor-grab active:cursor-grabbing"
                  >
                    <div
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        const rect = trackAreaRef.current?.getBoundingClientRect();
                        const pxPerSec = rect ? rect.width / viewSpanSec : 20;
                        frozenViewRef.current = { startSec: viewStartSec, spanSec: viewSpanSec };
                        setDragAction({
                          kind: 'trim_outro_left',
                          startClientX: e.clientX,
                          origStartSec: outroStartSec,
                          origDurSec: outroDurSec,
                          origSourceStartSec: bgmSliceStart,
                          origSourceEndSec: bgmSliceEnd,
                          pxPerSec,
                        });
                      }}
                      title="左右拖动调整片尾 BGM 开始位置"
                      className="absolute left-0 top-0 bottom-0 w-1.5 bg-emerald-300/35 hover:bg-emerald-300/85 cursor-ew-resize z-10"
                    />
                    <div
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        const rect = trackAreaRef.current?.getBoundingClientRect();
                        const pxPerSec = rect ? rect.width / viewSpanSec : 20;
                        frozenViewRef.current = { startSec: viewStartSec, spanSec: viewSpanSec };
                        setDragAction({
                          kind: 'trim_outro_right',
                          startClientX: e.clientX,
                          origDurSec: outroDurSec,
                          pxPerSec,
                        });
                      }}
                      title="左右拖动调整片尾 BGM 结束位置与时长"
                      className="absolute right-0 top-0 bottom-0 w-1.5 bg-emerald-300/35 hover:bg-emerald-300/85 cursor-ew-resize z-10"
                    />
                    <span className="text-[9.5px] font-semibold text-emerald-300 truncate pointer-events-none z-10 leading-none">
                      🎵 片尾 BGM · {formatMmSs(outroStartSec)}–{formatMmSs(outroEndSec)} ({outroDurSec.toFixed(1)}s · 自动避让 {state.bgmDuckDb ?? -18}dB)
                    </span>
                    <div className="flex-1 min-h-0 w-full pointer-events-none">
                      <canvas ref={bgmCanvasRef} className="w-full h-full block" />
                    </div>
                  </div>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-[11px] text-zinc-600">
                    未开启片尾 BGM（点击左侧上传按钮导入）
                  </div>
                )}
              </div>
            </div>

            {/* Playhead */}
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

      {/* 片尾 BGM 文件拖拽截取条（片尾时长默认同步为截取 BGM 的 1.2 倍） */}
      <BgmSourceTrimmer
        label="片尾 BGM"
        accentColor="emerald"
        asset={state.outroBgm}
        resolvedDurationSec={bgmTotalDur}
        durationMultiplier={1.2}
        onChangeSlice={(patch) => {
          const sliceLen = Math.max(0.5, patch.sourceEndSec - patch.sourceStartSec);
          const nextOutroDur = Number((sliceLen * 1.2).toFixed(1));
          onUpdateState((prev) =>
            prev.outroBgm
              ? { ...prev, outroBgm: { ...prev.outroBgm, ...patch, customDurationSec: nextOutroDur } }
              : prev
          );
        }}
        onApplyDuration={(targetDur) =>
          onUpdateState((prev) =>
            prev.outroBgm
              ? { ...prev, outroBgm: { ...prev.outroBgm, customDurationSec: targetDur } }
              : prev
          )
        }
      />
    </div>
  );
};
