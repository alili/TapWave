import React, { useEffect } from 'react';
import {
  Clock,
  FileText,
  ListFilter,
  RotateCcw,
  Scissors,
  Sparkles,
  Volume2,
  X,
} from 'lucide-react';
import { CutCategory, CutPointItem } from '../engine/cutAnalysisEngine';

interface CutDetailPopoverProps {
  cut: CutPointItem | null;
  anchorPos?: { x: number; y: number } | null;
  embedded?: boolean;
  onClose: () => void;
  onUndoCut: (cut: CutPointItem) => void;
  onSeekToSec?: (sec: number) => void;
  onAudition?: (cut: CutPointItem) => void;
  onOpenAllCuts?: () => void;
}

const CATEGORY_BADGE_STYLE: Record<CutCategory, string> = {
  silence: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
  filler: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  waveform_cut: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  manual_delete: 'bg-red-500/20 text-red-300 border-red-500/40',
  pause_tighten: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
  track_mute: 'bg-zinc-700/60 text-zinc-300 border-zinc-600',
};

export const CutDetailPopover: React.FC<CutDetailPopoverProps> = ({
  cut,
  anchorPos,
  embedded = false,
  onClose,
  onUndoCut,
  onSeekToSec,
  onAudition,
  onOpenAllCuts,
}) => {
  useEffect(() => {
    if (!cut || embedded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cut, embedded, onClose]);

  if (!cut) return null;

  // Clamp position inside viewport (only used when floating)
  const cardWidth = 360;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const left = anchorPos
    ? Math.max(12, Math.min(vw - cardWidth - 16, anchorPos.x - cardWidth / 2))
    : Math.max(12, (vw - cardWidth) / 2);
  const top = anchorPos
    ? anchorPos.y > vh * 0.55
      ? Math.max(16, anchorPos.y - 290)
      : Math.min(vh - 300, anchorPos.y + 14)
    : Math.max(80, vh * 0.25);

  const cardNode = (
    <div
      onClick={(e) => e.stopPropagation()}
      style={embedded ? undefined : { left, top, width: cardWidth }}
      className={
        embedded
          ? 'w-full rounded-xl border border-emerald-500/35 bg-zinc-900/95 shadow-lg overflow-hidden text-xs'
          : 'fixed rounded-2xl border border-zinc-700/90 bg-zinc-900/95 backdrop-blur-md shadow-2xl overflow-hidden text-xs animate-in fade-in zoom-in-95 duration-150'
      }
    >
        {/* Header */}
        <div className="px-3.5 py-2.5 bg-zinc-950/90 border-b border-zinc-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-6 h-6 rounded-lg bg-emerald-500/15 border border-emerald-500/35 flex items-center justify-center text-emerald-300 shrink-0">
              <Scissors className="w-3.5 h-3.5" />
            </span>
            <span className="font-semibold text-zinc-100 truncate">剪辑处详情</span>
            <span
              className={`px-1.5 py-0.5 rounded-full text-[10px] border shrink-0 ${
                CATEGORY_BADGE_STYLE[cut.category]
              }`}
            >
              {cut.categoryLabel}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer"
            title="关闭 (Esc)"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-3.5 space-y-2.5">
          {/* Speaker + Time + Duration */}
          <div className="flex items-center justify-between text-[11px] text-zinc-400">
            <div className="flex items-center gap-1.5">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: cut.speakerColor }}
              />
              <span className="font-medium text-zinc-200">{cut.speakerName}</span>
              <button
                type="button"
                onClick={() => onSeekToSec?.(cut.editedSec)}
                className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-mono cursor-pointer transition"
                title="点击定位到此剪辑点"
              >
                {cut.timeFormatted}
              </button>
            </div>
            <span className="font-mono font-semibold text-emerald-300 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {cut.category === 'track_mute'
                ? `静音 ${cut.removedDurationSec.toFixed(2)}s`
                : `-${cut.removedDurationSec.toFixed(2)}s`}
            </span>
          </div>

          {/* Removed content box */}
          <div className="p-2.5 rounded-xl bg-zinc-950/90 border border-zinc-800/90 space-y-1.5">
            <div className="text-[10px] font-medium text-zinc-400 flex items-center gap-1">
              <FileText className="w-3 h-3 text-zinc-400" />
              <span>去掉的空白 / 文字内容</span>
            </div>

            {cut.removedText && (
              <div className="text-xs text-red-200 bg-red-500/10 border border-red-500/25 rounded-lg px-2 py-1.5 leading-relaxed break-words">
                <span className="line-through decoration-red-400/80">
                  {cut.removedText}
                </span>
              </div>
            )}

            {cut.removedSilenceSec > 0.01 && (
              <div className="text-[11px] text-purple-200 bg-purple-500/10 border border-purple-500/25 rounded-lg px-2 py-1 flex items-center justify-between">
                <span>
                  {cut.category === 'pause_tighten'
                    ? `停顿压缩：${cut.origDurationSec?.toFixed(2)}s → ${cut.keptDurationSec?.toFixed(2)}s`
                    : cut.category === 'track_mute'
                    ? '单轨局部静音区间'
                    : '切除空白停顿'}
                </span>
                <span className="font-mono font-semibold">
                  {cut.removedSilenceSec.toFixed(2)}s
                </span>
              </div>
            )}
          </div>

          {/* Rationale */}
          <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/25 text-[11px] text-blue-200/90 flex items-start gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
            <span>
              <strong className="text-blue-200">剪辑依据：</strong>
              {cut.reason}
            </span>
          </div>
        </div>

        {/* Footer actions */}
        <div className="px-3.5 py-2.5 bg-zinc-950/80 border-t border-zinc-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {onAudition && (
              <button
                type="button"
                onClick={() => onAudition(cut)}
                className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 flex items-center gap-1 cursor-pointer transition"
              >
                <Volume2 className="w-3 h-3 text-emerald-400" />
                <span>试听衔接</span>
              </button>
            )}
            {onOpenAllCuts && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenAllCuts();
                }}
                className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 flex items-center gap-1 cursor-pointer transition"
              >
                <ListFilter className="w-3 h-3 text-blue-400" />
                <span>全部剪辑</span>
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              onUndoCut(cut);
              onClose();
            }}
            className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-1 cursor-pointer transition shadow-sm"
          >
            <RotateCcw className="w-3 h-3" />
            <span>撤销该剪辑</span>
          </button>
        </div>
      </div>
  );

  if (embedded) return cardNode;

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      {cardNode}
    </div>
  );
};
