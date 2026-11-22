import {
  LiveOutlineItem,
  LiveProfile,
  LiveQuestion,
  LiveSessionSnapshot,
  LiveSpeaker,
  LiveUtterance,
} from '../types/liveSession';

export type OralFillerCategory = 'pure_filler' | 'starter_crutch' | 'hedging_tail';

export interface OralFillerWordStat {
  word: string;
  category: OralFillerCategory;
  categoryLabel: string;
  count: number;
  perMin: number;
  firstMs: number;
  latestMs: number;
}

export interface OralFillerStats {
  totalCount: number;
  perMin: number;
  charRatioPct: number;
  byCategory: Record<OralFillerCategory, number>;
  topWords: OralFillerWordStat[];
}

export interface PaceTrendPoint {
  id: string;
  timeMs: number;
  cpm: number;
  speakerId: string;
  chars: number;
  densityScore: number;
  fillerCount: number;
}

export interface SpeakerSpeechSummary {
  speakerId: string;
  name: string;
  role: LiveSpeaker['role'];
  utteranceCount: number;
  charCount: number;
  activeMs: number;
  sharePct: number;
  avgCpm: number;
  fillerCount: number;
  fillerPerMin: number;
}

export interface SpeechPaceStats {
  overallCpm: number;
  recentCpm: number;
  paceStatus: 'idle' | 'slow' | 'moderate' | 'fast';
  paceLabel: string;
  paceStdCpm: number;
  trendPoints: PaceTrendPoint[];
}

export interface InfoDensityStats {
  score: number; // 0..100
  level: 'idle' | 'low' | 'medium' | 'high';
  levelLabel: string;
  effectiveRatioPct: number;
  substantivePointsCount: number;
  pointsPerMin: number;
  factMarkerCount: number;
}

export interface HabitDimension {
  key: 'fluency' | 'paceStability' | 'conciseness' | 'infoDensity' | 'logicStructure';
  label: string;
  score: number; // 0..100
}

export interface HabitTag {
  label: string;
  tone: 'good' | 'warn' | 'info';
  detail: string;
}

export interface SpeechHabitAnalysis {
  avgUtteranceChars: number;
  avgTurnDurationSec: number;
  maxTurnDurationSec: number;
  turnSwitchCount: number;
  dominantPattern: string;
  dimensions: HabitDimension[];
  tags: HabitTag[];
}

export type LogicRelationType =
  | 'viewpoint'
  | 'story'
  | 'causal'
  | 'contrast'
  | 'progression'
  | 'example'
  | 'conclusion'
  | 'outline';

export interface LogicMapChildNode {
  id: string;
  relation: LogicRelationType;
  relationLabel: string;
  text: string;
  evidenceMs: number;
}

export interface LogicMapBranch {
  id: string;
  kind: 'viewpoint' | 'story' | 'outline' | 'utterance';
  relation: LogicRelationType;
  relationLabel: string;
  title: string;
  detail?: string;
  speakerId?: string;
  evidenceMs: number;
  children: LogicMapChildNode[];
}

export type LogicGraphNodeKind =
  | 'topic'
  | 'viewpoint'
  | 'story'
  | 'utterance'
  | 'outline'
  | 'support';

export type LogicGraphEdgeRelation =
  | LogicRelationType
  | 'topic_link'
  | 'support_of'
  | 'echo'
  | 'sequence';

export interface LogicGraphNode {
  id: string;
  kind: LogicGraphNodeKind;
  relation: LogicRelationType;
  relationLabel: string;
  title: string;
  detail?: string;
  speakerId?: string;
  speakerName?: string;
  evidenceMs: number;
  /** 分层布局列序号: 0=主题, 1=观点/提纲, 2=案例/话语逻辑, 3=论据支点/总结 */
  tier: number;
  /** 泳道归属: global=非时间线(核心主题/多次体现或总结观点/提纲), timeline=时间线逻辑流 */
  lane?: 'global' | 'timeline';
  /** 被引用/体现/呼应的次数（用于标识多次使用或总结的观点） */
  occurrenceCount?: number;
  /** 是否为多次使用/体现/总结的跨时间观点 */
  isRecurring?: boolean;
  /** 是否高亮为可提问拓展的节点 */
  expandableForQuestion: boolean;
  /** 为什么此处适合提问拓展 */
  expandReason?: string;
  /** 建议追问方向或匹配的 AI 提问文本 */
  questionHint?: string;
  /** 关联的提问建议 ID */
  matchedQuestionId?: string;
}

export interface LogicGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: LogicGraphEdgeRelation;
  label: string;
  dashed?: boolean;
}

export interface LogicConnectionMap {
  rootTopic: string;
  totalConnectors: number;
  connectorCounts: {
    causal: number;
    contrast: number;
    progression: number;
    example: number;
    conclusion: number;
  };
  branches: LogicMapBranch[];
  nodes: LogicGraphNode[];
  edges: LogicGraphEdge[];
  expandableNodeIds: string[];
}

export interface InsightUpdateStatus {
  lastUpdatedAt: number | null;
  lastUpdatedLabel: string;
  elapsedSinceLastSec: number | null;
  pendingChars: number;
  charThreshold: number;
  fallbackSec: number;
  progressPct: number;
  nextExpectedLabel: string;
  statusTone: 'idle' | 'active' | 'thinking' | 'disabled' | 'paused';
}

export interface LiveSpeechAnalyticsResult {
  totalChars: number;
  activeMs: number;
  utteranceCount: number;
  speakers: SpeakerSpeechSummary[];
  pace: SpeechPaceStats;
  fillers: OralFillerStats;
  density: InfoDensityStats;
  habits: SpeechHabitAnalysis;
  logicMap: LogicConnectionMap;
}

interface FillerPatternDef {
  word: string;
  category: OralFillerCategory;
  categoryLabel: string;
}

