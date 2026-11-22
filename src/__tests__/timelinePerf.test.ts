import { describe, expect, it } from 'vitest';
import { createEmptyProjectState } from '../data/emptyProject';
import {
  findActiveOverlapForTrack,
  isSourceMsInTrackMuteRange,
} from '../engine/audioPreviewEngine';
import {
  computeEditedTimeline,
  getCachedEditedTimeline,
  OverlapTimelineRegion,
} from '../engine/timelineEngine';
import {
  PodcastProjectState,
  SpeakerTrack,
  TrackMuteRange,
  TranscriptBlock,
  TranscriptToken,
} from '../types/podcast';

function buildLargeProject(tokenCount = 30000, trackCount = 3): PodcastProjectState {
  const base = createEmptyProjectState();
  const roles: Array<{ role: SpeakerTrack['role']; roleLabel: string; color: string }> = [
    { role: 'host', roleLabel: '主持人', color: '#3b82f6' },
    { role: 'guest', roleLabel: '嘉宾', color: '#10b981' },
    { role: 'co_host', roleLabel: '联合主持', color: '#f59e0b' },
  ];

  const tracks: SpeakerTrack[] = [];
  for (let t = 0; t < trackCount; t++) {
    const r = roles[t % roles.length];
    tracks.push({
      id: `sp_${t}`,
      name: `发言人${t + 1}`,
      role: r.role,
      roleLabel: r.roleLabel,
      color: r.color,
      filePath: `/tmp/track_${t}.wav`,
      durationMs: tokenCount * 220,
      rawLufs: -18,
      autoGainDb: 0,
      syncOffsetMs: 0,
      roomToneStartMs: 0,
      roomToneEndMs: 500,
      peaks: [0.2, 0.4, 0.3],
      solo: false,
      muted: false,
    });
  }

  const tokensPerBlock = 40;
  const blocks: TranscriptBlock[] = [];
  let cursorMs = 0;
  let remaining = tokenCount;
  let blockIdx = 0;

  while (remaining > 0) {
    const count = Math.min(tokensPerBlock, remaining);
    const speakerIdx = blockIdx % trackCount;
    const speakerId = tracks[speakerIdx].id;
    // Periodically overlap block start by 900ms (past trailing 320ms silence & any deleted leading token)
    // to exercise cross-speaker overlap regions
    if (blockIdx > 0 && blockIdx % 5 === 0) {
      cursorMs = Math.max(0, cursorMs - 900);
    }

    const tokens: TranscriptToken[] = [];
    for (let i = 0; i < count; i++) {
      const globalIdx = tokenCount - remaining + i;
      const isSilence = i === count - 1;
      const durMs = isSilence ? 320 : 200;
      const startMs = cursorMs;
      const endMs = startMs + durMs;
      cursorMs = endMs;
      tokens.push({
        id: `tok_${blockIdx}_${i}`,
        type: isSilence ? 'silence' : 'word',
        text: isSilence ? '' : `词${globalIdx}`,
        sourceStartMs: startMs,
        sourceEndMs: endMs,
        durationSec: durMs / 1000,
        origDurationSec: durMs / 1000,
        deleted: globalIdx % 10 === 0,
      });
    }

    blocks.push({
      blockId: `blk_${blockIdx}`,
      speakerId,
      chapterTitle: `章节 ${Math.floor(blockIdx / 25) + 1}`,
      tokens,
    });

    remaining -= count;
    blockIdx++;
  }

  const trackMuteRanges: TrackMuteRange[] = [];
  const totalMs = Math.max(1000, cursorMs);
  for (let m = 0; m < 200; m++) {
    const s = Math.floor((m / 200) * totalMs);
    trackMuteRanges.push({
      id: `mute_${m}`,
      trackId: tracks[m % trackCount].id,
      sourceStartMs: s,
      sourceEndMs: s + 400,
    });
  }

  return {
    ...base,
    projectTitle: '大型压测工程',
    tracks,
    blocks,
    trackMuteRanges,
  };
}

