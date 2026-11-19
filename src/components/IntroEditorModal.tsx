import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Film,
  Mic,
  Minus,
  Music,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Upload,
  Volume2,
  X,
} from 'lucide-react';
import { AuxAudioSlot, HighlightClip, PodcastProjectState } from '../types/podcast';
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
  state: PodcastProjectState;
  timeline: TimelineComputation;
  onClose: () => void;
  onUpdateState: (updater: (prev: PodcastProjectState) => PodcastProjectState) => void;
  onImportBgm: (slot: AuxAudioSlot) => void;
  onSeekMainPlayhead: (sec: number) => void;
  onNotify?: (msg: string) => void;
}

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
      kind: 'scrub';
      rectLeft: number;
      rectWidth: number;
    };

export const IntroEditorModal: React.FC<IntroEditorModalProps> = ({
  open,
  state,
  timeline,
  onClose,
  onUpdateState,
  onImportBgm,
  onSeekMainPlayhead,
  onNotify,
}) => {
  const [zoom, setZoom] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [selectedHlId, setSelectedHlId] = useState<string | null>(null);
  const [dragAction, setDragAction] = useState<DragAction | null>(null);

  const trackAreaRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

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

  useEffect(() => {
    if (!open || !isPlaying) {
      return;
    }
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
        setPlayheadSec(0);
        setIsPlaying(false);
        audioPreview.pauseMultiTrackPlayback();
        return;
      }
      playheadRef.current = nextPlayheadSec;
      setPlayheadSec(Number(nextPlayheadSec.toFixed(3)));
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [open, isPlaying, totalIntroSec]);

  useEffect(() => {
    if (!dragAction) return;

    const handleMove = (e: PointerEvent) => {
      const container = trackAreaRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const pxPerSec = Math.max(1, rect.width / timelineSpanSec);

      if (dragAction.kind === 'scrub') {
        const ratio = Math.max(0, Math.min(1, (e.clientX - dragAction.rectLeft) / Math.max(1, dragAction.rectWidth)));
        const sec = Number((ratio * timelineSpanSec).toFixed(2));
        playheadRef.current = sec;
        setPlayheadSec(sec);
        audioPreview.requestSeek();
        if (isPlaying) {
          audioPreview.syncMultiTrackPlayback(stateRef.current, timelineRef.current, sec, true);
        }
        return;
      }

      const deltaSec = (e.clientX - dragAction.startClientX) / pxPerSec;
      const snap = (v: number) => Math.round(v * 20) / 20; // 0.05s snap

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
      setDragAction(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [dragAction, timelineSpanSec, isPlaying, onUpdateState]);

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

  const resetSequentialHighlights = () => {
    onUpdateState((prev) => ({
      ...prev,
      highlights: prev.highlights.map(({ introStartSec: _removed, ...rest }) => rest),
    }));
    onNotify?.('✨ 已恢复金句片段默认顺序排布');
  };

  const rulerTicks: number[] = [];
  const tickStep = timelineSpanSec / zoom <= 15 ? 1 : timelineSpanSec / zoom <= 40 ? 2 : 5;
  for (let t = 0; t <= timelineSpanSec; t += tickStep) {
    rulerTicks.push(Number(t.toFixed(1)));
  }

  // Build BGM ducking envelope polygon points across [0..introBgmDurationSec]
  const duckPct = Math.max(10, Math.min(85, 100 - Math.abs(state.bgmDuckDb ?? -18) * 2.5));
  const isSecDucked = (t: number) => {
    if (
      state.coldOpenEnabled &&
      clipWindows.some((w) => t >= w.startSec && t <= w.endSec)
    ) {
      return true;
    }
    if (
      state.introVoiceover?.enabled &&
      t >= introVoStartSec &&
      t <= introVoStartSec + introVoDurationSec
    ) {
      return true;
    }
    return false;
  };

  const playheadPct = Math.max(0, Math.min(100, (playheadSec / timelineSpanSec) * 100));

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-6xl bg-zinc-900 border border-zinc-700/80 rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between bg-zinc-950/70">
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
                拖拽移动金句或口播位置 · 拖拽金句左右边缘缩放修剪时长 · 实时预览片头 BGM 闪避包络
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
        <div className="px-5 py-2.5 border-b border-zinc-800/80 bg-zinc-900/95 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                playheadRef.current = 0;
                setPlayheadSec(0);
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
              {formatMmSs(playheadSec)}.{Math.floor((playheadSec % 1) * 10)}
              <span className="text-zinc-500 mx-1">/</span>
              <span className="text-purple-300">{totalIntroSec.toFixed(1)}s</span>
            </span>

            <label className="ml-2 flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
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

          <div className="flex items-center gap-3">
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
                onClick={() => setZoom((z) => Math.max(1, Number((z / 1.4).toFixed(2))))}
                className="p-1 text-zinc-400 hover:text-white cursor-pointer"
              >
                <Minus className="w-3 h-3" />
              </button>
              <span className="font-mono text-[11px] text-zinc-200 w-9 text-center">
                {zoom.toFixed(1)}x
              </span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(6, Number((z * 1.4).toFixed(2))))}
                className="p-1 text-zinc-400 hover:text-white cursor-pointer"
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>

        {/* Multi-Track Intro Timeline */}
        <div className="flex-1 overflow-auto p-4 bg-zinc-950/60">
          <div className="flex rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden min-h-[340px]">
            {/* Left Track Headers */}
            <div className="w-44 shrink-0 border-r border-zinc-800 bg-zinc-900/70 flex flex-col">
              <div className="h-7 border-b border-zinc-800 px-3 flex items-center text-[10px] font-mono text-zinc-500">
                时间标尺 (秒)
              </div>

              <div className="h-28 border-b border-zinc-800/80 p-3 flex flex-col justify-between">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-purple-200">
                  <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                  <span>金句高光轨</span>
                </div>
                <span className="text-[10px] text-zinc-400 leading-tight">
                  拖动片段移动位置，拖动左右边缩放修剪 ({state.highlights.length} 段)
                </span>
              </div>

              <div className="h-24 border-b border-zinc-800/80 p-3 flex flex-col justify-between">
                <div className="flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-200">
                    <Mic className="w-3.5 h-3.5 text-amber-400" />
                    <span>固定口播轨</span>
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
                <span className="text-[10px] text-zinc-400 leading-tight truncate">
                  {state.introVoiceover?.enabled
                    ? `${state.introVoiceover.fileName} (@${introVoStartSec.toFixed(1)}s)`
                    : '未开启或未上传'}
                </span>
              </div>

              <div className="h-24 p-3 flex flex-col justify-between">
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
                <span className="text-[10px] text-zinc-400 leading-tight truncate">
                  {state.introBgm?.enabled
                    ? `${state.introBgm.fileName} (${introBgmDurationSec.toFixed(1)}s)`
                    : '未开启或未上传'}
                </span>
              </div>
            </div>

            {/* Right Scrollable Zoomed Track Area */}
            <div className="flex-1 overflow-x-auto relative select-none">
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

                {/* Track 1: Highlights */}
                <div className="h-28 border-b border-zinc-800/80 relative bg-zinc-950/80">
                  {!state.coldOpenEnabled && (
                    <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500 pointer-events-none">
                      片头金句未启用（勾选上方「启用片头金句」即可编排）
                    </div>
                  )}
                  {clipWindows.map(({ highlight: hl, startSec, endSec }) => {
                    const leftPct = (startSec / timelineSpanSec) * 100;
                    const widthPct = Math.max(0.8, ((endSec - startSec) / timelineSpanSec) * 100);
                    const tr = trackColorBySpeaker.get(hl.speakerId);
                    const color = tr?.color || '#a855f7';
                    const isSelected = selectedHlId === hl.id;

                    return (
                      <div
                        key={hl.id}
                        style={{
                          left: `${leftPct}%`,
                          width: `${widthPct}%`,
                          borderColor: isSelected ? '#ffffff' : color,
                          backgroundColor: `${color}28`,
                        }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setSelectedHlId(hl.id);
                          setDragAction({
                            kind: 'move_hl',
                            hlId: hl.id,
                            startClientX: e.clientX,
                            origStartSec: startSec,
                          });
                        }}
                        className="absolute top-3 bottom-3 rounded-lg border-2 cursor-grab active:cursor-grabbing overflow-hidden group flex flex-col justify-between px-2 py-1 shadow-md"
                      >
                        {/* Left trim handle */}
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
                          title="左右拖动裁剪金句开头"
                          className="absolute left-0 top-0 bottom-0 w-2 bg-white/25 hover:bg-white/70 cursor-ew-resize z-10"
                        />

                        {/* Right trim handle */}
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
                              maxSourceMs: tr?.durationMs ?? hl.sourceEndMs + 30000,
                            });
                          }}
                          title="左右拖动裁剪/扩展金句结尾"
                          className="absolute right-0 top-0 bottom-0 w-2 bg-white/25 hover:bg-white/70 cursor-ew-resize z-10"
                        />

                        <div className="flex items-center justify-between gap-1 text-[10px] font-mono pointer-events-none pl-1 pr-1">
                          <span className="font-semibold text-zinc-100 truncate">
                            {hl.speakerName}
                          </span>
                          <span className="text-zinc-300 shrink-0">
                            @{startSec.toFixed(1)}s · {hl.durationSec.toFixed(1)}s
                          </span>
                        </div>
                        <div className="text-[11px] text-zinc-200 truncate pointer-events-none pl-1 pr-1">
                          “{hl.text}”
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Track 2: Intro Voiceover */}
                <div className="h-24 border-b border-zinc-800/80 relative bg-zinc-950/60">
                  {state.introVoiceover?.enabled && (state.introVoiceover.filePath || state.introVoiceover.audioUrl) ? (
                    <div
                      style={{
                        left: `${(introVoStartSec / timelineSpanSec) * 100}%`,
                        width: `${Math.max(1, (introVoDurationSec / timelineSpanSec) * 100)}%`,
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
                      className="absolute top-3 bottom-3 rounded-lg border-2 border-amber-400/80 bg-amber-500/20 cursor-grab active:cursor-grabbing px-2.5 py-1.5 flex flex-col justify-between shadow-md"
                    >
                      <div className="flex items-center justify-between text-[10px] font-mono text-amber-200 pointer-events-none">
                        <span className="font-semibold truncate">🎙️ {state.introVoiceover.fileName}</span>
                        <span className="shrink-0">
                          @{introVoStartSec.toFixed(1)}s ({introVoDurationSec.toFixed(1)}s)
                        </span>
                      </div>
                      <div className="text-[10px] text-amber-300/80 pointer-events-none truncate">
                        左右拖动调整片头口播位置
                      </div>
                    </div>
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500">
                      未开启或未上传固定口播（点击左侧上传按钮导入）
                    </div>
                  )}
                </div>

                {/* Track 3: Intro BGM with Ducking Envelope */}
                <div className="h-24 relative bg-zinc-950/40">
                  {state.introBgm?.enabled && (state.introBgm.filePath || state.introBgm.audioUrl || state.bgmWavPath) ? (
                    <div
                      style={{
                        left: '0%',
                        width: `${Math.min(100, (introBgmDurationSec / timelineSpanSec) * 100)}%`,
                      }}
                      className="absolute top-3 bottom-3 rounded-lg border border-blue-500/60 bg-blue-500/15 overflow-hidden px-2.5 py-1.5 flex flex-col justify-between"
                    >
                      <div className="flex items-center justify-between text-[10px] font-mono text-blue-200 z-10 pointer-events-none">
                        <span className="font-semibold truncate">🎵 {state.introBgm.fileName}</span>
                        <span className="shrink-0">
                          0.0s ~ {introBgmDurationSec.toFixed(1)}s (自动避让 {state.bgmDuckDb ?? -18}dB)
                        </span>
                      </div>

                      {/* Ducking envelope preview */}
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

                {/* Playhead vertical line */}
                <div
                  style={{ left: `${playheadPct}%` }}
                  className="absolute top-0 bottom-0 w-0.5 bg-red-500 pointer-events-none z-20 shadow-[0_0_8px_rgba(239,68,68,0.8)]"
                >
                  <div className="w-2.5 h-2.5 -ml-[4px] bg-red-500 rotate-45 rounded-xs" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-800 bg-zinc-950/70 flex items-center justify-between text-xs text-zinc-400">
          <span>所有修改已实时同步至主时间轴与导出配置</span>
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
            完成编排
          </button>
        </div>
      </div>
    </div>
  );
};
