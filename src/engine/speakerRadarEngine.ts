import { GlossaryItem, SpeakerTrack, TranscriptBlock } from '../types/podcast';
import { extractGenuineQuestionsFromTurn } from './questionAnalysis';
import { formatMmSs, MappedTokenTimeline, OverlapTimelineRegion } from './timelineEngine';

export type RadarDimensionKey =
  | 'fluency'
  | 'pacing'
  | 'conciseness'
  | 'turnTaking'
  | 'specificity';

export interface RadarDimensionScore {
  key: RadarDimensionKey;
  label: string;
  score: number; // 0..100
  detail: string;
}

export type HabitPhraseCategory = 'pure_filler' | 'starter_crutch' | 'hedging_tail';

export interface HabitPhraseItem {
  word: string;
  category: HabitPhraseCategory;
  categoryLabel: string;
  count: number;
  perMin: number;
  firstTimeSec: number;
  firstTimeFormatted: string;
}

export interface HabitEvidenceAnchor {
  label: string;
  timeSec: number;
  timeFormatted: string;
  snippet?: string;
}

export interface SpeakerHabitMicroMetrics {
  mergedTurnCount: number;
  avgMergedTurnSec: number;
  maxMergedTurnSec: number;
  paceStdCpm: number;
  trailingDropDb: number | null;
  avgTurnGapSec: number | null;
  backchannelCount: number;
  pureFillerCount: number;
}

export interface SpeakerHabitInsight {
  id:
    | 'filler_fingerprint'
    | 'pace_prosody'
    | 'turn_structure'
    | 'turn_taking'
    | 'lexical_conciseness'
    | 'role_timing';
  category: string;
  status: 'good' | 'warn' | 'alert';
  metricBadge: string;
  summary: string;
  detail: string;
  evidences: HabitEvidenceAnchor[];
}

export interface SpeakerRadarProfile {
  speakerId: string;
  overallScore: number;
  dimensions: RadarDimensionScore[];
  microMetrics: SpeakerHabitMicroMetrics;
  topHabitPhrases: HabitPhraseItem[];
  habitInsights: SpeakerHabitInsight[];
}

export interface SpeakerRadarComputationParams {
  speakerTracks: SpeakerTrack[];
  blocks: TranscriptBlock[];
  glossary: GlossaryItem[];
  blockEditedStartsSec?: Record<string, number>;
  mappedTokens?: MappedTokenTimeline[];
  overlapRegions?: OverlapTimelineRegion[];
}

const STARTER_CRUTCH_PATTERNS = [
  '然后呢',
  '然后',
  '就是说',
  '其实吧',
  '那其实',
  '那其实是',
  '怎么说呢',
  '怎么讲呢',
  '也就是说',
  '所以说',
  '基本上',
  '某种程度上',
  '换句话说',
  '说实话',
  '老实说',
];

const HEDGING_TAIL_PATTERNS = [
  '对吧',
  '对不对',
  '是吧',
  '是不是',
  '对吗',
  '是吗',
  '知道吧',
  '懂吧',
  '算不算',
  '算是吧',
  '大概吧',
  '基本上吧',
];

const VAGUE_WORDS_RE =
  /很多|一些|大概|可能|应该|差不多|各种|挺好|挺多|有点|比较|非常|相当|巨大|很多东西|各种各样/g;

const SPECIFIC_FACTS_RE =
  /\d+(\.\d+)?%?|年|月|日|块|元|万|亿|比如|例如|具体|案例|数据|模型|架构|指标|业务|转化|留存|复购|成本|效率|对比|实验/g;

const CONVERGENCE_KEYWORDS_RE =
  /所以|总结|核心|关键|本质|结论|归根结底|简而言之|也就是说|落地|第一|第二|最后/g;

