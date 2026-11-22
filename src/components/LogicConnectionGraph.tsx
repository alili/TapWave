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
    card: 'border-blue-500/55 bg-blue-950/45 hover:border-blue-400/80',
    accent: 'bg-blue-400',
    label: '观点',
    dot: 'bg-blue-400',
  },
  story: {
    card: 'border-purple-500/55 bg-purple-950/45 hover:border-purple-400/80',
    accent: 'bg-purple-400',
    label: '案例',
    dot: 'bg-purple-400',
  },
  causal: {
    card: 'border-emerald-500/55 bg-emerald-950/45 hover:border-emerald-400/80',
    accent: 'bg-emerald-400',
    label: '因果',
    dot: 'bg-emerald-400',
  },
  contrast: {
    card: 'border-orange-500/55 bg-orange-950/45 hover:border-orange-400/80',
    accent: 'bg-orange-400',
    label: '转折',
    dot: 'bg-orange-400',
  },
  progression: {
    card: 'border-teal-500/55 bg-teal-950/45 hover:border-teal-400/80',
    accent: 'bg-teal-400',
    label: '递进',
    dot: 'bg-teal-400',
  },
  example: {
    card: 'border-indigo-500/55 bg-indigo-950/45 hover:border-indigo-400/80',
    accent: 'bg-indigo-400',
    label: '举例',
    dot: 'bg-indigo-400',
  },
  conclusion: {
    card: 'border-rose-500/55 bg-rose-950/45 hover:border-rose-400/80',
    accent: 'bg-rose-400',
    label: '结论',
    dot: 'bg-rose-400',
  },
  outline: {
    card: 'border-slate-500/55 bg-slate-900/75 hover:border-slate-400/80',
    accent: 'bg-slate-400',
    label: '提纲',
    dot: 'bg-slate-400',
  },
};

