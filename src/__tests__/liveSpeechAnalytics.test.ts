import { describe, expect, it } from 'vitest';
import {
  computeInsightUpdateStatus,
  computeLiveSpeechAnalytics,
  countSpokenUnits,
  detectLogicRelation,
} from '../engine/liveSpeechAnalytics';
import { createInitialLiveSnapshot } from '../engine/liveSessionStore';
import { LiveSessionSnapshot } from '../types/liveSession';

function buildSampleSnapshot(): LiveSessionSnapshot {
  const base = createInitialLiveSnapshot();
  return {
    ...base,
    phase: 'recording',
    title: 'AI 音频产品架构复盘',
    elapsedMs: 90_000,
    speakers: [
      { id: 'spk_self', name: '主持人', role: 'self' },
      { id: 'spk_guest', name: '李工', role: 'counterpart' },
    ],
    utterances: [
      {
        id: 'u_1',
        text: '嗯，欢迎来到今天节目，我们聊聊本地语音识别的工程落地。',
        startMs: 0,
        endMs: 12_000,
        speakerId: 'spk_self',
        speakerSource: 'manual',
      },
      {
        id: 'u_2',
        text: '其实我们当时做了3个版本，因为端侧内存只有2GB，所以最后选择了INT8量化模型。',
        startMs: 12_500,
        endMs: 32_500,
        speakerId: 'spk_guest',
        speakerSource: 'voiceprint',
      },
      {
        id: 'u_3',
        text: '就是说，然后效果提升明显，但是长音频还是会有漂移，对吧。',
        startMs: 33_000,
        endMs: 48_000,
        speakerId: 'spk_guest',
        speakerSource: 'voiceprint',
      },
      {
        id: 'u_4',
        text: '例如在60分钟的播客测试里，延迟降低了40%，核心是流式分段处理。',
        startMs: 48_500,
        endMs: 66_500,
        speakerId: 'spk_guest',
        speakerSource: 'voiceprint',
      },
    ],
    profile: {
      background: [{ text: '李工，前音视频架构师', evidenceMs: 12_500 }],
      stories: [
        {
          title: '端侧模型量化攻坚',
          gist: '在 2GB 内存限制下通过 INT8 量化实现稳定推理',
          evidenceMs: 12_500,
        },
      ],
      viewpoints: [
        {
          claim: '端侧落地必须做 INT8 量化与流式分段',
          support: '延迟降低 40%，内存可控在 2GB 内',
          evidenceMs: 48_500,
        },
      ],
    },
    keyPoints: ['INT8 量化解决 2GB 内存限制', '流式分段降低 40% 延迟'],
    outline: [{ id: 'ol_1', text: '端侧性能优化', status: 'covered' }],
  };
}

