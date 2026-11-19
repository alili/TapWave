import {
  GlossaryItem,
  PodcastProjectState,
  TranscriptBlock,
  TranscriptToken,
} from '../types/podcast';

export type SubtitleFormatKind =
  | 'srt'
  | 'vtt'
  | 'ass'
  | 'lrc'
  | 'json'
  | 'timestamped_txt'
  | 'plain_txt';

export interface ParsedSubtitleCue {
  index: number;
  startMs: number | null;
  endMs: number | null;
  text: string;
  speakerHint?: string;
}

export interface ParsedSubtitleDocument {
  fileName: string;
  format: SubtitleFormatKind;
  formatLabel: string;
  hasTimestamps: boolean;
  cues: ParsedSubtitleCue[];
  totalCharCount: number;
}

export interface SubtitleAlignOptions {
  targetTrackId: string; // 'all' | track.id
  timeOffsetMs: number;
  autoHideOmittedFillers: boolean;
  syncPunctuation: boolean;
  extractGlossaryWords: boolean;
}

export interface SubtitleReplacementTokenSpec {
  text: string;
  weight: number;
}

export interface SubtitleCorrectionHunk {
  id: string;
  blockId: string;
  speakerId: string;
  speakerName: string;
  speakerColor: string;
  startMs: number;
  endMs: number;
  beforeText: string;
  afterText: string;
  kind: 'typo_replace' | 'punctuation' | 'filler_hide' | 'placeholder_fill';
  targetTokenIds: string[];
  replacementSpecs: SubtitleReplacementTokenSpec[];
  markDeleted?: boolean;
}

export interface SubtitleAlignmentPreview {
  document: ParsedSubtitleDocument;
  hunks: SubtitleCorrectionHunk[];
  matchedTokenCount: number;
  candidateGlossaryWords: string[];
}

const PUNCT_CHARS_RE = /^[，。？！、；：,.?!;:）》」』”’】\]…—\-]+$/;
const CJK_CHAR_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const HESITATION_BASE_SET = new Set(['呃', '啊', '嗯', '哦', '诶', '唉', '额', '唔']);
const PURE_FILLER_PHRASES = new Set(['那个', '就是', '然后', '怎么说呢', '就是说', '其实吧']);

export function normalizeBaseToken(text: string): string {
  return text
    .replace(/[，。？！、；：,.?!;:（）()《》「」『』“”‘’【】\[\]…—\-\s]/g, '')
    .toLowerCase();
}

function isPureHesitationToken(tok: TranscriptToken): boolean {
  if (tok.fillerTag === 'pure') return true;
  // Only treat untagged single-syllable '呃'/'嗯' as pure hesitation when followed by pause/punctuation
  return /^[呃嗯额][，、,.…]+$/.test(tok.text.trim());
}

/**
 * Tokenizes third-party subtitle text into PodCraft's character/word token granularity
 * (1 CJK char + trailing punctuation, or 1 contiguous English/numeric word + trailing punctuation).
 */
export function tokenizeSubtitleText(rawText: string): string[] {
  const cleaned = rawText
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];

  const out: string[] = [];
  let i = 0;
  const n = cleaned.length;

  while (i < n) {
    const ch = cleaned[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Opening quotes/brackets attach to next token if possible, or skip standalone
    if (/^[（(《「『“‘【\[]$/.test(ch)) {
      i++;
      continue;
    }

    if (CJK_CHAR_RE.test(ch)) {
      let tok = ch;
      i++;
      while (i < n && PUNCT_CHARS_RE.test(cleaned[i])) {
        tok += cleaned[i];
        i++;
      }
      out.push(tok);
      continue;
    }

    if (/[A-Za-z0-9]/.test(ch)) {
      let tok = ch;
      i++;
      while (i < n && /[A-Za-z0-9'\-+._%]/.test(cleaned[i])) {
        // Don't swallow sentence-ending period if followed by space or CJK or end
        if (
          cleaned[i] === '.' &&
          (i + 1 >= n || /\s/.test(cleaned[i + 1]) || CJK_CHAR_RE.test(cleaned[i + 1]))
        ) {
          break;
        }
        tok += cleaned[i];
        i++;
      }
      while (i < n && PUNCT_CHARS_RE.test(cleaned[i])) {
        tok += cleaned[i];
        i++;
      }
      out.push(tok);
      continue;
    }

    // Trailing punctuation right after an emitted token -> merge onto previous token
    if (PUNCT_CHARS_RE.test(ch) && out.length > 0) {
      out[out.length - 1] += ch;
      i++;
      continue;
    }

    i++;
  }

  return out;
}

function parseFlexibleTimecodeToMs(raw: string): number | null {
  const s = raw.trim();
  // Matches [HH:]MM:SS[,/.]mmm or centiseconds
  const m = s.match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?$/);
  if (!m) return null;
  const hh = m[1] ? parseInt(m[1], 10) : 0;
  const mm = parseInt(m[2], 10);
  const ss = parseInt(m[3], 10);
  let ms = 0;
  if (m[4]) {
    const frac = m[4];
    if (frac.length === 1) ms = parseInt(frac, 10) * 100;
    else if (frac.length === 2) ms = parseInt(frac, 10) * 10;
    else ms = parseInt(frac.slice(0, 3), 10);
  }
  return ((hh * 3600 + mm * 60 + ss) * 1000 + ms) | 0;
}

function cleanCueLineAndExtractSpeaker(rawText: string): {
  text: string;
  speakerHint?: string;
} {
  let text = rawText
    // Strip ASS override blocks {\an8} {\pos(...)}
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/\\N|\\n/g, ' ')
    .replace(/\\h/g, ' ')
    .trim();

  let speakerHint: string | undefined;

  // WebVTT <v SpeakerName>text</v>
  const vttVoice = text.match(/^<v(?:\.[^>\s]+)?\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/i);
  if (vttVoice) {
    speakerHint = vttVoice[1].trim();
    text = vttVoice[2].trim();
  }

  // Strip remaining HTML/VTT tags like <c>, <i>, <b>, <font ...>, <00:01.200>
  text = text.replace(/<[^>]+>/g, '').trim();

  // Leading [Speaker]: or 发言人1：
  const prefixMatch = text.match(
    /^(?:\[([^\]]{1,20})\]|([\u4e00-\u9fa5A-Za-z0-9_ ]{1,16}))\s*[：:]\s+(.+)$/
  );
  if (prefixMatch && prefixMatch[3]) {
    speakerHint = speakerHint || (prefixMatch[1] || prefixMatch[2]).trim();
    text = prefixMatch[3].trim();
  }

  return { text: text.replace(/\s+/g, ' ').trim(), speakerHint };
}

