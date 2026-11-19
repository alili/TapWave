import { SpeakerRole, SpeakerTrack, TranscriptBlock } from '../types/podcast';
import { formatMmSs } from './timelineEngine';

export interface SpeakerQaStat {
  speakerId: string;
  name: string;
  color: string;
  role: SpeakerRole;
  roleBadge: string;
  questionCount: number;
  questionSec: number;
  statementSec: number;
  laughSec: number;
  totalSec: number;
  questionPctOfTotal: number;
  statementPctOfTotal: number;
  sharePct: number;
}

export interface ExtractedQuestionItem {
  id: string;
  speakerId: string;
  speakerName: string;
  speakerColor: string;
  roleBadge: string;
  isHostSide: boolean;
  text: string;
  timeSec: number;
  timeFormatted: string;
}

export interface QaAnalysisResult {
  hostQPct: number;
  hostOpPct: number;
  guestPct: number;
  laughPct: number;
  badge: string;
  speakerBreakdown: SpeakerQaStat[];
  questions: ExtractedQuestionItem[];
}

function getRoleBadgeText(role?: SpeakerRole): string {
  if (role === 'host') return '主持人';
  if (role === 'co_host') return '常驻主播';
  if (role === 'guest') return '嘉宾';
  if (role === 'bgm') return 'BGM';
  return '参考轨';
}

// 仅用于附和、填充或确认的短语（整句匹配时直接排除）
const PHATIC_ONLY_RE =
  /^(?:对吧|对不对|是吧|是不是|好吧|行吧|好吗|行吗|可以吗|真的吗|是吗|对吗|这样吗|这样啊|然后呢|所以呢|那呢|怎么说呢|怎么讲呢|干嘛呢|什么呀|啥呀|啊|嗯|哦|唔|呃|哈|哎|唉|哇|天哪)$/;

// 句尾口头禅/确认尾缀（如“……，对吧？”），剥离后再判断主体是否为真问句
const TRAILING_TAG_RE =
  /[,，\s]+(?:对吧|对不对|是吧|是不是|好不好|行不行|对吗|是吗|好吗|行吗|可以吗|懂吗|知道吗|明白吗|你说呢|你觉得呢)[？?!！。.\s]*$/;

// 句首/句中常见的“非疑问”固定搭配（不定指、否定、让步、转折、间接引语陈述）
const NON_INTERROGATIVE_WRAPPER_RE =
  /(?:没什么|没有什么|不算什么|不是什么|说不上什么|谈不上什么|干不了什么|做不了什么|有点什么|有些什么|不怎么|不知怎么|不知为什么|不知为何|莫名其妙|不管怎么|无论怎么|不管怎样|无论怎样|无论如何|不管什么|无论什么|不管哪|无论哪|不管谁|无论谁|无论多少|怎么说呢|怎么讲呢)/g;

// 间接引语/自我猜测/不确定陈述引导词（后接疑问词通常不是向他人提问）
const INDIRECT_CLAUSE_RE =
  /(?:不知道|不确定|不清楚|不明白|想不通|搞不懂|搞不清|说不清|记不清|看得出|看不出|看看|想知道|好奇|怀疑|担心|怕|猜)(?:[^。？！?!]{0,14})(?:是不是|有没有|能不能|会不会|可不可以|为什么|怎么|什么|哪|谁|多少|如何)/;

// 明确的正反问句结构
const A_NOT_A_RE =
  /(?:是不是|有没有|能不能|会不会|可不可以|愿不愿意|想不想|敢不敢|值不值得|算不算|需不需要|应不应该|好不好|行不行|对不对|懂不懂|记不记得|知不知道)/;

// 选择问句结构（如“是A还是B”、“你是A，还是B？”、“A还是B呢/？”）
const CHOICE_QUESTION_RE =
  /(?:^|[，,\s])(?:是[^。？！?!]{1,20}还是[^。？！?!]{1,20}|[^，。？！?!]{0,16}还是[^，。？！?!]{1,16}(?:呢|吗|[？?]+))/;

