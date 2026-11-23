import { describe, expect, it } from 'vitest';
import {
  computeLiveSpeechAnalytics,
  LogicConnectionMap,
} from '../engine/liveSpeechAnalytics';
import {
  computeMindMapLayout,
  MindMapPositionedNode,
} from '../engine/logicMindMapLayout';
import { createInitialLiveSnapshot } from '../engine/liveSessionStore';
import { LiveSessionSnapshot } from '../types/liveSession';

function assertNoOverlap(nodes: MindMapPositionedNode[]) {
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const separated =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y;
      expect(
        separated,
        `Nodes "${a.id}" and "${b.id}" overlapped: (${a.x},${a.y},${a.width}x${a.height}) vs (${b.x},${b.y},${b.width}x${b.height})`
      ).toBe(true);
    }
  }
}

function buildDenseSnapshot(): LiveSessionSnapshot {
  const base = createInitialLiveSnapshot();
  return {
    ...base,
    phase: 'recording',
    title: '端侧语音与 AI 架构深度复盘',
    elapsedMs: 180_000,
    speakers: [
      { id: 'spk_self', name: '主持人', role: 'self' },
      { id: 'spk_guest', name: '李工', role: 'counterpart' },
    ],
    utterances: [
      {
        id: 'u_1',
        text: '因为端侧内存限制在2GB，所以我们把模型压缩到了INT8量化格式。',
        startMs: 10_000,
        endMs: 25_000,
        speakerId: 'spk_guest',
        speakerSource: 'voiceprint',
      },
      {
        id: 'u_2',
        text: '但是长音频还是会出现声纹漂移，不过可以通过分段聚类解决。',
        startMs: 30_000,
        endMs: 48_000,
        speakerId: 'spk_guest',
        speakerSource: 'voiceprint',
      },
      {
        id: 'u_3',
        text: '例如在60分钟双人播客压测中，首字延迟从900ms降到了320ms。',
        startMs: 55_000,
        endMs: 75_000,
        speakerId: 'spk_guest',
        speakerSource: 'voiceprint',
      },
      {
        id: 'u_4',
        text: '更重要的是，本地推理完全不依赖网络，因此隐私安全性提升明显。',
        startMs: 85_000,
        endMs: 105_000,
        speakerId: 'spk_guest',
        speakerSource: 'voiceprint',
      },
    ],
    profile: {
      background: [{ text: '李工，音视频算法负责人', evidenceMs: 10_000 }],
      stories: [
        {
          title: '60分钟播客压测实战',
          gist: 'INT8量化配合流式分段使首字延迟降低64%',
          evidenceMs: 55_000,
        },
        {
          title: '线下会议室离线部署案例',
          gist: '断网环境下稳定运行本地推理引擎',
          evidenceMs: 85_000,
        },
      ],
      viewpoints: [
        {
          claim: '端侧落地必须依靠 INT8 量化与流式分段',
          support: '延迟从 900ms 降至 320ms，内存稳控 2GB 内',
          evidenceMs: 10_000,
        },
        {
          claim: '本地离线推理的核心价值是隐私与零网络依赖',
          support: '敏感会议录音全程不出本地设备',
          evidenceMs: 85_000,
        },
        {
          claim: '声纹漂移需要靠动态分段聚类持续校准',
          support: '',
          evidenceMs: 30_000,
        },
      ],
    },
    questions: [
      {
        id: 'q_int8',
        type: 'deepen',
        text: 'INT8 量化后在嘈杂环境下的识别准确率下降了多少？',
        why: '验证量化精度取舍',
        relatedTo: 'INT8 量化与流式分段',
        status: 'new',
      },
      {
        id: 'q_privacy',
        type: 'follow_up',
        text: '离线部署在企业客户验收时最看重哪些安全指标？',
        why: '挖掘企业落地痛点',
        relatedTo: '隐私与零网络依赖',
        status: 'adopted',
      },
      {
        id: 'q_root',
        type: 'pivot',
        text: '海外团队拓展与全球化运营何时启动？',
        why: '探讨国际化节奏',
        relatedTo: '出海全球化路线',
        status: 'new',
      },
    ],
  };
}

