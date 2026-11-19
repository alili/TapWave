import { describe, it, expect } from 'vitest';
import {
  analyzeTranscriptOutlines,
  generateSectionTitle,
  isSecondaryOverlapShortBlock,
  reorderOutlineSections,
  syncOutlineTitlesToBlocks,
} from '../engine/outlineEngine';
import { PodcastProjectState, TranscriptBlock } from '../types/podcast';
import { computeEditedTimeline } from '../engine/timelineEngine';
import { createEmptyProjectState } from '../data/emptyProject';

function makeMockBlock(
  blockId: string,
  speakerId: string,
  chapterTitle: string,
  text: string,
  startMs: number,
  durationSec: number
): TranscriptBlock {
  const token = {
    id: `tok_${blockId}_0`,
    type: 'word' as const,
    text,
    sourceStartMs: startMs,
    sourceEndMs: startMs + Math.round(durationSec * 1000),
    durationSec,
    origDurationSec: durationSec,
  };
  return {
    blockId,
    speakerId,
    chapterTitle,
    tokens: [token],
  };
}

describe('outlineEngine', () => {
  it('generates concise section titles', () => {
    const title = generateSectionTitle('接下来我们聊聊人工智能在播客制作领域的实际落地经验', 0);
    expect(title).toContain('01');
    expect(title.length).toBeGreaterThan(3);
  });

  it('analyzes transcript outlines by pre-existing chapter titles', () => {
    const b1 = makeMockBlock('b1', 'sp1', '开场引入', '大家好欢迎收听本期播客', 0, 5);
    const b2 = makeMockBlock('b2', 'sp2', '开场引入', '今天我们邀请到行业资深专家', 5000, 5);
    const b3 = makeMockBlock('b3', 'sp1', '技术架构选型', '我们来具体讲讲模型部署和降噪算法', 10000, 10);
    const b4 = makeMockBlock('b4', 'sp2', '总结收尾', '感谢大家收听，记得点赞订阅', 20000, 8);

    const state: PodcastProjectState = {
      ...createEmptyProjectState(),
      projectTitle: '测试播客',
      tracks: [
        { id: 'sp1', name: '主播A', role: 'host', roleLabel: '主持人', color: '#3b82f6', solo: false, muted: false, rawLufs: -16, autoGainDb: 0, syncOffsetMs: 0, roomToneStartMs: 0, roomToneEndMs: 0, peaks: [] },
        { id: 'sp2', name: '嘉宾B', role: 'guest', roleLabel: '飞行嘉宾', color: '#10b981', solo: false, muted: false, rawLufs: -16, autoGainDb: 0, syncOffsetMs: 0, roomToneStartMs: 0, roomToneEndMs: 0, peaks: [] },
      ],
      blocks: [b1, b2, b3, b4],
    };

    const timeline = computeEditedTimeline(state);
    const sections = analyzeTranscriptOutlines(state, timeline);

    expect(sections.length).toBe(3);
    expect(sections[0].title).toBe('开场引入');
    expect(sections[0].blockIds).toEqual(['b1', 'b2']);
    expect(sections[0].speakerNames).toContain('主播A');
    expect(sections[0].speakerNames).toContain('嘉宾B');

    expect(sections[1].title).toBe('技术架构选型');
    expect(sections[1].blockIds).toEqual(['b3']);

    expect(sections[2].title).toBe('总结收尾');
    expect(sections[2].blockIds).toEqual(['b4']);
  });

  it('reorders outline sections and cleanly shifts underlying blocks', () => {
    const b1 = makeMockBlock('b1', 'sp1', 'Part 1', '这是第一部分内容', 0, 5);
    const b2 = makeMockBlock('b2', 'sp1', 'Part 2', '这是第二部分内容', 5000, 5);
    const b3 = makeMockBlock('b3', 'sp1', 'Part 3', '这是第三部分内容', 10000, 5);

    const sections = [
      { id: 's1', title: 'Part 1', summary: '', blockIds: ['b1'], startSec: 0, endSec: 5, durationSec: 5, speakerIds: ['sp1'], speakerNames: ['主播'], wordCount: 8 },
      { id: 's2', title: 'Part 2', summary: '', blockIds: ['b2'], startSec: 5, endSec: 10, durationSec: 5, speakerIds: ['sp1'], speakerNames: ['主播'], wordCount: 8 },
      { id: 's3', title: 'Part 3', summary: '', blockIds: ['b3'], startSec: 10, endSec: 15, durationSec: 5, speakerIds: ['sp1'], speakerNames: ['主播'], wordCount: 8 },
    ];

    // 将 Part 3 移动到第一位 (fromIndex: 2, toIndex: 0)
    const { newSections, newBlocks } = reorderOutlineSections(sections, 2, 0, [b1, b2, b3]);

    expect(newSections.map((s) => s.title)).toEqual(['Part 3', 'Part 1', 'Part 2']);
    expect(newBlocks.map((b) => b.blockId)).toEqual(['b3', 'b1', 'b2']);
  });

  it('syncs updated section titles to blocks', () => {
    const b1 = makeMockBlock('b1', 'sp1', '旧标题', '内容', 0, 5);
    const sections = [
      { id: 's1', title: '新精彩大纲标题', summary: '', blockIds: ['b1'], startSec: 0, endSec: 5, durationSec: 5, speakerIds: ['sp1'], speakerNames: ['主播'], wordCount: 2 },
    ];
    const updated = syncOutlineTitlesToBlocks([b1], sections);
    expect(updated[0].chapterTitle).toBe('新精彩大纲标题');
  });

  it('correctly identifies secondary overlap short blocks that should be hidden', () => {
    // 主讲人长发言：0s ~ 15s (15秒，很多字)
    const hostBlock = makeMockBlock('host_1', 'sp_host', '话题讨论', '今天我们非常荣幸能够和各位专家一起深入聊聊大模型与端侧硬件的融合应用实践', 0, 15);
    // 嘉宾插话短句：5s ~ 6s (1秒，“对的，没错”)，完全重叠在 host 发言区间内
    const guestInterruption = makeMockBlock('guest_1', 'sp_guest', '话题讨论', '对的没错', 5000, 1);
    // 嘉宾独立长发言：15s ~ 25s (10秒)
    const guestFullSpeech = makeMockBlock('guest_2', 'sp_guest', '话题讨论', '从我们过去一年的供应链经验来看，核心矛盾主要集中在芯片能耗和散热架构的设计上', 15000, 10);

    const allBlocks = [hostBlock, guestInterruption, guestFullSpeech];

    // 短句 guest_1 应被判定为副轨重叠插入短句
    expect(isSecondaryOverlapShortBlock(guestInterruption, allBlocks)).toBe(true);
    // 主讲人 hostBlock 不应被判定为插入短句
    expect(isSecondaryOverlapShortBlock(hostBlock, allBlocks)).toBe(false);
    // 独立长发言 guestFullSpeech 不应被判定为插入短句
    expect(isSecondaryOverlapShortBlock(guestFullSpeech, allBlocks)).toBe(false);
  });

  it('analyzes transcript outlines using shownotes skill timeline when no chapter titles exist', () => {
    // 构造无手动章节的对话流
    const b1 = makeMockBlock('b1', 'sp1', '', '大家好欢迎收听本期节目，今天我们聊聊创业心法与产品落地', 0, 8);
    const b2 = makeMockBlock('b2', 'sp2', '', '说到这里我们来具体拆解一下商业模式的底层逻辑与商业闭环', 8000, 10);
    const b3 = makeMockBlock('b3', 'sp1', '', '另外在团队管理方面，核心是让成员找到使命感与执行力', 18000, 10);
    const b4 = makeMockBlock('b4', 'sp2', '', '最后感谢大家的收听，评论区留言我们抽取幸运听友送出专属福利', 28000, 8);

    const state: PodcastProjectState = {
      ...createEmptyProjectState(),
      projectTitle: '智能章节测试',
      tracks: [
        { id: 'sp1', name: '主播小李', role: 'host', roleLabel: '主持人', color: '#3b82f6', solo: false, muted: false, rawLufs: -16, autoGainDb: 0, syncOffsetMs: 0, roomToneStartMs: 0, roomToneEndMs: 0, peaks: [] },
        { id: 'sp2', name: '嘉宾老王', role: 'guest', roleLabel: '飞行嘉宾', color: '#10b981', solo: false, muted: false, rawLufs: -16, autoGainDb: 0, syncOffsetMs: 0, roomToneStartMs: 0, roomToneEndMs: 0, peaks: [] },
      ],
      blocks: [b1, b2, b3, b4],
    };

    const timeline = computeEditedTimeline(state);
    const sections = analyzeTranscriptOutlines(state, timeline);

    expect(sections.length).toBeGreaterThanOrEqual(2);
    // 验证章节来自 Shownotes 语义主题（如开场介绍、商业模式、听友福利等）
    expect(sections[0].title).toBeDefined();
    expect(sections[0].summary).toBeDefined();
    expect(sections[0].blockIds).toContain('b1');
  });
});
