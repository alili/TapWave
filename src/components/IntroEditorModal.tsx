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
import { AuxAudioSlot, HighlightMuteInterval, PodcastProjectState } from '../types/podcast';
import {
  computeColdOpenDurationSec,
  computeIntroBgmDurationSec,
  formatMmSs,
  resolveColdOpenClipWindows,
  resolveEffectiveHighlightGapSec,
  TimelineComputation,
} from '../engine/timelineEngine';
import { audioPreview } from '../engine/audioPreviewEngine';

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

function samplePeaksForSlice(
  peaks: number[] | undefined,
  durationMs: number | undefined,
  sliceStartMs: number,
  sliceEndMs: number,
  numBars: number
): number[] {
  const out = new Array<number>(numBars).fill(0.12);
  if (!peaks || peaks.length === 0 || !durationMs || durationMs <= 0) {
    for (let i = 0; i < numBars; i++) {
      out[i] = 0.2 + 0.55 * Math.abs(Math.sin(i * 0.7 + sliceStartMs * 0.001));
    }
    return out;
  }
  const spanMs = Math.max(1, sliceEndMs - sliceStartMs);
  for (let i = 0; i < numBars; i++) {
    const t0 = sliceStartMs + (i / numBars) * spanMs;
    const t1 = sliceStartMs + ((i + 1) / numBars) * spanMs;
    const idx0 = Math.max(0, Math.min(peaks.length - 1, Math.floor((t0 / durationMs) * peaks.length)));
    const idx1 = Math.max(idx0, Math.min(peaks.length - 1, Math.floor((t1 / durationMs) * peaks.length)));
    let maxV = 0;
    for (let k = idx0; k <= idx1; k++) {
      if (peaks[k] > maxV) maxV = peaks[k];
    }
    out[i] = Math.max(0.08, Math.min(1, maxV * 1.4));
  }
  return out;
}

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
  }, [open]);

  // Ultra-smooth 60fps playhead loop updating DOM directly (0 React re-renders during playback!)
  useEffect(() => {
    if (!open || !isPlaying) return;
    let rafId = 0;
    let lastMs = performance.now();

    const updatePlayheadDom = (sec: number) => {
      const pct = Math.max(0, Math.min(100, (sec / timelineSpanSec) * 100));
      if (playheadLineRef.current) {
        playheadLineRef.current.style.left = `${pct}%`;
      }
      if (timeReadoutRef.current) {
        timeReadoutRef.current.textContent = `${formatMmSs(sec)}.${Math.floor((sec % 1) * 10)}`;
      }
    };

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
        if (playheadLineRef.current) {
          playheadLineRef.current.style.left = `${(sec / timelineSpanSec) * 100}%`;
        }
        if (timeReadoutRef.current) {
          timeReadoutRef.current.textContent = `${formatMmSs(sec)}.${Math.floor((sec % 1) * 10)}`;
        }
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

  const wrapperClass = embedded
    ? 'flex-1 min-w-0 h-full flex flex-col bg-zinc-950 overflow-hidden'
    : 'fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4';
  const cardClass = embedded
    ? 'w-full h-full bg-zinc-900/95 flex flex-col overflow-hidden'
    : 'w-full max-w-6xl bg-zinc-900 border border-zinc-700/80 rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-[92vh]';

  return (
    <div className={wrapperClass}>
      <div className={cardClass}>
        {/* Header */}
        <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between bg-zinc-950/75">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-purple-600/20 border border-purple-500/40 flex items-center justify-center">
              <Film className="w-4 h-4 text-purple-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                <span>片头独立多轨编辑器</span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-purple-500/15 border border-purple-500/35 text-purple-300">
                  总片头 {totalIntroSec.toFixed(1)}s
                </span>
              </h2>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                复用多轨波形视图 · 拖动片段移动/缩放长度 · 按住 Shift 或切换「段落静音」框选静音某音轨片段
              </p>
            </div>
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
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Transport & Controls */}
        <div className="px-5 py-2.5 border-b border-zinc-800/80 bg-zinc-900/95 flex flex-wrap items-center justify-between gap-2.5 text-xs">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                playheadRef.current = 0;
                setPlayheadSec(0);
                if (playheadLineRef.current) playheadLineRef.current.style.left = '0%';
                if (timeReadoutRef.current) timeReadoutRef.current.textContent = '00:00.0';
                audioPreview.requestSeek();
              }}
              title="回到 00:00"
              className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={togglePlay}
              className={`px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 cursor-pointer transition ${
                isPlaying
                  ? 'bg-amber-500 text-zinc-950'
                  : 'bg-purple-600 hover:bg-purple-500 text-white'
              }`}
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              <span>{isPlaying ? '暂停预览' : '试听片头'}</span>
            </button>
            <span className="px-2.5 py-1 rounded bg-zinc-950 border border-zinc-800 font-mono text-[11px] text-zinc-200 tabular-nums">
              <span ref={timeReadoutRef}>
                {formatMmSs(playheadSec)}.{Math.floor((playheadSec % 1) * 10)}
              </span>
              <span className="text-zinc-500 mx-1">/</span>
              <span className="text-purple-300">{totalIntroSec.toFixed(1)}s</span>
            </span>

            {/* Edit vs Range Mute Tool Switch */}
            <div className="ml-2 inline-flex rounded-lg bg-zinc-950 border border-zinc-800 p-0.5">
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

            <label className="ml-1 flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={state.coldOpenEnabled}
                onChange={(e) =>
                  onUpdateState((p) => ({ ...p, coldOpenEnabled: e.target.checked }))
                }
                className="rounded accent-purple-500"
              />
              <span>启用片头金句</span>
            </label>
          </div>

          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-300">
              <Volume2 className="w-3.5 h-3.5 text-blue-400" />
              <span>BGM 闪避:</span>
              <input
                type="range"
                min={-30}
                max={-6}
                step={1}
                value={state.bgmDuckDb ?? -18}
                onChange={(e) =>
                  onUpdateState((p) => ({ ...p, bgmDuckDb: Number(e.target.value) }))
                }
                className="w-20 accent-blue-500 cursor-pointer"
              />
              <span className="font-mono text-blue-300 w-10 text-right">
                {state.bgmDuckDb ?? -18}dB
              </span>
            </div>

            <button
              type="button"
              onClick={resetSequentialHighlights}
              className="px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[11px] text-zinc-200 cursor-pointer"
            >
              自动顺序排列
            </button>

            <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 rounded-lg px-1.5 py-0.5">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(1, Number((z / 1.5).toFixed(2))))}
                className="p-1 text-zinc-400 hover:text-white cursor-pointer"
              >
                <Minus className="w-3 h-3" />
              </button>
              <span className="font-mono text-[11px] text-zinc-200 w-10 text-center">
                {zoom.toFixed(1)}x
              </span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(16, Number((z * 1.5).toFixed(2))))}
                className="p-1 text-zinc-400 hover:text-white cursor-pointer"
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>

        {/* Multi-Track Intro Timeline (matching main track DAW structure) */}
        <div className="flex-1 overflow-y-auto p-4 bg-zinc-950/60">
          <div className="flex rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
            {/* Left Track Headers */}
            <div className="w-48 shrink-0 border-r border-zinc-800 bg-zinc-900/75 flex flex-col">
              <div className="h-7 border-b border-zinc-800 px-3 flex items-center text-[10px] font-mono text-zinc-500">
                时间标尺 (⌘+滚轮缩放)
              </div>

              {speakerTracks.map((tr) => (
                <div
                  key={tr.id}
                  className="h-24 border-b border-zinc-800/80 px-3 py-2 flex flex-col justify-between"
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-1.5 h-3.5 rounded-full shrink-0"
                        style={{ backgroundColor: tr.color }}
                      />
                      <span className="text-xs font-semibold text-zinc-100 truncate">
                        {tr.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => toggleTrackSolo(tr.id)}
                        title="独奏此轨 (Solo)"
                        className={`w-4 h-4 rounded text-[9px] font-mono font-bold flex items-center justify-center cursor-pointer ${
                          tr.solo
                            ? 'bg-amber-500 text-zinc-950'
                            : 'bg-zinc-800 text-zinc-400 hover:text-white'
                        }`}
                      >
                        S
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleTrackMute(tr.id)}
                        title="静音此轨 (Mute)"
                        className={`w-4 h-4 rounded text-[9px] font-mono font-bold flex items-center justify-center cursor-pointer ${
                          tr.muted
                            ? 'bg-red-500 text-white'
                            : 'bg-zinc-800 text-zinc-400 hover:text-white'
                        }`}
                      >
                        M
                      </button>
                    </div>
                  </div>
                  <span className="text-[10px] text-zinc-500 truncate">
                    {tr.roleLabel} · 主讲 {clipWindows.filter((w) => w.highlight.speakerId === tr.id).length} / 共 {clipWindows.length} 段
                  </span>
                </div>
              ))}

              {/* Intro Voiceover Track Header */}
              <div className="h-20 border-b border-zinc-800/80 px-3 py-2 flex flex-col justify-between">
                <div className="flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-200">
                    <Mic className="w-3.5 h-3.5 text-amber-400" />
                    <span>固定口播</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onImportBgm('intro_vo')}
                    title="导入或更换固定口播音频"
                    className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer"
                  >
                    <Upload className="w-3 h-3" />
                  </button>
                </div>
                <span className="text-[10px] text-zinc-400 truncate">
                  {state.introVoiceover?.enabled
                    ? `${state.introVoiceover.fileName} (@${introVoStartSec.toFixed(1)}s)`
                    : '未开启或未上传'}
                </span>
              </div>

              {/* Intro BGM Track Header */}
              <div className="h-20 px-3 py-2 flex flex-col justify-between">
                <div className="flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-blue-200">
                    <Music className="w-3.5 h-3.5 text-blue-400" />
                    <span>片头 BGM</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onImportBgm('intro')}
                    title="导入或更换片头 BGM"
                    className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer"
                  >
                    <Upload className="w-3 h-3" />
                  </button>
                </div>
                <span className="text-[10px] text-zinc-400 truncate">
                  {state.introBgm?.enabled
                    ? `${state.introBgm.fileName} (${introBgmDurationSec.toFixed(1)}s)`
                    : '未开启或未上传'}
                </span>
              </div>
            </div>

            {/* Right Scrollable Zoomed Track Viewport */}
            <div ref={scrollViewportRef} className="flex-1 overflow-x-auto relative select-none">
              <div
                ref={trackAreaRef}
                style={{ width: `${zoom * 100}%`, minWidth: '100%' }}
                className="relative"
              >
                {/* Ruler */}
                <div
                  onPointerDown={(e) => {
                    const el = trackAreaRef.current;
                    if (!el) return;
                    const rect = el.getBoundingClientRect();
                    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
                    const sec = Number((ratio * timelineSpanSec).toFixed(2));
                    playheadRef.current = sec;
                    setPlayheadSec(sec);
                    if (playheadLineRef.current) playheadLineRef.current.style.left = `${(sec / timelineSpanSec) * 100}%`;
                    if (timeReadoutRef.current) timeReadoutRef.current.textContent = `${formatMmSs(sec)}.${Math.floor((sec % 1) * 10)}`;
                    audioPreview.requestSeek();
                    setDragAction({ kind: 'scrub', rectLeft: rect.left, rectWidth: rect.width });
                  }}
                  className="h-7 border-b border-zinc-800 bg-zinc-900/50 relative cursor-pointer"
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

                {/* Speaker Track Lanes */}
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
                      className={`h-24 border-b border-zinc-800/80 relative bg-zinc-950/80 ${
                        toolMode === 'mute_range' ? 'cursor-crosshair' : ''
                      }`}
                    >
                      {/* Center 0-crossing axis */}
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
                          const bars = samplePeaksForSlice(
                            tr.peaks,
                            tr.durationMs,
                            hl.sourceStartMs,
                            hl.sourceEndMs,
                            36
                          );

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
                              className={`absolute top-2 bottom-2 rounded-lg border-2 overflow-hidden flex flex-col justify-between px-2 py-1 shadow-md ${
                                toolMode === 'mute_range'
                                  ? 'cursor-crosshair'
                                  : 'cursor-grab active:cursor-grabbing'
                              }`}
                            >
                              {/* Left trim handle */}
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
                                  className="absolute left-0 top-0 bottom-0 w-2 bg-white/25 hover:bg-white/75 cursor-ew-resize z-10"
                                />
                              )}

                              {/* Right trim handle */}
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
                                  className="absolute right-0 top-0 bottom-0 w-2 bg-white/25 hover:bg-white/75 cursor-ew-resize z-10"
                                />
                              )}

                              <div className="flex items-center justify-between gap-1 text-[10px] font-mono z-10 pl-1 pr-1">
                                <span className="text-zinc-200 truncate pointer-events-none">
                                  {isPrimarySpeaker ? '★ ' : ''}@{startSec.toFixed(1)}s · {hl.durationSec.toFixed(1)}s
                                </span>
                                <button
                                  type="button"
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleHighlightTrackMute(hl.id, tr.id);
                                  }}
                                  title={isClipMuted ? '取消静音此片段' : '静音此金句片段'}
                                  className={`px-1 rounded text-[9px] cursor-pointer ${
                                    isClipMuted
                                      ? 'bg-red-500/80 text-white'
                                      : 'bg-zinc-900/70 text-zinc-300 hover:text-white'
                                  }`}
                                >
                                  {isClipMuted ? '🔇' : '🔊'}
                                </button>
                              </div>

                              {/* Bipolar Waveform */}
                              <div className="flex-1 flex items-center gap-[1.5px] pointer-events-none px-1">
                                {bars.map((amp, i) => (
                                  <div
                                    key={i}
                                    style={{
                                      height: `${Math.round(amp * 100)}%`,
                                      backgroundColor: isClipMuted ? '#71717a' : tr.color,
                                    }}
                                    className="flex-1 rounded-full opacity-75"
                                  />
                                ))}
                              </div>

                              <div className="text-[10px] text-zinc-200 truncate pointer-events-none pl-1 pr-1 z-10">
                                “{hl.text}”
                              </div>

                              {/* Partially muted sub-ranges inside this clip */}
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

                      {/* Active mute_range drag preview */}
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

                {/* Intro Voiceover Lane */}
                <div className="h-20 border-b border-zinc-800/80 relative bg-zinc-950/60">
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
                      className="absolute top-2 bottom-2 rounded-lg border-2 border-amber-400/80 bg-amber-500/20 cursor-grab active:cursor-grabbing px-2.5 py-1 flex flex-col justify-between shadow-md"
                    >
                      <div className="flex items-center justify-between text-[10px] font-mono text-amber-200 pointer-events-none">
                        <span className="font-semibold truncate">🎙️ {state.introVoiceover.fileName}</span>
                        <span className="shrink-0">
                          @{introVoStartSec.toFixed(1)}s ({introVoDurationSec.toFixed(1)}s)
                        </span>
                      </div>
                      <div className="flex-1 flex items-center gap-[1.5px] pointer-events-none">
                        {samplePeaksForSlice(
                          state.introVoiceover.peaks,
                          introVoDurationSec * 1000,
                          0,
                          introVoDurationSec * 1000,
                          32
                        ).map((amp, i) => (
                          <div
                            key={i}
                            style={{ height: `${Math.round(amp * 100)}%` }}
                            className="flex-1 rounded-full bg-amber-400/75"
                          />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500">
                      未开启或未上传固定口播（点击左侧上传按钮导入）
                    </div>
                  )}
                </div>

                {/* Intro BGM Lane with Live Ducking Envelope */}
                <div className="h-20 relative bg-zinc-950/40">
                  {state.introBgm?.enabled && (state.introBgm.filePath || state.introBgm.audioUrl || state.bgmWavPath) ? (
                    <div
                      style={{
                        left: '0%',
                        width: `${Math.min(100, (introBgmDurationSec / timelineSpanSec) * 100)}%`,
                      }}
                      className="absolute top-2 bottom-2 rounded-lg border border-blue-500/60 bg-blue-500/15 overflow-hidden px-2.5 py-1 flex flex-col justify-between"
                    >
                      <div className="flex items-center justify-between text-[10px] font-mono text-blue-200 z-10 pointer-events-none">
                        <span className="font-semibold truncate">🎵 {state.introBgm.fileName}</span>
                        <span className="shrink-0">
                          0.0s ~ {introBgmDurationSec.toFixed(1)}s (避让 {state.bgmDuckDb ?? -18}dB)
                        </span>
                      </div>

                      <div className="relative h-8 w-full flex items-end gap-[2px] pointer-events-none">
                        {Array.from({ length: 80 }).map((_, i) => {
                          const t = ((i + 0.5) / 80) * introBgmDurationSec;
                          const ducked = isSecDucked(t);
                          return (
                            <div
                              key={i}
                              style={{ height: `${ducked ? duckPct : 88}%` }}
                              className={`flex-1 rounded-t-xs transition-all ${
                                ducked ? 'bg-purple-400/50' : 'bg-blue-400/75'
                              }`}
                            />
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500">
                      未开启或未上传片头 BGM（点击左侧上传按钮导入）
                    </div>
                  )}
                </div>

                {/* Playhead vertical line (updated directly via ref at 60fps) */}
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

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-800 bg-zinc-950/70 flex items-center justify-between text-xs text-zinc-400">
          <span>所有修改已实时同步至片头与导出配置 · 主音轨仅保留正文内容</span>
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
            className="px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-semibold cursor-pointer"
          >
            {embedded ? '返回音轨视图' : '完成编排'}
          </button>
        </div>
      </div>
    </div>
  );
};
