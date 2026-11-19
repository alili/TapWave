import { describe, expect, it } from 'vitest';
import {
  computeSpeakerRadarProfiles,
  SpeakerRadarComputationParams,
} from '../engine/speakerRadarEngine';
import { GlossaryItem, SpeakerTrack, TranscriptBlock } from '../types/podcast';

describe('computeSpeakerRadarProfiles', () => {
  const dummyTracks: SpeakerTrack[] = [
    {
      id: 'sp_host',
      name: '主播小李',
      role: 'host',
      roleLabel: '主持人',
      color: '#3b82f6',
      rawLufs: -16,
      autoGainDb: 0,
      syncOffsetMs: 0,
      roomToneStartMs: 0,
      roomToneEndMs: 1000,
      peaks: new Array(100).fill(0.5),
      solo: false,
      muted: false,
    },
    {
      id: 'sp_guest',
      name: '嘉宾老王',
      role: 'guest',
      roleLabel: '嘉宾',
      color: '#10b981',
      rawLufs: -16,
      autoGainDb: 0,
      syncOffsetMs: 0,
      roomToneStartMs: 0,
      roomToneEndMs: 1000,
      peaks: new Array(100).fill(0.6),
      solo: false,
      muted: false,
    },
  ];

  const glossary: GlossaryItem[] = [
    { id: 'g1', word: 'SenseVoice', type: 'hotword' },
    { id: 'g2', word: '那个', type: 'habit' },
  ];

  it('never emits "短碎附和较多" warning even with multiple short backchannel responses', () => {
    // 构造对谈场景：嘉宾发言，主播在中间多次发出短于2s的倾听附和（“嗯”、“对”、“没错”）
    const blocks: TranscriptBlock[] = [
      {
        blockId: 'b1',
        speakerId: 'sp_guest',
        chapterTitle: '嘉宾分享',
        tokens: [
          {
            id: 't1',
            type: 'word',
            text: '我们当时在做这个项目的时候，遇到了非常多的架构难题。',
            sourceStartMs: 0,
            sourceEndMs: 4000,
            durationSec: 4.0,
            origDurationSec: 4.0,
          },
        ],
      },
      {
        blockId: 'b2',
        speakerId: 'sp_host',
        chapterTitle: '附和1',
        tokens: [
          {
            id: 't2',
            type: 'word',
            text: '嗯。',
            sourceStartMs: 4200,
            sourceEndMs: 4800,
            durationSec: 0.6,
            origDurationSec: 0.6,
          },
        ],
      },
      {
        blockId: 'b3',
        speakerId: 'sp_guest',
        chapterTitle: '嘉宾继续',
        tokens: [
          {
            id: 't3',
            type: 'word',
            text: '主要是在网络延迟和多端同步上，花了大概三个月才完全解决。',
            sourceStartMs: 5000,
            sourceEndMs: 9000,
            durationSec: 4.0,
            origDurationSec: 4.0,
          },
        ],
      },
      {
        blockId: 'b4',
        speakerId: 'sp_host',
        chapterTitle: '附和2',
        tokens: [
          {
            id: 't4',
            type: 'word',
            text: '对，确实。',
            sourceStartMs: 9200,
            sourceEndMs: 9900,
            durationSec: 0.7,
            origDurationSec: 0.7,
          },
        ],
      },
      {
        blockId: 'b5',
        speakerId: 'sp_host',
        chapterTitle: '附和3',
        tokens: [
          {
            id: 't5',
            type: 'word',
            text: '没错。',
            sourceStartMs: 10100,
            sourceEndMs: 10700,
            durationSec: 0.6,
            origDurationSec: 0.6,
          },
        ],
      },
      {
        blockId: 'b6',
        speakerId: 'sp_host',
        chapterTitle: '附和4',
        tokens: [
          {
            id: 't6',
            type: 'word',
            text: '哈哈。',
            sourceStartMs: 10900,
            sourceEndMs: 11500,
            durationSec: 0.6,
            origDurationSec: 0.6,
          },
        ],
      },
    ];

    const profiles = computeSpeakerRadarProfiles(dummyTracks, blocks, glossary);
    const hostProfile = profiles.get('sp_host');
    expect(hostProfile).toBeDefined();

    // 检查 habitInsights 绝对不包含任何“短碎附和”字样
    const allSummaries = hostProfile!.habitInsights.map((h) => h.summary).join(' | ');
    const allDetails = hostProfile!.habitInsights.map((h) => h.detail).join(' | ');
    expect(allSummaries).not.toContain('短碎附和');
    expect(allDetails).not.toContain('短碎附和');

    // 确认 backchannelCount 积极倾听被正向记录为 >= 3
    expect(hostProfile!.microMetrics.backchannelCount).toBeGreaterThanOrEqual(3);
  });

  it('merges adjacent blocks of the same speaker into one true continuous turn', () => {
    // 构造同一发言人连续 5 个相邻 block，单段各 10s，总长 50s
    const blocks: TranscriptBlock[] = [1, 2, 3, 4, 5].map((idx) => ({
      blockId: `b_${idx}`,
      speakerId: 'sp_guest',
      chapterTitle: `段落 ${idx}`,
      tokens: [
        {
          id: `t_${idx}`,
          type: 'word',
          text: `这是第${idx}个连续阐述阶段，我们接着看后面的数据。`,
          sourceStartMs: (idx - 1) * 10000,
          sourceEndMs: idx * 10000,
          durationSec: 10.0,
          origDurationSec: 10.0,
        },
      ],
    }));

    const profiles = computeSpeakerRadarProfiles(dummyTracks, blocks, glossary);
    const guestProfile = profiles.get('sp_guest');
    expect(guestProfile).toBeDefined();

    // 合并后的真实连续话轮数应为 1，最长连续话轮时长应为 50s
    expect(guestProfile!.microMetrics.mergedTurnCount).toBe(1);
    expect(guestProfile!.microMetrics.maxMergedTurnSec).toBe(50);

    // 此时应准确给出长发言节奏提醒，且 evidences 包含正确的起点时间戳
    const turnInsight = guestProfile!.habitInsights.find((h) => h.id === 'turn_structure');
    expect(turnInsight).toBeDefined();
    expect(turnInsight!.status).toBe('warn');
    expect(turnInsight!.evidences.length).toBeGreaterThan(0);
    expect(turnInsight!.evidences[0].timeFormatted).toBe('00:00');
  });

  it('detects top habit phrases with categories and provides precise timestamps', () => {
    const blocks: TranscriptBlock[] = [
      {
        blockId: 'b1',
        speakerId: 'sp_host',
        chapterTitle: '主持开场',
        tokens: [
          {
            id: 't1',
            type: 'word',
            text: '然后呢我们今天来聊聊技术，对吧？',
            sourceStartMs: 0,
            sourceEndMs: 3000,
            durationSec: 3.0,
            origDurationSec: 3.0,
          },
          {
            id: 't2',
            type: 'word',
            text: '呃',
            fillerTag: 'pure',
            sourceStartMs: 3100,
            sourceEndMs: 3600,
            durationSec: 0.5,
            origDurationSec: 0.5,
          },
          {
            id: 't3',
            type: 'word',
            text: '然后呢其实这个方向大家都在看，是不是？',
            sourceStartMs: 3700,
            sourceEndMs: 7000,
            durationSec: 3.3,
            origDurationSec: 3.3,
          },
        ],
      },
    ];

    const profiles = computeSpeakerRadarProfiles(dummyTracks, blocks, glossary);
    const hostProfile = profiles.get('sp_host');
    expect(hostProfile).toBeDefined();

    const phrases = hostProfile!.topHabitPhrases;
    expect(phrases.length).toBeGreaterThanOrEqual(1);

    const words = phrases.map((p) => p.word);
    // 包含纯口癖“呃”或启动词“然后呢”或尾缀“对吧”
    expect(words.some((w) => ['呃', '然后呢', '对吧', '是不是'].includes(w))).toBe(true);

    // 检查口癖清理计数
    expect(hostProfile!.microMetrics.pureFillerCount).toBe(1);
  });
});