describe('logicMindMapLayout', () => {
  it('handles empty LogicConnectionMap safely', () => {
    const emptyMap: LogicConnectionMap = {
      rootTopic: '空主题',
      totalConnectors: 0,
      connectorCounts: {
        causal: 0,
        contrast: 0,
        progression: 0,
        example: 0,
        conclusion: 0,
      },
      branches: [],
      nodes: [],
      edges: [],
      expandableNodeIds: [],
    };
    const res = computeMindMapLayout(emptyMap, {
      mode: 'radial',
      containerWidth: 720,
      showDockedQuestions: true,
    });
    expect(res.rootId).toBeNull();
    expect(res.nodes).toHaveLength(0);
    expect(res.curves).toHaveLength(0);
  });

  it('balances branches bilaterally in radial mode and keeps all branches right in right mode', () => {
    const snap = buildDenseSnapshot();
    const { logicMap } = computeLiveSpeechAnalytics(snap);

    const radial = computeMindMapLayout(logicMap, {
      mode: 'radial',
      containerWidth: 820,
      showDockedQuestions: true,
    });
    const root = radial.nodeById.get(radial.rootId!)!;
    const leftNodes = radial.nodes.filter((n) => n.side === 'left');
    const rightNodes = radial.nodes.filter((n) => n.side === 'right');

    expect(leftNodes.length).toBeGreaterThanOrEqual(1);
    expect(rightNodes.length).toBeGreaterThanOrEqual(1);
    for (const ln of leftNodes) {
      expect(ln.x + ln.width).toBeLessThan(root.x);
    }
    for (const rn of rightNodes) {
      expect(rn.x).toBeGreaterThan(root.x + root.width);
    }

    const rightOnly = computeMindMapLayout(logicMap, {
      mode: 'right',
      containerWidth: 820,
      showDockedQuestions: true,
    });
    expect(rightOnly.nodes.filter((n) => n.side === 'left')).toHaveLength(0);
    expect(rightOnly.nodes.filter((n) => n.side === 'right').length).toBe(
      rightOnly.nodes.length - 1
    );
  });

  it('embeds support nodes into parent viewpoints and docks all questions onto modules', () => {
    const snap = buildDenseSnapshot();
    const { logicMap } = computeLiveSpeechAnalytics(snap);

    const layout = computeMindMapLayout(logicMap, {
      mode: 'radial',
      containerWidth: 760,
      showDockedQuestions: true,
    });

    // 不再渲染独立的 question 或已被内嵌的 support 卡片
    expect(layout.nodes.some((n) => n.node.kind === 'question')).toBe(false);
    expect(layout.nodes.some((n) => n.node.kind === 'support')).toBe(false);

    // 核心观点卡片内嵌了论据
    const vp0 = layout.nodeById.get('vp-0');
    expect(vp0?.inlineSupport?.text).toContain('900ms');

    // 提问直接磁吸到关联模块（含未匹配分支的通用提问吸附至中心主题）
    expect(layout.totalDockedQuestions).toBeGreaterThanOrEqual(3);
    const root = layout.nodeById.get(layout.rootId!)!;
    expect(
      root.dockedQuestions.some((q) => q.questionId === 'q_root')
    ).toBe(true);

    // 树干曲线数量严格等于可见节点数 - 1
    expect(layout.curves).toHaveLength(layout.nodes.length - 1);
  });

  it('guarantees zero bounding-box overlap across modes and dock states', () => {
    const snap = buildDenseSnapshot();
    const { logicMap } = computeLiveSpeechAnalytics(snap);

    for (const mode of ['radial', 'right'] as const) {
      for (const showDockedQuestions of [true, false]) {
        const res = computeMindMapLayout(logicMap, {
          mode,
          containerWidth: 640,
          showDockedQuestions,
        });
        assertNoOverlap(res.nodes);
        expect(res.curves).toHaveLength(res.nodes.length - 1);
      }
    }
  });

  it('collapses sub-branches cleanly and maintains layout invariants', () => {
    const snap = buildDenseSnapshot();
    const { logicMap } = computeLiveSpeechAnalytics(snap);

    const expanded = computeMindMapLayout(logicMap, {
      mode: 'radial',
      containerWidth: 760,
      showDockedQuestions: true,
    });

    const collapsibleBranch = expanded.nodes.find(
      (n) => n.depth === 1 && n.childIds.length > 0
    );
    expect(collapsibleBranch).toBeDefined();

    const collapsed = computeMindMapLayout(logicMap, {
      mode: 'radial',
      containerWidth: 760,
      showDockedQuestions: true,
      collapsedIds: new Set([collapsibleBranch!.id]),
    });

    expect(collapsed.nodes.length).toBeLessThan(expanded.nodes.length);
    const updatedBranch = collapsed.nodeById.get(collapsibleBranch!.id)!;
    expect(updatedBranch.isCollapsed).toBe(true);
    expect(updatedBranch.hiddenDescendantCount).toBeGreaterThanOrEqual(1);
    expect(collapsed.curves).toHaveLength(collapsed.nodes.length - 1);
    assertNoOverlap(collapsed.nodes);
  });
});
