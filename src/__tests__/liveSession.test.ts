import { describe, expect, it } from 'vitest';
import { createDownsampler, int16ToBase64 } from '../engine/liveAudioCapture';
import { buildLiveSessionMarkdown } from '../engine/liveMinutesExporter';
import {
  applyLiveEvent,
  computeUtteranceUploadStates,
  createInitialLiveSnapshot,
  findSpeakerReassignSuggestions,
} from '../engine/liveSessionStore';
import { LiveSessionSnapshot } from '../types/liveSession';

describe('liveSessionStore applyLiveEvent', () => {
  it('handles ready, engine switch, partial/final, utterance_update, insight merge, errors and stopped', () => {
    let snap: LiveSessionSnapshot = {
      ...createInitialLiveSnapshot(),
      phase: 'starting',
      scenario: 'interview',
      title: '测试录制',
      speakers: [
        { id: 'spk_self', name: '我', role: 'self' },
        { id: 'spk_other_1', name: '嘉宾', role: 'counterpart' },
      ],
      outline: [{ id: 'ol_1', text: '创业初衷', status: 'not_started' }],
    };

    snap = applyLiveEvent(snap, {
      type: 'ready',
      asrEngine: 'volcengine_sauc_bigmodel',
      wavPath: '/tmp/rec.wav',
      outputDir: '/tmp/out',
    });
    expect(snap.phase).toBe('recording');
    expect(snap.asrEngine).toBe('volcengine_sauc_bigmodel');
    expect(snap.outputDir).toBe('/tmp/out');

    snap = applyLiveEvent(snap, {
      type: 'engine',
      asrEngine: 'local_sensevoice',
      reason: '403 fallback',
    });
    expect(snap.asrEngine).toBe('local_sensevoice');
    expect(snap.engineNotice).toContain('403 fallback');

    snap = applyLiveEvent(snap, {
      type: 'partial',
      text: '正在说',
      startMs: 1000,
      endMs: 1500,
    });
    expect(snap.partial?.text).toBe('正在说');

    snap = applyLiveEvent(snap, {
      type: 'final',
      utterance: {
        id: 'u_1',
        text: '正在说我的创业经历。',
        startMs: 1000,
        endMs: 5000,
        speakerId: 'spk_other_1',
        speakerSource: 'voiceprint',
      },
    });
    expect(snap.partial).toBeNull();
    expect(snap.utterances).toHaveLength(1);

    snap = applyLiveEvent(snap, {
      type: 'utterance_update',
      utteranceId: 'u_1',
      speakerId: 'spk_self',
      speakerSource: 'manual',
    });
    expect(snap.utterances[0].speakerId).toBe('spk_self');
    expect(snap.utterances[0].speakerSource).toBe('manual');

    // First insight with q1
    snap = applyLiveEvent(snap, {
      type: 'insight',
      seq: 1,
      profile: {
        background: [{ text: '前架构师', evidenceMs: 1200 }],
        stories: [],
        viewpoints: [],
      },
      questions: [
        { id: 'q_1', type: 'deepen', text: '当时为何离职？', why: '挖动机', relatedTo: '背景' },
      ],
      turnSummaries: [{ speakerId: 'spk_other_1', startMs: 1000, summary: '介绍背景' }],
      keyPoints: ['要点A'],
      outlineCoverage: [{ id: 'ol_1', status: 'partial', note: '刚提到' }],
      generatedAt: 10000,
    });
    // Mark q_1 as adopted locally
    snap = {
      ...snap,
      questions: snap.questions.map((q) => (q.id === 'q_1' ? { ...q, status: 'adopted' } : q)),
    };

    // Second insight omits q_1 and repeats the same turnSummary -> adopted q_1 stays & summary deduped
    snap = applyLiveEvent(snap, {
      type: 'insight',
      seq: 2,
      profile: {
        background: [{ text: '前架构师', evidenceMs: 1200 }],
        stories: [{ title: '首次创业', gist: '半年融资', evidenceMs: 3000 }],
        viewpoints: [],
      },
      questions: [
        { id: 'q_2', type: 'follow_up', text: '融资怎么谈的？', why: '挖细节', relatedTo: '故事' },
      ],
      turnSummaries: [
        { speakerId: 'spk_other_1', startMs: 1000, summary: '介绍背景' },
        { speakerId: 'spk_other_1', startMs: 3000, summary: '谈融资' },
      ],
      keyPoints: ['要点A', '要点B'],
      outlineCoverage: [{ id: 'ol_1', status: 'covered', note: '已讲完' }],
      generatedAt: 20000,
    });
    expect(snap.questions.find((q) => q.id === 'q_1')?.status).toBe('adopted');
    expect(snap.questions.find((q) => q.id === 'q_2')?.status).toBe('new');
    expect(snap.turnSummaries).toHaveLength(2);
    expect(snap.outline[0].status).toBe('covered');

    // Non-fatal error keeps phase
    snap = applyLiveEvent(snap, { type: 'error', message: '提示信息', fatal: false });
    expect(snap.phase).toBe('recording');
    expect(snap.engineNotice).toBe('提示信息');

    // Stopped
    snap = applyLiveEvent(snap, {
      type: 'stopped',
      wavPath: '/tmp/rec.wav',
      sessionJsonPath: '/tmp/session.json',
      durationMs: 12000,
    });
    expect(snap.phase).toBe('stopped');
    expect(snap.elapsedMs).toBe(12000);

    // Fatal error moves phase to error
    const errSnap = applyLiveEvent(createInitialLiveSnapshot(), {
      type: 'error',
      message: '致命错误',
      fatal: true,
    });
    expect(errSnap.phase).toBe('error');
    expect(errSnap.errorMessage).toBe('致命错误');
  });

  it('tracks analyzing/analyzed utterance upload states across insight_request, insight, llm error and final_summary', () => {
    let snap: LiveSessionSnapshot = {
      ...createInitialLiveSnapshot(),
      phase: 'recording',
      llmStatus: 'idle',
      utterances: [
        { id: 'u_1', text: '一', startMs: 0, endMs: 1000, speakerId: 's1', speakerSource: 'voiceprint' },
        { id: 'u_2', text: '二', startMs: 1000, endMs: 2000, speakerId: 's1', speakerSource: 'voiceprint' },
        { id: 'u_3', text: '三', startMs: 2000, endMs: 3000, speakerId: 's2', speakerSource: 'voiceprint' },
        { id: 'u_4', text: '四', startMs: 3000, endMs: 4000, speakerId: 's2', speakerSource: 'voiceprint' },
      ],
    };

    snap = applyLiveEvent(snap, { type: 'insight_request', upToUtteranceId: 'u_3' });
    expect(snap.analyzingUpToUtteranceId).toBe('u_3');

    snap = applyLiveEvent(snap, {
      type: 'insight',
      seq: 1,
      profile: { background: [], stories: [], viewpoints: [] },
      questions: [],
      turnSummaries: [],
      keyPoints: [],
      outlineCoverage: [],
      basedOnUtteranceId: 'u_1',
    });
    expect(snap.analyzedUpToUtteranceId).toBe('u_1');
    expect(snap.analyzingUpToUtteranceId).toBeNull();

    // computeUtteranceUploadStates with analyzed=u_1, analyzing=u_3
    snap = applyLiveEvent(snap, { type: 'insight_request', upToUtteranceId: 'u_3' });
    const states = computeUtteranceUploadStates(snap);
    expect(states.get('u_1')).toBe('uploaded');
    expect(states.get('u_2')).toBe('uploading');
    expect(states.get('u_3')).toBe('uploading');
    expect(states.get('u_4')).toBe('pending');

    // LLM error clears analyzing
    snap = applyLiveEvent(snap, { type: 'status', llm: 'error', message: 'timeout' });
    expect(snap.analyzingUpToUtteranceId).toBeNull();

    // final_summary marks all utterances as uploaded
    snap = applyLiveEvent(snap, {
      type: 'final_summary',
      overview: '总结',
      keyTakeaways: [],
      nextSteps: [],
    });
    expect(snap.analyzedUpToUtteranceId).toBe('u_4');
    expect(snap.analyzingUpToUtteranceId).toBeNull();

    // Disabled LLM -> all 'none'
    const disabledStates = computeUtteranceUploadStates({
      ...snap,
      llmStatus: 'disabled',
    });
    expect(Array.from(disabledStates.values())).toEqual(['none', 'none', 'none', 'none']);
  });
});