function parseSrtOrVtt(raw: string, isVtt: boolean): ParsedSubtitleCue[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const cues: ParsedSubtitleCue[] = [];
  const arrowRe =
    /((?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3})/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (
      !line ||
      line.startsWith('WEBVTT') ||
      line.startsWith('NOTE') ||
      line.startsWith('STYLE')
    ) {
      if (line.startsWith('NOTE') || line.startsWith('STYLE')) {
        while (i < lines.length && lines[i].trim() !== '') i++;
      }
      i++;
      continue;
    }

    const arrowMatch = line.match(arrowRe);
    if (!arrowMatch) {
      i++;
      continue;
    }

    const startMs = parseFlexibleTimecodeToMs(arrowMatch[1]);
    const endMs = parseFlexibleTimecodeToMs(arrowMatch[2]);
    i++;

    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      if (arrowRe.test(lines[i])) break;
      textLines.push(lines[i].trim());
      i++;
    }

    const joined = textLines.join(' ');
    const { text, speakerHint } = cleanCueLineAndExtractSpeaker(joined);
    if (text && startMs !== null && endMs !== null) {
      cues.push({
        index: cues.length,
        startMs,
        endMs: Math.max(startMs + 80, endMs),
        text,
        speakerHint,
      });
    }
  }

  void isVtt;
  return cues;
}

function parseAssOrSsa(raw: string): ParsedSubtitleCue[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const cues: ParsedSubtitleCue[] = [];
  let inEvents = false;
  let formatCols = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;
    if (/^\[events\]$/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (/^\[.+\]$/.test(line)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;

    if (/^format\s*:/i.test(line)) {
      const rest = line.replace(/^format\s*:/i, '').trim();
      formatCols = rest.split(',').map((c) => c.trim().toLowerCase());
      continue;
    }

    if (/^dialogue\s*:/i.test(line)) {
      const rest = line.replace(/^dialogue\s*:/i, '').trimStart();
      const parts: string[] = [];
      let cursor = 0;
      for (let c = 0; c < formatCols.length - 1; c++) {
        const commaIdx = rest.indexOf(',', cursor);
        if (commaIdx === -1) break;
        parts.push(rest.slice(cursor, commaIdx).trim());
        cursor = commaIdx + 1;
      }
      parts.push(rest.slice(cursor));
      if (parts.length < formatCols.length) continue;

      const startIdx = formatCols.indexOf('start');
      const endIdx = formatCols.indexOf('end');
      const nameIdx =
        formatCols.indexOf('name') !== -1
          ? formatCols.indexOf('name')
          : formatCols.indexOf('actor');
      const textIdx = formatCols.indexOf('text');
      if (startIdx === -1 || endIdx === -1 || textIdx === -1) continue;

      const startMs = parseFlexibleTimecodeToMs(parts[startIdx]);
      const endMs = parseFlexibleTimecodeToMs(parts[endIdx]);
      const { text, speakerHint } = cleanCueLineAndExtractSpeaker(parts[textIdx]);
      const actorName = nameIdx !== -1 && parts[nameIdx] ? parts[nameIdx].trim() : undefined;

      if (text && startMs !== null && endMs !== null) {
        cues.push({
          index: cues.length,
          startMs,
          endMs: Math.max(startMs + 80, endMs),
          text,
          speakerHint: actorName || speakerHint,
        });
      }
    }
  }

  return cues;
}

function parseLrc(raw: string): ParsedSubtitleCue[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const temp: Array<{ startMs: number; text: string; speakerHint?: string }> = [];
  const tagRe = /\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/g;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const matches = Array.from(line.matchAll(tagRe));
    if (matches.length === 0) continue;
    const strippedText = line.replace(tagRe, '').trim();
    const { text, speakerHint } = cleanCueLineAndExtractSpeaker(strippedText);
    if (!text) continue;

    for (const m of matches) {
      const ms = parseFlexibleTimecodeToMs(m[1].replace(/:(\d{1,3})$/, '.$1'));
      if (ms !== null) {
        temp.push({ startMs: ms, text, speakerHint });
      }
    }
  }

  temp.sort((a, b) => a.startMs - b.startMs);
  return temp.map((item, idx) => {
    const nextStart = temp[idx + 1]?.startMs;
    const maxNaturalSpan = item.startMs + Math.max(10000, item.text.length * 450);
    const fallbackEnd = item.startMs + Math.max(2000, item.text.length * 260);
    const endMs =
      nextStart !== undefined
        ? Math.min(maxNaturalSpan, Math.max(item.startMs + 120, nextStart))
        : fallbackEnd;
    return {
      index: idx,
      startMs: item.startMs,
      endMs,
      text: item.text,
      speakerHint: item.speakerHint,
    };
  });
}

function parseJsonSubtitle(raw: string): ParsedSubtitleCue[] | null {
  try {
    const data = JSON.parse(raw) as unknown;
    let items: Array<Record<string, unknown>> | null = null;
    if (Array.isArray(data)) {
      items = data as Array<Record<string, unknown>>;
    } else if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      for (const key of ['body', 'segments', 'utterances', 'sentences', 'cues', 'paragraphs', 'result']) {
        if (Array.isArray(obj[key])) {
          items = obj[key] as Array<Record<string, unknown>>;
          break;
        }
      }
    }
    if (!items || items.length === 0) return null;

    const cues: ParsedSubtitleCue[] = [];
    for (const row of items) {
      if (!row || typeof row !== 'object') continue;
      const rawText = String(
        row.text ?? row.content ?? row.sentence ?? row.transcript ?? ''
      ).trim();
      if (!rawText) continue;

      let startMs: number | null = null;
      let endMs: number | null = null;

      if (typeof row.startMs === 'number' || typeof row.start_time === 'number' || typeof row.begin_time === 'number') {
        startMs = Math.round(Number(row.startMs ?? row.start_time ?? row.begin_time));
        endMs = Math.round(Number(row.endMs ?? row.end_time ?? startMs + 1500));
      } else if (typeof row.from === 'number' || typeof row.start === 'number') {
        const sVal = Number(row.from ?? row.start);
        const eVal = Number(row.to ?? row.end ?? sVal + 1.5);
        // Whisper & Bilibili BCC use seconds
        startMs = Math.round(sVal * 1000);
        endMs = Math.round(eVal * 1000);
      }

      const { text, speakerHint } = cleanCueLineAndExtractSpeaker(rawText);
      const sp =
        typeof row.speaker === 'string'
          ? row.speaker
          : typeof row.speaker_name === 'string'
          ? row.speaker_name
          : speakerHint;

      if (text) {
        cues.push({
          index: cues.length,
          startMs,
          endMs: startMs !== null && endMs !== null ? Math.max(startMs + 80, endMs) : null,
          text,
          speakerHint: sp,
        });
      }
    }
    return cues.length > 0 ? cues : null;
  } catch {
    return null;
  }
}

