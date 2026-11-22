import { describe, expect, it } from 'vitest';
import {
  demoteSentenceFinalModalAFillers,
  isSentenceFinalModalA,
} from '../engine/fillerRules';
import type { TranscriptBlock, TranscriptToken } from '../types/podcast';

let seq = 0;

function w(text: string, fillerTag?: TranscriptToken['fillerTag']): TranscriptToken {
  const start = seq * 300;
  seq++;
  return {
    id: `tok_w_${seq}`,
    type: 'word',
    text,
    sourceStartMs: start,
    sourceEndMs: start + 250,
    durationSec: 0.25,
    origDurationSec: 0.25,
    fillerTag,
  };
}

function sil(): TranscriptToken {
  const start = seq * 300;
  seq++;
  return {
    id: `tok_sil_${seq}`,
    type: 'silence',
    text: '',
    sourceStartMs: start,
    sourceEndMs: start + 500,
    durationSec: 0.5,
    origDurationSec: 0.5,
  };
}

describe('fillerRules: sentence-final modal particle 「啊」', () => {
  it('identifies sentence/clause-final modal 「啊」 after a content word', () => {
    expect(isSentenceFinalModalA([w('好'), w('啊。')], 1)).toBe(true);
    expect(isSentenceFinalModalA([w('是'), w('啊')], 1)).toBe(true);
    expect(isSentenceFinalModalA([w('对'), w('啊'), sil(), w('我')], 1)).toBe(true);
  });

  it('does not treat leading, standalone, post-punctuation, or mid-phrase 「啊」 as modal final', () => {
    expect(isSentenceFinalModalA([w('啊，'), w('我'), w('觉得')], 0)).toBe(false);
    expect(isSentenceFinalModalA([w('我'), w('觉得'), w('啊'), w('这个')], 2)).toBe(false);
    expect(isSentenceFinalModalA([w('呃'), w('啊。')], 1)).toBe(false);
    expect(isSentenceFinalModalA([w('好。'), w('啊')], 1)).toBe(false);
  });

  it('demotes pure fillerTag on sentence-final 「啊」 while preserving leading 「啊」 and untouched references', () => {
    const untouchedBlock: TranscriptBlock = {
      blockId: 'blk_untouched',
      speakerId: 'sp_1',
      chapterTitle: '章节 1',
      tokens: [w('啊，', 'pure'), w('我'), w('明白')],
    };
    const mixedBlock: TranscriptBlock = {
      blockId: 'blk_mixed',
      speakerId: 'sp_1',
      chapterTitle: '章节 1',
      tokens: [w('啊，', 'pure'), w('好'), w('啊。', 'pure')],
    };

    const updated = demoteSentenceFinalModalAFillers([untouchedBlock, mixedBlock]);
    expect(updated).not.toBe([untouchedBlock, mixedBlock]);
    expect(updated[0]).toBe(untouchedBlock);
    expect(updated[1]).not.toBe(mixedBlock);
    expect(updated[1].tokens[0].fillerTag).toBe('pure');
    expect(updated[1].tokens[2].fillerTag).toBeUndefined();

    // No changes returns original array reference
    const noChangeBlocks: TranscriptBlock[] = [untouchedBlock];
    expect(demoteSentenceFinalModalAFillers(noChangeBlocks)).toBe(noChangeBlocks);
  });
});
