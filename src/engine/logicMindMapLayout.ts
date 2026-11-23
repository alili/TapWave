import {
  LogicConnectionMap,
  LogicGraphEdge,
  LogicGraphNode,
  LogicRelationType,
} from './liveSpeechAnalytics';
import { LiveQuestion } from '../types/liveSession';

export type MindMapLayoutMode = 'radial' | 'right';
export type MindMapSide = 'center' | 'left' | 'right';

export interface DockedQuestion {
  id: string;
  questionId?: string;
  text: string;
  reason: string;
  why?: string;
  questionType?: LiveQuestion['type'];
  source: 'ai' | 'structural';
  status?: LiveQuestion['status'];
  evidenceMs: number;
}

export interface InlineSupportBlock {
  nodeId: string;
  text: string;
  evidenceMs: number;
}

export interface MindMapPositionedNode {
  id: string;
  node: LogicGraphNode;
  side: MindMapSide;
  depth: number; // 0=中心主题, 1=主分支, 2=紧密子块, 3=三级子块
  parentId: string | null;
  branchId: string; // 所属一级主分支 ID（中心节点为自身 id）
  x: number;
  y: number;
  width: number;
  height: number;
  bodyHeight: number; // 模块本体高度（不含底部磁吸提问底座）
  dockHeight: number; // 底部磁吸提问底座高度（0 表示无吸附或处于紧凑角标态）
  inlineSupport?: InlineSupportBlock;
  dockedQuestions: DockedQuestion[];
  childIds: string[];
  hiddenDescendantCount: number;
  isCollapsed: boolean;
}

export interface MindMapBranchCurve {
  id: string;
  sourceId: string;
  targetId: string;
  branchId: string;
  depth: number; // 1=中心到主分支, >=2=父块到子块
  pathD: string;
  color: string;
}

export interface MindMapClusterBox {
  branchId: string;
  side: 'left' | 'right';
  x: number;
  y: number;
  width: number;
  height: number;
  accentColor: string;
  nodeCount: number;
}

export interface MindMapCrossLink {
  edge: LogicGraphEdge;
  sourceId: string;
  targetId: string;
  pathD: string;
  labelX: number;
  labelY: number;
  color: string;
}

export interface MindMapLayoutOptions {
  mode: MindMapLayoutMode;
  containerWidth: number;
  showDockedQuestions: boolean; // true=展开底部磁吸提问条，false=紧凑徽章吸附
  collapsedIds?: ReadonlySet<string>;
}

export interface MindMapLayoutResult {
  rootId: string | null;
  nodes: MindMapPositionedNode[];
  nodeById: Map<string, MindMapPositionedNode>;
  parentMap: Map<string, string | null>;
  curves: MindMapBranchCurve[];
  clusters: MindMapClusterBox[];
  crossLinks: MindMapCrossLink[];
  width: number;
  height: number;
  rootCenterX: number;
  rootCenterY: number;
  autoFitScale: number;
  totalDockedQuestions: number;
  questionModuleIds: string[];
}

export const MINDMAP_RELATION_COLOR: Record<LogicRelationType | 'topic', string> = {
  topic: '#22d3ee',
  viewpoint: '#60a5fa',
  story: '#c084fc',
  causal: '#34d399',
  contrast: '#fb923c',
  progression: '#2dd4bf',
  example: '#818cf8',
  conclusion: '#fb7185',
  outline: '#94a3b8',
};

const GAP_ROOT_L1 = 48;
const GAP_CHILD_X = 24;
const SIBLING_GAP_Y = 10;
const BRANCH_GAP_Y = 22;
const CANVAS_PAD_X = 28;
const CANVAS_PAD_Y = 28;
const CLUSTER_PAD = 10;

function getNodeColor(node: LogicGraphNode): string {
  if (node.kind === 'topic') return MINDMAP_RELATION_COLOR.topic;
  return MINDMAP_RELATION_COLOR[node.relation] ?? MINDMAP_RELATION_COLOR.outline;
}

