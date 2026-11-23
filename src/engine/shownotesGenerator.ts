import {
  CartoonAvatarStyle,
  ListenerBenefitItem,
  LotteryDrawCondition,
  PodcastProjectState,
  PodcastShownotes,
  ShownotesActivityInfo,
  ShownotesGuest,
  ShownotesReferenceCategory,
  ShownotesReferenceItem,
  ShownotesTimelineItem,
  ShownotesTitleOption,
  SpeakerRole,
  SpeakerTrack,
} from '../types/podcast';
import { TimelineComputation } from './timelineEngine';
import type { SidecarShownotesPayload } from './tauriBridge';

const AVATAR_STYLES: CartoonAvatarStyle[] = [
  'mic',
  'headphones',
  'glasses',
  'spark',
  'cat',
  'astro',
];

const AVATAR_BG_COLORS = [
  '#3b82f6',
  '#f59e0b',
  '#10b981',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
];

export const DRAW_CONDITION_LABELS: Record<LotteryDrawCondition, string> = {
  comment_like: '评论区走心留言 + 点赞最高',
  keyword_reply: '评论区回复指定暗号',
  random_comment: '评论区随机抽取幸运听友',
  share_screenshot: '转发本期节目并截图至听友群',
};

export const REFERENCE_CATEGORY_LABELS: Record<ShownotesReferenceCategory, string> = {
  book: '书籍',
  movie: '影视/纪录片',
  article: '文章/论文',
  tool: '工具/产品',
  person: '提及人物',
  other: '延伸资料',
};

export function normalizeReferenceCategory(raw?: string): ShownotesReferenceCategory {
  if (
    raw === 'book' ||
    raw === 'movie' ||
    raw === 'article' ||
    raw === 'tool' ||
    raw === 'person' ||
    raw === 'other'
  ) {
    return raw;
  }
  return 'other';
}

export function getRoleDisplayLabel(role: SpeakerRole): string {
  if (role === 'host') return '主持人';
  if (role === 'co_host') return '常驻主播';
  if (role === 'guest') return '飞行嘉宾';
  if (role === 'bgm') return 'BGM 垫乐';
  return '参考轨';
}

export function countSummaryChars(text: string): number {
  return text.replace(/\s+/g, '').length;
}

