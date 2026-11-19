import { describe, expect, it } from 'vitest';
import {
  createEmptyProjectState,
  parsePodcraftProjectJson,
  serializeProjectToPodcraftJson,
} from '../data/emptyProject';
import { hydrateSeparatedTracks, SidecarSeparatedTrackDto } from '../engine/tauriBridge';
import { buildTranscriptBlocksFromImportedTracks } from '../engine/transcriptBuilder';
import { computeEditedTimeline } from '../engine/timelineEngine';
import { buildLocalShownotes } from '../engine/shownotesGenerator';

describe('火山引擎豆包语音单文件分角色集成', () => {
  it('在 .podcraft 序列化时剥离火山引擎密钥，反序列化保留 volcengine_doubao 与 SSD 版本', () => {
    const state = createEmptyProjectState();
    state.asrConfig = {
      provider: 'volcengine_doubao',
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      model: '',
      fallbackToLocal: true,
      volcUsername: 'nemo',
      volcAccountId: '2134470279',
      volcAccessKeyId: 'AKLT_PUBLIC_ID_123',
      volcSecretAccessKey: 'SECRET_SHOULD_BE_STRIPPED',
      volcApiKey: 'API_KEY_SHOULD_BE_STRIPPED',
      volcAccessToken: 'TOKEN_SHOULD_BE_STRIPPED',
      volcSsdVersion: '300',
      enableSingleFileSpeakerSep: true,
    };

    const json = serializeProjectToPodcraftJson(state, '/tmp/volc_demo.podcraft');
    expect(json).not.toContain('SECRET_SHOULD_BE_STRIPPED');
    expect(json).not.toContain('API_KEY_SHOULD_BE_STRIPPED');
    expect(json).not.toContain('TOKEN_SHOULD_BE_STRIPPED');

    const restored = parsePodcraftProjectJson(json, '/tmp/volc_demo.podcraft', false);
    expect(restored.asrConfig.provider).toBe('volcengine_doubao');
    expect(restored.asrConfig.volcSsdVersion).toBe('300');
    expect(restored.asrConfig.volcUsername).toBe('nemo');
    expect(restored.asrConfig.volcAccountId).toBe('2134470279');
    expect(restored.asrConfig.volcSecretAccessKey).toBe('');
    expect(restored.asrConfig.volcApiKey).toBe('');
    expect(restored.asrConfig.volcAccessToken).toBe('');
  });

  it('将单文件分出的多角色独立音轨组装为交替对话流并同步 Shownotes 嘉宾列表', () => {
    const separatedDtos: SidecarSeparatedTrackDto[] = [
      {
        id: 'sp_1',
        speakerKey: '1',
        name: '主持人 (角色1)',
        role: 'host',
        roleLabel: '主持人 Host',
        color: '#3b82f6',
        filePath: '/tmp/podcraft_separated_stems/demo_sp_1.wav',
        durationMs: 6000,
        rawLufs: -18.2,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 500,
        peaks: Array.from({ length: 1200 }, (_, i) => (i < 400 ? 0.55 : 0.02)),
        detectedSegments: [
          { startMs: 100, endMs: 1900, isSilence: false },
          { startMs: 1900, endMs: 6000, isSilence: true },
        ],
      },
      {
        id: 'sp_2',
        speakerKey: '2',
        name: '嘉宾 1 (角色2)',
        role: 'guest',
        roleLabel: '飞行嘉宾 Guest',
        color: '#10b981',
        filePath: '/tmp/podcraft_separated_stems/demo_sp_2.wav',
        durationMs: 6000,
        rawLufs: -19.0,
        autoGainDb: 0,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 500,
        peaks: Array.from({ length: 1200 }, (_, i) => (i >= 500 && i < 900 ? 0.52 : 0.02)),
        detectedSegments: [
          { startMs: 0, endMs: 2200, isSilence: true },
          { startMs: 2200, endMs: 4200, isSilence: false },
        ],
      },
    ];

    const tracks = hydrateSeparatedTracks(separatedDtos);
    expect(tracks).toHaveLength(2);
    expect(tracks[0].audioUrl).toContain('/api/audio-stream');
    expect(tracks[1].audioUrl).toContain('demo_sp_2.wav');

    const sidecarTracks = {
      sp_1: {
        engine: 'volcengine_doubao',
        tokens: [
          { type: 'word' as const, text: '你好，', startMs: 150, endMs: 800 },
          { type: 'word' as const, text: '欢迎来到节目。', startMs: 820, endMs: 1850 },
        ],
      },
      sp_2: {
        engine: 'volcengine_doubao',
        tokens: [
          { type: 'word' as const, text: '谢谢邀请，', startMs: 2250, endMs: 3100 },
          { type: 'word' as const, text: '很高兴交流！', startMs: 3120, endMs: 4100 },
        ],
      },
    };

    const { blocks } = buildTranscriptBlocksFromImportedTracks(
      tracks,
      sidecarTracks,
      [],
      'same_room_sync'
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0].speakerId).toBe('sp_1');
    expect(blocks[1].speakerId).toBe('sp_2');

    const project = createEmptyProjectState();
    project.tracks = tracks;
    project.blocks = blocks;
    const timeline = computeEditedTimeline(project);
    const shownotes = buildLocalShownotes(project, timeline);

    expect(shownotes.guests).toHaveLength(2);
    expect(shownotes.guests[0].name).toBe('主持人 (角色1)');
    expect(shownotes.guests[1].name).toBe('嘉宾 1 (角色2)');
  });
});