// 实质性特指疑问词
const WH_WORD_RE =
  /(?:为什么|为啥|干嘛|怎么会|怎么样|怎么看|怎么想|怎么办|怎么做|怎么理解|怎么解决|怎么判断|怎么做到|如何|什么样|什么原因|什么感觉|什么意思|什么区别|什么情况|什么叫|什么是|有什么|做什么|干什么|说什么|想什么|看什么|哪个|哪些|哪里|哪儿|哪位|哪方面|哪一步|谁|多少|几(?:个|次|年|天|点|岁|位|种|分|成|倍)|多久|多长|多大|多远|多高)/;

// 句末疑问助词（吗/么）
const MA_END_RE = /(?:吗|么)[？?!！。.\s]*$/;

// 带问号的简短“X呢？”追问（如“你呢？”、“结果呢？”、“后来呢？”）
const SHORT_NE_QUESTION_RE = /^[^，。？！?!]{1,8}呢[？?]+$/;

// 面向对方征询/对话引导词（配合问号使用）
const DIRECT_ADDRESS_CUE_RE =
  /(?:你觉得|你怎么|你说|你认为|你当时|你有没有|你们|各位|请问|我想问|想问一下|想请教)/;

// 英文问句启发式
const EN_QUESTION_RE =
  /^(?:what|why|how|who|when|where|which|whose|whom|do|does|did|is|are|was|were|can|could|will|would|should|have|has|had)\b[^。！？?!]*\?$/i;

// 设问后紧跟自答的典型开头
const SELF_ANSWER_START_RE =
  /^(?:因为|其实|主要是|简单来说|说白了|原因|答案|我觉得|我认为|我发现|第一|一方面|首先|所以|也就是说|事实上|就是|那是因为)/;

