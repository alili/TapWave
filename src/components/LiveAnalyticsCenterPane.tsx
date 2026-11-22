import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BookOpen,
  Briefcase,
  Clock,
  Compass,
  GitBranch,
  Layers,
  MessageSquareWarning,
  Sparkles,
  TrendingUp,
  Zap,
} from 'lucide-react';
import {
  LiveOutlineItem,
  LiveSessionSnapshot,
} from '../types/liveSession';
import {
  computeInsightUpdateStatus,
  computeLiveSpeechAnalytics,
  LogicMapBranch,
  LogicRelationType,
} from '../engine/liveSpeechAnalytics';
import { formatLiveMmSs } from '../engine/liveMinutesExporter';
import { LogicConnectionGraph } from './LogicConnectionGraph';

interface LiveAnalyticsCenterPaneProps {
  snap: LiveSessionSnapshot;
  isListenMode: boolean;
  onJumpToMs: (ms: number) => void;
  onOverrideOutline: (id: string, status: LiveOutlineItem['status']) => void;
}

const RELATION_STYLE: Record<LogicRelationType, string> = {
  viewpoint: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
  story: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
  causal: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  contrast: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  progression: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
  example: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40',
  conclusion: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  outline: 'bg-zinc-700/40 text-zinc-300 border-zinc-600/50',
};

const SPEAKER_BAR_COLORS = [
  'bg-blue-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-purple-500',
];

function nextOutlineStatus(cur: LiveOutlineItem['status']): LiveOutlineItem['status'] {
  if (cur === 'not_started') return 'partial';
  if (cur === 'partial') return 'covered';
  return 'not_started';
}

function outlineBadge(status: LiveOutlineItem['status']): { label: string; cls: string } {
  switch (status) {
    case 'covered':
      return {
        label: '已覆盖',
        cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
      };
    case 'partial':
      return {
        label: '讨论中',
        cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
      };
    default:
      return {
        label: '待展开',
        cls: 'bg-zinc-800 text-zinc-400 border-zinc-700',
      };
  }
}