export function formatTimecode(sec: number, includeHours = true): string {
  const safe = Math.max(0, Math.floor(sec));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const rem = safe % 60;
  if (includeHours || hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function composeTimelineLineText(t: ShownotesTimelineItem): string {
  const title = (t.title || '').trim();
  const summary = (t.summary || '').trim();

  if (title && summary && !title.includes(summary)) {
    if (title.endsWith('：') || title.endsWith(':')) {
      return `${title}${summary}`;
    }
    if (title.includes('：') || title.includes(':')) {
      return `${title} ${summary}`;
    }
    return `${title}：${summary}`;
  }
  return title || summary || '核心议题展开';
}

/**
 * 格式化标准播客智能大纲与时间轴单行输出
 * 严格遵循《智能大纲规范》：
 * 1. 时间戳与标题之间用一个英文空格隔开，拒绝破折号或多余括号；
 * 2. 标题结构公式：[核心主题/观点] + [具体细节/金句/反常识点]；
 * 3. 字数控制：精炼控制在 12～25 个汉字之间。
 */
export function formatTimelineRow(t: ShownotesTimelineItem, preferShortTime = false): string {
  const timeStr = formatTimecode(t.timeSec, !preferShortTime);
  let lineText = composeTimelineLineText(t);

  // 整理字数，力求精炼口语化并保持在 12~25 字区间
  if (lineText.length > 28) {
    lineText = `${lineText.slice(0, 27)}…`;
  }

  return `${timeStr} ${lineText}`;
}

/**
 * 格式化 Shownotes 节目时间轴单行输出：完整保留高信息密度案例、对比与钩子，不做 28 字截断。
 */
export function formatShownotesTimelineRow(
  t: ShownotesTimelineItem,
  preferShortTime = false
): string {
  const timeStr = formatTimecode(t.timeSec, !preferShortTime);
  const lineText = composeTimelineLineText(t);
  return `${timeStr} ${lineText}`;
}

/**
 * 导出标准智能大纲时间轴纯列表文本（直接可贴小宇宙、Apple Podcasts）
 */
export function formatPodcastTimestamps(timeline: ShownotesTimelineItem[]): string {
  const sorted = [...timeline].sort((a, b) => a.timeSec - b.timeSec);
  const hasOverHour = sorted.some((item) => item.timeSec >= 3600);
  // 若未超过一小时，采用 MM:SS 格式；超过一小时统一使用 HH:MM:SS (如 00:12:30)
  return sorted.map((t) => formatTimelineRow(t, !hasOverHour)).join('\n');
}

export interface NaturalContentSegment {
  segmentIndex: number;
  startSec: number;
  timeLabel: string;
  chapterTitles: string[];
  excerpt: string;
}

const TARGET_MIN_SEGMENTS = 6;
const TARGET_MAX_SEGMENTS = 15;

const TOPIC_SHIFT_REGEX =
  /^(接下来|说到这|另外|那么|顺便|第二个|第三个|最后|总结一下|回到|再说说|顺着这个)/;

interface RawUtteranceUnit {
  startSec: number;
  endSec: number;
  speakerName: string;
  chapterTitle: string;
  text: string;
  hasTopicShift: boolean;
}

/**
 * 根据内容语义、章节变化与对话节奏自然分割节目内容，目标大致 8-20 个分段。
 */
export function buildNaturalContentSegments(
  state: PodcastProjectState,
  timeline: TimelineComputation
): NaturalContentSegment[] {
  const speakerMap = Object.fromEntries(state.tracks.map((t) => [t.id, t.name]));
  const blockMap = Object.fromEntries(state.blocks.map((b) => [b.blockId, b]));

  // 1. 先按 block / 说话人连续片段提取自然话语单元
  const rawUnits: RawUtteranceUnit[] = [];
  let current: {
    blockId: string;
    speakerId: string;
    startSec: number;
    endSec: number;
    chars: string[];
  } | null = null;

  const flushUnit = () => {
    if (!current) return;
    const text = current.chars.join('').replace(/\[语音 [^\]]+\]/g, '').trim();
    if (text) {
      const ch = blockMap[current.blockId]?.chapterTitle?.trim() || '';
      rawUnits.push({
        startSec: current.startSec,
        endSec: current.endSec,
        speakerName: speakerMap[current.speakerId] ?? '发言人',
        chapterTitle: ch,
        text,
        hasTopicShift: TOPIC_SHIFT_REGEX.test(text),
      });
    }
    current = null;
  };

  for (const m of timeline.mappedTokens) {
    if (!blockMap[m.blockId] || m.token.deleted || m.token.type !== 'word') continue;
    const wordText = m.token.bleeped ? '[***]' : m.token.text;

    if (
      !current ||
      current.blockId !== m.blockId ||
      current.speakerId !== m.speakerId
    ) {
      flushUnit();
      current = {
        blockId: m.blockId,
        speakerId: m.speakerId,
        startSec: Math.max(0, m.editedStartSec),
        endSec: Math.max(0, m.editedEndSec),
        chars: [wordText],
      };
    } else {
      current.endSec = Math.max(current.endSec, m.editedEndSec);
      current.chars.push(wordText);
    }
  }
  flushUnit();

  if (rawUnits.length === 0) return [];

  // 2. 若话语单元很少但单段很长（例如少于8段但总字数足够），按句末标点拆分为更细的自然句段
  let workingUnits: RawUtteranceUnit[] = [];
  if (rawUnits.length < TARGET_MIN_SEGMENTS) {
    for (const u of rawUnits) {
      const sentences = u.text
        .split(/(?<=[。！？!?])\s*/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 6);
      if (sentences.length > 1 && u.endSec - u.startSec >= 20) {
        const totalLen = sentences.reduce((acc, s) => acc + s.length, 0) || 1;
        let cursor = u.startSec;
        const dur = Math.max(1, u.endSec - u.startSec);
        for (let i = 0; i < sentences.length; i++) {
          const s = sentences[i];
          const sliceDur = (s.length / totalLen) * dur;
          workingUnits.push({
            startSec: cursor,
            endSec: cursor + sliceDur,
            speakerName: u.speakerName,
            chapterTitle: u.chapterTitle,
            text: s,
            hasTopicShift: TOPIC_SHIFT_REGEX.test(s),
          });
          cursor += sliceDur;
        }
      } else {
        workingUnits.push(u);
      }
    }
  } else {
    workingUnits = [...rawUnits];
  }

  // 3. 按章节切换与话题转换词先聚合成自然语义组
  interface Group {
    startSec: number;
    endSec: number;
    chapterTitles: string[];
    lines: string[];
    charCount: number;
  }

  const groups: Group[] = [];
  for (const u of workingUnits) {
    const prev = groups[groups.length - 1];
    const prevChapter = prev?.chapterTitles[prev.chapterTitles.length - 1] || '';
    const chapterChanged = Boolean(u.chapterTitle && prev && u.chapterTitle !== prevChapter);

    const shouldStartNew =
      !prev ||
      chapterChanged ||
      (u.hasTopicShift && prev.charCount >= 40) ||
      prev.charCount >= 260;

    if (shouldStartNew) {
      groups.push({
        startSec: u.startSec,
        endSec: u.endSec,
        chapterTitles: u.chapterTitle ? [u.chapterTitle] : [],
        lines: [`[${u.speakerName}]: ${u.text}`],
        charCount: u.text.length,
      });
    } else {
      prev.endSec = Math.max(prev.endSec, u.endSec);
      if (u.chapterTitle && !prev.chapterTitles.includes(u.chapterTitle)) {
        prev.chapterTitles.push(u.chapterTitle);
      }
      prev.lines.push(`[${u.speakerName}]: ${u.text}`);
      prev.charCount += u.text.length;
    }
  }

  // 4. 若分段数仍超过 20，优先合并相邻字数最少的分段，收敛到 <= 20 个（目标约 12-18 个）
  while (groups.length > TARGET_MAX_SEGMENTS) {
    let bestIdx = 0;
    let bestScore = Infinity;
    for (let i = 0; i < groups.length - 1; i++) {
      const a = groups[i];
      const b = groups[i + 1];
      const sameChapter =
        a.chapterTitles.length > 0 &&
        b.chapterTitles.length > 0 &&
        a.chapterTitles[a.chapterTitles.length - 1] === b.chapterTitles[0];
      const penalty = sameChapter ? 0 : 120;
      const score = a.charCount + b.charCount + penalty;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const left = groups[bestIdx];
    const right = groups[bestIdx + 1];
    const mergedChapters = [...left.chapterTitles];
    for (const ct of right.chapterTitles) {
      if (!mergedChapters.includes(ct)) mergedChapters.push(ct);
    }
    groups.splice(bestIdx, 2, {
      startSec: left.startSec,
      endSec: Math.max(left.endSec, right.endSec),
      chapterTitles: mergedChapters,
      lines: [...left.lines, ...right.lines],
      charCount: left.charCount + right.charCount,
    });
  }

  // 5. 若分段数少于 8 个且仍有包含多条句子的组，适度拆分最长组以贴近 8-20 区间
  let safety = 0;
  while (groups.length < TARGET_MIN_SEGMENTS && safety < 16) {
    safety++;
    let maxIdx = -1;
    let maxLines = 1;
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].lines.length > maxLines) {
        maxLines = groups[i].lines.length;
        maxIdx = i;
      }
    }
    if (maxIdx === -1) break;
    const target = groups[maxIdx];
    const mid = Math.ceil(target.lines.length / 2);
    const totalDur = Math.max(1, target.endSec - target.startSec);
    const splitSec = target.startSec + totalDur * (mid / target.lines.length);
    const firstHalf = target.lines.slice(0, mid);
    const secondHalf = target.lines.slice(mid);
    groups.splice(
      maxIdx,
      1,
      {
        startSec: target.startSec,
        endSec: splitSec,
        chapterTitles: target.chapterTitles,
        lines: firstHalf,
        charCount: firstHalf.join('').length,
      },
      {
        startSec: splitSec,
        endSec: target.endSec,
        chapterTitles: target.chapterTitles,
        lines: secondHalf,
        charCount: secondHalf.join('').length,
      }
    );
  }

  return groups.map((g, idx) => {
    const startSec = Math.max(0, Math.round(g.startSec));
    return {
      segmentIndex: idx,
      startSec,
      timeLabel: formatTimecode(startSec),
      chapterTitles: g.chapterTitles,
      excerpt: g.lines.join('\n').slice(0, 600),
    };
  });
}

