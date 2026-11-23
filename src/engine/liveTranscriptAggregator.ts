import { LiveSpeakerSource, LiveUtterance } from '../types/liveSession';

export interface AggregatedUtteranceBlock {
  /** 使用首段 utterance.id 作为稳定区块键 */
  id: string;
  utterances: LiveUtterance[];
  utteranceIds: string[];
  speakerId: string;
  startMs: number;
  endMs: number;
  text: string;
  /** 该区块发言人是否已确认（manual / cloud / hybrid / 高置信度声纹或内容） */
  isSpeakerConfirmed: boolean;
  /** 是否仍需显示 '?' 待确认标记 */
  isUncertain: boolean;
  speakerSource?: LiveSpeakerSource;
  voiceprintCluster?: string;
  voiceprintConfidence?: number;
  contentConfidence?: number;
  speakerReason?: string;
  totalChars: number;
}

export interface UtteranceAggregationOptions {
  /** 短句阈值（字数 <= 该值时优先聚合，避免过短内容独占区块），默认 18 */
  shortCharLimit?: number;
  /** 常规连续同发言人最大静默间隔，默认 15000ms */
  maxGapMs?: number;
  /** 短句吸收允许的最大静默间隔，默认 30000ms */
  maxShortGapMs?: number;
  /** 长独白软分段字数阈值（超过且存在明显停顿时起新段，但短尾仍吸收），默认 280 */
  softMaxBlockChars?: number;
  /** 长独白软分段停顿阈值，默认 4000ms */
  softSplitGapMs?: number;
}

const DEFAULT_SHORT_CHAR_LIMIT = 18;
const DEFAULT_MAX_GAP_MS = 15_000;
const DEFAULT_MAX_SHORT_GAP_MS = 30_000;
const DEFAULT_SOFT_MAX_BLOCK_CHARS = 280;
const DEFAULT_SOFT_SPLIT_GAP_MS = 4_000;

export function isSpeakerConfirmedUtterance(u: LiveUtterance): boolean {
  if (
    u.speakerSource === 'manual' ||
    u.speakerSource === 'cloud' ||
    u.speakerSource === 'hybrid'
  ) {
    return true;
  }
  if (u.speakerSource === 'voiceprint') {
    return u.voiceprintConfidence === undefined || u.voiceprintConfidence >= 0.7;
  }
  if (u.speakerSource === 'content') {
    return typeof u.contentConfidence === 'number' && u.contentConfidence >= 0.75;
  }
  return false;
}

function isUtteranceUncertain(u: LiveUtterance): boolean {
  if (
    u.speakerSource === 'manual' ||
    u.speakerSource === 'cloud' ||
    u.speakerSource === 'hybrid'
  ) {
    return false;
  }
  if (
    u.speakerSource === 'content' &&
    typeof u.contentConfidence === 'number' &&
    u.contentConfidence >= 0.85
  ) {
    return false;
  }
  return true;
}

const SOURCE_PRIORITY: Record<LiveSpeakerSource, number> = {
  manual: 6,
  hybrid: 5,
  cloud: 4,
  content: 3,
  voiceprint: 2,
  fallback: 1,
};

export function separatorBetweenUtterances(prevText: string, nextText: string): string {
  const prevTrimmed = prevText.trimEnd();
  const nextTrimmed = nextText.trimStart();
  if (!prevTrimmed || !nextTrimmed) return '';
  const lastChar = prevTrimmed[prevTrimmed.length - 1];
  const firstChar = nextTrimmed[0];
  if (/[A-Za-z0-9]/.test(lastChar) && /[A-Za-z0-9]/.test(firstChar)) {
    return ' ';
  }
  return '';
}

export function buildSingleUtteranceBlock(u: LiveUtterance): AggregatedUtteranceBlock {
  const cleanText = u.text.trim();
  const confirmed = isSpeakerConfirmedUtterance(u);
  const uncertain = isUtteranceUncertain(u);
  const cluster = u.voiceprintCluster || u.speakerLabel;
  return {
    id: u.id,
    utterances: [u],
    utteranceIds: [u.id],
    speakerId: u.speakerId,
    startMs: u.startMs,
    endMs: u.endMs,
    text: u.text,
    isSpeakerConfirmed: confirmed,
    isUncertain: uncertain,
    speakerSource: u.speakerSource,
    voiceprintCluster: cluster,
    voiceprintConfidence: u.voiceprintConfidence,
    contentConfidence: u.contentConfidence,
    speakerReason: u.speakerReason,
    totalChars: cleanText.length,
  };
}

/**
 * 将右侧发言流在确认发言人后智能聚合为自然段落，同时吸收过短碎句避免孤立占块。
 * 不会修改原始 LiveUtterance 数组。
 */