function getEdgeColor(edge: LogicGraphEdge): string {
  switch (edge.relation) {
    case 'causal':
      return '#34d399';
    case 'contrast':
      return '#fb923c';
    case 'progression':
      return '#2dd4bf';
    case 'example':
    case 'support_of':
      return '#818cf8';
    case 'conclusion':
      return '#fb7185';
    case 'echo':
      return '#a78bfa';
    case 'viewpoint':
      return '#60a5fa';
    case 'story':
      return '#c084fc';
    default:
      return '#94a3b8';
  }
}

/**
 * 估算中英文混排文本在指定宽度和字号下的行数。
 */
function estimateWrappedLines(
  text: string,
  usableWidthPx: number,
  fontSizePx: number,
  maxLines: number
): number {
  const clean = text.trim();
  if (!clean) return 1;
  let totalPx = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const code = clean.charCodeAt(i);
    // ASCII 字符较窄，CJK 与全角字符按 1.02 倍字号估算
    totalPx += code <= 0x7f ? fontSizePx * 0.58 : fontSizePx * 1.02;
  }
  const lines = Math.ceil(totalPx / Math.max(40, usableWidthPx));
  return Math.max(1, Math.min(maxLines, lines));
}

function widthForDepth(depth: number): number {
  if (depth === 0) return 184;
  if (depth === 1) return 214;
  if (depth === 2) return 192;
  return 178;
}

interface RawCrossEdge {
  edge: LogicGraphEdge;
  sourceId: string;
  targetId: string;
}

interface TreeData {
  rootId: string;
  contentById: Map<string, LogicGraphNode>;
  parentMap: Map<string, string | null>;
  childrenMap: Map<string, string[]>;
  inlineSupportByNodeId: Map<string, InlineSupportBlock>;
  dockedByNodeId: Map<string, DockedQuestion[]>;
  rawCrossEdges: RawCrossEdge[];
}

