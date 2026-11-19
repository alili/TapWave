import React, { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Loader2, Square } from 'lucide-react';
import { LoadingProgressState } from '../types/podcast';

interface LoadingProgressModalProps {
  progress: LoadingProgressState;
  onCancel?: () => void;
}

const STAGE_DISPLAY_LABELS: Record<string, string> = {
  dsp_inspect: '流式音频解码与响度扫描',
  inspect_track: '提取轨道波形与声学分段',
  align_clock: '多轨时钟偏移自动对齐',
  web_decode: '音频流解码与波形提取',
  asr_upload: '准备本地语音识别缓存',
  asr_transcribe: '神经网络逐字语音识别',
  asr_retranscribe: '重新执行神经网络语音识别',
  asr_ai: 'SenseVoice 神经网络转写中',
  timeline_build: '组装逐字对话流与动态时间轴',
  timeline_rebuild: '重建精剪对话流与空白胶囊',
  open_dialog: '选择工程文件',
  project_read: '读取 .podcraft 工程文件',
  project_parse: '解析并校验多轨工程数据',
  browser_read: '读取并解析工程文件',
  drop_project: '加载拖拽工程文件',
  restore_ui: '恢复剪辑台与多轨波形',
  export_init: '初始化母带导出引擎',
  export_mix: '多轨对齐混音与 -16 LUFS 母带处理',
  done: '全部处理已完成',
};

interface PipelineStepItem {
  label: string;
  thresholdPct: number;
  donePct: number;
}

function getPipelineSteps(stage: string, title: string): PipelineStepItem[] {
  if (
    stage.startsWith('project_') ||
    stage === 'open_dialog' ||
    stage === 'browser_read' ||
    stage === 'drop_project' ||
    stage === 'restore_ui' ||
    title.includes('.podcraft')
  ) {
    return [
      { label: '读取工程文件数据', thresholdPct: 1, donePct: 40 },
      { label: '校验多轨路径与切片状态', thresholdPct: 40, donePct: 88 },
      { label: '恢复文稿与波形时间轴', thresholdPct: 88, donePct: 100 },
    ];
  }
  if (stage.startsWith('export_') || title.includes('导出') || title.includes('渲染')) {
    return [
      { label: '准备多轨剪辑决策表 (EDL)', thresholdPct: 1, donePct: 22 },
      { label: '过零吸附交叉淡化与防串音混音', thresholdPct: 22, donePct: 85 },
      { label: '-16 LUFS 响度标准化封装', thresholdPct: 85, donePct: 100 },
    ];
  }
  return [
    { label: '读取音轨与流式解码', thresholdPct: 1, donePct: 26 },
    { label: '波形峰值提取、响度测量与时钟对齐', thresholdPct: 26, donePct: 50 },
    { label: '多轨防串音分离与 SenseVoice 逐字识别', thresholdPct: 50, donePct: 91 },
    { label: '构建空白胶囊、情绪曲线与多轨时间轴', thresholdPct: 91, donePct: 100 },
  ];
}