const FILLER_PATTERNS: FillerPatternDef[] = [
  // 起手口癖 / 连接口癖（优先匹配长词）
  { word: '怎么说呢', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '怎么讲呢', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '也就是说', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '换句话说', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '某种程度上', category: 'hedging_tail', categoryLabel: '模糊确认' },
  { word: '然后呢', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '就是说', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '其实吧', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '那其实', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '所以说', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '基本上', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '说实话', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '老实说', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '对不对', category: 'hedging_tail', categoryLabel: '模糊确认' },
  { word: '是不是', category: 'hedging_tail', categoryLabel: '模糊确认' },
  { word: '知道吧', category: 'hedging_tail', categoryLabel: '模糊确认' },
  { word: '然后', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '就是', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '那个', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '其实', category: 'starter_crutch', categoryLabel: '起手口癖' },
  { word: '对吧', category: 'hedging_tail', categoryLabel: '模糊确认' },
  { word: '是吧', category: 'hedging_tail', categoryLabel: '模糊确认' },
  { word: '懂吧', category: 'hedging_tail', categoryLabel: '模糊确认' },
  { word: '大概', category: 'hedging_tail', categoryLabel: '模糊确认' },
  { word: '好像', category: 'hedging_tail', categoryLabel: '模糊确认' },
  // 纯语气停顿词
  { word: '嗯', category: 'pure_filler', categoryLabel: '语气停顿' },
  { word: '呃', category: 'pure_filler', categoryLabel: '语气停顿' },
  { word: '额', category: 'pure_filler', categoryLabel: '语气停顿' },
  { word: '唔', category: 'pure_filler', categoryLabel: '语气停顿' },
  { word: '诶', category: 'pure_filler', categoryLabel: '语气停顿' },
];

const LOGIC_CONNECTOR_GROUPS: Array<{
  relation: 'causal' | 'contrast' | 'progression' | 'example' | 'conclusion';
  label: string;
  keywords: string[];
}> = [
  {
    relation: 'causal',
    label: '因果',
    keywords: ['因为', '所以', '因此', '导致', '从而', '之所以', '正因如此', '结果就是'],
  },
  {
    relation: 'contrast',
    label: '转折',
    keywords: ['但是', '不过', '然而', '反而', '虽然', '尽管', '另一方面', '恰恰相反'],
  },
  {
    relation: 'progression',
    label: '递进',
    keywords: ['首先', '其次', '最后', '第一', '第二', '第三', '另外', '此外', '并且', '而且', '更重要的是'],
  },
  {
    relation: 'example',
    label: '举例',
    keywords: ['比如', '例如', '举个例子', '比如说', '像之前', '打个比方'],
  },
  {
    relation: 'conclusion',
    label: '总结',
    keywords: ['总结', '核心是', '本质上', '归根结底', '简而言之', '总的来说', '关键在于'],
  },
];

