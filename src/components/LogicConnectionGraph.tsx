import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Clock,
  HelpCircle,
  Layers,
  LayoutGrid,
  Maximize2,
  Minimize2,
  MoveHorizontal,
  Sparkles,
} from 'lucide-react';
import {
  LogicConnectionMap,
  LogicGraphEdge,
  LogicGraphEdgeRelation,
  LogicGraphNode,
  LogicRelationType,
} from '../engine/liveSpeechAnalytics';
import { formatLiveMmSs } from '../engine/liveMinutesExporter';

interface LogicConnectionGraphProps {
  logicMap: LogicConnectionMap;
  onJumpToMs: (ms: number) => void;
}

const NODE_H = 68;
const H_GAP = 36;
const ROW_GAP = 54;
const PAD_X = 24;
const GLOBAL_HEADER_H = 22;
const TOP_ARC_PAD = 30;
const LANE_GAP = 66;
const TIMELINE_HEADER_H = 20;
const TIMELINE_AXIS_OFFSET = 18;
const BOTTOM_ARC_PAD = 42;

const RELATION_BADGE_STYLE: Record<LogicRelationType, string> = {
  viewpoint: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
  story: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
  causal: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  contrast: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  progression: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
  example: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40',
  conclusion: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  outline: 'bg-zinc-700/50 text-zinc-300 border-zinc-600/60',
};

const EDGE_COLOR: Record<LogicGraphEdgeRelation, string> = {
  topic_link: '#38bdf8',
  viewpoint: '#60a5fa',
  story: '#c084fc',
  support_of: '#818cf8',
  example: '#818cf8',
  causal: '#34d399',
  contrast: '#fbbf24',
  progression: '#22d3ee',
  conclusion: '#fb7185',
  echo: '#a78bfa',
  sequence: '#64748b',
  outline: '#71717a',
};

type Side = 'top' | 'bottom' | 'left' | 'right';

interface PositionedNode {
  node: LogicGraphNode;
  lane: 'global' | 'timeline';
  row: number; // 全局绝对行号，用于路由判断
  col: number;
  x: number;
  y: number;
}

interface RoutedEdge {
  edge: LogicGraphEdge;
  pathD: string;
  labelX: number;
  labelY: number;
  color: string;
}

interface TimelineRowAxis {
  row: number;
  axisY: number;
  startX: number;
  endX: number;
  nodes: PositionedNode[];
}

function cubicPointAt(
  p0: number,
  c1: number,
  c2: number,
  p3: number,
  t: number
): number {
  const mt = 1 - t;
  return (
    mt * mt * mt * p0 +
    3 * mt * mt * t * c1 +
    3 * mt * t * t * c2 +
    t * t * t * p3
  );
}

