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
import { AuxAudioSlot, HighlightMuteInterval, PodcastProjectState, SpeakerTrack } from '../types/podcast';
import {
  computeColdOpenDurationSec,
  computeIntroBgmDurationSec,
  formatMmSs,
  resolveColdOpenClipWindows,
  resolveEffectiveHighlightGapSec,
  TimelineComputation,
} from '../engine/timelineEngine';
import { audioPreview } from '../engine/audioPreviewEngine';
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

interface HiResClipWaveformCanvasProps {
  hiRes?: HiResWaveformEnvelope;
  legacyPeaks: number[];
  durationMs: number;
  sliceStartMs: number;
  sliceEndMs: number;
  color: string;
  dimmed?: boolean;
  gainFn?: (relSec: number) => number;
}

const HiResClipWaveformCanvas: React.FC<HiResClipWaveformCanvasProps> = React.memo(
  ({ hiRes, legacyPeaks, durationMs, sliceStartMs, sliceEndMs, color, dimmed = false, gainFn }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

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
      const sharedRefCeiling = calibration.p992Peak || 0.72;
      const midY = H / 2;
      const maxAmp = Math.max(4, H * 0.44);
      const spanMs = Math.max(1, sliceEndMs - sliceStartMs);
      const halfWinRatio = Math.max(0.0005, (spanMs / W) * 0.5 / safeDurMs);

      ctx.strokeStyle = dimmed ? 'rgba(113, 113, 122, 0.55)' : color;
      ctx.lineWidth = 1;

      for (let x = 0; x < W; x += 1.5) {
        const tMs = sliceStartMs + (x / W) * spanMs;
        const ratio = Math.max(0, Math.min(0.999999, tMs / safeDurMs));
        const pt = sampleCalibratedWaveformPoint(
          hiRes,
          legacyPeaks,
          ratio,
          halfWinRatio,
          1.0,
          calibration,
          sharedRefCeiling
        );
        const g = gainFn ? gainFn((tMs - sliceStartMs) / 1000) : 1.0;
        const posH = Math.max(1, pt.posPeak * maxAmp * g);
        const negH = Math.max(1, pt.negPeak * maxAmp * g);

        ctx.globalAlpha = dimmed ? 0.45 : 0.78;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, midY - posH);
        ctx.lineTo(x + 0.5, midY + negH);
        ctx.stroke();

        const rmsH = Math.max(0.5, pt.rms * maxAmp * g);
        ctx.globalAlpha = dimmed ? 0.5 : 0.95;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, midY - rmsH);
        ctx.lineTo(x + 0.5, midY + rmsH);
        ctx.stroke();
      }
      ctx.restore();
    }, [hiRes, legacyPeaks, durationMs, sliceStartMs, sliceEndMs, color, dimmed, gainFn]);

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
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const playheadLineRef = useRef<HTMLDivElement | null>(null);
  const scrubberFillRef = useRef<HTMLDivElement | null>(null);
  const scrubberThumbRef = useRef<HTMLDivElement | null>(null);
  const timeReadoutRef = useRef<HTMLSpanElement | null>(null);
  const scrubberTimeRef = useRef<HTMLSpanElement | null>(null);
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
  const introBgmDurationSec = computeIntroBgmDurationSec(state);

  const totalIntroSec = Math.max(
    6,
    coldDurationSec,
    state.introVoiceover?.enabled ? introVoStartSec + introVoDurationSec : 0,
    introBgmDurationSec
  );
  const timelineSpanSec = Math.max(10, Number((totalIntroSec * 1.15).toFixed(1)));

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
    const introPct = Math.max(0, Math.min(100, (sec / totalIntroSec) * 100));
    if (playheadLineRef.current) {
      playheadLineRef.current.style.left = `${pct}%`;
    }
    if (scrubberFillRef.current) {
      scrubberFillRef.current.style.width = `${introPct}%`;
    }
    if (scrubberThumbRef.current) {
      scrubberThumbRef.current.style.left = `${introPct}%`;
    }
    const formatted = `${formatMmSs(sec)}.${Math.floor((sec % 1) * 10)}`;
    if (timeReadoutRef.current) {
      timeReadoutRef.current.textContent = formatted;
    }
    if (scrubberTimeRef.current) {
      scrubberTimeRef.current.textContent = formatted;
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
      const stopBound = Math.max(
        1,
        curTl.prefixDurationSec > 0 ? curTl.prefixDurationSec : totalIntroSec
      );
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
        const factor = Math.exp(-e.deltaY * 0.008);
        setZoom((z) => Math.max(1, Math.min(16, Number((z * factor).toFixed(2)))));
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

  const duckPct = Math.max(10, Math.min(85, 100 - Math.abs(state.bgmDuckDb ?? -18) * 2.5));
  const isSecDucked = (t: number) => {
    if (state.coldOpenEnabled && clipWindows.some((w) => t >= w.startSec && t <= w.endSec)) {
      return true;
    }
    if (state.introVoiceover?.enabled && t >= introVoStartSec && t <= introVoStartSec + introVoDurationSec) {
      return true;
    }
    return false;
  };

  const playheadPct = Math.max(0, Math.min(100, (playheadSec / timelineSpanSec) * 100));
  const introProgressPct = Math.max(0, Math.min(100, (playheadSec / totalIntroSec) * 100));

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
                  <span>返回音轨视图</span>
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

            <div className="flex items-center gap-1 bg-zinc-950/90 border border-zinc-800 rounded-lg px-1.5 py-0.5">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(1, Number((z / 1.5).toFixed(2))))}
                className="p-0.5 text-zinc-400 hover:text-white cursor-pointer"
              >
                <Minus className="w-3 h-3" />
              </button>
              <span className="font-mono text-[11px] text-zinc-200 w-9 text-center">
                {zoom.toFixed(1)}x
              </span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(16, Number((z * 1.5).toFixed(2))))}
                className="p-0.5 text-zinc-400 hover:text-white cursor-pointer"
              >
                <Plus className="w-3 h-3" />
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

        {/* 片头进度条：与音轨视图进度条完全一致 */}
        <div className="px-2.5 py-1 rounded-lg bg-zinc-950/90 border border-zinc-800/85 flex items-center gap-2.5 select-none shrink-0">
          <span
            ref={scrubberTimeRef}
            className="font-mono tabular-nums text-[11px] text-purple-300 font-semibold w-14 shrink-0"
          >
            {formatMmSs(playheadSec)}.{Math.floor((playheadSec % 1) * 10)}
          </span>
          <div
            ref={scrubberRef}
            onPointerDown={(e) => {
              const el = scrubberRef.current;
              if (!el) return;
              const rect = el.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
              seekIntroToSec(ratio * totalIntroSec);
            }}
            className="relative flex-1 h-4 flex items-center cursor-pointer group"
          >
            <div className="relative w-full h-1.5 group-hover:h-2 transition-all rounded-full bg-zinc-800/95 overflow-hidden">
              <div
                ref={scrubberFillRef}
                style={{ width: `${introProgressPct}%` }}
                className="absolute inset-y-0 left-0 bg-gradient-to-r from-purple-600 via-purple-500 to-blue-400 rounded-full"
              />
            </div>
            <div
              ref={scrubberThumbRef}
              style={{ left: `${introProgressPct}%` }}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white border-2 border-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.85)] pointer-events-none"
            />
          </div>
          <span className="font-mono tabular-nums text-[11px] text-purple-400 font-semibold w-16 text-right shrink-0">
            {totalIntroSec.toFixed(1)}s
          </span>
        </div>

        {/* 多轨 DAW 视图：左 176px 音轨头 + 右可缩放音轨画布，与音轨视图结构完全一致 */}
        <div className="flex-1 min-h-0 flex rounded-xl border border-zinc-800/90 bg-zinc-950 overflow-hidden shadow-inner">
          {/* Left Track Headers (176px, matching WaveformEditorBar) */}
          <div className="w-[176px] shrink-0 border-r border-zinc-800/90 bg-zinc-900/75 flex flex-col">
            <div className="h-[22px] shrink-0 border-b border-zinc-800/90 px-2.5 flex items-center justify-between text-[10px] font-mono text-zinc-500">
              <span>音轨</span>
              <span>片头时间轴</span>
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
              <div className="h-[44px] shrink-0 px-2.5 flex items-center justify-between gap-1 bg-zinc-900/40">
                <div className="min-w-0">
                  <div className="flex items-center gap-1 text-[11px] font-semibold text-blue-200 truncate">
                    <Music className="w-3 h-3 text-blue-400 shrink-0" />
                    <span>片头 BGM</span>
                  </div>
                  <div className="text-[9px] text-zinc-500 truncate">
                    {state.introBgm?.enabled ? `${introBgmDurationSec.toFixed(1)}s` : '未启用'}
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
          <div ref={scrollViewportRef} className="flex-1 overflow-x-auto relative select-none">
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
                className="h-[22px] shrink-0 border-b border-zinc-800 bg-zinc-900/50 relative cursor-pointer"
              >
                {rulerTicks.map((t) => (
                  <div
                    key={t}
                    style={{ left: `${(t / timelineSpanSec) * 100}%` }}
                    className="absolute top-0 bottom-0 border-l border-zinc-700/70 pl-1 flex items-center text-[10px] font-mono text-zinc-400 pointer-events-none"
                  >
                    {t}s
                  </div>
                ))}
              </div>

              <div className="flex-1 min-h-0 flex flex-col">
                {speakerTracks.map((tr) => {
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
                      className={`flex-1 min-h-[54px] border-b border-zinc-800/60 relative bg-zinc-950/80 ${
                        toolMode === 'mute_range' ? 'cursor-crosshair' : ''
                      }`}
                    >
                      <div
                        className="absolute left-0 right-0 top-1/2 h-px pointer-events-none opacity-25"
                        style={{ backgroundColor: tr.color }}
                      />

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
                              borderColor: isSelected ? '#ffffff' : isPrimarySpeaker ? tr.color : `${tr.color}88`,
                              backgroundColor: isClipMuted
                                ? 'rgba(63,63,70,0.35)'
                                : isPrimarySpeaker
                                ? `${tr.color}28`
                                : `${tr.color}12`,
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
                            className={`absolute top-1.5 bottom-1.5 rounded-md border overflow-hidden flex flex-col justify-between px-1.5 py-0.5 shadow-sm ${
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
                                title="左右拖动缩放/修剪金句开头"
                                className="absolute left-0 top-0 bottom-0 w-1.5 bg-white/25 hover:bg-white/75 cursor-ew-resize z-10"
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
                                title="左右拖动缩放/扩展金句结尾"
                                className="absolute right-0 top-0 bottom-0 w-1.5 bg-white/25 hover:bg-white/75 cursor-ew-resize z-10"
                              />
                            )}

                            <div className="flex items-center justify-between gap-1 text-[9px] font-mono z-10 pl-0.5 pr-0.5">
                              <span className="text-zinc-200 truncate pointer-events-none">
                                {isPrimarySpeaker ? '★ ' : ''}@{startSec.toFixed(1)}s
                              </span>
                              <button
                                type="button"
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleHighlightTrackMute(hl.id, tr.id);
                                }}
                                className={`px-1 rounded text-[9px] cursor-pointer ${
                                  isClipMuted ? 'bg-red-500/80 text-white' : 'bg-zinc-900/70 text-zinc-300'
                                }`}
                              >
                                {isClipMuted ? '🔇' : '🔊'}
                              </button>
                            </div>

                            <div className="flex-1 min-h-0 w-full pointer-events-none">
                              <HiResClipWaveformCanvas
                                hiRes={trEnv}
                                legacyPeaks={tr.peaks}
                                durationMs={tr.durationMs || trEnv?.durationMs || hl.sourceEndMs}
                                sliceStartMs={hl.sourceStartMs}
                                sliceEndMs={hl.sourceEndMs}
                                color={tr.color}
                                dimmed={isClipMuted}
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
                                    className="absolute inset-y-0 bg-red-950/75 border-x border-red-400/80 flex items-center justify-center text-[10px] text-red-200 z-20 cursor-pointer hover:bg-red-900/80"
                                  >
                                    🔇
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
                <div className="h-[44px] shrink-0 border-b border-zinc-800/60 relative bg-zinc-950/60">
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
                      title="左右拖动调整固定口播起播时间"
                      className="absolute top-1 bottom-1 rounded-md border border-amber-400/80 bg-amber-500/15 cursor-grab active:cursor-grabbing overflow-hidden px-1.5 py-0.5 flex flex-col justify-between shadow-sm"
                    >
                      <span className="text-[9px] font-mono text-amber-200 truncate pointer-events-none z-10 leading-none">
                        🎙️ @{introVoStartSec.toFixed(1)}s ({introVoDurationSec.toFixed(1)}s)
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
                      未开启固定口播
                    </div>
                  )}
                </div>

                {/* 片头 BGM 紧凑轨（真实波形 + 闪避包络） */}
                <div className="h-[44px] shrink-0 relative bg-zinc-950/40">
                  {state.introBgm?.enabled && (state.introBgm.filePath || state.introBgm.audioUrl || state.bgmWavPath) ? (
                    <div
                      style={{
                        left: '0%',
                        width: `${Math.min(100, (introBgmDurationSec / timelineSpanSec) * 100)}%`,
                      }}
                      className="absolute top-1 bottom-1 rounded-md border border-blue-500/60 bg-blue-500/10 overflow-hidden px-1.5 py-0.5 flex flex-col justify-between"
                    >
                      <span className="text-[9px] font-mono text-blue-200 truncate pointer-events-none z-10 leading-none">
                        🎵 {state.introBgm.fileName} (避让 {state.bgmDuckDb ?? -18}dB)
                      </span>
                      <div className="flex-1 min-h-0 w-full pointer-events-none">
                        <HiResClipWaveformCanvas
                          hiRes={hiResEnvelopesRef.current.get('__intro_bgm__')}
                          legacyPeaks={state.introBgm.peaks ?? []}
                          durationMs={(state.introBgm.durationSec ?? introBgmDurationSec) * 1000}
                          sliceStartMs={0}
                          sliceEndMs={introBgmDurationSec * 1000}
                          color="#60a5fa"
                          gainFn={(t) => (isSecDucked(t) ? duckPct / 100 : 1.0)}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-[11px] text-zinc-600">
                      未开启片头 BGM
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
      </div>
    </div>
  );
};