const PUNCT_AND_SPACE_RE = /[\s，。？！、；：,.?!;:…~～—\-()（）「」『』“”"'`]+/g;
const LATIN_WORD_RE = /[A-Za-z0-9_]+/g;
const FACT_MARKER_RE = /(\d+(?:\.\d+)?%?|[一二三四五六七八九十]+(?:个|次|倍|年|月|天|万|亿)|「[^」]+」)/g;

/**
 * 统计口语文本的有效字数（中文按字计，连续英文/数字按词计，忽略标点空白）。
 */
export function countSpokenUnits(text: string): number {
  const cleaned = text.replace(PUNCT_AND_SPACE_RE, '');
  if (!cleaned) return 0;
  let units = 0;
  let latinMatches = 0;
  const withoutLatin = cleaned.replace(LATIN_WORD_RE, () => {
    latinMatches += 1;
    return '';
  });
  units += withoutLatin.length + latinMatches;
  return units;
}

function clampScore(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function clipText(text: string, maxLen = 44): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}…`;
}

/**
 * 对单段发言扫描口语词，返回命中列表及扣除的口语词字符数。
 */
function scanFillersInText(text: string): Array<{ def: FillerPatternDef; count: number }> {
  const hits: Array<{ def: FillerPatternDef; count: number }> = [];
  if (!text) return hits;

  // 使用掩码避免长词被短词重复统计（例如 "就是说" 避免再计入 "就是"）
  let masked = text;
  for (const def of FILLER_PATTERNS) {
    let count = 0;
    let idx = masked.indexOf(def.word);
    while (idx !== -1) {
      count += 1;
      masked =
        masked.slice(0, idx) + '□'.repeat(def.word.length) + masked.slice(idx + def.word.length);
      idx = masked.indexOf(def.word, idx + def.word.length);
    }
    if (count > 0) {
      hits.push({ def, count });
    }
  }
  return hits;
}

/**
 * 识别一段文本中最具代表性的逻辑连接关系。
 */
export function detectLogicRelation(text: string): {
  relation: 'causal' | 'contrast' | 'progression' | 'example' | 'conclusion' | null;
  label: string;
  keyword: string | null;
} {
  for (const group of LOGIC_CONNECTOR_GROUPS) {
    for (const kw of group.keywords) {
      if (text.includes(kw)) {
        return { relation: group.relation, label: group.label, keyword: kw };
      }
    }
  }
  return { relation: null, label: '陈述', keyword: null };
}

const INSIGHT_CHAR_THRESHOLD = 120;
const INSIGHT_MIN_COOLDOWN_SEC = 15;
const INSIGHT_FALLBACK_SEC = 60;
const INSIGHT_FALLBACK_MIN_CHARS = 15;

/**
 * 计算实时 AI 内容提取的上次更新时点与下轮更新预期（用于进度条展示）。
 */
export function computeInsightUpdateStatus(
  snap: Pick<
    LiveSessionSnapshot,
    | 'phase'
    | 'llmStatus'
    | 'lastInsightAt'
    | 'analyzedUpToUtteranceId'
    | 'utterances'
    | 'elapsedMs'
  >,
  nowMs: number = Date.now()
): InsightUpdateStatus {
  const lastUpdatedAt = snap.lastInsightAt ?? null;
  const lastUpdatedLabel = lastUpdatedAt
    ? new Date(lastUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '尚未生成';

  // 计算自上次分析节点之后的新增字数
  let startIdx = 0;
  if (snap.analyzedUpToUtteranceId) {
    const idx = snap.utterances.findIndex((u) => u.id === snap.analyzedUpToUtteranceId);
    if (idx !== -1) {
      startIdx = idx + 1;
    }
  }
  const pendingChars = snap.utterances
    .slice(startIdx)
    .reduce((sum, u) => sum + u.text.trim().length, 0);

  const elapsedSinceLastSec =
    lastUpdatedAt !== null
      ? Math.max(0, Math.floor((nowMs - lastUpdatedAt) / 1000))
      : snap.elapsedMs > 0
        ? Math.floor(snap.elapsedMs / 1000)
        : null;

  if (snap.llmStatus === 'disabled') {
    return {
      lastUpdatedAt,
      lastUpdatedLabel,
      elapsedSinceLastSec,
      pendingChars,
      charThreshold: INSIGHT_CHAR_THRESHOLD,
      fallbackSec: INSIGHT_FALLBACK_SEC,
      progressPct: 0,
      nextExpectedLabel: '未配置大模型，仅本地实时指标分析',
      statusTone: 'disabled',
    };
  }

  if (snap.llmStatus === 'thinking') {
    return {
      lastUpdatedAt,
      lastUpdatedLabel,
      elapsedSinceLastSec,
      pendingChars,
      charThreshold: INSIGHT_CHAR_THRESHOLD,
      fallbackSec: INSIGHT_FALLBACK_SEC,
      progressPct: 100,
      nextExpectedLabel: 'AI 正在提炼本轮洞察与观点…',
      statusTone: 'thinking',
    };
  }

  if (snap.phase !== 'recording') {
    return {
      lastUpdatedAt,
      lastUpdatedLabel,
      elapsedSinceLastSec,
      pendingChars,
      charThreshold: INSIGHT_CHAR_THRESHOLD,
      fallbackSec: INSIGHT_FALLBACK_SEC,
      progressPct: pendingChars > 0 ? Math.min(95, Math.round((pendingChars / INSIGHT_CHAR_THRESHOLD) * 100)) : 0,
      nextExpectedLabel:
        snap.phase === 'paused'
          ? '录制已暂停'
          : snap.phase === 'stopped'
            ? '录制已结束'
            : '等待开始录制',
      statusTone: 'paused',
    };
  }

  const secSinceLast = elapsedSinceLastSec ?? 0;
  const charPct = Math.min(100, Math.round((pendingChars / INSIGHT_CHAR_THRESHOLD) * 100));
  const timePct =
    pendingChars >= INSIGHT_FALLBACK_MIN_CHARS
      ? Math.min(100, Math.round((secSinceLast / INSIGHT_FALLBACK_SEC) * 100))
      : 0;
  const progressPct = Math.max(charPct, timePct);

  let nextExpectedLabel = '等待新发言输入…';
  if (pendingChars === 0) {
    nextExpectedLabel = '已同步至最新发言，等待新内容…';
  } else if (pendingChars >= INSIGHT_CHAR_THRESHOLD) {
    const waitSec = Math.max(0, INSIGHT_MIN_COOLDOWN_SEC - secSinceLast);
    nextExpectedLabel =
      waitSec > 0 ? `字数已达标，约 ${waitSec}s 后触发下轮提取` : '即将触发下轮提取…';
  } else if (pendingChars >= INSIGHT_FALLBACK_MIN_CHARS) {
    const remainChars = INSIGHT_CHAR_THRESHOLD - pendingChars;
    const remainSec = Math.max(1, INSIGHT_FALLBACK_SEC - secSinceLast);
    nextExpectedLabel = `再累积 ${remainChars} 字或约 ${remainSec}s 后更新`;
  } else {
    const remainChars = INSIGHT_CHAR_THRESHOLD - pendingChars;
    nextExpectedLabel = `已累积 ${pendingChars} 字，约还需 ${remainChars} 字触发下轮`;
  }

  return {
    lastUpdatedAt,
    lastUpdatedLabel,
    elapsedSinceLastSec,
    pendingChars,
    charThreshold: INSIGHT_CHAR_THRESHOLD,
    fallbackSec: INSIGHT_FALLBACK_SEC,
    progressPct,
    nextExpectedLabel,
    statusTone: pendingChars > 0 ? 'active' : 'idle',
  };
}

/**
 * 提取文本中的 2 字中文切片和英文/数字 token，用于节点间语义关联与提问匹配。
 */
function extractSemanticTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const cleaned = text.replace(PUNCT_AND_SPACE_RE, ' ').trim();
  if (!cleaned) return tokens;

  const latin = cleaned.match(/[A-Za-z0-9_]{2,}/g) ?? [];
  for (const w of latin) tokens.add(w.toLowerCase());

  const zhBlocks = cleaned.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const stopWords = new Set(['因为', '所以', '但是', '不过', '然后', '就是', '其实', '如果', '可以', '这个', '那个', '我们', '他们', '什么', '怎么', '一种', '进行', '通过', '已经', '现在']);
  for (const block of zhBlocks) {
    for (let i = 0; i <= block.length - 2; i++) {
      const bi = block.slice(i, i + 2);
      if (!stopWords.has(bi)) {
        tokens.add(bi);
      }
    }
  }
  return tokens;
}

function tokenOverlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const t of a) {
    if (b.has(t)) overlap += 1;
  }
  return overlap;
}

function buildLogicConnectionMap(
  utterances: LiveUtterance[],
  profile: LiveProfile,
  keyPoints: string[],
  outline: LiveOutlineItem[],
  rootTopic: string,
  questions: LiveQuestion[] = [],
  speakerLookup: Map<string, LiveSpeaker> = new Map()
): LogicConnectionMap {
  const connectorCounts = {
    causal: 0,
    contrast: 0,
    progression: 0,
    example: 0,
    conclusion: 0,
  };

  const detectedTurns: Array<{
    utt: LiveUtterance;
    relation: 'causal' | 'contrast' | 'progression' | 'example' | 'conclusion';
    label: string;
    keyword: string;
  }> = [];

  for (const u of utterances) {
    for (const group of LOGIC_CONNECTOR_GROUPS) {
      let groupMatched = false;
      for (const kw of group.keywords) {
        if (u.text.includes(kw)) {
          connectorCounts[group.relation] += 1;
          if (!groupMatched) {
            groupMatched = true;
            detectedTurns.push({
              utt: u,
              relation: group.relation,
              label: group.label,
              keyword: kw,
            });
          }
        }
      }
    }
  }

  const totalConnectors =
    connectorCounts.causal +
    connectorCounts.contrast +
    connectorCounts.progression +
    connectorCounts.example +
    connectorCounts.conclusion;

  const branches: LogicMapBranch[] = [];

  // 1. 优先展示 AI 提炼的核心观点 + 论据支点
  profile.viewpoints.slice(0, 5).forEach((vp, idx) => {
    const children: LogicMapChildNode[] = [];
    if (vp.support) {
      children.push({
        id: `vp-sup-${idx}`,
        relation: 'example',
        relationLabel: '论据支撑',
        text: clipText(vp.support, 54),
        evidenceMs: vp.evidenceMs,
      });
    }
    branches.push({
      id: `vp-${idx}`,
      kind: 'viewpoint',
      relation: 'viewpoint',
      relationLabel: '核心观点',
      title: clipText(vp.claim, 40),
      detail: vp.support ? clipText(vp.support, 60) : undefined,
      evidenceMs: vp.evidenceMs,
      children,
    });
  });

  // 2. 故事与案例分支
  profile.stories.slice(0, 3).forEach((st, idx) => {
    branches.push({
      id: `st-${idx}`,
      kind: 'story',
      relation: 'story',
      relationLabel: '案例/经历',
      title: clipText(st.title, 34),
      detail: clipText(st.gist, 56),
      evidenceMs: st.evidenceMs,
      children: st.gist
        ? [
            {
              id: `st-gist-${idx}`,
              relation: 'example',
              relationLabel: '关键脉络',
              text: clipText(st.gist, 50),
              evidenceMs: st.evidenceMs,
            },
          ]
        : [],
    });
  });

  // 3. 实时话语逻辑连接链（补充因果/转折/递进/总结等实时话语节点）
  const recentLogicTurns = detectedTurns.slice(-6);
  recentLogicTurns.forEach((item, idx) => {
    branches.push({
      id: `lt-${item.utt.id}-${idx}`,
      kind: 'utterance',
      relation: item.relation,
      relationLabel: `${item.label} · ${item.keyword}`,
      title: clipText(item.utt.text, 44),
      speakerId: item.utt.speakerId,
      evidenceMs: item.utt.startMs,
      children: [],
    });
  });

  // 4. 若暂无观点也无逻辑词，使用最近要点或提纲作为导图节点保底
  if (branches.length === 0) {
    keyPoints.slice(0, 4).forEach((kp, idx) => {
      branches.push({
        id: `kp-${idx}`,
        kind: 'outline',
        relation: 'conclusion',
        relationLabel: '要点提炼',
        title: clipText(kp, 44),
        evidenceMs: utterances[0]?.startMs ?? 0,
        children: [],
      });
    });
  }

  if (branches.length === 0 && outline.length > 0) {
    outline.slice(0, 4).forEach((ol) => {
      branches.push({
        id: `ol-${ol.id}`,
        kind: 'outline',
        relation: 'outline',
        relationLabel: ol.status === 'covered' ? '已覆盖' : ol.status === 'partial' ? '讨论中' : '待展开',
        title: clipText(ol.text, 40),
        detail: ol.note,
        evidenceMs: 0,
        children: [],
      });
    });
  }

  // ===== 构建多关系有向图（Graph） =====
  const nodes: LogicGraphNode[] = [];
  const edges: LogicGraphEdge[] = [];
  const nodeTokens = new Map<string, Set<string>>();
  const edgeKeys = new Set<string>();

  const addEdge = (
    source: string,
    target: string,
    relation: LogicGraphEdgeRelation,
    label: string,
    dashed = false
  ) => {
    if (source === target) return;
    const key = `${source}->${target}:${relation}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({
      id: `e-${edges.length + 1}`,
      source,
      target,
      relation,
      label,
      dashed,
    });
  };

  const hasContent =
    profile.viewpoints.length > 0 ||
    profile.stories.length > 0 ||
    recentLogicTurns.length > 0 ||
    keyPoints.length > 0 ||
    outline.length > 0;

  if (hasContent) {
    const topicTitle = clipText(rootTopic || '实时对话主题', 36);
    nodes.push({
      id: 'node-topic',
      kind: 'topic',
      relation: 'outline',
      relationLabel: '核心主题',
      title: topicTitle,
      evidenceMs: 0,
      tier: 0,
      expandableForQuestion: false,
    });
    nodeTokens.set('node-topic', extractSemanticTokens(topicTitle));

    const viewpointNodeIds: string[] = [];
    const storyNodeIds: string[] = [];
    const turnNodeIds: string[] = [];

    // 1) 核心观点节点 (tier 1) + 论据支点节点 (tier 3)
    profile.viewpoints.slice(0, 5).forEach((vp, idx) => {
      const vpId = `vp-${idx}`;
      viewpointNodeIds.push(vpId);
      nodes.push({
        id: vpId,
        kind: 'viewpoint',
        relation: 'viewpoint',
        relationLabel: '核心观点',
        title: clipText(vp.claim, 38),
        detail: vp.support ? clipText(vp.support, 58) : undefined,
        evidenceMs: vp.evidenceMs,
        tier: 1,
        expandableForQuestion: false,
      });
      nodeTokens.set(vpId, extractSemanticTokens(`${vp.claim} ${vp.support ?? ''}`));
      addEdge('node-topic', vpId, 'topic_link', '核心观点');

      if (vp.support) {
        const supId = `vp-sup-${idx}`;
        nodes.push({
          id: supId,
          kind: 'support',
          relation: 'example',
          relationLabel: '论据支点',
          title: clipText(vp.support, 40),
          evidenceMs: vp.evidenceMs,
          tier: 3,
          expandableForQuestion: false,
        });
        nodeTokens.set(supId, extractSemanticTokens(vp.support));
        addEdge(vpId, supId, 'support_of', '论据支撑');
      }
    });

    // 相邻观点之间如果存在语义关联或逻辑词，建立观点间连接
    for (let i = 1; i < viewpointNodeIds.length; i++) {
      const prevId = viewpointNodeIds[i - 1];
      const currId = viewpointNodeIds[i];
      const currNode = nodes.find((n) => n.id === currId);
      const rel = currNode ? detectLogicRelation(currNode.title).relation : null;
      if (rel === 'contrast' || rel === 'causal' || rel === 'progression' || rel === 'conclusion') {
        const labelMap: Record<string, string> = {
          causal: '因果推导',
          contrast: '观点转折',
          progression: '递进延伸',
          conclusion: '归纳总结',
        };
        addEdge(prevId, currId, rel, labelMap[rel] ?? '关联', rel === 'contrast');
      } else {
        const overlap = tokenOverlapScore(
          nodeTokens.get(prevId) ?? new Set(),
          nodeTokens.get(currId) ?? new Set()
        );
        if (overlap >= 1) {
          addEdge(prevId, currId, 'echo', '观点呼应', true);
        }
      }
    }

    // 2) 案例/故事节点 (tier 2) —— 可直接佐证多个观点
    profile.stories.slice(0, 3).forEach((st, idx) => {
      const stId = `st-${idx}`;
      storyNodeIds.push(stId);
      nodes.push({
        id: stId,
        kind: 'story',
        relation: 'story',
        relationLabel: '案例/经历',
        title: clipText(st.title, 34),
        detail: clipText(st.gist, 56),
        evidenceMs: st.evidenceMs,
        tier: 2,
        expandableForQuestion: false,
      });
      const stTok = extractSemanticTokens(`${st.title} ${st.gist}`);
      nodeTokens.set(stId, stTok);

      let linkedToViewpoint = false;
      for (const vpId of viewpointNodeIds) {
        const vpTok = nodeTokens.get(vpId) ?? new Set();
        const vpNode = nodes.find((n) => n.id === vpId);
        const closeInTime =
          vpNode && Math.abs(vpNode.evidenceMs - st.evidenceMs) <= 20_000;
        if (tokenOverlapScore(stTok, vpTok) >= 1 || closeInTime) {
          addEdge(stId, vpId, 'example', '案例佐证');
          linkedToViewpoint = true;
        }
      }
      if (!linkedToViewpoint) {
        addEdge('node-topic', stId, 'topic_link', '案例展开');
      }
    });

    // 3) 实时话语逻辑节点 (tier 2 / 3) —— 构建话语逻辑链与交叉语义边
    recentLogicTurns.slice(-5).forEach((item, idx) => {
      const ltId = `lt-${item.utt.id}-${idx}`;
      turnNodeIds.push(ltId);
      const spkName = speakerLookup.get(item.utt.speakerId)?.name;
      const tier = item.relation === 'conclusion' ? 3 : 2;
      nodes.push({
        id: ltId,
        kind: 'utterance',
        relation: item.relation,
        relationLabel: `${item.label} · ${item.keyword}`,
        title: clipText(item.utt.text, 42),
        speakerId: item.utt.speakerId,
        speakerName: spkName,
        evidenceMs: item.utt.startMs,
        tier,
        expandableForQuestion: false,
      });
      const ltTok = extractSemanticTokens(item.utt.text);
      nodeTokens.set(ltId, ltTok);

      let connected = false;
      // 与前一条话语逻辑节点形成逻辑流转
      if (idx > 0) {
        const prevLtId = turnNodeIds[idx - 1];
        addEdge(
          prevLtId,
          ltId,
          item.relation,
          item.label,
          item.relation === 'contrast'
        );
        connected = true;
      }

      // 与观点/案例节点建立交叉语义边（允许关联最多 2 个相关节点以体现反复呼应）
      let semanticMatches = 0;
      for (const targetId of [...viewpointNodeIds, ...storyNodeIds]) {
        const targetTok = nodeTokens.get(targetId) ?? new Set();
        if (tokenOverlapScore(ltTok, targetTok) >= 1) {
          addEdge(
            ltId,
            targetId,
            item.relation,
            item.label,
            item.relation === 'contrast'
          );
          connected = true;
          semanticMatches += 1;
          if (semanticMatches >= 2) break;
        }
      }

      if (!connected) {
        addEdge('node-topic', ltId, item.relation, item.label, item.relation === 'contrast');
      }
    });

    // 4) 若仅有提纲或要点（尚无观点/案例/逻辑话语），补充保底图节点
    if (viewpointNodeIds.length === 0 && storyNodeIds.length === 0 && turnNodeIds.length === 0) {
      if (keyPoints.length > 0) {
        keyPoints.slice(0, 4).forEach((kp, idx) => {
          const kpId = `kp-${idx}`;
          nodes.push({
            id: kpId,
            kind: 'outline',
            relation: 'conclusion',
            relationLabel: '要点提炼',
            title: clipText(kp, 40),
            evidenceMs: utterances[0]?.startMs ?? 0,
            tier: 1,
            expandableForQuestion: false,
          });
          nodeTokens.set(kpId, extractSemanticTokens(kp));
          addEdge('node-topic', kpId, 'conclusion', '要点归纳');
        });
      } else {
        outline.slice(0, 4).forEach((ol) => {
          const olId = `ol-${ol.id}`;
          nodes.push({
            id: olId,
            kind: 'outline',
            relation: 'outline',
            relationLabel:
              ol.status === 'covered' ? '已覆盖' : ol.status === 'partial' ? '讨论中' : '待展开',
            title: clipText(ol.text, 38),
            detail: ol.note,
            evidenceMs: 0,
            tier: 1,
            expandableForQuestion: ol.status !== 'covered',
            expandReason: ol.status !== 'covered' ? '提纲待展开' : undefined,
            questionHint: ol.status !== 'covered' ? `可围绕「${clipText(ol.text, 24)}」发起追问` : undefined,
          });
          nodeTokens.set(olId, extractSemanticTokens(ol.text));
          addEdge('node-topic', olId, 'topic_link', '提纲议题');
        });
      }
    }

    // 4.5) 计算节点体现/引用频次，划分非时间线(global)与时间线(timeline)泳道，并补全时间线线性主链
    const supportPartnerCount = new Map<string, Set<string>>();
    for (const e of edges) {
      if (e.relation === 'topic_link') continue;
      if (!supportPartnerCount.has(e.target)) supportPartnerCount.set(e.target, new Set());
      if (!supportPartnerCount.has(e.source)) supportPartnerCount.set(e.source, new Set());
      supportPartnerCount.get(e.target)!.add(e.source);
      if (e.relation === 'support_of' || e.relation === 'echo') {
        supportPartnerCount.get(e.source)!.add(e.target);
      }
    }

    for (const node of nodes) {
      const refCount = supportPartnerCount.get(node.id)?.size ?? 0;
      node.occurrenceCount = refCount;

      if (node.kind === 'topic' || node.kind === 'outline') {
        node.lane = 'global';
        node.isRecurring = node.kind === 'outline' && node.relation === 'conclusion';
        continue;
      }

      if (node.kind === 'viewpoint') {
        const isSummaryViewpoint = detectLogicRelation(node.title).relation === 'conclusion';
        if (refCount >= 2 || isSummaryViewpoint || node.evidenceMs <= 0) {
          node.lane = 'global';
          node.isRecurring = true;
        } else {
          node.lane = 'timeline';
          node.isRecurring = false;
        }
        continue;
      }

      node.lane = 'timeline';
      node.isRecurring = false;
    }

    const kindOrder: Record<LogicGraphNodeKind, number> = {
      topic: 0,
      outline: 1,
      viewpoint: 2,
      support: 3,
      story: 4,
      utterance: 5,
    };

    const timelinePrimary = nodes
      .filter((n) => n.lane === 'timeline' && n.kind !== 'support')
      .sort((a, b) => {
        if (a.evidenceMs !== b.evidenceMs) return a.evidenceMs - b.evidenceMs;
        return (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9);
      });

    const connectedPair = new Set<string>();
    for (const e of edges) {
      connectedPair.add(`${e.source}->${e.target}`);
      connectedPair.add(`${e.target}->${e.source}`);
    }

    for (let i = 1; i < timelinePrimary.length; i++) {
      const prev = timelinePrimary[i - 1];
      const curr = timelinePrimary[i];
      if (!connectedPair.has(`${prev.id}->${curr.id}`)) {
        addEdge(prev.id, curr.id, 'sequence', '时序推进', true);
        connectedPair.add(`${prev.id}->${curr.id}`);
      }
    }

    // 5) 高亮可作为提问拓展的节点（优先匹配 AI 提问建议，其次标记结构性深挖点）
    const activeQuestions = questions.filter((q) => q.status !== 'dismissed');
    for (const node of nodes) {
      if (node.kind === 'topic') continue;
      const nTok = nodeTokens.get(node.id) ?? new Set();

      let bestQ: LiveQuestion | null = null;
      let bestScore = 0;
      for (const q of activeQuestions) {
        const qTok = extractSemanticTokens(`${q.relatedTo} ${q.text}`);
        const score = tokenOverlapScore(nTok, qTok);
        if (score > bestScore) {
          bestScore = score;
          bestQ = q;
        }
      }

      if (bestQ && bestScore >= 1) {
        node.expandableForQuestion = true;
        node.matchedQuestionId = bestQ.id;
        node.expandReason = 'AI 建议追问';
        node.questionHint = bestQ.text;
        continue;
      }

      // 结构性可拓展节点识别
      if (node.kind === 'viewpoint' && !node.detail) {
        node.expandableForQuestion = true;
        node.expandReason = '论据待补充';
        node.questionHint = '该观点暂无具体案例或数据支撑，可追问实证细节';
      } else if (node.relation === 'contrast') {
        node.expandableForQuestion = true;
        node.expandReason = '转折深挖点';
        node.questionHint = '存在转折张力，可顺势追问原因、取舍或边界条件';
      } else if (node.relation === 'causal' && node.kind === 'utterance') {
        node.expandableForQuestion = true;
        node.expandReason = '因果延伸点';
        node.questionHint = '可追问该因果链背后的深层动因或后续影响';
      }
    }
  }

  const expandableNodeIds = nodes
    .filter((n) => n.expandableForQuestion)
    .map((n) => n.id);

  return {
    rootTopic: clipText(rootTopic || '实时对话主题', 36),
    totalConnectors,
    connectorCounts,
    branches: branches.slice(0, 10),
    nodes,
    edges,
    expandableNodeIds,
  };
}