export const LogicConnectionGraph: React.FC<LogicConnectionGraphProps> = ({
  logicMap,
  onJumpToMs,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(680);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [onlyExpandable, setOnlyExpandable] = useState(false);
  const [layoutMode, setLayoutMode] = useState<'fit' | 'linear'>('fit');
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen]);

  const handleJumpToMs = (ms: number) => {
    if (isFullscreen) setIsFullscreen(false);
    onJumpToMs(ms);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 120) setContainerWidth(w);
    };
    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    const rawNodes = logicMap.nodes;
    if (rawNodes.length === 0) {
      return {
        positioned: [] as PositionedNode[],
        routedEdges: [] as RoutedEdge[],
        nodeById: new Map<string, PositionedNode>(),
        width: containerWidth,
        height: 200,
        nodeW: 164,
        hasGlobal: false,
        hasTimeline: false,
        globalBandTop: 0,
        timelineBandTop: 0,
        timelineRowAxes: [] as TimelineRowAxis[],
        timelineFlowPath: '',
      };
    }

    const isGlobalNode = (n: LogicGraphNode): boolean => {
      if (n.lane) return n.lane === 'global';
      return n.kind === 'topic' || n.kind === 'outline' || Boolean(n.isRecurring);
    };

    const globalNodes = rawNodes.filter(isGlobalNode);
    const timelineAll = rawNodes.filter((n) => !isGlobalNode(n));

    const globalOrder: Record<string, number> = {
      topic: 0,
      viewpoint: 1,
      outline: 2,
    };
    const sortedGlobal = [...globalNodes].sort((a, b) => {
      const oa = globalOrder[a.kind] ?? 3;
      const ob = globalOrder[b.kind] ?? 3;
      if (oa !== ob) return oa - ob;
      if ((b.occurrenceCount ?? 0) !== (a.occurrenceCount ?? 0)) {
        return (b.occurrenceCount ?? 0) - (a.occurrenceCount ?? 0);
      }
      return a.evidenceMs - b.evidenceMs;
    });

    const kindTieOrder: Record<string, number> = {
      viewpoint: 0,
      support: 1,
      story: 2,
      utterance: 3,
    };
    const sortedTimeline = [...timelineAll].sort((a, b) => {
      if (a.evidenceMs !== b.evidenceMs) return a.evidenceMs - b.evidenceMs;
      return (kindTieOrder[a.kind] ?? 9) - (kindTieOrder[b.kind] ?? 9);
    });

    const hasGlobal = sortedGlobal.length > 0;
    const hasTimeline = sortedTimeline.length > 0;

    // 计算一屏自适应列数与卡片宽度
    const usableW = Math.max(320, containerWidth - PAD_X * 2);
    const maxColsFit = Math.max(
      2,
      Math.min(5, Math.floor((usableW + H_GAP) / (148 + H_GAP)))
    );

    const nodeW =
      layoutMode === 'fit'
        ? Math.min(
            188,
            Math.max(138, Math.floor((usableW - (maxColsFit - 1) * H_GAP) / maxColsFit))
          )
        : 176;

    const colsPerRow =
      layoutMode === 'fit'
        ? maxColsFit
        : Math.max(sortedGlobal.length, sortedTimeline.length, 1);

    const chunkRows = <T,>(items: T[], cols: number): T[][] => {
      if (items.length === 0) return [];
      const res: T[][] = [];
      for (let i = 0; i < items.length; i += cols) {
        res.push(items.slice(i, i + cols));
      }
      return res;
    };

    const globalRows = chunkRows(sortedGlobal, colsPerRow);
    const timelineRows = chunkRows(sortedTimeline, colsPerRow);

    const maxColsUsed = Math.max(
      1,
      ...globalRows.map((r) => r.length),
      ...timelineRows.map((r) => r.length)
    );
    const contentW = maxColsUsed * nodeW + (maxColsUsed - 1) * H_GAP;
    const totalW =
      layoutMode === 'fit'
        ? Math.max(containerWidth, contentW + PAD_X * 2)
        : Math.max(containerWidth, contentW + PAD_X * 2);

    const positioned: PositionedNode[] = [];
    const nodeById = new Map<string, PositionedNode>();

    const globalBandTop = 8;
    let curY = globalBandTop + (hasGlobal ? GLOBAL_HEADER_H + TOP_ARC_PAD : 0);

    let absRow = 0;
    globalRows.forEach((rowNodes, rIdx) => {
      const rowW = rowNodes.length * nodeW + (rowNodes.length - 1) * H_GAP;
      const startX = PAD_X + Math.max(0, (totalW - PAD_X * 2 - rowW) / 2);
      const y = curY + rIdx * (NODE_H + ROW_GAP);

      rowNodes.forEach((node, colIdx) => {
        const item: PositionedNode = {
          node,
          lane: 'global',
          row: absRow,
          col: colIdx,
          x: startX + colIdx * (nodeW + H_GAP),
          y,
        };
        positioned.push(item);
        nodeById.set(node.id, item);
      });
      absRow += 1;
    });

    if (hasGlobal) {
      curY +=
        globalRows.length * NODE_H +
        Math.max(0, globalRows.length - 1) * ROW_GAP;
    }

    const timelineBandTop = hasGlobal ? curY + LANE_GAP : 8;
    const timelineStartY = hasTimeline
      ? timelineBandTop + TIMELINE_HEADER_H + TIMELINE_AXIS_OFFSET + 6
      : timelineBandTop;

    const timelineRowAxes: TimelineRowAxis[] = [];
    const timelineRowStride = NODE_H + ROW_GAP + 14;

    timelineRows.forEach((rowNodes, rIdx) => {
      const rowW = rowNodes.length * nodeW + (rowNodes.length - 1) * H_GAP;
      const startX =
        layoutMode === 'fit'
          ? PAD_X + Math.max(0, (totalW - PAD_X * 2 - rowW) / 2)
          : PAD_X;
      const y = timelineStartY + rIdx * timelineRowStride;
      const axisY = y - TIMELINE_AXIS_OFFSET;
      const rowPositioned: PositionedNode[] = [];

      rowNodes.forEach((node, colIdx) => {
        const item: PositionedNode = {
          node,
          lane: 'timeline',
          row: absRow,
          col: colIdx,
          x: startX + colIdx * (nodeW + H_GAP),
          y,
        };
        positioned.push(item);
        rowPositioned.push(item);
        nodeById.set(node.id, item);
      });

      timelineRowAxes.push({
        row: absRow,
        axisY,
        startX: Math.max(PAD_X, startX - 8),
        endX: Math.min(totalW - PAD_X, startX + rowW + 14),
        nodes: rowPositioned,
      });

      absRow += 1;
    });

    const totalH = hasTimeline
      ? timelineStartY +
        timelineRows.length * NODE_H +
        Math.max(0, timelineRows.length - 1) * (ROW_GAP + 14) +
        BOTTOM_ARC_PAD
      : curY + BOTTOM_ARC_PAD;

    // ===== 边路由与端口分配 =====
    type EndpointSpec = {
      edge: LogicGraphEdge;
      src: PositionedNode;
      dst: PositionedNode;
      srcSide: Side;
      dstSide: Side;
      mode: 'adjacent_lr' | 'arc_top' | 'arc_bottom' | 'vertical';
    };

    const specs: EndpointSpec[] = [];
    for (const edge of logicMap.edges) {
      const src = nodeById.get(edge.source);
      const dst = nodeById.get(edge.target);
      if (!src || !dst) continue;

      if (src.row === dst.row) {
        const colDiff = dst.col - src.col;
        if (colDiff === 1) {
          specs.push({
            edge,
            src,
            dst,
            srcSide: 'right',
            dstSide: 'left',
            mode: 'adjacent_lr',
          });
        } else {
          // 同行跨节点：上泳道走上方弧线，下泳道走下方弧线，绝不穿过中间卡片
          const useTop = src.lane === 'global';
          specs.push({
            edge,
            src,
            dst,
            srcSide: useTop ? 'top' : 'bottom',
            dstSide: useTop ? 'top' : 'bottom',
            mode: useTop ? 'arc_top' : 'arc_bottom',
          });
        }
      } else if (src.row < dst.row) {
        specs.push({
          edge,
          src,
          dst,
          srcSide: 'bottom',
          dstSide: 'top',
          mode: 'vertical',
        });
      } else {
        specs.push({
          edge,
          src,
          dst,
          srcSide: 'top',
          dstSide: 'bottom',
          mode: 'vertical',
        });
      }
    }

    const portBuckets = new Map<
      string,
      Array<{ edgeId: string; peerCenter: number }>
    >();
    const pushPort = (
      nodeId: string,
      side: Side,
      edgeId: string,
      peerCenter: number
    ) => {
      const key = `${nodeId}:${side}`;
      const arr = portBuckets.get(key) ?? [];
      arr.push({ edgeId, peerCenter });
      portBuckets.set(key, arr);
    };

    for (const s of specs) {
      const srcCx = s.src.x + nodeW / 2;
      const srcCy = s.src.y + NODE_H / 2;
      const dstCx = s.dst.x + nodeW / 2;
      const dstCy = s.dst.y + NODE_H / 2;

      pushPort(
        s.src.node.id,
        s.srcSide,
        s.edge.id,
        s.srcSide === 'top' || s.srcSide === 'bottom' ? dstCx : dstCy
      );
      pushPort(
        s.dst.node.id,
        s.dstSide,
        s.edge.id,
        s.dstSide === 'top' || s.dstSide === 'bottom' ? srcCx : srcCy
      );
    }

    const portRatioMap = new Map<string, number>();
    for (const [key, list] of portBuckets.entries()) {
      list.sort((a, b) => a.peerCenter - b.peerCenter);
      const count = list.length;
      list.forEach((item, idx) => {
        const ratio = count === 1 ? 0.5 : 0.22 + (0.56 * idx) / (count - 1);
        portRatioMap.set(`${key}:${item.edgeId}`, ratio);
      });
    }

    const getAnchor = (
      pos: PositionedNode,
      side: Side,
      edgeId: string,
      isTarget: boolean
    ) => {
      const ratio = portRatioMap.get(`${pos.node.id}:${side}:${edgeId}`) ?? 0.5;
      const pad = isTarget ? 1.5 : 0;
      switch (side) {
        case 'top':
          return { x: pos.x + nodeW * ratio, y: pos.y - pad };
        case 'bottom':
          return { x: pos.x + nodeW * ratio, y: pos.y + NODE_H + pad };
        case 'left':
          return { x: pos.x - pad, y: pos.y + NODE_H * ratio };
        case 'right':
          return { x: pos.x + nodeW + pad, y: pos.y + NODE_H * ratio };
      }
    };

    let topArcIdx = 0;
    let bottomArcIdx = 0;
    const routedEdges: RoutedEdge[] = specs.map((s) => {
      const p0 = getAnchor(s.src, s.srcSide, s.edge.id, false);
      const p3 = getAnchor(s.dst, s.dstSide, s.edge.id, true);
      const color = EDGE_COLOR[s.edge.relation] ?? '#94a3b8';

      let pathD = '';
      let labelX = (p0.x + p3.x) / 2;
      let labelY = (p0.y + p3.y) / 2;

      if (s.mode === 'adjacent_lr') {
        const dx = Math.max(12, (p3.x - p0.x) * 0.45);
        const c1x = p0.x + dx;
        const c1y = p0.y;
        const c2x = p3.x - dx;
        const c2y = p3.y;
        pathD = `M ${p0.x} ${p0.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p3.x} ${p3.y}`;
        labelX = cubicPointAt(p0.x, c1x, c2x, p3.x, 0.5);
        labelY = cubicPointAt(p0.y, c1y, c2y, p3.y, 0.5) - 9;
      } else if (s.mode === 'arc_top') {
        const span = Math.abs(s.dst.col - s.src.col);
        const arcLift = Math.min(28, 14 + span * 4 + (topArcIdx % 2) * 6);
        topArcIdx += 1;
        const cy = Math.min(p0.y, p3.y) - arcLift;
        pathD = `M ${p0.x} ${p0.y} C ${p0.x} ${cy}, ${p3.x} ${cy}, ${p3.x} ${p3.y}`;
        labelX = cubicPointAt(p0.x, p0.x, p3.x, p3.x, 0.5);
        labelY = cubicPointAt(p0.y, cy, cy, p3.y, 0.5) - 1;
      } else if (s.mode === 'arc_bottom') {
        const span = Math.abs(s.dst.col - s.src.col);
        const arcDrop = Math.min(34, 16 + span * 5 + (bottomArcIdx % 2) * 7);
        bottomArcIdx += 1;
        const cy = Math.max(p0.y, p3.y) + arcDrop;
        pathD = `M ${p0.x} ${p0.y} C ${p0.x} ${cy}, ${p3.x} ${cy}, ${p3.x} ${p3.y}`;
        labelX = cubicPointAt(p0.x, p0.x, p3.x, p3.x, 0.5);
        labelY = cubicPointAt(p0.y, cy, cy, p3.y, 0.5) + 3;
      } else {
        const dy = Math.max(20, Math.abs(p3.y - p0.y) * 0.45);
        const c1y = s.srcSide === 'bottom' ? p0.y + dy : p0.y - dy;
        const c2y = s.dstSide === 'top' ? p3.y - dy : p3.y + dy;
        pathD = `M ${p0.x} ${p0.y} C ${p0.x} ${c1y}, ${p3.x} ${c2y}, ${p3.x} ${p3.y}`;
        const t = s.src.col % 2 === 0 ? 0.42 : 0.58;
        labelX = cubicPointAt(p0.x, p0.x, p3.x, p3.x, t);
        labelY = cubicPointAt(p0.y, c1y, c2y, p3.y, t);
      }

      return {
        edge: s.edge,
        pathD,
        labelX,
        labelY,
        color,
      };
    });

    return {
      positioned,
      routedEdges,
      nodeById,
      width: totalW,
      height: totalH,
      nodeW,
      hasGlobal,
      hasTimeline,
      globalBandTop,
      timelineBandTop,
      timelineRowAxes,
    };
  }, [logicMap.nodes, logicMap.edges, containerWidth, layoutMode]);

  const selectedNode = selectedNodeId
    ? layout.nodeById.get(selectedNodeId)?.node ?? null
    : null;

  const connectedToSelected = useMemo(() => {
    const ids = new Set<string>();
    const edgeIds = new Set<string>();
    if (!selectedNodeId) return { ids, edgeIds };
    ids.add(selectedNodeId);
    for (const e of logicMap.edges) {
      if (e.source === selectedNodeId || e.target === selectedNodeId) {
        edgeIds.add(e.id);
        ids.add(e.source);
        ids.add(e.target);
      }
    }
    return { ids, edgeIds };
  }, [selectedNodeId, logicMap.edges]);

  const expandableCount = logicMap.expandableNodeIds.length;

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 bg-zinc-950/95 backdrop-blur-sm flex flex-col p-4 sm:p-6 gap-3'
          : 'space-y-2'
      }
    >
      {/* 图谱控制栏 */}
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
          <span className="inline-flex items-center gap-1 text-amber-300 font-medium">
            <Sparkles className="w-3 h-3" />
            <span>可提问 ({expandableCount})</span>
          </span>
          <span className="text-zinc-600">|</span>
          <span>边 {logicMap.edges.length}</span>
          <span className="text-zinc-600">|</span>
          <span className="hidden sm:inline">
            上：核心/反复体现观点 · 下：时间线流转
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="inline-flex rounded border border-zinc-700 bg-zinc-900 p-0.5">
            <button
              type="button"
              onClick={() => setLayoutMode('fit')}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] cursor-pointer transition ${
                layoutMode === 'fit'
                  ? 'bg-blue-500/20 text-blue-300 font-medium'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="自适应当前窗口宽度折行总览"
            >
              <LayoutGrid className="w-2.5 h-2.5" />
              <span>一屏总览</span>
            </button>
            <button
              type="button"
              onClick={() => setLayoutMode('linear')}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] cursor-pointer transition ${
                layoutMode === 'linear'
                  ? 'bg-blue-500/20 text-blue-300 font-medium'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="单行横向时间轴（可左右滚动）"
            >
              <MoveHorizontal className="w-2.5 h-2.5" />
              <span>横向长轴</span>
            </button>
          </div>

          {expandableCount > 0 && (
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
          )}

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

      {/* 画布容器 */}
      <div
        ref={containerRef}
        className={`relative rounded-lg border border-zinc-800/80 bg-zinc-950/80 ${
          isFullscreen ? 'flex-1 min-h-0' : ''
        } ${
          layoutMode === 'linear'
            ? isFullscreen
              ? 'overflow-auto'
              : 'overflow-x-auto'
            : isFullscreen
              ? 'overflow-y-auto overflow-x-hidden'
              : 'overflow-hidden'
        }`}
      >
        <div
          className="relative"
          style={{ width: `${layout.width}px`, height: `${layout.height}px` }}
        >
          {/* 泳道标识 */}
          {layout.hasGlobal && (
            <div
              className="absolute left-3 right-3 flex items-center gap-1.5 text-[10px] font-medium text-cyan-300/80 pointer-events-none"
              style={{ top: `${layout.globalBandTop}px` }}
            >
              <Layers className="w-3 h-3 text-cyan-400" />
              <span>非时间线 · 核心主题与多次体现/总结观点</span>
            </div>
          )}

          {layout.hasTimeline && (
            <div
              className="absolute left-3 right-3 flex items-center gap-1.5 text-[10px] font-medium text-zinc-400 pointer-events-none"
              style={{ top: `${layout.timelineBandTop}px` }}
            >
              <Clock className="w-3 h-3 text-blue-400" />
              <span>时间线 · 线性逻辑流转</span>
            </div>
          )}

          {/* SVG 时间轴与连线层 */}
          <svg
            width={layout.width}
            height={layout.height}
            className="absolute inset-0 pointer-events-none"
          >
            <defs>
              {Object.entries(EDGE_COLOR).map(([rel, color]) => (
                <marker
                  key={rel}
                  id={`logic-arrow-${rel}`}
                  markerWidth="8"
                  markerHeight="8"
                  refX="7"
                  refY="4"
                  orient="auto"
                  markerUnits="userSpaceOnUse"
                >
                  <path d="M0.5,1 L7,4 L0.5,7 Z" fill={color} />
                </marker>
              ))}
              <marker
                id="logic-timeline-axis-arrow"
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <path d="M0.5,0.8 L6,3.5 L0.5,6.2 Z" fill="#3f3f46" />
              </marker>
            </defs>

            {/* 每行时间线顶部横向刻度轴 */}
            {layout.timelineRowAxes.map((rowAxis) => (
              <g key={`axis-${rowAxis.row}`}>
                <line
                  x1={rowAxis.startX}
                  y1={rowAxis.axisY}
                  x2={rowAxis.endX}
                  y2={rowAxis.axisY}
                  stroke="#27272a"
                  strokeWidth={1.1}
                  markerEnd="url(#logic-timeline-axis-arrow)"
                />
                {rowAxis.nodes.map((item) => {
                  const cx = item.x + layout.nodeW / 2;
                  return (
                    <g key={`tick-${item.node.id}`}>
                      <circle cx={cx} cy={rowAxis.axisY} r={2.5} fill="#3b82f6" />
                      <text
                        x={cx}
                        y={rowAxis.axisY - 5}
                        textAnchor="middle"
                        fontSize={8.5}
                        fontFamily="monospace"
                        fill="#93c5fd"
                      >
                        {formatLiveMmSs(item.node.evidenceMs)}
                      </text>
                    </g>
                  );
                })}
              </g>
            ))}

            {/* 逻辑连接边 */}
            {layout.routedEdges.map(({ edge, pathD, labelX, labelY, color }) => {
              const srcPos = layout.nodeById.get(edge.source);
              const dstPos = layout.nodeById.get(edge.target);
              const isHighlighted = selectedNodeId
                ? connectedToSelected.edgeIds.has(edge.id)
                : onlyExpandable
                  ? Boolean(
                      srcPos?.node.expandableForQuestion ||
                        dstPos?.node.expandableForQuestion
                    )
                  : true;

              const isFocused =
                selectedNodeId !== null && connectedToSelected.edgeIds.has(edge.id);

              return (
                <g
                  key={edge.id}
                  style={{
                    opacity: isHighlighted ? 0.94 : 0.16,
                    transition: 'opacity 180ms ease',
                  }}
                >
                  <path
                    d={pathD}
                    fill="none"
                    stroke={color}
                    strokeWidth={isFocused ? 2.1 : 1.4}
                    strokeDasharray={edge.dashed ? '4 3' : undefined}
                    markerEnd={`url(#logic-arrow-${edge.relation})`}
                  />
                  {edge.label && (
                    <g transform={`translate(${labelX}, ${labelY})`}>
                      <rect
                        x={-20}
                        y={-7}
                        width={40}
                        height={13}
                        rx={4}
                        fill="#09090b"
                        fillOpacity={0.92}
                        stroke={color}
                        strokeOpacity={0.45}
                        strokeWidth={0.7}
                      />
                      <text
                        x={0}
                        y={2.5}
                        textAnchor="middle"
                        fontSize={8}
                        fill={color}
                        fontWeight={500}
                      >
                        {edge.label.slice(0, 4)}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>

          {/* 节点卡片层 */}
          {layout.positioned.map(({ node, x, y }) => {
            const isSelected = selectedNodeId === node.id;
            const isTopic = node.kind === 'topic';
            const dimmed =
              (selectedNodeId !== null && !connectedToSelected.ids.has(node.id)) ||
              (onlyExpandable && !node.expandableForQuestion && !isTopic);

            const borderCls = isTopic
              ? 'border-cyan-500/50 bg-cyan-950/40'
              : node.expandableForQuestion
                ? 'border-amber-400/80 bg-amber-950/25 shadow-[0_0_12px_rgba(245,158,11,0.18)]'
                : node.isRecurring
                  ? 'border-indigo-500/55 bg-indigo-950/25'
                  : 'border-zinc-800 bg-zinc-900/90 hover:border-zinc-600';

            return (
              <div
                key={node.id}
                role="button"
                tabIndex={0}
                onClick={() =>
                  setSelectedNodeId((prev) => (prev === node.id ? null : node.id))
                }
                onDoubleClick={() => {
                  if (node.evidenceMs > 0 || node.kind !== 'topic') {
                    handleJumpToMs(node.evidenceMs);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
                  }
                }}
                style={{
                  left: `${x}px`,
                  top: `${y}px`,
                  width: `${layout.nodeW}px`,
                  height: `${NODE_H}px`,
                  opacity: dimmed ? 0.28 : 1,
                }}
                className={`absolute rounded-lg border px-2 py-1.5 flex flex-col justify-between cursor-pointer transition-all select-none ${borderCls} ${
                  isSelected ? 'ring-2 ring-blue-400/70' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1 min-w-0">
                    <span
                      className={`px-1 py-0.5 rounded border text-[8.5px] font-medium truncate max-w-[78px] ${
                        isTopic
                          ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                          : RELATION_BADGE_STYLE[node.relation]
                      }`}
                    >
                      {node.relationLabel}
                    </span>
                    {node.isRecurring && (node.occurrenceCount ?? 0) >= 2 && (
                      <span className="px-1 py-0.5 rounded bg-indigo-500/20 border border-indigo-400/40 text-indigo-200 text-[8px] font-medium shrink-0">
                        ×{node.occurrenceCount}
                      </span>
                    )}
                  </div>

                  {node.expandableForQuestion ? (
                    <span
                      title={node.questionHint || node.expandReason}
                      className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded-full bg-amber-500/20 border border-amber-400/60 text-amber-200 text-[8.5px] font-semibold shrink-0"
                    >
                      <Sparkles className="w-2.5 h-2.5" />
                      <span>可提问</span>
                    </span>
                  ) : (
                    !isTopic && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleJumpToMs(node.evidenceMs);
                        }}
                        className="text-[8.5px] font-mono text-blue-400 hover:underline cursor-pointer shrink-0"
                      >
                        [{formatLiveMmSs(node.evidenceMs)}]
                      </button>
                    )
                  )}
                </div>

                <div className="text-[10.5px] font-medium text-zinc-100 leading-tight line-clamp-2">
                  {node.title}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 选中节点详情与提问拓展提示条 */}
      {selectedNode && (
        <div
          className={`rounded-lg border p-2.5 text-xs space-y-1.5 ${
            selectedNode.expandableForQuestion
              ? 'border-amber-500/45 bg-amber-950/20'
              : 'border-zinc-800 bg-zinc-900/80'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span
                className={`px-1.5 py-0.5 rounded border text-[10px] ${
                  RELATION_BADGE_STYLE[selectedNode.relation]
                }`}
              >
                {selectedNode.relationLabel}
              </span>
              {selectedNode.isRecurring && (
                <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 border border-indigo-400/40 text-indigo-200 text-[10px]">
                  {selectedNode.occurrenceCount && selectedNode.occurrenceCount >= 2
                    ? `跨时间反复体现 ×${selectedNode.occurrenceCount}`
                    : '核心总结观点'}
                </span>
              )}
              {selectedNode.speakerName && (
                <span className="text-[10px] text-zinc-400">
                  发言人：{selectedNode.speakerName}
                </span>
              )}
              {selectedNode.expandReason && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200 text-[10px]">
                  <HelpCircle className="w-3 h-3" />
                  <span>{selectedNode.expandReason}</span>
                </span>
              )}
            </div>

            {selectedNode.kind !== 'topic' && (
              <button
                type="button"
                onClick={() => handleJumpToMs(selectedNode.evidenceMs)}
                className="inline-flex items-center gap-1 text-[11px] font-mono text-blue-400 hover:underline cursor-pointer"
              >
                <span>定位原文 [{formatLiveMmSs(selectedNode.evidenceMs)}]</span>
                <ArrowRight className="w-3 h-3" />
              </button>
            )}
          </div>

          <div className="text-zinc-100 font-medium">{selectedNode.title}</div>
          {selectedNode.detail && (
            <div className="text-[11px] text-zinc-400">{selectedNode.detail}</div>
          )}
          {selectedNode.questionHint && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200 flex items-start gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-300 shrink-0 mt-0.5" />
              <span>
                <strong>提问拓展建议：</strong>
                {selectedNode.questionHint}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