function parseTextTranscript(raw: string): {
  cues: ParsedSubtitleCue[];
  hasTimestamps: boolean;
} {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Detect Feishu妙记 / 通义听悟 / 小宇宙 style timestamped transcripts:
  // Pattern A: Header line "发言人 1 00:12" or "主播A 00:01:23" followed by text lines
  // Pattern B: Inline "[00:12] 主播：内容" or "00:12 内容"
  const headerRe =
    /^(?:([\u4e00-\u9fa5A-Za-z0-9_ -]{1,20})\s+)?\[?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?)\]?$/;
  const inlineRe =
    /^\[?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?)\]?\s+(.+)$/;

  const tsEntries: Array<{ startMs: number; text: string; speakerHint?: string }> = [];
  let pendingHeader: { startMs: number; speakerHint?: string; buf: string[] } | null = null;

  for (const line of lines) {
    const hm = line.match(headerRe);
    if (hm) {
      const ms = parseFlexibleTimecodeToMs(hm[2]);
      if (ms !== null) {
        if (pendingHeader && pendingHeader.buf.length > 0) {
          tsEntries.push({
            startMs: pendingHeader.startMs,
            speakerHint: pendingHeader.speakerHint,
            text: pendingHeader.buf.join(' '),
          });
        }
        pendingHeader = {
          startMs: ms,
          speakerHint: hm[1]?.trim(),
          buf: [],
        };
        continue;
      }
    }

    const im = line.match(inlineRe);
    if (im) {
      const ms = parseFlexibleTimecodeToMs(im[1]);
      if (ms !== null) {
        if (pendingHeader && pendingHeader.buf.length > 0) {
          tsEntries.push({
            startMs: pendingHeader.startMs,
            speakerHint: pendingHeader.speakerHint,
            text: pendingHeader.buf.join(' '),
          });
          pendingHeader = null;
        }
        const { text, speakerHint } = cleanCueLineAndExtractSpeaker(im[2]);
        if (text) {
          tsEntries.push({ startMs: ms, text, speakerHint });
        }
        continue;
      }
    }

    if (pendingHeader) {
      pendingHeader.buf.push(line);
    }
  }

  if (pendingHeader && pendingHeader.buf.length > 0) {
    tsEntries.push({
      startMs: pendingHeader.startMs,
      speakerHint: pendingHeader.speakerHint,
      text: pendingHeader.buf.join(' '),
    });
  }

  if (tsEntries.length >= 2 || (tsEntries.length === 1 && lines.length <= 3)) {
    tsEntries.sort((a, b) => a.startMs - b.startMs);
    const cues: ParsedSubtitleCue[] = tsEntries.map((entry, idx) => {
      const nextStart = tsEntries[idx + 1]?.startMs;
      const estEnd = entry.startMs + Math.max(1800, entry.text.length * 220);
      return {
        index: idx,
        startMs: entry.startMs,
        endMs:
          nextStart !== undefined
            ? Math.min(estEnd, Math.max(entry.startMs + 150, nextStart))
            : estEnd,
        text: entry.text,
        speakerHint: entry.speakerHint,
      };
    });
    return { cues, hasTimestamps: true };
  }

  // Pure plain-text / Markdown proofread script
  const plainCues: ParsedSubtitleCue[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line) || /^---+$/.test(line)) continue;
    const mdStripped = line.replace(/\*\*|__|`/g, '');
    const { text, speakerHint } = cleanCueLineAndExtractSpeaker(mdStripped);
    if (text) {
      plainCues.push({
        index: plainCues.length,
        startMs: null,
        endMs: null,
        text,
        speakerHint,
      });
    }
  }
  return { cues: plainCues, hasTimestamps: false };
}

/**
 * Auto-detects and parses third-party subtitle or proofread transcript content.
 */
export function parseSubtitleDocument(
  rawContent: string,
  fileName = '粘贴文稿.txt'
): ParsedSubtitleDocument {
  const cleaned = rawContent.replace(/^\uFEFF/, '').trim();
  const ext = (fileName.split('.').pop() || '').toLowerCase();

  let format: SubtitleFormatKind = 'plain_txt';
  let formatLabel = '纯文本校对稿 (TXT)';
  let cues: ParsedSubtitleCue[] = [];
  let hasTimestamps = false;

  if (ext === 'json' || ext === 'bcc' || cleaned.startsWith('{') || cleaned.startsWith('[')) {
    const jsonCues = parseJsonSubtitle(cleaned);
    if (jsonCues && jsonCues.length > 0) {
      format = 'json';
      formatLabel = 'JSON 结构化字幕';
      cues = jsonCues;
      hasTimestamps = jsonCues.some((c) => c.startMs !== null);
    }
  }

  if (cues.length === 0 && (ext === 'ass' || ext === 'ssa' || /\[events\]/i.test(cleaned))) {
    const assCues = parseAssOrSsa(cleaned);
    if (assCues.length > 0) {
      format = 'ass';
      formatLabel = 'ASS / SSA 时间轴字幕';
      cues = assCues;
      hasTimestamps = true;
    }
  }

  if (cues.length === 0 && (ext === 'vtt' || /^WEBVTT/i.test(cleaned))) {
    const vttCues = parseSrtOrVtt(cleaned, true);
    if (vttCues.length > 0) {
      format = 'vtt';
      formatLabel = 'WebVTT 时间轴字幕';
      cues = vttCues;
      hasTimestamps = true;
    }
  }

  if (
    cues.length === 0 &&
    (ext === 'srt' || /\d{1,2}:\d{2}[,.]\d{1,3}\s*-->\s*/.test(cleaned))
  ) {
    const srtCues = parseSrtOrVtt(cleaned, false);
    if (srtCues.length > 0) {
      format = 'srt';
      formatLabel = 'SRT 标准时间轴字幕';
      cues = srtCues;
      hasTimestamps = true;
    }
  }

  if (cues.length === 0 && (ext === 'lrc' || /^\[\d{2}:\d{2}[.:]\d{1,3}\]/m.test(cleaned))) {
    const lrcCues = parseLrc(cleaned);
    if (lrcCues.length > 0) {
      format = 'lrc';
      formatLabel = 'LRC 时间轴字幕';
      cues = lrcCues;
      hasTimestamps = true;
    }
  }

  if (cues.length === 0) {
    const parsedTxt = parseTextTranscript(cleaned);
    cues = parsedTxt.cues;
    hasTimestamps = parsedTxt.hasTimestamps;
    if (hasTimestamps) {
      format = 'timestamped_txt';
      formatLabel = '带时间戳校对文稿 (飞书/听悟/小宇宙)';
    } else {
      format = 'plain_txt';
      formatLabel = '纯文本校对逐字稿';
    }
  }

  const totalCharCount = cues.reduce((sum, c) => sum + normalizeBaseToken(c.text).length, 0);

  return {
    fileName,
    format,
    formatLabel,
    hasTimestamps,
    cues,
    totalCharCount,
  };
}

// ==================== Sequence Alignment Engine ====================

interface AsrWordRef {
  asrIdx: number;
  blockIdx: number;
  blockId: string;
  speakerId: string;
  tokenIdxInBlock: number;
  runId: number; // Increments whenever block changes or a non-word/deleted/silence token intervenes
  token: TranscriptToken;
  base: string;
  midMs: number;
}

interface SubWordRef {
  subIdx: number;
  cueIdx: number;
  text: string;
  base: string;
  startMs: number | null;
  endMs: number | null;
  midMs: number | null;
}

function tokenCharWeight(text: string): number {
  const b = normalizeBaseToken(text);
  if (!b) return 1;
  if (/^[a-z0-9]+$/i.test(b)) {
    return Math.max(1, Math.min(4, Math.ceil(b.length / 2.5)));
  }
  return Math.max(1, b.length);
}

/** O(K log K) Longest Increasing Subsequence over pair indices (i, j) strictly increasing in both i and j */
function longestIncreasingAnchorChain(pairs: Array<[number, number]>): Array<[number, number]> {
  if (pairs.length === 0) return [];
  // Sort by i ascending, and for ties in i by j descending so strictly increasing j guarantees strictly increasing i!
  const sorted = [...pairs].sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : b[1] - a[1]));

  const tailsIdx: number[] = [];
  const prevIdx = new Int32Array(sorted.length).fill(-1);

  for (let p = 0; p < sorted.length; p++) {
    const jVal = sorted[p][1];
    let lo = 0;
    let hi = tailsIdx.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[tailsIdx[mid]][1] < jVal) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) {
      prevIdx[p] = tailsIdx[lo - 1];
    }
    if (lo === tailsIdx.length) {
      tailsIdx.push(p);
    } else {
      tailsIdx[lo] = p;
    }
  }

  const result: Array<[number, number]> = [];
  let cur = tailsIdx[tailsIdx.length - 1];
  while (cur !== -1 && cur !== undefined) {
    result.push(sorted[cur]);
    cur = prevIdx[cur];
  }
  result.reverse();
  return result;
}

function buildSeededAnchors(
  asr: AsrWordRef[],
  sub: SubWordRef[],
  hasTimestamps: boolean
): Array<[number, number]> {
  const candidatePairs: Array<[number, number]> = [];

  if (hasTimestamps) {
    // Index ASR tokens by 2-gram and 1-gram base strings for fast temporally-constrained lookup
    const bigramMap = new Map<string, number[]>();
    const unigramMap = new Map<string, number[]>();

    for (let i = 0; i < asr.length; i++) {
      if (asr[i].base) {
        const u = unigramMap.get(asr[i].base);
        if (u) u.push(i);
        else unigramMap.set(asr[i].base, [i]);
      }
      if (i + 1 < asr.length && asr[i].base && asr[i + 1].base) {
        const key = `${asr[i].base}\u0001${asr[i + 1].base}`;
        const list = bigramMap.get(key);
        if (list) list.push(i);
        else bigramMap.set(key, [i]);
      }
    }

    for (let j = 0; j < sub.length - 1; j++) {
      const sMid = sub[j].midMs;
      if (sMid === null || !sub[j].base || !sub[j + 1].base) continue;
      const key = `${sub[j].base}\u0001${sub[j + 1].base}`;
      const hits = bigramMap.get(key);
      if (!hits) continue;
      let bestI = -1;
      let bestDist = 4500;
      for (const i of hits) {
        const d = Math.abs(asr[i].midMs - sMid);
        if (d < bestDist) {
          bestDist = d;
          bestI = i;
        }
      }
      if (bestI !== -1) {
        candidatePairs.push([bestI, j]);
        candidatePairs.push([bestI + 1, j + 1]);
      }
    }

    // Also add close 1-gram matches within +-1800ms to tighten short sentences with typos
    for (let j = 0; j < sub.length; j++) {
      const sMid = sub[j].midMs;
      if (sMid === null || !sub[j].base || HESITATION_BASE_SET.has(sub[j].base)) continue;
      const hits = unigramMap.get(sub[j].base);
      if (!hits) continue;
      const closeHits = hits.filter((i) => Math.abs(asr[i].midMs - sMid) <= 1800);
      if (closeHits.length === 1) {
        candidatePairs.push([closeHits[0], j]);
      }
    }
  } else {
    // Plain-text mode: unique N-gram anchors (k = 4, 3, 2)
    for (const k of [4, 3, 2]) {
      const asrCounts = new Map<string, number>();
      const subCounts = new Map<string, number>();
      for (let i = 0; i <= asr.length - k; i++) {
        const key = asr
          .slice(i, i + k)
          .map((x) => x.base)
          .join('\u0001');
        asrCounts.set(key, asrCounts.has(key) ? -2 : i);
      }
      for (let j = 0; j <= sub.length - k; j++) {
        const key = sub
          .slice(j, j + k)
          .map((x) => x.base)
          .join('\u0001');
        subCounts.set(key, subCounts.has(key) ? -2 : j);
      }
      for (const [key, iPos] of asrCounts.entries()) {
        if (iPos < 0) continue;
        const jPos = subCounts.get(key);
        if (jPos !== undefined && jPos >= 0) {
          for (let t = 0; t < k; t++) {
            candidatePairs.push([iPos + t, jPos + t]);
          }
        }
      }
    }
  }

  const chain = longestIncreasingAnchorChain(candidatePairs);
  // Deduplicate exact pairs
  const dedup: Array<[number, number]> = [];
  for (const [i, j] of chain) {
    if (dedup.length === 0 || (i > dedup[dedup.length - 1][0] && j > dedup[dedup.length - 1][1])) {
      dedup.push([i, j]);
    }
  }
  return dedup;
}

type OpStep =
  | { op: 'align'; aIdx: number; bIdx: number }
  | { op: 'del_asr'; aIdx: number }
  | { op: 'ins_sub'; bIdx: number };

/**
 * Filler-aware Needleman-Wunsch local gap alignment.
 */
function alignGapDp(asrSlice: AsrWordRef[], subSlice: SubWordRef[]): OpStep[] {
  const m = asrSlice.length;
  const n = subSlice.length;
  if (m === 0 && n === 0) return [];
  if (m === 0) return subSlice.map((b) => ({ op: 'ins_sub', bIdx: b.subIdx }));
  if (n === 0) return asrSlice.map((a) => ({ op: 'del_asr', aIdx: a.asrIdx }));

  // Guard against pathological giant unanchored gaps (> 260 x 260) by chunking proportionally
  if (m * n > 70000) {
    const midM = m >>> 1;
    const midN = n >>> 1;
    return [
      ...alignGapDp(asrSlice.slice(0, midM), subSlice.slice(0, midN)),
      ...alignGapDp(asrSlice.slice(midM), subSlice.slice(midN)),
    ];
  }

  const cols = n + 1;
  const dp = new Float32Array((m + 1) * cols);
  const ptr = new Uint8Array((m + 1) * cols); // 1: diag, 2: up (del_asr), 3: left (ins_sub)

  for (let i = 1; i <= m; i++) {
    const pen = isPureHesitationToken(asrSlice[i - 1].token) ? -0.25 : -1.5;
    dp[i * cols] = dp[(i - 1) * cols] + pen;
    ptr[i * cols] = 2;
  }
  for (let j = 1; j <= n; j++) {
    dp[j] = dp[j - 1] - 1.5;
    ptr[j] = 3;
  }

  for (let i = 1; i <= m; i++) {
    const a = asrSlice[i - 1];
    const skipAsrPen = isPureHesitationToken(a.token) ? -0.25 : -1.5;
    for (let j = 1; j <= n; j++) {
      const b = subSlice[j - 1];
      let subScore = -0.6;
      if (a.base && a.base === b.base) {
        subScore = 4.2;
      } else if (
        !isPureHesitationToken(a.token) &&
        a.base.length > 0 &&
        b.base.length > 0 &&
        ((CJK_CHAR_RE.test(a.base[0]) && CJK_CHAR_RE.test(b.base[0])) ||
          (/^[a-z0-9]/i.test(a.base) && /^[a-z0-9]/i.test(b.base)))
      ) {
        subScore = 1.15;
      } else if (isPureHesitationToken(a.token) && !HESITATION_BASE_SET.has(b.base)) {
        // Strongly discourage aligning a pure '呃' hesitation onto a real content word!
        subScore = -2.2;
      }

      if (b.midMs !== null) {
        const dt = Math.abs(a.midMs - b.midMs);
        if (dt <= 800) subScore += 0.45;
        else if (dt > 3500) subScore -= 1.2;
      }

      const diag = dp[(i - 1) * cols + (j - 1)] + subScore;
      const up = dp[(i - 1) * cols + j] + skipAsrPen;
      const left = dp[i * cols + (j - 1)] - 1.5;

      const idx = i * cols + j;
      if (diag >= up && diag >= left) {
        dp[idx] = diag;
        ptr[idx] = 1;
      } else if (up >= left) {
        dp[idx] = up;
        ptr[idx] = 2;
      } else {
        dp[idx] = left;
        ptr[idx] = 3;
      }
    }
  }

  const steps: OpStep[] = [];
  let ci = m;
  let cj = n;
  while (ci > 0 || cj > 0) {
    const move = ptr[ci * cols + cj];
    if (ci > 0 && cj > 0 && move === 1) {
      steps.push({ op: 'align', aIdx: asrSlice[ci - 1].asrIdx, bIdx: subSlice[cj - 1].subIdx });
      ci--;
      cj--;
    } else if (ci > 0 && (cj === 0 || move === 2)) {
      steps.push({ op: 'del_asr', aIdx: asrSlice[ci - 1].asrIdx });
      ci--;
    } else {
      steps.push({ op: 'ins_sub', bIdx: subSlice[cj - 1].subIdx });
      cj--;
    }
  }
  steps.reverse();
  return steps;
}

function isPlaceholderWord(tok: TranscriptToken): boolean {
  return (
    tok.type === 'word' &&
    (tok.text.startsWith('[语音 ') || tok.text.startsWith('[音轨片段'))
  );
}

/**
 * Computes a complete, non-destructive alignment preview between the current PodcastProjectState
 * and a parsed third-party subtitle / proofread transcript document.
 */
export function previewSubtitleCorrection(
  state: PodcastProjectState,
  doc: ParsedSubtitleDocument,
  options: SubtitleAlignOptions
): SubtitleAlignmentPreview {
  const speakerMap = Object.fromEntries(state.tracks.map((t) => [t.id, t]));

  // Build shifted subtitle token stream
  const subTokens: SubWordRef[] = [];
  doc.cues.forEach((cue, cueIdx) => {
    const pieces = tokenizeSubtitleText(cue.text);
    if (pieces.length === 0) return;

    const cStart =
      cue.startMs !== null ? Math.max(0, cue.startMs + options.timeOffsetMs) : null;
    const cEnd =
      cue.endMs !== null ? Math.max(cStart ?? 0, cue.endMs + options.timeOffsetMs) : null;

    const totalW = pieces.reduce((s, p) => s + tokenCharWeight(p), 0) || 1;
    let accW = 0;

    for (const piece of pieces) {
      const w = tokenCharWeight(piece);
      let sMs: number | null = null;
      let eMs: number | null = null;
      let mMs: number | null = null;
      if (cStart !== null && cEnd !== null) {
        const span = Math.max(40, cEnd - cStart);
        sMs = Math.round(cStart + (accW / totalW) * span);
        eMs = Math.round(cStart + ((accW + w) / totalW) * span);
        mMs = Math.round((sMs + eMs) / 2);
      }
      accW += w;
      subTokens.push({
        subIdx: subTokens.length,
        cueIdx,
        text: piece,
        base: normalizeBaseToken(piece),
        startMs: sMs,
        endMs: eMs,
        midMs: mMs,
      });
    }
  });

  if (subTokens.length === 0 || state.blocks.length === 0) {
    return {
      document: doc,
      hunks: [],
      matchedTokenCount: 0,
      candidateGlossaryWords: [],
    };
  }

  // Collect active ASR word tokens in target scope
  const asrTokens: AsrWordRef[] = [];
  let currentRunId = 0;

  state.blocks.forEach((block, blockIdx) => {
    if (options.targetTrackId !== 'all' && block.speakerId !== options.targetTrackId) {
      return;
    }
    currentRunId++;
    block.tokens.forEach((tok, tokenIdxInBlock) => {
      if (tok.deleted || tok.type !== 'word') {
        currentRunId++;
        return;
      }
      asrTokens.push({
        asrIdx: asrTokens.length,
        blockIdx,
        blockId: block.blockId,
        speakerId: block.speakerId,
        tokenIdxInBlock,
        runId: currentRunId,
        token: tok,
        base: normalizeBaseToken(tok.text),
        midMs: Math.round((tok.sourceStartMs + tok.sourceEndMs) / 2),
      });
    });
  });

  if (asrTokens.length === 0) {
    return {
      document: doc,
      hunks: [],
      matchedTokenCount: 0,
      candidateGlossaryWords: [],
    };
  }

  // Special Mode A: Project currently has acoustic placeholders ([语音 00:01.2])
  const placeholderRefs = asrTokens.filter((r) => isPlaceholderWord(r.token));
  if (placeholderRefs.length > 0 && placeholderRefs.length >= asrTokens.length * 0.5) {
    const hunks: SubtitleCorrectionHunk[] = [];
    if (doc.hasTimestamps) {
      for (const pRef of placeholderRefs) {
        const pStart = pRef.token.sourceStartMs;
        const pEnd = pRef.token.sourceEndMs;
        const overlappingSub = subTokens.filter(
          (st) =>
            st.midMs !== null && st.midMs >= pStart - 450 && st.midMs <= pEnd + 450
        );
        if (overlappingSub.length === 0) continue;
        const sp = speakerMap[pRef.speakerId];
        hunks.push({
          id: `hunk_ph_${pRef.token.id}`,
          blockId: pRef.blockId,
          speakerId: pRef.speakerId,
          speakerName: sp?.name ?? '发言人',
          speakerColor: sp?.color ?? '#3b82f6',
          startMs: pStart,
          endMs: pEnd,
          beforeText: pRef.token.text,
          afterText: overlappingSub.map((x) => x.text).join(''),
          kind: 'placeholder_fill',
          targetTokenIds: [pRef.token.id],
          replacementSpecs: overlappingSub.map((x) => ({
            text: x.text,
            weight: tokenCharWeight(x.text),
          })),
        });
      }
    } else {
      const totalDur =
        placeholderRefs.reduce((s, r) => s + Math.max(0.1, r.token.durationSec), 0) || 1;
      let cursorIdx = 0;
      placeholderRefs.forEach((pRef, idx) => {
        const ratio = Math.max(0.1, pRef.token.durationSec) / totalDur;
        const count =
          idx === placeholderRefs.length - 1
            ? subTokens.length - cursorIdx
            : Math.max(1, Math.round(ratio * subTokens.length));
        const slice = subTokens.slice(cursorIdx, cursorIdx + count);
        cursorIdx += slice.length;
        if (slice.length === 0) return;
        const sp = speakerMap[pRef.speakerId];
        hunks.push({
          id: `hunk_ph_${pRef.token.id}`,
          blockId: pRef.blockId,
          speakerId: pRef.speakerId,
          speakerName: sp?.name ?? '发言人',
          speakerColor: sp?.color ?? '#3b82f6',
          startMs: pRef.token.sourceStartMs,
          endMs: pRef.token.sourceEndMs,
          beforeText: pRef.token.text,
          afterText: slice.map((x) => x.text).join(''),
          kind: 'placeholder_fill',
          targetTokenIds: [pRef.token.id],
          replacementSpecs: slice.map((x) => ({
            text: x.text,
            weight: tokenCharWeight(x.text),
          })),
        });
      });
    }

    return {
      document: doc,
      hunks,
      matchedTokenCount: subTokens.length,
      candidateGlossaryWords: [],
    };
  }

  // Standard Mode B: Align third-party subtitle against recognized ASR tokens
  const anchors = buildSeededAnchors(asrTokens, subTokens, doc.hasTimestamps);
  const allSteps: OpStep[] = [];

  const sentinelAnchors: Array<[number, number]> = [
    [-1, -1],
    ...anchors,
    [asrTokens.length, subTokens.length],
  ];

  for (let k = 0; k < sentinelAnchors.length - 1; k++) {
    const [aPrev, bPrev] = sentinelAnchors[k];
    const [aNext, bNext] = sentinelAnchors[k + 1];

    const aGap = asrTokens.slice(aPrev + 1, aNext);
    const bGap = subTokens.slice(bPrev + 1, bNext);

    if (aGap.length > 0 || bGap.length > 0) {
      if (doc.hasTimestamps && bGap.length > 0) {
        const minSubMs = (bGap[0].startMs ?? bGap[0].midMs ?? 0) - 1400;
        const maxSubMs =
          (bGap[bGap.length - 1].endMs ?? bGap[bGap.length - 1].midMs ?? 0) + 1400;

        const leadingOut: AsrWordRef[] = [];
        const inWindow: AsrWordRef[] = [];
        const trailingOut: AsrWordRef[] = [];

        for (const aRef of aGap) {
          if (aRef.midMs < minSubMs) leadingOut.push(aRef);
          else if (aRef.midMs > maxSubMs) trailingOut.push(aRef);
          else inWindow.push(aRef);
        }

        for (const r of leadingOut) allSteps.push({ op: 'del_asr', aIdx: r.asrIdx });
        allSteps.push(...alignGapDp(inWindow, bGap));
        for (const r of trailingOut) allSteps.push({ op: 'del_asr', aIdx: r.asrIdx });
      } else if (doc.hasTimestamps && bGap.length === 0) {
        // Check if this unanchored ASR span actually lies inside the subtitle's covered cue range
        // (e.g. an omitted filler between two anchored words!)
        const prevSubEnd = bPrev >= 0 ? subTokens[bPrev].endMs : null;
        const nextSubStart = bNext < subTokens.length ? subTokens[bNext].startMs : null;
        const insideCoveredSpan =
          prevSubEnd !== null &&
          nextSubStart !== null &&
          nextSubStart - prevSubEnd <= 5000;
        if (insideCoveredSpan) {
          for (const r of aGap) allSteps.push({ op: 'del_asr', aIdx: r.asrIdx });
        }
      } else {
        allSteps.push(...alignGapDp(aGap, bGap));
      }
    }

    if (aNext < asrTokens.length && bNext < subTokens.length) {
      allSteps.push({ op: 'align', aIdx: aNext, bIdx: bNext });
    }
  }

  // Extract clean, contiguous, intra-run correction hunks
  const hunks: SubtitleCorrectionHunk[] = [];
  const candidateGlossarySet = new Set<string>();
  let matchedTokenCount = 0;

  // Group non-identical step runs between exact anchors
  let idx = 0;
  while (idx < allSteps.length) {
    const st = allSteps[idx];
    if (st.op === 'align') {
      const a = asrTokens[st.aIdx];
      const b = subTokens[st.bIdx];
      if (a.base === b.base) {
        matchedTokenCount++;
        // Check pure punctuation difference on an otherwise identical word
        if (options.syncPunctuation && a.token.text !== b.text) {
          const sp = speakerMap[a.speakerId];
          hunks.push({
            id: `hunk_punct_${a.token.id}`,
            blockId: a.blockId,
            speakerId: a.speakerId,
            speakerName: sp?.name ?? '发言人',
            speakerColor: sp?.color ?? '#3b82f6',
            startMs: a.token.sourceStartMs,
            endMs: a.token.sourceEndMs,
            beforeText: a.token.text,
            afterText: b.text,
            kind: 'punctuation',
            targetTokenIds: [a.token.id],
            replacementSpecs: [{ text: b.text, weight: 1 }],
          });
        }
        idx++;
        continue;
      }
    }

    // Collect contiguous mismatch steps until the next exact base-matching 'align' step
    const chunkSteps: OpStep[] = [];
    while (idx < allSteps.length) {
      const cur = allSteps[idx];
      if (
        cur.op === 'align' &&
        asrTokens[cur.aIdx].base === subTokens[cur.bIdx].base
      ) {
        break;
      }
      chunkSteps.push(cur);
      idx++;
    }

    // First separate out pure omitted hesitation/filler deletions so they NEVER pollute adjacent word edits!
    const filteredSteps: OpStep[] = [];
    for (const cs of chunkSteps) {
      if (cs.op === 'del_asr') {
        const aRef = asrTokens[cs.aIdx];
        if (isPureHesitationToken(aRef.token)) {
          if (options.autoHideOmittedFillers) {
            const sp = speakerMap[aRef.speakerId];
            hunks.push({
              id: `hunk_filler_${aRef.token.id}`,
              blockId: aRef.blockId,
              speakerId: aRef.speakerId,
              speakerName: sp?.name ?? '发言人',
              speakerColor: sp?.color ?? '#3b82f6',
              startMs: aRef.token.sourceStartMs,
              endMs: aRef.token.sourceEndMs,
              beforeText: aRef.token.text,
              afterText: '（隐藏口癖）',
              kind: 'filler_hide',
              targetTokenIds: [aRef.token.id],
              replacementSpecs: [],
              markDeleted: true,
            });
          }
          continue;
        }
      }
      filteredSteps.push(cs);
    }

    if (filteredSteps.length === 0) continue;

    // Fast path: all steps in filteredSteps are 1-to-1 'align' substitutions!
    if (filteredSteps.every((s) => s.op === 'align')) {
      // Merge consecutive 1-to-1 substitutions in the same runId into a single readable phrase hunk!
      let gStart = 0;
      while (gStart < filteredSteps.length) {
        let gEnd = gStart;
        const firstA = asrTokens[(filteredSteps[gStart] as { op: 'align'; aIdx: number; bIdx: number }).aIdx];
        while (
          gEnd + 1 < filteredSteps.length &&
          asrTokens[(filteredSteps[gEnd + 1] as { op: 'align'; aIdx: number; bIdx: number }).aIdx].runId ===
            firstA.runId &&
          asrTokens[(filteredSteps[gEnd + 1] as { op: 'align'; aIdx: number; bIdx: number }).aIdx].asrIdx ===
            asrTokens[(filteredSteps[gEnd] as { op: 'align'; aIdx: number; bIdx: number }).aIdx].asrIdx + 1
        ) {
          gEnd++;
        }

        const slice = filteredSteps.slice(gStart, gEnd + 1) as Array<{
          op: 'align';
          aIdx: number;
          bIdx: number;
        }>;
        const aList = slice.map((s) => asrTokens[s.aIdx]);
        const bList = slice.map((s) => subTokens[s.bIdx]);
        const beforeText = aList.map((x) => x.token.text).join('');
        const afterText = bList.map((x) => x.text).join('');

        if (beforeText !== afterText) {
          const sp = speakerMap[firstA.speakerId];
          const cleanTerm = normalizeBaseToken(afterText);
          if (cleanTerm.length >= 2 && cleanTerm.length <= 12 && !PURE_FILLER_PHRASES.has(cleanTerm)) {
            candidateGlossarySet.add(afterText.replace(/[，。？！、；：,.?!;:]/g, '').trim());
          }
          hunks.push({
            id: `hunk_sub_${firstA.token.id}`,
            blockId: firstA.blockId,
            speakerId: firstA.speakerId,
            speakerName: sp?.name ?? '发言人',
            speakerColor: sp?.color ?? '#3b82f6',
            startMs: aList[0].token.sourceStartMs,
            endMs: aList[aList.length - 1].token.sourceEndMs,
            beforeText,
            afterText,
            kind: 'typo_replace',
            targetTokenIds: aList.map((x) => x.token.id),
            replacementSpecs: bList.map((x) => ({
              text: x.text,
              weight: tokenCharWeight(x.text),
            })),
          });
        }
        gStart = gEnd + 1;
      }
      continue;
    }

    // M-to-N replacement hunk (e.g. ASR ['诶','艾'] <-> Subtitle ['AI'], or 1 missed char)
    const aRefs: AsrWordRef[] = [];
    const bRefs: SubWordRef[] = [];
    for (const s of filteredSteps) {
      if (s.op === 'align') {
        aRefs.push(asrTokens[s.aIdx]);
        bRefs.push(subTokens[s.bIdx]);
      } else if (s.op === 'del_asr') {
        aRefs.push(asrTokens[s.aIdx]);
      } else {
        bRefs.push(subTokens[s.bIdx]);
      }
    }

    if (
      aRefs.length >= 1 &&
      bRefs.length >= 1 &&
      aRefs.every((r) => r.runId === aRefs[0].runId) &&
      aRefs[aRefs.length - 1].asrIdx - aRefs[0].asrIdx === aRefs.length - 1 &&
      Math.max(aRefs.length, bRefs.length) <= 10
    ) {
      const beforeText = aRefs.map((x) => x.token.text).join('');
      const afterText = bRefs.map((x) => x.text).join('');
      if (beforeText !== afterText) {
        const sp = speakerMap[aRefs[0].speakerId];
        const cleanTerm = normalizeBaseToken(afterText);
        if (cleanTerm.length >= 2 && cleanTerm.length <= 12 && !PURE_FILLER_PHRASES.has(cleanTerm)) {
          candidateGlossarySet.add(afterText.replace(/[，。？！、；：,.?!;:]/g, '').trim());
        }
        hunks.push({
          id: `hunk_mn_${aRefs[0].token.id}`,
          blockId: aRefs[0].blockId,
          speakerId: aRefs[0].speakerId,
          speakerName: sp?.name ?? '发言人',
          speakerColor: sp?.color ?? '#3b82f6',
          startMs: aRefs[0].token.sourceStartMs,
          endMs: aRefs[aRefs.length - 1].token.sourceEndMs,
          beforeText,
          afterText,
          kind: 'typo_replace',
          targetTokenIds: aRefs.map((x) => x.token.id),
          replacementSpecs: bRefs.map((x) => ({
            text: x.text,
            weight: tokenCharWeight(x.text),
          })),
        });
      }
    }
  }

  return {
    document: doc,
    hunks,
    matchedTokenCount,
    candidateGlossaryWords: Array.from(candidateGlossarySet).filter(Boolean).slice(0, 24),
  };
}

/**
 * Applies selected SubtitleCorrectionHunks non-destructively to project blocks,
 * preserving exact millisecond audio bounds and silence capsules with 0.000s timeline drift.
 */
export function applySubtitleCorrectionHunks(
  state: PodcastProjectState,
  preview: SubtitleAlignmentPreview,
  selectedHunkIds: Set<string>,
  extractGlossary: boolean
): {
  nextBlocks: TranscriptBlock[];
  nextGlossary: GlossaryItem[];
  appliedCount: number;
  addedGlossaryCount: number;
} {
  const activeHunks = preview.hunks.filter((h) => selectedHunkIds.has(h.id));
  if (activeHunks.length === 0) {
    return {
      nextBlocks: state.blocks,
      nextGlossary: state.glossary,
      appliedCount: 0,
      addedGlossaryCount: 0,
    };
  }

  // Index hunks by their first targetTokenId within each block
  const hunkByFirstTokenId = new Map<string, SubtitleCorrectionHunk>();
  const consumedTokenIds = new Set<string>();
  for (const h of activeHunks) {
    if (h.targetTokenIds.length === 0) continue;
    hunkByFirstTokenId.set(h.targetTokenIds[0], h);
    for (let i = 1; i < h.targetTokenIds.length; i++) {
      consumedTokenIds.add(h.targetTokenIds[i]);
    }
  }

  const nextBlocks: TranscriptBlock[] = state.blocks.map((block) => {
    let changed = false;
    const newTokens: TranscriptToken[] = [];

    for (let i = 0; i < block.tokens.length; i++) {
      const tok = block.tokens[i];
      if (consumedTokenIds.has(tok.id)) {
        changed = true;
        continue;
      }

      const hunk = hunkByFirstTokenId.get(tok.id);
      if (!hunk) {
        newTokens.push(tok);
        continue;
      }

      changed = true;
      const targetSet = new Set(hunk.targetTokenIds);
      const matchedTokens = block.tokens.filter((t) => targetSet.has(t.id));

      if (hunk.markDeleted) {
        for (const mt of matchedTokens) {
          newTokens.push({ ...mt, deleted: true });
        }
        continue;
      }

      // 1-to-1 exact token count replacement: preserve every token's exact timestamps & durations untouched!
      if (matchedTokens.length === hunk.replacementSpecs.length) {
        for (let k = 0; k < matchedTokens.length; k++) {
          const orig = matchedTokens[k];
          newTokens.push({
            ...orig,
            text: hunk.replacementSpecs[k].text,
            correctedStatus: 'manual',
            aiSuggestedText: undefined,
          });
        }
        continue;
      }

      // M-to-N replacement: preserve exact [spanStartMs .. spanEndMs] & exact sum(durationSec) to 0.000s drift!
      const spanStartMs = matchedTokens[0].sourceStartMs;
      const spanEndMs = matchedTokens[matchedTokens.length - 1].sourceEndMs;
      const totalDurSec = matchedTokens.reduce((s, t) => s + t.durationSec, 0);
      const totalOrigDurSec = matchedTokens.reduce((s, t) => s + t.origDurationSec, 0);
      const anyTrackMuted = matchedTokens.some((t) => t.trackMuted);
      const anyBleeped = matchedTokens.some((t) => t.bleeped);

      const totalWeight =
        hunk.replacementSpecs.reduce((s, sp) => s + Math.max(1, sp.weight), 0) || 1;
      let accWeight = 0;
      let usedDurSec = 0;
      let usedOrigDurSec = 0;

      hunk.replacementSpecs.forEach((spec, k) => {
        const isLast = k === hunk.replacementSpecs.length - 1;
        const w = Math.max(1, spec.weight);
        const startRatio = accWeight / totalWeight;
        const endRatio = (accWeight + w) / totalWeight;
        accWeight += w;

        const tStartMs =
          k === 0 ? spanStartMs : Math.round(spanStartMs + startRatio * (spanEndMs - spanStartMs));
        const tEndMs = isLast
          ? spanEndMs
          : Math.max(tStartMs + 10, Math.round(spanStartMs + endRatio * (spanEndMs - spanStartMs)));

        const durSec = isLast
          ? Math.max(0.01, Number((totalDurSec - usedDurSec).toFixed(4)))
          : Math.max(0.01, Number(((w / totalWeight) * totalDurSec).toFixed(4)));
        const origDurSec = isLast
          ? Math.max(0.01, Number((totalOrigDurSec - usedOrigDurSec).toFixed(4)))
          : Math.max(0.01, Number(((w / totalWeight) * totalOrigDurSec).toFixed(4)));

        usedDurSec += durSec;
        usedOrigDurSec += origDurSec;

        newTokens.push({
          id: k === 0 ? matchedTokens[0].id : `${matchedTokens[0].id}_sub_${k}`,
          type: 'word',
          text: spec.text,
          sourceStartMs: tStartMs,
          sourceEndMs: tEndMs,
          durationSec: durSec,
          origDurationSec: origDurSec,
          correctedStatus: 'manual',
          trackMuted: anyTrackMuted,
          bleeped: anyBleeped,
          bleepStyle: anyBleeped ? 'sine_1khz_bleep' : undefined,
        });
      });
    }

    return changed ? { ...block, tokens: newTokens } : block;
  });

  // Optionally add newly corrected multi-char terms into project Glossary
  let nextGlossary = state.glossary;
  let addedGlossaryCount = 0;
  if (extractGlossary) {
    const existingWords = new Set(state.glossary.map((g) => g.word.toLowerCase()));
    const additions: GlossaryItem[] = [];
    for (const h of activeHunks) {
      if (h.kind !== 'typo_replace') continue;
      const cleanedWord = h.afterText.replace(/[，。？！、；：,.?!;:（）()“”‘’\s]/g, '').trim();
      const base = normalizeBaseToken(cleanedWord);
      if (
        cleanedWord &&
        base.length >= 2 &&
        base.length <= 10 &&
        !PURE_FILLER_PHRASES.has(base) &&
        !existingWords.has(cleanedWord.toLowerCase())
      ) {
        existingWords.add(cleanedWord.toLowerCase());
        additions.push({
          id: `g_sub_${Date.now()}_${additions.length}`,
          word: cleanedWord,
          type: 'hotword',
        });
      }
    }
    if (additions.length > 0) {
      addedGlossaryCount = additions.length;
      nextGlossary = [...additions, ...state.glossary];
    }
  }

  return {
    nextBlocks,
    nextGlossary,
    appliedCount: activeHunks.length,
    addedGlossaryCount,
  };
}
