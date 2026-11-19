import { describe, expect, it } from 'vitest';
import {
  analyzeQaInteractions,
  extractGenuineQuestionsFromTurn,
  isGenuineQuestionSentence,
} from '../engine/questionAnalysis';
import { SpeakerTrack, TranscriptBlock } from '../types/podcast';

describe('isGenuineQuestionSentence', () => {
  it('detects genuine Chinese and English questions', () => {
    const genuine = [
      '你当初为什么决定离开大厂出来创业？',
      '那在这个过程中，你们遇到最大的困难是什么？',
      '你觉得AI会取代程序员吗？',
      '当时听到这个消息的时候，你是惊讶多一点，还是释然多一点？',
      '能跟听众朋友具体分享一下当时的细节吗。',
      '你怎么看最近行业里的这个变化。',
      '你呢？',
      '结果呢？',
      '可不可以理解为它其实降低了门槛？',
      'What do you think about this?',
    ];

    for (const s of genuine) {
      expect(isGenuineQuestionSentence(s), `Expected genuine question: ${s}`).toBe(true);
    }
  });

  it('rejects common false-positive statements, fillers, and ASR mis-punctuations', () => {
    const falsePositives = [
      // 句末“呢”的陈述句
      '我觉得这个事情其实挺复杂的呢。',
      '这事儿还早着呢。',
      '我还没说完呢！',
      // 口头禅/确认尾缀
      '然后我们就开始做产品了，对吧？',
      '这个逻辑其实是完全通顺的，是不是？',
      '我们当时花了很多时间去打磨，对不对。',
      // 纯附和/填充语
      '真的吗？',
      '是吗？',
      '对吧？',
      '然后呢？',
      '嗯？',
      '啊？',
      '怎么说呢，我觉得这个事得看情况。',
      // 否定/不定指/让步/间接从句
      '其实也没什么，就是习惯了。',
      '我也不知道他为什么会这样。',
      '不管怎么说，结果还是好的。',
      '无论如何都要坚持下去。',
      '他不怎么喜欢出门。',
      '我觉得他可能会不会有点紧张。',
      // ASR 误标问号的陈述句
      '我觉得他可能会有点紧张？',
      '然后我昨天去了一趟北京？',
      '大概就是十点钟左右？',
    ];

    for (const s of falsePositives) {
      expect(isGenuineQuestionSentence(s), `Expected non-question: ${s}`).toBe(false);
    }
  });
});

describe('extractGenuineQuestionsFromTurn', () => {
  it('filters out rhetorical self-answered questions followed by long explanation', () => {
    const selfAnsweredTurn =
      '那为什么会出现这种情况呢？其实主要有两个原因，第一是因为大家对成本的敏感度变高了，第二是供应链的协同效率在过去两年里发生了非常明显的变化，所以结果才会这样。';
    const result = extractGenuineQuestionsFromTurn(selfAnsweredTurn);
    expect(result.questionSentences).toEqual([]);
    expect(result.questionCharRatio).toBe(0);
  });

  it('keeps genuine trailing question after host setup and computes accurate char ratio', () => {
    const hostTurn =
      '我们刚才聊了很多关于产品早期冷启动的经历，也看到你们踩了不少坑。那如果再给你一次机会，你还会做同样的选择吗？';
    const result = extractGenuineQuestionsFromTurn(hostTurn);
    expect(result.questionSentences).toEqual([
      '那如果再给你一次机会，你还会做同样的选择吗？',
    ]);
    expect(result.questionCharRatio).toBeGreaterThan(0.2);
    expect(result.questionCharRatio).toBeLessThan(0.6);
  });
});

describe('analyzeQaInteractions', () => {
  const tracks: SpeakerTrack[] = [
    {
      id: 'host',
      name: '主持人',
      role: 'host',
      roleLabel: '主持人 Host',
      color: '#3b82f6',
      rawLufs: -18,
      autoGainDb: 0,
      syncOffsetMs: 0,
      roomToneStartMs: 0,
      roomToneEndMs: 0,
      peaks: [],
      solo: false,
      muted: false,
    },
    {
      id: 'guest',
      name: '嘉宾',
      role: 'guest',
      roleLabel: '嘉宾 Guest',
      color: '#10b981',
      rawLufs: -18,
      autoGainDb: 0,
      syncOffsetMs: 0,
      roomToneStartMs: 0,
      roomToneEndMs: 0,
      peaks: [],
      solo: false,
      muted: false,
    },
  ];

  const makeBlock = (blockId: string, speakerId: string, text: string, durationSec: number): TranscriptBlock => ({
    blockId,
    speakerId,
    chapterTitle: '对话',
    tokens: [
      {
        id: `${blockId}_w1`,
        type: 'word',
        text,
        sourceStartMs: 0,
        sourceEndMs: durationSec * 1000,
        durationSec,
        origDurationSec: durationSec,
      },
    ],
  });

  it('does not count filler/statement turns as questions and splits statement vs question duration', () => {
    const blocks: TranscriptBlock[] = [
      // 误判高发陈述句（不应算作提问）
      makeBlock('b1', 'host', '我们当时做了很多尝试，对吧？其实也没什么。', 10),
      // 嘉宾附和与陈述（不应算作提问）
      makeBlock('b2', 'guest', '真的吗？我觉得这事儿还早着呢。', 10),
      // 主持人先陈述15字再提问15字（只应计入1次提问，且时长约一半算提问、一半算陈述）
      makeBlock('b3', 'host', '我刚才听完非常有同感。你当时是怎么做决定的？', 10),
    ];

    const res = analyzeQaInteractions({
      blocks,
      speakerTracks: tracks,
      blockEditedStartsSec: { b1: 0, b2: 10, b3: 20 },
    });

    expect(res.questions).toHaveLength(1);
    expect(res.questions[0].id).toBe('q_b3');
    expect(res.questions[0].text).toBe('你当时是怎么做决定的？');

    const hostStat = res.speakerBreakdown.find((s) => s.speakerId === 'host')!;
    const guestStat = res.speakerBreakdown.find((s) => s.speakerId === 'guest')!;
    expect(hostStat.questionCount).toBe(1);
    expect(guestStat.questionCount).toBe(0);

    // 主持人总计20秒：b1全10秒陈述 + b3约5秒陈述 + b3约5秒提问
    expect(res.hostQPct).toBeGreaterThanOrEqual(15);
    expect(res.hostQPct).toBeLessThanOrEqual(20);
    expect(res.hostOpPct).toBeGreaterThanOrEqual(45);
  });
});
