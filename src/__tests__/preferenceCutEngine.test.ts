import { describe, expect, it } from 'vitest';
import {
  applyPreferenceSmartCut,
  isHesitationToken,
  isProtectedAffirmation,
} from '../engine/preferenceCutEngine';
import { PodcastProjectState, TranscriptBlock } from '../types/podcast';
import { createEmptyProjectState } from '../data/emptyProject';

describe('preferenceCutEngine (EP121 坚叔审美回测)', () => {
  it('correctly discriminates hesitation tokens vs protected backchannels', () => {
    expect(isProtectedAffirmation('嗯。', 1)).toBe(true);
    expect(isProtectedAffirmation('对', 2)).toBe(true);
    expect(isProtectedAffirmation('啊。', 3)).toBe(true);
    expect(isProtectedAffirmation('呃，', 1)).toBe(false);

    expect(
      isHesitationToken({
        id: 't1',
        type: 'word',
        text: '呃，',
        sourceStartMs: 0,
        sourceEndMs: 300,
        durationSec: 0.3,
        origDurationSec: 0.3,
      })
    ).toBe(true);

    expect(
      isHesitationToken({
        id: 't2',
        type: 'word',
        text: '嗯。',
        sourceStartMs: 0,
        sourceEndMs: 300,
        durationSec: 0.3,
        origDurationSec: 0.3,
      })
    ).toBe(false);
  });

  it('eliminates immediate word stutters and tightens subsequent gap', () => {
    const empty = createEmptyProjectState();
    const block: TranscriptBlock = {
      blockId: 'b1',
      speakerId: 'sp1',
      chapterTitle: '测试',
      tokens: [
        { id: '1', type: 'word', text: '本', sourceStartMs: 0, sourceEndMs: 200, durationSec: 0.2, origDurationSec: 0.2 },
        { id: '2', type: 'word', text: '人', sourceStartMs: 200, sourceEndMs: 400, durationSec: 0.2, origDurationSec: 0.2 },
        { id: '3', type: 'word', text: '本', sourceStartMs: 400, sourceEndMs: 600, durationSec: 0.2, origDurationSec: 0.2 },
        { id: '4', type: 'word', text: '人', sourceStartMs: 600, sourceEndMs: 800, durationSec: 0.2, origDurationSec: 0.2 },
        { id: '5', type: 'word', text: '本', sourceStartMs: 800, sourceEndMs: 1000, durationSec: 0.2, origDurationSec: 0.2 },
        { id: '6', type: 'word', text: '名', sourceStartMs: 1000, sourceEndMs: 1200, durationSec: 0.2, origDurationSec: 0.2 },
      ],
    };
    empty.blocks = [block];

    const outcome = applyPreferenceSmartCut(empty);
    expect(outcome.stuttersCut).toBeGreaterThanOrEqual(2);
    expect(outcome.nextState.blocks[0].tokens[0].deleted).toBe(true);
    expect(outcome.nextState.blocks[0].tokens[1].deleted).toBe(true);
    expect(outcome.nextState.blocks[0].tokens[2].deleted).toBeUndefined();
    expect(outcome.nextState.blocks[0].tokens[2].gapBeforeSec).toBe(0.06);
  });

  it('protects standalone affirmative backchannels while eliminating hesitation', () => {
    const empty = createEmptyProjectState();
    empty.blocks = [
      {
        blockId: 'b_host',
        speakerId: 'sp_host',
        chapterTitle: '主讲',
        tokens: [
          { id: 'h1', type: 'word', text: '今天', sourceStartMs: 0, sourceEndMs: 300, durationSec: 0.3, origDurationSec: 0.3 },
          { id: 'h2', type: 'word', text: '呃，', sourceStartMs: 300, sourceEndMs: 700, durationSec: 0.4, origDurationSec: 0.4 },
          { id: 'h3', type: 'word', text: '我们聊买房。', sourceStartMs: 700, sourceEndMs: 1500, durationSec: 0.8, origDurationSec: 0.8 },
        ],
      },
      {
        blockId: 'b_guest',
        speakerId: 'sp_guest',
        chapterTitle: '附和',
        tokens: [
          { id: 'g1', type: 'word', text: '嗯。', sourceStartMs: 1600, sourceEndMs: 1800, durationSec: 0.2, origDurationSec: 0.2 },
        ],
      },
    ];

    const outcome = applyPreferenceSmartCut(empty);
    expect(outcome.hesitationsCut).toBe(1);
    expect(outcome.protectedBackchannels).toBe(1);

    // Hesitation deleted
    expect(outcome.nextState.blocks[0].tokens[1].deleted).toBe(true);
    // Conversational backchannel protected
    expect(outcome.nextState.blocks[1].tokens[0].deleted).toBeFalsy();
  });
});
