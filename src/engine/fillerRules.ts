import type { TranscriptBlock, TranscriptToken } from '../types/podcast';

const TRAILING_PUNCT_RE = /[，。？！、；：,.?!;:…~～—]+$/;
const MODAL_A_RE = /^啊+$/;
const HESITATION_ONLY_RE = /^[呃啊嗯额哦唔诶]+$/;

/**
 * 判断 token[idx] 是否为句尾/分句尾语气词「啊」（如「好啊。」「是啊」），
 * 此类语气词属于正常口语表达，不计入冗余口癖。
 */
export function isSentenceFinalModalA(tokens: TranscriptToken[], idx: number): boolean {
  const tok = tokens[idx];
  if (!tok || tok.type !== 'word') return false;
  const raw = tok.text.trim();
  const plain = raw.replace(TRAILING_PUNCT_RE, '');
  if (!MODAL_A_RE.test(plain)) return false;

  // 必须紧跟在同一 block 内的一个实词后面（前一个 token 不是静音、不是语气/卡壳词、也不以标点结尾）
  const prev = tokens[idx - 1];
  if (!prev || prev.type !== 'word') return false;
  const prevRaw = prev.text.trim();
  if (!prevRaw || TRAILING_PUNCT_RE.test(prevRaw)) return false;
  if (HESITATION_ONLY_RE.test(prevRaw.replace(TRAILING_PUNCT_RE, ''))) return false;

  // 自身位于句尾/分句尾：带结尾标点，或是 block 的最后一个 token，或后面紧跟静音停顿
  if (TRAILING_PUNCT_RE.test(raw)) return true;
  const next = tokens[idx + 1];
  if (!next) return true;
  return next.type === 'silence';
}

/**
 * 去掉句尾「啊」上的 pure 口癖标记；没有任何改动时返回原数组与原 block 引用。
 */
export function demoteSentenceFinalModalAFillers(blocks: TranscriptBlock[]): TranscriptBlock[] {
  let changedAny = false;
  const out = blocks.map((b) => {
    let changed = false;
    const tokens = b.tokens.map((t, i) => {
      if (t.fillerTag === 'pure' && isSentenceFinalModalA(b.tokens, i)) {
        changed = true;
        return { ...t, fillerTag: undefined };
      }
      return t;
    });
    if (!changed) return b;
    changedAny = true;
    return { ...b, tokens };
  });
  return changedAny ? out : blocks;
}