export const LoadingProgressModal: React.FC<LoadingProgressModalProps> = ({ progress, onCancel }) => {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!progress.active) {
      setElapsedSec(0);
      return;
    }
    const startMs = progress.startedAtMs || Date.now();
    setElapsedSec(Math.max(0, (Date.now() - startMs) / 1000));
    const timer = window.setInterval(() => {
      setElapsedSec(Math.max(0, (Date.now() - startMs) / 1000));
    }, 100);
    return () => window.clearInterval(timer);
  }, [progress.active, progress.startedAtMs]);

  if (!progress.active) return null;

  const clampedPct = Math.max(0, Math.min(100, Math.round(progress.percent)));
  const isDone = clampedPct >= 100 || progress.stage === 'done';
  const stageText = STAGE_DISPLAY_LABELS[progress.stage] || progress.stage || '处理中';
  const steps = getPipelineSteps(progress.stage, progress.title);

  return (
    <div className="fixed inset-0 z-[70] bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 select-none">
      <div className="w-full max-w-xl rounded-2xl border border-zinc-700/90 bg-zinc-900 p-6 shadow-2xl space-y-4">
        {/* 标题与完整百分比 + 耗时 */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            {isDone ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <Loader2 className="w-5 h-5 text-blue-400 animate-spin shrink-0 mt-0.5" />
            )}
            <div className="space-y-0.5 min-w-0">
              <h3 className="text-sm font-semibold text-zinc-100 whitespace-normal break-words leading-snug">
                {progress.title}
              </h3>
              <div className="text-[11px] text-zinc-400 flex flex-wrap items-center gap-2">
                <span className="px-2 py-0.5 rounded bg-blue-500/15 border border-blue-500/30 text-blue-300 font-medium">
                  当前阶段：{stageText}
                </span>
                <span className="font-mono tabular-nums text-zinc-400">
                  已用时 {elapsedSec.toFixed(1)}s
                </span>
              </div>
            </div>
          </div>

          <div className="text-right shrink-0">
            <span
              className={`font-mono text-lg font-bold tabular-nums ${
                isDone ? 'text-emerald-400' : 'text-blue-400'
              }`}
            >
              {clampedPct}%
            </span>
          </div>
        </div>

        {/* 主进度条（带刻度与平滑过渡） */}
        <div className="space-y-1.5">
          <div className="w-full h-3 rounded-full bg-zinc-950 overflow-hidden border border-zinc-700/80 p-0.5">
            <div
              className={`h-full rounded-full transition-all duration-150 ease-out ${
                isDone
                  ? 'bg-emerald-500'
                  : 'bg-gradient-to-r from-blue-600 via-blue-400 to-emerald-400'
              }`}
              style={{ width: `${clampedPct}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] font-mono text-zinc-500 px-0.5">
            <span>0%</span>
            <span>25%</span>
            <span>50%</span>
            <span>75%</span>
            <span>100%</span>
          </div>
        </div>

        {/* 完整实时状态文本（不截断，支持多行完整展示文件名与分段进度） */}
        <div className="p-3 rounded-xl bg-zinc-950/90 border border-zinc-800 text-xs text-zinc-200 whitespace-normal break-words leading-relaxed">
          {progress.message || '正在处理中，请稍候...'}
          {progress.subDetail && (
            <div className="mt-1 text-[11px] text-zinc-400 font-mono">{progress.subDetail}</div>
          )}
        </div>

        {/* 全流程步骤清单 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
          {steps.map((st, idx) => {
            const stepCompleted = isDone || clampedPct >= st.donePct;
            const stepActive = !stepCompleted && clampedPct >= st.thresholdPct;
            return (
              <div
                key={idx}
                className={`px-2.5 py-2 rounded-lg border text-xs flex items-center gap-2 transition ${
                  stepCompleted
                    ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                    : stepActive
                    ? 'border-blue-500/45 bg-blue-500/15 text-blue-200 font-medium'
                    : 'border-zinc-800 bg-zinc-950/50 text-zinc-500'
                }`}
              >
                {stepCompleted ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                ) : stepActive ? (
                  <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
                ) : (
                  <Circle className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
                )}
                <span className="leading-snug">
                  {idx + 1}. {st.label}
                </span>
              </div>
            );
          })}
        </div>

        {!isDone && onCancel && (
          <div className="pt-2 flex items-center justify-between border-t border-zinc-800/80">
            <span className="text-[11px] text-zinc-500">
              识别过程耗时视音轨长短而定，可随时中断
            </span>
            <button
              type="button"
              onClick={onCancel}
              className="px-3.5 py-1.5 rounded-lg border border-red-500/40 bg-red-500/10 hover:bg-red-500/20 text-red-300 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition shadow-xs"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              <span>停止识别</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
