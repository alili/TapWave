import { describe, expect, it } from 'vitest';
import {
  applySpeakerTrackProfileUpdate,
  createEmptyProjectState,
  normalizePlayableAudioUrl,
  parsePodcraftProjectJson,
  serializeProjectToPodcraftJson,
} from '../data/emptyProject';
import {
  applyTrackMuteSelectionToProject,
  applyWaveformSelectionToBlocks,
  buildEdlKeepSegments,
  buildParagraphHintSegments,
  buildVisibleWordTimelineAnnotations,
  coalesceChronologicalBlocks,
  computeEditedTimeline,
  computeAutoScrollViewStartRatio,
  computeWaveformFocusViewport,
  computeWordGapSnapPointsSec,
  findParagraphHintAtSec,
  isWordTimelineZoom,
  PAGE_SCROLL_LANDING_ANCHOR,
  PLAYHEAD_AUTO_SCROLL_ANCHOR,
  projectSourceRangesMsToEditedRatios,
  remapPlayheadAfterTimelineEdit,
  snapRangeToWordGaps,
  snapSourceMsToWaveformValley,
  splitLexicalUnits,
} from '../engine/timelineEngine';
import {
  buildTranscriptBlocksFromImportedTracks,
  computeEmotionCurveFromTracks,
} from '../engine/transcriptBuilder';
import { scanAndCleanMouthClicks } from '../engine/mouthClickCleaner';
import { refineProjectBlocksWithWaveform } from '../engine/waveformAligner';
import { resolveEditedPlayheadToSource } from '../engine/audioPreviewEngine';
import {
  applySubtitleCorrectionHunks,
  parseSubtitleDocument,
  previewSubtitleCorrection,
} from '../engine/subtitleAligner';
import {
  computeSharedReferenceCeiling,
  computeTrackLinearGain,
  HiResWaveformEnvelope,
  parseWaveformEnvelopeBinary,
  sampleCalibratedWaveformPoint,
} from '../engine/waveformEnvelopeLoader';
import { PodcastProjectState, SpeakerTrack, TranscriptBlock } from '../types/podcast';

function createTestFixtureState(): PodcastProjectState {
  const base = createEmptyProjectState();
  return {
    ...base,
    projectTitle: '测试多轨播客工程',
    coldOpenEnabled: true,
    tracks: [
      {
        id: 'sp_1',
        name: '主播A',
        role: 'host',
        roleLabel: '主持人 Host',
        color: '#3b82f6',
        filePath: '/tmp/host_a.wav',
        durationMs: 25000,
        rawLufs: -18.5,
        autoGainDb: 2.5,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 1000,
        peaks: [0.2, 0.5, 0.8, 0.3],
        solo: false,
        muted: false,
      },
      {
        id: 'sp_2',
        name: '嘉宾B',
        role: 'guest',
        roleLabel: '飞行嘉宾 Guest',
        color: '#10b981',
        filePath: '/tmp/guest_b.wav',
        durationMs: 25000,
        rawLufs: -21.0,
        autoGainDb: 5.0,
        syncOffsetMs: 180,
        roomToneStartMs: 0,
        roomToneEndMs: 1000,
        peaks: [0.1, 0.7, 0.6, 0.4],
        solo: false,
        muted: false,
      },
    ],
    highlights: [
      {
        id: 'hl_1',
        speakerId: 'sp_2',
        speakerName: '嘉宾B',
        text: '这是一段核心观点切片。',
        sourceStartMs: 5000,
        sourceEndMs: 17000,
        durationSec: 12.0,
        selectionSource: 'manual_pick',
      },
      {
        id: 'hl_2',
        speakerId: 'sp_1',
        speakerName: '主播A',
        text: '开场追问钩子。',
        sourceStartMs: 1000,
        sourceEndMs: 10000,
        durationSec: 9.0,
        selectionSource: 'ai_auto',
      },
    ],
    blocks: [
      {
        blockId: 'b1',
        speakerId: 'sp_1',
        chapterTitle: '开场引入',
        tokens: [
          {
            id: 't1',
            type: 'word',
            text: '欢迎',
            sourceStartMs: 0,
            sourceEndMs: 450,
            durationSec: 0.45,
            origDurationSec: 0.45,
          },
          {
            id: 't2',
            type: 'word',
            text: '呃',
            fillerTag: 'pure',
            sourceStartMs: 450,
            sourceEndMs: 850,
            durationSec: 0.4,
            origDurationSec: 0.4,
          },
          {
            id: 't3',
            type: 'word',
            text: '收听节目。',
            aiSuggestedText: '收听本期节目。',
            sourceStartMs: 850,
            sourceEndMs: 1450,
            durationSec: 0.6,
            origDurationSec: 0.6,
          },
          {
            id: 's1',
            type: 'silence',
            text: '',
            sourceStartMs: 1450,
            sourceEndMs: 2650,
            durationSec: 1.2,
            origDurationSec: 1.2,
          },
        ],
      },
      {
        blockId: 'b2',
        speakerId: 'sp_2',
        chapterTitle: '嘉宾回应',
        tokens: [
          {
            id: 't4',
            type: 'word',
            text: '非常开心来到这里。',
            sourceStartMs: 2650,
            sourceEndMs: 4650,
            durationSec: 2.0,
            origDurationSec: 2.0,
          },
        ],
      },
      {
        blockId: 'b3',
        speakerId: 'sp_1',
        chapterTitle: '主持追问',
        tokens: [
          {
            id: 't5',
            type: 'word',
            text: '我们直接进入正题！',
            sourceStartMs: 4650,
            sourceEndMs: 6650,
            durationSec: 2.0,
            origDurationSec: 2.0,
          },
        ],
      },
    ],
  };
}