export function aggregateLiveUtterances(
  utterances: LiveUtterance[],
  options: UtteranceAggregationOptions = {}
): AggregatedUtteranceBlock[] {
  if (utterances.length === 0) return [];

  const shortCharLimit = options.shortCharLimit ?? DEFAULT_SHORT_CHAR_LIMIT;
  const maxGapMs = options.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const maxShortGapMs = options.maxShortGapMs ?? DEFAULT_MAX_SHORT_GAP_MS;
  const softMaxBlockChars = options.softMaxBlockChars ?? DEFAULT_SOFT_MAX_BLOCK_CHARS;
  const softSplitGapMs = options.softSplitGapMs ?? DEFAULT_SOFT_SPLIT_GAP_MS;

  const blocks: AggregatedUtteranceBlock[] = [buildSingleUtteranceBlock(utterances[0])];

  for (let i = 1; i < utterances.length; i += 1) {
    const curr = utterances[i];
    const prevBlock = blocks[blocks.length - 1];
    const prev = prevBlock.utterances[prevBlock.utterances.length - 1];

    if (curr.speakerId !== prevBlock.speakerId) {
      blocks.push(buildSingleUtteranceBlock(curr));
      continue;
    }

    const currChars = curr.text.trim().length;
    const isCurrShort = currChars <= shortCharLimit;
    const isPrevShort = prevBlock.totalChars <= shortCharLimit;
    const currConfirmed = isSpeakerConfirmedUtterance(curr);
    const prevCluster = prev.voiceprintCluster || prev.speakerLabel;
    const currCluster = curr.voiceprintCluster || curr.speakerLabel;
    const sameCluster = Boolean(prevCluster && currCluster && prevCluster === currCluster);

    const speakerConsistent =
      (prevBlock.isSpeakerConfirmed && currConfirmed) ||
      sameCluster ||
      curr.speakerSource === 'fallback' ||
      ((isCurrShort || isPrevShort) && (prevBlock.isSpeakerConfirmed || currConfirmed)) ||
      (isCurrShort && isPrevShort);

    if (!speakerConsistent) {
      blocks.push(buildSingleUtteranceBlock(curr));
      continue;
    }

    const gapMs = Math.max(0, curr.startMs - prev.endMs);
    const shouldMerge =
      isCurrShort || isPrevShort
        ? gapMs <= maxShortGapMs
        : gapMs <= maxGapMs &&
          !(prevBlock.totalChars >= softMaxBlockChars && gapMs >= softSplitGapMs);

    if (!shouldMerge) {
      blocks.push(buildSingleUtteranceBlock(curr));
      continue;
    }

    const sep = separatorBetweenUtterances(prevBlock.text, curr.text);
    const nextUtterances = [...prevBlock.utterances, curr];
    const hasStrongConfirmed = nextUtterances.some((u) => !isUtteranceUncertain(u));
    const allFallbackOrConfirmed = nextUtterances.every(
      (u) => u.speakerSource === 'fallback' || isSpeakerConfirmedUtterance(u)
    );
    const confValues = nextUtterances
      .map((u) => u.voiceprintConfidence)
      .filter((v): v is number => typeof v === 'number');
    const avgConfidence =
      confValues.length > 0
        ? Number(
            (confValues.reduce((sum, v) => sum + v, 0) / confValues.length).toFixed(2)
          )
        : undefined;
    const contentConfValues = nextUtterances
      .map((u) => u.contentConfidence)
      .filter((v): v is number => typeof v === 'number');
    const avgContentConfidence =
      contentConfValues.length > 0
        ? Number(
            (
              contentConfValues.reduce((sum, v) => sum + v, 0) /
              contentConfValues.length
            ).toFixed(2)
          )
        : undefined;
    const firstCluster = nextUtterances
      .map((u) => u.voiceprintCluster || u.speakerLabel)
      .find((c): c is string => Boolean(c));
    const firstReason = nextUtterances
      .map((u) => u.speakerReason)
      .find((r): r is string => Boolean(r && r.trim()));
    const bestSource = nextUtterances.reduce<LiveSpeakerSource>(
      (best, u) =>
        (SOURCE_PRIORITY[u.speakerSource] ?? 0) > (SOURCE_PRIORITY[best] ?? 0)
          ? u.speakerSource
          : best,
      nextUtterances[0].speakerSource
    );

    prevBlock.utterances = nextUtterances;
    prevBlock.utteranceIds = [...prevBlock.utteranceIds, curr.id];
    prevBlock.endMs = Math.max(prevBlock.endMs, curr.endMs);
    prevBlock.text = `${prevBlock.text}${sep}${curr.text}`;
    prevBlock.totalChars += currChars;
    prevBlock.isSpeakerConfirmed = hasStrongConfirmed || allFallbackOrConfirmed;
    prevBlock.isUncertain = !hasStrongConfirmed;
    prevBlock.speakerSource = bestSource;
    prevBlock.voiceprintCluster = firstCluster;
    prevBlock.voiceprintConfidence = avgConfidence;
    prevBlock.contentConfidence = avgContentConfidence;
    prevBlock.speakerReason = firstReason;
  }

  return blocks;
}
