import { describe, expect, it } from 'vitest';
import { createEmptyProjectState } from '../data/emptyProject';
import {
  applyWaveformSelectionToBlocks,
  computeEditedTimeline,
} from '../engine/timelineEngine';
import type { PodcastProjectState } from '../types/podcast';

type Interval = [number, number];

function mergeIntervals(intervals: Interval[]): Interval[] {
  const valid = intervals
    .filter(([s, e]) => e > s + 1e-6)
    .sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const [s, e] of valid) {
    const prev = merged[merged.length - 1];
    if (!prev || s > prev[1] + 1e-4) {
      merged.push([s, e]);
    } else {
      prev[1] = Math.max(prev[1], e);
    }
  }
  return merged;
}

function sumIntervals(intervals: Interval[]): number {
  return intervals.reduce((acc, [s, e]) => acc + Math.max(0, e - s), 0);
}

function intersectIntervals(aList: Interval[], bList: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [as, ae] of aList) {
    for (const [bs, be] of bList) {
      const s = Math.max(as, bs);
      const e = Math.min(ae, be);
      if (e > s + 1e-6) out.push([s, e]);
    }
  }
  return mergeIntervals(out);
}

function buildLinearGapTestProject(): PodcastProjectState {
  const base = createEmptyProjectState();
  return {
    ...base,
    tracks: [
      {
        id: 'sp_1',
        name: 'Host',
        role: 'host',
        roleLabel: '主持人',
        color: '#3b82f6',
        filePath: '/tmp/host.wav',
        durationMs: 4000,
        rawLufs: -18,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 100,
        peaks: [0.2, 0.4, 0.3, 0.2],
        solo: false,
        muted: false,
      },
    ],
    blocks: [
      {
        blockId: 'blk_1',
        speakerId: 'sp_1',
        chapterTitle: '测试段落',
        tokens: [
          {
            id: 'tok_A',
            type: 'word',
            text: '开始',
            sourceStartMs: 0,
            sourceEndMs: 1000,
            durationSec: 1.0,
            origDurationSec: 1.0,
          },
          {
            id: 'tok_X',
            type: 'word',
            text: '中间',
            sourceStartMs: 1300,
            sourceEndMs: 2000,
            durationSec: 0.7,
            origDurationSec: 0.7,
          },
          {
            id: 'tok_B',
            type: 'word',
            text: '继续',
            sourceStartMs: 2000,
            sourceEndMs: 3000,
            durationSec: 1.0,
            origDurationSec: 1.0,
          },
          {
            id: 'tok_C',
            type: 'word',
            text: '结尾',
            sourceStartMs: 3300,
            sourceEndMs: 4000,
            durationSec: 0.7,
            origDurationSec: 0.7,
          },
        ],
      },
    ],
  };
}

function assertPlaysExactlyComplement(stateAfter: PodcastProjectState, s: number, e: number) {
  const tl = computeEditedTimeline(stateAfter);
  const playedUnion = mergeIntervals(
    tl.playbackSpans.map((sp) => [sp.sourceStartSec, sp.sourceEndSec] as Interval)
  );
  const expected: Interval[] = mergeIntervals([
    [0, s],
    [e, 4.0],
  ]);

  const overlapLen = sumIntervals(intersectIntervals(playedUnion, expected));
  const symDiff = sumIntervals(playedUnion) + sumIntervals(expected) - 2 * overlapLen;
  const leakedCutLen = sumIntervals(intersectIntervals(playedUnion, [[s, e]]));

  expect(symDiff).toBeLessThanOrEqual(0.03);
  expect(leakedCutLen).toBeLessThanOrEqual(0.02);
  expect(Math.abs(tl.totalEditedDurationSec - (4.0 - (e - s)))).toBeLessThanOrEqual(0.03);
}

describe('waveformCutAccuracy (free-mode source audio fidelity)', () => {
  it('starts with an identity 1:1 playbackSpan across [0, 4.0]', () => {
    const state = buildLinearGapTestProject();
    const tl = computeEditedTimeline(state);
    expect(tl.playbackSpans).toHaveLength(1);
    expect(tl.playbackSpans[0].editedStartSec).toBe(0);
    expect(tl.playbackSpans[0].editedEndSec).toBe(4.0);
    expect(tl.playbackSpans[0].sourceStartSec).toBe(0);
    expect(tl.playbackSpans[0].sourceEndSec).toBe(4.0);
    expect(tl.totalEditedDurationSec).toBe(4.0);
  });

  const cases: Array<{ name: string; s: number; e: number }> = [
    { name: 'trailing half of gap + leading edge of X [1.1, 1.5]', s: 1.1, e: 1.5 },
    { name: 'trailing half of gap + entire X before B [1.15, 2.0]', s: 1.15, e: 2.0 },
    { name: 'strictly inside natural gap [1.1, 1.2]', s: 1.1, e: 1.2 },
    { name: 'mid-word split inside B [2.3, 2.6]', s: 2.3, e: 2.6 },
    { name: 'tail of A + leading half of gap [0.8, 1.2]', s: 0.8, e: 1.2 },
  ];

  for (const tc of cases) {
    it(`plays exact complement [0, 4.0] \\ [${tc.s}, ${tc.e}] for ${tc.name}`, () => {
      const state = buildLinearGapTestProject();
      const outcome = applyWaveformSelectionToBlocks(
        state,
        tc.s,
        tc.e,
        'ripple_all',
        undefined,
        { mode: 'free' }
      );
      const nextState: PodcastProjectState = { ...state, blocks: outcome.nextBlocks };
      assertPlaysExactlyComplement(nextState, tc.s, tc.e);
    });
  }
});
