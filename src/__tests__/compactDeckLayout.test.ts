import { describe, expect, it } from 'vitest';
import { createEmptyProjectState } from '../data/emptyProject';
import {
  coalesceChronologicalBlocks,
  computeEditedTimeline,
  computeHorizontalDeckCardWidthPx,
  MappedTokenTimeline,
  mergeCompactDeckTurnGroups,
} from '../engine/timelineEngine';
import { PodcastProjectState } from '../types/podcast';

describe('横向布局发言块紧凑化策略', () => {
  it('根据预览文本长度动态计算自适应卡片宽度', () => {
    const shortW = computeHorizontalDeckCardWidthPx('嗯对。');
    expect(shortW).toBeGreaterThanOrEqual(132);
    expect(shortW).toBeLessThanOrEqual(156);

    const midW = computeHorizontalDeckCardWidthPx('我觉得今天聊的这个话题非常有意思，确实值得深挖。');
    expect(midW).toBeGreaterThan(shortW);
    expect(midW).toBeLessThanOrEqual(260);

    const longText = '这是一段很长的深度阐述内容，用来测试横向卡片在遇到长段落时不会无限拉宽，而是稳定封顶在合理区间内，保证多轨横向布局依然紧凑易读。'.repeat(2);
    const longW = computeHorizontalDeckCardWidthPx(longText);
    expect(longW).toBeLessThanOrEqual(320);

    const overlapShortW = computeHorizontalDeckCardWidthPx('对对。', true);
    expect(overlapShortW).toBeGreaterThanOrEqual(188);
  });

  it('合并同一发言人连续短句且保留交替说话人与长停顿边界', () => {
    const base = createEmptyProjectState();
    const project: PodcastProjectState = {
      ...base,
      tracks: [
        {
          id: 'sp_1',
          name: '主播A',
          role: 'host',
          roleLabel: '主持人 Host',
          color: '#3b82f6',
          rawLufs: -18,
          autoGainDb: 0,
          syncOffsetMs: 0,
          roomToneStartMs: 0,
          roomToneEndMs: 500,
          peaks: [0.3],
          solo: false,
          muted: false,
        },
        {
          id: 'sp_2',
          name: '嘉宾B',
          role: 'guest',
          roleLabel: '飞行嘉宾 Guest',
          color: '#10b981',
          rawLufs: -18,
          autoGainDb: 0,
          syncOffsetMs: 0,
          roomToneStartMs: 0,
          roomToneEndMs: 500,
          peaks: [0.3],
          solo: false,
          muted: false,
        },
      ],
      blocks: [
        // sp_1 连续 3 个短句（间隔 < 1s），应合并为 1 个紧凑发言组
        {
          blockId: 'b1',
          speakerId: 'sp_1',
          chapterTitle: '开场',
          tokens: [
            {
              id: 't1',
              type: 'word',
              text: '大家好，',
              sourceStartMs: 0,
              sourceEndMs: 900,
              durationSec: 0.9,
              origDurationSec: 0.9,
            },
          ],
        },
        {
          blockId: 'b2',
          speakerId: 'sp_1',
          chapterTitle: '开场',
          tokens: [
            {
              id: 't2',
              type: 'word',
              text: '欢迎来到本期播客，',
              sourceStartMs: 1400,
              sourceEndMs: 3200,
              durationSec: 1.8,
              origDurationSec: 1.8,
            },
          ],
        },
        {
          blockId: 'b3',
          speakerId: 'sp_1',
          chapterTitle: '开场',
          tokens: [
            {
              id: 't3',
              type: 'word',
              text: '今天聊聊效率工具。',
              sourceStartMs: 3700,
              sourceEndMs: 5600,
              durationSec: 1.9,
              origDurationSec: 1.9,
            },
          ],
        },
        // sp_2 回应，不与 sp_1 合并
        {
          blockId: 'b4',
          speakerId: 'sp_2',
          chapterTitle: '回应',
          tokens: [
            {
              id: 't4',
              type: 'word',
              text: '没错。',
              sourceStartMs: 6000,
              sourceEndMs: 6800,
              durationSec: 0.8,
              origDurationSec: 0.8,
            },
          ],
        },
        // sp_1 再次接话，再间隔 > 4s 的另一个 sp_1 片段，不应跨长停顿合并
        {
          blockId: 'b5',
          speakerId: 'sp_1',
          chapterTitle: '正题',
          tokens: [
            {
              id: 't5',
              type: 'word',
              text: '我们先看第一点。',
              sourceStartMs: 7200,
              sourceEndMs: 9000,
              durationSec: 1.8,
              origDurationSec: 1.8,
            },
          ],
        },
        {
          blockId: 'b6',
          speakerId: 'sp_1',
          chapterTitle: '正题',
          tokens: [
            {
              id: 't6',
              type: 'word',
              text: '停顿五秒之后的新段落。',
              sourceStartMs: 14500,
              sourceEndMs: 17000,
              durationSec: 2.5,
              origDurationSec: 2.5,
            },
          ],
        },
        // 超长同人段 (> 96 视觉字) 不应与上一组强行合并
        {
          blockId: 'b7',
          speakerId: 'sp_1',
          chapterTitle: '深聊',
          tokens: [
            {
              id: 't7',
              type: 'word',
              text: '这是一段非常长非常详细的技术背景铺垫，里面包含了大量具体案例、时间线拆解与实战总结，字数故意写得很长以确保超过九十六个中文字符，避免单张横向卡片塞入过多文字影响视野与定位。',
              sourceStartMs: 17500,
              sourceEndMs: 32000,
              durationSec: 14.5,
              origDurationSec: 14.5,
            },
          ],
        },
      ],
    };

    const timeline = computeEditedTimeline(project);
    const mappedByTokenId = new Map<string, MappedTokenTimeline>();
    timeline.mappedTokens.forEach((m) => mappedByTokenId.set(m.token.id, m));

    const raw = coalesceChronologicalBlocks(project.blocks);
    expect(raw).toHaveLength(7);

    const compact = mergeCompactDeckTurnGroups(raw, mappedByTokenId);
    // b1+b2+b3 -> 1组; b4 -> 1组; b5 -> 1组; b6 -> 1组 (因间隔5.5s > 4.0s); b7 -> 1组 (因超长)
    expect(compact).toHaveLength(5);
    expect(compact[0].blocks.map((b) => b.blockId)).toEqual(['b1', 'b2', 'b3']);
    expect(compact[1].blocks.map((b) => b.blockId)).toEqual(['b4']);
    expect(compact[2].blocks.map((b) => b.blockId)).toEqual(['b5']);
    expect(compact[3].blocks.map((b) => b.blockId)).toEqual(['b6']);
    expect(compact[4].blocks.map((b) => b.blockId)).toEqual(['b7']);
  });
});
