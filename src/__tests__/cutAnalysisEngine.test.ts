import { describe, expect, it } from 'vitest';
import { createEmptyProjectState } from '../data/emptyProject';
import {
  applyEditingHabitProfileConfig,
  buildEditingHabitProfileConfig,
  extractAllCutPoints,
  generateCutAnalysisReport,
  undoCutPoint,
} from '../engine/cutAnalysisEngine';
import { computeEditedTimeline } from '../engine/timelineEngine';
import { PodcastProjectState } from '../types/podcast';

function buildTestProject(): PodcastProjectState {
  const base = createEmptyProjectState();
  return {
    ...base,
    projectTitle: '机密内部访谈测试工程',
    tracks: [
      {
        id: 'sp_host',
        name: '主持人张三',
        role: 'host',
        roleLabel: '主持人',
        color: '#3b82f6',
        filePath: '/Users/secret/host_audio.wav',
        rawLufs: -18,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 500,
        peaks: [0.2, 0.4, 0.3],
        solo: false,
        muted: false,
      },
      {
        id: 'sp_guest',
        name: '嘉宾李四',
        role: 'guest',
        roleLabel: '嘉宾',
        color: '#10b981',
        filePath: '/Users/secret/guest_audio.wav',
        rawLufs: -18,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 500,
        peaks: [0.3, 0.5, 0.2],
        solo: false,
        muted: false,
      },
    ],
    blocks: [
      {
        blockId: 'b1',
        speakerId: 'sp_host',
        chapterTitle: '开场',
        tokens: [
          {
            id: 't1',
            type: 'word',
            text: '欢迎收听',
            sourceStartMs: 0,
            sourceEndMs: 800,
            durationSec: 0.8,
            origDurationSec: 0.8,
          },
          {
            id: 't2',
            type: 'silence',
            text: '',
            sourceStartMs: 800,
            sourceEndMs: 2400,
            durationSec: 1.6,
            origDurationSec: 1.6,
            deleted: true,
          },
          {
            id: 't3',
            type: 'word',
            text: '呃',
            sourceStartMs: 2400,
            sourceEndMs: 2900,
            durationSec: 0.5,
            origDurationSec: 0.5,
            fillerTag: 'pure',
            deleted: true,
          },
          {
            id: 't4',
            type: 'word',
            text: '本期聊机密商业数据。',
            sourceStartMs: 2900,
            sourceEndMs: 4900,
            durationSec: 2.0,
            origDurationSec: 2.0,
          },
        ],
      },
      {
        blockId: 'b2',
        speakerId: 'sp_guest',
        chapterTitle: '正题',
        tokens: [
          {
            id: 'g1',
            type: 'word',
            text: '那个',
            sourceStartMs: 5000,
            sourceEndMs: 5450,
            durationSec: 0.45,
            origDurationSec: 0.45,
            fillerTag: 'pure',
            deleted: true,
          },
          {
            id: 'g2',
            type: 'silence',
            text: '',
            sourceStartMs: 5450,
            sourceEndMs: 6850,
            durationSec: 0.2,
            origDurationSec: 1.4,
          },
          {
            id: 'g3',
            type: 'word',
            text: '我觉得今年增长了35%。',
            sourceStartMs: 6850,
            sourceEndMs: 9250,
            durationSec: 2.4,
            origDurationSec: 2.4,
          },
          {
            id: 'g4',
            type: 'word',
            text: '私有废话片段',
            sourceStartMs: 9250,
            sourceEndMs: 10250,
            durationSec: 1.0,
            origDurationSec: 1.0,
            deleted: true,
            cutByWaveform: true,
          },
        ],
      },
    ],
    trackMuteRanges: [
      {
        id: 'tm1',
        trackId: 'sp_host',
        sourceStartMs: 6000,
        sourceEndMs: 6600,
      },
    ],
  };
}