const EDGE_COLOR: Record<LogicGraphEdgeRelation, string> = {
  topic_link: '#38bdf8',
  viewpoint: '#60a5fa',
  story: '#c084fc',
  support_of: '#818cf8',
  example: '#818cf8',
  causal: '#34d399',
  contrast: '#fb923c',
  progression: '#2dd4bf',
  conclusion: '#fb7185',
  echo: '#a78bfa',
  sequence: '#64748b',
  outline: '#94a3b8',
  question_suggest: '#f59e0b',
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
      question: 3,
    };
    const sortedGlobal = [...globalNodes].sort((a, b) => {
      const oa = globalOrder[a.kind] ?? 4;
      const ob = globalOrder[b.kind] ?? 4;
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
      question: 4,
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

    // ===== 时间轴柔性曲线（粗线、彩色、支持微弧与跨行 S 形回环） =====
    let timelineFlowPath = '';
    if (timelineRowAxes.length > 0) {
      const segs: string[] = [];
      timelineRowAxes.forEach((rowAxis, rIdx) => {
        const pts = rowAxis.nodes.map((n) => ({
          x: n.x + nodeW / 2,
          y: rowAxis.axisY,
        }));
        if (pts.length === 0) return;

        const rowStartX = Math.min(rowAxis.startX, pts[0].x - 12);
        const rowEndX = Math.max(rowAxis.endX, pts[pts.length - 1].x + 12);

        if (rIdx === 0) {
          segs.push(`M ${rowStartX.toFixed(1)} ${rowAxis.axisY.toFixed(1)}`);
          segs.push(
            `Q ${((rowStartX + pts[0].x) / 2).toFixed(1)} ${(rowAxis.axisY - 4).toFixed(1)}, ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`
          );
        }

        // 同行节点间采用柔性微弧贝塞尔曲线连接，而非死板直线
        for (let i = 0; i < pts.length - 1; i += 1) {
          const a = pts[i];
          const b = pts[i + 1];
          const midX = (a.x + b.x) / 2;
          const arch = i % 2 === 0 ? -5.5 : 4.5;
          segs.push(
            `C ${(a.x + (b.x - a.x) * 0.35).toFixed(1)} ${(a.y + arch).toFixed(1)}, ${(a.x + (b.x - a.x) * 0.65).toFixed(1)} ${(b.y + arch).toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
          );
          void midX;
        }

        const lastPt = pts[pts.length - 1];
        if (rIdx === timelineRowAxes.length - 1) {
          // 末行收尾延伸
          segs.push(
            `Q ${((lastPt.x + rowEndX) / 2).toFixed(1)} ${(lastPt.y - 3).toFixed(1)}, ${rowEndX.toFixed(1)} ${lastPt.y.toFixed(1)}`
          );
        } else {
          // 换行：从本行末节点通过右侧→行间通道→左侧优雅 S 形回环连接到下一行首节点
          const nextRow = timelineRowAxes[rIdx + 1];
          const nextFirst = nextRow.nodes[0];
          if (nextFirst) {
            const nextPt = {
              x: nextFirst.x + nodeW / 2,
              y: nextRow.axisY,
            };
            const turnRightX = Math.min(totalW - 8, Math.max(lastPt.x + 26, rowEndX + 6));
            const turnLeftX = Math.max(8, Math.min(nextPt.x - 26, nextRow.startX - 6));
            const midRowY = (lastPt.y + NODE_H + TIMELINE_AXIS_OFFSET + nextPt.y) / 2;
            segs.push(
              `C ${turnRightX.toFixed(1)} ${lastPt.y.toFixed(1)}, ${turnRightX.toFixed(1)} ${midRowY.toFixed(1)}, ${((turnRightX + turnLeftX) / 2).toFixed(1)} ${midRowY.toFixed(1)}`
            );
            segs.push(
              `C ${turnLeftX.toFixed(1)} ${midRowY.toFixed(1)}, ${turnLeftX.toFixed(1)} ${nextPt.y.toFixed(1)}, ${nextPt.x.toFixed(1)} ${nextPt.y.toFixed(1)}`
            );
          }
        }
      });
      timelineFlowPath = segs.join(' ');
    }

    // ===== 边路由与端口分配（支持树状发散 + 跨多行防遮挡绕行） =====
    type EndpointSpec = {
      edge: LogicGraphEdge;
      src: PositionedNode;
      dst: PositionedNode;
      srcSide: Side;
      dstSide: Side;
      mode: 'adjacent_lr' | 'arc_top' | 'arc_bottom' | 'vertical' | 'detour';
    };

    const specs: EndpointSpec[] = [];
    for (const edge of logicMap.edges) {
      const src = nodeById.get(edge.source);
      const dst = nodeById.get(edge.target);
      if (!src || !dst) continue;

      const rowDiff = Math.abs(dst.row - src.row);
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
      } else if (rowDiff === 1) {
        specs.push({
          edge,
          src,
          dst,
          srcSide: src.row < dst.row ? 'bottom' : 'top',
          dstSide: src.row < dst.row ? 'top' : 'bottom',
          mode: 'vertical',
        });
      } else {
        // 跨多行连线：走安全绕行通道，不穿越中间行卡片
        specs.push({
          edge,
          src,
          dst,
          srcSide: src.row < dst.row ? 'bottom' : 'top',
          dstSide: src.row < dst.row ? 'top' : 'bottom',
          mode: 'detour',
        });
      }
    }

    // 统计一对多垂直发散（树状扇出），便于共用树干出口并向子节点柔性发散
    const fanOutGroups = new Map<string, EndpointSpec[]>();
    for (const s of specs) {
      if (s.mode === 'vertical') {
        const k = `${s.src.node.id}:${s.srcSide}`;
        const list = fanOutGroups.get(k) ?? [];
        list.push(s);
        fanOutGroups.set(k, list);
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
      const isTreeFanOut = (fanOutGroups.get(key)?.length ?? 0) > 1;
      list.forEach((item, idx) => {
        // 树状发散时将出口收束在节点底/顶部中间区域，形成清晰的树干发散感
        const ratio =
          count === 1
            ? 0.5
            : isTreeFanOut
              ? 0.42 + (0.16 * idx) / (count - 1)
              : 0.22 + (0.56 * idx) / (count - 1);
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

    // 计算可用垂直通道（左外侧、列间缝隙、右外侧），用于跨多行连线避障
    const candidateGutters: number[] = [Math.max(10, PAD_X * 0.48)];
    for (let c = 0; c < maxColsUsed - 1; c += 1) {
      const leftBound = PAD_X + c * (nodeW + H_GAP) + nodeW;
      candidateGutters.push(leftBound + H_GAP / 2);
    }
    candidateGutters.push(Math.min(totalW - 10, totalW - PAD_X * 0.48));

    const pickClearGutterX = (
      minRow: number,
      maxRow: number,
      preferX: number,
      detourOffsetIdx: number
    ): number => {
      const middleNodes = positioned.filter(
        (n) => n.row > minRow && n.row < maxRow
      );
      const clear = candidateGutters.filter((gx) =>
        middleNodes.every((n) => gx < n.x - 6 || gx > n.x + nodeW + 6)
      );
      const pool = clear.length > 0 ? clear : [candidateGutters[0], candidateGutters[candidateGutters.length - 1]];
      const sorted = [...pool].sort(
        (a, b) => Math.abs(a - preferX) - Math.abs(b - preferX)
      );
      const base = sorted[0] ?? preferX;
      // 多条绕行线轻微错开，避免重叠
      const jitter = ((detourOffsetIdx % 3) - 1) * 5;
      return Math.max(8, Math.min(totalW - 8, base + jitter));
    };

    let topArcIdx = 0;
    let bottomArcIdx = 0;
    let detourIdx = 0;
    const routedEdges: RoutedEdge[] = specs.map((s) => {
      const p0 = getAnchor(s.src, s.srcSide, s.edge.id, false);
      const p3 = getAnchor(s.dst, s.dstSide, s.edge.id, true);
      const color = EDGE_COLOR[s.edge.relation] ?? '#94a3b8';

      let pathD = '';
      let labelX = (p0.x + p3.x) / 2;
      let labelY = (p0.y + p3.y) / 2;

      if (s.mode === 'adjacent_lr') {
        const dx = Math.max(14, (p3.x - p0.x) * 0.48);
        const c1x = p0.x + dx;
        const c1y = p0.y;
        const c2x = p3.x - dx;
        const c2y = p3.y;
        pathD = `M ${p0.x} ${p0.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p3.x} ${p3.y}`;
        labelX = cubicPointAt(p0.x, c1x, c2x, p3.x, 0.5);
        labelY = cubicPointAt(p0.y, c1y, c2y, p3.y, 0.5) - 10;
      } else if (s.mode === 'arc_top') {
        const span = Math.abs(s.dst.col - s.src.col);
        const arcLift = Math.min(34, 16 + span * 5 + (topArcIdx % 3) * 6);
        topArcIdx += 1;
        const cy = Math.min(p0.y, p3.y) - arcLift;
        pathD = `M ${p0.x} ${p0.y} C ${p0.x} ${cy}, ${p3.x} ${cy}, ${p3.x} ${p3.y}`;
        labelX = cubicPointAt(p0.x, p0.x, p3.x, p3.x, 0.5);
        labelY = cubicPointAt(p0.y, cy, cy, p3.y, 0.5) - 2;
      } else if (s.mode === 'arc_bottom') {
        const span = Math.abs(s.dst.col - s.src.col);
        const arcDrop = Math.min(40, 18 + span * 6 + (bottomArcIdx % 3) * 7);
        bottomArcIdx += 1;
        const cy = Math.max(p0.y, p3.y) + arcDrop;
        pathD = `M ${p0.x} ${p0.y} C ${p0.x} ${cy}, ${p3.x} ${cy}, ${p3.x} ${p3.y}`;
        labelX = cubicPointAt(p0.x, p0.x, p3.x, p3.x, 0.5);
        labelY = cubicPointAt(p0.y, cy, cy, p3.y, 0.5) + 4;
      } else if (s.mode === 'detour') {
        const minRow = Math.min(s.src.row, s.dst.row);
        const maxRow = Math.max(s.src.row, s.dst.row);
        const preferX = (p0.x + p3.x) / 2;
        const gutterX = pickClearGutterX(minRow, maxRow, preferX, detourIdx);
        detourIdx += 1;

        const dir = s.src.row < s.dst.row ? 1 : -1;
        const exitY = p0.y + dir * 20;
        const enterY = p3.y - dir * 20;
        const midY = (exitY + enterY) / 2;

        pathD = [
          `M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)}`,
          `C ${p0.x.toFixed(1)} ${exitY.toFixed(1)}, ${gutterX.toFixed(1)} ${p0.y.toFixed(1)}, ${gutterX.toFixed(1)} ${((exitY + midY) / 2).toFixed(1)}`,
          `L ${gutterX.toFixed(1)} ${((enterY + midY) / 2).toFixed(1)}`,
          `C ${gutterX.toFixed(1)} ${p3.y.toFixed(1)}, ${p3.x.toFixed(1)} ${enterY.toFixed(1)}, ${p3.x.toFixed(1)} ${p3.y.toFixed(1)}`,
        ].join(' ');
        labelX = gutterX;
        labelY = midY;
      } else {
        // 相邻行垂直连线：支持一对多树状发散（共用短树干再柔性分叉）
        const fanGroup = fanOutGroups.get(`${s.src.node.id}:${s.srcSide}`) ?? [];
        const isTreeFanOut = fanGroup.length > 1;
        const dir = s.srcSide === 'bottom' ? 1 : -1;

        if (isTreeFanOut) {
          const stemLen = 14;
          const trunkX = s.src.x + nodeW / 2;
          const trunkEndY = p0.y + dir * stemLen;
          const midY = (trunkEndY + p3.y) / 2;
          pathD = [
            `M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)}`,
            `Q ${p0.x.toFixed(1)} ${(p0.y + dir * 7).toFixed(1)}, ${trunkX.toFixed(1)} ${trunkEndY.toFixed(1)}`,
            `C ${trunkX.toFixed(1)} ${midY.toFixed(1)}, ${p3.x.toFixed(1)} ${midY.toFixed(1)}, ${p3.x.toFixed(1)} ${p3.y.toFixed(1)}`,
          ].join(' ');
          const t = 0.58;
          labelX = cubicPointAt(trunkX, trunkX, p3.x, p3.x, t);
          labelY = cubicPointAt(trunkEndY, midY, midY, p3.y, t);
        } else {
          const dy = Math.max(24, Math.abs(p3.y - p0.y) * 0.5);
          const c1y = p0.y + dir * dy;
          const c2y = p3.y - dir * dy;
          pathD = `M ${p0.x} ${p0.y} C ${p0.x} ${c1y}, ${p3.x} ${c2y}, ${p3.x} ${p3.y}`;
          const t = s.src.col % 2 === 0 ? 0.44 : 0.56;
          labelX = cubicPointAt(p0.x, p0.x, p3.x, p3.x, t);
          labelY = cubicPointAt(p0.y, c1y, c2y, p3.y, t);
        }
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
      timelineFlowPath,
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
              <linearGradient id="logic-timeline-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.9" />
                <stop offset="50%" stopColor="#3b82f6" stopOpacity="0.95" />
                <stop offset="100%" stopColor="#818cf8" stopOpacity="0.9" />
              </linearGradient>
              <marker
                id="logic-timeline-axis-arrow"
                markerWidth="9"
                markerHeight="9"
                refX="7"
                refY="4.5"
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <path d="M0.5,1 L7.5,4.5 L0.5,8 Z" fill="#38bdf8" />
              </marker>
            </defs>

            {/* 连续柔性时间流主轴（更粗 + 蓝青渐变 + 跨行 S 曲线串联） */}
            {layout.timelineFlowPath && (
              <path
                d={layout.timelineFlowPath}
                fill="none"
                stroke="url(#logic-timeline-gradient)"
                strokeWidth={2.8}
                strokeLinecap="round"
                strokeOpacity={0.85}
                markerEnd="url(#logic-timeline-axis-arrow)"
              />
            )}

            {/* 每行时间线节点刻度点与短引线 */}
            {layout.timelineRowAxes.map((rowAxis) => (
              <g key={`axis-${rowAxis.row}`}>
                {rowAxis.nodes
                  .filter((item) => item.node.kind !== 'question')
                  .map((item) => {
                    const cx = item.x + layout.nodeW / 2;
                  return (
                    <g key={`tick-${item.node.id}`}>
                      <line
                        x1={cx}
                        y1={rowAxis.axisY}
                        x2={cx}
                        y2={item.y}
                        stroke="#38bdf8"
                        strokeOpacity={0.35}
                        strokeWidth={1.2}
                        strokeDasharray="2 2"
                      />
                      <circle
                        cx={cx}
                        cy={rowAxis.axisY}
                        r={5}
                        fill="#38bdf8"
                        fillOpacity={0.2}
                      />
                      <circle
                        cx={cx}
                        cy={rowAxis.axisY}
                        r={3}
                        fill="#38bdf8"
                        stroke="#09090b"
                        strokeWidth={1}
                      />
                      <text
                        x={cx}
                        y={rowAxis.axisY - 7}
                        textAnchor="middle"
                        fontSize={8.5}
                        fontFamily="monospace"
                        fontWeight={600}
                        fill="#bae6fd"
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
                      edge.relation === 'question_suggest' ||
                        srcPos?.node.expandableForQuestion ||
                        dstPos?.node.expandableForQuestion ||
                        srcPos?.node.kind === 'question' ||
                        dstPos?.node.kind === 'question'
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
            const isQuestion = node.kind === 'question';
            const dimmed =
              (selectedNodeId !== null && !connectedToSelected.ids.has(node.id)) ||
              (onlyExpandable && !node.expandableForQuestion && !isQuestion && !isTopic);

            const theme = NODE_CARD_THEME[node.relation] ?? NODE_CARD_THEME.outline;
            const borderCls = isTopic
              ? 'border-cyan-400/70 bg-cyan-950/55 hover:border-cyan-300/90 shadow-[0_0_12px_rgba(34,211,238,0.12)]'
              : isQuestion
                ? 'border-dashed border-amber-400/85 bg-gradient-to-br from-amber-950/75 to-[#1c1306] hover:border-amber-300 shadow-[0_0_14px_rgba(245,158,11,0.2)]'
                : theme.card;
            const accentCls = isTopic
              ? 'bg-cyan-400'
              : isQuestion
                ? 'bg-amber-400'
                : theme.accent;

            return (
              <div
                key={node.id}
                role="button"
                tabIndex={0}
                onClick={() =>
                  setSelectedNodeId((prev) => (prev === node.id ? null : node.id))
                }
                onDoubleClick={() => {
                  if (node.evidenceMs > 0 || !isTopic) {
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
                  opacity: dimmed ? 0.25 : 1,
                }}
                className={`absolute z-10 rounded-lg border pl-2.5 pr-2 py-1.5 flex flex-col justify-between cursor-pointer transition-all select-none overflow-hidden ${borderCls} ${
                  isSelected ? 'ring-2 ring-blue-400/80' : ''
                }`}
              >
                {/* 左侧彩色标识条，让不同逻辑块一目了然 */}
                <span
                  aria-hidden="true"
                  className={`absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r ${accentCls}`}
                />

                <div className="flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1 min-w-0">
                    {isQuestion ? (
                      <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded border border-amber-400/60 bg-amber-500/20 text-amber-200 text-[8.5px] font-semibold truncate max-w-[92px]">
                        <Sparkles className="w-2.5 h-2.5 shrink-0 text-amber-300" />
                        <span className="truncate">{node.relationLabel}</span>
                      </span>
                    ) : (
                      <span
                        className={`px-1 py-0.5 rounded border text-[8.5px] font-medium truncate max-w-[78px] ${
                          isTopic
                            ? 'bg-cyan-500/25 text-cyan-200 border-cyan-400/50'
                            : RELATION_BADGE_STYLE[node.relation]
                        }`}
                      >
                        {node.relationLabel}
                      </span>
                    )}
                    {!isQuestion && node.isRecurring && (node.occurrenceCount ?? 0) >= 2 && (
                      <span className="px-1 py-0.5 rounded bg-indigo-500/25 border border-indigo-400/50 text-indigo-200 text-[8px] font-medium shrink-0">
                        ×{node.occurrenceCount}
                      </span>
                    )}
                  </div>

                  {isQuestion ? (
                    <span className="px-1 py-0.5 rounded bg-amber-400/15 text-amber-300 text-[8px] font-semibold shrink-0">
                      提问建议
                    </span>
                  ) : node.expandableForQuestion ? (
                    <span
                      title={node.questionHint || node.expandReason}
                      className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded-full bg-amber-500/20 border border-amber-400/60 text-amber-200 text-[8px] font-semibold shrink-0"
                    >
                      <Sparkles className="w-2 h-2" />
                      <span>可深挖</span>
                    </span>
                  ) : (
                    !isTopic && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleJumpToMs(node.evidenceMs);
                        }}
                        className="text-[8.5px] font-mono text-sky-300 hover:underline cursor-pointer shrink-0"
                      >
                        [{formatLiveMmSs(node.evidenceMs)}]
                      </button>
                    )
                  )}
                </div>

                <div
                  className={`text-[10.5px] font-medium leading-tight line-clamp-2 ${
                    isQuestion ? 'text-amber-100' : 'text-zinc-100'
                  }`}
                >
                  {node.title}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 色彩图例 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-zinc-400 shrink-0">
        <span className="inline-flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm bg-cyan-400" />
          <span>主题</span>
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
          <span className="w-2.5 h-2 rounded-sm border border-dashed border-amber-400 bg-amber-500/30" />
          <span>提问建议节点</span>
        </span>
      </div>

      {/* 选中节点详情与提问拓展提示条 */}
      {selectedNode && (
        <div
          className={`rounded-lg border p-2.5 text-xs space-y-1.5 ${
            selectedNode.kind === 'question' || selectedNode.expandableForQuestion
              ? 'border-amber-500/45 bg-amber-950/20'
              : 'border-zinc-800 bg-zinc-900/80'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span
                className={`px-1.5 py-0.5 rounded border text-[10px] ${
                  selectedNode.kind === 'question'
                    ? 'bg-amber-500/20 text-amber-200 border-amber-400/50 font-semibold'
                    : selectedNode.kind === 'topic'
                      ? 'bg-cyan-500/20 text-cyan-200 border-cyan-400/50'
                      : RELATION_BADGE_STYLE[selectedNode.relation]
                }`}
              >
                {selectedNode.kind === 'question' ? '提问建议节点' : selectedNode.relationLabel}
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

            {selectedNode.kind !== 'topic' && selectedNode.evidenceMs > 0 && (
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
          {selectedNode.detail && selectedNode.detail !== selectedNode.questionHint && (
            <div className="text-[11px] text-zinc-400">{selectedNode.detail}</div>
          )}
          {selectedNode.questionHint && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200 flex items-start gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-300 shrink-0 mt-0.5" />
              <span>
                <strong>{selectedNode.kind === 'question' ? '建议提问：' : '提问拓展建议：'}</strong>
                {selectedNode.questionHint}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