/**
 * 清理文字稿中的所有标签与内部标记（如 [说话人]:、[语音 ...]、[停顿]、[笑声]、[***]、<|...|> 等），
 * 输出纯净的播客对话文本供 AI 生成 Shownotes。
 */
export function stripTranscriptTagsForAi(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/<\|[^|>]+\|>/g, '')
    .replace(/\[[^\]]+\][:：]?\s*/g, '')
    .replace(/[😂]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * 为云端 AI 生成 Shownotes 构建纯净文字稿分段（仅保留时间点与纯净对话文本，不带任何标签或标记）。
 */
export function buildCleanContentSegmentsForAi(
  state: PodcastProjectState,
  timeline: TimelineComputation
): NaturalContentSegment[] {
  const segments = buildNaturalContentSegments(state, timeline);
  return segments
    .map((seg) => ({
      ...seg,
      chapterTitles: [],
      excerpt: stripTranscriptTagsForAi(seg.excerpt),
    }))
    .filter((seg) => seg.excerpt.length > 0);
}

/**
 * 格式化标准 SRT 时间戳（HH:MM:SS,mmm）。
 */
export function formatSrtTimestamp(sec: number): string {
  const safeMs = Math.max(0, Math.round(sec * 1000));
  const hrs = Math.floor(safeMs / 3_600_000);
  const mins = Math.floor((safeMs % 3_600_000) / 60_000);
  const secs = Math.floor((safeMs % 60_000) / 1000);
  const ms = safeMs % 1000;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * 构建纯 SRT 格式的录音转文字内容（仅包含序号、SRT 时间轴与纯净转写句子，不包含单字列表、说话人标签或剪辑分析信息）。
 */
export function buildPureSrtTranscript(
  state: PodcastProjectState,
  timeline: TimelineComputation
): string {
  const blockIds = new Set(state.blocks.map((b) => b.blockId));
  const cues: Array<{ startSec: number; endSec: number; text: string }> = [];

  let current: {
    startSec: number;
    endSec: number;
    parts: string[];
    charLen: number;
  } | null = null;

  const flushCue = () => {
    if (!current) return;
    const text = stripTranscriptTagsForAi(current.parts.join(''));
    if (text) {
      cues.push({
        startSec: current.startSec,
        endSec: Math.max(current.startSec + 0.2, current.endSec),
        text,
      });
    }
    current = null;
  };

  for (const m of timeline.mappedTokens) {
    if (!blockIds.has(m.blockId) || m.token.deleted || m.token.bleeped || m.token.type !== 'word') {
      continue;
    }
    const cleanWord = stripTranscriptTagsForAi(m.token.text);
    if (!cleanWord) continue;

    const startSec = Math.max(0, m.editedStartSec);
    const endSec = Math.max(startSec, m.editedEndSec);
    const gapExceeded = current ? startSec - current.endSec > 1.5 : false;

    if (!current || gapExceeded) {
      flushCue();
      current = {
        startSec,
        endSec,
        parts: [cleanWord],
        charLen: cleanWord.length,
      };
    } else {
      current.endSec = Math.max(current.endSec, endSec);
      current.parts.push(cleanWord);
      current.charLen += cleanWord.length;
    }

    // 保持自然的句子级 SRT 粒度（18~60字），既有精细时间分布又避免 1~3 字碎块
    if (
      current &&
      ((current.charLen >= 18 && /[。！？!?]$/.test(cleanWord)) || current.charLen >= 60)
    ) {
      flushCue();
    }
  }
  flushCue();

  // 若 timeline.mappedTokens 未产出有效字幕（例如尚未计算时间轴），兜底直接从 state.blocks 提取真实转写文本
  if (cues.length === 0 && state.blocks.length > 0) {
    for (const block of state.blocks) {
      const validTokens = block.tokens.filter(
        (t) => !t.deleted && !t.bleeped && t.type !== 'silence' && t.type !== 'laughter'
      );
      const text = stripTranscriptTagsForAi(validTokens.map((t) => t.text).join(''));
      if (!text) continue;
      const startSec = Math.max(0, (validTokens[0]?.sourceStartMs ?? 0) / 1000);
      const endSec = Math.max(
        startSec + 0.2,
        (validTokens[validTokens.length - 1]?.sourceEndMs ?? startSec * 1000 + 1000) / 1000
      );
      cues.push({ startSec, endSec, text });
    }
  }

  return cues
    .map(
      (cue, idx) =>
        `${idx + 1}\n${formatSrtTimestamp(cue.startSec)} --> ${formatSrtTimestamp(cue.endSec)}\n${cue.text}`
    )
    .join('\n\n');
}

const GENERIC_CHAPTER_RE = /^(章节|话题|分段|第\d+段)\s*\d*$/;
const LEADING_FILLER_RE =
  /^(嗯+|啊+|呃+|哦+|对对对|是的|没错|那个|就是说|其实吧|然后呢|怎么说呢|说白了|你看|听我说)[，,、\s]*/g;

const TIMELINE_THEME_RULES: Array<{ theme: string; pattern: RegExp }> = [
  { theme: '听友福利', pattern: /福利|内测|共创|抽奖|赠送|扫码|进群|免费领|口令/ },
  { theme: '嘉宾履历', pattern: /出身|毕业|履历|从业|年入行|当年|背景|经历|创始人/ },
  { theme: '维度对比', pattern: /区别|对比|差异|相比|不同之处|而不是|而非|反而/ },
  { theme: '实战案例', pattern: /案例|故事|举例|那次|当时|有个客户|大姐|朋友|亲测/ },
  { theme: '商业模式', pattern: /商业模式|盈利|变现|版权|定价|交付|标准|规模化|营收/ },
  { theme: '团队赋能', pattern: /团队|招聘|面试|新人|赋能|管理|培养|筛选|带教/ },
  { theme: '底层逻辑', pattern: /底层|逻辑|本质|核心原因|驱动力|为什么|归根结底|关键在于/ },
  { theme: '设计心法', pattern: /心法|设计|以终为始|框架|体系|方法论|四步|三大/ },
  { theme: '落地闭环', pattern: /落地|闭环|朋友圈|裂变|破冰|追踪|转化|复购|执行/ },
  { theme: '细节巧思', pattern: /细节|巧思|伴手礼|仪式感|心锚|体验感|第四面墙/ },
  { theme: '行业洞察', pattern: /行业|趋势|痛点|传统|破局|内卷|骗局|现状|洗脑/ },
  { theme: '未来展望', pattern: /未来|展望|AI时代|壁垒|跨界|趋势|接下来|十年/ },
];

function stripSpeakerAndFillers(raw: string): string {
  return raw
    .replace(/\[[^\]]+\]:\s*/g, '')
    .replace(/^(?:主持人|嘉宾|主播|[\u4e00-\u9fa5]{1,6})(?:说|表示|提到|分享)?[：:]\s*/g, '')
    .replace(/\[语音 [^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_FILLER_RE, '')
    .trim();
}

function synthesizeClauseToSummary(raw: string, theme: string): string {
  let text = raw
    .replace(/[“"『』”]/g, '')
    .replace(/^(?:我|我们|大家都|很多人|听众朋友们|我个人|其实我|我觉得|我认为|我感觉|我们当时|我们后来|大家可能)[，,\s]*/g, '')
    .replace(/^(?:今天|这次|首先|然后|接着|后来|最后|那么|实际上)[，,\s]*/g, '')
    .replace(/(?:啊|呀|呢|吧|啦|哈|嘛|哦|喔)+$/g, '')
    .replace(/(?:我觉得|我认为|就是说|怎么说呢|说实话|坦白讲|大体上|基本上|所谓的一件事)/g, '')
    .trim();

  // 若以“好奇...的区别”开头，改写为“对比...的本质区别”
  if (/^好奇(.+)的区别/i.test(text)) {
    text = text.replace(/^好奇(.+)的区别/, '对比$1的本质区别');
  }
  // 若包含“本质上是”，净化为“剖析其本质在于”
  if (/本质上是(.+)/.test(text)) {
    text = text.replace(/本质上是/, '剖析其本质在于');
  }

  // 若句子开头缺乏动词，根据主题前置专业概括动词，杜绝原话生硬截取
  const startsWithVerb = /^(?:剖析|探讨|分析|对比|复盘|拆解|分享|阐释|梳理|揭示|介绍|回顾|盘点|总结)/.test(text);
  if (!startsWithVerb) {
    if (/履历|经历|背景|科班|入行|创立/.test(text) || theme === '嘉宾履历') {
      text = `分享${text}`;
    } else if (/对比|区别|差异|不同/.test(text) || theme === '维度对比') {
      text = `对比分析${text}`;
    } else if (/原因|底层|本质|为什么|关键在于/.test(text) || theme === '底层逻辑') {
      text = `深度剖析${text}`;
    } else if (/当时|那次|后来|决定|踩坑|弯路/.test(text) || theme === '实战案例' || theme === '实践复盘') {
      text = `复盘${text}`;
    } else if (/方法|框架|四步|体系|模型/.test(text) || theme === '设计心法') {
      text = `拆解${text}`;
    } else if (/未来|趋势|接下来|展望/.test(text) || theme === '未来展望') {
      text = `展望${text}`;
    } else {
      text = `探讨${text}`;
    }
  }

  if (text.length > 44) {
    text = `${text.slice(0, 42)}…`;
  }
  return text;
}

function summarizeSegmentForTimeline(
  seg: NaturalContentSegment,
  totalSegments: number,
  glossaryWords: string[]
): { title: string; summary: string } {
  const rawLines = seg.excerpt
    .split(/\n+/)
    .map(stripSpeakerAndFillers)
    .filter((l) => l.length >= 4);

  const combinedText = rawLines.join(' ').trim();

  // 1. 提炼 4-6 字主题标签（优先使用有意义的章节名，否则结合位置与语义分类）
  const meaningfulChapter = seg.chapterTitles.find(
    (c) => c.trim().length >= 2 && !GENERIC_CHAPTER_RE.test(c.trim())
  );
  let theme = '';
  if (meaningfulChapter) {
    theme = meaningfulChapter.trim().slice(0, 8);
  } else if (seg.segmentIndex === 0 && !/福利|抽奖/.test(combinedText)) {
    theme = /履历|出身|毕业|经历/.test(combinedText) ? '嘉宾履历' : '开场介绍';
  } else if (
    seg.segmentIndex === totalSegments - 1 &&
    /福利|内测|抽奖|进群|关注|感谢/.test(combinedText)
  ) {
    theme = '听友福利';
  } else {
    const matched = TIMELINE_THEME_RULES.find((r) => r.pattern.test(combinedText));
    if (matched) {
      theme = matched.theme;
    } else {
      const fallbacks = ['核心观点', '深度拆解', '对谈焦点', '实践复盘', '观点交锋'];
      theme = fallbacks[seg.segmentIndex % fallbacks.length];
    }
  }

  // 2. 从整段中提炼核心语义分句并合成为专业主旨概括，绝非原话直接机械摘抄
  const clauses = combinedText
    .split(/[。！？!?\n；;]+/)
    .map((c) => c.replace(LEADING_FILLER_RE, '').trim())
    .filter((c) => c.length >= 6);

  if (clauses.length === 0) {
    return {
      title: theme,
      summary: combinedText ? synthesizeClauseToSummary(combinedText, theme) : '围绕本节核心话题展开深入交流与观点提炼',
    };
  }

  const scoreClause = (clause: string, idx: number): number => {
    let score = 0;
    if (/\d+|%/.test(clause)) score += 4;
    if (/所以|核心|关键|本质|总结|对比|区别|而是|因为|从.+到/.test(clause)) score += 4;
    if (glossaryWords.some((gw) => gw && clause.includes(gw))) score += 3;
    if (clause.length >= 12 && clause.length <= 36) score += 3;
    else if (clause.length > 36) score += 1;
    // 偏好段落中后部的总结与反思性分句
    if (idx > 0) score += 1;
    return score;
  };

  const ranked = clauses
    .map((text, idx) => ({ text, idx, score: scoreClause(text, idx) }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx);

  const bestClause = ranked[0]?.text || combinedText;
  const synthesizedDigest = synthesizeClauseToSummary(bestClause, theme);

  return {
    title: theme,
    summary: synthesizedDigest,
  };
}

/**
 * 从当前精剪时间轴与内容提取 Shownotes 时间轴列表（根据内容自然分割，大致 8-20 个分段）。
 */
export function buildTimelineItemsFromProject(
  state: PodcastProjectState,
  timeline: TimelineComputation
): ShownotesTimelineItem[] {
  const items: ShownotesTimelineItem[] = [];
  const hasColdOpen = state.coldOpenEnabled && state.highlights.length > 0;
  const glossaryWords = (state.glossary ?? []).map((g) => g.word.trim()).filter(Boolean);

  if (hasColdOpen) {
    const firstHl = state.highlights[0];
    const snippet = firstHl.text.replace(/\s+/g, '').slice(0, 26);
    items.push({
      id: 'tl_cold_open',
      timeSec: 0,
      title: '高光片头',
      summary: snippet ? `${snippet}${firstHl.text.length > 26 ? '…' : ''}` : '本期精彩抢先听',
    });
  }

  const segments = buildNaturalContentSegments(state, timeline);
  for (const seg of segments) {
    let timeSec = seg.startSec;
    if (hasColdOpen && seg.segmentIndex === 0 && timeSec === 0) {
      timeSec = 1;
    }

    const { title, summary } = summarizeSegmentForTimeline(
      seg,
      segments.length,
      glossaryWords
    );

    items.push({
      id: `tl_seg_${seg.segmentIndex}`,
      timeSec,
      title,
      summary,
    });
  }

  if (items.length === 0 && timeline.totalEditedDurationSec > 0) {
    items.push({
      id: 'tl_start',
      timeSec: 0,
      title: '开场介绍',
      summary: '本期对谈开场与核心议题引入',
    });
  }

  return items;
}

/**
 * 从多轨音轨同步嘉宾列表，保留用户自定义排序、联系方式、多社交账户与卡通头像配置。
 */
export function buildGuestsFromTracks(
  tracks: SpeakerTrack[],
  existingGuests: ShownotesGuest[] = []
): ShownotesGuest[] {
  const activeTracks = tracks.some((t) => !t.isRef)
    ? tracks.filter((t) => !t.isRef)
    : tracks;

  const trackById = new Map(activeTracks.map((t) => [t.id, t]));
  const seenTrackIds = new Set<string>();

  // 1. 保留 existingGuests 的自定义排序并同步音轨最新姓名与角色
  const orderedExisting: ShownotesGuest[] = existingGuests.map((g) => {
    if (g.trackId && trackById.has(g.trackId)) {
      seenTrackIds.add(g.trackId);
      const tr = trackById.get(g.trackId)!;
      return {
        ...g,
        name: tr.name,
        roleLabel: getRoleDisplayLabel(tr.role),
      };
    }
    return g;
  });

  // 2. 追加尚未出现在 existingGuests 中的新音轨嘉宾
  const newlyAdded: ShownotesGuest[] = activeTracks
    .filter((tr) => !seenTrackIds.has(tr.id))
    .map((tr, idx) => ({
      id: `guest_${tr.id}`,
      trackId: tr.id,
      name: tr.name,
      roleLabel: getRoleDisplayLabel(tr.role),
      bio: tr.role === 'host' ? '播客主理人 / 本期主持' : '特邀嘉宾 / 深度分享',
      contact: '',
      socialAccount: '',
      socialAccounts: [],
      avatarStyle: AVATAR_STYLES[idx % AVATAR_STYLES.length],
      avatarBgColor: tr.color || AVATAR_BG_COLORS[idx % AVATAR_BG_COLORS.length],
      avatarSeed: `${tr.name}_${idx}`,
    }));

  return [...orderedExisting, ...newlyAdded];
}

export function formatGuestWechat(contact: string): string {
  const trimmed = contact.trim();
  if (!trimmed) return '';
  if (/^微信[:：]/.test(trimmed)) return trimmed;
  return `微信：${trimmed}`;
}

export function formatGuestBioTags(bio?: string): string {
  const trimmed = (bio ?? '').trim();
  if (!trimmed) return '';
  return trimmed
    .split(/[/｜|、,，]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' / ');
}

export function formatGuestSocialSummary(
  guest: ShownotesGuest,
  markdown = false
): string {
  const list = (guest.socialAccounts ?? []).filter(
    (s) => s.platform.trim() || s.handle.trim() || (s.url && s.url.trim())
  );
  if (list.length > 0) {
    return list
      .map((s) => {
        const label = [s.platform.trim(), s.handle.trim()].filter(Boolean).join(' ');
        const url = s.url?.trim();
        if (url) {
          return markdown ? `[${label || url}](${url})` : `${label ? `${label} ` : ''}(${url})`;
        }
        return label;
      })
      .filter(Boolean)
      .join(' · ');
  }
  return guest.socialAccount.trim();
}

export function sanitizeShownotesSynthesizedText(
  raw: string,
  preserveConceptQuotes = false
): string {
  if (!raw) return '';
  let text = raw
    .replace(/分享了关于[“"『]([^”"』]+)[”"』]的思考/g, '深入探讨了$1的核心议题')
    .replace(/[“"『]([^”"』]{10,})[”"』]/g, '$1');
  if (!preserveConceptQuotes) {
    text = text.replace(/[“”""]/g, '');
  }
  return text.trim();
}

/**
 * 基于项目主题、核心章节与嘉宾信息，生成 3 种不同风格的备选单集标题（本地离线版）。
 */
export function buildLocalTitleOptions(
  state: PodcastProjectState,
  guests: ShownotesGuest[],
  timelineItems: ShownotesTimelineItem[]
): ShownotesTitleOption[] {
  const baseTitle = (state.projectTitle || '本期对谈').trim();
  const meaningfulChapters = timelineItems.filter(
    (item) => !/高光片头|听友福利|活动抽奖|开场介绍/.test(item.title)
  );
  const coreTopic =
    meaningfulChapters[0]?.title ||
    state.glossary.find((g) => g.type === 'hotword')?.word ||
    baseTitle;
  const guestNames = guests
    .filter((g) => g.roleLabel !== '主持人')
    .map((g) => g.name)
    .slice(0, 2)
    .join('、');

  return [
    {
      style: 'pain_point',
      label: '悬念/痛点型',
      title: `${coreTopic}背后：为什么大多数人都在这里踩了坑？`,
    },
    {
      style: 'insight',
      label: '干货/金句型',
      title: baseTitle,
    },
    {
      style: 'narrative',
      label: '温和/陪伴型',
      title: guestNames
        ? `与 ${guestNames} 聊 ${coreTopic}：那些一线实践里的真实取舍`
        : `关于 ${coreTopic} 的深度对谈：在不确定中寻找确定性`,
    },
  ];
}

/**
 * 从脱敏后的文字稿中提取明确提及的书影音/延伸资料（若无则返回空数组）。
 */
export function extractLocalReferences(state: PodcastProjectState): ShownotesReferenceItem[] {
  const projectTitle = (state.projectTitle || '').trim();
  const fullText = state.blocks
    .map((b) =>
      b.tokens
        .filter((t) => !t.deleted && t.type !== 'silence' && t.type !== 'laughter')
        .map((t) => (t.bleeped ? '[***]' : t.text))
        .join('')
    )
    .join('\n');

  const seen = new Set<string>();
  const refs: ShownotesReferenceItem[] = [];
  const bookMatches = fullText.matchAll(/《([^《》\n]{2,30})》/g);
  for (const match of bookMatches) {
    const title = match[1].trim();
    if (!title || title === projectTitle || title.includes('[***]')) continue;
    if (seen.has(title)) continue;
    seen.add(title);

    const matchIdx = match.index ?? 0;
    const beforeCtx = fullText.slice(Math.max(0, matchIdx - 10), matchIdx);
    const afterCtx = fullText.slice(
      matchIdx + match[0].length,
      Math.min(fullText.length, matchIdx + match[0].length + 6)
    );
    const nearCtx = `${beforeCtx}${afterCtx}`;
    let category: ShownotesReferenceCategory = 'book';
    if (/这本书|一书|原著|书单/.test(afterCtx) || /读过|推荐.*书/.test(beforeCtx)) {
      category = 'book';
    } else if (/电影|纪录片|影片|剧集|导演/.test(nearCtx)) {
      category = 'movie';
    } else if (/文章|论文|报告|专栏|公众号/.test(nearCtx)) {
      category = 'article';
    }

    refs.push({
      id: `ref_local_${refs.length + 1}`,
      category,
      title: `《${title}》`,
    });
    if (refs.length >= 8) break;
  }

  return refs;
}

/**
 * 提炼脱敏对话与议题内容，组织约 500 字的专业播客节目简介（钩子->核心内容->听众收获，无流水账开头与引号摘抄）。
 */
function buildFiveHundredCharSummary(
  state: PodcastProjectState,
  timeline: TimelineComputation,
  guests: ShownotesGuest[],
  timelineItems: ShownotesTimelineItem[]
): string {
  const title = state.projectTitle || '本期播客';
  const durationMin = Math.max(1, Math.round(timeline.totalEditedDurationSec / 60));
  const guestNames = guests.map((g) => `${g.name}（${g.roleLabel}）`).join('、') || '主创团队';

  // 提取有效核心章节
  const meaningfulChapters = timelineItems
    .filter((item) => !/高光片头|听友福利|活动抽奖/.test(item.title));

  const chapterTopics = meaningfulChapters
    .slice(0, 5)
    .map((item) => `「${item.title}」`)
    .join('、');

  // 提取章节主旨要点作为对话脉络概括（绝无引号摘抄，全为第三人称主旨归纳）
  const topicHighlights = meaningfulChapters
    .slice(0, 4)
    .map((item) => {
      const summaryText = item.summary ? `，重点${item.summary.replace(/[“"『』”]/g, '')}` : '';
      return `围绕${item.title}${summaryText}`;
    });

  const hotwords = state.glossary
    .filter((g) => g.type === 'hotword')
    .slice(0, 6)
    .map((g) => g.word);

  const paragraphs: string[] = [];

  // 第 1 段（钩子）：直面核心问题与现实张力，避免“欢迎收听”式流水账开头
  paragraphs.push(
    `当经验不再奏效，真正的破局点往往藏在一线实践的取舍之中。在《${title}》这期约 ${durationMin} 分钟的深度对谈里，${guestNames} 坐在一起，拆解了从概念热潮走向真实落地过程中最容易被忽略的关键命题。`
  );

  // 第 2 段（核心内容）：对谈主线、嘉宾视角与具体场景
  if (chapterTopics) {
    paragraphs.push(
      `整场对话沿着 ${chapterTopics} 等关键脉络层层推进。${
        hotwords.length > 0 ? `讨论紧扣 ${hotwords.join('、')} 等核心概念，` : ''
      }结合一线实战场景还原了从初期探索、业务推演到落地攻坚的完整过程，既直面真实困境与试错代价，也梳理出清晰的判断依据。`
    );
  }

  // 第 3 段（听众收获）：深度思辨、方法论与实操启发
  if (topicHighlights.length > 0) {
    paragraphs.push(
      `深入复盘关键转折：${topicHighlights.join('；')}。听完这期对谈，你将厘清表象背后的深层动因，带走一套经过验证的思考框架与避坑指南，为下一阶段的决策与行动提供扎实的参考。`
    );
  } else {
    paragraphs.push(
      `整场交流不仅客观复盘了实践中的经验与教训，还对关键难点背后的权衡取舍给出了明确的解题思路。无论你关注技术演进、产品打磨还是个人成长，都能从中获得可落地的启发与思考框架。`
    );
  }

  // 第 4 段（收听与互动指引）：自然收尾
  paragraphs.push(
    `节目已整理好完整时间轴与嘉宾联络名片，点击下方节点即可直达你最关心的段落。如果你在收听过程中产生了共鸣或疑问，欢迎在评论区留下你的观察，也别忘了查看文末的听友交流与专属福利。`
  );

  let result = paragraphs.join('\n\n');

  // 若文稿较短导致总字数不足 440 字，补充结构化收听指南以贴近 ~500 字标准
  if (countSummaryChars(result) < 440) {
    result += `\n\n【收听贴士】本期对谈信息密度较高，建议配合下方时间轴分段收听或收藏回听；相关延伸资料与互动活动规则已同步附于文末，期待在评论区与听友群和你继续交流。`;
  }

  return sanitizeShownotesSynthesizedText(result);
}

export function createDefaultActivityInfo(episodeTitle: string): ShownotesActivityInfo {
  return {
    title: `《${episodeTitle}》听友互动抽奖活动`,
    description: '收听本期节目并参与评论区互动，即有机会赢取主创团队准备的限定好礼！',
    eventTime: '本期上线日起 7 天内',
    locationOrPlatform: '小宇宙 / Apple Podcasts 评论区 & 听友交流群',
    posterTheme: 'amber_studio',
    posterSlogan: '好声音值得被看见 · 参与互动赢好礼',
    lottery: {
      enabled: true,
      prizeName: '节目限定周边礼包 / 精品咖啡券',
      winnerCount: 3,
      drawCondition: 'comment_like',
      participationMethod: '订阅本播客并在本期节目评论区分享你的收听感悟，点赞最高或随机抽取',
      keyword: '我想听下期',
      deadline: '节目发布后第 7 天 20:00 开奖',
      announcementChannel: '评论区置顶公示 & 听友群通知',
    },
  };
}

export function createDefaultBenefits(): ListenerBenefitItem[] {
  return [
    {
      id: 'ben_1',
      title: '听友交流群 & 本期延伸资料包',
      codeOrLink: '微信添加小助手备注「听友」',
      description: '进群即可领取本期提及的书单、工具清单与嘉宾补充资料。',
    },
  ];
}

/**
 * 一键在本地生成完整的 Shownotes 结构（可离线 100% 运行）。
 */
export function buildLocalShownotes(
  state: PodcastProjectState,
  timeline: TimelineComputation,
  existing?: PodcastShownotes
): PodcastShownotes {
  const episodeTitle = existing?.episodeTitle?.trim() || state.projectTitle || '未命名播客单集';
  const guests = buildGuestsFromTracks(state.tracks, existing?.guests ?? []);
  const timelineItems = buildTimelineItemsFromProject(state, timeline);
  const summary = buildFiveHundredCharSummary(state, timeline, guests, timelineItems);
  const titleOptions =
    existing?.titleOptions && existing.titleOptions.length > 0
      ? existing.titleOptions
      : buildLocalTitleOptions(state, guests, timelineItems);
  const references =
    existing?.references !== undefined ? existing.references : extractLocalReferences(state);

  return {
    generatedAt: new Date().toISOString(),
    episodeTitle,
    titleOptions,
    summary: sanitizeShownotesSynthesizedText(summary),
    guests,
    timeline: timelineItems.map((t) => ({
      ...t,
      title: sanitizeShownotesSynthesizedText(t.title),
      summary: t.summary ? sanitizeShownotesSynthesizedText(t.summary) : undefined,
    })),
    references,
    activity: existing?.activity ?? createDefaultActivityInfo(episodeTitle),
    benefits: existing?.benefits?.length ? existing.benefits : createDefaultBenefits(),
  };
}

/**
 * 合并云端大模型返回的 Shownotes 字段，保留本地嘉宾联系方式与抽奖配置。
 */
export function mergeCloudShownotes(
  localBase: PodcastShownotes,
  cloud: SidecarShownotesPayload
): PodcastShownotes {
  const mergedTimeline: ShownotesTimelineItem[] =
    Array.isArray(cloud.timeline) && cloud.timeline.length > 0
      ? cloud.timeline.map((item, idx) => ({
          id: `tl_ai_${idx}`,
          timeSec:
            typeof item.timeSec === 'number' && Number.isFinite(item.timeSec)
              ? Math.max(0, Math.round(item.timeSec))
              : localBase.timeline[idx]?.timeSec ?? idx * 60,
          title: sanitizeShownotesSynthesizedText(
            item.title?.trim() || localBase.timeline[idx]?.title || `章节 ${idx + 1}`,
            true
          ),
          summary: item.summary
            ? sanitizeShownotesSynthesizedText(item.summary, true)
            : undefined,
        }))
      : localBase.timeline;

  const mergedTitleOptions: ShownotesTitleOption[] | undefined =
    Array.isArray(cloud.titleOptions) && cloud.titleOptions.length > 0
      ? cloud.titleOptions
          .filter((o) => o && typeof o.title === 'string' && o.title.trim())
          .slice(0, 3)
          .map((o, idx) => {
            const style: ShownotesTitleOption['style'] =
              o.style === 'pain_point' || o.style === 'insight' || o.style === 'narrative'
                ? o.style
                : (['pain_point', 'insight', 'narrative'][idx % 3] as ShownotesTitleOption['style']);
            const defaultLabel =
              style === 'pain_point'
                ? '悬念/痛点型'
                : style === 'insight'
                ? '干货/金句型'
                : '温和/陪伴型';
            return {
              style,
              label: o.label?.trim() || defaultLabel,
              title: o.title!.trim(),
            };
          })
      : localBase.titleOptions;

  const mergedReferences: ShownotesReferenceItem[] | undefined = Array.isArray(cloud.references)
    ? cloud.references
        .filter((r) => r && typeof r.title === 'string' && r.title.trim())
        .map((r, idx) => ({
          id: `ref_ai_${idx}`,
          category: normalizeReferenceCategory(r.category),
          title: r.title!.trim(),
          note: r.note?.trim() || undefined,
        }))
    : localBase.references;

  const mergedActivity: ShownotesActivityInfo = {
    ...localBase.activity,
    title: cloud.activitySuggestion?.title?.trim() || localBase.activity.title,
    description:
      cloud.activitySuggestion?.description?.trim() || localBase.activity.description,
    posterSlogan:
      cloud.activitySuggestion?.posterSlogan?.trim() || localBase.activity.posterSlogan,
  };

  const mergedBenefits: ListenerBenefitItem[] =
    Array.isArray(cloud.benefitsSuggestion) && cloud.benefitsSuggestion.length > 0
      ? cloud.benefitsSuggestion.map((b, idx) => ({
          id: `ben_ai_${idx}`,
          title: b.title?.trim() || `听友福利 ${idx + 1}`,
          codeOrLink: localBase.benefits[idx]?.codeOrLink || '详见评论区置顶说明',
          description: b.description?.trim() || '',
        }))
      : localBase.benefits;

  return {
    ...localBase,
    generatedAt: new Date().toISOString(),
    episodeTitle: cloud.episodeTitle?.trim() || localBase.episodeTitle,
    titleOptions: mergedTitleOptions,
    summary: sanitizeShownotesSynthesizedText(cloud.summary?.trim() || localBase.summary),
    timeline: mergedTimeline,
    references: mergedReferences,
    activity: mergedActivity,
    benefits: mergedBenefits,
  };
}

/**
 * 导出标准 Markdown 格式 Shownotes。
 */
export function formatShownotesMarkdown(sn: PodcastShownotes): string {
  const lines: string[] = [];
  lines.push(`# ${sn.episodeTitle}`);
  lines.push('');

  lines.push('## 📝 节目简介');
  lines.push(sn.summary.trim() || '暂无简介');
  lines.push('');

  lines.push('## 🎙️ 节目嘉宾');
  if (sn.guests.length === 0) {
    lines.push('- 暂无嘉宾信息');
  } else {
    for (const g of sn.guests) {
      const wechat = formatGuestWechat(g.contact);
      const bioTags = formatGuestBioTags(g.bio);
      const social = formatGuestSocialSummary(g, true);
      const header = `**${g.name}**${wechat ? `（${wechat}｜${g.roleLabel}）` : `（${g.roleLabel}）`}`;
      const parts = [header];
      if (bioTags) parts.push(bioTags);
      if (social) parts.push(`社交主页：${social}`);
      lines.push(`- ${parts.join(' ｜ ')}`);
    }
  }
  lines.push('');

  lines.push('## ⏱️ 时间轴');
  const hasOverHour = sn.timeline.some((t) => t.timeSec >= 3600);
  if (sn.timeline.length === 0) {
    lines.push('- 00:00 开场：本期对谈开场与核心议题引入');
  } else {
    for (const t of sn.timeline) {
      lines.push(`- ${formatShownotesTimelineRow(t, hasOverHour)}`);
    }
  }
  lines.push('');

  if (sn.references && sn.references.length > 0) {
    lines.push('## 📚 提及书影音 / 延伸资料');
    for (const ref of sn.references) {
      const catLabel = REFERENCE_CATEGORY_LABELS[ref.category] || '延伸资料';
      const noteText = ref.note?.trim() ? ` — ${ref.note.trim()}` : '';
      lines.push(`- [${catLabel}] **${ref.title}**${noteText}`);
    }
    lines.push('');
  }

  lines.push('## 🎉 活动信息');
  lines.push(`- **活动主题**：${sn.activity.title}`);
  if (sn.activity.description.trim()) {
    lines.push(`- **活动说明**：${sn.activity.description.trim()}`);
  }
  if (sn.activity.eventTime.trim()) {
    lines.push(`- **活动时间**：${sn.activity.eventTime.trim()}`);
  }
  if (sn.activity.locationOrPlatform.trim()) {
    lines.push(`- **参与平台**：${sn.activity.locationOrPlatform.trim()}`);
  }
  if (sn.activity.lottery.enabled) {
    const lt = sn.activity.lottery;
    lines.push(`- **抽奖规则**：${DRAW_CONDITION_LABELS[lt.drawCondition]}`);
    lines.push(`  - 🎁 奖品设置：${lt.prizeName}（共 ${lt.winnerCount} 名）`);
    lines.push(`  - 📌 参与方式：${lt.participationMethod}`);
    if (lt.drawCondition === 'keyword_reply' && lt.keyword?.trim()) {
      lines.push(`  - 🔑 互动暗号：「${lt.keyword.trim()}」`);
    }
    lines.push(`  - ⏰ 开奖时间：${lt.deadline}`);
    lines.push(`  - 📢 公示渠道：${lt.announcementChannel}`);
  }
  lines.push('');

  lines.push('## 🎁 听友福利');
  if (sn.benefits.length === 0) {
    lines.push('- 关注节目订阅，更多听友专属福利持续更新中');
  } else {
    for (const b of sn.benefits) {
      const code = b.codeOrLink.trim() ? `（口令/链接：${b.codeOrLink.trim()}）` : '';
      lines.push(`- **${b.title}**${code}：${b.description}`);
    }
  }

  return lines.join('\n');
}

/**
 * 导出纯文本格式 Shownotes（适合小宇宙/Apple Podcasts 等后台直接粘贴）。
 */
export function formatShownotesPlainText(sn: PodcastShownotes): string {
  const lines: string[] = [];
  lines.push(`【${sn.episodeTitle}】`);
  lines.push('');
  lines.push('【节目简介】');
  lines.push(sn.summary.trim() || '暂无简介');
  lines.push('');
  lines.push('【节目嘉宾】');
  for (const g of sn.guests) {
    const wechat = formatGuestWechat(g.contact);
    const bioTags = formatGuestBioTags(g.bio);
    const social = formatGuestSocialSummary(g, false);
    const details = [bioTags, social].filter(Boolean).join(' ｜ ');
    lines.push(
      `• ${g.name}${wechat ? `（${wechat}｜${g.roleLabel}）` : `（${g.roleLabel}）`}${
        details ? ` - ${details}` : ''
      }`
    );
  }
  lines.push('');
  lines.push('【时间轴】');
  const hasOverHour = sn.timeline.some((t) => t.timeSec >= 3600);
  for (const t of sn.timeline) {
    lines.push(formatShownotesTimelineRow(t, hasOverHour));
  }
  lines.push('');

  if (sn.references && sn.references.length > 0) {
    lines.push('【提及书影音 / 延伸资料】');
    for (const ref of sn.references) {
      const catLabel = REFERENCE_CATEGORY_LABELS[ref.category] || '延伸资料';
      const noteText = ref.note?.trim() ? `（${ref.note.trim()}）` : '';
      lines.push(`• [${catLabel}] ${ref.title}${noteText}`);
    }
    lines.push('');
  }
  lines.push('【活动信息】');
  lines.push(`${sn.activity.title}`);
  if (sn.activity.description.trim()) lines.push(sn.activity.description.trim());
  if (sn.activity.eventTime.trim()) lines.push(`时间：${sn.activity.eventTime.trim()}`);
  if (sn.activity.locationOrPlatform.trim()) {
    lines.push(`平台：${sn.activity.locationOrPlatform.trim()}`);
  }
  if (sn.activity.lottery.enabled) {
    const lt = sn.activity.lottery;
    lines.push(
      `抽奖规则：${DRAW_CONDITION_LABELS[lt.drawCondition]}｜奖品：${lt.prizeName} × ${lt.winnerCount}名`
    );
    lines.push(`参与方式：${lt.participationMethod}`);
    if (lt.drawCondition === 'keyword_reply' && lt.keyword?.trim()) {
      lines.push(`互动暗号：${lt.keyword.trim()}`);
    }
    lines.push(`开奖时间：${lt.deadline}｜公布渠道：${lt.announcementChannel}`);
  }
  lines.push('');
  lines.push('【听友福利】');
  for (const b of sn.benefits) {
    lines.push(
      `• ${b.title}${b.codeOrLink ? ` [${b.codeOrLink}]` : ''}：${b.description}`
    );
  }
  return lines.join('\n');
}
