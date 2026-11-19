import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Filter,
  Play,
  RotateCcw,
  Scissors,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  PreferenceSmartCutOutcome,
  SmartCutActionItem,
} from '../engine/preferenceCutEngine';

interface SmartCutConfirmModalProps {
  open: boolean;
  outcome: PreferenceSmartCutOutcome | null;
  auditioningItemId?: string | null;
  onAuditionCutPoint?: (item: SmartCutActionItem) => void;
  onStopAudition?: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onSeekToSec?: (sec: number) => void;
}

export const SmartCutConfirmModal: React.FC<SmartCutConfirmModalProps> = ({
  open,
  outcome,
  auditioningItemId,
  onAuditionCutPoint,
  onStopAudition,
  onConfirm,
  onCancel,
  onSeekToSec,
}) => {
  const [filterType, setFilterType] = useState<string>('all');
  const callbacksRef = React.useRef({ onCancel, onConfirm, onStopAudition });
  callbacksRef.current = { onCancel, onConfirm, onStopAudition };

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        callbacksRef.current.onStopAudition?.();
        callbacksRef.current.onCancel();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        callbacksRef.current.onStopAudition?.();
        callbacksRef.current.onConfirm();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      callbacksRef.current.onStopAudition?.();
    };
  }, [open]);

  const items = outcome?.actionItems ?? [];

  const filteredItems = useMemo(() => {
    if (filterType === 'all') return items;
    return items.filter((it) => it.category === filterType);
  }, [items, filterType]);

  if (!open || !outcome) return null;

  return (
    <div
      onClick={onCancel}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl rounded-2xl border border-purple-500/40 bg-zinc-900 shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-800 bg-zinc-950 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-purple-500/20 border border-purple-500/40 flex items-center justify-center text-purple-300">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <span>AI 偏好风格精剪 · 方案确认</span>
                <span className="text-[11px] font-normal px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  自然微创预设
                </span>
              </h2>
              <p className="text-xs text-zinc-400">
                AI 已基于您的剪辑审美完成预审分析。请检查以下精简明细，确认后将一键执行修改。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition cursor-pointer"
            title="取消 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Overview Stats Cards */}
        <div className="p-4 bg-zinc-900/90 border-b border-zinc-800 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <div className="p-3 rounded-xl bg-zinc-950/80 border border-zinc-800 space-y-1">
            <span className="text-[11px] text-zinc-400 flex items-center gap-1">
              <Scissors className="w-3 h-3 text-amber-400" />
              <span>卡壳口癖剔除</span>
            </span>
            <div className="flex items-baseline gap-1">
              <span className="text-lg font-bold font-mono text-amber-300">
                {outcome.hesitationsCut}
              </span>
              <span className="text-[11px] text-zinc-500">处</span>
            </div>
            <div className="text-[10px] text-emerald-400 flex items-center gap-0.5">
              <Check className="w-2.5 h-2.5" />
              <span>已保护 {outcome.protectedBackchannels} 处捧场词</span>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-zinc-950/80 border border-zinc-800 space-y-1">
            <span className="text-[11px] text-zinc-400 flex items-center gap-1">
              <RotateCcw className="w-3 h-3 text-cyan-400" />
              <span>口吃重说消解</span>
            </span>
            <div className="flex items-baseline gap-1">
              <span className="text-lg font-bold font-mono text-cyan-300">
                {outcome.stuttersCut}
              </span>
              <span className="text-[11px] text-zinc-500">处</span>
            </div>
            <span className="text-[10px] text-zinc-400">紧凑气口缝合 (40ms)</span>
          </div>

          <div className="p-3 rounded-xl bg-zinc-950/80 border border-zinc-800 space-y-1">
            <span className="text-[11px] text-zinc-400 flex items-center gap-1">
              <Clock className="w-3 h-3 text-purple-400" />
              <span>句内停顿收紧</span>
            </span>
            <div className="flex items-baseline gap-1">
              <span className="text-lg font-bold font-mono text-purple-300">
                {outcome.pausesTightened}
              </span>
              <span className="text-[11px] text-zinc-500">处</span>
            </div>
            <span className="text-[10px] text-zinc-400">长死寂压至 0.18s</span>
          </div>

          <div className="p-3 rounded-xl bg-zinc-950/80 border border-zinc-800 space-y-1">
            <span className="text-[11px] text-zinc-400 flex items-center gap-1">
              <VolumeX className="w-3 h-3 text-teal-400" />
              <span>单轨杂音消音</span>
            </span>
            <div className="flex items-baseline gap-1">
              <span className="text-lg font-bold font-mono text-teal-300">
                {outcome.surgicalMutesAdded}
              </span>
              <span className="text-[11px] text-zinc-500">处</span>
            </div>
            <span className="text-[10px] text-zinc-400">主时间轴零跳变</span>
          </div>
        </div>

        {/* Head / Tail Advisory notice if detected */}
        {outcome.headTailHints.length > 0 && (
          <div className="px-5 py-2.5 bg-amber-500/10 border-b border-amber-500/25 flex items-center gap-2 text-xs text-amber-200">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
            <div className="flex-1">
              <span className="font-semibold">特别提示：</span>
              <span>
                系统检测到 {outcome.headTailHints.map((h) => `${h.label}（${h.range}）`).join('、')}
                。为保障安全，正片外长段落未自动勾选删除，建议稍后人工确认。
              </span>
            </div>
          </div>
        )}

        {/* Category Filters Bar */}
        <div className="px-5 py-2.5 bg-zinc-950/70 border-b border-zinc-800/80 flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-zinc-400" />
            <span className="text-zinc-400">分类筛选:</span>
            {[
              { id: 'all', label: `全部 (${items.length})` },
              { id: 'hesitation', label: `卡壳口癖 (${outcome.hesitationsCut})` },
              { id: 'stutter', label: `口吃重说 (${outcome.stuttersCut})` },
              { id: 'pause', label: `紧凑停顿 (${outcome.pausesTightened})` },
              { id: 'mute', label: `单轨消音 (${outcome.surgicalMutesAdded})` },
            ].map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilterType(f.id)}
                className={`px-2 py-0.5 rounded-full text-[11px] transition cursor-pointer ${
                  filterType === f.id
                    ? 'bg-purple-600 text-white font-medium shadow-xs'
                    : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <span className="text-[11px] text-zinc-400 font-mono">
            预计精简总时长: <strong className="text-purple-300">-{outcome.savedSec.toFixed(1)}s</strong>
          </span>
        </div>

        {/* Detailed Action Items List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2 divide-y divide-zinc-800/60">
          {filteredItems.length === 0 ? (
            <div className="p-8 text-center text-xs text-zinc-500">
              当前分类无剪辑项，该维度已处于最佳状态
            </div>
          ) : (
            filteredItems.map((item, idx) => {
              const isAuditioning = auditioningItemId === item.id;
              return (
                <div
                  key={item.id || idx}
                  className={`pt-2 first:pt-0 flex items-center justify-between gap-3 text-xs p-2.5 rounded-xl transition ${
                    isAuditioning
                      ? 'bg-purple-950/60 border border-purple-500/60 shadow-lg shadow-purple-950/40 ring-1 ring-purple-500/30'
                      : 'hover:bg-zinc-800/50 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-6 text-center text-[10px] font-mono text-zinc-500 shrink-0">
                      {idx + 1}
                    </span>

                    {/* 试听剪辑点播放按钮 */}
                    <button
                      type="button"
                      onClick={() => {
                        onSeekToSec?.(item.timeSec);
                        onAuditionCutPoint?.(item);
                      }}
                      title={
                        isAuditioning
                          ? '点击停止试听'
                          : '点击播放收听该剪辑点 (前置0.8s ➔ 剪辑点 ➔ 上下文)'
                      }
                      className={`flex items-center gap-1.5 font-mono text-[11px] px-2.5 py-1 rounded-lg border cursor-pointer shrink-0 transition shadow-xs ${
                        isAuditioning
                          ? 'bg-amber-500/25 border-amber-400 text-amber-200 animate-pulse font-semibold'
                          : 'text-purple-300 hover:text-white bg-purple-500/15 hover:bg-purple-500/30 border-purple-500/35'
                      }`}
                    >
                      {isAuditioning ? (
                        <>
                          <Square className="w-2.5 h-2.5 fill-current text-amber-300" />
                          <span>收听中... @{item.timeFormatted}</span>
                        </>
                      ) : (
                        <>
                          <Play className="w-2.5 h-2.5 fill-current text-purple-400" />
                          <span>收听 @{item.timeFormatted}</span>
                        </>
                      )}
                    </button>

                    <span className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-[10px] text-zinc-300 shrink-0">
                      {item.speakerName}
                    </span>

                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-medium border shrink-0 ${
                        item.category === 'hesitation'
                          ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                          : item.category === 'stutter'
                          ? 'border-cyan-500/40 bg-cyan-500/15 text-cyan-300'
                          : item.category === 'pause'
                          ? 'border-purple-500/40 bg-purple-500/15 text-purple-300'
                          : 'border-teal-500/40 bg-teal-500/15 text-teal-300'
                      }`}
                    >
                      {item.categoryLabel}
                    </span>

                    <div className="truncate">
                      <span className="text-zinc-200 font-medium">{item.snippet}</span>
                      <span className="text-zinc-400 text-[11px] ml-2 hidden sm:inline">
                        {item.detail}
                      </span>
                    </div>
                  </div>

                  <div className="text-[11px] font-mono text-zinc-400 shrink-0">
                    -{item.durationSec.toFixed(2)}s
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 border-t border-zinc-800 bg-zinc-950 flex items-center justify-between">
          <div className="text-xs text-zinc-400">
            <span>支持 </span>
            <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono text-[10px]">
              ⌘ Z
            </kbd>
            <span> 一键撤销全部修改</span>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => {
                onStopAudition?.();
                onCancel();
              }}
              className="px-4 py-2 rounded-xl border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium cursor-pointer transition"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                onStopAudition?.();
                onConfirm();
              }}
              className="px-5 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-lg shadow-purple-500/20 cursor-pointer transition flex items-center gap-1.5"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>确认执行智能剪辑 (⌘ Enter)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