describe('PodCraft Clean Workspace, Project Persistence & Timeline Engine', () => {
  it('launches into a completely clean empty workspace with zero default audio or fake text', () => {
    const empty = createEmptyProjectState();
    expect(empty.tracks).toHaveLength(0);
    expect(empty.blocks).toHaveLength(0);
    expect(empty.highlights).toHaveLength(0);
    expect(empty.glossary).toHaveLength(0);
    expect(empty.emotionCurve).toHaveLength(0);
    expect(empty.introVoiceover).toBeNull();
    expect(empty.introBgm).toBeNull();
    expect(empty.outroBgm).toBeNull();
  });

  it('roundtrips .podcraft project save, modify, and reload cleanly', () => {
    const state = createTestFixtureState();
    // Modify text, delete a filler, bleep a token, add Intro Voiceover, BGM & glossary item
    state.blocks[0].tokens[1].deleted = true;
    state.blocks[0].tokens[2].text = '收听播客。';
    state.blocks[0].tokens[2].correctedStatus = 'manual';
    state.blocks[1].tokens[0].bleeped = true;
    state.glossary.push({ id: 'g1', word: '多轨精剪', type: 'hotword' });
    state.llmConfig.apiKey = 'sk-should-not-persist';
    state.tracks[0].sourceFileName = 'host_a_raw.wav';
    state.tracks[0].audioUrl = 'blob:http://localhost/ephemeral';
    state.introVoiceover = {
      fileName: 'podcast_fixed_intro_vo.wav',
      filePath: '/Users/test/podcast_fixed_intro_vo.wav',
      audioUrl: 'blob:http://localhost/vo_intro',
      durationSec: 6.5,
      enabled: true,
    };
    state.introBgm = {
      fileName: 'intro_theme.mp3',
      filePath: '/Users/test/intro_theme.mp3',
      audioUrl: 'blob:http://localhost/bgm_intro',
      durationSec: 28.4,
      enabled: true,
    };
    state.outroBgm = {
      fileName: 'outro_chill.wav',
      filePath: '/Users/test/outro_chill.wav',
      audioUrl: 'blob:http://localhost/bgm_outro',
      durationSec: 42.0,
      enabled: false,
    };

    const json = serializeProjectToPodcraftJson(state, '/Users/test/episode01.podcraft');
    const restored = parsePodcraftProjectJson(json, '/Users/test/episode01.podcraft', true);
    const tl = computeEditedTimeline(restored);

    expect(restored.projectFilePath).toBe('/Users/test/episode01.podcraft');
    expect(restored.tracks).toHaveLength(2);
    expect(restored.tracks[0].sourceFileName).toBe('host_a_raw.wav');
    expect(restored.tracks[0].audioUrl).toContain('http://127.0.0.1:');
    expect(restored.tracks[0].audioUrl).toContain('/audio?path=');
    expect(restored.introVoiceover?.fileName).toBe('podcast_fixed_intro_vo.wav');
    expect(restored.introVoiceover?.audioUrl).toContain('/audio?path=');
    expect(tl.introVoiceoverDurationSec).toBe(6.5);
    expect(restored.introBgm?.fileName).toBe('intro_theme.mp3');
    expect(restored.introBgm?.audioUrl).toContain('/audio?path=');
    expect(restored.introBgm?.enabled).toBe(true);
    expect(restored.outroBgm?.fileName).toBe('outro_chill.wav');
    expect(restored.outroBgm?.enabled).toBe(false);
    expect(restored.highlights).toHaveLength(2);
    expect(restored.blocks[0].tokens[1].deleted).toBe(true);
    expect(restored.blocks[0].tokens[2].text).toBe('收听播客。');
    expect(restored.blocks[1].tokens[0].bleeped).toBe(true);
    expect(restored.glossary[0].word).toBe('多轨精剪');
    expect(restored.llmConfig.apiKey).toBe('');
  });

  it('builds real speech & explicit silence tokens from imported acoustic VAD segments', () => {
    const base = createEmptyProjectState();
    const tracks = [
      {
        id: 'sp_1',
        name: 'Track01',
        role: 'host' as const,
        roleLabel: '主持人 Host',
        color: '#3b82f6',
        durationMs: 6000,
        rawLufs: -17.2,
        autoGainDb: 1.2,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 500,
        peaks: [0.05, 0.7, 0.1, 0.8],
        detectedSegments: [
          { startMs: 0, endMs: 800, isSilence: true },
          { startMs: 800, endMs: 2600, isSilence: false },
          { startMs: 2600, endMs: 3400, isSilence: true },
          { startMs: 3400, endMs: 5200, isSilence: false },
        ],
        solo: false,
        muted: false,
      },
    ];

    const { blocks, emotionCurve } = buildTranscriptBlocksFromImportedTracks(
      tracks,
      null,
      base.glossary
    );
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const allTokens = blocks.flatMap((b) => b.tokens);
    expect(allTokens.some((t) => t.type === 'silence')).toBe(true);
    expect(allTokens.some((t) => t.type === 'word')).toBe(true);
    expect(emotionCurve.length).toBeGreaterThan(0);
  });

  it('recalculates dynamic chapters and saved duration when deleting tokens or toggling Cold Open', () => {
    const state = createTestFixtureState();
    const initial = computeEditedTimeline(state);

    expect(initial.coldOpenDurationSec).toBeGreaterThan(20);
    expect(initial.chapters[0].timeFormatted).toBe('00:00');
    expect(initial.chapters[0].isColdOpen).toBe(true);

    state.blocks.forEach((b) =>
      b.tokens.forEach((t) => {
        if (t.fillerTag === 'pure') {
          t.deleted = true;
        }
      })
    );

    const afterFillerClean = computeEditedTimeline(state);
    expect(afterFillerClean.editedBodyDurationSec).toBeLessThan(initial.editedBodyDurationSec);
    expect(afterFillerClean.savedDurationSec).toBeGreaterThan(initial.savedDurationSec);

    state.coldOpenEnabled = false;
    const withoutIntro = computeEditedTimeline(state);
    expect(withoutIntro.coldOpenDurationSec).toBe(0);
    expect(withoutIntro.chapters[0].timeFormatted).toBe('00:00');
    expect(withoutIntro.chapters[0].isColdOpen).toBeUndefined();
  });

  it('preserves exact audio duration when correcting typos (Edit Text vs Cut Audio decoupling)', () => {
    const state = createTestFixtureState();
    const before = computeEditedTimeline(state).totalEditedDurationSec;

    const typoToken = state.blocks[0].tokens.find((t) => t.id === 't3')!;
    typoToken.text = '收听本期节目。';
    typoToken.correctedStatus = 'manual';

    const after = computeEditedTimeline(state).totalEditedDurationSec;
    expect(after).toBe(before);
  });

  it('supports bidirectional waveform range cut with Sub-word Boundary Trim (<55% overlap)', () => {
    const state = createTestFixtureState();
    state.coldOpenEnabled = false;

    const outcome = applyWaveformSelectionToBlocks(state, 0.35, 1.0, 'ripple_all');
    expect(outcome.fullDeletedCount).toBe(1);
    expect(outcome.subwordTrimmedCount).toBe(2);

    const nextTokens = outcome.nextBlocks[0].tokens;
    expect(nextTokens[0].subwordTrimmed).toBe(true);
    expect(nextTokens[0].deleted).toBeFalsy();
    expect(nextTokens[1].deleted).toBe(true);
    expect(nextTokens[1].cutByWaveform).toBe(true);
    expect(nextTokens[2].subwordTrimmed).toBe(true);
  });

  it('coalesces adjacent turns of the same speaker when intervening speaker blocks are completely deleted', () => {
    const state = createTestFixtureState();
    state.blocks[1].tokens.forEach((t) => (t.deleted = true));

    const groups = coalesceChronologicalBlocks(state.blocks);
    const coalesced = groups.find((g) => g.speakerId === 'sp_1' && g.blocks.length === 2);
    expect(coalesced).toBeDefined();
    expect(coalesced?.coalescedAcrossCut).toBe(true);
  });

  it('builds EDL keep segments with crossfades and cross-sentence micro-pauses', () => {
    const state = createTestFixtureState();
    const s1 = state.blocks[0].tokens.find((t) => t.id === 's1')!;
    s1.deleted = true;

    const edl = buildEdlKeepSegments(state);
    expect(edl.length).toBeGreaterThanOrEqual(2);
    expect(edl[0].pauseAfterMs).toBe(280);
    expect(edl[0].crossfadeMs).toBe(48);
  });

  it('assembles SenseVoice neural ASR tokens with punctuated fillers, laughter, and single-track mix fallback', () => {
    const singleMixTrack = [
      {
        id: 'ref_1',
        name: 'podcast_mix',
        role: 'ref' as const,
        roleLabel: '合并参考轨',
        color: '#64748b',
        durationMs: 6500,
        rawLufs: -16.8,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 500,
        peaks: [0.2, 0.8, 0.4, 0.9],
        solo: false,
        muted: false,
        isRef: true,
      },
    ];

    const sidecarTracks = {
      ref_1: {
        engine: 'sense_voice_int8',
        tokens: [
          { type: 'word' as const, text: '大家', startMs: 600, endMs: 920 },
          { type: 'word' as const, text: '好，', startMs: 920, endMs: 1200 },
          { type: 'word' as const, text: '那个，', startMs: 1850, endMs: 2250 },
          { type: 'word' as const, text: '欢迎', startMs: 2260, endMs: 2650 },
          { type: 'word' as const, text: '那个', startMs: 2700, endMs: 3000 },
          { type: 'word' as const, text: '时代。', startMs: 3000, endMs: 3450 },
          { type: 'laughter' as const, text: '😂 [笑声]', startMs: 3500, endMs: 4100 },
        ],
      },
    };

    const { blocks } = buildTranscriptBlocksFromImportedTracks(
      singleMixTrack,
      sidecarTracks,
      []
    );
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const allTokens = blocks.flatMap((b) => b.tokens);

    // Leading silence (0 -> 600ms) and intra-turn pause (1200 -> 1850ms)
    expect(allTokens.filter((t) => t.type === 'silence').length).toBeGreaterThanOrEqual(2);
    // Punctuated pure filler '那个，' -> pure, whereas '那个' + '时代。' -> semantic_keep
    const pureFiller = allTokens.find((t) => t.text === '那个，');
    const semanticKeep = allTokens.find((t) => t.text === '那个');
    const laughTok = allTokens.find((t) => t.type === 'laughter');
    expect(pureFiller?.fillerTag).toBe('pure');
    expect(semanticKeep?.fillerTag).toBe('semantic_keep');
    expect(laughTok?.text).toContain('笑声');
  });

  it('defaults hideDeletedTokens=true & playbackRate=1.0 and binary-searches playhead seamlessly across deleted text', () => {
    const empty = createEmptyProjectState();
    expect(empty.hideDeletedTokens).toBe(true);
    expect(empty.playbackRate).toBe(1.0);
    expect(empty.cutPrerollEnabled).toBe(true);
    expect(empty.cutPrerollSec).toBe(1.0);

    const state = createTestFixtureState();
    state.coldOpenEnabled = false;
    state.playbackRate = 1.5;
    state.hideDeletedTokens = true;
    state.cutPrerollEnabled = false;
    state.cutPrerollSec = 2.0;
    // Delete t2 ('呃', 450ms -> 850ms) and bleep t4
    state.blocks[0].tokens[1].deleted = true;
    state.blocks[1].tokens[0].bleeped = true;

    const timeline = computeEditedTimeline(state);
    // t1 occupies [0.00 .. 0.45], t2 is deleted (0s), so t3 ('收听节目。', source 850..1450ms) now starts at 0.45s!
    const atT1 = resolveEditedPlayheadToSource(state, timeline, 0.2);
    expect(atT1.activeTokenId).toBe('t1');
    expect(atT1.activeBlockId).toBe('b1');
    expect(atT1.sourceSec).toBeCloseTo(0.2, 3);

    const acrossDeletedT2 = resolveEditedPlayheadToSource(state, timeline, 0.55);
    expect(acrossDeletedT2.activeTokenId).toBe('t3');
    expect(acrossDeletedT2.activeBlockId).toBe('b1');
    // 0.55 - 0.45 = 0.10s into t3 (whose sourceStartMs is 850ms => 0.95s source time)
    expect(acrossDeletedT2.sourceSec).toBeCloseTo(0.95, 3);

    const atBleepedT4 = resolveEditedPlayheadToSource(state, timeline, 2.5);
    expect(atBleepedT4.activeTokenId).toBe('t4');
    expect(atBleepedT4.activeBlockId).toBe('b2');
    expect(atBleepedT4.isBleeped).toBe(true);

    const json = serializeProjectToPodcraftJson(state, '/Users/test/speed_test.podcraft');
    const restored = parsePodcraftProjectJson(json, '/Users/test/speed_test.podcraft', false);
    expect(restored.playbackRate).toBe(1.5);
    expect(restored.hideDeletedTokens).toBe(true);
    expect(restored.cutPrerollEnabled).toBe(false);
    expect(restored.cutPrerollSec).toBe(2.0);
    expect(restored.tracks[0].audioUrl).toContain('/api/audio-stream?path=');
  });

  it('parses SRT, VTT, ASS, LRC, JSON, and Feishu/plain TXT third-party subtitle formats accurately', () => {
    const srt = parseSubtitleDocument(
      `1\n00:00:00,100 --> 00:00:01,500\n欢迎收听播客节目。\n\n2\n00:00:02,650 --> 00:00:04,650\n非常开心来到这里！\n`,
      'ep01.srt'
    );
    expect(srt.format).toBe('srt');
    expect(srt.hasTimestamps).toBe(true);
    expect(srt.cues).toHaveLength(2);
    expect(srt.cues[0].startMs).toBe(100);
    expect(srt.cues[0].endMs).toBe(1500);

    const vtt = parseSubtitleDocument(
      `WEBVTT\n\n00:01.000 --> 00:03.200\n<v 主播A>大家好，今天聊一聊 AI 工具。</v>`,
      'ep01.vtt'
    );
    expect(vtt.format).toBe('vtt');
    expect(vtt.cues[0].speakerHint).toBe('主播A');
    expect(vtt.cues[0].text).toBe('大家好，今天聊一聊 AI 工具。');

    const ass = parseSubtitleDocument(
      `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.25,0:00:04.50,Default,嘉宾B,0,0,0,,{\\an8}这是一行，带逗号的ASS字幕\\N第二行`,
      'ep01.ass'
    );
    expect(ass.format).toBe('ass');
    expect(ass.cues[0].startMs).toBe(1250);
    expect(ass.cues[0].speakerHint).toBe('嘉宾B');
    expect(ass.cues[0].text).toContain('这是一行，带逗号的ASS字幕');

    const lrc = parseSubtitleDocument(`[00:01.20]第一句歌词字幕\n[00:04.00]第二句字幕`, 'ep01.lrc');
    expect(lrc.format).toBe('lrc');
    expect(lrc.cues).toHaveLength(2);
    expect(lrc.cues[0].endMs).toBe(4000);

    const bccJson = parseSubtitleDocument(
      JSON.stringify({ body: [{ from: 0.5, to: 2.5, content: 'B站JSON字幕测试' }] }),
      'ep01.bcc'
    );
    expect(bccJson.format).toBe('json');
    expect(bccJson.cues[0].startMs).toBe(500);
    expect(bccJson.cues[0].endMs).toBe(2500);

    const feishuTxt = parseSubtitleDocument(
      `主播A 00:01\n欢迎来到本期播客\n嘉宾B 00:05\n很高兴受邀参加`,
      'feishu.txt'
    );
    expect(feishuTxt.format).toBe('timestamped_txt');
    expect(feishuTxt.hasTimestamps).toBe(true);
    expect(feishuTxt.cues).toHaveLength(2);
  });

  it('aligns third-party subtitles to correct homophone & multi-token typos with 0.000s audio duration drift', () => {
    const state = createEmptyProjectState();
    state.tracks = [
      {
        id: 'sp_1',
        name: '主播A',
        role: 'host',
        roleLabel: '主持人 Host',
        color: '#3b82f6',
        durationMs: 6000,
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 500,
        peaks: [0.3, 0.7],
        solo: false,
        muted: false,
      },
    ];
    // Simulate per-character SenseVoice tokens: "欢迎 [呃] 收听 波客 与 诶艾 节目。"
    state.blocks = [
      {
        blockId: 'b_asr_1',
        speakerId: 'sp_1',
        chapterTitle: '开场',
        tokens: [
          { id: 'w1', type: 'word', text: '欢', sourceStartMs: 100, sourceEndMs: 300, durationSec: 0.2, origDurationSec: 0.2 },
          { id: 'w2', type: 'word', text: '迎', sourceStartMs: 300, sourceEndMs: 500, durationSec: 0.2, origDurationSec: 0.2 },
          { id: 'f1', type: 'word', text: '呃', fillerTag: 'pure', sourceStartMs: 500, sourceEndMs: 750, durationSec: 0.25, origDurationSec: 0.25 },
          { id: 'w3', type: 'word', text: '收', sourceStartMs: 750, sourceEndMs: 950, durationSec: 0.2, origDurationSec: 0.2 },
          { id: 'w4', type: 'word', text: '听', sourceStartMs: 950, sourceEndMs: 1150, durationSec: 0.2, origDurationSec: 0.2 },
          { id: 'w5', type: 'word', text: '波', sourceStartMs: 1150, sourceEndMs: 1350, durationSec: 0.2, origDurationSec: 0.2 },
          { id: 'w6', type: 'word', text: '客', sourceStartMs: 1350, sourceEndMs: 1550, durationSec: 0.2, origDurationSec: 0.2 },
          { id: 'w7', type: 'word', text: '与', sourceStartMs: 1550, sourceEndMs: 1750, durationSec: 0.2, origDurationSec: 0.2 },
          { id: 'w8', type: 'word', text: '诶', sourceStartMs: 1750, sourceEndMs: 1950, durationSec: 0.2, origDurationSec: 0.2 },
          { id: 'w9', type: 'word', text: '艾', sourceStartMs: 1950, sourceEndMs: 2150, durationSec: 0.2, origDurationSec: 0.2 },
          { id: 's1', type: 'silence', text: '', sourceStartMs: 2150, sourceEndMs: 2750, durationSec: 0.6, origDurationSec: 0.6 },
          { id: 'w10', type: 'word', text: '节', sourceStartMs: 2750, sourceEndMs: 2950, durationSec: 0.2, origDurationSec: 0.2 },
          { id: 'w11', type: 'word', text: '目。', sourceStartMs: 2950, sourceEndMs: 3250, durationSec: 0.3, origDurationSec: 0.3 },
        ],
      },
    ];

    const beforeDur = computeEditedTimeline(state).totalEditedDurationSec;

    // Third-party SRT omits '呃', fixes '波客' -> '播客', and fixes 2-token '诶艾' -> 1-token 'AI'!
    const srtDoc = parseSubtitleDocument(
      `1\n00:00:00,100 --> 00:00:03,300\n欢迎收听播客与 AI 节目。\n`,
      'proofread.srt'
    );
    const preview = previewSubtitleCorrection(state, srtDoc, {
      targetTrackId: 'all',
      timeOffsetMs: 0,
      autoHideOmittedFillers: false,
      syncPunctuation: true,
      extractGlossaryWords: true,
    });

    expect(preview.hunks.length).toBeGreaterThanOrEqual(2);
    const allIds = new Set(preview.hunks.map((h) => h.id));
    const applied = applySubtitleCorrectionHunks(state, preview, allIds, true);

    const nextState: PodcastProjectState = {
      ...state,
      blocks: applied.nextBlocks,
      glossary: applied.nextGlossary,
    };
    const afterDur = computeEditedTimeline(nextState).totalEditedDurationSec;

    // Zero audio timeline drift!
    expect(afterDur).toBeCloseTo(beforeDur, 4);

    // Pure filler '呃' was preserved (not mistakenly overwritten by '收' or '播'), while '波'->'播' and '诶艾'->'AI'!
    const renderedText = nextState.blocks[0].tokens
      .filter((t) => t.type === 'word' && !t.deleted)
      .map((t) => t.text)
      .join('');
    expect(renderedText).toBe('欢迎呃收听播客与AI节目。');
    // Silence capsule s1 remains completely intact
    expect(nextState.blocks[0].tokens.some((t) => t.id === 's1' && t.type === 'silence')).toBe(true);
    // 'AI' extracted to hotword glossary
    expect(nextState.glossary.some((g) => g.word === 'AI')).toBe(true);
  });

  it('normalizes legacy podaudio:// URLs to HTTP byte-range URLs and resolves playhead across 15+ consecutive deleted tokens', () => {
    const legacyUrl =
      'podaudio://localhost/%2Ftmp%2Fpodcraft_active_session%2Fsp_1_norm48k.wav';
    const playableUrl = normalizePlayableAudioUrl(legacyUrl);
    expect(playableUrl).toBeDefined();
    expect(playableUrl).not.toContain('podaudio://');
    expect(playableUrl).toContain('path=%2Ftmp%2Fpodcraft_active_session%2Fsp_1_norm48k.wav');

    const transcodedFallback = normalizePlayableAudioUrl(legacyUrl, undefined, true);
    expect(transcodedFallback).toContain('transcode=wav');

    // Verify playhead mapping still finds the kept token even when 18 consecutive tokens share the cut boundary
    const state = createTestFixtureState();
    state.coldOpenEnabled = false;
    const bulkDeleted = Array.from({ length: 18 }, (_, i) => ({
      id: `del_bulk_${i}`,
      type: 'word' as const,
      text: '废',
      deleted: true,
      sourceStartMs: 500 + i * 100,
      sourceEndMs: 600 + i * 100,
      durationSec: 0.1,
      origDurationSec: 0.1,
    }));
    state.blocks = [
      {
        blockId: 'blk_bulk',
        speakerId: 'sp_1',
        chapterTitle: '连续删词边界测试',
        tokens: [
          {
            id: 'keep_head',
            type: 'word',
            text: '开头',
            sourceStartMs: 0,
            sourceEndMs: 500,
            durationSec: 0.5,
            origDurationSec: 0.5,
          },
          ...bulkDeleted,
          {
            id: 'keep_tail',
            type: 'word',
            text: '结尾正常播放',
            sourceStartMs: 2300,
            sourceEndMs: 3300,
            durationSec: 1.0,
            origDurationSec: 1.0,
          },
        ],
      },
    ];

    const tl = computeEditedTimeline(state);
    expect(tl.totalEditedDurationSec).toBeCloseTo(1.5, 3);
    const resolvedAtBoundary = resolveEditedPlayheadToSource(state, tl, 0.501);
    expect(resolvedAtBoundary.activeTokenId).toBe('keep_tail');
    expect(resolvedAtBoundary.sourceSec).toBeCloseTo(2.301, 2);
  });

  it('sets and synchronizes speaker/guest name and role across tracks, highlights, overlap notes, and .podcraft files', () => {
    const state = createTestFixtureState();
    state.blocks[0].chapterTitle = 'Track_2 开场对谈';
    state.blocks[0].overlapNote = {
      id: 'ov_1',
      speakerId: 'sp_2',
      speakerName: state.tracks[1].name,
      text: '对对对',
      sourceStartMs: 200,
      sourceEndMs: 600,
      muted: false,
    };

    const renamed = applySpeakerTrackProfileUpdate(state, 'sp_2', '李沐老师', 'guest');
    expect(renamed.tracks[1].name).toBe('李沐老师');
    expect(renamed.tracks[1].role).toBe('guest');
    expect(renamed.tracks[1].roleLabel).toBe('飞行嘉宾 Guest');
    expect(renamed.highlights.find((h) => h.speakerId === 'sp_2')?.speakerName).toBe('李沐老师');
    expect(renamed.blocks[0].overlapNote?.speakerName).toBe('李沐老师');

    const savedJson = serializeProjectToPodcraftJson(renamed);
    const reloaded = parsePodcraftProjectJson(savedJson, undefined, false);
    expect(reloaded.tracks[1].name).toBe('李沐老师');
    expect(reloaded.highlights.find((h) => h.speakerId === 'sp_2')?.speakerName).toBe('李沐老师');
  });

  it('jumps playhead to the exact clicked token across millisecond boundaries, deleted words, and Cold Open', () => {
    const state = createTestFixtureState();
    state.coldOpenEnabled = true;
    // Introduce millisecond-precision durations and a deleted middle word
    state.blocks[0].tokens = [
      {
        id: 'w_1',
        type: 'word',
        text: '今天',
        sourceStartMs: 123,
        sourceEndMs: 567,
        durationSec: 0.444,
        origDurationSec: 0.444,
      },
      {
        id: 'w_del',
        type: 'word',
        text: '那个',
        deleted: true,
        sourceStartMs: 567,
        sourceEndMs: 890,
        durationSec: 0.323,
        origDurationSec: 0.323,
      },
      {
        id: 'w_2',
        type: 'word',
        text: '来聊播客剪辑',
        sourceStartMs: 890,
        sourceEndMs: 1734,
        durationSec: 0.844,
        origDurationSec: 0.844,
      },
    ];

    const tl = computeEditedTimeline(state);
    const activeMapped = tl.mappedTokens.filter((m) => !m.token.deleted);
    expect(activeMapped.length).toBeGreaterThanOrEqual(2);

    for (const mapped of activeMapped) {
      const seekSec = Number(mapped.editedStartSec.toFixed(3));
      const resolved = resolveEditedPlayheadToSource(state, tl, seekSec);
      expect(resolved.activeTokenId).toBe(mapped.token.id);
      expect(resolved.activeBlockId).toBe(mapped.blockId);
      if (typeof mapped.token.sourceStartMs === 'number') {
        expect(resolved.sourceSec).toBeCloseTo(mapped.token.sourceStartMs / 1000, 3);
      }
    }

    // Deleted token's editedStartSec collapses seamlessly onto the next kept word ('w_2')
    const deletedMapped = tl.mappedTokens.find((m) => m.token.id === 'w_del')!;
    const resolvedAfterDeleted = resolveEditedPlayheadToSource(
      state,
      tl,
      deletedMapped.editedStartSec
    );
    expect(resolvedAfterDeleted.activeTokenId).toBe('w_2');
    expect(resolvedAfterDeleted.sourceSec).toBeCloseTo(0.89, 3);
  });

  it('produces dynamic fluctuating emotion curve across multi-track dialogue without silent-track flattening', () => {
    const state = createTestFixtureState();
    // Simulate typical compressed multi-track peaks where only 1 speaker talks at a time
    state.tracks[0].peaks = [0.42, 0.02, 0.39, 0.02, 0.45, 0.02, 0.38, 0.02];
    state.tracks[1].peaks = [0.02, 0.41, 0.02, 0.44, 0.43, 0.02, 0.02, 0.40];

    const curve = computeEmotionCurveFromTracks(state.tracks, state.blocks);
    expect(curve.length).toBe(40);
    const scores = curve.map((c) => c.energyScore);
    const dynamicSpread = Math.max(...scores) - Math.min(...scores);
    expect(dynamicSpread).toBeGreaterThanOrEqual(50);
    expect(curve.some((c) => c.tag === 'climax')).toBe(true);
    expect(curve.some((c) => c.tag === 'low_energy')).toBe(true);
  });

  it('supports high-magnification millisecond leading-edge sub-word trim and partial silence trim', () => {
    const state = createTestFixtureState();
    state.coldOpenEnabled = false;
    state.blocks = [
      {
        blockId: 'blk_zoom',
        speakerId: 'sp_1',
        chapterTitle: '高倍精剪测试',
        tokens: [
          {
            id: 'z_word',
            type: 'word',
            text: '开始',
            sourceStartMs: 1000,
            sourceEndMs: 1500,
            durationSec: 0.5,
            origDurationSec: 0.5,
          },
          {
            id: 'z_sil',
            type: 'silence',
            text: '[空白 1.20s]',
            sourceStartMs: 1500,
            sourceEndMs: 2700,
            durationSec: 1.2,
            origDurationSec: 1.2,
          },
        ],
      },
    ];

    // 1) Trim 45ms leading plosive/breath [0.000s .. 0.045s] at the head of 'z_word'
    const resHead = applyWaveformSelectionToBlocks(state, 0.0, 0.045, 'ripple_all');
    const trimmedWord = resHead.nextBlocks[0].tokens[0];
    expect(trimmedWord.subwordTrimmed).toBe(true);
    expect(trimmedWord.durationSec).toBeCloseTo(0.455, 3);
    expect(trimmedWord.sourceStartMs).toBe(1045);

    // 2) Partially trim 0.50s [0.700s .. 1.200s] inside the 1.20s silence without deleting the entire pause
    state.blocks = resHead.nextBlocks;
    const resSil = applyWaveformSelectionToBlocks(state, 0.7, 1.2, 'ripple_all');
    const trimmedSil = resSil.nextBlocks[0].tokens[1];
    expect(trimmedSil.deleted).toBeFalsy();
    expect(trimmedSil.durationSec).toBeCloseTo(0.7, 3);
  });

  it('maintains a single continuous spanIndex across sub-450ms ASR word gaps and folds overlapped backchannels without playback skips', () => {
    const base = createEmptyProjectState();
    const tracks = [
      {
        id: 'host_1',
        name: '主播A',
        role: 'host' as const,
        roleLabel: '主持人 Host',
        color: '#3b82f6',
        durationMs: 5000,
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 500,
        peaks: [0.3, 0.7, 0.6, 0.8],
        solo: false,
        muted: false,
      },
      {
        id: 'guest_1',
        name: '嘉宾B',
        role: 'guest' as const,
        roleLabel: '飞行嘉宾 Guest',
        color: '#10b981',
        durationMs: 5000,
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 500,
        peaks: [0.2, 0.5, 0.7, 0.6],
        solo: false,
        muted: false,
      },
    ];

    const sidecarTracks = {
      host_1: {
        engine: 'sense_voice_int8',
        tokens: [
          { type: 'word' as const, text: '今天', startMs: 0, endMs: 420 },
          { type: 'word' as const, text: '聊一聊', startMs: 560, endMs: 1120 }, // 140ms natural gap
          { type: 'word' as const, text: '播客剪辑。', startMs: 1250, endMs: 2100 }, // 130ms natural gap
        ],
      },
      guest_1: {
        engine: 'sense_voice_int8',
        tokens: [
          // Backchannel inside host_1's turn (should become overlapNote, NOT warp timeline!)
          { type: 'word' as const, text: '没错', startMs: 1350, endMs: 1750 },
          // Follow-up turn after 2300ms
          { type: 'word' as const, text: '非常实用！', startMs: 2300, endMs: 3200 },
        ],
      },
    };

    const { blocks } = buildTranscriptBlocksFromImportedTracks(tracks, sidecarTracks, []);
    expect(blocks[0].overlapNote?.text).toContain('没错');

    const state: PodcastProjectState = { ...base, tracks, blocks };
    const tl = computeEditedTimeline(state);

    // Entire unedited 5.000s timeline maps 1:1 with zero skipped milliseconds and a single spanIndex = 0!
    expect(tl.totalEditedDurationSec).toBeCloseTo(5.0, 2);
    const activeSpans = new Set(tl.mappedTokens.filter((m) => !m.token.deleted).map((m) => m.spanIndex));
    expect(activeSpans.size).toBe(1);

    // Deleting a middle word splits spanIndex cleanly into two spans (before & after the cut)
    state.blocks[0].tokens[1].deleted = true;
    const tlCut = computeEditedTimeline(state);
    const spansAfterCut = new Set(
      tlCut.mappedTokens.filter((m) => !m.token.deleted).map((m) => m.spanIndex)
    );
    expect(spansAfterCut.size).toBe(2);
  });

  it('detects and cleans mouth-click tokens and impulsive lip-smack spikes inside pauses', () => {
    const state = createEmptyProjectState();
    // 20 peak bins over 4000ms (200ms per bin); bin 6 (1200ms) has an impulsive mouth-smack spike (0.16) inside silence!
    const peaks = new Array(20).fill(0.008);
    peaks[0] = 0.65;
    peaks[1] = 0.72;
    peaks[2] = 0.58;
    peaks[6] = 0.16; // lip-smack inside [800ms .. 1800ms] silence capsule!
    peaks[12] = 0.68;
    peaks[13] = 0.74;

    state.tracks = [
      {
        id: 'sp_1',
        name: '主播A',
        role: 'host',
        roleLabel: '主持人 Host',
        color: '#3b82f6',
        durationMs: 4000,
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 400,
        peaks,
        solo: false,
        muted: false,
      },
    ];
    state.blocks = [
      {
        blockId: 'b_mc',
        speakerId: 'sp_1',
        chapterTitle: '口水音清理测试',
        tokens: [
          {
            id: 'mc_w1',
            type: 'word',
            text: '大家好，',
            sourceStartMs: 0,
            sourceEndMs: 800,
            durationSec: 0.8,
            origDurationSec: 0.8,
          },
          {
            id: 'mc_sil_click',
            type: 'silence',
            text: '',
            sourceStartMs: 800,
            sourceEndMs: 1800,
            durationSec: 1.0,
            origDurationSec: 1.0,
          },
          {
            id: 'mc_smack',
            type: 'word',
            text: '啧，',
            sourceStartMs: 1800,
            sourceEndMs: 2100,
            durationSec: 0.3,
            origDurationSec: 0.3,
          },
          {
            id: 'mc_w2',
            type: 'word',
            text: '欢迎收听节目。',
            sourceStartMs: 2100,
            sourceEndMs: 3800,
            durationSec: 1.7,
            origDurationSec: 1.7,
          },
        ],
      },
    ];

    const res = scanAndCleanMouthClicks(state);
    expect(res.deletedMouthTokens).toBe(1);
    expect(res.mutedPauseClicks).toBe(1);
    expect(res.totalCleanedCount).toBe(2);

    const updated = res.nextBlocks[0].tokens;
    expect(updated[0].deleted).toBeFalsy(); // Normal speech untouched
    expect(updated[1].trackMuted).toBe(true); // Pause lip-smack muted cleanly
    expect(updated[1].mouthClickCleaned).toBe(true);
    expect(updated[2].deleted).toBe(true); // '啧，' mouth-click token deleted
    expect(updated[3].deleted).toBeFalsy(); // Normal speech untouched
  });

  it('preserves uncut ASR inter-token micro-gaps with zero cumulative sourceSec drift or spanIndex flicker', () => {
    const state = createEmptyProjectState();
    state.coldOpenEnabled = false;
    state.tracks = [
      {
        id: 'sp_1',
        name: '主播A',
        role: 'host',
        roleLabel: '主持人 Host',
        color: '#3b82f6',
        filePath: '/tmp/host_a.wav',
        durationMs: 10000,
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 400,
        peaks: [0.3, 0.5, 0.4, 0.6],
        solo: false,
        muted: false,
      },
    ];
    // Simulate a loaded .podcraft or ASR transcript where kept tokens have 150ms–320ms natural inter-word gaps
    state.blocks = [
      {
        blockId: 'b_drift_test',
        speakerId: 'sp_1',
        chapterTitle: '零漂移连续播放测试',
        tokens: [
          {
            id: 'w1',
            type: 'word',
            text: '第一句，',
            sourceStartMs: 0,
            sourceEndMs: 1000,
            durationSec: 1.0,
            origDurationSec: 1.0,
          },
          // 250ms natural ASR gap [1000..1250] without explicit silence token
          {
            id: 'w2',
            type: 'word',
            text: '第二句，',
            sourceStartMs: 1250,
            sourceEndMs: 2450,
            durationSec: 1.2,
            origDurationSec: 1.2,
          },
          // 320ms natural ASR gap [2450..2770] without explicit silence token
          {
            id: 'w3',
            type: 'word',
            text: '第三句，',
            sourceStartMs: 2770,
            sourceEndMs: 4270,
            durationSec: 1.5,
            origDurationSec: 1.5,
          },
          // Explicit deleted filler [4270..4770] -> MUST create a splice boundary!
          {
            id: 'f_cut',
            type: 'word',
            text: '呃',
            fillerTag: 'pure',
            deleted: true,
            sourceStartMs: 4270,
            sourceEndMs: 4770,
            durationSec: 0.5,
            origDurationSec: 0.5,
          },
          {
            id: 'w4',
            type: 'word',
            text: '剪辑后第四句。',
            sourceStartMs: 4770,
            sourceEndMs: 6270,
            durationSec: 1.5,
            origDurationSec: 1.5,
          },
        ],
      },
    ];

    const tl = computeEditedTimeline(state);
    // Before the deleted filler at 4.27s, w1..w3 + both natural ASR gaps must form ONE continuous span [0..4.27s]
    expect(tl.playbackSpans).toHaveLength(2);
    expect(tl.playbackSpans[0].editedStartSec).toBeCloseTo(0, 3);
    expect(tl.playbackSpans[0].editedEndSec).toBeCloseTo(4.27, 3);
    expect(tl.playbackSpans[0].sourceStartSec).toBeCloseTo(0, 3);
    expect(tl.playbackSpans[0].sourceEndSec).toBeCloseTo(4.27, 3);

    // Every sample point across [0..4.25s] (including inside 1.10s and 2.60s inter-word gaps) must map 1:1 with 0 drift and constant spanIndex
    for (const tSec of [0.1, 1.1, 1.8, 2.6, 3.5, 4.2]) {
      const resolved = resolveEditedPlayheadToSource(state, tl, tSec);
      expect(resolved.spanIndex).toBe(tl.playbackSpans[0].spanIndex);
      expect(resolved.sourceSec).toBeCloseTo(tSec, 3);
    }

    // After crossing the deleted 0.5s filler, playhead 4.50s maps cleanly to source 5.00s in span #2
    const afterSplice = resolveEditedPlayheadToSource(state, tl, 4.5);
    expect(afterSplice.spanIndex).toBe(tl.playbackSpans[1].spanIndex);
    expect(afterSplice.sourceSec).toBeCloseTo(5.0, 3);
  });

  it('snaps inaccurate ASR token boundaries to real vocal waveform peaks and filters cross-mic bleed', () => {
    // 4000ms audio with 160 bins (25ms/bin):
    // Track 1 speaks loudly at [500ms..1300ms] (bins 20..52), quiet floor (0.01) elsewhere
    // Track 2 has tiny mic bleed (0.025) at [500ms..1300ms], then speaks loudly at [1850ms..3100ms] (bins 74..124)
    const peaks1 = new Array(160).fill(0.01);
    for (let i = 20; i <= 52; i++) peaks1[i] = 0.58;

    const peaks2 = new Array(160).fill(0.01);
    for (let i = 20; i <= 52; i++) peaks2[i] = 0.024; // faint room bleed from Track 1
    for (let i = 74; i <= 124; i++) peaks2[i] = 0.54; // Track 2 real speech [1850..3100ms]

    const tracks = [
      {
        id: 'sp_1',
        name: '主播A',
        role: 'host' as const,
        roleLabel: '主持人 Host',
        color: '#3b82f6',
        durationMs: 4000,
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 400,
        peaks: peaks1,
        solo: false,
        muted: false,
      },
      {
        id: 'sp_2',
        name: '嘉宾B',
        role: 'guest' as const,
        roleLabel: '飞行嘉宾 Guest',
        color: '#10b981',
        durationMs: 4000,
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 400,
        peaks: peaks2,
        solo: false,
        muted: false,
      },
    ];

    // Feed inaccurate ASR timestamps:
    // - Track 1 word starts 300ms too early in silence (200ms instead of 500ms) & ends 200ms into silence (1500ms instead of 1300ms)
    // - Track 2 has a ghost bleed token at [600..1100ms] AND a CTC-delayed real word starting at 1920ms (70ms after 1850ms consonant) & ending early at 2980ms (120ms before 3100ms vowel tail)
    const built = buildTranscriptBlocksFromImportedTracks(
      tracks,
      {
        sp_1: {
          engine: 'sense_voice_int8',
          tokens: [{ type: 'word', text: '欢迎收听，', startMs: 200, endMs: 1500 }],
        },
        sp_2: {
          engine: 'sense_voice_int8',
          tokens: [
            { type: 'word', text: '收听', startMs: 600, endMs: 1100 }, // ghost bleed!
            { type: 'word', text: '非常高兴来到这里。', startMs: 1920, endMs: 2980 },
          ],
        },
      },
      [],
      'same_room_sync'
    );

    // Ghost bleed token on sp_2 must be dropped; remaining 2 blocks are sp_1 then sp_2
    expect(built.blocks).toHaveLength(2);
    const w1 = built.blocks[0].tokens.find((t) => t.type === 'word')!;
    const w2 = built.blocks[1].tokens.find((t) => t.type === 'word')!;

    // w1 snapped out of [200..500ms] silence and [1300..1500ms] silence tightly onto [~480ms .. ~1335ms]
    expect(w1.sourceStartMs).toBeGreaterThanOrEqual(465);
    expect(w1.sourceStartMs).toBeLessThanOrEqual(525);
    expect(w1.sourceEndMs).toBeGreaterThanOrEqual(1290);
    expect(w1.sourceEndMs).toBeLessThanOrEqual(1355);

    // w2 pulled back to capture [1850ms] consonant onset and extended to capture [3100ms] vowel tail!
    expect(w2.sourceStartMs).toBeGreaterThanOrEqual(1830);
    expect(w2.sourceStartMs).toBeLessThanOrEqual(1880);
    expect(w2.sourceEndMs).toBeGreaterThanOrEqual(3075);
    expect(w2.sourceEndMs).toBeLessThanOrEqual(3135);

    // Also verify refineProjectBlocksWithWaveform works directly on already-loaded blocks
    const refinedAgain = refineProjectBlocksWithWaveform(built.blocks, tracks, 'same_room_sync');
    expect(refinedAgain[0].tokens.find((t) => t.type === 'word')!.sourceStartMs).toBeCloseTo(
      w1.sourceStartMs,
      -2
    );
  });

  it('maintains one unbroken PlaybackSpan across uncut speaker overlaps & long pauses without dead-air blanks', () => {
    const state = createEmptyProjectState();
    state.coldOpenEnabled = false;
    const peaksVoicedPause = new Array(120).fill(0.015);
    // Put sustained missed vocal speech inside [1200ms..2000ms] (bins 36..60)
    for (let i = 36; i <= 60; i++) peaksVoicedPause[i] = 0.45;

    state.tracks = [
      {
        id: 'sp_1',
        name: '主播A',
        role: 'host',
        roleLabel: '主持人 Host',
        color: '#3b82f6',
        durationMs: 4000,
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 300,
        peaks: peaksVoicedPause,
        solo: false,
        muted: false,
      },
      {
        id: 'sp_2',
        name: '嘉宾B',
        role: 'guest',
        roleLabel: '飞行嘉宾 Guest',
        color: '#10b981',
        durationMs: 4000,
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 300,
        peaks: new Array(120).fill(0.015),
        solo: false,
        muted: false,
      },
    ];

    state.blocks = [
      {
        blockId: 'b1',
        speakerId: 'sp_1',
        chapterTitle: '主播发言',
        tokens: [
          {
            id: 'u1',
            type: 'word',
            text: '我们先聊第一个话题。',
            sourceStartMs: 200,
            sourceEndMs: 1100,
            durationSec: 0.9,
            origDurationSec: 0.9,
          },
          // Uncut pause [1100..2200ms] that actually contains untranscribed vocal audio [1200..2000ms]
          {
            id: 's_voiced',
            type: 'silence',
            text: '',
            sourceStartMs: 1100,
            sourceEndMs: 2200,
            durationSec: 1.1,
            origDurationSec: 1.1,
          },
        ],
      },
      {
        blockId: 'b2',
        speakerId: 'sp_2',
        chapterTitle: '嘉宾抢话接话',
        tokens: [
          // Natural -150ms conversational overlap (started at 2050ms before 2200ms)
          {
            id: 'u2',
            type: 'word',
            text: '没错我非常赞同！',
            sourceStartMs: 2050,
            sourceEndMs: 3600,
            durationSec: 1.55,
            origDurationSec: 1.55,
          },
        ],
      },
    ];

    // 1. Mouth-click cleaner MUST NOT mute `s_voiced` because waveform shows sustained speech inside it!
    const cleaned = scanAndCleanMouthClicks(state);
    expect(cleaned.mutedPauseClicks).toBe(0);
    expect(cleaned.nextBlocks[0].tokens[1].trackMuted).toBeFalsy();

    // 2. Uncut timeline [200ms .. 3600ms] MUST form ONE single continuous PlaybackSpan [0.00s .. 3.40s] (ZERO <audio> seeks!)
    const tl = computeEditedTimeline(state);
    expect(tl.playbackSpans).toHaveLength(1);
    expect(tl.playbackSpans[0].editedStartSec).toBeCloseTo(0, 3);
    expect(tl.playbackSpans[0].editedEndSec).toBeCloseTo(3.4, 3);
    expect(tl.playbackSpans[0].sourceStartSec).toBeCloseTo(0.2, 3);
    expect(tl.playbackSpans[0].sourceEndSec).toBeCloseTo(3.6, 3);

    // 3. Monotonic sourceSec progression across speech, pause, and -150ms turn overlap
    let prevSrc = -1;
    for (const playSec of [0.05, 0.5, 1.3, 1.95, 2.05, 2.9, 3.35]) {
      const res = resolveEditedPlayheadToSource(state, tl, playSec);
      expect(res.spanIndex).toBe(0);
      expect(res.sourceSec).toBeCloseTo(0.2 + playSec, 3);
      expect(res.sourceSec!).toBeGreaterThan(prevSrc);
      prevSrc = res.sourceSec!;
    }
  });

  it('keeps legacy .podcraft word duration discrepancies, >2s overlaps, and 45s gaps in ONE continuous PlaybackSpan with zero drift', () => {
    const state = createEmptyProjectState();
    state.coldOpenEnabled = false;
    state.tracks = [
      {
        id: 'sp_1',
        name: '主播A',
        role: 'host',
        roleLabel: '主持人 Host',
        color: '#3b82f6',
        filePath: '/tmp/a.wav',
        durationMs: 70000,
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 500,
        peaks: [0.3, 0.6],
        solo: false,
        muted: false,
      },
      {
        id: 'sp_2',
        name: '嘉宾B',
        role: 'guest',
        roleLabel: '飞行嘉宾 Guest',
        color: '#10b981',
        filePath: '/tmp/b.wav',
        durationMs: 70000,
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 500,
        peaks: [0.2, 0.5],
        solo: false,
        muted: false,
      },
    ];

    state.blocks = [
      {
        blockId: 'b_legacy_1',
        speakerId: 'sp_1',
        chapterTitle: '旧工程字词时长偏差与大跨度连贯测试',
        tokens: [
          {
            id: 'lw1',
            type: 'word',
            text: '这段保存的旧工程词条',
            sourceStartMs: 0,
            sourceEndMs: 2500,
            // Legacy .podcraft discrepancy: saved durationSec differs by 80ms from raw 2.500s
            durationSec: 2.42,
            origDurationSec: 2.5,
          },
          {
            id: 'lw2',
            type: 'word',
            text: '继续自然讲述内容。',
            sourceStartMs: 2500,
            sourceEndMs: 6000,
            durationSec: 3.5,
            origDurationSec: 3.5,
          },
        ],
      },
      {
        blockId: 'b_overlap_3s',
        speakerId: 'sp_2',
        chapterTitle: '超长插话重叠',
        tokens: [
          // Starts 3.2s BEFORE sp_1 finishes (2800ms .. 5200ms) -> completely inside sp_1's turn!
          {
            id: 'ov_inside',
            type: 'word',
            text: '哈哈对对对完全同意',
            sourceStartMs: 2800,
            sourceEndMs: 5200,
            durationSec: 2.4,
            origDurationSec: 2.4,
          },
          // Continues smoothly past 6000ms to 8500ms, followed by 45s musical pause until 53500ms
          {
            id: 'ov_tail',
            type: 'word',
            text: '我们继续往下聊。',
            sourceStartMs: 5200,
            sourceEndMs: 8500,
            durationSec: 3.3,
            origDurationSec: 3.3,
          },
        ],
      },
      {
        blockId: 'b_after_45s_music',
        speakerId: 'sp_1',
        chapterTitle: '间奏音乐后恢复',
        tokens: [
          {
            id: 'after_gap',
            type: 'word',
            text: '欢迎回到下半场。',
            sourceStartMs: 53500,
            sourceEndMs: 56000,
            durationSec: 2.5,
            origDurationSec: 2.5,
          },
        ],
      },
    ];

    const tl = computeEditedTimeline(state);
    // All uncut tokens MUST stay in ONE continuous PlaybackSpan (0 backward seeks, 0 30s split!)
    expect(tl.playbackSpans).toHaveLength(1);
    expect(tl.playbackSpans[0].sourceStartSec).toBeCloseTo(0, 3);
    expect(tl.playbackSpans[0].sourceEndSec).toBeCloseTo(56.0, 3);
    expect(tl.playbackSpans[0].editedStartSec).toBeCloseTo(0, 3);
    expect(tl.playbackSpans[0].editedEndSec).toBeCloseTo(56.0, 3);

    const edl = buildEdlKeepSegments(state);
    expect(edl).toHaveLength(1);
    expect(edl[0].sourceStartMs).toBe(0);
    expect(edl[0].sourceEndMs).toBe(56000);

    let prevSrc = -1;
    for (const tSec of [0.5, 2.45, 4.0, 6.2, 8.1, 30.0, 54.0]) {
      const resolved = resolveEditedPlayheadToSource(state, tl, tSec);
      expect(resolved.spanIndex).toBe(0);
      expect(resolved.sourceSec).toBeCloseTo(tSec, 3);
      expect(resolved.sourceSec!).toBeGreaterThan(prevSrc);
      prevSrc = resolved.sourceSec!;
    }
  });

  it('still splits PlaybackSpan cleanly when a silence or subwordTrimmed token is compressed', () => {
    const state = createEmptyProjectState();
    state.coldOpenEnabled = false;
    state.tracks = [
      {
        id: 'sp_1',
        name: '主播A',
        role: 'host',
        roleLabel: '主持人 Host',
        color: '#3b82f6',
        durationMs: 5000,
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 400,
        peaks: [0.4, 0.5],
        solo: false,
        muted: false,
      },
    ];
    state.blocks = [
      {
        blockId: 'b_comp',
        speakerId: 'sp_1',
        chapterTitle: '气口压缩切点测试',
        tokens: [
          {
            id: 'c1',
            type: 'word',
            text: '第一句，',
            sourceStartMs: 0,
            sourceEndMs: 1000,
            durationSec: 1.0,
            origDurationSec: 1.0,
          },
          {
            id: 'c_sil',
            type: 'silence',
            text: '',
            sourceStartMs: 1000,
            sourceEndMs: 2500,
            durationSec: 0.45, // shortened from 1.50s to 0.45s
            origDurationSec: 1.5,
          },
          {
            id: 'c2',
            type: 'word',
            text: '第二句。',
            sourceStartMs: 2500,
            sourceEndMs: 3800,
            durationSec: 1.3,
            origDurationSec: 1.3,
          },
        ],
      },
    ];

    const tl = computeEditedTimeline(state);
    expect(tl.playbackSpans).toHaveLength(2);
    expect(tl.playbackSpans[0].editedEndSec).toBeCloseTo(1.45, 3);
    expect(tl.playbackSpans[0].sourceEndSec).toBeCloseTo(1.45, 3);
    expect(tl.playbackSpans[1].editedStartSec).toBeCloseTo(1.45, 3);
    expect(tl.playbackSpans[1].sourceStartSec).toBeCloseTo(2.5, 3);
    expect(tl.playbackSpans[1].editedEndSec).toBeCloseTo(2.75, 3);
  });

  it('defaults non-primary speaker auto-ducking (-16dB) and detects multi-track speech overlap regions while ignoring mic bleed', () => {
    const empty = createEmptyProjectState();
    expect(empty.autoSoloMode).toBe('natural_ducking');
    expect(empty.duckAttenuationDb).toBe(-16);

    const state = createEmptyProjectState();
    state.coldOpenEnabled = false;
    state.tracks = [
      {
        id: 'sp_1',
        name: '主播A',
        role: 'host',
        roleLabel: '主持人 Host',
        color: '#3b82f6',
        durationMs: 4000,
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 200,
        peaks: [0.6, 0.65, 0.7, 0.6],
        detectedSegments: [{ startMs: 0, endMs: 2000, isSilence: false }],
        solo: false,
        muted: false,
      },
      {
        id: 'sp_2',
        name: '嘉宾B',
        role: 'guest',
        roleLabel: '嘉宾 Guest',
        color: '#a855f7',
        durationMs: 4000,
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 200,
        // First half [0..1000ms] is low mic bleed (0.08), second quarter [1000..2000ms] is real overlapping speech (0.58)
        peaks: [0.08, 0.58, 0.62, 0.1],
        detectedSegments: [
          { startMs: 100, endMs: 900, isSilence: false }, // low-amplitude bleed -> should be ignored
          { startMs: 1100, endMs: 1900, isSilence: false }, // genuine vocal overlap -> should be detected
        ],
        solo: false,
        muted: false,
      },
    ];

    state.blocks = [
      {
        blockId: 'b_ov_1',
        speakerId: 'sp_1',
        chapterTitle: '多轨重合检测',
        tokens: [
          {
            id: 'w_pri_1',
            type: 'word',
            text: '我们今天聊一下播客剪辑',
            sourceStartMs: 0,
            sourceEndMs: 2000,
            durationSec: 2.0,
            origDurationSec: 2.0,
          },
        ],
        overlapNote: {
          id: 'ov_test_1',
          speakerId: 'sp_2',
          speakerName: '嘉宾B',
          text: '没错',
          sourceStartMs: 500,
          sourceEndMs: 800,
          muted: false,
        },
      },
      {
        blockId: 'b_ov_2',
        speakerId: 'sp_2',
        chapterTitle: '接话段',
        tokens: [
          {
            id: 'w_sec_turn',
            type: 'word',
            text: '确实非常实用',
            sourceStartMs: 1750, // starts 250ms before sp_1 finishes at 2000ms!
            sourceEndMs: 3000,
            durationSec: 1.25,
            origDurationSec: 1.25,
          },
        ],
      },
    ];

    const tl = computeEditedTimeline(state);
    expect(tl.overlapRegions.length).toBeGreaterThanOrEqual(2);
    // Low-amplitude bleed [100..450ms] must NOT be reported as overlap, while 500..900ms overlapNote and 1100..2000ms VAD/cross-turn overlap ARE reported
    expect(tl.overlapRegions.some((ov) => ov.sourceStartMs === 100 && ov.sourceEndMs === 900)).toBe(
      false
    );
    const noteOv = tl.overlapRegions.find(
      (ov) => ov.primarySpeakerId === 'sp_1' && ov.secondarySpeakerId === 'sp_2' && ov.text?.includes('没错')
    );
    expect(noteOv).toBeDefined();
    expect(noteOv?.keepFullVolume).toBe(false);

    // Canceling primary speaker ducking on selection toggles keepFullVolume to true
    state.blocks[0].overlapNote!.keepFullVolume = true;
    const tlWithCancelDucking = computeEditedTimeline(state);
    const updatedNoteOv = tlWithCancelDucking.overlapRegions.find(
      (ov) => ov.primarySpeakerId === 'sp_1' && ov.secondarySpeakerId === 'sp_2' && ov.text?.includes('没错')
    );
    expect(updatedNoteOv?.keepFullVolume).toBe(true);

    const acousticOrTurnOv = tl.overlapRegions.find(
      (ov) => ov.secondarySpeakerId === 'sp_2' && ov.sourceEndMs >= 1900
    );
    expect(acousticOrTurnOv).toBeDefined();
  });

  it('defaults to Audition multitrack workspaceLayout and preserves layout in .podcraft JSON', () => {
    const empty = createEmptyProjectState();
    expect(empty.workspaceLayout).toBe('multitrack');

    const transcriptProj = {
      ...createTestFixtureState(),
      workspaceLayout: 'transcript' as const,
    };
    const serialized = serializeProjectToPodcraftJson(transcriptProj, '/Users/test/layout.podcraft');
    const parsed = parsePodcraftProjectJson(serialized);
    expect(parsed.workspaceLayout).toBe('transcript');

    const corruptedLayoutJson = JSON.stringify({
      ...transcriptProj,
      workspaceLayout: 'unexpected_mode',
    });
    const parsedFallback = parsePodcraftProjectJson(corruptedLayoutJson);
    expect(parsedFallback.workspaceLayout).toBe('multitrack');
  });

  it('snaps high-res waveform cuts to low-energy valleys and emits >=36ms EDL crossfades', () => {
    const baseState = createTestFixtureState();
    // 500 peaks across 5000ms => 10ms per bin; valleys centered at bin 200 (2000ms) and bin 300 (3000ms)
    const peaks = Array.from({ length: 500 }, (_, i) => {
      if (i === 200 || i === 300) return 0.012;
      return 0.78;
    });
    const state: PodcastProjectState = {
      ...baseState,
      coldOpenEnabled: false,
      tracks: [
        {
          ...baseState.tracks[0],
          durationMs: 5000,
          syncOffsetMs: 0,
          peaks,
        },
      ],
      blocks: [
        {
          blockId: 'b_cut_1',
          speakerId: 'sp_1',
          chapterTitle: '章节一',
          tokens: [
            {
              id: 'w_head',
              type: 'word',
              text: '这是上半句连续音频。',
              sourceStartMs: 0,
              sourceEndMs: 2200,
              durationSec: 2.2,
              origDurationSec: 2.2,
            },
            {
              id: 'w_mid_filler',
              type: 'word',
              text: '呃那个',
              sourceStartMs: 2200,
              sourceEndMs: 2800,
              durationSec: 0.6,
              origDurationSec: 0.6,
            },
            {
              id: 'w_tail',
              type: 'word',
              text: '这是下半句连续音频',
              sourceStartMs: 2800,
              sourceEndMs: 5000,
              durationSec: 2.2,
              origDurationSec: 2.2,
            },
          ],
        },
      ],
    };

    // Direct valley snap near 2012ms must snap onto bin 200 (~2000ms)
    const snapped = snapSourceMsToWaveformValley(
      state.tracks,
      state.recordingMode,
      2012,
      'sp_1',
      24
    );
    expect(Math.abs(snapped - 2000)).toBeLessThanOrEqual(12);

    // Waveform selection cut across 2.01s..2.99s trims edge tokens and snaps cuts onto valleys (2000ms / 3000ms)
    const outcome = applyWaveformSelectionToBlocks(state, 2.01, 2.99, 'ripple_all');
    const keepTokens = outcome.nextBlocks[0].tokens.filter((t) => !t.deleted);
    expect(keepTokens.length).toBe(2);
    const trimmedTailEndMs = keepTokens[0].sourceStartMs + keepTokens[0].durationSec * 1000;
    expect(Math.abs(trimmedTailEndMs - 2000)).toBeLessThanOrEqual(12);
    expect(Math.abs(keepTokens[1].sourceStartMs - 3000)).toBeLessThanOrEqual(12);

    const cutState: PodcastProjectState = { ...state, blocks: outcome.nextBlocks };
    const tl = computeEditedTimeline(cutState);
    expect(tl.playbackSpans.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(tl.playbackSpans[0].sourceEndSec * 1000 - 2000)).toBeLessThanOrEqual(12);
    expect(Math.abs(tl.playbackSpans[1].sourceStartSec * 1000 - 3000)).toBeLessThanOrEqual(12);
    const edl = buildEdlKeepSegments(cutState);
    expect(edl.length).toBeGreaterThanOrEqual(2);
    expect(edl[0].crossfadeMs).toBeGreaterThanOrEqual(36);
  });

  it('defaults asrConfig, strips apiKey on .podcraft serialization, and supports legacy project JSON', () => {
    const empty = createEmptyProjectState();
    expect(empty.asrConfig.provider).toBe('local_sensevoice');
    expect(empty.asrConfig.baseUrl).toBe('https://api.deepseek.com');
    expect(empty.asrConfig.fallbackToLocal).toBe(true);

    const state = createTestFixtureState();
    state.asrConfig = {
      provider: 'deepseek',
      apiKey: 'sk-super-secret-deepseek-key',
      baseUrl: 'https://api.deepseek.com/v1',
      model: '',
      fallbackToLocal: false,
    };

    const json = serializeProjectToPodcraftJson(state, '/Users/test/ds_ep.podcraft');
    expect(json).not.toContain('sk-super-secret-deepseek-key');

    const restored = parsePodcraftProjectJson(json, '/Users/test/ds_ep.podcraft', false);
    expect(restored.asrConfig.provider).toBe('deepseek');
    expect(restored.asrConfig.apiKey).toBe('');
    expect(restored.asrConfig.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(restored.asrConfig.fallbackToLocal).toBe(false);

    // Simulate a legacy .podcraft envelope without asrConfig
    const parsedEnvelope = JSON.parse(json) as {
      format: string;
      version: string;
      savedAt: string;
      project: Record<string, unknown>;
    };
    delete parsedEnvelope.project.asrConfig;
    const legacyRestored = parsePodcraftProjectJson(
      JSON.stringify(parsedEnvelope),
      '/Users/test/legacy_ep.podcraft',
      false
    );
    expect(legacyRestored.asrConfig.provider).toBe('local_sensevoice');
    expect(legacyRestored.asrConfig.baseUrl).toBe('https://api.deepseek.com');
    expect(legacyRestored.asrConfig.fallbackToLocal).toBe(true);
  });

  it('keeps activeBlockId and activeTokenId synced across Cold Open, body tokens, and inter-word breath gaps', () => {
    const base = createTestFixtureState();
    const syncState: PodcastProjectState = {
      ...base,
      coldOpenEnabled: true,
      highlights: [
        {
          id: 'hl_sync',
          speakerId: 'sp_1',
          speakerName: '主播A',
          text: '高光金句',
          sourceStartMs: 1000,
          sourceEndMs: 2200,
          durationSec: 1.2,
          selectionSource: 'manual_pick',
        },
      ],
      blocks: [
        {
          blockId: 'blk_sync',
          speakerId: 'sp_1',
          chapterTitle: '测试同步',
          tokens: [
            {
              id: 'tok_a',
              type: 'word',
              text: '开场',
              sourceStartMs: 1000,
              sourceEndMs: 1400,
              durationSec: 0.4,
              origDurationSec: 0.4,
            },
            // Inter-word breath gap between 1400ms and 1600ms (no token covers 1400..1600)
            {
              id: 'tok_b',
              type: 'word',
              text: '聚焦',
              sourceStartMs: 1600,
              sourceEndMs: 2200,
              durationSec: 0.6,
              origDurationSec: 0.6,
            },
          ],
        },
      ],
    };

    const tl = computeEditedTimeline(syncState);

    // 1. Cold Open segment (after 2.0s intro swell) resolves matching block & token instead of dropping to null
    const coldRes = resolveEditedPlayheadToSource(syncState, tl, 2.25);
    expect(coldRes.inColdOpen).toBe(true);
    expect(coldRes.activeSpeakerId).toBe('sp_1');
    expect(coldRes.activeBlockId).toBe('blk_sync');
    expect(coldRes.activeTokenId).toBe('tok_a');

    // 2. Body word token resolves exact block & token
    const bodyTokA = tl.mappedTokens.find((m) => m.token.id === 'tok_a')!;
    const bodyWordRes = resolveEditedPlayheadToSource(
      syncState,
      tl,
      (bodyTokA.editedStartSec + bodyTokA.editedEndSec) * 0.5
    );
    expect(bodyWordRes.inColdOpen).toBe(false);
    expect(bodyWordRes.activeBlockId).toBe('blk_sync');
    expect(bodyWordRes.activeTokenId).toBe('tok_a');

    // 3. Inter-word breath gap right after tok_a still keeps activeBlockId & nearest activeTokenId
    //    while keeping activeSpeakerId === null so audio mixing gates stay untouched.
    const bodyTokB = tl.mappedTokens.find((m) => m.token.id === 'tok_b')!;
    const gapMidSec = (bodyTokA.editedEndSec + bodyTokB.editedStartSec) * 0.5;
    expect(bodyTokB.editedStartSec - bodyTokA.editedEndSec).toBeGreaterThan(0.1);
    const gapRes = resolveEditedPlayheadToSource(syncState, tl, gapMidSec);
    expect(gapRes.inColdOpen).toBe(false);
    expect(gapRes.activeSpeakerId).toBeNull();
    expect(gapRes.activeBlockId).toBe('blk_sync');
    expect(gapRes.activeTokenId).not.toBeNull();
  });

  it('auto-focuses waveform viewport onto clicked speaker blocks and preserves finer word-level zoom', () => {
    const totalSec = 1800;
    const maxZoom = 2250;

    // 1. Clicking a 6s speaker block from 1x overview zooms to <=24s window and frames [start, end] cleanly
    const shortFocus = computeWaveformFocusViewport({
      blockStartSec: 420,
      blockEndSec: 426,
      totalSec,
      maxZoom,
      currentZoom: 1,
      currentViewStartRatio: 0,
    });
    const shortWindowSec = totalSec / shortFocus.zoom;
    expect(shortFocus.seekSec).toBe(420);
    expect(shortWindowSec).toBeGreaterThanOrEqual(8.0);
    expect(shortWindowSec).toBeLessThanOrEqual(10.0);
    expect(shortFocus.viewStartRatio * totalSec).toBeLessThan(420);
    expect((shortFocus.viewStartRatio + 1 / shortFocus.zoom) * totalSec).toBeGreaterThan(426);
    const shortSeekRel =
      (shortFocus.seekSec / totalSec - shortFocus.viewStartRatio) * shortFocus.zoom;
    expect(shortSeekRel).toBeGreaterThanOrEqual(0.08);
    expect(shortSeekRel).toBeLessThanOrEqual(0.88);

    // 2. Clicking a long 45s monologue caps visible window at 24s so inline word ticks stay visible
    const longFocus = computeWaveformFocusViewport({
      blockStartSec: 900,
      blockEndSec: 945,
      totalSec,
      maxZoom,
      currentZoom: 1,
      currentViewStartRatio: 0,
    });
    const longWindowSec = totalSec / longFocus.zoom;
    expect(longWindowSec).toBeLessThanOrEqual(24.0);
    expect(longFocus.viewStartRatio * totalSec).toBeLessThan(900);

    // 3. Clicking an individual word while already at 300x zoom preserves fine zoom and pans if offscreen
    const inViewWord = computeWaveformFocusViewport({
      blockStartSec: 420,
      blockEndSec: 426,
      totalSec,
      maxZoom,
      anchorSec: 422.5,
      currentZoom: 300,
      currentViewStartRatio: 420 / totalSec,
      preserveHigherZoom: true,
    });
    expect(inViewWord.zoom).toBe(300);
    expect(inViewWord.viewStartRatio).toBeCloseTo(420 / totalSec, 6);

    const offViewWord = computeWaveformFocusViewport({
      blockStartSec: 420,
      blockEndSec: 426,
      totalSec,
      maxZoom,
      anchorSec: 425.6,
      currentZoom: 300,
      currentViewStartRatio: 418 / totalSec,
      preserveHigherZoom: true,
    });
    expect(offViewWord.zoom).toBe(300);
    expect(offViewWord.viewStartRatio).toBeGreaterThan(418 / totalSec);
    expect((offViewWord.viewStartRatio + 1 / offViewWord.zoom) * totalSec).toBeGreaterThan(425.6);
  });

  it('handles large 1-hour multi-track projects (6,000+ tokens & 600 VAD segments) cleanly and fast', () => {
    const base = createEmptyProjectState();
    const totalMs = 3600_000;
    const hostVad: Array<{ startMs: number; endMs: number; isSilence: boolean }> = [];
    const guestVad: Array<{ startMs: number; endMs: number; isSilence: boolean }> = [];
    for (let i = 0; i < 600; i++) {
      const startMs = i * 6000 + 200;
      hostVad.push({ startMs, endMs: startMs + 4800, isSilence: false });
      // Every third segment also has overlapping guest speech (200 overlaps)
      if (i % 3 === 0) {
        guestVad.push({ startMs: startMs + 800, endMs: startMs + 2200, isSilence: false });
      }
    }

    const blocks = [];
    for (let b = 0; b < 300; b++) {
      const blkStartMs = b * 12000;
      const tokens = [];
      for (let w = 0; w < 20; w++) {
        const sMs = blkStartMs + w * 500;
        tokens.push({
          id: `lg_tok_${b}_${w}`,
          type: 'word' as const,
          text: w % 5 === 0 ? '讨论' : '内容',
          sourceStartMs: sMs,
          sourceEndMs: sMs + 420,
          durationSec: 0.42,
          origDurationSec: 0.42,
        });
      }
      tokens.push({
        id: `lg_sil_${b}`,
        type: 'silence' as const,
        text: '[停顿]',
        sourceStartMs: blkStartMs + 10000,
        sourceEndMs: blkStartMs + 11500,
        durationSec: 1.5,
        origDurationSec: 1.5,
      });
      blocks.push({
        blockId: `lg_blk_${b}`,
        speakerId: b % 2 === 0 ? 'sp_host' : 'sp_guest',
        chapterTitle: '测试章节',
        tokens,
      });
    }

    const largeState: PodcastProjectState = {
      ...base,
      projectTitle: '1小时大型多轨测试',
      coldOpenEnabled: true,
      autoSoloMode: 'natural_ducking',
      tracks: [
        {
          id: 'sp_host',
          name: '主播A',
          role: 'host',
          roleLabel: '主持人 Host',
          color: '#3b82f6',
          filePath: '/tmp/host_1h.wav',
          durationMs: totalMs,
          rawLufs: -18,
          syncOffsetMs: 0,
          roomToneStartMs: 0,
          roomToneEndMs: 500,
          peaks: new Array(3600).fill(0.18),
          muted: false,
          solo: false,
          autoGainDb: 0,
          detectedSegments: hostVad,
        },
        {
          id: 'sp_guest',
          name: '嘉宾B',
          role: 'guest',
          roleLabel: '嘉宾 Guest',
          color: '#10b981',
          filePath: '/tmp/guest_1h.wav',
          durationMs: totalMs,
          rawLufs: -18,
          syncOffsetMs: 0,
          roomToneStartMs: 0,
          roomToneEndMs: 500,
          peaks: new Array(3600).fill(0.14),
          muted: false,
          solo: false,
          autoGainDb: 0,
          detectedSegments: guestVad,
        },
      ],
      highlights: [
        {
          id: 'lg_hl_1',
          speakerId: 'sp_host',
          speakerName: '主播A',
          text: '高光片段',
          sourceStartMs: 120_000,
          sourceEndMs: 124_000,
          durationSec: 4.0,
          selectionSource: 'manual_pick',
        },
      ],
      blocks,
    };

    const t0 = performance.now();
    const tl = computeEditedTimeline(largeState);
    const computeMs = performance.now() - t0;

    expect(tl.mappedTokens.length).toBe(6300);
    expect(tl.totalEditedDurationSec).toBeGreaterThan(2500);
    expect((tl.overlapRegions ?? []).length).toBeGreaterThanOrEqual(50);
    expect(computeMs).toBeLessThan(1500);

    // Cold Open binary lookup resolves the 120s highlight onto lg_blk_10 in O(log K)
    const coldHit = resolveEditedPlayheadToSource(largeState, tl, 2.3);
    expect(coldHit.inColdOpen).toBe(true);
    expect(coldHit.activeBlockId).toBe('lg_blk_10');
    expect(coldHit.activeTokenId).toBe('lg_tok_10_0');

    // Sweep 1,000 playhead scrubs across the entire 1-hour timeline
    const scrubT0 = performance.now();
    let matchedBlocks = 0;
    for (let i = 0; i < 1000; i++) {
      const sampleSec = (i / 1000) * tl.totalEditedDurationSec;
      const res = resolveEditedPlayheadToSource(largeState, tl, sampleSec);
      if (res.activeBlockId) matchedBlocks++;
    }
    const scrubMs = performance.now() - scrubT0;
    expect(matchedBlocks).toBeGreaterThan(700);
    expect(scrubMs).toBeLessThan(350);
  });

  it('parses 5ms WENV bipolar binary envelopes, preserves loudness ratios, and keeps 25ms inter-character gaps intact', () => {
    const numBins = 200; // 1.0s @ 5ms/bin
    const buf = new ArrayBuffer(16 + numBins * 6);
    const dv = new DataView(buf);
    dv.setUint8(0, 0x57); // 'W'
    dv.setUint8(1, 0x45); // 'E'
    dv.setUint8(2, 0x4e); // 'N'
    dv.setUint8(3, 0x56); // 'V'
    dv.setUint32(4, 1, true);
    dv.setUint32(8, 5, true);
    dv.setUint32(12, numBins, true);

    const setBin = (i: number, pos: number, neg: number, rms: number) => {
      const off = 16 + i * 6;
      dv.setUint16(off, Math.round(pos * 65535), true);
      dv.setUint16(off + 2, Math.round(neg * 65535), true);
      dv.setUint16(off + 4, Math.round(rms * 65535), true);
    };

    for (let i = 0; i < numBins; i++) {
      setBin(i, 0.006, 0.0055, 0.003); // room noise floor
    }
    for (let i = 20; i <= 49; i++) {
      setBin(i, 0.64, 0.58, 0.36); // loud vowel [100..250ms]
    }
    // Bins 50..54 [250..275ms]: explicit 25ms inter-character gap left at room noise floor
    for (let i = 55; i <= 84; i++) {
      setBin(i, 0.28, 0.25, 0.14); // medium syllable [275..425ms]
    }
    for (let i = 100; i <= 139; i++) {
      setBin(i, 0.09, 0.08, 0.045); // quiet trailing syllable [500..700ms]
    }

    const env = parseWaveformEnvelopeBinary(buf);
    expect(env).not.toBeNull();
    expect(env!.binMs).toBe(5);
    expect(env!.numBins).toBe(200);
    expect(env!.durationMs).toBe(1000);
    expect(env!.noiseFloorPeak).toBeLessThan(0.015);
    expect(env!.p992Peak).toBeGreaterThanOrEqual(0.6);

    const ceiling = computeSharedReferenceCeiling([
      { p992Peak: env!.p992Peak, gainLinear: 1.0 },
    ]);

    const loud = sampleCalibratedWaveformPoint(
      env!,
      [],
      35 / 199,
      0.002,
      1.0,
      env!,
      ceiling
    );
    const medium = sampleCalibratedWaveformPoint(
      env!,
      [],
      70 / 199,
      0.002,
      1.0,
      env!,
      ceiling
    );
    const quiet = sampleCalibratedWaveformPoint(
      env!,
      [],
      120 / 199,
      0.002,
      1.0,
      env!,
      ceiling
    );

    // 1. Dynamic loudness proportionality: loud vs medium vs quiet stay visually distinct
    expect(loud.posPeak).toBeGreaterThan(medium.posPeak * 1.9);
    expect(medium.posPeak).toBeGreaterThan(quiet.posPeak * 2.4);
    expect(loud.rms).toBeGreaterThan(medium.rms * 2.0);
    expect(medium.rms).toBeGreaterThan(quiet.rms * 2.5);

    // Loudness alignment linear gain boost (+6dB ~= 2.0x) raises quieter tracks accurately
    const unalignedGain = computeTrackLinearGain(6, false);
    const alignedGain = computeTrackLinearGain(6, true);
    expect(unalignedGain).toBe(1.0);
    expect(alignedGain).toBeCloseTo(Math.pow(10, 6 / 20), 4);
    const mediumBoosted = sampleCalibratedWaveformPoint(
      env!,
      [],
      70 / 199,
      0.002,
      alignedGain,
      env!,
      ceiling
    );
    expect(mediumBoosted.posPeak).toBeGreaterThan(medium.posPeak * 1.85);

    // 2. Zero morphological dilation across the 25ms gap at character & sentence zoom
    const gapChar = sampleCalibratedWaveformPoint(
      env!,
      [],
      52 / 199,
      0.001,
      1.0,
      env!,
      ceiling
    );
    const gapSentence = sampleCalibratedWaveformPoint(
      env!,
      [],
      52 / 199,
      0.01,
      1.0,
      env!,
      ceiling
    );
    expect(gapChar.posPeak).toBeLessThan(0.015);
    expect(gapChar.negPeak).toBeLessThan(0.015);
    expect(gapSentence.posPeak).toBeLessThan(0.015);
    expect(gapSentence.negPeak).toBeLessThan(0.015);
  });

  it('keeps 50x-100x in phrase mode, activates word-annotated timeline above 100x, preserves inter-word gaps, and subdivides multi-char words at deeper zoom', () => {
    // 1. Threshold check aligned with UI readout Rounding (> 100x, i.e. >= 101x)
    expect(isWordTimelineZoom(1)).toBe(false);
    expect(isWordTimelineZoom(50)).toBe(false);
    expect(isWordTimelineZoom(99.6)).toBe(false);
    expect(isWordTimelineZoom(100)).toBe(false);
    expect(isWordTimelineZoom(100.4)).toBe(false);
    expect(isWordTimelineZoom(100.6)).toBe(true);
    expect(isWordTimelineZoom(101)).toBe(true);
    expect(isWordTimelineZoom(250)).toBe(true);
    expect(isWordTimelineZoom(2400)).toBe(true);

    // 2. Lexical splitter & bracketed placeholder protection
    expect(splitLexicalUnits('今天，PodCraft 2.0!')).toEqual([
      '今',
      '天，',
      'PodCraft',
      '2.0!',
    ]);
    expect(splitLexicalUnits('[音轨片段 00:00.8–00:02.0]')).toEqual([
      '[音轨片段 00:00.8–00:02.0]',
    ]);

    const state = createTestFixtureState();
    state.coldOpenEnabled = true;
    state.highlights = [
      {
        id: 'hl_word_1',
        speakerId: 'sp_host',
        speakerName: '主播',
        text: '今天播',
        sourceStartMs: 0,
        sourceEndMs: 500,
        durationSec: 1.5,
        selectionSource: 'manual_pick',
      },
    ];
    state.blocks = [
      {
        blockId: 'blk_word_timeline',
        speakerId: 'sp_host',
        chapterTitle: '测试字词时间轴',
        tokens: [
          {
            id: 'wt_1',
            type: 'word',
            text: '今天',
            sourceStartMs: 0,
            sourceEndMs: 300,
            durationSec: 0.3,
            origDurationSec: 0.3,
          },
          {
            id: 'wt_2',
            type: 'word',
            text: '播',
            sourceStartMs: 335,
            sourceEndMs: 500,
            durationSec: 0.165,
            origDurationSec: 0.165,
          },
          {
            id: 'wt_3',
            type: 'word',
            text: '客',
            sourceStartMs: 620,
            sourceEndMs: 800,
            durationSec: 0.18,
            origDurationSec: 0.18,
          },
          {
            id: 'wt_placeholder',
            type: 'word',
            text: '[音轨片段 00:00.8–00:02.0]',
            sourceStartMs: 800,
            sourceEndMs: 2000,
            durationSec: 1.2,
            origDurationSec: 1.2,
          },
          {
            id: 'wt_deleted',
            type: 'word',
            text: '删掉',
            sourceStartMs: 2000,
            sourceEndMs: 2400,
            durationSec: 0.4,
            origDurationSec: 0.4,
            deleted: true,
          },
          {
            id: 'wt_sil',
            type: 'silence',
            text: '',
            sourceStartMs: 2400,
            sourceEndMs: 3200,
            durationSec: 0.8,
            origDurationSec: 0.8,
          },
          {
            id: 'wt_muted',
            type: 'word',
            text: '静音词',
            sourceStartMs: 3200,
            sourceEndMs: 3500,
            durationSec: 0.3,
            origDurationSec: 0.3,
            trackMuted: true,
          },
        ],
      },
    ];

    const timeline = computeEditedTimeline(state);

    // 3. Moderate 100x density (~13px/char): keeps 2-char word "今天" intact, skips deleted/silence/muted, preserves 35ms & 120ms gaps, never splits placeholder
    const bodyModerate = buildVisibleWordTimelineAnnotations(timeline, {
      viewStartSec: 5.45,
      viewEndSec: 7.6,
      viewportWidthPx: 200,
      totalSec: timeline.totalEditedDurationSec,
      coldOpenEnabled: state.coldOpenEnabled,
      highlights: state.highlights,
      blocks: state.blocks,
    });
    expect(bodyModerate.map((a) => a.text)).toEqual([
      '今天',
      '播',
      '客',
      '[音轨片段 00:00.8–00:02.0]',
    ]);
    expect(bodyModerate[0].isSubCharSplit).toBe(false);
    expect(bodyModerate[0].editedStartSec).toBeCloseTo(5.5, 3);
    expect(bodyModerate[0].editedEndSec).toBeCloseTo(5.8, 3);
    expect(bodyModerate[1].editedStartSec - bodyModerate[0].editedEndSec).toBeCloseTo(0.035, 3);
    expect(bodyModerate[2].editedStartSec - bodyModerate[1].editedEndSec).toBeCloseTo(0.12, 3);

    // 4. Deep zoom (>=20px/char): proportionally subdivides "今天" into "今" + "天" with isSubCharSplit=true on second char
    const bodyDeep = buildVisibleWordTimelineAnnotations(timeline, {
      viewStartSec: 5.45,
      viewEndSec: 6.35,
      viewportWidthPx: 900,
      totalSec: timeline.totalEditedDurationSec,
      coldOpenEnabled: state.coldOpenEnabled,
      highlights: state.highlights,
      blocks: state.blocks,
    });
    expect(bodyDeep.map((a) => a.text)).toEqual([
      '今',
      '天',
      '播',
      '客',
      '[音轨片段 00:00.8–00:02.0]',
    ]);
    expect(bodyDeep[0].isSubCharSplit).toBe(false);
    expect(bodyDeep[1].isSubCharSplit).toBe(true);
    expect(bodyDeep[0].editedStartSec).toBeCloseTo(5.5, 3);
    expect(bodyDeep[0].editedEndSec).toBeCloseTo(5.65, 3);
    expect(bodyDeep[1].editedStartSec).toBeCloseTo(5.65, 3);
    expect(bodyDeep[1].editedEndSec).toBeCloseTo(5.8, 3);

    // 5. Cold Open highlight lexical mapping into [2.0s .. 3.5s]
    const coldOnly = buildVisibleWordTimelineAnnotations(timeline, {
      viewStartSec: 1.95,
      viewEndSec: 3.55,
      viewportWidthPx: 900,
      totalSec: timeline.totalEditedDurationSec,
      coldOpenEnabled: state.coldOpenEnabled,
      highlights: state.highlights,
      blocks: state.blocks,
    });
    expect(coldOnly.map((a) => a.text)).toEqual(['今', '天', '播']);
    expect(coldOnly[0].editedStartSec).toBeCloseTo(2.0, 3);
    expect(coldOnly[1].editedEndSec).toBeCloseTo(2.9, 3);
    expect(coldOnly[2].editedStartSec).toBeCloseTo(3.005, 3);
    expect(coldOnly[2].editedEndSec).toBeCloseTo(3.5, 3);
  });

  it('mutes hovered single-track range without affecting other tracks and ripple-deletes all tracks with exact forward snapping', () => {
    const state = createEmptyProjectState();
    state.tracks = [
      {
        id: 'sp_host',
        name: '主播 A',
        role: 'host',
        roleLabel: '主播',
        color: '#3b82f6',
        peaks: [],
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 0,
        muted: false,
        solo: false,
        durationMs: 2600,
      },
      {
        id: 'sp_guest',
        name: '嘉宾 B',
        role: 'guest',
        roleLabel: '嘉宾',
        color: '#ec4899',
        peaks: [],
        rawLufs: -18,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 0,
        muted: false,
        solo: false,
        durationMs: 2600,
      },
    ];
    state.blocks = [
      {
        blockId: 'blk_mix',
        speakerId: 'sp_host',
        chapterTitle: '章节 1',
        tokens: [
          {
            id: 't1',
            text: '今天',
            type: 'word',
            sourceStartMs: 0,
            sourceEndMs: 400,
            durationSec: 0.4,
            origDurationSec: 0.4,
          },
          // 300ms un-tokenized inter-word gap [400ms..700ms]
          {
            id: 't2',
            text: '播客',
            type: 'word',
            sourceStartMs: 700,
            sourceEndMs: 1200,
            durationSec: 0.5,
            origDurationSec: 0.5,
          },
          // contiguous word for leading-edge trim test
          {
            id: 't3',
            text: '节目',
            type: 'word',
            sourceStartMs: 1200,
            sourceEndMs: 1700,
            durationSec: 0.5,
            origDurationSec: 0.5,
          },
          // long word for interior split test
          {
            id: 't4',
            text: '特别精彩内容',
            type: 'word',
            sourceStartMs: 1700,
            sourceEndMs: 2600,
            durationSec: 0.9,
            origDurationSec: 0.9,
          },
        ],
      },
    ];

    // 1. Delete on hovered Guest track over [1.30s .. 1.65s] while Host is speaking:
    // keeps total duration 2.60s and only records TrackMuteRange on sp_guest
    const muteRes = applyTrackMuteSelectionToProject(state, 1.3, 1.65, 'sp_guest');
    expect(muteRes.addedRanges).toHaveLength(1);
    expect(muteRes.addedRanges[0].trackId).toBe('sp_guest');
    expect(muteRes.addedRanges[0].sourceStartMs).toBe(1300);
    expect(muteRes.addedRanges[0].sourceEndMs).toBe(1650);
    expect(muteRes.mutedDurationSec).toBeCloseTo(0.35, 3);
    expect(computeEditedTimeline(muteRes.nextState).totalEditedDurationSec).toBeCloseTo(2.6, 2);
    expect(muteRes.nextState.blocks[0].tokens.some((t) => Boolean(t.trackMuted))).toBe(false);

    // .podcraft save/load roundtrip preserves trackMuteRanges
    const reloaded = parsePodcraftProjectJson(serializeProjectToPodcraftJson(muteRes.nextState));
    expect(reloaded.trackMuteRanges).toEqual(muteRes.nextState.trackMuteRanges);

    // 2. Cmd+Shift+Delete [0.45s .. 0.65s] (0.200s inside un-tokenized gap [0.40 .. 0.70]):
    const cutGapOutcome = applyWaveformSelectionToBlocks(
      muteRes.nextState,
      0.45,
      0.65,
      'ripple_all'
    );
    const afterGapState = { ...muteRes.nextState, blocks: cutGapOutcome.nextBlocks };
    const tlAfterGap = computeEditedTimeline(afterGapState);
    expect(tlAfterGap.totalEditedDurationSec).toBeCloseTo(2.4, 2);
    const t2AfterGap = tlAfterGap.mappedTokens.find((m) => m.tokenId === 't2');
    expect(t2AfterGap?.token.gapBeforeSec).toBeCloseTo(0.1, 3);
    expect(t2AfterGap?.editedStartSec).toBeCloseTo(0.5, 3);
    expect(t2AfterGap?.editedEndSec).toBeCloseTo(1.0, 3);

    const edlAfterGap = buildEdlKeepSegments(afterGapState);
    const edlDurMs = edlAfterGap.reduce((acc, s) => acc + (s.sourceEndMs - s.sourceStartMs), 0);
    expect(edlDurMs).toBe(2400);

    // Upstream 0.20s ripple delete shifts Guest's [1300..1650ms] mute range forward by 0.20s on edited timeline!
    const projectedMute = projectSourceRangesMsToEditedRatios(
      tlAfterGap,
      afterGapState.trackMuteRanges ?? []
    );
    expect(projectedMute).toHaveLength(1);
    expect(projectedMute[0].startRatio * tlAfterGap.totalEditedDurationSec).toBeCloseTo(1.1, 3);
    expect(projectedMute[0].endRatio * tlAfterGap.totalEditedDurationSec).toBeCloseTo(1.45, 3);

    // 3. Leading-edge trim [1.00s .. 1.12s] on t3 (now at [1.00s .. 1.50s]): must snap t3 & t4 forward by 0.120s
    const leadTrimOutcome = applyWaveformSelectionToBlocks(
      afterGapState,
      1.0,
      1.12,
      'ripple_all'
    );
    const afterLeadState = { ...afterGapState, blocks: leadTrimOutcome.nextBlocks };
    const tlAfterLead = computeEditedTimeline(afterLeadState);
    expect(tlAfterLead.totalEditedDurationSec).toBeCloseTo(2.28, 2);
    const t3AfterLead = tlAfterLead.mappedTokens.find((m) => m.tokenId === 't3');
    expect(t3AfterLead?.token.sourceStartMs).toBe(1320);
    expect(t3AfterLead?.token.gapBeforeSec).toBe(0);
    expect(t3AfterLead?.editedStartSec).toBeCloseTo(1.0, 3);
    expect(t3AfterLead?.editedEndSec).toBeCloseTo(1.38, 3);

    // 4. Interior split [1.55s .. 1.85s] inside t4 (currently [1.38s .. 2.28s], 0.17s left & 0.43s right)
    const interiorOutcome = applyWaveformSelectionToBlocks(
      afterLeadState,
      1.55,
      1.85,
      'ripple_all'
    );
    const afterInteriorState = { ...afterLeadState, blocks: interiorOutcome.nextBlocks };
    const tlAfterInterior = computeEditedTimeline(afterInteriorState);
    expect(tlAfterInterior.totalEditedDurationSec).toBeCloseTo(1.98, 2);
    const t4Left = tlAfterInterior.mappedTokens.find((m) => m.tokenId === 't4');
    const t4Right = tlAfterInterior.mappedTokens.find((m) => m.tokenId.startsWith('t4__tail_'));
    expect(t4Left?.editedStartSec).toBeCloseTo(1.38, 3);
    expect(t4Left?.editedEndSec).toBeCloseTo(1.55, 3);
    expect(t4Right?.editedStartSec).toBeCloseTo(1.55, 3);
    expect(t4Right?.editedEndSec).toBeCloseTo(1.98, 3);
  });

  it('supports snap mode (snapping to word gaps) and free mode (strict exact-range deletion without valley snap or 55% expansion)', () => {
    const state = createEmptyProjectState();
    state.tracks = [
      {
        id: 'sp_1',
        name: '主播',
        role: 'host',
        roleLabel: '主播',
        color: '#3b82f6',
        durationMs: 3000,
        // Deliberately place a low-energy valley at 0.72s to verify free mode does NOT snap to it
        peaks: Array.from({ length: 60 }, (_, i) => (i === 14 ? 0.02 : 0.8)),
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 0,
        muted: false,
        solo: false,
      },
    ];
    state.blocks = [
      {
        blockId: 'blk_1',
        speakerId: 'sp_1',
        chapterTitle: '测试',
        tokens: [
          {
            id: 'w1',
            type: 'word',
            text: '第一句',
            durationSec: 1.0,
            origDurationSec: 1.0,
            sourceStartMs: 0,
            sourceEndMs: 1000,
          },
          {
            id: 'w2',
            type: 'word',
            text: '第二句',
            durationSec: 0.8,
            origDurationSec: 0.8,
            sourceStartMs: 1100,
            sourceEndMs: 1900,
            gapBeforeSec: 0.1,
          },
        ],
      },
    ];

    const tl = computeEditedTimeline(state);
    expect(tl.totalEditedDurationSec).toBeCloseTo(1.9, 3);

    // 1. Snap mode: word-gap snap points include 0, 1.05 (midpoint of [1.0, 1.1] gap), 1.9
    const snapPoints = computeWordGapSnapPointsSec(tl);
    expect(snapPoints).toEqual([0, 1.05, 1.9]);

    // Dragging inside w1 [0.22s .. 0.35s] expands to enclosing word-gap interval [0, 1.05]
    const [snapStart1, snapEnd1] = snapRangeToWordGaps(0.22, 0.35, snapPoints, 0.02);
    expect(snapStart1).toBeCloseTo(0, 3);
    expect(snapEnd1).toBeCloseTo(1.05, 3);

    // Dragging across w1..w2 [0.15s .. 1.75s] snaps to [0, 1.9]
    const [snapStart2, snapEnd2] = snapRangeToWordGaps(0.15, 1.75, snapPoints, 0.02);
    expect(snapStart2).toBeCloseTo(0, 3);
    expect(snapEnd2).toBeCloseTo(1.9, 3);

    // 2. Free mode: cutting 70% [0.000s .. 0.700s] of w1 (1.0s) strictly deletes 0.700s,
    // leaving 0.300s (NOT deleting the whole token via 55% threshold, and NOT snapping to 0.72s valley)
    const freeLeadOutcome = applyWaveformSelectionToBlocks(
      state,
      0.0,
      0.7,
      'ripple_all',
      undefined,
      { mode: 'free' }
    );
    const afterFreeLead = { ...state, blocks: freeLeadOutcome.nextBlocks };
    const tlFreeLead = computeEditedTimeline(afterFreeLead);
    expect(tlFreeLead.totalEditedDurationSec).toBeCloseTo(1.2, 3);
    const w1Free = tlFreeLead.mappedTokens.find((m) => m.tokenId === 'w1');
    expect(w1Free).toBeDefined();
    expect(w1Free?.token.deleted).toBeFalsy();
    expect(w1Free?.token.sourceStartMs).toBe(700);
    expect(w1Free?.token.durationSec).toBeCloseTo(0.3, 3);

    // 3. Snap mode: cutting 70% [0.000s .. 0.700s] of w1 deletes the entire w1 token
    const snapLeadOutcome = applyWaveformSelectionToBlocks(
      state,
      0.0,
      0.7,
      'ripple_all',
      undefined,
      { mode: 'snap' }
    );
    const w1Snap = snapLeadOutcome.nextBlocks[0].tokens.find((t) => t.id === 'w1');
    expect(w1Snap?.deleted).toBe(true);

    // 4. Free mode: interior cut [0.200s .. 0.800s] inside w1 splits at exact 200ms and 800ms
    const freeMidOutcome = applyWaveformSelectionToBlocks(
      state,
      0.2,
      0.8,
      'ripple_all',
      undefined,
      { mode: 'free' }
    );
    const tlFreeMid = computeEditedTimeline({ ...state, blocks: freeMidOutcome.nextBlocks });
    expect(tlFreeMid.totalEditedDurationSec).toBeCloseTo(1.3, 3);
    const w1Left = tlFreeMid.mappedTokens.find((m) => m.tokenId === 'w1');
    const w1Right = tlFreeMid.mappedTokens.find((m) => m.tokenId.startsWith('w1__tail_'));
    expect(w1Left?.token.sourceStartMs).toBe(0);
    expect(w1Left?.token.sourceEndMs).toBe(200);
    expect(w1Right?.token.sourceStartMs).toBe(800);
    expect(w1Right?.token.sourceEndMs).toBe(1000);
  });

  it('jumps chunk-by-chunk instead of continuously scrolling during playback to prevent visual fatigue', () => {
    const totalSec = 100;
    const zoom = 10; // span = 0.1 (10s window)

    // 1. At 1x overview zoom, always returns 0
    expect(
      computeAutoScrollViewStartRatio({
        playheadSec: 50,
        totalSec,
        zoom: 1,
        currentViewStartRatio: 0,
        isPlaying: true,
      })
    ).toBe(0);

    // 2. Playing inside current viewport (e.g. 2s, 5s, 8.5s in [0s, 10s] window) stays completely steady (0), NOT continuously scrolling
    expect(
      computeAutoScrollViewStartRatio({
        playheadSec: 2.0,
        totalSec,
        zoom,
        currentViewStartRatio: 0,
        isPlaying: true,
        viewportWidthPx: 1200,
      })
    ).toBe(0);

    expect(
      computeAutoScrollViewStartRatio({
        playheadSec: 5.0,
        totalSec,
        zoom,
        currentViewStartRatio: 0,
        isPlaying: true,
        viewportWidthPx: 1200,
      })
    ).toBe(0);

    expect(
      computeAutoScrollViewStartRatio({
        playheadSec: 8.5,
        totalSec,
        zoom,
        currentViewStartRatio: 0,
        isPlaying: true,
        viewportWidthPx: 1200,
      })
    ).toBe(0);

    // 3. When playhead reaches/exceeds right trigger threshold (>= 90% of window, e.g. 9.1s in [0s, 10s]), jumps chunk forward
    const chunkJump = computeAutoScrollViewStartRatio({
      playheadSec: 9.1,
      totalSec,
      zoom,
      currentViewStartRatio: 0,
      isPlaying: true,
      viewportWidthPx: 1200,
    });
    expect(chunkJump).toBeGreaterThan(0);
    // After jump, playhead lands near the comfortable left landing anchor (12%)
    expect((9.1 / totalSec - chunkJump) * zoom).toBeCloseTo(PAGE_SCROLL_LANDING_ANCHOR, 2);

    // 4. In a mid-timeline viewport [40s, 50s] (curStart = 0.40):
    // Playhead moving at 42s, 45s, 48s keeps viewport perfectly static at 0.40
    expect(
      computeAutoScrollViewStartRatio({
        playheadSec: 42.0,
        totalSec,
        zoom,
        currentViewStartRatio: 0.4,
        isPlaying: true,
        viewportWidthPx: 1200,
      })
    ).toBe(0.4);

    expect(
      computeAutoScrollViewStartRatio({
        playheadSec: 48.0,
        totalSec,
        zoom,
        currentViewStartRatio: 0.4,
        isPlaying: true,
        viewportWidthPx: 1200,
      })
    ).toBe(0.4);

    // When hitting >= 49.0s (90%), it jumps to the next chunk
    const jumpFromMid = computeAutoScrollViewStartRatio({
      playheadSec: 49.2,
      totalSec,
      zoom,
      currentViewStartRatio: 0.4,
      isPlaying: true,
      viewportWidthPx: 1200,
    });
    expect(jumpFromMid).toBeGreaterThan(0.4);
    expect((49.2 / totalSec - jumpFromMid) * zoom).toBeCloseTo(PAGE_SCROLL_LANDING_ANCHOR, 2);

    // 5. Clamps cleanly at 1 - span (0.9) near the end of timeline
    const nearEnd = computeAutoScrollViewStartRatio({
      playheadSec: 98.0,
      totalSec,
      zoom,
      currentViewStartRatio: 0.85,
      isPlaying: true,
      viewportWidthPx: 1200,
    });
    expect(nearEnd).toBeCloseTo(0.9, 6);

    // 6. When paused, keeps viewport steady inside safe zone and jumps to landing anchor if jumping off-screen
    expect(
      computeAutoScrollViewStartRatio({
        playheadSec: 45.0,
        totalSec,
        zoom,
        currentViewStartRatio: 0.4,
        isPlaying: false,
      })
    ).toBe(0.4);

    const jumpedOffscreen = computeAutoScrollViewStartRatio({
      playheadSec: 75.0,
      totalSec,
      zoom,
      currentViewStartRatio: 0.4,
      isPlaying: false,
    });
    expect((75.0 / totalSec - jumpedOffscreen) * zoom).toBeCloseTo(PAGE_SCROLL_LANDING_ANCHOR, 2);

    // 7. Supports continuous mode when explicitly requested
    const continuousResult = computeAutoScrollViewStartRatio({
      playheadSec: 5.0,
      totalSec,
      zoom,
      currentViewStartRatio: 0,
      isPlaying: true,
      mode: 'continuous',
    });
    expect((5.0 / totalSec - continuousResult) * zoom).toBeCloseTo(PLAYHEAD_AUTO_SCROLL_ANCHOR, 2);
  });

  it('keeps playhead anchored on original source content after deleting or undoing earlier/later tokens', () => {
    const state = createEmptyProjectState();
    state.tracks = [
      {
        id: 'sp_1',
        name: '主播',
        role: 'host',
        roleLabel: '主播',
        color: '#3b82f6',
        durationMs: 4000,
        peaks: [],
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 0,
        muted: false,
        solo: false,
      },
    ];
    state.blocks = [
      {
        blockId: 'blk_1',
        speakerId: 'sp_1',
        chapterTitle: '测试',
        tokens: [
          {
            id: 't1',
            type: 'word',
            text: '第一段',
            durationSec: 1.0,
            origDurationSec: 1.0,
            sourceStartMs: 0,
            sourceEndMs: 1000,
          },
          {
            id: 't2',
            type: 'word',
            text: '第二段',
            durationSec: 1.5,
            origDurationSec: 1.5,
            sourceStartMs: 1000,
            sourceEndMs: 2500,
          },
          {
            id: 't3',
            type: 'word',
            text: '第三段',
            durationSec: 1.5,
            origDurationSec: 1.5,
            sourceStartMs: 2500,
            sourceEndMs: 4000,
          },
        ],
      },
    ];

    const prevTl = computeEditedTimeline(state);
    expect(prevTl.totalEditedDurationSec).toBeCloseTo(4.0, 3);

    // Playhead at 3.2s (0.7s into t3, sourceSec = 3.2s).
    // Delete t2 (1.5s before playhead) -> t3 now starts at 1.0s, so 0.7s into t3 is 1.7s!
    const deletedT2 = {
      ...state,
      blocks: [
        {
          ...state.blocks[0],
          tokens: state.blocks[0].tokens.map((t) =>
            t.id === 't2' ? { ...t, deleted: true } : t
          ),
        },
      ],
    };
    const nextTlT2 = computeEditedTimeline(deletedT2);
    expect(nextTlT2.totalEditedDurationSec).toBeCloseTo(2.5, 3);
    expect(remapPlayheadAfterTimelineEdit(prevTl, nextTlT2, 3.2)).toBeCloseTo(1.7, 3);

    // Undo (restore t2 from nextTlT2 back to prevTl): 1.7s -> 3.2s!
    expect(remapPlayheadAfterTimelineEdit(nextTlT2, prevTl, 1.7)).toBeCloseTo(3.2, 3);

    // Playhead at 0.4s (before deleted t2) -> stays at 0.4s
    expect(remapPlayheadAfterTimelineEdit(prevTl, nextTlT2, 0.4)).toBeCloseTo(0.4, 3);

    // Playhead at 1.8s (inside deleted t2) -> lands on cut seam 1.0s (start of t3)
    expect(remapPlayheadAfterTimelineEdit(prevTl, nextTlT2, 1.8)).toBeCloseTo(1.0, 3);
  });

  it('persists and restores playhead position (savedPlayheadSec) during project save and load roundtrips', () => {
    // 1. Clean empty project initializes with savedPlayheadSec = 0
    const empty = createEmptyProjectState();
    expect(empty.savedPlayheadSec).toBe(0);

    // 2. Custom playhead position is preserved in serialized JSON
    const testState = createTestFixtureState();
    const stateWithPlayhead: PodcastProjectState = {
      ...testState,
      savedPlayheadSec: 42.6789,
    };
    const serialized = serializeProjectToPodcraftJson(stateWithPlayhead, '/Users/test/cursor_test.podcraft');
    const envelope = JSON.parse(serialized);
    expect(envelope.project.savedPlayheadSec).toBe(42.679);

    // 3. Deserialization restores savedPlayheadSec
    const restored = parsePodcraftProjectJson(serialized, '/Users/test/cursor_test.podcraft');
    expect(restored.savedPlayheadSec).toBe(42.679);

    // 4. Legacy .podcraft JSON without savedPlayheadSec gracefully defaults to 0
    const legacyProject = {
      format: 'podcraft-project',
      version: '2.2',
      savedAt: '2026-01-01T00:00:00.000Z',
      project: {
        ...testState,
        savedPlayheadSec: undefined,
      },
    };
    const restoredLegacy = parsePodcraftProjectJson(JSON.stringify(legacyProject));
    expect(restoredLegacy.savedPlayheadSec).toBe(0);

    // 5. Negative or invalid savedPlayheadSec is clamped to 0
    const invalidPlayheadProject = {
      format: 'podcraft-project',
      version: '2.2',
      savedAt: '2026-01-01T00:00:00.000Z',
      project: {
        ...testState,
        savedPlayheadSec: -15.5,
      },
    };
    const restoredInvalid = parsePodcraftProjectJson(JSON.stringify(invalidPlayheadProject));
    expect(restoredInvalid.savedPlayheadSec).toBe(0);

    // 6. pauseCutJumpEnabled configuration round-trip and default fallback
    const emptyState = createEmptyProjectState();
    expect(emptyState.pauseCutJumpEnabled).toBe(true);

    const customPauseJumpState: PodcastProjectState = {
      ...testState,
      pauseCutJumpEnabled: false,
    };
    const jsonPaused = serializeProjectToPodcraftJson(customPauseJumpState);
    const restoredPaused = parsePodcraftProjectJson(jsonPaused);
    expect(restoredPaused.pauseCutJumpEnabled).toBe(false);

    const legacyWithoutPauseJump = {
      format: 'podcraft-project',
      version: '2.2',
      savedAt: '2026-01-01T00:00:00.000Z',
      project: {
        ...testState,
        pauseCutJumpEnabled: undefined,
      },
    };
    const restoredFallback = parsePodcraftProjectJson(JSON.stringify(legacyWithoutPauseJump));
    expect(restoredFallback.pauseCutJumpEnabled).toBe(true);
  });

  it('refines token bounds using 5ms HiResWaveformEnvelope even when legacy peaks are coarse (>90ms/bin)', () => {
    const durationMs = 240_000; // 4 minutes -> 1200 peaks = 200ms/bin (>90ms limit for legacy peaks)
    const coarsePeaks = new Array(1200).fill(0.01);
    const binMs = 5;
    const numBins = durationMs / binMs;
    const triples = new Uint16Array(numBins * 3);
    // Background noise floor ~ 0.01
    for (let b = 0; b < numBins; b++) {
      triples[b * 3] = Math.round(0.01 * 65535);
      triples[b * 3 + 1] = Math.round(0.01 * 65535);
      triples[b * 3 + 2] = Math.round(0.006 * 65535);
    }
    // Real speech burst only during [1200ms, 1450ms] (bins 240..290)
    for (let b = 240; b < 290; b++) {
      triples[b * 3] = Math.round(0.52 * 65535);
      triples[b * 3 + 1] = Math.round(0.50 * 65535);
      triples[b * 3 + 2] = Math.round(0.32 * 65535);
    }

    const hiRes: HiResWaveformEnvelope = {
      binMs,
      numBins,
      durationMs,
      triples,
      noiseFloorPeak: 0.01,
      noiseFloorRms: 0.006,
      p95Peak: 0.52,
      p992Peak: 0.52,
    };

    const baseTrack = createTestFixtureState().tracks[0];
    const tracks: SpeakerTrack[] = [
      {
        ...baseTrack,
        id: 'sp_1',
        name: '主播',
        color: '#38bdf8',
        role: 'host',
        durationMs,
        peaks: coarsePeaks,
      },
    ];

    const rawBlocks: TranscriptBlock[] = [
      {
        blockId: 'blk_1',
        speakerId: 'sp_1',
        chapterTitle: '测试',
        tokens: [
          {
            id: 't_1',
            type: 'word',
            text: '你好',
            // Raw ASR timestamp has 180ms leading silence and 150ms trailing silence
            sourceStartMs: 1020,
            sourceEndMs: 1600,
            durationSec: 0.58,
            origDurationSec: 0.58,
          },
        ],
      },
    ];

    // Without hiRes, coarse peaks (>90ms/bin) cannot refine
    const withoutHiRes = refineProjectBlocksWithWaveform(rawBlocks, tracks, 'same_room_sync');
    expect(withoutHiRes[0].tokens[0].sourceStartMs).toBe(1020);
    expect(withoutHiRes[0].tokens[0].sourceEndMs).toBe(1600);

    // With hiRes, bounds snap tightly around [1200ms, 1450ms]
    const hiResMap = new Map<string, HiResWaveformEnvelope>([['sp_1', hiRes]]);
    const withHiRes = refineProjectBlocksWithWaveform(rawBlocks, tracks, 'same_room_sync', hiResMap);
    expect(withHiRes[0].tokens[0].sourceStartMs).toBeGreaterThanOrEqual(1170);
    expect(withHiRes[0].tokens[0].sourceStartMs).toBeLessThanOrEqual(1210);
    expect(withHiRes[0].tokens[0].sourceEndMs).toBeGreaterThanOrEqual(1440);
    expect(withHiRes[0].tokens[0].sourceEndMs).toBeLessThanOrEqual(1485);
  });

  it('subdivides multi-character tokens at acoustic valleys when HiResWaveformEnvelope is provided', () => {
    const durationMs = 2000;
    const binMs = 5;
    const numBins = durationMs / binMs;
    const triples = new Uint16Array(numBins * 3);
    for (let b = 0; b < numBins; b++) {
      triples[b * 3] = Math.round(0.01 * 65535);
      triples[b * 3 + 1] = Math.round(0.01 * 65535);
      triples[b * 3 + 2] = Math.round(0.005 * 65535);
    }
    // Token spans [0ms, 900ms] with 3 chars "大家好":
    // Char 1 ("大") strong at [0..180ms], valley at 195ms,
    // Char 2 ("家") strong at [210..560ms], valley at 585ms,
    // Char 3 ("好") strong at [600..900ms]
    const setActive = (startMs: number, endMs: number, amp = 0.55) => {
      for (let b = Math.floor(startMs / binMs); b < Math.floor(endMs / binMs); b++) {
        triples[b * 3] = Math.round(amp * 65535);
        triples[b * 3 + 1] = Math.round(amp * 65535);
        triples[b * 3 + 2] = Math.round(amp * 0.6 * 65535);
      }
    };
    setActive(0, 180);
    setActive(210, 560);
    setActive(600, 900);

    const hiRes: HiResWaveformEnvelope = {
      binMs,
      numBins,
      durationMs,
      triples,
      noiseFloorPeak: 0.01,
      noiseFloorRms: 0.005,
      p95Peak: 0.55,
      p992Peak: 0.55,
    };

    const state = createTestFixtureState();
    state.coldOpenEnabled = false;
    state.highlights = [];
    state.introVoiceover = undefined;
    state.tracks = [
      {
        ...state.tracks[0],
        id: 'sp_host',
        name: '主播',
        color: '#38bdf8',
        role: 'host',
        durationMs,
        peaks: new Array(40).fill(0.2),
      },
    ];
    state.blocks = [
      {
        blockId: 'blk_val',
        speakerId: 'sp_host',
        chapterTitle: '测试',
        tokens: [
          {
            id: 'tok_3char',
            type: 'word',
            text: '大家好',
            sourceStartMs: 0,
            sourceEndMs: 900,
            durationSec: 0.9,
            origDurationSec: 0.9,
          },
        ],
      },
    ];

    const tl = computeEditedTimeline(state);
    const anns = buildVisibleWordTimelineAnnotations(tl, {
      viewStartSec: 0,
      viewEndSec: 1.0,
      viewportWidthPx: 1000,
      totalSec: tl.totalEditedDurationSec,
      tracks: state.tracks,
      hiResEnvelopes: new Map([['sp_host', hiRes]]),
      recordingMode: 'same_room_sync',
    });

    expect(anns.map((a) => a.text)).toEqual(['大', '家', '好']);
    // Uniform split would be 0.30s and 0.60s; acoustic valleys are around ~0.195s and ~0.585s
    expect(anns[0].editedEndSec).toBeLessThan(0.23);
    expect(anns[1].editedStartSec).toBeLessThan(0.23);
    expect(anns[1].editedEndSec).toBeGreaterThanOrEqual(0.56);
    expect(anns[1].editedEndSec).toBeLessThanOrEqual(0.60);
  });

  it('never replays overlapped or cut source audio when trimming an overlapped token or leading gap', () => {
    const state = createTestFixtureState();
    state.coldOpenEnabled = false;
    state.highlights = [];
    state.introVoiceover = undefined;
    state.blocks = [
      {
        blockId: 'b_ov_1',
        speakerId: 'host',
        chapterTitle: '测试',
        tokens: [
          {
            id: 't_host',
            type: 'word',
            text: '主持人',
            sourceStartMs: 0,
            sourceEndMs: 5000,
            durationSec: 5.0,
            origDurationSec: 5.0,
          },
        ],
      },
      {
        blockId: 'b_ov_2',
        speakerId: 'guest',
        chapterTitle: '测试',
        tokens: [
          {
            id: 't_guest',
            type: 'word',
            text: '嘉宾接话',
            sourceStartMs: 2000,
            sourceEndMs: 6000,
            durationSec: 4.0,
            origDurationSec: 4.0,
          },
        ],
      },
    ];

    // Before cut: t_host [0..5s], t_guest visible edited [5..6s] (source [5..6s])
    const cutRes = applyWaveformSelectionToBlocks(state, 4.5, 5.5, 'ripple_all', undefined, {
      mode: 'free',
    });
    const nextState: PodcastProjectState = { ...state, blocks: cutRes.nextBlocks };
    const nextTl = computeEditedTimeline(nextState);

    // Total edited duration must be 5.0s (4.5s + 0.5s), NEVER 8.0s (replaying 2.5..5.5s)!
    expect(nextTl.totalEditedDurationSec).toBeCloseTo(5.0, 2);
    expect(nextTl.playbackSpans).toHaveLength(2);
    expect(nextTl.playbackSpans[0].sourceStartSec).toBeCloseTo(0, 2);
    expect(nextTl.playbackSpans[0].sourceEndSec).toBeCloseTo(4.5, 2);
    expect(nextTl.playbackSpans[1].sourceStartSec).toBeCloseTo(5.5, 2);
    expect(nextTl.playbackSpans[1].sourceEndSec).toBeCloseTo(6.0, 2);

    // Leading gap cut when first token is deleted and next token has gapBeforeSec
    const gapState = createTestFixtureState();
    gapState.coldOpenEnabled = false;
    gapState.highlights = [];
    gapState.introVoiceover = undefined;
    gapState.blocks = [
      {
        blockId: 'b_gap',
        speakerId: 'host',
        chapterTitle: '测试',
        tokens: [
          {
            id: 't_0',
            type: 'word',
            text: '第一句',
            sourceStartMs: 0,
            sourceEndMs: 1000,
            durationSec: 1.0,
            origDurationSec: 1.0,
          },
          {
            id: 't_1',
            type: 'word',
            text: '第二句',
            sourceStartMs: 1500,
            sourceEndMs: 2500,
            durationSec: 1.0,
            origDurationSec: 1.0,
            gapBeforeSec: 0.5,
          },
        ],
      },
    ];
    const gapCut = applyWaveformSelectionToBlocks(gapState, 0.0, 1.3, 'ripple_all', undefined, {
      mode: 'free',
    });
    const gapNextTl = computeEditedTimeline({ ...gapState, blocks: gapCut.nextBlocks });
    expect(gapNextTl.totalEditedDurationSec).toBeCloseTo(1.2, 2);
    expect(gapNextTl.playbackSpans[0].sourceStartSec).toBeCloseTo(1.3, 2);
    expect(gapNextTl.playbackSpans[0].sourceEndSec).toBeCloseTo(2.5, 2);
  });

  it('builds full-paragraph hint segments for <100x timeline band and resolves active/nearest segment by time', () => {
    const state = createEmptyProjectState();
    state.tracks = [
      {
        id: 'sp_host',
        name: '主持',
        role: 'host',
        roleLabel: '主播',
        color: '#38bdf8',
        durationMs: 10000,
        peaks: new Array(100).fill(0.5),
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 0,
        muted: false,
        solo: false,
      },
      {
        id: 'sp_guest',
        name: '嘉宾',
        role: 'guest',
        roleLabel: '嘉宾',
        color: '#a855f7',
        durationMs: 10000,
        peaks: new Array(100).fill(0.5),
        rawLufs: -16,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 0,
        muted: false,
        solo: false,
      },
    ];
    state.blocks = [
      {
        blockId: 'blk_1',
        speakerId: 'sp_host',
        chapterTitle: '开场',
        tokens: [
          {
            id: 'h1',
            type: 'word',
            text: '欢迎来到',
            durationSec: 1.0,
            origDurationSec: 1.0,
            sourceStartMs: 0,
            sourceEndMs: 1000,
          },
          {
            id: 'h2',
            type: 'word',
            text: '播客节目。',
            durationSec: 1.0,
            origDurationSec: 1.0,
            sourceStartMs: 1000,
            sourceEndMs: 2000,
          },
        ],
      },
      {
        blockId: 'blk_deleted',
        speakerId: 'sp_guest',
        chapterTitle: '开场',
        tokens: [
          {
            id: 'gd1',
            type: 'word',
            text: '被删掉的插话',
            durationSec: 0.5,
            origDurationSec: 0.5,
            sourceStartMs: 2000,
            sourceEndMs: 2500,
            deleted: true,
          },
        ],
      },
      {
        blockId: 'blk_2',
        speakerId: 'sp_host',
        chapterTitle: '开场',
        tokens: [
          {
            id: 'h3',
            type: 'word',
            text: '今天聊聊AI。',
            durationSec: 1.2,
            origDurationSec: 1.2,
            sourceStartMs: 2500,
            sourceEndMs: 3700,
          },
        ],
      },
      {
        blockId: 'blk_3',
        speakerId: 'sp_guest',
        chapterTitle: '正片',
        tokens: [
          {
            id: 'g1',
            type: 'word',
            text: '大家好',
            durationSec: 1.0,
            origDurationSec: 1.0,
            sourceStartMs: 4200,
            sourceEndMs: 5200,
            gapBeforeSec: 0.5,
          },
        ],
      },
    ];

    const tl = computeEditedTimeline(state);
    const segments = buildParagraphHintSegments(state.blocks, tl, state.tracks);
    expect(segments).toHaveLength(2);
    expect(segments[0].speakerName).toBe('主持');
    expect(segments[0].text).toBe('欢迎来到播客节目。今天聊聊AI。');
    expect(segments[0].startSec).toBeCloseTo(0, 2);
    expect(segments[0].endSec).toBeCloseTo(3.2, 2);

    expect(segments[1].speakerName).toBe('嘉宾');
    expect(segments[1].text).toBe('大家好');

    expect(findParagraphHintAtSec(segments, 1.5)?.segment.id).toBe(segments[0].id);
    expect(findParagraphHintAtSec(segments, 4.0)?.segment.id).toBe(segments[1].id);
    expect(findParagraphHintAtSec(segments, 12.0)).toBeNull();
  });
});
