import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  X,
  Play,
  Pause,
  RotateCcw,
  Sparkles,
  Volume2,
  VolumeX,
  Clock,
  Quote,
  Check,
  ChevronLeft,
  ChevronRight,
  Sliders,
} from 'lucide-react';
import {
  HighlightClip,
  PodcastProjectState,
  SpeakerTrack,
} from '../types/podcast';
import { formatMmSs } from '../engine/timelineEngine';
import { normalizePlayableAudioUrl } from '../data/emptyProject';

interface HighlightEditModalProps {
  open: boolean;
  highlight: HighlightClip | null;
  tracks: SpeakerTrack[];
  onClose: () => void;
  onSave: (updated: HighlightClip) => void;
}

export const HighlightEditModal: React.FC<HighlightEditModalProps> = ({
  open,
  highlight,
  tracks,
  onClose,
  onSave,
}) => {
  if (!open || !highlight) return null;

  const [text, setText] = useState(highlight.text);
  const [startMs, setStartMs] = useState(highlight.sourceStartMs);
  const [endMs, setEndMs] = useState(highlight.sourceEndMs);
  const [mutedTrackIds, setMutedTrackIds] = useState<string[]>(
    highlight.mutedTrackIds ? [...highlight.mutedTrackIds] : []
  );

  // 视窗总长度：以当前金句为中心，前后各扩展 2.5 秒上下文缓冲，便于观察波形前后气口与发音边缘
  const initialWindow = useMemo(() => {
    const s = highlight.sourceStartMs;
    const e = highlight.sourceEndMs;
    const dur = Math.max(1000, e - s);
    const pad = Math.max(2000, Math.min(4000, Math.round(dur * 0.35)));
    const wStart = Math.max(0, s - pad);
    const wEnd = e + pad;
    return { wStart, wEnd };
  }, [highlight]);

  const [viewStartMs, setViewStartMs] = useState(initialWindow.wStart);
  const [viewEndMs, setViewEndMs] = useState(initialWindow.wEnd);

  // 播放与试听状态
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // 拖拽手柄状态
  const [dragMode, setDragMode] = useState<'start' | 'end' | 'pan' | null>(null);
  const dragStartXRef = useRef(0);
  const dragStartMsRef = useRef(0);
  const dragEndMsRef = useRef(0);
  const waveformContainerRef = useRef<HTMLDivElement | null>(null);

  // 初始化重置
  useEffect(() => {
    setText(highlight.text);
    setStartMs(highlight.sourceStartMs);
    setEndMs(highlight.sourceEndMs);
    setMutedTrackIds(highlight.mutedTrackIds ? [...highlight.mutedTrackIds] : []);
    setViewStartMs(initialWindow.wStart);
    setViewEndMs(initialWindow.wEnd);
    setIsPlaying(false);
    setPlayheadMs(null);
  }, [highlight, initialWindow]);

  // 音频实例准备：优先选取主发言人音轨或首个有音频文件的轨道
  const primaryAudioUrl = useMemo(() => {
    const spkTrack = tracks.find((t) => t.id === highlight.speakerId && (t.audioUrl || t.filePath));
    const fallbackTrack = tracks.find((t) => t.audioUrl || t.filePath);
    const target = spkTrack || fallbackTrack;
    if (!target) return null;
    return normalizePlayableAudioUrl(target.audioUrl, target.filePath, false);
  }, [tracks, highlight.speakerId]);

  // 试听停止清理
  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    setIsPlaying(false);
    setPlayheadMs(null);
  }, []);

  // 试听播放 / 暂停
  const togglePlay = useCallback(() => {
    if (isPlaying) {
      stopAudio();
      return;
    }

    setIsPlaying(true);
    setPlayheadMs(startMs);

    let audio: HTMLAudioElement | null = null;
    if (primaryAudioUrl) {
      try {
        audio = new Audio(primaryAudioUrl);
        audioRef.current = audio;
        audio.volume = 0.95;
        const targetSec = Math.max(0, startMs / 1000);
        if (audio.readyState >= 1) {
          audio.currentTime = targetSec;
        } else {
          audio.addEventListener(
            'loadedmetadata',
            () => {
              if (audio) audio.currentTime = targetSec;
            },
            { once: true }
          );
        }
        void audio
          .play()
          .then(() => {
            if (audioRef.current !== audio) {
              audio?.pause();
            }
          })
          .catch((err) => {
            console.warn('Audio preview play non-fatal error:', err);
          });
      } catch (err) {
        console.warn('Failed to create preview Audio element:', err);
      }
    }

    const startPerf = performance.now();
    const originMs = startMs;

    const checkLoop = () => {
      const elapsed = performance.now() - startPerf;
      let currentMs = originMs + elapsed;
      if (audio && !audio.paused && Number.isFinite(audio.currentTime) && audio.currentTime > 0) {
        const audioPosMs = audio.currentTime * 1000;
        if (Math.abs(audioPosMs - currentMs) < 600) {
          currentMs = audioPosMs;
        }
      }
      setPlayheadMs(currentMs);
      if (currentMs >= endMs || (audio && audio.ended)) {
        stopAudio();
      } else {
        animFrameRef.current = requestAnimationFrame(checkLoop);
      }
    };
    animFrameRef.current = requestAnimationFrame(checkLoop);
  }, [isPlaying, primaryAudioUrl, startMs, endMs, stopAudio]);

  // 键盘快捷键（Space 播放/暂停，ESC 退出）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        e.stopPropagation();
        togglePlay();
      } else if (e.code === 'Escape' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        stopAudio();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      stopAudio();
    };
  }, [togglePlay, onClose, stopAudio]);

  // 拖动计算工具
  const viewDurationMs = Math.max(500, viewEndMs - viewStartMs);
  const leftRatio = Math.max(0, Math.min(1, (startMs - viewStartMs) / viewDurationMs));
  const rightRatio = Math.max(0, Math.min(1, (endMs - viewStartMs) / viewDurationMs));

  const handlePointerDown = (mode: 'start' | 'end' | 'pan', e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragMode(mode);
    dragStartXRef.current = e.clientX;
    dragStartMsRef.current = startMs;
    dragEndMsRef.current = endMs;
    stopAudio();
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragMode || !waveformContainerRef.current) return;
    const rect = waveformContainerRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;

    const deltaPx = e.clientX - dragStartXRef.current;
    const deltaMs = (deltaPx / rect.width) * viewDurationMs;

    // 量化至 50ms 精度
    const quantizedDeltaMs = Math.round(deltaMs / 50) * 50;

    if (dragMode === 'start') {
      const nextStart = Math.max(
        viewStartMs,
        Math.min(dragEndMsRef.current - 300, dragStartMsRef.current + quantizedDeltaMs)
      );
      setStartMs(nextStart);
    } else if (dragMode === 'end') {
      const nextEnd = Math.max(
        dragStartMsRef.current + 300,
        Math.min(viewEndMs, dragEndMsRef.current + quantizedDeltaMs)
      );
      setEndMs(nextEnd);
    } else if (dragMode === 'pan') {
      const segDur = dragEndMsRef.current - dragStartMsRef.current;
      let nextStart = dragStartMsRef.current + quantizedDeltaMs;
      let nextEnd = nextStart + segDur;

      if (nextStart < viewStartMs) {
        nextStart = viewStartMs;
        nextEnd = nextStart + segDur;
      }
      if (nextEnd > viewEndMs) {
        nextEnd = viewEndMs;
        nextStart = nextEnd - segDur;
      }
      setStartMs(nextStart);
      setEndMs(nextEnd);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (dragMode) {
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      setDragMode(null);
    }
  };

  // 重置回原始选区
  const handleReset = () => {
    stopAudio();
    setStartMs(highlight.sourceStartMs);
    setEndMs(highlight.sourceEndMs);
    setText(highlight.text);
    setMutedTrackIds(highlight.mutedTrackIds ? [...highlight.mutedTrackIds] : []);
  };

  // 保存提交
  const handleSave = () => {
    stopAudio();
    const durationSec = Math.max(0.1, Number(((endMs - startMs) / 1000).toFixed(2)));
    const updated: HighlightClip = {
      ...highlight,
      text: text.trim() || highlight.text,
      sourceStartMs: startMs,
      sourceEndMs: endMs,
      durationSec,
      mutedTrackIds: mutedTrackIds.length > 0 ? mutedTrackIds : undefined,
    };
    onSave(updated);
    onClose();
  };

  // 切换音轨静音
  const toggleTrackMute = (trackId: string) => {
    setMutedTrackIds((prev) =>
      prev.includes(trackId) ? prev.filter((id) => id !== trackId) : [...prev, trackId]
    );
  };

  // 计算时间刻度标尺点
  const timeTicks = useMemo(() => {
    const ticks: { ms: number; label: string; pct: number }[] = [];
    const stepMs = viewDurationMs > 15000 ? 2000 : 1000;
    const firstTick = Math.ceil(viewStartMs / stepMs) * stepMs;
    for (let t = firstTick; t <= viewEndMs; t += stepMs) {
      const pct = ((t - viewStartMs) / viewDurationMs) * 100;
      ticks.push({
        ms: t,
        label: formatMmSs(t / 1000),
        pct,
      });
    }
    return ticks;
  }, [viewStartMs, viewEndMs, viewDurationMs]);

  const mainSpeaker = tracks.find((t) => t.id === highlight.speakerId);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-3 animate-in fade-in duration-150 select-none">
      <div className="bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-2xl w-[900px] max-w-[96vw] max-h-[92vh] flex flex-col overflow-hidden text-zinc-100">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between bg-zinc-950/60 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-purple-500/15 border border-purple-500/35 flex items-center justify-center shrink-0">
              <Quote className="w-4 h-4 text-purple-400" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-zinc-100 truncate">
                  金句起止时间段与多音轨波形编辑
                </h3>
                {mainSpeaker && (
                  <span
                    className="px-2 py-0.5 rounded-full text-[11px] font-medium flex items-center gap-1.5 shrink-0"
                    style={{
                      backgroundColor: `${mainSpeaker.color || '#a855f7'}22`,
                      color: mainSpeaker.color || '#c084fc',
                      border: `1px solid ${mainSpeaker.color || '#a855f7'}44`,
                    }}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: mainSpeaker.color || '#a855f7' }}
                    />
                    <span>{mainSpeaker.name}</span>
                  </span>
                )}
              </div>
              <p className="text-[11px] text-zinc-400 truncate mt-0.5">
                拖动左右手柄微调金句起止点，拖动选区整体平移，控制各麦克风音轨避让静音
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              stopAudio();
              onClose();
            }}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition cursor-pointer"
            title="关闭 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* 1. 金句文案编辑 */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-300 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Quote className="w-3.5 h-3.5 text-purple-400" />
                <span>金句台词文案 (支持文本纠错)</span>
              </span>
              <span className="text-[10px] text-zinc-500 font-mono">
                {text.length} 字符
              </span>
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-700/80 text-zinc-100 text-xs focus:outline-none focus:border-purple-500 leading-relaxed resize-none shadow-inner"
              placeholder="输入或修正金句文案..."
            />
          </div>

          {/* 2. 起止时间码控制栏与试听 */}
          <div className="p-3 rounded-lg bg-zinc-950/80 border border-zinc-800 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-4 flex-wrap">
              {/* 开始时间 */}
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-400 font-medium block">开始时间点</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      stopAudio();
                      setStartMs((p) => Math.max(viewStartMs, p - 500));
                    }}
                    className="px-1.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-300 border border-zinc-700 cursor-pointer"
                    title="提前 0.5s"
                  >
                    -0.5s
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      stopAudio();
                      setStartMs((p) => Math.max(viewStartMs, p - 100));
                    }}
                    className="px-1.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-300 border border-zinc-700 cursor-pointer"
                    title="提前 0.1s"
                  >
                    -0.1s
                  </button>
                  <span className="px-2.5 py-1 rounded bg-purple-950/50 border border-purple-500/40 text-purple-200 font-mono text-xs font-bold">
                    {formatMmSs(startMs / 1000)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      stopAudio();
                      setStartMs((p) => Math.min(endMs - 300, p + 100));
                    }}
                    className="px-1.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-300 border border-zinc-700 cursor-pointer"
                    title="推迟 0.1s"
                  >
                    +0.1s
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      stopAudio();
                      setStartMs((p) => Math.min(endMs - 300, p + 500));
                    }}
                    className="px-1.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-300 border border-zinc-700 cursor-pointer"
                    title="推迟 0.5s"
                  >
                    +0.5s
                  </button>
                </div>
              </div>

              {/* 箭头 */}
              <div className="text-zinc-600 font-mono text-sm self-end pb-1.5">➔</div>

              {/* 结束时间 */}
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-400 font-medium block">结束时间点</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      stopAudio();
                      setEndMs((p) => Math.max(startMs + 300, p - 500));
                    }}
                    className="px-1.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-300 border border-zinc-700 cursor-pointer"
                    title="提前 0.5s"
                  >
                    -0.5s
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      stopAudio();
                      setEndMs((p) => Math.max(startMs + 300, p - 100));
                    }}
                    className="px-1.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-300 border border-zinc-700 cursor-pointer"
                    title="提前 0.1s"
                  >
                    -0.1s
                  </button>
                  <span className="px-2.5 py-1 rounded bg-purple-950/50 border border-purple-500/40 text-purple-200 font-mono text-xs font-bold">
                    {formatMmSs(endMs / 1000)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      stopAudio();
                      setEndMs((p) => Math.min(viewEndMs, p + 100));
                    }}
                    className="px-1.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-300 border border-zinc-700 cursor-pointer"
                    title="推迟 0.1s"
                  >
                    +0.1s
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      stopAudio();
                      setEndMs((p) => Math.min(viewEndMs, p + 500));
                    }}
                    className="px-1.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-300 border border-zinc-700 cursor-pointer"
                    title="推迟 0.5s"
                  >
                    +0.5s
                  </button>
                </div>
              </div>

              {/* 总时长 */}
              <div className="space-y-1 pl-2 border-l border-zinc-800">
                <span className="text-[10px] text-zinc-400 font-medium block">片段总时长</span>
                <span className="px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-amber-300 font-mono text-xs font-bold inline-block">
                  {((endMs - startMs) / 1000).toFixed(2)}s
                </span>
              </div>
            </div>

            {/* 试听与重置按钮 */}
            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={handleReset}
                className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 flex items-center gap-1.5 transition cursor-pointer"
                title="重置回初始起止时间"
              >
                <RotateCcw className="w-3.5 h-3.5 text-zinc-400" />
                <span>重置</span>
              </button>

              <button
                type="button"
                onClick={togglePlay}
                className={`px-3.5 py-1.5 rounded-lg font-semibold text-xs flex items-center gap-1.5 transition cursor-pointer shadow-md ${
                  isPlaying
                    ? 'bg-amber-600 hover:bg-amber-500 text-white animate-pulse'
                    : 'bg-purple-600 hover:bg-purple-500 text-white'
                }`}
                title="试听金句选区音频 (空格键快捷触发)"
              >
                {isPlaying ? (
                  <>
                    <Pause className="w-3.5 h-3.5 fill-current" />
                    <span>暂停试听</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>试听选区</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* 3. 多音轨波形可视化与可拖拽高光选区 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-blue-400" />
                <span>各音轨波形与金句时间窗拖动编辑</span>
              </span>
              <span className="text-[11px] text-zinc-500 font-mono">
                视窗范围: {formatMmSs(viewStartMs / 1000)} ~ {formatMmSs(viewEndMs / 1000)}
              </span>
            </div>

            {/* 波形与轨道容器 */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden shadow-inner">
              {/* 顶部时间刻度尺 */}
              <div className="h-6 border-b border-zinc-800/80 bg-zinc-900/80 flex items-center relative pl-36 pr-4 select-none">
                <div className="relative w-full h-full">
                  {timeTicks.map((tk) => (
                    <div
                      key={tk.ms}
                      style={{ left: `${tk.pct}%` }}
                      className="absolute top-0 bottom-0 flex flex-col items-center -translate-x-1/2"
                    >
                      <span className="text-[9px] text-zinc-500 font-mono mt-0.5">
                        {tk.label}
                      </span>
                      <div className="w-px flex-1 bg-zinc-800" />
                    </div>
                  ))}
                </div>
              </div>

              {/* 多轨波形主视口 */}
              <div
                ref={waveformContainerRef}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                className="relative divide-y divide-zinc-900 select-none cursor-default"
              >
                {tracks.map((tr) => {
                  const isMuted = mutedTrackIds.includes(tr.id);
                  const isMainSpeaker = tr.id === highlight.speakerId;
                  const trackColor = tr.color || '#6366f1';

                  return (
                    <div key={tr.id} className="flex h-14 relative group">
                      {/* 左侧轨道信息与静音按钮 */}
                      <div className="w-36 shrink-0 bg-zinc-900/90 border-r border-zinc-800 p-2 flex flex-col justify-between z-20">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0 shadow-xs"
                            style={{ backgroundColor: trackColor }}
                          />
                          <span className="text-xs font-semibold text-zinc-200 truncate">
                            {tr.name}
                          </span>
                          {isMainSpeaker && (
                            <span className="px-1 py-0.2 rounded text-[9px] bg-purple-500/20 text-purple-300 font-medium shrink-0">
                              金句主轨
                            </span>
                          )}
                        </div>

                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-zinc-500">
                            {tr.role === 'host' ? '主讲人' : '嘉宾'}
                          </span>
                          <button
                            type="button"
                            onClick={() => toggleTrackMute(tr.id)}
                            className={`px-1.5 py-0.5 rounded flex items-center gap-1 cursor-pointer transition text-[10px] font-medium ${
                              isMuted
                                ? 'bg-red-500/20 text-red-300 border border-red-500/40'
                                : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-700/60'
                            }`}
                            title={isMuted ? '点击恢复该音轨发音' : '点击在此金句中静音该音轨 (避让漏音)'}
                          >
                            {isMuted ? (
                              <>
                                <VolumeX className="w-3 h-3 text-red-400" />
                                <span>已静音</span>
                              </>
                            ) : (
                              <>
                                <Volume2 className="w-3 h-3" />
                                <span>静音</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>

                      {/* 右侧波形渲染 Canvas */}
                      <div className="flex-1 relative overflow-hidden bg-zinc-950">
                        <WaveformCanvas
                          track={tr}
                          viewStartMs={viewStartMs}
                          viewEndMs={viewEndMs}
                          isMuted={isMuted}
                        />
                      </div>
                    </div>
                  );
                })}

                {/* 覆盖在所有波形上方的交互式高光选区（拖拽图层） */}
                <div
                  className="absolute inset-y-0 right-0 left-36 pointer-events-auto z-30"
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                >
                  {/* 选区外左侧暗色蒙版 */}
                  <div
                    style={{ width: `${leftRatio * 100}%` }}
                    className="absolute inset-y-0 left-0 bg-black/45 pointer-events-none"
                  />

                  {/* 选区外右侧暗色蒙版 */}
                  <div
                    style={{ left: `${rightRatio * 100}%` }}
                    className="absolute inset-y-0 right-0 bg-black/45 pointer-events-none"
                  />

                  {/* 选区内部高亮与整体平移区 */}
                  <div
                    style={{
                      left: `${leftRatio * 100}%`,
                      width: `${Math.max(0, rightRatio - leftRatio) * 100}%`,
                    }}
                    onPointerDown={(e) => handlePointerDown('pan', e)}
                    title="按住鼠标拖拽：整体平移金句时间窗"
                    className="absolute inset-y-0 border-y border-purple-500/50 bg-purple-500/15 cursor-grab active:cursor-grabbing group shadow-md"
                  >
                    <div className="absolute inset-0 bg-purple-400/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                    <div className="absolute top-1 left-2 text-[10px] font-mono text-purple-300 font-semibold pointer-events-none">
                      金句范围 ({((endMs - startMs) / 1000).toFixed(2)}s)
                    </div>
                  </div>

                  {/* 左手柄：微调开始时间 */}
                  <div
                    style={{ left: `${leftRatio * 100}%` }}
                    onPointerDown={(e) => handlePointerDown('start', e)}
                    className="absolute inset-y-0 -translate-x-1/2 w-4 cursor-ew-resize flex items-center justify-center z-40 group"
                    title="拖拽微调金句开始时间"
                  >
                    <div className="w-1.5 h-full bg-purple-400 rounded-full group-hover:bg-purple-300 group-hover:w-2 transition-all shadow-lg flex items-center justify-center">
                      <div className="w-0.5 h-4 bg-purple-950 rounded-full" />
                    </div>
                  </div>

                  {/* 右手柄：微调结束时间 */}
                  <div
                    style={{ left: `${rightRatio * 100}%` }}
                    onPointerDown={(e) => handlePointerDown('end', e)}
                    className="absolute inset-y-0 -translate-x-1/2 w-4 cursor-ew-resize flex items-center justify-center z-40 group"
                    title="拖拽微调金句结束时间"
                  >
                    <div className="w-1.5 h-full bg-purple-400 rounded-full group-hover:bg-purple-300 group-hover:w-2 transition-all shadow-lg flex items-center justify-center">
                      <div className="w-0.5 h-4 bg-purple-950 rounded-full" />
                    </div>
                  </div>

                  {/* 试听播放扫描光标 */}
                  {playheadMs !== null && playheadMs >= viewStartMs && playheadMs <= viewEndMs && (
                    <div
                      style={{
                        left: `${((playheadMs - viewStartMs) / viewDurationMs) * 100}%`,
                      }}
                      className="absolute inset-y-0 w-0.5 bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.9)] z-50 pointer-events-none"
                    >
                      <div className="w-2.5 h-2.5 bg-amber-300 rounded-full -translate-x-1/2 -translate-y-1 shadow-md" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-800 bg-zinc-950/70 flex items-center justify-between shrink-0">
          <div className="text-[11px] text-zinc-400 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span>
              已选时长: <strong className="text-purple-300 font-mono">{((endMs - startMs) / 1000).toFixed(2)}s</strong>
              {mutedTrackIds.length > 0 && (
                <span className="ml-2 text-zinc-500">
                  (已静音 {mutedTrackIds.length} 条音轨)
                </span>
              )}
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => {
                stopAudio();
                onClose();
              }}
              className="px-4 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-300 transition cursor-pointer"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs transition cursor-pointer flex items-center gap-1.5 shadow-md"
            >
              <Check className="w-3.5 h-3.5" />
              <span>保存金句修改</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/** 单音轨波形渲染 Canvas */
const WaveformCanvas: React.FC<{
  track: SpeakerTrack;
  viewStartMs: number;
  viewEndMs: number;
  isMuted: boolean;
}> = ({ track, viewStartMs, viewEndMs, isMuted }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const peaks = track.peaks || [];
    const durMs = track.durationMs && track.durationMs > 0 ? track.durationMs : 1;
    const viewDur = Math.max(1, viewEndMs - viewStartMs);
    const midY = height / 2;

    ctx.fillStyle = isMuted ? '#52525b' : track.color || '#818cf8';
    ctx.globalAlpha = isMuted ? 0.35 : 0.85;

    // 根据 Canvas 宽度细分柱条
    const barWidth = 2;
    const barGap = 1;
    const totalBars = Math.floor(width / (barWidth + barGap));

    for (let i = 0; i < totalBars; i++) {
      const frac = i / totalBars;
      const currentMs = viewStartMs + frac * viewDur;
      const peakRatio = currentMs / durMs;

      let val = 0.04;
      if (peaks.length > 0 && peakRatio >= 0 && peakRatio <= 1) {
        const peakIdx = Math.min(peaks.length - 1, Math.floor(peakRatio * peaks.length));
        val = Math.max(0.04, Math.min(1.0, peaks[peakIdx] || 0));
      }

      const barH = Math.max(2, val * (height - 6));
      const x = i * (barWidth + barGap);
      const y = midY - barH / 2;

      ctx.fillRect(x, y, barWidth, barH);
    }
  }, [track, viewStartMs, viewEndMs, isMuted]);

  return (
    <canvas
      ref={canvasRef}
      width={720}
      height={56}
      className="w-full h-full block"
    />
  );
};