function stripPunctuationAndSpace(text: string): string {
  return text.replace(/[，。？！、；：“”‘’（）()【】\[\],.?!;:'"\s]/g, '');
}

/**
 * 判断单个句子是否为真正的互动提问句（过滤口头禅、附和、陈述句误标问号及否定/不定指句）。
 */
export function isGenuineQuestionSentence(rawSentence: string): boolean {
  const sentence = rawSentence.trim();
  if (!sentence) return false;

  const hasQuestionMark = /[？?]$/.test(sentence);
  const coreChars = stripPunctuationAndSpace(sentence);

  // 过短（< 3字）且不是“X呢？”形式的，基本为语气词或附和（如“嗯？”、“啥？”、“对？”）
  if (coreChars.length < 3 && !SHORT_NE_QUESTION_RE.test(sentence)) {
    return false;
  }

  // 纯附和/填充语直接排除
  if (PHATIC_ONLY_RE.test(coreChars)) {
    return false;
  }

  // 英文问句
  if (EN_QUESTION_RE.test(sentence)) {
    return true;
  }

  // 剥离句末口头禅尾缀（如“……，对吧？”）后再评估主体
  const stripped = sentence.replace(TRAILING_TAG_RE, '').trim();
  if (!stripped || stripped !== sentence) {
    const strippedCore = stripPunctuationAndSpace(stripped);
    if (strippedCore.length < 2 || PHATIC_ONLY_RE.test(strippedCore)) {
      return false;
    }
    // 剥离尾缀后，主体本身必须仍具备疑问特征，否则原句只是陈述+口头禅
    return isGenuineQuestionSentence(stripped);
  }

  // 去除不定指/否定/固定陈述搭配后再检测疑问词，避免“没什么”、“不怎么”、“无论如何”等误判
  const masked = sentence.replace(NON_INTERROGATIVE_WRAPPER_RE, ' ');

  // 句末带“吗/么”
  if (MA_END_RE.test(masked)) {
    // 排除明显自言自语的反问感叹（无问号且含“难道/岂不是”等可放宽，这里主要防“对吗/是吗”已由 PHATIC_ONLY_RE 拦掉）
    return true;
  }

  // 简短“X呢？”（如“你呢？”、“结果呢？”）
  if (SHORT_NE_QUESTION_RE.test(sentence)) {
    return true;
  }

  // 检查是否属于“我不知道他为什么会这样 / 我觉得会不会有点贵”这类间接陈述从句
  const isIndirectClause = INDIRECT_CLAUSE_RE.test(masked);
  if (isIndirectClause && !hasQuestionMark) {
    return false;
  }
  if (isIndirectClause && hasQuestionMark && !DIRECT_ADDRESS_CUE_RE.test(masked)) {
    return false;
  }

  // 正反问（是不是/有没有/能不能...）
  if (A_NOT_A_RE.test(masked)) {
    // 无问号且以“我觉得/可能/大概”等猜测语气为主时，多为陈述句
    if (!hasQuestionMark && /^(?:我觉得|我感觉|我猜|可能|大概|估计|应该)/.test(masked)) {
      return false;
    }
    return true;
  }

  // 选择问（是A还是B / A还是B呢）
  if (CHOICE_QUESTION_RE.test(masked)) {
    return true;
  }

  // 特指疑问词（为什么/怎么看/什么原因/哪个/谁/多少...）
  if (WH_WORD_RE.test(masked)) {
    return true;
  }

  // 带问号且有明确面向对方的征询词（如“你觉得这样行？”、“请问这一步怎么处理？”）
  if (hasQuestionMark && DIRECT_ADDRESS_CUE_RE.test(masked)) {
    return true;
  }

  // 仅有泛化的“怎么/什么”且带问号，如“这怎么弄？”、“接下来什么打算？”
  if (hasQuestionMark && /(?:怎么|什么|哪)/.test(masked) && coreChars.length <= 28) {
    return true;
  }

  return false;
}

export interface TurnQuestionExtraction {
  questionSentences: string[];
  questionCharRatio: number;
}

/**
 * 从单轮发言文本中提取真正的提问句（自动过滤同轮内紧跟长篇自答的修辞性设问），
 * 并计算提问句占本轮总字数的比例用于精确时长切分。
 */
export function extractGenuineQuestionsFromTurn(cleanText: string): TurnQuestionExtraction {
  const sentences = cleanText
    .split(/(?<=[。？！?!；;\n])/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return { questionSentences: [], questionCharRatio: 0 };
  }

  const totalChars = sentences.reduce(
    (sum, s) => sum + Math.max(1, stripPunctuationAndSpace(s).length),
    0
  );

  const questionSentences: string[] = [];
  let questionChars = 0;

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (!isGenuineQuestionSentence(s)) continue;

    // 检测“设问/自问自答”：同轮后续紧跟较长陈述或明显作答开头，则不计为向他人的互动提问
    const trailingSentences = sentences.slice(i + 1);
    if (trailingSentences.length > 0) {
      const trailingChars = trailingSentences.reduce(
        (sum, ts) => sum + stripPunctuationAndSpace(ts).length,
        0
      );
      const nextSentence = trailingSentences[0];
      const looksLikeSelfAnswer =
        trailingChars >= 45 ||
        (trailingChars >= 25 && SELF_ANSWER_START_RE.test(nextSentence));
      if (looksLikeSelfAnswer) {
        continue;
      }
    }

    questionSentences.push(s);
    questionChars += Math.max(1, stripPunctuationAndSpace(s).length);
  }

  const questionCharRatio =
    totalChars > 0 ? Math.min(1, Math.max(0, questionChars / totalChars)) : 0;

  return { questionSentences, questionCharRatio };
}

export function analyzeQaInteractions(params: {
  blocks: TranscriptBlock[];
  speakerTracks: SpeakerTrack[];
  blockEditedStartsSec: Record<string, number>;
}): QaAnalysisResult {
  const { blocks, speakerTracks, blockEditedStartsSec } = params;
  const speakerMap = Object.fromEntries(speakerTracks.map((t) => [t.id, t]));

  let hostQSec = 0;
  let hostOpinionSec = 0;
  let guestSec = 0;
  let laughSec = 0;

  const perSpeakerMap = new Map<string, SpeakerQaStat>();
  speakerTracks.forEach((tr) => {
    perSpeakerMap.set(tr.id, {
      speakerId: tr.id,
      name: tr.name,
      color: tr.color,
      role: tr.role,
      roleBadge: getRoleBadgeText(tr.role),
      questionCount: 0,
      questionSec: 0,
      statementSec: 0,
      laughSec: 0,
      totalSec: 0,
      questionPctOfTotal: 0,
      statementPctOfTotal: 0,
      sharePct: 0,
    });
  });

  const questions: ExtractedQuestionItem[] = [];

  blocks.forEach((b) => {
    const sp = speakerMap[b.speakerId];
    const spRole: SpeakerRole = sp?.role ?? 'guest';
    const isHostSide = spRole === 'host' || spRole === 'co_host';

    if (!perSpeakerMap.has(b.speakerId)) {
      perSpeakerMap.set(b.speakerId, {
        speakerId: b.speakerId,
        name: sp?.name ?? '发言人',
        color: sp?.color ?? '#3b82f6',
        role: spRole,
        roleBadge: getRoleBadgeText(spRole),
        questionCount: 0,
        questionSec: 0,
        statementSec: 0,
        laughSec: 0,
        totalSec: 0,
        questionPctOfTotal: 0,
        statementPctOfTotal: 0,
        sharePct: 0,
      });
    }
    const stat = perSpeakerMap.get(b.speakerId)!;

    let turnSec = 0;
    let turnLaughSec = 0;
    let turnText = '';
    b.tokens.forEach((t) => {
      if (t.deleted) return;
      if (t.type === 'laughter') {
        laughSec += t.durationSec;
        turnLaughSec += t.durationSec;
      } else if (t.type === 'word') {
        turnSec += t.durationSec;
        turnText += t.bleeped ? '[已消音]' : t.text;
      }
    });

    stat.laughSec += turnLaughSec;
    const cleanText = turnText.replace(/\[语音 [^\]]+\]|\[音轨片段[^\]]*\]/g, '').trim();
    const { questionSentences, questionCharRatio } =
      cleanText.length >= 2
        ? extractGenuineQuestionsFromTurn(cleanText)
        : { questionSentences: [], questionCharRatio: 0 };

    const hasQuestion = questionSentences.length > 0;
    const turnQSec = hasQuestion ? turnSec * questionCharRatio : 0;
    const turnStmtSec = Math.max(0, turnSec - turnQSec);

    if (hasQuestion) {
      stat.questionCount += 1;
      stat.questionSec += turnQSec;
      stat.statementSec += turnStmtSec;

      const blockStartSec = blockEditedStartsSec[b.blockId] ?? 0;
      const displayQ = questionSentences.join(' ').slice(0, 72);

      questions.push({
        id: `q_${b.blockId}`,
        speakerId: b.speakerId,
        speakerName: stat.name,
        speakerColor: stat.color,
        roleBadge: stat.roleBadge,
        isHostSide,
        text: displayQ,
        timeSec: blockStartSec,
        timeFormatted: formatMmSs(blockStartSec),
      });
    } else {
      stat.statementSec += turnSec;
    }

    stat.totalSec += turnSec + turnLaughSec;

    if (isHostSide) {
      hostQSec += turnQSec;
      hostOpinionSec += turnStmtSec;
    } else {
      guestSec += turnSec;
    }
  });

  const total = hostQSec + hostOpinionSec + guestSec + laughSec;
  const speakerBreakdown = Array.from(perSpeakerMap.values()).map((st) => ({
    ...st,
    questionPctOfTotal: total > 0.01 ? Math.round((st.questionSec / total) * 100) : 0,
    statementPctOfTotal: total > 0.01 ? Math.round((st.statementSec / total) * 100) : 0,
    sharePct: total > 0.01 ? Math.round((st.totalSec / total) * 100) : 0,
  }));

  if (total <= 0.01) {
    return {
      hostQPct: 0,
      hostOpPct: 0,
      guestPct: 0,
      laughPct: 0,
      badge: '待导入音频',
      speakerBreakdown,
      questions,
    };
  }

  const hostQPct = Math.round((hostQSec / total) * 100);
  const hostOpPct = Math.round((hostOpinionSec / total) * 100);
  const laughPct = Math.round((laughSec / total) * 100);
  const guestPct = Math.max(0, 100 - hostQPct - hostOpPct - laughPct);
  const badge =
    guestPct >= 50
      ? '嘉宾输出充足 · 黄金控场区间'
      : speakerTracks.length === 1
      ? '单口/独白播客模式'
      : '主持/主播主导对谈';

  return {
    hostQPct,
    hostOpPct,
    guestPct,
    laughPct,
    badge,
    speakerBreakdown,
    questions,
  };
}