describe('timeline & playback performance baseline', () => {
  it('computes edited timeline for 30,000 tokens within generous upper bound', () => {
    const state = buildLargeProject(30000, 3);
    const samples: number[] = [];
    let lastResult = computeEditedTimeline(state);
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      lastResult = computeEditedTimeline(state);
      samples.push(performance.now() - t0);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const medianMs = sorted[Math.floor(sorted.length / 2)];
    console.log(`[perf] computeEditedTimeline(30k tokens) median=${medianMs.toFixed(2)}ms samples=[${samples.map((x) => x.toFixed(2)).join(', ')}]`);

    expect(lastResult.mappedTokens.length).toBe(30000);
    expect(lastResult.overlapRegions.length).toBeGreaterThan(0);
    expect(medianMs).toBeLessThan(5000);
  });

  it('memoizes timeline computations per state reference via getCachedEditedTimeline', () => {
    const state = buildLargeProject(600, 3);
    const tl1 = getCachedEditedTimeline(state);
    const tl2 = getCachedEditedTimeline(state);
    expect(tl1).toBe(tl2);

    const shallowClone: PodcastProjectState = { ...state };
    const tl3 = getCachedEditedTimeline(shallowClone);
    expect(tl3).not.toBe(tl1);
    expect(tl3).toEqual(computeEditedTimeline(shallowClone));
  });

  it('matches linear .some / .find semantics exactly for mute ranges and overlap lookups across 2000 random queries', () => {
    let seed = 0x12345678;
    const rand = () => {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    const trackIds = ['sp_0', 'sp_1', 'sp_2', 'sp_missing'];
    const muteRanges: TrackMuteRange[] = [];
    for (let i = 0; i < 300; i++) {
      const s = Math.floor(rand() * 50000);
      const len = Math.floor(rand() * 1200);
      muteRanges.push({
        id: `m_${i}`,
        trackId: trackIds[Math.floor(rand() * 3)],
        sourceStartMs: s,
        sourceEndMs: s + len,
      });
    }

    const overlaps: OverlapTimelineRegion[] = [];
    for (let i = 0; i < 300; i++) {
      const s = Number((rand() * 200).toFixed(3));
      const dur = Number((rand() * 3).toFixed(3));
      overlaps.push({
        id: `ov_${i}`,
        blockId: `blk_${i}`,
        editedStartSec: s,
        editedEndSec: Number((s + dur).toFixed(3)),
        sourceStartMs: Math.round(s * 1000),
        sourceEndMs: Math.round((s + dur) * 1000),
        primarySpeakerId: 'sp_0',
        primarySpeakerName: 'Host',
        secondarySpeakerId: trackIds[Math.floor(rand() * 3)],
        secondarySpeakerName: 'Guest',
        muted: i % 3 === 0,
        keepFullVolume: i % 5 === 0,
      });
    }

    for (let q = 0; q < 2000; q++) {
      const tid = trackIds[Math.floor(rand() * trackIds.length)];
      const ms =
        q < 100 && muteRanges[q]
          ? q % 2 === 0
            ? muteRanges[q].sourceStartMs
            : muteRanges[q].sourceEndMs
          : Math.floor(rand() * 52000);
      const expectedMute = muteRanges.some(
        (tm) => tm.trackId === tid && ms >= tm.sourceStartMs && ms <= tm.sourceEndMs
      );
      expect(isSourceMsInTrackMuteRange(muteRanges, tid, ms)).toBe(expectedMute);

      const sec =
        q < 100 && overlaps[q]
          ? q % 2 === 0
            ? overlaps[q].editedStartSec - 0.04
            : overlaps[q].editedEndSec + 0.08
          : rand() * 205;
      const expectedOv = overlaps.find(
        (ov) =>
          ov.secondarySpeakerId === tid &&
          sec >= ov.editedStartSec - 0.04 &&
          sec <= ov.editedEndSec + 0.08
      );
      expect(findActiveOverlapForTrack(overlaps, tid, sec, 0.04, 0.08)).toBe(expectedOv);
    }

    expect(isSourceMsInTrackMuteRange(undefined, 'sp_0', 100)).toBe(false);
    expect(findActiveOverlapForTrack([], 'sp_0', 1.0)).toBeUndefined();
  });
});