function buildMindMapHierarchy(logicMap: LogicConnectionMap): TreeData | null {
  if (logicMap.nodes.length === 0) return null;

  const rawById = new Map<string, LogicGraphNode>();
  for (const n of logicMap.nodes) {
    rawById.set(n.id, n);
  }

  const rootNode =
    logicMap.nodes.find((n) => n.kind === 'topic') ?? logicMap.nodes[0];
  const rootId = rootNode.id;

  // 1. 识别并内嵌折叠 support 节点到其所属 viewpoint
  const supportToParentVp = new Map<string, string>();
  const inlineSupportByNodeId = new Map<string, InlineSupportBlock>();

  for (const edge of logicMap.edges) {
    if (edge.relation !== 'support_of') continue;
    const src = rawById.get(edge.source);
    const dst = rawById.get(edge.target);
    if (!src || !dst) continue;
    if (dst.kind === 'support' && src.kind === 'viewpoint') {
      supportToParentVp.set(dst.id, src.id);
      if (!inlineSupportByNodeId.has(src.id)) {
        inlineSupportByNodeId.set(src.id, {
          nodeId: dst.id,
          text: dst.title,
          evidenceMs: dst.evidenceMs,
        });
      }
    }
  }

  // 收集剩余内容节点（排除 question 与已折叠的 support）
  const contentById = new Map<string, LogicGraphNode>();
  for (const n of logicMap.nodes) {
    if (n.kind === 'question') continue;
    if (n.kind === 'support' && supportToParentVp.has(n.id)) continue;
    contentById.set(n.id, n);
  }

  // 2. 提取所有 question 节点并吸附到对应关联模块
  const dockedByNodeId = new Map<string, DockedQuestion[]>();
  const pushDocked = (hostId: string, q: DockedQuestion) => {
    const targetId = contentById.has(hostId) ? hostId : rootId;
    const list = dockedByNodeId.get(targetId) ?? [];
    const dedupKey = q.questionId ? `qid:${q.questionId}` : `txt:${q.text}`;
    if (
      list.some(
        (item) =>
          (item.questionId ? `qid:${item.questionId}` : `txt:${item.text}`) ===
          dedupKey
      )
    ) {
      return;
    }
    list.push(q);
    // AI 提问排在结构性深挖建议前
    list.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'ai' ? -1 : 1;
      return a.evidenceMs - b.evidenceMs;
    });
    dockedByNodeId.set(targetId, list);
  };

  for (const n of logicMap.nodes) {
    if (n.kind !== 'question') continue;
    let rawHost = n.parentNodeId ?? rootId;
    if (rawHost === 'topic_root') rawHost = rootId;
    const resolvedHost = supportToParentVp.get(rawHost) ?? rawHost;
    const text = (n.questionHint || n.title || '').trim();
    if (!text) continue;
    pushDocked(resolvedHost, {
      id: n.id,
      questionId: n.matchedQuestionId,
      text,
      reason: n.expandReason || n.relationLabel || '提问建议',
      why: n.questionWhy,
      questionType: n.questionType,
      source: n.matchedQuestionId ? 'ai' : 'structural',
      status: n.questionStatus,
      evidenceMs: n.evidenceMs,
    });
  }

  // 兜底：若存在标有 expandableForQuestion 但未生成 question 节点的模块，也补一条吸附
  for (const n of contentById.values()) {
    if (n.id === rootId) continue;
    if (!n.expandableForQuestion || !n.questionHint) continue;
    const existing = dockedByNodeId.get(n.id) ?? [];
    if (existing.length > 0) continue;
    pushDocked(n.id, {
      id: `dock_${n.id}`,
      questionId: n.matchedQuestionId,
      text: n.questionHint,
      reason: n.expandReason || '提问建议',
      why: n.questionWhy,
      questionType: n.questionType,
      source: n.matchedQuestionId ? 'ai' : 'structural',
      status: n.questionStatus,
      evidenceMs: n.evidenceMs,
    });
  }

  // 3. 构建单父树（最大深度 3）：分配唯一最佳父节点
  const parentMap = new Map<string, string | null>();
  parentMap.set(rootId, null);

  const depthOf = (id: string): number => {
    let d = 0;
    let cur: string | null | undefined = parentMap.get(id);
    const seen = new Set<string>([id]);
    while (cur) {
      if (seen.has(cur)) break;
      seen.add(cur);
      d += 1;
      cur = parentMap.get(cur) ?? null;
    }
    return d;
  };

  const wouldCreateCycle = (childId: string, candidateParentId: string): boolean => {
    let cur: string | null | undefined = candidateParentId;
    const seen = new Set<string>();
    while (cur) {
      if (cur === childId) return true;
      if (seen.has(cur)) return true;
      seen.add(cur);
      cur = parentMap.get(cur) ?? null;
    }
    return false;
  };

  const assignParent = (childId: string, pid: string) => {
    if (childId === pid || !contentById.has(pid) || wouldCreateCycle(childId, pid)) {
      parentMap.set(childId, rootId);
      return;
    }
    parentMap.set(childId, pid);
  };

  // 构建邻接表（忽略 topic_link / support_of / sequence / question_suggest）
  const neighbors = new Map<string, Set<string>>();
  const addNeighbor = (a: string, b: string) => {
    if (a === b) return;
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    if (!neighbors.has(b)) neighbors.set(b, new Set());
    neighbors.get(a)!.add(b);
    neighbors.get(b)!.add(a);
  };

  for (const edge of logicMap.edges) {
    if (
      edge.relation === 'topic_link' ||
      edge.relation === 'support_of' ||
      edge.relation === 'sequence' ||
      edge.relation === 'question_suggest'
    ) {
      continue;
    }
    const s = supportToParentVp.get(edge.source) ?? edge.source;
    const t = supportToParentVp.get(edge.target) ?? edge.target;
    if (contentById.has(s) && contentById.has(t) && s !== rootId && t !== rootId) {
      addNeighbor(s, t);
    }
  }

  // 3a. viewpoint 与 outline 作为一级主分支
  const primaryBranches: LogicGraphNode[] = [];
  const stories: LogicGraphNode[] = [];
  const utterances: LogicGraphNode[] = [];
  const others: LogicGraphNode[] = [];

  for (const n of contentById.values()) {
    if (n.id === rootId) continue;
    if (n.kind === 'viewpoint' || n.kind === 'outline') {
      primaryBranches.push(n);
    } else if (n.kind === 'story') {
      stories.push(n);
    } else if (n.kind === 'utterance') {
      utterances.push(n);
    } else {
      others.push(n);
    }
  }

  for (const b of primaryBranches) {
    assignParent(b.id, rootId);
  }

  // 3b. story 紧贴归属最相关的 viewpoint（作为 L2），无关联则升为 L1 主分支
  for (const st of stories) {
    const linkedIds = Array.from(neighbors.get(st.id) ?? []);
    const candidateVps = linkedIds
      .map((id) => contentById.get(id))
      .filter((n): n is LogicGraphNode => Boolean(n && n.kind === 'viewpoint'));

    if (candidateVps.length > 0) {
      candidateVps.sort(
        (a, b) =>
          Math.abs(a.evidenceMs - st.evidenceMs) -
          Math.abs(b.evidenceMs - st.evidenceMs)
      );
      assignParent(st.id, candidateVps[0].id);
    } else {
      assignParent(st.id, rootId);
    }
  }

  // 3c. utterance 紧贴归属关联的 viewpoint 或 story（最大深度不超过 3）
  const hasAnyMacroBranch = primaryBranches.length > 0 || stories.length > 0;
  let lastRootUtteranceId: string | null = null;
  let rootUtteranceCount = 0;

  utterances.sort((a, b) => a.evidenceMs - b.evidenceMs);

  for (const utt of utterances) {
    const linkedIds = Array.from(neighbors.get(utt.id) ?? []);
    const candidateParents = linkedIds
      .map((id) => contentById.get(id))
      .filter((n): n is LogicGraphNode => {
        if (!n) return false;
        if (!parentMap.has(n.id)) return false;
        if (n.kind === 'viewpoint' || n.kind === 'story' || n.kind === 'outline') {
          return depthOf(n.id) <= 2;
        }
        return false;
      });

    if (candidateParents.length > 0) {
      candidateParents.sort((a, b) => {
        const pa = a.kind === 'viewpoint' ? 0 : a.kind === 'story' ? 1 : 2;
        const pb = b.kind === 'viewpoint' ? 0 : b.kind === 'story' ? 1 : 2;
        if (pa !== pb) return pa - pb;
        return (
          Math.abs(a.evidenceMs - utt.evidenceMs) -
          Math.abs(b.evidenceMs - utt.evidenceMs)
        );
      });
      assignParent(utt.id, candidateParents[0].id);
      continue;
    }

    // 未关联观点/案例的实时话语：尽量局部成簇，避免全平铺在根节点导致过宽
    if (
      lastRootUtteranceId &&
      neighbors.get(utt.id)?.has(lastRootUtteranceId) &&
      (hasAnyMacroBranch || rootUtteranceCount >= 4)
    ) {
      assignParent(utt.id, lastRootUtteranceId);
    } else {
      assignParent(utt.id, rootId);
      lastRootUtteranceId = utt.id;
      rootUtteranceCount += 1;
    }
  }

  for (const o of others) {
    assignParent(o.id, rootId);
  }

  // 4. 构建 childrenMap，同级子节点按时间顺排
  const childrenMap = new Map<string, string[]>();
  for (const id of contentById.keys()) {
    childrenMap.set(id, []);
  }
  for (const [id, pid] of parentMap.entries()) {
    if (!pid) continue;
    const arr = childrenMap.get(pid);
    if (arr) arr.push(id);
  }
  for (const list of childrenMap.values()) {
    list.sort((aId, bId) => {
      const a = contentById.get(aId)!;
      const b = contentById.get(bId)!;
      if (a.evidenceMs !== b.evidenceMs) return a.evidenceMs - b.evidenceMs;
      return a.id.localeCompare(b.id);
    });
  }

  // 5. 收集非树干的跨分支关联边（按需浮现，默认隐藏以减少连线）
  const rawCrossEdges: RawCrossEdge[] = [];
  const crossSeen = new Set<string>();
  for (const edge of logicMap.edges) {
    if (
      edge.relation === 'topic_link' ||
      edge.relation === 'support_of' ||
      edge.relation === 'sequence' ||
      edge.relation === 'question_suggest'
    ) {
      continue;
    }
    const s = supportToParentVp.get(edge.source) ?? edge.source;
    const t = supportToParentVp.get(edge.target) ?? edge.target;
    if (!contentById.has(s) || !contentById.has(t) || s === t) continue;
    if (s === rootId || t === rootId) continue;
    if (parentMap.get(s) === t || parentMap.get(t) === s) continue;

    const pairKey = s < t ? `${s}<->${t}:${edge.relation}` : `${t}<->${s}:${edge.relation}`;
    if (crossSeen.has(pairKey)) continue;
    crossSeen.add(pairKey);
    rawCrossEdges.push({ edge, sourceId: s, targetId: t });
  }

  return {
    rootId,
    contentById,
    parentMap,
    childrenMap,
    inlineSupportByNodeId,
    dockedByNodeId,
    rawCrossEdges,
  };
}

