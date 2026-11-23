import { describe, expect, it } from 'vitest';
import {
  aggregateLiveUtterances,
  buildSingleUtteranceBlock,
  isSpeakerConfirmedUtterance,
  separatorBetweenUtterances,
} from '../engine/liveTranscriptAggregator';
import { LiveUtterance } from '../types/liveSession';

function makeUtt(
  id: string,
  text: string,
  startMs: number,
  endMs: number,
  speakerId = 'spk_1',
  speakerSource: LiveUtterance['speakerSource'] = 'manual',
  extra: Partial<LiveUtterance> = {}
): LiveUtterance {
  return {
    id,
    text,
    startMs,
    endMs,
    speakerId,
    speakerSource,
    ...extra,
  };
}

describe('liveTranscriptAggregator', () => {
  it('merges consecutive confirmed utterances from the same speaker', () => {
    const utts: LiveUtterance[] = [
      makeUtt('u1', '我们今天聊聊端侧模型的量化方案。', 0, 3000, 'spk_1', 'manual'),
      makeUtt('u2', '目前在 2GB 内存限制下效果非常稳定。', 3500, 7000, 'spk_1', 'cloud'),
      makeUtt('u3', '对，而且首字延迟降低了接近一半。', 7800, 11000, 'spk_1', 'voiceprint', {
        voiceprintCluster: 'v0',
        voiceprintConfidence: 0.88,
      }),
    ];

    const blocks = aggregateLiveUtterances(utts);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].utteranceIds).toEqual(['u1', 'u2', 'u3']);
    expect(blocks[0].startMs).toBe(0);
    expect(blocks[0].endMs).toBe(11000);
    expect(blocks[0].isSpeakerConfirmed).toBe(true);
    expect(blocks[0].isUncertain).toBe(false);
    expect(blocks[0].text).toBe(
      '我们今天聊聊端侧模型的量化方案。目前在 2GB 内存限制下效果非常稳定。对，而且首字延迟降低了接近一半。'
    );
  });

  it('absorbs short utterances into adjacent same-speaker block instead of leaving orphan cards', () => {
    const utts: LiveUtterance[] = [
      makeUtt('u1', '这个方案我们前前后后验证了三个月，确实解决了不少线下噪声问题。', 0, 5000, 'spk_1', 'manual'),
      makeUtt('u2', '嗯对。', 5200, 5800, 'spk_1', 'fallback'),
      makeUtt('u3', '没错。', 6200, 6800, 'spk_1', 'voiceprint', { voiceprintConfidence: 0.55 }),
    ];

    const blocks = aggregateLiveUtterances(utts);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].utteranceIds).toEqual(['u1', 'u2', 'u3']);
  });

  it('keeps different speakers separated', () => {
    const utts: LiveUtterance[] = [
      makeUtt('u1', '你当时是怎么决定做本地化部署的？', 0, 3000, 'spk_host', 'manual'),
      makeUtt('u2', '嗯。', 3200, 3600, 'spk_guest', 'manual'),
      makeUtt('u3', '主要是客户对数据不出域有强要求。', 3800, 7000, 'spk_guest', 'manual'),
    ];

    const blocks = aggregateLiveUtterances(utts);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].speakerId).toBe('spk_host');
    expect(blocks[1].speakerId).toBe('spk_guest');
    expect(blocks[1].utteranceIds).toEqual(['u2', 'u3']);
  });

  it('keeps unconfirmed differing-cluster long utterances separate until confirmed', () => {
    const beforeConfirm: LiveUtterance[] = [
      makeUtt(
        'u1',
        '第一段较长的话语目前只有低置信度声纹匹配，暂未确认发言人。',
        0,
        5000,
        'spk_guest',
        'voiceprint',
        { voiceprintCluster: 'v0', voiceprintConfidence: 0.52 }
      ),
      makeUtt(
        'u2',
        '第二段较长的话语来自另一个声纹簇，也还没有人工确认发言人。',
        6000,
        11000,
        'spk_guest',
        'voiceprint',
        { voiceprintCluster: 'v1', voiceprintConfidence: 0.54 }
      ),
    ];

    expect(aggregateLiveUtterances(beforeConfirm)).toHaveLength(2);

    const afterConfirm = beforeConfirm.map((u) => ({
      ...u,
      speakerSource: 'manual' as const,
    }));
    const merged = aggregateLiveUtterances(afterConfirm);
    expect(merged).toHaveLength(1);
    expect(merged[0].isSpeakerConfirmed).toBe(true);
    expect(merged[0].isUncertain).toBe(false);
  });

  it('splits very long monologues on noticeable pauses while still absorbing trailing short phrases', () => {
    const longBody = '这是一段非常长的连续技术分享内容，包含大量架构与工程实现细节。'.repeat(10);
    const utts: LiveUtterance[] = [
      makeUtt('u1', longBody, 0, 20_000, 'spk_1', 'manual'),
      makeUtt('u2', '另外还有一点非常关键的工程经验需要补充说明一下。', 25_000, 30_000, 'spk_1', 'manual'),
      makeUtt('u3', '就这样。', 30_400, 31_000, 'spk_1', 'manual'),
    ];

    const blocks = aggregateLiveUtterances(utts);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].utteranceIds).toEqual(['u1']);
    expect(blocks[1].utteranceIds).toEqual(['u2', 'u3']);
  });

  it('inserts space only between ASCII alphanumeric boundaries', () => {
    expect(separatorBetweenUtterances('Hello', 'World')).toBe(' ');
    expect(separatorBetweenUtterances('INT8', '量化')).toBe('');
    expect(separatorBetweenUtterances('中文句子。', '下一句')).toBe('');
  });

  it('recognizes hybrid and high-confidence content sources as confirmed and merges cleanly', () => {
    const uHybrid = makeUtt('uh1', '这是声纹加内容确认的句子。', 0, 3000, 'spk_1', 'hybrid', {
      contentConfidence: 0.88,
      speakerReason: '声纹与问答逻辑一致',
    });
    const uContentHigh = makeUtt('uc1', '这是高置信内容确认的句子。', 3500, 6500, 'spk_1', 'content', {
      contentConfidence: 0.9,
      speakerReason: '承接前文点名',
    });
    const uContentLow = makeUtt('uc2', '这是低置信内容猜测的句子。', 7000, 9500, 'spk_2', 'content', {
      contentConfidence: 0.65,
    });

    expect(isSpeakerConfirmedUtterance(uHybrid)).toBe(true);
    expect(isSpeakerConfirmedUtterance(uContentHigh)).toBe(true);
    expect(isSpeakerConfirmedUtterance(uContentLow)).toBe(false);

    const singleLow = buildSingleUtteranceBlock(uContentLow);
    expect(singleLow.isUncertain).toBe(true);

    const blocks = aggregateLiveUtterances([uHybrid, uContentHigh]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].isSpeakerConfirmed).toBe(true);
    expect(blocks[0].isUncertain).toBe(false);
    expect(blocks[0].speakerSource).toBe('hybrid');
    expect(blocks[0].speakerReason).toBe('声纹与问答逻辑一致');
  });
});