describe('liveSpeechAnalytics', () => {
  it('counts Chinese characters and Latin/number tokens as spoken units', () => {
    expect(countSpokenUnits('你好，世界！')).toBe(4);
    expect(countSpokenUnits('INT8 模型降低了 40% 延迟')).toBe(10);
  });

  it('detects logic relations accurately', () => {
    expect(detectLogicRelation('因为预算有限，所以先做MVP').relation).toBe('causal');
    expect(detectLogicRelation('但是实际测试中发现延迟偏高').relation).toBe('contrast');
    expect(detectLogicRelation('例如在 60 分钟测试里').relation).toBe('example');
    expect(detectLogicRelation('今天天气不错').relation).toBeNull();
  });

  it('computes pace, oral fillers, density, habits, and logic map from snapshot', () => {
    const snap = buildSampleSnapshot();
    const res = computeLiveSpeechAnalytics(snap);

    expect(res.utteranceCount).toBe(4);
    expect(res.totalChars).toBeGreaterThan(70);
    expect(res.pace.overallCpm).toBeGreaterThan(60);
    expect(res.pace.trendPoints).toHaveLength(4);

    // "就是说" should not double-count "就是"
    const jiushishuo = res.fillers.topWords.find((w) => w.word === '就是说');
    const jiushi = res.fillers.topWords.find((w) => w.word === '就是');
    expect(jiushishuo?.count).toBe(1);
    expect(jiushi).toBeUndefined();
    expect(res.fillers.byCategory.starter_crutch).toBeGreaterThanOrEqual(3); // 其实, 就是说, 然后
    expect(res.fillers.byCategory.hedging_tail).toBeGreaterThanOrEqual(1); // 对吧
    expect(res.fillers.byCategory.pure_filler).toBeGreaterThanOrEqual(1); // 嗯

    expect(res.density.score).toBeGreaterThan(50);
    expect(res.density.factMarkerCount).toBeGreaterThanOrEqual(4);
    expect(res.habits.dimensions).toHaveLength(5);
    expect(res.habits.turnSwitchCount).toBe(1);

    // Logic map should combine viewpoint, story, and real-time logic turns
    expect(res.logicMap.rootTopic).toBe('AI 音频产品架构复盘');
    expect(res.logicMap.connectorCounts.causal).toBeGreaterThanOrEqual(1);
    expect(res.logicMap.connectorCounts.contrast).toBeGreaterThanOrEqual(1);
    expect(res.logicMap.connectorCounts.example).toBeGreaterThanOrEqual(1);
    expect(res.logicMap.connectorCounts.conclusion).toBeGreaterThanOrEqual(1);
    expect(res.logicMap.branches.some((b) => b.kind === 'viewpoint')).toBe(true);
    expect(res.logicMap.branches.some((b) => b.kind === 'story')).toBe(true);
  });

  it('supports filtering analytics by a single speaker', () => {
    const snap = buildSampleSnapshot();
    const guestOnly = computeLiveSpeechAnalytics(snap, 'spk_guest');
    expect(guestOnly.utteranceCount).toBe(3);
    expect(guestOnly.fillers.byCategory.pure_filler).toBe(0);
    expect(guestOnly.speakers).toHaveLength(2);
  });

  it('handles empty snapshot gracefully', () => {
    const empty = createInitialLiveSnapshot();
    const res = computeLiveSpeechAnalytics(empty);
    expect(res.utteranceCount).toBe(0);
    expect(res.pace.paceStatus).toBe('idle');
    expect(res.density.level).toBe('idle');
    expect(res.logicMap.branches).toHaveLength(0);
    expect(res.logicMap.nodes).toHaveLength(0);
    expect(res.logicMap.edges).toHaveLength(0);
  });

  it('builds graph nodes/edges and highlights expandable question nodes', () => {
    const base = buildSampleSnapshot();
    const snap: LiveSessionSnapshot = {
      ...base,
      questions: [
        {
          id: 'q_1',
          type: 'deepen',
          text: 'INT8 量化后长音频漂移的问题后来是如何解决的？',
          why: '嘉宾提到了长音频漂移，值得深挖工程方案',
          relatedTo: 'INT8 量化与长音频漂移',
          status: 'new',
        },
      ],
    };

    const res = computeLiveSpeechAnalytics(snap);
    expect(res.logicMap.nodes.length).toBeGreaterThanOrEqual(5);
    expect(res.logicMap.edges.length).toBeGreaterThanOrEqual(4);
    expect(res.logicMap.edges.some((e) => e.relation === 'support_of')).toBe(true);
    expect(res.logicMap.edges.some((e) => e.relation === 'example')).toBe(true);
    expect(res.logicMap.expandableNodeIds.length).toBeGreaterThanOrEqual(1);

    const matchedNode = res.logicMap.nodes.find((n) => n.matchedQuestionId === 'q_1');
    expect(matchedNode).toBeDefined();
    expect(matchedNode?.expandableForQuestion).toBe(true);
    expect(matchedNode?.questionHint).toContain('INT8');

    const questionNodes = res.logicMap.nodes.filter((n) => n.kind === 'question');
    expect(questionNodes.length).toBeGreaterThanOrEqual(1);
    expect(questionNodes.some((n) => n.questionHint?.includes('INT8'))).toBe(true);
    expect(res.logicMap.edges.some((e) => e.relation === 'question_suggest')).toBe(true);
  });

  it('computes insight last-update timestamp and next-round progress', () => {
    const base = buildSampleSnapshot();
    const now = 1_700_000_030_000;
    const snap: LiveSessionSnapshot = {
      ...base,
      lastInsightAt: now - 30_000,
      analyzedUpToUtteranceId: 'u_2',
      llmStatus: 'idle',
    };

    const status = computeInsightUpdateStatus(snap, now);
    expect(status.lastUpdatedAt).toBe(now - 30_000);
    expect(status.elapsedSinceLastSec).toBe(30);
    expect(status.pendingChars).toBeGreaterThan(40);
    expect(status.progressPct).toBeGreaterThanOrEqual(45);
    expect(status.statusTone).toBe('active');

    const thinkingStatus = computeInsightUpdateStatus(
      { ...snap, llmStatus: 'thinking' },
      now
    );
    expect(thinkingStatus.progressPct).toBe(100);
    expect(thinkingStatus.statusTone).toBe('thinking');
  });
});