/**
 * 基于实时录制快照计算发言习惯、语速、口语词、信息密度与逻辑连接导图。
 */
export function computeLiveSpeechAnalytics(
  snap: Pick<
    LiveSessionSnapshot,
    | 'utterances'
    | 'speakers'
    | 'profile'
    | 'keyPoints'
    | 'outline'
    | 'elapsedMs'
    | 'title'
    | 'prep'
  > & { questions?: LiveQuestion[] },
  filterSpeakerId?: string | null
): LiveSpeechAnalyticsResult {
  const allUtterances = snap.utterances;
  const utterances = filterSpeakerId
    ? allUtterances.filter((u) => u.speakerId === filterSpeakerId)
    : allUtterances;

  const speakerLookup = new Map<string, LiveSpeaker>();
  for (const s of snap.speakers) {
    speakerLookup.set(s.id, s);
  }

  // Per-speaker accumulators (always computed over allUtterances for share%)
  const spkAcc = new Map<
    string,
    { chars: number; activeMs: number; count: number; fillerCount: number }
  >();
  for (const s of snap.speakers) {
    spkAcc.set(s.id, { chars: 0, activeMs: 0, count: 0, fillerCount: 0 });
  }
  let allTotalChars = 0;
  for (const u of allUtterances) {
    const chars = countSpokenUnits(u.text);
    const dur = Math.max(400, u.endMs - u.startMs);
    const fCount = scanFillersInText(u.text).reduce((acc, h) => acc + h.count, 0);
    allTotalChars += chars;
    const prev = spkAcc.get(u.speakerId) ?? { chars: 0, activeMs: 0, count: 0, fillerCount: 0 };
    spkAcc.set(u.speakerId, {
      chars: prev.chars + chars,
      activeMs: prev.activeMs + dur,
      count: prev.count + 1,
      fillerCount: prev.fillerCount + fCount,
    });
  }

  const speakers: SpeakerSpeechSummary[] = Array.from(spkAcc.entries()).map(([id, acc]) => {
    const meta = speakerLookup.get(id);
    const activeMin = acc.activeMs / 60000;
    return {
      speakerId: id,
      name: meta?.name ?? '发言人',
      role: meta?.role ?? 'counterpart',
      utteranceCount: acc.count,
      charCount: acc.chars,
      activeMs: acc.activeMs,
      sharePct: allTotalChars > 0 ? Math.round((acc.chars / allTotalChars) * 100) : 0,
      avgCpm: activeMin > 0 ? Math.round(acc.chars / activeMin) : 0,
      fillerCount: acc.fillerCount,
      fillerPerMin: activeMin > 0 ? Number((acc.fillerCount / activeMin).toFixed(1)) : 0,
    };
  });

  // Filtered analytics
  let totalChars = 0;
  let activeMs = 0;
  let fillerCountTotal = 0;
  let fillerCharsTotal = 0;
  let factMarkerCount = 0;
  const byCategory: Record<OralFillerCategory, number> = {
    pure_filler: 0,
    starter_crutch: 0,
    hedging_tail: 0,
  };
  const wordAgg = new Map<string, OralFillerWordStat>();
  const trendPoints: PaceTrendPoint[] = [];
  const uttCpms: number[] = [];

  for (const u of utterances) {
    const chars = countSpokenUnits(u.text);
    const durMs = Math.max(400, u.endMs - u.startMs);
    const cpm = Math.min(480, Math.round((chars / durMs) * 60000));
    totalChars += chars;
    activeMs += durMs;
    if (chars >= 4) {
      uttCpms.push(cpm);
    }

    const hits = scanFillersInText(u.text);
    let uttFillers = 0;
    let uttFillerChars = 0;
    for (const h of hits) {
      uttFillers += h.count;
      uttFillerChars += h.count * h.def.word.length;
      byCategory[h.def.category] += h.count;

      const existing = wordAgg.get(h.def.word);
      if (existing) {
        existing.count += h.count;
        existing.latestMs = Math.max(existing.latestMs, u.startMs);
      } else {
        wordAgg.set(h.def.word, {
          word: h.def.word,
          category: h.def.category,
          categoryLabel: h.def.categoryLabel,
          count: h.count,
          perMin: 0,
          firstMs: u.startMs,
          latestMs: u.startMs,
        });
      }
    }
    fillerCountTotal += uttFillers;
    fillerCharsTotal += uttFillerChars;

    const facts = u.text.match(FACT_MARKER_RE);
    const factCount = facts ? facts.length : 0;
    factMarkerCount += factCount;

    const effectiveRatio = chars > 0 ? Math.max(0, (chars - uttFillerChars) / chars) : 0;
    const logicHit = detectLogicRelation(u.text).relation ? 12 : 0;
    const uttDensity = clampScore(effectiveRatio * 68 + Math.min(20, factCount * 10) + logicHit);

    trendPoints.push({
      id: u.id,
      timeMs: u.startMs,
      cpm,
      speakerId: u.speakerId,
      chars,
      densityScore: uttDensity,
      fillerCount: uttFillers,
    });
  }

  const activeMin = activeMs / 60000;
  const overallCpm = activeMin > 0 ? Math.round(totalChars / activeMin) : 0;

  // Recent 3 utterances CPM
  const recentSlice = utterances.slice(-3);
  const recentChars = recentSlice.reduce((s, u) => s + countSpokenUnits(u.text), 0);
  const recentMs = recentSlice.reduce((s, u) => s + Math.max(400, u.endMs - u.startMs), 0);
  const recentCpm = recentMs > 0 ? Math.round((recentChars / recentMs) * 60000) : 0;

  const paceStatus: SpeechPaceStats['paceStatus'] =
    utterances.length === 0
      ? 'idle'
      : overallCpm < 140
        ? 'slow'
        : overallCpm > 300
          ? 'fast'
          : 'moderate';
  const paceLabel =
    paceStatus === 'idle'
      ? '等待发言'
      : paceStatus === 'slow'
        ? '语速偏慢'
        : paceStatus === 'fast'
          ? '语速偏快'
          : '语速适中';

  let paceStdCpm = 0;
  if (uttCpms.length >= 2) {
    const mean = uttCpms.reduce((a, b) => a + b, 0) / uttCpms.length;
    const variance =
      uttCpms.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / uttCpms.length;
    paceStdCpm = Math.round(Math.sqrt(variance));
  }

  const topWords = Array.from(wordAgg.values())
    .map((item) => ({
      ...item,
      perMin: activeMin > 0 ? Number((item.count / activeMin).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const fillerPerMin = activeMin > 0 ? Number((fillerCountTotal / activeMin).toFixed(1)) : 0;
  const charRatioPct =
    totalChars > 0 ? Number(Math.min(100, (fillerCharsTotal / totalChars) * 100).toFixed(1)) : 0;

  const effectiveRatioPct =
    totalChars > 0
      ? Math.max(0, Math.round(((totalChars - fillerCharsTotal) / totalChars) * 100))
      : 0;

  const substantivePointsCount =
    snap.profile.viewpoints.length + snap.profile.stories.length + snap.keyPoints.length;
  const pointsPerMin =
    activeMin > 0 ? Number(((substantivePointsCount + factMarkerCount) / activeMin).toFixed(1)) : 0;

  const logicMap = buildLogicConnectionMap(
    utterances,
    snap.profile,
    snap.keyPoints,
    snap.outline,
    snap.title || snap.prep?.topic || '当前录制主题',
    snap.questions ?? [],
    speakerLookup
  );

  const densityScore =
    utterances.length === 0
      ? 0
      : clampScore(
          effectiveRatioPct * 0.62 +
            Math.min(20, factMarkerCount * 3 + substantivePointsCount * 4) +
            Math.min(18, logicMap.totalConnectors * 3)
        );
  const densityLevel: InfoDensityStats['level'] =
    utterances.length === 0
      ? 'idle'
      : densityScore >= 75
        ? 'high'
        : densityScore >= 50
          ? 'medium'
          : 'low';
  const densityLabel =
    densityLevel === 'idle'
      ? '待分析'
      : densityLevel === 'high'
        ? '高信息密度'
        : densityLevel === 'medium'
          ? '信息密度适中'
          : '口语冗余偏高';

  // Turn structure & habits
  let turnSwitchCount = 0;
  const mergedTurnsMs: number[] = [];
  let curSpeaker: string | null = null;
  let curTurnStart = 0;
  let curTurnEnd = 0;
  for (const u of utterances) {
    if (curSpeaker === null) {
      curSpeaker = u.speakerId;
      curTurnStart = u.startMs;
      curTurnEnd = u.endMs;
    } else if (u.speakerId === curSpeaker) {
      curTurnEnd = Math.max(curTurnEnd, u.endMs);
    } else {
      mergedTurnsMs.push(Math.max(400, curTurnEnd - curTurnStart));
      turnSwitchCount += 1;
      curSpeaker = u.speakerId;
      curTurnStart = u.startMs;
      curTurnEnd = u.endMs;
    }
  }
  if (curSpeaker !== null) {
    mergedTurnsMs.push(Math.max(400, curTurnEnd - curTurnStart));
  }

  const avgUtteranceChars =
    utterances.length > 0 ? Math.round(totalChars / utterances.length) : 0;
  const avgTurnDurationSec =
    mergedTurnsMs.length > 0
      ? Number(
          (mergedTurnsMs.reduce((a, b) => a + b, 0) / mergedTurnsMs.length / 1000).toFixed(1)
        )
      : 0;
  const maxTurnDurationSec =
    mergedTurnsMs.length > 0
      ? Number((Math.max(...mergedTurnsMs) / 1000).toFixed(1))
      : 0;

  const dominantPattern =
    utterances.length === 0
      ? '等待发言'
      : avgTurnDurationSec >= 18
        ? '长段落深度输出'
        : turnSwitchCount >= Math.max(2, Math.floor(utterances.length * 0.45))
          ? '高频交互对话'
          : '平稳叙事节奏';

  const fluencyScore = utterances.length === 0 ? 0 : clampScore(95 - fillerPerMin * 5.5);
  const paceStabilityScore =
    utterances.length === 0
      ? 0
      : clampScore(
          92 - paceStdCpm * 0.45 - (paceStatus === 'moderate' ? 0 : 12)
        );
  const concisenessScore =
    utterances.length === 0 ? 0 : clampScore(100 - charRatioPct * 3.2);
  const logicStructureScore =
    utterances.length === 0
      ? 0
      : clampScore(45 + logicMap.totalConnectors * 8 + snap.profile.viewpoints.length * 7);

  const dimensions: HabitDimension[] = [
    { key: 'fluency', label: '流畅度', score: fluencyScore },
    { key: 'paceStability', label: '语速稳健', score: paceStabilityScore },
    { key: 'conciseness', label: '语言精炼', score: concisenessScore },
    { key: 'infoDensity', label: '信息密度', score: densityScore },
    { key: 'logicStructure', label: '逻辑结构', score: logicStructureScore },
  ];

  const tags: HabitTag[] = [];
  if (utterances.length > 0) {
    if (paceStatus === 'moderate') {
      tags.push({
        label: `语速适中 (${overallCpm} 字/分)`,
        tone: 'good',
        detail: '处于 140–300 字/分舒适区间，听感清晰',
      });
    } else if (paceStatus === 'fast') {
      tags.push({
        label: `语速偏快 (${overallCpm} 字/分)`,
        tone: 'warn',
        detail: '建议在核心观点处适当放慢或增加短停顿',
      });
    } else if (paceStatus === 'slow') {
      tags.push({
        label: `语速偏慢 (${overallCpm} 字/分)`,
        tone: 'info',
        detail: '节奏偏舒缓，适合解释复杂概念',
      });
    }

    if (topWords.length > 0 && fillerPerMin >= 4) {
      tags.push({
        label: `高频口语词「${topWords[0].word}」`,
        tone: 'warn',
        detail: `已出现 ${topWords[0].count} 次（约 ${fillerPerMin} 次/分）`,
      });
    } else if (fillerCountTotal <= 2 && activeMin >= 0.3) {
      tags.push({
        label: '表达干练少口癖',
        tone: 'good',
        detail: '几乎无冗余口语连接词',
      });
    }

    if (logicMap.totalConnectors >= 3) {
      tags.push({
        label: `逻辑连接丰富 (${logicMap.totalConnectors} 处)`,
        tone: 'good',
        detail: '善用因果、转折或递进词组织表达',
      });
    }

    if (avgTurnDurationSec >= 20) {
      tags.push({
        label: `单轮输出较长 (${avgTurnDurationSec}s)`,
        tone: 'info',
        detail: '适合做阶段性要点小结',
      });
    }
  }

  return {
    totalChars,
    activeMs,
    utteranceCount: utterances.length,
    speakers,
    pace: {
      overallCpm,
      recentCpm,
      paceStatus,
      paceLabel,
      paceStdCpm,
      trendPoints: trendPoints.slice(-20),
    },
    fillers: {
      totalCount: fillerCountTotal,
      perMin: fillerPerMin,
      charRatioPct,
      byCategory,
      topWords,
    },
    density: {
      score: densityScore,
      level: densityLevel,
      levelLabel: densityLabel,
      effectiveRatioPct,
      substantivePointsCount,
      pointsPerMin,
      factMarkerCount,
    },
    habits: {
      avgUtteranceChars,
      avgTurnDurationSec,
      maxTurnDurationSec,
      turnSwitchCount,
      dominantPattern,
      dimensions,
      tags,
    },
    logicMap,
  };
}
