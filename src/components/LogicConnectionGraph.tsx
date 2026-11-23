import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  Compass,
  Copy,
  GitBranch,
  Link2,
  Maximize2,
  Minimize2,
  RotateCcw,
  Sparkles,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  LogicConnectionMap,
  LogicRelationType,
} from '../engine/liveSpeechAnalytics';
import {
  computeMindMapLayout,
  DockedQuestion,
  MindMapLayoutMode,
  MindMapPositionedNode,
} from '../engine/logicMindMapLayout';
import { formatLiveMmSs } from '../engine/liveMinutesExporter';

interface LogicConnectionGraphProps {
  logicMap: LogicConnectionMap;
  onJumpToMs: (ms: number) => void;
  onQuestionAction?: (questionId: string, action: 'adopted' | 'dismissed') => void;
}

const RELATION_BADGE_STYLE: Record<LogicRelationType, string> = {
  viewpoint: 'bg-blue-500/20 text-blue-200 border-blue-400/50',
  story: 'bg-purple-500/20 text-purple-200 border-purple-400/50',
  causal: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/50',
  contrast: 'bg-orange-500/20 text-orange-200 border-orange-400/50',
  progression: 'bg-teal-500/20 text-teal-200 border-teal-400/50',
  example: 'bg-indigo-500/20 text-indigo-200 border-indigo-400/50',
  conclusion: 'bg-rose-500/20 text-rose-200 border-rose-400/50',
  outline: 'bg-slate-600/35 text-slate-200 border-slate-400/50',
};

const NODE_CARD_THEME: Record<
  LogicRelationType,
  { card: string; accent: string; label: string; dot: string }
> = {
  viewpoint: {
    card: 'border-blue-500/50 bg-blue-950/45 hover:border-blue-400/80',
    accent: 'bg-blue-400',
    label: '观点',
    dot: 'bg-blue-400',
  },
  story: {
    card: 'border-purple-500/50 bg-purple-950/45 hover:border-purple-400/80',
    accent: 'bg-purple-400',
    label: '案例',
    dot: 'bg-purple-400',
  },
  causal: {
    card: 'border-emerald-500/50 bg-emerald-950/45 hover:border-emerald-400/80',
    accent: 'bg-emerald-400',
    label: '因果',
    dot: 'bg-emerald-400',
  },
  contrast: {
    card: 'border-orange-500/50 bg-orange-950/45 hover:border-orange-400/80',
    accent: 'bg-orange-400',
    label: '转折',
    dot: 'bg-orange-400',
  },
  progression: {
    card: 'border-teal-500/50 bg-teal-950/45 hover:border-teal-400/80',
    accent: 'bg-teal-400',
    label: '递进',
    dot: 'bg-teal-400',
  },
  example: {
    card: 'border-indigo-500/50 bg-indigo-950/45 hover:border-indigo-400/80',
    accent: 'bg-indigo-400',
    label: '举例',
    dot: 'bg-indigo-400',
  },
  conclusion: {
    card: 'border-rose-500/50 bg-rose-950/45 hover:border-rose-400/80',
    accent: 'bg-rose-400',
    label: '结论',
    dot: 'bg-rose-400',
  },
  outline: {
    card: 'border-slate-500/50 bg-slate-900/75 hover:border-slate-400/80',
    accent: 'bg-slate-400',
    label: '提纲',
    dot: 'bg-slate-400',
  },
};