/**
 * 计算思维导图布局：中心发散（radial）或向右展开（right），
 * 关联模块紧密聚类、提问磁吸至模块底部，数学上保证节点零重叠。
 */
export function computeMindMapLayout(
  logicMap: LogicConnectionMap,
  options: MindMapLayoutOptions
): MindMapLayoutResult {
  const empty: MindMapLayoutResult = {
    rootId: null,
    nodes: [],
    nodeById: new Map(),
    parentMap: new Map(),
    curves: [],
    clusters: [],
    crossLinks: [],
    width: Math.max(320, options.containerWidth),
    height: 220,
    rootCenterX: Math.max(160, options.containerWidth / 2),
    rootCenterY: 110,
    autoFitScale: 1,
    totalDockedQuestions: 0,
    questionModuleIds: [],
  };

  const tree = buildMindMapHierarchy(logicMap);
  if (!tree) return empty;

  const collapsedIds = options.collapsedIds ?? new Set<string>();
  const {
    rootId,
    contentById,
    parentMap,
    childrenMap,
    inlineSupportByNodeId,
    dockedByNodeId,
    rawCrossEdges,
  } = tree;

  const depthMap = new Map<string, number>();
  const branchIdMap = new Map<string, string>();

  const computeMeta = (id: string, depth: number, branchId: string) => {
    depthMap.set(id, depth);
    branchIdMap.set(id, branchId);
    for (const cid of childrenMap.get(id) ?? []) {
      computeMeta(cid, depth + 1, depth === 0 ? cid : branchId);
    }
  };
  computeMeta(rootId, 0, rootId);

  const countAllDescendants = (id: string): number => {
    const kids = childrenMap.get(id) ?? [];
    let total = kids.length;
    for (const k of kids) total += countAllDescendants(k);
    return total;
  };

  // 估算每个节点宽高
  const sizeMap = new Map<
    string,
    { width: number; bodyHeight: number; dockHeight: number; height: number }
  >();

  for (const [id, node] of contentById.entries()) {
    const depth = depthMap.get(id) ?? 1;
    const width = widthForDepth(depth);
    const docked = dockedByNodeId.get(id) ?? [];
    const inlineSup = inlineSupportByNodeId.get(id);

    let bodyHeight = 64;
    if (depth === 0) {
      const titleLines = estimateWrappedLines(node.title, width - 28, 12.5, 3);
      bodyHeight = 38 + titleLines * 17 + 14;
    } else {
      const titleLines = estimateWrappedLines(node.title, width - 24, 11, 2);
      bodyHeight = 24 + titleLines * 16 + 16;
      if (inlineSup) {
        const supLines = estimateWrappedLines(inlineSup.text, width - 28, 10, 2);
        bodyHeight += 12 + supLines * 14 + 6;
      }
      if (!options.showDockedQuestions && docked.length > 0) {
        bodyHeight += 4;
      }
    }

    let dockHeight = 0;
    if (options.showDockedQuestions && docked.length > 0) {
      const firstQ = docked[0];
      const qLines = estimateWrappedLines(firstQ.text, width - 26, 10.5, 2);
      dockHeight = 22 + qLines * 15 + 10 + (docked.length > 1 ? 16 : 0);
    }

    sizeMap.set(id, {
      width,
      bodyHeight,
      dockHeight,
      height: bodyHeight + dockHeight,
    });
  }

  const getVisibleChildren = (id: string): string[] => {
    if (id !== rootId && collapsedIds.has(id)) return [];
    return childrenMap.get(id) ?? [];
  };

  // 递归测量子树尺寸（子树总高与向外延伸总宽）
  const subtreeHMap = new Map<string, number>();
  const subtreeWMap = new Map<string, number>();

  const measureSubtree = (id: string): { h: number; w: number } => {
    const sz = sizeMap.get(id)!;
    const visKids = getVisibleChildren(id);
    if (visKids.length === 0) {
      subtreeHMap.set(id, sz.height);
      subtreeWMap.set(id, sz.width);
      return { h: sz.height, w: sz.width };
    }

    let kidsH = 0;
    let maxKidW = 0;
    visKids.forEach((kidId, idx) => {
      const m = measureSubtree(kidId);
      kidsH += m.h;
      if (idx > 0) kidsH += SIBLING_GAP_Y;
      if (m.w > maxKidW) maxKidW = m.w;
    });

    const totalH = Math.max(sz.height, kidsH);
    const totalW = sz.width + GAP_CHILD_X + maxKidW;
    subtreeHMap.set(id, totalH);
    subtreeWMap.set(id, totalW);
    return { h: totalH, w: totalW };
  };

  const l1Ids = childrenMap.get(rootId) ?? [];
  for (const bId of l1Ids) {
    measureSubtree(bId);
  }

  // 左右两翼高度平衡分配
  const rightBranches: string[] = [];
  const leftBranches: string[] = [];

  if (options.mode === 'right' || l1Ids.length <= 1) {
    rightBranches.push(...l1Ids);
  } else {
    let rightSum = 0;
    let leftSum = 0;
    l1Ids.forEach((bId, idx) => {
      const h = subtreeHMap.get(bId) ?? 64;
      if (idx === 0) {
        rightBranches.push(bId);
        rightSum += h;
      } else if (idx === 1) {
        leftBranches.push(bId);
        leftSum += h;
      } else if (leftSum < rightSum) {
        leftBranches.push(bId);
        leftSum += h + BRANCH_GAP_Y;
      } else {
        rightBranches.push(bId);
        rightSum += h + BRANCH_GAP_Y;
      }
    });

    const sortByTime = (aId: string, bId: string) => {
      const a = contentById.get(aId)!;
      const b = contentById.get(bId)!;
      if (a.evidenceMs !== b.evidenceMs) return a.evidenceMs - b.evidenceMs;
      return a.id.localeCompare(b.id);
    };
    rightBranches.sort(sortByTime);
    leftBranches.sort(sortByTime);
  }

  const wingTotalHeight = (branches: string[]): number => {
    if (branches.length === 0) return 0;
    return branches.reduce(
      (sum, bId, idx) =>
        sum + (subtreeHMap.get(bId) ?? 64) + (idx > 0 ? BRANCH_GAP_Y : 0),
      0
    );
  };

  const wingMaxWidth = (branches: string[]): number => {
    if (branches.length === 0) return 0;
    return Math.max(...branches.map((bId) => subtreeWMap.get(bId) ?? 200));
  };

  const rightWingH = wingTotalHeight(rightBranches);
  const leftWingH = wingTotalHeight(leftBranches);
  const rightWingW = wingMaxWidth(rightBranches);
  const leftWingW = wingMaxWidth(leftBranches);

  const rootSz = sizeMap.get(rootId)!;
  const contentH = Math.max(rootSz.height, rightWingH, leftWingH);
  const totalH = contentH + CANVAS_PAD_Y * 2;

  const rootX =
    CANVAS_PAD_X + (leftWingW > 0 ? leftWingW + GAP_ROOT_L1 : 0);
  const rootY = CANVAS_PAD_Y + (contentH - rootSz.height) / 2;
  const totalW =
    rootX +
    rootSz.width +
    (rightWingW > 0 ? GAP_ROOT_L1 + rightWingW : 0) +
    CANVAS_PAD_X;

  const positionedNodes: MindMapPositionedNode[] = [];
  const nodeById = new Map<string, MindMapPositionedNode>();

  const registerNode = (
    id: string,
    side: MindMapSide,
    x: number,
    y: number
  ) => {
    const node = contentById.get(id)!;
    const sz = sizeMap.get(id)!;
    const depth = depthMap.get(id) ?? 0;
    const isCollapsed = id !== rootId && collapsedIds.has(id);
    const hiddenDescendantCount = isCollapsed ? countAllDescendants(id) : 0;
    const item: MindMapPositionedNode = {
      id,
      node,
      side,
      depth,
      parentId: parentMap.get(id) ?? null,
      branchId: branchIdMap.get(id) ?? id,
      x,
      y,
      width: sz.width,
      height: sz.height,
      bodyHeight: sz.bodyHeight,
      dockHeight: sz.dockHeight,
      inlineSupport: inlineSupportByNodeId.get(id),
      dockedQuestions: dockedByNodeId.get(id) ?? [],
      childIds: childrenMap.get(id) ?? [],
      hiddenDescendantCount,
      isCollapsed,
    };
    positionedNodes.push(item);
    nodeById.set(id, item);
  };

  registerNode(rootId, 'center', rootX, rootY);

  const placeSubtree = (
    id: string,
    side: 'left' | 'right',
    edgeX: number,
    slotTopY: number
  ) => {
    const sz = sizeMap.get(id)!;
    const subH = subtreeHMap.get(id) ?? sz.height;
    const x = side === 'right' ? edgeX : edgeX - sz.width;
    const y = slotTopY + (subH - sz.height) / 2;
    registerNode(id, side, x, y);

    const visKids = getVisibleChildren(id);
    if (visKids.length === 0) return;

    const kidsTotalH = visKids.reduce(
      (sum, kId, idx) =>
        sum + (subtreeHMap.get(kId) ?? 64) + (idx > 0 ? SIBLING_GAP_Y : 0),
      0
    );
    let curKidY = slotTopY + (subH - kidsTotalH) / 2;
    const nextEdgeX =
      side === 'right' ? x + sz.width + GAP_CHILD_X : x - GAP_CHILD_X;

    for (const kId of visKids) {
      placeSubtree(kId, side, nextEdgeX, curKidY);
      curKidY += (subtreeHMap.get(kId) ?? 64) + SIBLING_GAP_Y;
    }
  };

  if (rightBranches.length > 0) {
    let curY = CANVAS_PAD_Y + (contentH - rightWingH) / 2;
    const startEdgeX = rootX + rootSz.width + GAP_ROOT_L1;
    for (const bId of rightBranches) {
      placeSubtree(bId, 'right', startEdgeX, curY);
      curY += (subtreeHMap.get(bId) ?? 64) + BRANCH_GAP_Y;
    }
  }

  if (leftBranches.length > 0) {
    let curY = CANVAS_PAD_Y + (contentH - leftWingH) / 2;
    const startEdgeX = rootX - GAP_ROOT_L1;
    for (const bId of leftBranches) {
      placeSubtree(bId, 'left', startEdgeX, curY);
      curY += (subtreeHMap.get(bId) ?? 64) + BRANCH_GAP_Y;
    }
  }

  // 生成有机贝塞尔曲线（边数严格等于可见节点数 - 1）
  const curves: MindMapBranchCurve[] = [];
  for (const item of positionedNodes) {
    if (!item.parentId) continue;
    const parent = nodeById.get(item.parentId);
    if (!parent) continue;

    const isLeft = item.side === 'left';
    const x0 = isLeft ? parent.x : parent.x + parent.width;
    const y0 = parent.y + parent.bodyHeight / 2;
    const x1 = isLeft ? item.x + item.width : item.x;
    const y1 = item.y + item.bodyHeight / 2;

    const dx = Math.abs(x1 - x0);
    const c1x = isLeft ? x0 - dx * 0.52 : x0 + dx * 0.52;
    const c2x = isLeft ? x1 + dx * 0.52 : x1 - dx * 0.52;
    const pathD = `M ${x0.toFixed(1)} ${y0.toFixed(1)} C ${c1x.toFixed(1)} ${y0.toFixed(1)}, ${c2x.toFixed(1)} ${y1.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;

    curves.push({
      id: `curve-${parent.id}->${item.id}`,
      sourceId: parent.id,
      targetId: item.id,
      branchId: item.branchId,
      depth: item.depth,
      pathD,
      color: getNodeColor(item.node),
    });
  }

  // 生成柔和分支聚类底板（含 >= 2 个可见节点的分支）
  const branchGroups = new Map<string, MindMapPositionedNode[]>();
  for (const item of positionedNodes) {
    if (item.depth === 0) continue;
    const arr = branchGroups.get(item.branchId) ?? [];
    arr.push(item);
    branchGroups.set(item.branchId, arr);
  }

  const clusters: MindMapClusterBox[] = [];
  for (const [bId, items] of branchGroups.entries()) {
    if (items.length < 2) continue;
    const minX = Math.min(...items.map((n) => n.x)) - CLUSTER_PAD;
    const minY = Math.min(...items.map((n) => n.y)) - CLUSTER_PAD;
    const maxX = Math.max(...items.map((n) => n.x + n.width)) + CLUSTER_PAD;
    const maxY = Math.max(...items.map((n) => n.y + n.height)) + CLUSTER_PAD;
    const branchHead = nodeById.get(bId);
    clusters.push({
      branchId: bId,
      side: items[0].side === 'left' ? 'left' : 'right',
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      accentColor: branchHead ? getNodeColor(branchHead.node) : '#60a5fa',
      nodeCount: items.length,
    });
  }

  // 生成按需浮现的跨分支语义弧线
  const crossLinks: MindMapCrossLink[] = [];
  for (const raw of rawCrossEdges) {
    const src = nodeById.get(raw.sourceId);
    const dst = nodeById.get(raw.targetId);
    if (!src || !dst) continue;

    const sx = src.x + src.width / 2;
    const sy = src.y + src.bodyHeight / 2;
    const tx = dst.x + dst.width / 2;
    const ty = dst.y + dst.bodyHeight / 2;

    const midX = (sx + tx) / 2;
    const midY = (sy + ty) / 2;
    const dist = Math.hypot(tx - sx, ty - sy);
    const bend = Math.min(72, Math.max(28, dist * 0.22));
    // 向外侧（上拱或侧拱）弯曲，避免穿过中心或卡片文字
    const ctrlX = midX + (src.side === 'left' && dst.side === 'left' ? -bend * 0.45 : src.side === 'right' && dst.side === 'right' ? bend * 0.45 : 0);
    const ctrlY = Math.min(sy, ty) - bend;

    const pathD = `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${ctrlX.toFixed(1)} ${ctrlY.toFixed(1)}, ${tx.toFixed(1)} ${ty.toFixed(1)}`;
    const labelX = 0.25 * sx + 0.5 * ctrlX + 0.25 * tx;
    const labelY = 0.25 * sy + 0.5 * ctrlY + 0.25 * ty;

    crossLinks.push({
      edge: raw.edge,
      sourceId: src.id,
      targetId: dst.id,
      pathD,
      labelX,
      labelY,
      color: getEdgeColor(raw.edge),
    });
  }

  const rawScale =
    options.containerWidth > 0 && totalW > 0
      ? (options.containerWidth - 16) / totalW
      : 1;
  const autoFitScale = Math.max(0.76, Math.min(1, Number(rawScale.toFixed(3))));

  let totalDockedQuestions = 0;
  const questionModuleIds: string[] = [];
  for (const item of positionedNodes) {
    if (item.dockedQuestions.length > 0) {
      totalDockedQuestions += item.dockedQuestions.length;
      questionModuleIds.push(item.id);
    }
  }

  return {
    rootId,
    nodes: positionedNodes,
    nodeById,
    parentMap,
    curves,
    clusters,
    crossLinks,
    width: Math.ceil(totalW),
    height: Math.ceil(totalH),
    rootCenterX: rootX + rootSz.width / 2,
    rootCenterY: rootY + rootSz.height / 2,
    autoFitScale,
    totalDockedQuestions,
    questionModuleIds,
  };
}