export const LiveAnalyticsCenterPane: React.FC<LiveAnalyticsCenterPaneProps> = ({
  snap,
  isListenMode,
  onJumpToMs,
  onOverrideOutline,
}) => {
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string | null>(null);
  const [logicViewMode, setLogicViewMode] = useState<'graph' | 'list'>('graph');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (snap.phase !== 'recording') return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [snap.phase, snap.lastInsightAt]);

  const analytics = useMemo(
    () => computeLiveSpeechAnalytics(snap, selectedSpeakerId),
    [snap, selectedSpeakerId]
  );

  const insightStatus = useMemo(
    () => computeInsightUpdateStatus(snap, nowMs),
    [snap, nowMs]
  );

  const paceBadgeCls =
    analytics.pace.paceStatus === 'moderate'
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
      : analytics.pace.paceStatus === 'fast'
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/35'
        : analytics.pace.paceStatus === 'slow'
          ? 'bg-blue-500/15 text-blue-300 border-blue-500/35'
          : 'bg-zinc-800 text-zinc-400 border-zinc-700';

  const densityBadgeCls =
    analytics.density.level === 'high'
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
      : analytics.density.level === 'medium'
        ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/35'
        : analytics.density.level === 'low'
          ? 'bg-amber-500/15 text-amber-300 border-amber-500/35'
          : 'bg-zinc-800 text-zinc-400 border-zinc-700';

  // Build SVG path for pace trend
  const trend = analytics.pace.trendPoints;
  const chartW = 420;
  const chartH = 112;
  const padX = 12;
  const padY = 12;
  const maxCpm = Math.max(340, ...trend.map((p) => p.cpm));

  const cpmPolyline = useMemo(() => {
    if (trend.length === 0) return '';
    return trend
      .map((p, idx) => {
        const x =
          trend.length === 1
            ? chartW / 2
            : padX + (idx / (trend.length - 1)) * (chartW - padX * 2);
        const y = chartH - padY - (Math.min(maxCpm, p.cpm) / maxCpm) * (chartH - padY * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [trend, maxCpm]);

  // Comfortable pace band (140..300 CPM)
  const bandTopY = chartH - padY - (Math.min(maxCpm, 300) / maxCpm) * (chartH - padY * 2);
  const bandBotY = chartH - padY - (Math.min(maxCpm, 140) / maxCpm) * (chartH - padY * 2);

  return (
    <main className="flex-1 min-w-0 flex flex-col bg-zinc-950 overflow-hidden">
      {/* 顶部栏：标题 + 发言人视角筛选 */}
      <div className="shrink-0 px-4 py-2 border-b border-zinc-800 bg-zinc-900/50 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-cyan-400" />
          <h2 className="text-xs font-bold text-zinc-100">实时内容提取与发言分析</h2>
          <span className="text-[11px] text-zinc-500">
            {analytics.utteranceCount} 段 · {analytics.totalChars} 字
          </span>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => setSelectedSpeakerId(null)}
            className={`px-2 py-0.5 rounded-md text-[11px] border cursor-pointer transition ${
              selectedSpeakerId === null
                ? 'bg-blue-600/25 text-blue-200 border-blue-500/50 font-semibold'
                : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
            }`}
          >
            全部发言人
          </button>
          {snap.speakers.map((sp) => (
            <button
              key={sp.id}
              type="button"
              onClick={() =>
                setSelectedSpeakerId((prev) => (prev === sp.id ? null : sp.id))
              }
              className={`px-2 py-0.5 rounded-md text-[11px] border cursor-pointer transition ${
                selectedSpeakerId === sp.id
                  ? 'bg-blue-600/25 text-blue-200 border-blue-500/50 font-semibold'
                  : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
              }`}
            >
              {sp.name}
            </button>
          ))}
        </div>
      </div>

      {/* 上次更新时点与下轮更新预期进度条 */}
      <div className="shrink-0 px-4 py-2 border-b border-zinc-800/80 bg-zinc-900/30 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-[11px]">
          <span className="inline-flex items-center gap-1.5 text-zinc-300">
            <Clock className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-zinc-400">上次内容提取：</span>
            <span className="font-mono font-semibold text-zinc-100">
              {insightStatus.lastUpdatedLabel}
            </span>
            {insightStatus.elapsedSinceLastSec !== null && insightStatus.lastUpdatedAt !== null && (
              <span className="text-zinc-500">({insightStatus.elapsedSinceLastSec}s 前)</span>
            )}
          </span>
          <span className="text-zinc-700 hidden sm:inline">|</span>
          <span className="text-zinc-500 hidden sm:inline">
            待分析新内容 <span className="font-mono text-zinc-300">{insightStatus.pendingChars}</span> 字
          </span>
        </div>

        <div className="flex items-center gap-2.5 min-w-[230px] flex-1 max-w-md justify-end">
          <span
            className={`text-[11px] truncate ${
              insightStatus.statusTone === 'thinking'
                ? 'text-cyan-300 font-medium'
                : insightStatus.statusTone === 'disabled'
                  ? 'text-zinc-500'
                  : 'text-zinc-400'
            }`}
          >
            {insightStatus.nextExpectedLabel}
          </span>
          <div className="w-28 sm:w-36 shrink-0 flex items-center gap-1.5">
            <div className="flex-1 h-2 rounded-full bg-zinc-800 overflow-hidden border border-zinc-700/60">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  insightStatus.statusTone === 'thinking'
                    ? 'bg-gradient-to-r from-cyan-400 via-blue-400 to-purple-400 animate-pulse'
                    : insightStatus.statusTone === 'disabled'
                      ? 'bg-zinc-700'
                      : insightStatus.progressPct >= 80
                        ? 'bg-gradient-to-r from-emerald-500 to-cyan-400'
                        : 'bg-gradient-to-r from-blue-500 to-cyan-400'
                }`}
                style={{ width: `${insightStatus.progressPct}%` }}
              />
            </div>
            <span className="text-[10px] font-mono text-zinc-400 w-8 text-right">
              {insightStatus.progressPct}%
            </span>
          </div>
        </div>
      </div>

      {/* 主滚动区域 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {/* 聊天模式：当前议题与议题流转 / 相关性追踪 */}
        {snap.scenario === 'chat' && (() => {
          const flow = snap.topicFlow ?? [];
          const activeItem =
            flow.find((f) => f.status === 'active') ??
            (flow.length > 0 ? flow[flow.length - 1] : undefined);
          const displayCurrentTopic =
            snap.currentTopic?.trim() ||
            activeItem?.topic ||
            snap.prep?.topic?.trim() ||
            '正在识别当前讨论议题…';
          const relMeta = (rel?: 'high' | 'medium' | 'off_topic') => {
            if (rel === 'off_topic') {
              return {
                label: '偏离主线',
                cls: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
              };
            }
            if (rel === 'medium') {
              return {
                label: '延伸相关',
                cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
              };
            }
            return {
              label: '高度相关',
              cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
            };
          };
          const curRel = relMeta(activeItem?.relevance);

          return (
            <section className="rounded-xl border border-cyan-500/35 bg-gradient-to-br from-cyan-950/35 via-zinc-900/75 to-zinc-900/80 p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="px-2 py-0.5 rounded-md bg-cyan-500/20 border border-cyan-500/40 text-[11px] font-semibold text-cyan-200 shrink-0">
                    当前议题
                  </span>
                  <h3 className="text-sm font-bold text-zinc-100 truncate">
                    {displayCurrentTopic}
                  </h3>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {activeItem && (
                    <span className={`px-2 py-0.5 rounded border text-[10px] font-medium ${curRel.cls}`}>
                      {curRel.label}
                    </span>
                  )}
                  <span className="text-[10px] font-mono text-zinc-400">
                    共 {flow.length} 个议题节点
                  </span>
                </div>
              </div>

              {(activeItem?.transitionFrom || activeItem?.relevanceNote) && (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-300 bg-zinc-950/60 border border-zinc-800/80 rounded-lg px-2.5 py-1.5">
                  {activeItem.transitionFrom && (
                    <span className="text-cyan-300/90">
                      流转自：<span className="font-medium">{activeItem.transitionFrom}</span>
                    </span>
                  )}
                  {activeItem.transitionFrom && activeItem.relevanceNote && (
                    <span className="text-zinc-600">·</span>
                  )}
                  {activeItem.relevanceNote && (
                    <span className="text-zinc-300">{activeItem.relevanceNote}</span>
                  )}
                </div>
              )}

              {flow.length > 0 ? (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium text-zinc-400">议题流转与相关性轨迹</div>
                  <div className="flex flex-wrap items-center gap-2">
                    {flow.map((item, idx) => {
                      const rm = relMeta(item.relevance);
                      const isActive = item.status === 'active';
                      return (
                        <React.Fragment key={item.id || `${item.topic}-${idx}`}>
                          <div
                            className={`rounded-lg border px-2.5 py-1.5 text-xs space-y-1 transition ${
                              isActive
                                ? 'border-cyan-500/50 bg-cyan-950/35 shadow-sm'
                                : 'border-zinc-800 bg-zinc-950/70'
                            }`}
                          >
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                  isActive ? 'bg-cyan-400 animate-pulse' : 'bg-zinc-600'
                                }`}
                              />
                              <span className={`font-semibold ${isActive ? 'text-cyan-100' : 'text-zinc-200'}`}>
                                {item.topic}
                              </span>
                              <span className={`px-1.5 py-0.2 rounded border text-[10px] ${rm.cls}`}>
                                {rm.label}
                              </span>
                              <button
                                type="button"
                                onClick={() => onJumpToMs(item.startMs)}
                                className="text-[10px] font-mono text-blue-400 hover:underline cursor-pointer ml-1"
                              >
                                [{formatLiveMmSs(item.startMs)}]
                              </button>
                            </div>
                            {(item.relevanceNote || (item.speakers && item.speakers.length > 0)) && (
                              <div className="text-[10px] text-zinc-400 flex flex-wrap items-center gap-1.5">
                                {item.speakers && item.speakers.length > 0 && (
                                  <span className="text-zinc-300">
                                    参与：{item.speakers.join('、')}
                                  </span>
                                )}
                                {item.relevanceNote && (
                                  <span className="truncate max-w-xs">{item.relevanceNote}</span>
                                )}
                              </div>
                            )}
                          </div>
                          {idx < flow.length - 1 && (
                            <span className="text-zinc-500 text-xs font-mono shrink-0">→</span>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-950/50 py-3 px-3 text-[11px] text-zinc-400">
                  多人聊天开始后，AI 将持续识别当前议题、追踪话题流转轨迹并评估与核心主题的相关性…
                </div>
              )}
            </section>
          );
        })()}

        {/* 1. 核心四维实时 KPI 卡片 */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {/* 语速 */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/65 p-3 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-zinc-400">
              <span className="inline-flex items-center gap-1 font-medium">
                <TrendingUp className="w-3.5 h-3.5 text-blue-400" />
                <span>语速</span>
              </span>
              <span className={`px-1.5 py-0.5 rounded border text-[10px] ${paceBadgeCls}`}>
                {analytics.pace.paceLabel}
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xl font-bold font-mono text-zinc-100">
                {analytics.pace.overallCpm || '--'}
              </span>
              <span className="text-[11px] text-zinc-400">字/分</span>
            </div>
            <div className="text-[10px] text-zinc-500 flex items-center justify-between">
              <span>近期：{analytics.pace.recentCpm || '--'} 字/分</span>
              <span>波动 ±{analytics.pace.paceStdCpm}</span>
            </div>
          </div>

          {/* 口语词 */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/65 p-3 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-zinc-400">
              <span className="inline-flex items-center gap-1 font-medium">
                <MessageSquareWarning className="w-3.5 h-3.5 text-amber-400" />
                <span>口语词</span>
              </span>
              <span className="text-[10px] font-mono text-zinc-400">
                占比 {analytics.fillers.charRatioPct}%
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xl font-bold font-mono text-zinc-100">
                {analytics.fillers.totalCount}
              </span>
              <span className="text-[11px] text-zinc-400">次</span>
            </div>
            <div className="text-[10px] text-zinc-500 flex items-center justify-between">
              <span>频率：{analytics.fillers.perMin} 次/分</span>
              <span>
                {analytics.fillers.topWords[0]
                  ? `高频「${analytics.fillers.topWords[0].word}」`
                  : '暂无口癖'}
              </span>
            </div>
          </div>

          {/* 信息密度 */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/65 p-3 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-zinc-400">
              <span className="inline-flex items-center gap-1 font-medium">
                <Zap className="w-3.5 h-3.5 text-emerald-400" />
                <span>信息密度</span>
              </span>
              <span className={`px-1.5 py-0.5 rounded border text-[10px] ${densityBadgeCls}`}>
                {analytics.density.levelLabel}
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xl font-bold font-mono text-zinc-100">
                {analytics.utteranceCount > 0 ? analytics.density.score : '--'}
              </span>
              <span className="text-[11px] text-zinc-400">/ 100</span>
            </div>
            <div className="text-[10px] text-zinc-500 flex items-center justify-between">
              <span>有效率 {analytics.density.effectiveRatioPct}%</span>
              <span>事实/数字 {analytics.density.factMarkerCount} 处</span>
            </div>
          </div>

          {/* 逻辑连接 */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/65 p-3 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-zinc-400">
              <span className="inline-flex items-center gap-1 font-medium">
                <GitBranch className="w-3.5 h-3.5 text-purple-400" />
                <span>逻辑连接</span>
              </span>
              <span className="text-[10px] font-mono text-purple-300">
                {analytics.logicMap.branches.length} 节点
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xl font-bold font-mono text-zinc-100">
                {analytics.logicMap.totalConnectors}
              </span>
              <span className="text-[11px] text-zinc-400">处连接词</span>
            </div>
            <div className="text-[10px] text-zinc-500 flex items-center justify-between">
              <span>观点 {snap.profile.viewpoints.length}</span>
              <span>要点 {snap.keyPoints.length}</span>
            </div>
          </div>
        </div>

        {/* 2. 核心内容提炼：讲者与主题背景 / 经历与案例 / 核心立场观点 */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          {/* 讲者与主题背景 */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5 space-y-2.5 flex flex-col">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-bold text-zinc-100 flex items-center gap-1.5">
                <BookOpen className="w-3.5 h-3.5 text-cyan-400" />
                <span>{isListenMode ? '讲者与主题背景' : '身份与背景信息'}</span>
              </h3>
              <span className="text-[10px] font-mono text-zinc-500">
                {snap.profile.background.length} 项
              </span>
            </div>
            {snap.profile.background.length === 0 ? (
              <div className="flex-1 rounded-lg border border-dashed border-zinc-800 bg-zinc-950/50 py-5 px-3 flex items-center justify-center text-center text-[11px] text-zinc-500">
                {isListenMode ? '等待讲座内容中自动提取…' : '等待对话中自动提取…'}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                {snap.profile.background.map((b, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-2.5 text-xs text-zinc-200 space-y-1"
                  >
                    <p className="leading-relaxed">{b.text}</p>
                    <button
                      type="button"
                      onClick={() => onJumpToMs(b.evidenceMs)}
                      className="text-[10px] font-mono text-blue-400 hover:underline cursor-pointer"
                    >
                      [{formatLiveMmSs(b.evidenceMs)}]
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 经历与案例 */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5 space-y-2.5 flex flex-col">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-bold text-zinc-100 flex items-center gap-1.5">
                <Briefcase className="w-3.5 h-3.5 text-purple-400" />
                <span>经历与案例</span>
              </h3>
              <span className="text-[10px] font-mono text-zinc-500">
                {snap.profile.stories.length} 项
              </span>
            </div>
            {snap.profile.stories.length === 0 ? (
              <div className="flex-1 rounded-lg border border-dashed border-zinc-800 bg-zinc-950/50 py-5 px-3 flex items-center justify-center text-center text-[11px] text-zinc-500">
                暂无经历或案例提取…
              </div>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                {snap.profile.stories.map((st, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-2.5 text-xs text-zinc-200 space-y-1"
                  >
                    <div className="font-semibold text-zinc-100">{st.title}</div>
                    <p className="text-zinc-300 leading-relaxed">{st.gist}</p>
                    <button
                      type="button"
                      onClick={() => onJumpToMs(st.evidenceMs)}
                      className="text-[10px] font-mono text-blue-400 hover:underline cursor-pointer"
                    >
                      [{formatLiveMmSs(st.evidenceMs)}]
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 核心立场 / 观点 */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5 space-y-2.5 flex flex-col">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-bold text-zinc-100 flex items-center gap-1.5">
                <Compass className="w-3.5 h-3.5 text-emerald-400" />
                <span>核心立场 / 观点</span>
              </h3>
              <span className="text-[10px] font-mono text-zinc-500">
                {snap.profile.viewpoints.length} 项
              </span>
            </div>
            {snap.profile.viewpoints.length === 0 ? (
              <div className="flex-1 rounded-lg border border-dashed border-zinc-800 bg-zinc-950/50 py-5 px-3 flex items-center justify-center text-center text-[11px] text-zinc-500">
                暂无核心观点提取…
              </div>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                {snap.profile.viewpoints.map((vp, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-2.5 text-xs text-zinc-200 space-y-1"
                  >
                    <p className="font-medium text-zinc-100 leading-relaxed">{vp.claim}</p>
                    {vp.support && (
                      <p className="text-[11px] text-zinc-400 leading-relaxed">{vp.support}</p>
                    )}
                    <button
                      type="button"
                      onClick={() => onJumpToMs(vp.evidenceMs)}
                      className="text-[10px] font-mono text-blue-400 hover:underline cursor-pointer"
                    >
                      [{formatLiveMmSs(vp.evidenceMs)}]
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* 3. 逻辑连接导图 */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-purple-400" />
              <h3 className="text-xs font-bold text-zinc-100">逻辑连接导图</h3>
              <span className="text-[11px] text-zinc-500">
                {logicViewMode === 'graph'
                  ? '多维逻辑图谱 · 高亮节点支持提问拓展'
                  : '点击节点可定位右侧原文'}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
              {(
                [
                  { label: '因果', count: analytics.logicMap.connectorCounts.causal, cls: RELATION_STYLE.causal },
                  { label: '转折', count: analytics.logicMap.connectorCounts.contrast, cls: RELATION_STYLE.contrast },
                  { label: '递进', count: analytics.logicMap.connectorCounts.progression, cls: RELATION_STYLE.progression },
                  { label: '举例', count: analytics.logicMap.connectorCounts.example, cls: RELATION_STYLE.example },
                  { label: '总结', count: analytics.logicMap.connectorCounts.conclusion, cls: RELATION_STYLE.conclusion },
                ] as const
              ).map((c) => (
                <span
                  key={c.label}
                  className={`px-1.5 py-0.5 rounded border ${c.cls}`}
                >
                  {c.label} {c.count}
                </span>
              ))}
              <div className="inline-flex rounded border border-zinc-700 overflow-hidden ml-1">
                <button
                  type="button"
                  onClick={() => setLogicViewMode('graph')}
                  className={`px-2 py-0.5 cursor-pointer transition ${
                    logicViewMode === 'graph'
                      ? 'bg-purple-600/30 text-purple-200 font-semibold'
                      : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  图谱
                </button>
                <button
                  type="button"
                  onClick={() => setLogicViewMode('list')}
                  className={`px-2 py-0.5 cursor-pointer transition ${
                    logicViewMode === 'list'
                      ? 'bg-purple-600/30 text-purple-200 font-semibold'
                      : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  列表
                </button>
              </div>
            </div>
          </div>

          {analytics.logicMap.nodes.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-950/50 py-6 text-center text-xs text-zinc-500">
              对话展开后，将自动抽取核心观点、因果/转折/递进逻辑链与论据支点生成逻辑连接图…
            </div>
          ) : logicViewMode === 'graph' ? (
            <LogicConnectionGraph
              logicMap={analytics.logicMap}
              onJumpToMs={onJumpToMs}
            />
          ) : (
            <div className="relative rounded-lg border border-zinc-800/80 bg-zinc-950/70 p-3 overflow-x-auto">
              <div className="flex items-stretch gap-4 min-w-[520px]">
                {/* 中心主题根节点 */}
                <div className="w-40 shrink-0 flex items-center">
                  <div className="w-full rounded-xl border border-cyan-500/40 bg-cyan-950/30 p-3 shadow-sm">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400 mb-1">
                      核心主题
                    </div>
                    <div className="text-xs font-bold text-zinc-100 leading-snug">
                      {analytics.logicMap.rootTopic}
                    </div>
                  </div>
                </div>

                {/* 分支连线与节点列表 */}
                <div className="flex-1 space-y-2 border-l-2 border-zinc-800 pl-4 relative">
                  {analytics.logicMap.branches.map((branch: LogicMapBranch) => (
                    <div key={branch.id} className="relative flex items-start gap-2.5">
                      {/* 横向分支连接线 */}
                      <span
                        className="absolute -left-4 top-3.5 w-3.5 h-0.5 bg-zinc-700"
                        aria-hidden="true"
                      />
                      <button
                        type="button"
                        onClick={() => onJumpToMs(branch.evidenceMs)}
                        className="flex-1 text-left rounded-lg border border-zinc-800 bg-zinc-900/85 hover:border-zinc-600 hover:bg-zinc-900 p-2.5 transition cursor-pointer space-y-1.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${
                              RELATION_STYLE[branch.relation]
                            }`}
                          >
                            {branch.relationLabel}
                          </span>
                          <span className="text-[10px] font-mono text-blue-400">
                            [{formatLiveMmSs(branch.evidenceMs)}]
                          </span>
                        </div>
                        <div className="text-xs font-medium text-zinc-100 leading-snug">
                          {branch.title}
                        </div>
                        {branch.children.length > 0 && (
                          <div className="pl-2.5 border-l border-zinc-700 space-y-1 mt-1">
                            {branch.children.map((ch) => (
                              <div key={ch.id} className="text-[11px] text-zinc-400 leading-snug">
                                <span className="text-zinc-500 mr-1">[{ch.relationLabel}]</span>
                                {ch.text}
                              </div>
                            ))}
                          </div>
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* 3. 双列分析区：语速趋势 & 口语词统计 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 语速趋势与发言占比 */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-zinc-100 flex items-center gap-1.5">
                <TrendingUp className="w-3.5 h-3.5 text-blue-400" />
                <span>语速与密度趋势</span>
              </h3>
              <span className="text-[10px] text-zinc-500">绿区为舒适语速 140–300 字/分</span>
            </div>

            {trend.length === 0 ? (
              <div className="h-28 rounded-lg border border-dashed border-zinc-800 bg-zinc-950/50 flex items-center justify-center text-xs text-zinc-500">
                等待语音输入以绘制实时语速曲线…
              </div>
            ) : (
              <svg
                viewBox={`0 0 ${chartW} ${chartH}`}
                className="w-full h-28 rounded-lg bg-zinc-950/70 border border-zinc-800/80"
              >
                {/* 舒适语速区间阴影 */}
                <rect
                  x={padX}
                  y={Math.min(bandTopY, bandBotY)}
                  width={chartW - padX * 2}
                  height={Math.max(4, Math.abs(bandBotY - bandTopY))}
                  fill="#10b981"
                  fillOpacity={0.08}
                />
                {/* 信息密度背景柱 */}
                {trend.map((p, idx) => {
                  const x =
                    trend.length === 1
                      ? chartW / 2
                      : padX + (idx / (trend.length - 1)) * (chartW - padX * 2);
                  const barH = (p.densityScore / 100) * 26;
                  return (
                    <rect
                      key={p.id}
                      x={x - 3}
                      y={chartH - 4 - barH}
                      width={6}
                      height={barH}
                      rx={1.5}
                      fill="#06b6d4"
                      fillOpacity={0.28}
                    />
                  );
                })}
                {/* 语速折线 */}
                {trend.length >= 2 && (
                  <polyline
                    fill="none"
                    stroke="#60a5fa"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    points={cpmPolyline}
                  />
                )}
                {/* 节点圆点 */}
                {trend.map((p, idx) => {
                  const x =
                    trend.length === 1
                      ? chartW / 2
                      : padX + (idx / (trend.length - 1)) * (chartW - padX * 2);
                  const y =
                    chartH - padY - (Math.min(maxCpm, p.cpm) / maxCpm) * (chartH - padY * 2);
                  return (
                    <circle
                      key={`pt-${p.id}`}
                      cx={x}
                      cy={y}
                      r={3}
                      fill="#93c5fd"
                      className="cursor-pointer"
                      onClick={() => onJumpToMs(p.timeMs)}
                    >
                      <title>
                        {formatLiveMmSs(p.timeMs)} · {p.cpm} 字/分 · 密度 {p.densityScore}
                      </title>
                    </circle>
                  );
                })}
              </svg>
            )}

            {/* 各发言人发言占比 */}
            {analytics.speakers.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <div className="text-[11px] font-medium text-zinc-400">发言人字数占比与语速</div>
                <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden flex">
                  {analytics.speakers.map((sp, i) => (
                    <div
                      key={sp.speakerId}
                      style={{ width: `${sp.sharePct}%` }}
                      className={SPEAKER_BAR_COLORS[i % SPEAKER_BAR_COLORS.length]}
                      title={`${sp.name}: ${sp.sharePct}%`}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-400">
                  {analytics.speakers.map((sp, i) => (
                    <span key={sp.speakerId} className="inline-flex items-center gap-1">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          SPEAKER_BAR_COLORS[i % SPEAKER_BAR_COLORS.length]
                        }`}
                      />
                      <span className="text-zinc-200">{sp.name}</span>
                      <span>
                        {sp.sharePct}% · {sp.avgCpm}字/分
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* 口语词检测 */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-zinc-100 flex items-center gap-1.5">
                <MessageSquareWarning className="w-3.5 h-3.5 text-amber-400" />
                <span>口语词与冗余词统计</span>
              </h3>
              <span className="text-[10px] text-zinc-500">点击词条定位原文</span>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
                <div className="text-[10px] text-zinc-400">起手口癖</div>
                <div className="text-sm font-bold font-mono text-amber-300">
                  {analytics.fillers.byCategory.starter_crutch}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
                <div className="text-[10px] text-zinc-400">模糊确认</div>
                <div className="text-sm font-bold font-mono text-purple-300">
                  {analytics.fillers.byCategory.hedging_tail}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
                <div className="text-[10px] text-zinc-400">语气停顿</div>
                <div className="text-sm font-bold font-mono text-cyan-300">
                  {analytics.fillers.byCategory.pure_filler}
                </div>
              </div>
            </div>

            {analytics.fillers.topWords.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-950/50 py-5 text-center text-xs text-zinc-500">
                暂未检测到明显口语词 / 口癖
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {analytics.fillers.topWords.map((item) => (
                  <button
                    key={item.word}
                    type="button"
                    onClick={() => onJumpToMs(item.latestMs)}
                    title={`${item.categoryLabel} · 首次 ${formatLiveMmSs(item.firstMs)} · 最新 ${formatLiveMmSs(item.latestMs)}`}
                    className="px-2 py-1 rounded-lg border border-zinc-700/80 bg-zinc-950/80 hover:border-amber-500/50 hover:bg-amber-500/10 text-xs text-zinc-200 inline-flex items-center gap-1.5 cursor-pointer transition"
                  >
                    <span>{item.word}</span>
                    <span className="px-1 rounded bg-amber-500/20 text-amber-300 font-mono text-[10px]">
                      ×{item.count}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* 4. 发言习惯分析 */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-bold text-zinc-100 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-emerald-400" />
              <span>发言习惯分析</span>
            </h3>
            <span className="px-2 py-0.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-300">
              模式：{analytics.habits.dominantPattern}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 五维能力条 */}
            <div className="space-y-2">
              {analytics.habits.dimensions.map((dim) => {
                const barCls =
                  dim.score >= 75
                    ? 'bg-emerald-500'
                    : dim.score >= 50
                      ? 'bg-blue-500'
                      : 'bg-amber-500';
                return (
                  <div key={dim.key} className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-zinc-300">{dim.label}</span>
                      <span className="font-mono text-zinc-400">{dim.score}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${barCls}`}
                        style={{ width: `${dim.score}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 微观指标与习惯诊断标签 */}
            <div className="space-y-2.5">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
                  <div className="text-[10px] text-zinc-500">平均单句长度</div>
                  <div className="font-mono font-semibold text-zinc-200">
                    {analytics.habits.avgUtteranceChars} 字
                  </div>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
                  <div className="text-[10px] text-zinc-500">平均连续轮次</div>
                  <div className="font-mono font-semibold text-zinc-200">
                    {analytics.habits.avgTurnDurationSec}s
                  </div>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
                  <div className="text-[10px] text-zinc-500">最长连续输出</div>
                  <div className="font-mono font-semibold text-zinc-200">
                    {analytics.habits.maxTurnDurationSec}s
                  </div>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
                  <div className="text-[10px] text-zinc-500">对话轮次切换</div>
                  <div className="font-mono font-semibold text-zinc-200">
                    {analytics.habits.turnSwitchCount} 次
                  </div>
                </div>
              </div>

              {analytics.habits.tags.length > 0 && (
                <div className="space-y-1">
                  {analytics.habits.tags.map((tag, idx) => (
                    <div
                      key={idx}
                      className={`rounded-lg border px-2.5 py-1.5 text-[11px] flex items-center justify-between gap-2 ${
                        tag.tone === 'good'
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                          : tag.tone === 'warn'
                            ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                            : 'border-blue-500/30 bg-blue-500/10 text-blue-200'
                      }`}
                    >
                      <span className="font-medium shrink-0">{tag.label}</span>
                      <span className="text-[10px] opacity-80 truncate">{tag.detail}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* 5. 提纲进度与全场要点（实时提取内容补充） */}
        {(snap.outline.length > 0 || snap.keyPoints.length > 0) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {snap.keyPoints.length > 0 && (
              <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5 space-y-2">
                <h3 className="text-xs font-bold text-zinc-100 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                  <span>{isListenMode ? '实时总结与核心要点' : '全场要点提取'}</span>
                </h3>
                <ul className="space-y-1.5 text-xs text-zinc-300 list-disc pl-4">
                  {snap.keyPoints.map((kp, i) => (
                    <li key={i}>{kp}</li>
                  ))}
                </ul>
              </section>
            )}

            {snap.outline.length > 0 && (
              <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5 space-y-2">
                <h3 className="text-xs font-bold text-zinc-100">
                  {isListenMode ? '议程 / 关注点进度' : '提纲覆盖进度'}
                </h3>
                <div className="space-y-1.5">
                  {snap.outline.map((item) => {
                    const badge = outlineBadge(item.status);
                    return (
                      <div
                        key={item.id}
                        onClick={() => onOverrideOutline(item.id, nextOutlineStatus(item.status))}
                        title="点击手动切换覆盖状态"
                        className="rounded-lg border border-zinc-800 bg-zinc-950/70 hover:bg-zinc-800/70 p-2 space-y-1 cursor-pointer transition"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-xs text-zinc-200 leading-snug">{item.text}</span>
                          <span
                            className={`px-1.5 py-0.5 rounded border text-[10px] shrink-0 ${badge.cls}`}
                          >
                            {badge.label}
                          </span>
                        </div>
                        {item.note && <p className="text-[10px] text-zinc-400">{item.note}</p>}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </main>
  );
};