export const LogicConnectionGraph: React.FC<LogicConnectionGraphProps> = ({
  logicMap,
  onJumpToMs,
  onQuestionAction,
}) => {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>({
    width: 680,
    height: 400,
  });

  const [layoutMode, setLayoutMode] = useState<MindMapLayoutMode>('radial');
  const [showDockedQuestions, setShowDockedQuestions] = useState(true);
  const [onlyExpandable, setOnlyExpandable] = useState(false);
  const [showCrossLinks, setShowCrossLinks] = useState(false);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [copiedQuestionId, setCopiedQuestionId] = useState<string | null>(null);

  const dragRef = useRef<{
    startX: number;
    startY: number;
    originPanX: number;
    originPanY: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 120) {
        setViewportSize({ width: w, height: Math.max(280, h) });
      }
    };
    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [isFullscreen]);

  // 聚焦可提问时临时展开被折叠的分支，避免提问被隐藏
  const effectiveCollapsedIds = useMemo(() => {
    if (onlyExpandable) return new Set<string>();
    return collapsedIds;
  }, [onlyExpandable, collapsedIds]);

  const layout = useMemo(
    () =>
      computeMindMapLayout(logicMap, {
        mode: layoutMode,
        containerWidth: viewportSize.width,
        showDockedQuestions,
        collapsedIds: effectiveCollapsedIds,
      }),
    [logicMap, layoutMode, viewportSize.width, showDockedQuestions, effectiveCollapsedIds]
  );

  const effectiveZoom = zoom ?? layout.autoFitScale;

  // 默认将思维导图居中放入画布视口
  const baseOffset = useMemo(() => {
    const scaledW = layout.width * effectiveZoom;
    const scaledH = layout.height * effectiveZoom;
    const canvasH = isFullscreen
      ? viewportSize.height
      : Math.min(540, Math.max(320, Math.ceil(scaledH + 24)));
    return {
      x: (viewportSize.width - scaledW) / 2,
      y: (canvasH - scaledH) / 2,
      canvasH,
    };
  }, [layout.width, layout.height, effectiveZoom, viewportSize.width, viewportSize.height, isFullscreen]);

  // 切换布局模式或全屏时复位手动平移
  useEffect(() => {
    setPan({ x: 0, y: 0 });
  }, [layoutMode, isFullscreen]);

  const activeNodeId = hoveredNodeId ?? selectedNodeId;

  // 计算当前高亮路径（祖先链 + 直接子节点 + 跨支关联）
  const focusSets = useMemo(() => {
    const pathNodes = new Set<string>();
    const pathCurves = new Set<string>();
    const crossPeerNodes = new Set<string>();
    const branchId = activeNodeId ? layout.nodeById.get(activeNodeId)?.branchId ?? null : null;

    if (activeNodeId && layout.nodeById.has(activeNodeId)) {
      let cur: string | null | undefined = activeNodeId;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        pathNodes.add(cur);
        const pId: string | null = layout.parentMap.get(cur) ?? null;
        if (pId) {
          pathCurves.add(`curve-${pId}->${cur}`);
        }
        cur = pId;
      }

      const activeItem = layout.nodeById.get(activeNodeId);
      if (activeItem) {
        for (const cId of activeItem.childIds) {
          if (layout.nodeById.has(cId)) {
            pathNodes.add(cId);
            pathCurves.add(`curve-${activeItem.id}->${cId}`);
          }
        }
      }

      for (const link of layout.crossLinks) {
        if (link.sourceId === activeNodeId) crossPeerNodes.add(link.targetId);
        if (link.targetId === activeNodeId) crossPeerNodes.add(link.sourceId);
      }
    }

    return { pathNodes, pathCurves, crossPeerNodes, branchId };
  }, [activeNodeId, layout]);

  const selectedItem: MindMapPositionedNode | null = selectedNodeId
    ? layout.nodeById.get(selectedNodeId) ?? null
    : null;

  const selectedCrossPeers = useMemo(() => {
    if (!selectedItem) return [];
    const peers: Array<{ node: MindMapPositionedNode; label: string; color: string }> = [];
    for (const link of layout.crossLinks) {
      if (link.sourceId === selectedItem.id) {
        const peer = layout.nodeById.get(link.targetId);
        if (peer) peers.push({ node: peer, label: link.edge.label, color: link.color });
      } else if (link.targetId === selectedItem.id) {
        const peer = layout.nodeById.get(link.sourceId);
        if (peer) peers.push({ node: peer, label: link.edge.label, color: link.color });
      }
    }
    return peers;
  }, [selectedItem, layout]);

  const handleJumpToMs = (ms: number) => {
    if (isFullscreen) setIsFullscreen(false);
    onJumpToMs(ms);
  };

  const toggleCollapse = (nodeId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const handleCopyQuestion = (q: DockedQuestion) => {
    navigator.clipboard?.writeText(q.text).catch(() => {});
    setCopiedQuestionId(q.id);
    window.setTimeout(() => {
      setCopiedQuestionId((cur) => (cur === q.id ? null : cur));
    }, 1500);
  };

  const handleViewportMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-mindmap-interactive="true"]')) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originPanX: pan.x,
      originPanY: pan.y,
      moved: false,
    };
    setIsDragging(true);
  };

  const handleViewportMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      dragRef.current.moved = true;
    }
    setPan({
      x: dragRef.current.originPanX + dx,
      y: dragRef.current.originPanY + dy,
    });
  };

  const handleViewportMouseUp = () => {
    if (dragRef.current && !dragRef.current.moved) {
      setSelectedNodeId(null);
    }
    dragRef.current = null;
    setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.08 : -0.08;
    setZoom((prev) => {
      const base = prev ?? layout.autoFitScale;
      return Math.max(0.55, Math.min(1.45, Number((base + step).toFixed(2))));
    });
  };

  const adjustZoom = (delta: number) => {
    setZoom((prev) => {
      const base = prev ?? layout.autoFitScale;
      return Math.max(0.55, Math.min(1.45, Number((base + delta).toFixed(2))));
    });
  };

  const resetView = () => {
    setZoom(null);
    setPan({ x: 0, y: 0 });
  };

  const visibleCrossLinks = useMemo(() => {
    if (showCrossLinks) return layout.crossLinks;
    if (!activeNodeId) return [];
    return layout.crossLinks.filter(
      (l) => l.sourceId === activeNodeId || l.targetId === activeNodeId
    );
  }, [showCrossLinks, activeNodeId, layout.crossLinks]);

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 bg-zinc-950/95 backdrop-blur-sm flex flex-col p-4 sm:p-6 gap-3'
          : 'space-y-2'
      }
    >
      {/* 顶部控制栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] shrink-0">
        <div className="flex flex-wrap items-center gap-2 text-zinc-400">
          {isFullscreen && (
            <>
              <span className="text-xs font-bold text-zinc-100">
                逻辑连接导图 · {logicMap.rootTopic || '全屏视图'}
              </span>
              <span className="text-zinc-600">|</span>
            </>
          )}
          <span className="text-zinc-300 font-medium">
            {layoutMode === 'radial' ? '中心发散' : '向右展开'} · {layout.nodes.length} 模块 ·{' '}
            {layout.curves.length} 枝干
          </span>
          {layout.totalDockedQuestions > 0 && (
            <>
              <span className="text-zinc-600">|</span>
              <span className="inline-flex items-center gap-1 text-amber-300 font-medium">
                <Sparkles className="w-3 h-3" />
                <span>磁吸提问 ({layout.totalDockedQuestions})</span>
              </span>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* 布局模式切换 */}
          <div className="inline-flex rounded border border-zinc-700 bg-zinc-900 p-0.5">
            <button
              type="button"
              onClick={() => setLayoutMode('radial')}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] cursor-pointer transition ${
                layoutMode === 'radial'
                  ? 'bg-cyan-500/20 text-cyan-200 font-medium'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="以中心主题为核心向两侧发散的思维导图布局"
            >
              <Compass className="w-2.5 h-2.5" />
              <span>中心发散</span>
            </button>
            <button
              type="button"
              onClick={() => setLayoutMode('right')}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] cursor-pointer transition ${
                layoutMode === 'right'
                  ? 'bg-cyan-500/20 text-cyan-200 font-medium'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="从左向右逐级展开的逻辑树布局"
            >
              <GitBranch className="w-2.5 h-2.5" />
              <span>向右展开</span>
            </button>
          </div>

          {layout.totalDockedQuestions > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowDockedQuestions((v) => !v)}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border cursor-pointer transition ${
                  showDockedQuestions
                    ? 'bg-amber-500/20 text-amber-200 border-amber-400/60 font-medium'
                    : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:text-zinc-200'
                }`}
                title="切换提问直接在模块底部展开或收起为紧凑角标"
              >
                <Sparkles className="w-2.5 h-2.5" />
                <span>{showDockedQuestions ? '提问已吸附展开' : '提问紧凑角标'}</span>
              </button>

              <button
                type="button"
                onClick={() => setOnlyExpandable((v) => !v)}
                className={`px-2 py-0.5 rounded border cursor-pointer transition ${
                  onlyExpandable
                    ? 'bg-amber-500/20 text-amber-200 border-amber-400/60 font-medium'
                    : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:text-zinc-200'
                }`}
              >
                {onlyExpandable ? '显示全部' : '聚焦可提问'}
              </button>
            </>
          )}

          {layout.crossLinks.length > 0 && (
            <button
              type="button"
              onClick={() => setShowCrossLinks((v) => !v)}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border cursor-pointer transition ${
                showCrossLinks
                  ? 'bg-purple-500/20 text-purple-200 border-purple-400/60 font-medium'
                  : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:text-zinc-200'
              }`}
              title="默认仅悬停或选中节点时展示跨支关联，点击可常驻显示全部"
            >
              <Link2 className="w-2.5 h-2.5" />
              <span>跨支关联 ({layout.crossLinks.length})</span>
            </button>
          )}

          {/* 缩放与居中控制 */}
          <div className="inline-flex items-center rounded border border-zinc-700 bg-zinc-900 overflow-hidden">
            <button
              type="button"
              onClick={() => adjustZoom(-0.1)}
              className="px-1.5 py-0.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer transition"
              title="缩小"
            >
              <ZoomOut className="w-3 h-3" />
            </button>
            <span className="px-1.5 font-mono text-zinc-300 select-none">
              {Math.round(effectiveZoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => adjustZoom(0.1)}
              className="px-1.5 py-0.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer transition"
              title="放大"
            >
              <ZoomIn className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={resetView}
              className="px-1.5 py-0.5 border-l border-zinc-700 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer transition inline-flex items-center gap-0.5"
              title="重置缩放并居中适配"
            >
              <RotateCcw className="w-2.5 h-2.5" />
              <span>适配</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setIsFullscreen((v) => !v)}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border cursor-pointer transition ${
              isFullscreen
                ? 'bg-zinc-800 text-zinc-100 border-zinc-600 hover:bg-zinc-700 font-medium'
                : 'bg-zinc-900 text-zinc-300 border-zinc-700 hover:text-zinc-100 hover:border-zinc-500'
            }`}
            title={isFullscreen ? '退出全屏 (Esc)' : '全屏查看逻辑连接导图'}
          >
            {isFullscreen ? (
              <>
                <Minimize2 className="w-3 h-3" />
                <span>退出全屏</span>
              </>
            ) : (
              <>
                <Maximize2 className="w-3 h-3" />
                <span>全屏</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* 思维导图画布视口 */}
      <div
        ref={viewportRef}
        onMouseDown={handleViewportMouseDown}
        onMouseMove={handleViewportMouseMove}
        onMouseUp={handleViewportMouseUp}
        onMouseLeave={handleViewportMouseUp}
        onWheel={handleWheel}
        style={{
          height: isFullscreen ? undefined : `${baseOffset.canvasH}px`,
          backgroundImage:
            'radial-gradient(rgba(148, 163, 184, 0.13) 1px, transparent 1px)',
          backgroundSize: '18px 18px',
        }}
        className={`relative rounded-xl border border-zinc-800/80 bg-zinc-950/85 overflow-hidden select-none ${
          isFullscreen ? 'flex-1 min-h-0' : ''
        } ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      >
        <div
          style={{
            width: `${layout.width}px`,
            height: `${layout.height}px`,
            transform: `translate(${(baseOffset.x + pan.x).toFixed(1)}px, ${(
              baseOffset.y + pan.y
            ).toFixed(1)}px) scale(${effectiveZoom})`,
            transformOrigin: '0 0',
          }}
          className="relative transition-transform duration-75 ease-out"
        >
          {/* SVG 聚类底板、有机枝干曲线与按需跨支关联线 */}
          <svg
            width={layout.width}
            height={layout.height}
            className="absolute inset-0 pointer-events-none overflow-visible"
          >
            {/* 分支微聚合底板：让关联模块一眼聚成视觉块 */}
            {layout.clusters.map((cluster) => {
              const isBranchActive = focusSets.branchId === cluster.branchId;
              return (
                <rect
                  key={`cluster-${cluster.branchId}`}
                  x={cluster.x}
                  y={cluster.y}
                  width={cluster.width}
                  height={cluster.height}
                  rx={16}
                  fill="rgba(24, 24, 27, 0.52)"
                  stroke={cluster.accentColor}
                  strokeOpacity={isBranchActive ? 0.45 : 0.14}
                  strokeWidth={isBranchActive ? 1.3 : 0.9}
                  style={{ transition: 'stroke-opacity 180ms ease' }}
                />
              );
            })}

            {/* 思维导图单父树有机贝塞尔枝干 */}
            {layout.curves.map((curve) => {
              const isPathActive =
                activeNodeId !== null && focusSets.pathCurves.has(curve.id);
              const dimmed =
                (activeNodeId !== null && !isPathActive) ||
                (onlyExpandable &&
                  !layout.questionModuleIds.includes(curve.targetId) &&
                  !layout.questionModuleIds.includes(curve.sourceId));

              return (
                <path
                  key={curve.id}
                  d={curve.pathD}
                  fill="none"
                  stroke={curve.color}
                  strokeWidth={
                    curve.depth === 1
                      ? isPathActive
                        ? 3.2
                        : 2.3
                      : isPathActive
                        ? 2.3
                        : 1.5
                  }
                  strokeLinecap="round"
                  strokeOpacity={dimmed ? 0.2 : isPathActive ? 0.95 : 0.68}
                  style={{ transition: 'stroke-opacity 180ms ease' }}
                />
              );
            })}

            {/* 枝干入点装饰圆点 */}
            {layout.nodes.map((item) => {
              if (item.depth === 0) return null;
              const isLeft = item.side === 'left';
              const cx = isLeft ? item.x + item.width : item.x;
              const cy = item.y + item.bodyHeight / 2;
              const color =
                layout.curves.find((c) => c.targetId === item.id)?.color ?? '#60a5fa';
              return (
                <circle
                  key={`dot-${item.id}`}
                  cx={cx}
                  cy={cy}
                  r={2.5}
                  fill={color}
                  fillOpacity={0.9}
                />
              );
            })}

            {/* 按需浮现的跨分支语义关联虚弧线 */}
            {visibleCrossLinks.map((link) => (
              <g key={`cross-${link.edge.id}`}>
                <path
                  d={link.pathD}
                  fill="none"
                  stroke={link.color}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  strokeOpacity={0.85}
                />
                {link.edge.label && (
                  <g transform={`translate(${link.labelX}, ${link.labelY})`}>
                    <rect
                      x={-24}
                      y={-8}
                      width={48}
                      height={15}
                      rx={5}
                      fill="#09090b"
                      fillOpacity={0.92}
                      stroke={link.color}
                      strokeOpacity={0.55}
                      strokeWidth={0.8}
                    />
                    <text
                      x={0}
                      y={3}
                      textAnchor="middle"
                      fontSize={8.5}
                      fill={link.color}
                      fontWeight={500}
                    >
                      {link.edge.label.slice(0, 4)}
                    </text>
                  </g>
                )}
              </g>
            ))}
          </svg>

          {/* HTML 节点卡片层（含内嵌论据与底部磁吸提问底座） */}
          {layout.nodes.map((item) => {
            const { node, x, y, width, height, bodyHeight, dockHeight, dockedQuestions } =
              item;
            const isTopic = item.depth === 0;
            const isSelected = selectedNodeId === item.id;
            const isHovered = hoveredNodeId === item.id;
            const hasDocked = dockedQuestions.length > 0;
            const hasAdoptedQuestion = dockedQuestions.some(
              (q) => q.status === 'adopted'
            );

            const isFocused =
              activeNodeId === null ||
              focusSets.pathNodes.has(item.id) ||
              focusSets.crossPeerNodes.has(item.id);
            const dimmedByExpandable =
              onlyExpandable && !isTopic && !hasDocked;
            const dimmed = (!isFocused && activeNodeId !== null) || dimmedByExpandable;

            const theme = NODE_CARD_THEME[node.relation] ?? NODE_CARD_THEME.outline;
            const hasChildren = item.childIds.length > 0;
            const firstQ = dockedQuestions[0];

            return (
              <div
                key={item.id}
                data-mindmap-interactive="true"
                role="button"
                tabIndex={0}
                onMouseEnter={() => setHoveredNodeId(item.id)}
                onMouseLeave={() =>
                  setHoveredNodeId((cur) => (cur === item.id ? null : cur))
                }
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedNodeId((prev) => (prev === item.id ? null : item.id));
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (!isTopic || node.evidenceMs > 0) {
                    handleJumpToMs(node.evidenceMs);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedNodeId((prev) => (prev === item.id ? null : item.id));
                  }
                }}
                style={{
                  left: `${x}px`,
                  top: `${y}px`,
                  width: `${width}px`,
                  height: `${height}px`,
                  opacity: dimmed ? 0.24 : 1,
                }}
                className={`absolute z-10 rounded-xl border transition-all duration-150 cursor-pointer ${
                  isTopic
                    ? 'border-cyan-400/75 bg-gradient-to-br from-cyan-950/90 via-slate-900/95 to-indigo-950/85 shadow-[0_0_24px_rgba(34,211,238,0.18)] hover:border-cyan-300'
                    : `${theme.card} shadow-sm`
                } ${isSelected ? 'ring-2 ring-blue-400/85' : isHovered ? 'ring-1 ring-white/25' : ''}`}
              >
                <div className="w-full h-full rounded-xl overflow-hidden flex flex-col">
                  {/* 模块本体区 */}
                  <div
                    style={{ height: `${bodyHeight}px` }}
                    className={`relative flex flex-col justify-between shrink-0 ${
                      isTopic ? 'px-3 py-2.5 text-center' : 'pl-2.5 pr-2 py-2'
                    }`}
                  >
                    {!isTopic && (
                      <span
                        aria-hidden="true"
                        className={`absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r ${theme.accent}`}
                      />
                    )}

                    {isTopic ? (
                      <>
                        <div className="flex items-center justify-center gap-1.5">
                          <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 border border-cyan-400/45 text-cyan-200 text-[9px] font-semibold">
                            核心主题
                          </span>
                          {!showDockedQuestions && hasDocked && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-500/20 border border-amber-400/50 text-amber-200 text-[8.5px] font-semibold">
                              <Sparkles className="w-2.5 h-2.5" />
                              <span>{dockedQuestions.length}</span>
                            </span>
                          )}
                        </div>
                        <div className="text-[12.5px] font-bold leading-[17px] text-zinc-50 line-clamp-3">
                          {node.title}
                        </div>
                        <div className="text-[9px] text-cyan-200/75">
                          {item.childIds.length} 条主脉络
                        </div>
                      </>
                    ) : (
                      <>
                        {/* 顶行：关系标签 + 反复次数 + 时间戳 / 紧凑提问角标 */}
                        <div className="flex items-center justify-between gap-1">
                          <div className="flex items-center gap-1 min-w-0">
                            <span
                              className={`px-1.5 py-0.5 rounded border text-[8.5px] font-medium truncate max-w-[84px] ${
                                RELATION_BADGE_STYLE[node.relation]
                              }`}
                            >
                              {node.relationLabel}
                            </span>
                            {node.isRecurring && (node.occurrenceCount ?? 0) >= 2 && (
                              <span className="px-1 py-0.5 rounded bg-indigo-500/25 border border-indigo-400/50 text-indigo-200 text-[8px] font-medium shrink-0">
                                ×{node.occurrenceCount}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            {!showDockedQuestions && hasDocked && (
                              <span
                                title={`已吸附 ${dockedQuestions.length} 条提问建议`}
                                className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded-full bg-amber-500/25 border border-amber-400/60 text-amber-200 text-[8px] font-semibold"
                              >
                                <Sparkles className="w-2 h-2" />
                                <span>{dockedQuestions.length}</span>
                              </span>
                            )}
                            {node.evidenceMs > 0 && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleJumpToMs(node.evidenceMs);
                                }}
                                className="text-[8.5px] font-mono text-sky-300 hover:underline cursor-pointer"
                              >
                                [{formatLiveMmSs(node.evidenceMs)}]
                              </button>
                            )}
                          </div>
                        </div>

                        {/* 模块标题 */}
                        <div className="text-[11px] font-medium leading-[16px] text-zinc-100 line-clamp-2">
                          {node.title}
                        </div>

                        {/* 内嵌论据支点（零间距直连呈现） */}
                        {item.inlineSupport && (
                          <div className="mt-1 pt-1 border-t border-white/10 text-[10px] leading-[14px] text-indigo-200/90 line-clamp-2">
                            <span className="text-indigo-300 font-semibold mr-1">论据:</span>
                            {item.inlineSupport.text}
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {/* 零间距磁吸提问底座 */}
                  {showDockedQuestions && dockHeight > 0 && firstQ && (
                    <div
                      style={{ height: `${dockHeight}px` }}
                      className="border-t border-amber-400/40 bg-gradient-to-r from-amber-950/85 via-amber-950/55 to-zinc-950/85 px-2.5 py-1.5 flex flex-col justify-between shrink-0"
                    >
                      <div className="flex items-center justify-between gap-1 text-[8.5px]">
                        <span className="inline-flex items-center gap-1 text-amber-300 font-semibold truncate">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                          <span className="truncate">{firstQ.reason}</span>
                        </span>
                        <div className="flex items-center gap-1 shrink-0">
                          {hasAdoptedQuestion && (
                            <span className="px-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-medium">
                              ✓ 已问
                            </span>
                          )}
                          {dockedQuestions.length > 1 && (
                            <span className="px-1 rounded bg-amber-500/20 text-amber-200 font-mono">
                              +{dockedQuestions.length - 1}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-[10.5px] leading-[15px] text-amber-100 line-clamp-2">
                        {firstQ.text}
                      </div>
                    </div>
                  )}
                </div>

                {/* 外侧分支折叠/展开小圆钮 */}
                {!isTopic && hasChildren && (
                  <button
                    type="button"
                    data-mindmap-interactive="true"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(item.id);
                    }}
                    style={{ top: `${Math.max(10, bodyHeight / 2 - 9)}px` }}
                    title={item.isCollapsed ? '展开子模块' : '折叠子模块'}
                    className={`absolute ${
                      item.side === 'left' ? '-left-2.5' : '-right-2.5'
                    } w-5 h-5 rounded-full border text-[9px] font-mono font-bold flex items-center justify-center cursor-pointer transition shadow-sm ${
                      item.isCollapsed
                        ? 'bg-cyan-500/25 border-cyan-400/70 text-cyan-200'
                        : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-100 hover:border-zinc-500'
                    }`}
                  >
                    {item.isCollapsed ? `+${item.hiddenDescendantCount}` : '−'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 精简色彩图例与交互提示 */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[10px] text-zinc-400 shrink-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-cyan-400" />
            <span>中心主题</span>
          </span>
          {(
            Object.entries(NODE_CARD_THEME) as Array<
              [LogicRelationType, (typeof NODE_CARD_THEME)[LogicRelationType]]
            >
          ).map(([rel, cfg]) => (
            <span key={rel} className="inline-flex items-center gap-1">
              <span className={`w-2 h-2 rounded-sm ${cfg.dot}`} />
              <span>{cfg.label}</span>
            </span>
          ))}
          <span className="inline-flex items-center gap-1 text-amber-300 font-medium">
            <span className="w-2.5 h-2 rounded-sm border border-amber-400/70 bg-amber-500/35" />
            <span>磁吸提问底座</span>
          </span>
        </div>
        <span className="text-[9.5px] text-zinc-500 hidden sm:inline">
          拖拽平移 · Ctrl/Cmd+滚轮缩放 · 双击模块定位原文 · 悬停查看跨支关联
        </span>
      </div>

      {/* 选中节点详情与吸附提问快捷操作面板 */}
      {selectedItem && (
        <div
          className={`rounded-lg border p-2.5 text-xs space-y-2 ${
            selectedItem.dockedQuestions.length > 0
              ? 'border-amber-500/45 bg-amber-950/15'
              : 'border-zinc-800 bg-zinc-900/80'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={`px-1.5 py-0.5 rounded border text-[10px] ${
                  selectedItem.depth === 0
                    ? 'bg-cyan-500/20 text-cyan-200 border-cyan-400/50'
                    : RELATION_BADGE_STYLE[selectedItem.node.relation]
                }`}
              >
                {selectedItem.node.relationLabel}
              </span>
              {selectedItem.node.isRecurring && (
                <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 border border-indigo-400/40 text-indigo-200 text-[10px]">
                  {selectedItem.node.occurrenceCount &&
                  selectedItem.node.occurrenceCount >= 2
                    ? `跨时间反复体现 ×${selectedItem.node.occurrenceCount}`
                    : '核心总结观点'}
                </span>
              )}
              {selectedItem.node.speakerName && (
                <span className="text-[10px] text-zinc-400">
                  发言人：{selectedItem.node.speakerName}
                </span>
              )}
            </div>

            {selectedItem.node.evidenceMs > 0 && (
              <button
                type="button"
                onClick={() => handleJumpToMs(selectedItem.node.evidenceMs)}
                className="inline-flex items-center gap-1 text-[11px] font-mono text-blue-400 hover:underline cursor-pointer"
              >
                <span>定位原文 [{formatLiveMmSs(selectedItem.node.evidenceMs)}]</span>
                <ArrowRight className="w-3 h-3" />
              </button>
            )}
          </div>

          <div className="text-zinc-100 font-medium leading-relaxed">
            {selectedItem.node.title}
          </div>

          {selectedItem.inlineSupport && (
            <div className="rounded-md border border-indigo-500/30 bg-indigo-950/25 px-2.5 py-1.5 text-[11px] text-indigo-200">
              <strong className="text-indigo-300 mr-1">内嵌论据：</strong>
              {selectedItem.inlineSupport.text}
            </div>
          )}

          {selectedItem.node.detail &&
            selectedItem.node.detail !== selectedItem.inlineSupport?.text &&
            selectedItem.node.detail !== selectedItem.node.questionHint && (
              <div className="text-[11px] text-zinc-400">{selectedItem.node.detail}</div>
            )}

          {/* 跨分支关联快捷跳转芯片 */}
          {selectedCrossPeers.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
              <span className="text-zinc-400">跨支关联：</span>
              {selectedCrossPeers.map((peer) => (
                <button
                  key={`${peer.node.id}-${peer.label}`}
                  type="button"
                  onClick={() => setSelectedNodeId(peer.node.id)}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-950/80 hover:border-zinc-500 text-zinc-200 cursor-pointer transition"
                >
                  <span style={{ color: peer.color }}>{peer.label}</span>
                  <span className="text-zinc-500">→</span>
                  <span className="truncate max-w-[160px]">{peer.node.node.title}</span>
                </button>
              ))}
            </div>
          )}

          {/* 吸附在该模块上的提问建议清单 */}
          {selectedItem.dockedQuestions.length > 0 && (
            <div className="space-y-1.5 pt-1">
              {selectedItem.dockedQuestions.map((q) => (
                <div
                  key={q.id}
                  className="rounded-md border border-amber-500/35 bg-amber-500/10 px-2.5 py-2 text-[11px] space-y-1.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-1.5 text-amber-100">
                      <Sparkles className="w-3.5 h-3.5 text-amber-300 shrink-0 mt-0.5" />
                      <div>
                        <span className="px-1 py-0.2 rounded bg-amber-500/25 text-amber-200 text-[9.5px] font-semibold mr-1.5">
                          {q.reason}
                        </span>
                        <span className="font-medium leading-relaxed">{q.text}</span>
                      </div>
                    </div>
                    {q.status === 'adopted' && (
                      <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[9.5px] shrink-0">
                        ✓ 已问
                      </span>
                    )}
                  </div>

                  {q.why && (
                    <div className="text-[10px] text-amber-200/75 pl-5">{q.why}</div>
                  )}

                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleCopyQuestion(q)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-200 cursor-pointer transition"
                    >
                      <Copy className="w-2.5 h-2.5" />
                      <span>{copiedQuestionId === q.id ? '已复制' : '复制'}</span>
                    </button>
                    {q.questionId && onQuestionAction && q.status !== 'adopted' && (
                      <>
                        <button
                          type="button"
                          onClick={() => onQuestionAction(q.questionId!, 'dismissed')}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-400 cursor-pointer transition"
                        >
                          <X className="w-2.5 h-2.5" />
                          <span>忽略</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onQuestionAction(q.questionId!, 'adopted')}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-600/80 hover:bg-emerald-500 text-[10px] text-white cursor-pointer transition"
                        >
                          <Check className="w-2.5 h-2.5" />
                          <span>已问</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