describe('liveAudioCapture downsampler and base64', () => {
  it('downsamples 48kHz and 44.1kHz to 16kHz Int16 within tolerance', () => {
    const ds48 = createDownsampler(48000, 16000);
    const in48 = new Float32Array(4800);
    for (let i = 0; i < in48.length; i++) {
      in48[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    const out48 = ds48.push(in48);
    expect(out48.length).toBe(1600);
    for (let i = 0; i < out48.length; i++) {
      expect(out48[i]).toBeGreaterThanOrEqual(-32768);
      expect(out48[i]).toBeLessThanOrEqual(32767);
    }

    const ds441 = createDownsampler(44100, 16000);
    let totalOut = 0;
    let totalIn = 0;
    for (let k = 0; k < 10; k++) {
      const chunk = new Float32Array(4410).fill(0.25);
      totalIn += chunk.length;
      const out = ds441.push(chunk);
      totalOut += out.length;
      for (let i = 0; i < out.length; i++) {
        expect(out[i]).toBeGreaterThanOrEqual(-32768);
        expect(out[i]).toBeLessThanOrEqual(32767);
      }
    }
    const expected = Math.round((totalIn * 16000) / 44100);
    expect(Math.abs(totalOut - expected)).toBeLessThanOrEqual(2);
  });

  it('roundtrips Int16Array through int16ToBase64', () => {
    const src = new Int16Array([0, 1234, -1234, 32767, -32768]);
    const b64 = int16ToBase64(src);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const restored = new Int16Array(bytes.buffer);
    expect(Array.from(restored)).toEqual(Array.from(src));
  });
});

describe('liveMinutesExporter buildLiveSessionMarkdown', () => {
  it('formats interview and sales scenarios accurately', () => {
    const base: LiveSessionSnapshot = {
      ...createInitialLiveSnapshot(),
      phase: 'stopped',
      scenario: 'interview',
      title: '创始人对谈',
      asrEngine: 'local_sensevoice',
      elapsedMs: 65000,
      speakers: [
        { id: 'spk_self', name: '主播', role: 'self' },
        { id: 'spk_other_1', name: '张三', role: 'counterpart' },
      ],
      prep: {
        scenario: 'interview',
        title: '创始人对谈',
        topic: 'AI 音频产品',
        goals: '挖故事',
        counterpartName: '张三',
        counterpartBackground: '',
        selfName: '主播',
        speakerCount: 2,
        firstSpeakerId: 'spk_self',
        asrEngine: 'auto',
        outline: [],
      },
      utterances: [
        {
          id: 'u_1',
          text: '大家好我是张三。',
          startMs: 5000,
          endMs: 8000,
          speakerId: 'spk_other_1',
          speakerSource: 'voiceprint',
        },
      ],
      profile: {
        background: [{ text: '十年音频老兵', evidenceMs: 5000 }],
        stories: [],
        viewpoints: [],
      },
    };

    const mdInterview = buildLiveSessionMarkdown(base);
    expect(mdInterview).toContain('# 采访纪要：创始人对谈');
    expect(mdInterview).toContain('[00:05]');
    expect(mdInterview).toContain('识别引擎');
    expect(mdInterview).not.toContain('### 销售洞察');

    const salesSnap: LiveSessionSnapshot = {
      ...base,
      scenario: 'sales',
      profile: {
        ...base.profile,
        sales: {
          painPoints: ['剪辑耗时久'],
          needs: ['实时纪要'],
          objections: [],
          decisionSignals: [],
        },
      },
    };
    const mdSales = buildLiveSessionMarkdown(salesSnap);
    expect(mdSales).toContain('# 销售拜访纪要：创始人对谈');
    expect(mdSales).toContain('### 销售洞察');
    expect(mdSales).toContain('剪辑耗时久');

    const listenSnap: LiveSessionSnapshot = {
      ...base,
      scenario: 'listen',
      title: 'AI Agent 工程化分享',
      speakers: [{ id: 'spk_other_1', name: '主讲人', role: 'counterpart' }],
    };
    const mdListen = buildLiveSessionMarkdown(listenSnap);
    expect(mdListen).toContain('# 讲座/分享笔记：AI Agent 工程化分享');
    expect(mdListen).toContain('## 讲者与核心内容提炼');
    expect(mdListen).toContain('## 延伸思考与后续行动');
  });

  it('handles streaming cloud correction events and keeps rawText for revert', () => {
    let snap = createInitialLiveSnapshot();
    snap = applyLiveEvent(snap, {
      type: 'final',
      utterance: {
        id: 'u_1',
        text: '我们今天聊一下点波波客工作流',
        startMs: 100,
        endMs: 2400,
        speakerId: 'spk_self',
        speakerSource: 'manual',
      },
    });
    expect(snap.utterances[0].text).toBe('我们今天聊一下点波波客工作流');

    snap = applyLiveEvent(snap, {
      type: 'utterance_correction',
      utteranceId: 'u_1',
      status: 'streaming',
      correctedText: '我们今天聊一下点波播客',
      rawText: '我们今天聊一下点波波客工作流',
    });
    expect(snap.utterances[0].correctionStatus).toBe('streaming');
    expect(snap.utterances[0].streamingCorrectedText).toBe('我们今天聊一下点波播客');
    expect(snap.utterances[0].text).toBe('我们今天聊一下点波波客工作流');

    snap = applyLiveEvent(snap, {
      type: 'utterance_correction',
      utteranceId: 'u_1',
      status: 'done',
      correctedText: '我们今天聊一下点波播客工作流。',
      rawText: '我们今天聊一下点波波客工作流',
    });
    expect(snap.utterances[0].correctionStatus).toBe('done');
    expect(snap.utterances[0].text).toBe('我们今天聊一下点波播客工作流。');
    expect(snap.utterances[0].rawText).toBe('我们今天聊一下点波波客工作流');
    expect(snap.utterances[0].streamingCorrectedText).toBeUndefined();
  });

  it('preserves voiceprint metadata and suggests matching utterances when reassigning speaker', () => {
    let snap = createInitialLiveSnapshot();
    snap = applyLiveEvent(snap, {
      type: 'final',
      utterance: {
        id: 'u_1',
        text: '第一段发言',
        startMs: 0,
        endMs: 4000,
        speakerId: 'spk_other_1',
        speakerLabel: 'v0',
        speakerSource: 'voiceprint',
        voiceprintCluster: 'v0',
        voiceprintConfidence: 0.94,
        voiceprintVector: [0.8, 0.2, 0.1, 0.4],
      },
    });
    snap = applyLiveEvent(snap, {
      type: 'final',
      utterance: {
        id: 'u_2',
        text: '第二段同声纹簇发言',
        startMs: 5000,
        endMs: 9000,
        speakerId: 'spk_other_1',
        speakerLabel: 'v0',
        speakerSource: 'voiceprint',
        voiceprintCluster: 'v0',
        voiceprintConfidence: 0.91,
        voiceprintVector: [0.79, 0.21, 0.11, 0.39],
      },
    });
    snap = applyLiveEvent(snap, {
      type: 'final',
      utterance: {
        id: 'u_3',
        text: '第三段不同簇但声纹向量高度相似',
        startMs: 10000,
        endMs: 14000,
        speakerId: 'spk_other_1',
        speakerLabel: 'v1',
        speakerSource: 'voiceprint',
        voiceprintCluster: 'v1',
        voiceprintConfidence: 0.78,
        voiceprintVector: [0.81, 0.19, 0.12, 0.41],
      },
    });
    snap = applyLiveEvent(snap, {
      type: 'final',
      utterance: {
        id: 'u_4',
        text: '第四段已手动锁定过',
        startMs: 15000,
        endMs: 18000,
        speakerId: 'spk_other_1',
        speakerLabel: 'v0',
        speakerSource: 'manual',
        voiceprintCluster: 'v0',
      },
    });

    // utterance_update 后仍保留声纹信息
    snap = applyLiveEvent(snap, {
      type: 'utterance_update',
      utteranceId: 'u_1',
      speakerId: 'spk_new',
      speakerSource: 'manual',
    });
    expect(snap.utterances[0].voiceprintCluster).toBe('v0');
    expect(snap.utterances[0].voiceprintConfidence).toBe(0.94);
    expect(snap.utterances[0].voiceprintVector).toEqual([0.8, 0.2, 0.1, 0.4]);

    const suggestions = findSpeakerReassignSuggestions(
      snap.utterances,
      'u_1',
      'spk_new'
    );
    const ids = suggestions.map((s) => s.utteranceId);
    expect(ids).toContain('u_2');
    expect(ids).toContain('u_3');
    expect(ids).not.toContain('u_4');
  });

  it('tracks targetFields updates and exports targetField results in markdown', () => {
    let snap: LiveSessionSnapshot = {
      ...createInitialLiveSnapshot(),
      scenario: 'sales',
      title: '客户初访',
      targetFields: [
        { id: 'tf_1', label: '预算范围', status: 'missing' },
        { id: 'tf_2', label: '决策流程', status: 'missing' },
      ],
    };

    snap = applyLiveEvent(snap, {
      type: 'insight',
      seq: 1,
      profile: { background: [], stories: [], viewpoints: [] },
      questions: [
        {
          id: 'q_tf2',
          type: 'advance',
          text: '采购审批一般需要经过哪些部门？',
          why: '确认决策链路',
          relatedTo: '决策流程',
          targetField: '决策流程',
        },
      ],
      turnSummaries: [],
      keyPoints: [],
      outlineCoverage: [],
      targetFieldUpdates: [
        { id: 'tf_1', status: 'captured', value: '50万以内', evidenceMs: 12000 },
        { id: 'tf_2', status: 'partial', value: '需技术总监评估', evidenceMs: 18000 },
      ],
    });

    expect(snap.questions[0].targetField).toBe('决策流程');
    expect(snap.targetFields?.[0]).toEqual({
      id: 'tf_1',
      label: '预算范围',
      status: 'captured',
      value: '50万以内',
      evidenceMs: 12000,
    });
    expect(snap.targetFields?.[1].status).toBe('partial');

    const md = buildLiveSessionMarkdown(snap);
    expect(md).toContain('## 目标字段采集结果');
    expect(md).toContain('**预算范围**（已获取）：50万以内 [00:12]');
    expect(md).toContain('**决策流程**（部分提及）：需技术总监评估 [00:18]');
  });

  it('tracks currentTopic and topicFlow in chat scenario and exports markdown', () => {
    let snap: LiveSessionSnapshot = {
      ...createInitialLiveSnapshot(),
      scenario: 'chat',
      title: '产品周会讨论',
      speakers: [
        { id: 'spk_self', name: '我', role: 'self' },
        { id: 'spk_other_1', name: '张三', role: 'counterpart' },
        { id: 'spk_other_2', name: '李四', role: 'counterpart' },
      ],
    };

    snap = applyLiveEvent(snap, {
      type: 'insight',
      seq: 1,
      profile: { background: [], stories: [], viewpoints: [] },
      questions: [],
      turnSummaries: [],
      keyPoints: ['确定先落地议题流转功能'],
      outlineCoverage: [],
      currentTopic: '议题流转 UI 设计',
      topicFlow: [
        {
          id: 't1',
          topic: 'Q4 核心目标对齐',
          status: 'ended',
          relevance: 'high',
          relevanceNote: '紧扣周会主线',
          startMs: 5000,
          speakers: ['我', '张三'],
        },
        {
          id: 't2',
          topic: '议题流转 UI 设计',
          status: 'active',
          relevance: 'high',
          relevanceNote: '从目标自然过渡到设计方案',
          transitionFrom: 'Q4 核心目标对齐',
          startMs: 42000,
          speakers: ['张三', '李四'],
        },
      ],
    });

    expect(snap.currentTopic).toBe('议题流转 UI 设计');
    expect(snap.topicFlow).toHaveLength(2);
    expect(snap.topicFlow?.[1].status).toBe('active');
    expect(snap.topicFlow?.[1].transitionFrom).toBe('Q4 核心目标对齐');

    const md = buildLiveSessionMarkdown(snap);
    expect(md).toContain('# 聊天讨论纪要：产品周会讨论');
    expect(md).toContain('## 议题流转与相关性');
    expect(md).toContain('**议题流转 UI 设计** [当前议题 · 高度相关]（接续自：Q4 核心目标对齐）');
  });

  it('auto-adds speakers on speaker_added and unknown speakerId in final utterance', () => {
    let snap: LiveSessionSnapshot = {
      ...createInitialLiveSnapshot(),
      scenario: 'chat',
      speakers: [{ id: 'spk_1', name: '发言人 1', role: 'counterpart' }],
    };

    snap = applyLiveEvent(snap, {
      type: 'speaker_added',
      speaker: { id: 'spk_2', name: '发言人 2', role: 'counterpart' },
    });
    // duplicate speaker_added should be ignored
    snap = applyLiveEvent(snap, {
      type: 'speaker_added',
      speaker: { id: 'spk_2', name: '发言人 2', role: 'counterpart' },
    });
    expect(snap.speakers).toHaveLength(2);
    expect(snap.speakers[1].name).toBe('发言人 2');

    // final with an unseen speakerId should also be auto-registered as fallback
    snap = applyLiveEvent(snap, {
      type: 'final',
      utterance: {
        id: 'u_3',
        text: '第三位发言人加入讨论',
        startMs: 3000,
        endMs: 4200,
        speakerId: 'spk_3',
        speakerSource: 'cloud',
      },
    });
    expect(snap.speakers).toHaveLength(3);
    expect(snap.speakers[2]).toEqual({
      id: 'spk_3',
      name: '发言人 3',
      role: 'counterpart',
    });
  });
});