describe('cutAnalysisEngine', () => {
  it('extracts all cut points including deleted tokens, tightened pauses, and track mutes', () => {
    const state = buildTestProject();
    const timeline = computeEditedTimeline(state);
    const cuts = extractAllCutPoints(state, timeline);

    expect(cuts.length).toBe(5);
    // Should include silence+filler group, filler, pause_tighten, waveform_cut, and track_mute
    const categories = cuts.map((c) => c.category);
    expect(categories).toContain('filler');
    expect(categories).toContain('pause_tighten');
    expect(categories).toContain('waveform_cut');
    expect(categories).toContain('track_mute');

    const tightened = cuts.find((c) => c.category === 'pause_tighten')!;
    expect(tightened.removedDurationSec).toBeCloseTo(1.2, 2);
    expect(tightened.summaryText).toContain('1.40s → 0.20s');
  });

  it('undoes deleted tokens, tightened pauses, and track mute ranges cleanly', () => {
    const state = buildTestProject();
    const timeline = computeEditedTimeline(state);
    const cuts = extractAllCutPoints(state, timeline);

    // Undo tightened pause
    const tightCut = cuts.find((c) => c.category === 'pause_tighten')!;
    const afterTightUndo = undoCutPoint(state, tightCut);
    const restoredG2 = afterTightUndo.blocks[1].tokens.find((t) => t.id === 'g2')!;
    expect(restoredG2.durationSec).toBeCloseTo(1.4, 2);

    // Undo waveform cut
    const waveCut = cuts.find((c) => c.category === 'waveform_cut')!;
    const afterWaveUndo = undoCutPoint(afterTightUndo, waveCut);
    const restoredG4 = afterWaveUndo.blocks[1].tokens.find((t) => t.id === 'g4')!;
    expect(restoredG4.deleted).toBe(false);
    expect(restoredG4.cutByWaveform).toBe(false);

    // Undo track mute
    const muteCut = cuts.find((c) => c.category === 'track_mute')!;
    const afterMuteUndo = undoCutPoint(afterWaveUndo, muteCut);
    expect(afterMuteUndo.trackMuteRanges?.length).toBe(0);
  });

  it('generates cut analysis report and speaker expression suggestions', () => {
    const state = buildTestProject();
    const timeline = computeEditedTimeline(state);
    const cuts = extractAllCutPoints(state, timeline);
    const report = generateCutAnalysisReport(state, timeline, cuts);

    expect(report.totalCutCount).toBe(5);
    expect(report.savedDurationSec).toBeGreaterThan(4.5);
    expect(report.compressionRatioPct).toBeGreaterThan(0);
    expect(report.speakerSuggestions.length).toBe(2);
    expect(report.speakerSuggestions[0].suggestions.length).toBeGreaterThan(0);
  });

  it('exports privacy-safe editing habit config without episode content/names/paths and applies it back', () => {
    const state = buildTestProject();
    const timeline = computeEditedTimeline(state);
    const cuts = extractAllCutPoints(state, timeline);
    const config = buildEditingHabitProfileConfig(state, timeline, cuts);

    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain('机密商业数据');
    expect(serialized).not.toContain('私有废话片段');
    expect(serialized).not.toContain('主持人张三');
    expect(serialized).not.toContain('嘉宾李四');
    expect(serialized).not.toContain('/Users/secret/');
    expect(serialized).not.toContain('机密内部访谈测试工程');

    expect(config.schema).toBe('podcraft-editing-habit-profile');
    expect(config.editingRationale.length).toBeGreaterThanOrEqual(4);
    expect(config.observedMetricsSummary.anonymizedRoleStats.map((r) => r.roleKey)).toEqual([
      'host_1',
      'guest_1',
    ]);

    // Apply loaded config to a fresh project
    const fresh = createEmptyProjectState();
    config.automationParams.stripSilenceThresholdSec = 0.72;
    config.automationParams.cutPrerollSec = 1.5;
    const { nextState, appliedProfile } = applyEditingHabitProfileConfig(fresh, config);
    expect(nextState.stripSilenceThresholdSec).toBe(0.72);
    expect(nextState.cutPrerollSec).toBe(1.5);
    expect(appliedProfile.cutPrerollSec).toBe(1.5);
  });
});