function clampScore(v: number): number {
  return Math.max(50, Math.min(98, Math.round(v)));
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

interface AtomBlock {
  blockId: string;
  speakerId: string;
  startSec: number;
  endSec: number;
  speechSec: number;
  text: string;
  words: Array<{ text: string; sec: number; isFiller: boolean; timeSec: number }>;
}

interface MergedSpeakerTurn {
  speakerId: string;
  startSec: number;
  endSec: number;
  speechSec: number;
  text: string;
  cpm: number;
  words: Array<{ text: string; sec: number; isFiller: boolean; timeSec: number }>;
}

function isPureBackchannelText(text: string): boolean {
  const clean = text.replace(/[，。？！、；：\s…!?,.]/g, '').trim();
  if (!clean) return true;
  return /^(嗯|对|对对|对对对|没错|确实|是的|好|好的|明白|收到|哈哈|哈|哎|哇|天哪|真棒|是啊|对啊)+$/.test(
    clean
  );
}

export function computeSpeakerRadarProfiles(
  speakerTracks: SpeakerTrack[],
  blocks: TranscriptBlock[],
  glossary: GlossaryItem[],
  optionalTimelineParams?: {
    blockEditedStartsSec?: Record<string, number>;
    mappedTokens?: MappedTokenTimeline[];
    overlapRegions?: OverlapTimelineRegion[];
  }
): Map<string, SpeakerRadarProfile> {
  const result = new Map<string, SpeakerRadarProfile>();
  if (speakerTracks.length === 0) return result;

  const blockEditedStarts = optionalTimelineParams?.blockEditedStartsSec ?? {};
  const mappedTokens = optionalTimelineParams?.mappedTokens ?? [];
  const overlapRegions = optionalTimelineParams?.overlapRegions ?? [];

  const tokenTimeMap = new Map<string, number>();
  for (const m of mappedTokens) {
    tokenTimeMap.set(m.tokenId, m.editedStartSec);
  }

  const glossaryTerms = glossary
    .map((g) => g.word.trim().toLowerCase())
    .filter((t) => t.length >= 2);
  const glossaryHabitWords = new Set(
    glossary.filter((g) => g.type === 'habit').map((g) => g.word.trim())
  );

  // 1. 将有效 blocks 映射为原子分段
  const rawAtoms: AtomBlock[] = [];
  for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
    const b = blocks[bIdx];
    const atomStartSec =
      blockEditedStarts[b.blockId] ??
      (b.tokens[0]?.sourceStartMs ? b.tokens[0].sourceStartMs / 1000 : bIdx * 3.0);
    let bSpeechSec = 0;
    let bText = '';
    const bWords: AtomBlock['words'] = [];

    for (const t of b.tokens) {
      if (t.deleted) continue;
      if (t.type === 'silence') continue;
      if (t.type === 'word' || t.type === 'laughter') {
        bSpeechSec += t.durationSec;
        if (!t.text.startsWith('[语音 ') && !t.text.startsWith('[音轨片段')) {
          const tTime =
            tokenTimeMap.get(t.id) ??
            (t.sourceStartMs ? t.sourceStartMs / 1000 : atomStartSec);
          bWords.push({
            text: t.text,
            sec: t.durationSec,
            isFiller: t.fillerTag === 'pure' || glossaryHabitWords.has(t.text.trim()),
            timeSec: tTime,
          });
          bText += t.text;
        }
      }
    }

    if (bSpeechSec > 0 || bText.trim().length > 0) {
      rawAtoms.push({
        blockId: b.blockId,
        speakerId: b.speakerId,
        startSec: atomStartSec,
        endSec: atomStartSec + bSpeechSec,
        speechSec: bSpeechSec,
        text: bText,
        words: bWords,
      });
    }
  }

  // 2. 连续话轮还原：剥离纯倾听共鸣，合并同人连续发言
  const speakerBackchannels = new Map<string, number>();
  for (const tr of speakerTracks) {
    speakerBackchannels.set(tr.id, 0);
  }

  // 统计 overlapNote / overlapRegions 里的自然倾听附和
  for (const b of blocks) {
    if (b.overlapNote && b.overlapNote.speakerId) {
      speakerBackchannels.set(
        b.overlapNote.speakerId,
        (speakerBackchannels.get(b.overlapNote.speakerId) ?? 0) + 1
      );
    }
  }

  const mergedTurns: MergedSpeakerTurn[] = [];
  let currTurn: MergedSpeakerTurn | null = null;

  for (let i = 0; i < rawAtoms.length; i++) {
    const atom = rawAtoms[i];
    const isShortPhatic =
      atom.speechSec < 2.0 &&
      atom.text.length <= 8 &&
      isPureBackchannelText(atom.text);

    if (isShortPhatic) {
      speakerBackchannels.set(
        atom.speakerId,
        (speakerBackchannels.get(atom.speakerId) ?? 0) + 1
      );
      // 自然附和不打断原发言人的主话轮
      continue;
    }

    if (!currTurn) {
      currTurn = {
        speakerId: atom.speakerId,
        startSec: atom.startSec,
        endSec: atom.endSec,
        speechSec: atom.speechSec,
        text: atom.text,
        cpm: 0,
        words: [...atom.words],
      };
    } else if (
      currTurn.speakerId === atom.speakerId &&
      (atom.startSec - currTurn.endSec <= 4.0 ||
        atom.startSec <= currTurn.endSec + 1.0 ||
        (optionalTimelineParams?.blockEditedStartsSec === undefined && i > 0))
    ) {
      // 同一发言人且间隔较近，合并为真实连续话轮
      currTurn.endSec = Math.max(currTurn.endSec, atom.endSec);
      currTurn.speechSec += atom.speechSec;
      currTurn.text += atom.text;
      currTurn.words.push(...atom.words);
    } else {
      const min = Math.max(0.05, currTurn.speechSec / 60);
      const chars = currTurn.text.replace(/[，。？！、；：\s…!?,.]/g, '').length;
      currTurn.cpm = Math.round(chars / min);
      mergedTurns.push(currTurn);

      currTurn = {
        speakerId: atom.speakerId,
        startSec: atom.startSec,
        endSec: atom.endSec,
        speechSec: atom.speechSec,
        text: atom.text,
        cpm: 0,
        words: [...atom.words],
      };
    }
  }

  if (currTurn) {
    const min = Math.max(0.05, currTurn.speechSec / 60);
    const chars = currTurn.text.replace(/[，。？！、；：\s…!?,.]/g, '').length;
    currTurn.cpm = Math.round(chars / min);
    mergedTurns.push(currTurn);
  }

  // 3. 计算每个人的全局声学与文本特征
  const trackMap = new Map<string, SpeakerTrack>();
  for (const tr of speakerTracks) {
    trackMap.set(tr.id, tr);
  }

  // 跨人接话留白统计
  const speakerTurnGaps = new Map<string, number[]>();
  for (let i = 1; i < mergedTurns.length; i++) {
    const prev = mergedTurns[i - 1];
    const curr = mergedTurns[i];
    if (prev.speakerId !== curr.speakerId) {
      const gap = Math.max(0, curr.startSec - prev.endSec);
      const arr = speakerTurnGaps.get(curr.speakerId) ?? [];
      arr.push(gap);
      speakerTurnGaps.set(curr.speakerId, arr);
    }
  }

  // 实质性抢话统计（对方未讲完且展开实质发言）
  const speakerInterruptions = new Map<string, HabitEvidenceAnchor[]>();
  for (const ov of overlapRegions) {
    const dur = ov.editedEndSec - ov.editedStartSec;
    if (dur >= 0.8 && !isPureBackchannelText(ov.text ?? '')) {
      const arr = speakerInterruptions.get(ov.secondarySpeakerId) ?? [];
      arr.push({
        label: `抢话插入 (${dur.toFixed(1)}s)`,
        timeSec: ov.editedStartSec,
        timeFormatted: formatMmSs(ov.editedStartSec),
        snippet: ov.text ? `“${ov.text.slice(0, 16)}…”` : undefined,
      });
      speakerInterruptions.set(ov.secondarySpeakerId, arr);
    }
  }

  // 4. 逐个发言人计算诊断画像
  for (const tr of speakerTracks) {
    const spTurns = mergedTurns.filter((t) => t.speakerId === tr.id);
    const totalSpeechSec = spTurns.reduce((acc, t) => acc + t.speechSec, 0);

    if (totalSpeechSec <= 0.05) {
      const emptyScores: RadarDimensionScore[] = [
        { key: 'fluency', label: '语流洁净度', score: 0, detail: '暂无有效语音' },
        { key: 'pacing', label: '节奏与气口', score: 0, detail: '暂无有效语音' },
        { key: 'conciseness', label: '表达精炼度', score: 0, detail: '暂无有效语音' },
        { key: 'turnTaking', label: '话轮互动感', score: 0, detail: '暂无有效语音' },
        { key: 'specificity', label: '内容具象度', score: 0, detail: '暂无有效语音' },
      ];
      result.set(tr.id, {
        speakerId: tr.id,
        overallScore: 0,
        dimensions: emptyScores,
        microMetrics: {
          mergedTurnCount: 0,
          avgMergedTurnSec: 0,
          maxMergedTurnSec: 0,
          paceStdCpm: 0,
          trailingDropDb: null,
          avgTurnGapSec: null,
          backchannelCount: speakerBackchannels.get(tr.id) ?? 0,
          pureFillerCount: 0,
        },
        topHabitPhrases: [],
        habitInsights: [],
      });
      continue;
    }

    const minutes = Math.max(0.1, totalSpeechSec / 60);
    const fullText = spTurns.map((t) => t.text).join(' ');
    const cleanChars = fullText.replace(/[，。？！、；：\s…!?,.]/g, '').length;
    const avgCpm = Math.round(cleanChars / minutes);

    // 语速波动标准差
    const validTurnCpms = spTurns.filter((t) => t.cpm > 50).map((t) => t.cpm);
    let paceStdCpm = 0;
    if (validTurnCpms.length >= 2) {
      const meanCpm =
        validTurnCpms.reduce((a, b) => a + b, 0) / validTurnCpms.length;
      const variance =
        validTurnCpms.reduce((a, b) => a + Math.pow(b - meanCpm, 2), 0) /
        validTurnCpms.length;
      paceStdCpm = Math.round(Math.sqrt(variance));
    }

    // 单轮时长指标
    const turnCount = Math.max(1, spTurns.length);
    const avgTurnSec = Number((totalSpeechSec / turnCount).toFixed(1));
    let maxTurn = spTurns[0];
    for (const t of spTurns) {
      if (t.speechSec > maxTurn.speechSec) {
        maxTurn = t;
      }
    }

    // 统计纯口癖与口头禅指纹
    const phraseMap = new Map<
      string,
      {
        category: HabitPhraseCategory;
        categoryLabel: string;
        count: number;
        firstTimeSec: number;
      }
    >();

    let pureFillerCount = 0;
    for (const t of spTurns) {
      for (const w of t.words) {
        if (w.isFiller) {
          pureFillerCount++;
          const cleanW = w.text.trim();
          if (cleanW) {
            const entry = phraseMap.get(cleanW) ?? {
              category: 'pure_filler',
              categoryLabel: '语气词',
              count: 0,
              firstTimeSec: w.timeSec,
            };
            entry.count++;
            phraseMap.set(cleanW, entry);
          }
        }
      }
    }

    // 分句挖掘句首启动词与句尾确认禅
    for (const turn of spTurns) {
      const sentences = turn.text
        .split(/(?<=[。？！?!；;\n])/)
        .map((s) => s.trim())
        .filter(Boolean);

      for (const s of sentences) {
        // 句首启动禅
        for (const p of STARTER_CRUTCH_PATTERNS) {
          if (s.startsWith(p)) {
            const entry = phraseMap.get(p) ?? {
              category: 'starter_crutch',
              categoryLabel: '启动禅',
              count: 0,
              firstTimeSec: turn.startSec,
            };
            entry.count++;
            phraseMap.set(p, entry);
          }
        }
        // 句尾确认禅
        for (const p of HEDGING_TAIL_PATTERNS) {
          if (s.endsWith(p) || s.endsWith(p + '？') || s.endsWith(p + '?')) {
            const entry = phraseMap.get(p) ?? {
              category: 'hedging_tail',
              categoryLabel: '尾缀/缓冲',
              count: 0,
              firstTimeSec: turn.startSec,
            };
            entry.count++;
            phraseMap.set(p, entry);
          }
        }
      }
    }

    const topHabitPhrases: HabitPhraseItem[] = Array.from(phraseMap.entries())
      .map(([word, data]) => ({
        word,
        category: data.category,
        categoryLabel: data.categoryLabel,
        count: data.count,
        perMin: Number((data.count / minutes).toFixed(1)),
        firstTimeSec: data.firstTimeSec,
        firstTimeFormatted: formatMmSs(data.firstTimeSec),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // 声学句尾衰减计算 (trailingDropDb)
    let trailingDropDb: number | null = null;
    const trackPeaks = trackMap.get(tr.id)?.peaks ?? [];
    if (trackPeaks.length >= 80 && maxTurn.speechSec >= 6.0) {
      // 采样最长话轮末端与躯干区间的能量差
      const durTotal = trackMap.get(tr.id)?.durationMs ?? 60000;
      const r0 = Math.max(0, Math.min(1, (maxTurn.startSec * 1000) / durTotal));
      const r1 = Math.max(0, Math.min(1, (maxTurn.endSec * 1000) / durTotal));
      const idx0 = Math.floor(r0 * (trackPeaks.length - 1));
      const idx1 = Math.ceil(r1 * (trackPeaks.length - 1));
      if (idx1 - idx0 >= 10) {
        const bodySlice = trackPeaks.slice(
          idx0,
          idx0 + Math.floor((idx1 - idx0) * 0.7)
        );
        const tailSlice = trackPeaks.slice(
          idx0 + Math.floor((idx1 - idx0) * 0.8),
          idx1
        );
        const bodyAvg =
          bodySlice.reduce((a, b) => a + b, 0) / Math.max(1, bodySlice.length);
        const tailAvg =
          tailSlice.reduce((a, b) => a + b, 0) / Math.max(1, tailSlice.length);
        if (bodyAvg > 0.05 && tailAvg > 0.01) {
          const drop = Number((20 * Math.log10(tailAvg / bodyAvg)).toFixed(1));
          if (drop < 0 && drop > -20) {
            trailingDropDb = Math.abs(drop);
          }
        }
      }
    }

    // 平均接话留白
    const gaps = speakerTurnGaps.get(tr.id) ?? [];
    const avgTurnGapSec =
      gaps.length > 0
        ? Number((gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2))
        : null;

    const backchannelCount = speakerBackchannels.get(tr.id) ?? 0;

    const microMetrics: SpeakerHabitMicroMetrics = {
      mergedTurnCount: turnCount,
      avgMergedTurnSec: avgTurnSec,
      maxMergedTurnSec: Number(maxTurn.speechSec.toFixed(1)),
      paceStdCpm,
      trailingDropDb,
      avgTurnGapSec,
      backchannelCount,
      pureFillerCount,
    };

    // 五维雷达分数计算
    // 1. 语流洁净度 (Fluency): 纯口癖 + 句首垫词密度
    const totalCrutches = Array.from(phraseMap.values()).reduce(
      (a, b) => a + b.count,
      0
    );
    const crutchesPerMin = totalCrutches / minutes;
    const fluencyScore = clampScore(96 - Math.max(0, crutchesPerMin - 1.2) * 5.5);

    // 2. 节奏与气口 (Pacing): 语速偏离 + 语速忽快忽慢波动 + 句尾吞音
    const pacePenalty = Math.max(0, Math.abs(avgCpm - 215) - 65) * 0.12;
    const stdPenalty = Math.max(0, paceStdCpm - 45) * 0.18;
    const dropPenalty = trailingDropDb && trailingDropDb > 5.5 ? 4 : 0;
    const pacingScore = clampScore(95 - pacePenalty - stdPenalty - dropPenalty);

    // 3. 表达精炼度 (Conciseness): 超长独白、车轱辘话
    const longTurnCount = spTurns.filter((t) => t.speechSec >= 45).length;
    const veryLongTurnCount = spTurns.filter((t) => t.speechSec >= 70).length;
    const concisenessScore = clampScore(
      94 - veryLongTurnCount * 6.5 - longTurnCount * 2.5
    );

    // 4. 话轮互动感 (TurnTaking): 接话气口过短或过长、抢话打断、提问与总结
    const interruptions = speakerInterruptions.get(tr.id) ?? [];
    const interruptPenalty = Math.min(20, interruptions.length * 3.5);
    const gapBonus =
      avgTurnGapSec !== null && avgTurnGapSec >= 0.2 && avgTurnGapSec <= 1.2
        ? 6
        : 0;
    const backchannelBonus = Math.min(6, backchannelCount * 1.5);
    const turnTakingScore = clampScore(
      88 - interruptPenalty + gapBonus + backchannelBonus
    );

    // 5. 内容具象度 (Specificity): 词汇丰富度 + 具象事实/数据 vs 空泛套话
    const wordList = spTurns.flatMap((t) => t.words.map((w) => w.text));
    const uniqueRatio =
      wordList.length > 0
        ? new Set(wordList.map((w) => w.toLowerCase())).size / wordList.length
        : 0.45;
    const specificHits = countMatches(fullText, SPECIFIC_FACTS_RE);
    let glossaryHits = 0;
    for (const term of glossaryTerms) {
      if (fullText.toLowerCase().includes(term)) glossaryHits++;
    }
    const vagueHits = countMatches(fullText, VAGUE_WORDS_RE);
    const specScoreRaw =
      50 +
      uniqueRatio * 28 +
      Math.min(22, ((specificHits + glossaryHits * 2) / minutes) * 4) -
      Math.min(12, (vagueHits / minutes) * 1.5);
    const specificityScore = clampScore(specScoreRaw);

    const dimensions: RadarDimensionScore[] = [
      {
        key: 'fluency',
        label: '语流洁净度',
        score: fluencyScore,
        detail: `习惯词 ${crutchesPerMin.toFixed(1)} 处/分 · 纯口癖 ${pureFillerCount} 个`,
      },
      {
        key: 'pacing',
        label: '节奏与气口',
        score: pacingScore,
        detail: `均速 ${avgCpm} 字/分 · 波动 ±${paceStdCpm} · 均轮 ${avgTurnSec}s`,
      },
      {
        key: 'conciseness',
        label: '表达精炼度',
        score: concisenessScore,
        detail: `峰值独白 ${maxTurn.speechSec.toFixed(0)}s · 超长发言 ${longTurnCount} 轮`,
      },
      {
        key: 'turnTaking',
        label: '话轮互动感',
        score: turnTakingScore,
        detail: `倾听共鸣 ${backchannelCount} 次 · 实质抢话 ${interruptions.length} 次`,
      },
      {
        key: 'specificity',
        label: '内容具象度',
        score: specificityScore,
        detail: `词汇丰富度 ${Math.round(uniqueRatio * 100)}% · 事实案例 ${specificHits + glossaryHits} 处`,
      },
    ];

    const overallScore = Math.round(
      dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length
    );

    // 六维详细诊断卡片生成
    const habitInsights: SpeakerHabitInsight[] = [];
    const isHostRole = tr.role === 'host' || tr.role === 'co_host';

    // 1. 口癖与启动垫词习惯
    const topCrutch = topHabitPhrases[0];
    if (crutchesPerMin >= 3.2) {
      habitInsights.push({
        id: 'filler_fingerprint',
        category: '口头禅与垫词习惯',
        status: 'alert',
        metricBadge: `${crutchesPerMin.toFixed(1)} 处/分`,
        summary: `口头禅密度偏高，高频词为「${topCrutch?.word ?? '语气词'}」`,
        detail: isHostRole
          ? '【主持提问】：注意精简句首“然后/就是说”，提问直奔议题，气场更干练。'
          : '【嘉宾作答】：作答前可用 0.5s 自然停顿代替起手垫词，直接给观点。',
        evidences: topCrutch
          ? [
              {
                label: `高频词「${topCrutch.word}」首次出现`,
                timeSec: topCrutch.firstTimeSec,
                timeFormatted: topCrutch.firstTimeFormatted,
              },
            ]
          : [],
      });
    } else if (crutchesPerMin >= 1.5) {
      habitInsights.push({
        id: 'filler_fingerprint',
        category: '口头禅与垫词习惯',
        status: 'warn',
        metricBadge: `${crutchesPerMin.toFixed(1)} 处/分`,
        summary: `语流整体流畅，有少量习惯起手词（如「${topCrutch?.word ?? '垫词'}」）`,
        detail: '思考间隙建议以自然呼吸停顿替代句首垫词，信息传达更紧凑。',
        evidences: topCrutch
          ? [
              {
                label: `习惯词「${topCrutch.word}」`,
                timeSec: topCrutch.firstTimeSec,
                timeFormatted: topCrutch.firstTimeFormatted,
              },
            ]
          : [],
      });
    } else {
      habitInsights.push({
        id: 'filler_fingerprint',
        category: '口头禅与垫词习惯',
        status: 'good',
        metricBadge: `${crutchesPerMin.toFixed(1)} 处/分`,
        summary: '用词干练利落，废话垫词极少',
        detail: '语流干净利落，几乎无冗余口头禅干扰听感，表现优秀。',
        evidences: [],
      });
    }

    // 2. 语速波动与发声气息
    if (paceStdCpm >= 55) {
      const fastTurn = spTurns.reduce((prev, curr) =>
        curr.cpm > prev.cpm ? curr : prev
      );
      habitInsights.push({
        id: 'pace_prosody',
        category: '语速波动与气息习惯',
        status: 'warn',
        metricBadge: `波动 ±${paceStdCpm} 字/分`,
        summary: `语速起伏较大（峰值达 ${fastTurn.cpm} 字/分）`,
        detail:
          '兴奋或阐述复杂逻辑时容易快速飙速，输出核心结论时注意适度放慢 15% 留白。',
        evidences: [
          {
            label: `语速峰值段 (${fastTurn.cpm}字/分)`,
            timeSec: fastTurn.startSec,
            timeFormatted: formatMmSs(fastTurn.startSec),
            snippet: `“${fastTurn.text.slice(0, 16)}…”`,
          },
        ],
      });
    } else if (trailingDropDb !== null && trailingDropDb >= 5.5) {
      habitInsights.push({
        id: 'pace_prosody',
        category: '语速波动与气息习惯',
        status: 'warn',
        metricBadge: `句尾下沉 -${trailingDropDb}dB`,
        summary: '长句末尾有气息衰减、吞音趋势',
        detail: '长段落后半程注意保持腹腔气息支撑，避免末字音量脱落被降噪切掉。',
        evidences: [
          {
            label: `长独白收尾处`,
            timeSec: Math.max(0, maxTurn.endSec - 2.5),
            timeFormatted: formatMmSs(Math.max(0, maxTurn.endSec - 2.5)),
          },
        ],
      });
    } else {
      habitInsights.push({
        id: 'pace_prosody',
        category: '语速波动与气息习惯',
        status: 'good',
        metricBadge: `均速 ${avgCpm} 字/分`,
        summary: '语速平稳适中，气息充沛稳定',
        detail: '叙事节奏稳健，气口留白均匀，听众收听舒适度高。',
        evidences: [],
      });
    }

    // 3. 连续话轮纵深与结构（彻底无短碎附和警告）
    if (maxTurn.speechSec >= 48 || longTurnCount >= 2) {
      habitInsights.push({
        id: 'turn_structure',
        category: '单段时长与话轮结构',
        status: maxTurn.speechSec >= 75 ? 'alert' : 'warn',
        metricBadge: `峰值 ${maxTurn.speechSec.toFixed(0)}s`,
        summary: `单轮发言偏长（最长达 ${maxTurn.speechSec.toFixed(0)}s，共 ${longTurnCount} 轮超 45s）`,
        detail: isHostRole
          ? '【主持控场】：长独白容易挤占对谈空间，建议每 30s 主动抛球给嘉宾互动。'
          : '【嘉宾输出】：干货故事详实，中途可插入 1~2 秒停顿让主持适时搭话，增强呼吸感。',
        evidences: [
          {
            label: `最长独白 (${maxTurn.speechSec.toFixed(0)}s)`,
            timeSec: maxTurn.startSec,
            timeFormatted: formatMmSs(maxTurn.startSec),
            snippet: `“${maxTurn.text.slice(0, 18)}…”`,
          },
        ],
      });
    } else {
      habitInsights.push({
        id: 'turn_structure',
        category: '单段时长与话轮结构',
        status: 'good',
        metricBadge: `均轮 ${avgTurnSec}s`,
        summary: `节奏均衡：均轮 ${avgTurnSec}s，互动呼吸感良好`,
        detail: '话轮长度适中，与搭档形成自然穿插的对谈流动感。',
        evidences: [],
      });
    }

    // 4. 接话气口与抢话交叠
    if (interruptions.length >= 2) {
      habitInsights.push({
        id: 'turn_taking',
        category: '接话气口与抢话交叠',
        status: 'warn',
        metricBadge: `抢话 ${interruptions.length} 次`,
        summary: `存在 ${interruptions.length} 处在对方未收尾时的切入抢话`,
        detail:
          '切入热情很高，建议等对方尾音完全落地留白 0.3s 后再开麦，避免重叠杂音。',
        evidences: interruptions.slice(0, 2),
      });
    } else {
      habitInsights.push({
        id: 'turn_taking',
        category: '接话气口与抢话交叠',
        status: 'good',
        metricBadge: `共鸣 ${backchannelCount} 次`,
        summary: `倾听积极：有 ${backchannelCount} 次自然倾听共鸣，接话从容`,
        detail: '既有良好的倾听回应，又不会冒失抢话，对话礼仪极佳。',
        evidences: [],
      });
    }

    // 5. 表达精炼度与内容具象度
    if (vagueHits > specificHits * 1.8 && vagueHits >= 4) {
      habitInsights.push({
        id: 'lexical_conciseness',
        category: '用词具象度与信息密度',
        status: 'warn',
        metricBadge: `抽象词 ${vagueHits} 处`,
        summary: '用词偏抽象泛化，可增加数字与案例支撑',
        detail: isHostRole
          ? '【主持设问】：多引入真实业务情境，引导嘉宾展开具象经历。'
          : '【嘉宾阐述】：多补充“当时具体哪件事、数据对比”等真实细节，说服力更强。',
        evidences: [],
      });
    } else {
      habitInsights.push({
        id: 'lexical_conciseness',
        category: '用词具象度与信息密度',
        status: 'good',
        metricBadge: `论据 ${specificHits + glossaryHits} 处`,
        summary: '论据扎实，案例与客观细节充分',
        detail: '善用真实案例与逻辑词支撑核心论点，干货密度饱满。',
        evidences: [],
      });
    }

    // 6. 提问与总结收束时机
    const qCount = spTurns.reduce(
      (sum, t) => sum + extractGenuineQuestionsFromTurn(t.text).questionSentences.length,
      0
    );
    const sumCount = countMatches(fullText, CONVERGENCE_KEYWORDS_RE);
    if (isHostRole && qCount === 0 && turnCount >= 3) {
      habitInsights.push({
        id: 'role_timing',
        category: '角色控场与收束时机',
        status: 'alert',
        metricBadge: `提问 0 次`,
        summary: '全程缺少主动有效追问',
        detail: '主持需在关键议题处主动抛出探针式问句，推动对话纵深。',
        evidences: [],
      });
    } else {
      habitInsights.push({
        id: 'role_timing',
        category: '角色控场与收束时机',
        status: 'good',
        metricBadge: isHostRole ? `提问 ${qCount} 次` : `收束 ${sumCount} 处`,
        summary: isHostRole
          ? `控场得当：主动提问 ${qCount} 次，收束归纳 ${sumCount} 处`
          : `分享充实：观点阐述完整，收尾归纳 ${sumCount} 处`,
        detail: '在话题转折与关键节点自然推进，有效把握讨论重心。',
        evidences: [],
      });
    }

    result.set(tr.id, {
      speakerId: tr.id,
      overallScore,
      dimensions,
      microMetrics,
      topHabitPhrases,
      habitInsights,
    });
  }

  return result;
}
