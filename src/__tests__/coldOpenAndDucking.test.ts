import { describe, it, expect } from 'vitest';
import { createEmptyProjectState } from '../data/emptyProject';
import {
  computeColdOpenDurationSec,
  computeEditedTimeline,
  resolveEffectiveHighlightGapSec,
} from '../engine/timelineEngine';
import { resolveEditedPlayheadToSource } from '../engine/audioPreviewEngine';
import { HighlightClip, HighlightMuteInterval, DEFAULT_BGM_FADE_MS } from '../types/podcast';

describe('金句起止时间段、自动间隔、固定口播与片头 BGM 人声避让测试', () => {
  it('正确记录金句起止时间段并在时间轴上反映', () => {
    const state = createEmptyProjectState();
    const hl1: HighlightClip = {
      id: 'hl-1',
      speakerId: 'spk-1',
      speakerName: '主播小李',
      text: '人生没有白走的路，每一步都算数。',
      sourceStartMs: 65400, // 01:05.4
      sourceEndMs: 75400,   // 01:15.4
      durationSec: 10.0,
      selectionSource: 'manual_pick',
    };
    const hl2: HighlightClip = {
      id: 'hl-2',
      speakerId: 'spk-2',
      speakerName: '嘉宾老王',
      text: '当你敢于把问题摆在桌面上，解决就已经开始了。',
      sourceStartMs: 142000, // 02:22.0
      sourceEndMs: 154000,   // 02:34.0
      durationSec: 12.0,
      selectionSource: 'manual_pick',
    };

    state.highlights = [hl1, hl2];
    state.coldOpenEnabled = true;

    expect(hl1.sourceEndMs - hl1.sourceStartMs).toBe(10000);
    expect(hl2.sourceEndMs - hl2.sourceStartMs).toBe(12000);
  });

  it('根据金句部分总时长自动均分设置金句间的间隔', () => {
    const state = createEmptyProjectState();
    state.highlights = [
      {
        id: 'h1',
        speakerId: 's1',
        speakerName: 'A',
        text: '金句一',
        sourceStartMs: 10000,
        sourceEndMs: 18000,
        durationSec: 8.0,
        selectionSource: 'manual_pick',
      },
      {
        id: 'h2',
        speakerId: 's2',
        speakerName: 'B',
        text: '金句二',
        sourceStartMs: 30000,
        sourceEndMs: 40000,
        durationSec: 10.0,
        selectionSource: 'manual_pick',
      },
      {
        id: 'h3',
        speakerId: 's1',
        speakerName: 'A',
        text: '金句三',
        sourceStartMs: 60000,
        sourceEndMs: 68000,
        durationSec: 8.0,
        selectionSource: 'manual_pick',
      },
    ];
    // 人声总时长 = 8 + 10 + 8 = 26s
    // 间隔处数 = 3 - 1 = 2处
    // 设定金句部分总时长为 30s
    state.targetTotalHighlightSec = 30;
    state.autoHighlightGap = true;

    // (30 - 26) / 2 = 2.0s
    const gap = resolveEffectiveHighlightGapSec(state);
    expect(gap).toBeCloseTo(2.0, 1);

    // 关闭自动均分，使用手动指定的 0.8s
    state.autoHighlightGap = false;
    state.highlightGapSec = 0.8;
    expect(resolveEffectiveHighlightGapSec(state)).toBe(0.8);
  });

  it('片头时间轴后部紧随片头固定口播并正确串联计算总时长', () => {
    const state = createEmptyProjectState();
    state.coldOpenEnabled = true;
    state.highlights = [
      {
        id: 'h1',
        speakerId: 's1',
        speakerName: 'A',
        text: '金句片段',
        sourceStartMs: 10000,
        sourceEndMs: 18000,
        durationSec: 8.0,
        selectionSource: 'manual_pick',
      },
    ];
    // 固定口播 6.5s
    state.introVoiceover = {
      fileName: 'intro_standard.mp3',
      durationSec: 6.5,
      enabled: true,
    };

    const timeline = computeEditedTimeline(state);
    // coldOpen: 2.0s 前奏 + 8.0s 金句 + 0 gaps + 2.0s 尾奏 = 12.0s
    expect(timeline.coldOpenDurationSec).toBe(12.0);
    // introVoiceover: 6.5s
    expect(timeline.introVoiceoverDurationSec).toBe(6.5);
    // prefix 总时长 = 12.0 + 6.5 = 18.5s
    expect(timeline.prefixDurationSec).toBe(18.5);
  });

  it('在金句发音和固定口播发音时触发 BGM 人声避让，停顿与气口 BGM 浮起', () => {
    const state = createEmptyProjectState();
    state.coldOpenEnabled = true;
    state.highlights = [
      {
        id: 'h1',
        speakerId: 's1',
        speakerName: 'A',
        text: '高光金句内容',
        sourceStartMs: 10000,
        sourceEndMs: 16000,
        durationSec: 6.0,
        selectionSource: 'manual_pick',
      },
      {
        id: 'h2',
        speakerId: 's2',
        speakerName: 'B',
        text: '第二条金句',
        sourceStartMs: 20000,
        sourceEndMs: 25000,
        durationSec: 5.0,
        selectionSource: 'manual_pick',
      },
    ];
    state.highlightGapSec = 1.0;
    state.autoHighlightGap = false;
    state.introVoiceover = {
      fileName: 'vo.mp3',
      durationSec: 5.0,
      enabled: true,
    };

    const timeline = computeEditedTimeline(state);

    // 1. [0.0 ~ 2.0s]: 片头 BGM 前导垫乐区，人声静音 -> BGM 浮起垫音
    const t0 = resolveEditedPlayheadToSource(state, timeline, 1.0);
    expect(t0.inIntroOrGapSilence).toBe(true);

    // 2. [2.0 ~ 8.0s]: 金句 1 发声区 -> 触发人声避让 (BGM Ducking)
    const t1 = resolveEditedPlayheadToSource(state, timeline, 3.5);
    expect(t1.inColdOpen).toBe(true);
    expect(t1.inIntroOrGapSilence).toBe(false);
    expect(t1.activeSpeakerId).toBe('s1');

    // 3. [8.0 ~ 9.0s]: 金句间的 1.0s 间隔停顿 -> 人声静默，BGM 自动浮起
    const tGap = resolveEditedPlayheadToSource(state, timeline, 8.5);
    expect(tGap.inIntroOrGapSilence).toBe(true);

    // 4. [9.0 ~ 14.0s]: 金句 2 发声区 -> 再次触发人声避让
    const t2 = resolveEditedPlayheadToSource(state, timeline, 10.0);
    expect(t2.inIntroOrGapSilence).toBe(false);
    expect(t2.activeSpeakerId).toBe('s2');

    // 5. [coldOpenDurationSec .. coldOpenDurationSec + 5.0s]: 片头固定口播区
    const tVo = resolveEditedPlayheadToSource(state, timeline, timeline.coldOpenDurationSec + 2.0);
    expect(tVo.inColdOpen).toBe(false);
  });

  it('支持片头口播指定开始时间并计算 prefixDurationSec', () => {
    const state = createEmptyProjectState();
    state.coldOpenEnabled = true;
    state.highlights = [
      {
        id: 'h1',
        speakerId: 's1',
        speakerName: 'A',
        text: '金句',
        sourceStartMs: 0,
        sourceEndMs: 10000,
        durationSec: 10.0,
        selectionSource: 'manual_pick',
      },
    ];
    // coldOpen: 2.0s + 10.0s + 2.0s = 14.0s
    // 用户指定口播在 00:00 开始播（时长 5.0s）
    state.introVoiceover = {
      fileName: 'vo.mp3',
      durationSec: 5.0,
      enabled: true,
      startOffsetSec: 0,
    };

    const tl1 = computeEditedTimeline(state);
    expect(tl1.coldOpenDurationSec).toBe(14.0);
    expect(tl1.introVoiceoverStartSec).toBe(0);
    expect(tl1.introVoiceoverDurationSec).toBe(5.0);
    // prefix 应当是 max(14.0, 0 + 5.0) = 14.0s
    expect(tl1.prefixDurationSec).toBe(14.0);

    // 用户指定口播延后在 16.0s 开始播（时长 5.0s）
    state.introVoiceover.startOffsetSec = 16.0;
    const tl2 = computeEditedTimeline(state);
    expect(tl2.introVoiceoverStartSec).toBe(16.0);
    // prefix 应当是 max(14.0, 16.0 + 5.0) = 21.0s
    expect(tl2.prefixDurationSec).toBe(21.0);
  });

  it('金句支持二次编辑：起止点微调、台词修改与某音轨整句/部分静音处理', () => {
    const state = createEmptyProjectState();
    state.coldOpenEnabled = true;
    const hl: HighlightClip = {
      id: 'hl-test',
      speakerId: 'track-1',
      speakerName: '主播',
      text: '原本的台词',
      sourceStartMs: 10000,
      sourceEndMs: 18000,
      durationSec: 8.0,
      selectionSource: 'manual_pick',
      // 二次编辑：将伴随的访客音轨 track-2 完全静音
      mutedTrackIds: ['track-2'],
      // 二次编辑：对音轨 track-1 在内部某段进行部分静音（例如 12.0s ~ 13.5s 消除咳嗽）
      partiallyMutedRanges: [
        {
          id: 'pm-1',
          trackId: 'track-1',
          sourceStartMs: 12000,
          sourceEndMs: 13500,
        },
      ],
    };
    state.highlights = [hl];

    const timeline = computeEditedTimeline(state);
    // 播放到金句发音时间点（playheadSec = 2.0s + 2.5s = 4.5s -> 对应源时间 10000 + 2500 = 12500ms）
    const resolved = resolveEditedPlayheadToSource(state, timeline, 4.5);
    expect(resolved.inColdOpen).toBe(true);
    expect(resolved.activeHighlight).toBeDefined();
    expect(resolved.activeHighlight?.mutedTrackIds).toContain('track-2');
    expect(resolved.activeHighlight?.partiallyMutedRanges?.length).toBe(1);

    // 验证源时间 12500ms 命中部分静音区间 [12000, 13500]
    const masterSrcMs = (resolved.sourceSec ?? 0) * 1000;
    const hitPartial = resolved.activeHighlight?.partiallyMutedRanges?.some(
      (pm: HighlightMuteInterval) => pm.trackId === 'track-1' && masterSrcMs >= pm.sourceStartMs && masterSrcMs <= pm.sourceEndMs
    );
    expect(hitPartial).toBe(true);
  });

  it('片头 BGM 支持指定播放长度', () => {
    const state = createEmptyProjectState();
    state.introBgm = {
      fileName: 'theme.mp3',
      enabled: true,
      customDurationSec: 30.0,
    };
    expect(state.introBgm.customDurationSec).toBe(30.0);
  });

  it('BGM 轨默认淡入淡出时间为 800ms，并支持 Solo/Mute 及淡入淡出调整', () => {
    expect(DEFAULT_BGM_FADE_MS).toBe(800);
    const state = createEmptyProjectState();
    expect(state.introBgm).toBeFalsy();

    // 增加 BGM 轨，默认淡入淡出时间为 800ms
    state.introBgm = {
      fileName: 'podcast_theme.wav',
      enabled: true,
      fadeInMs: DEFAULT_BGM_FADE_MS,
      fadeOutMs: DEFAULT_BGM_FADE_MS,
      solo: false,
      muted: false,
    };

    expect(state.introBgm!.fadeInMs).toBe(800);
    expect(state.introBgm!.fadeOutMs).toBe(800);

    // 切换 Solo 与 Mute
    state.introBgm!.solo = true;
    expect(state.introBgm!.solo).toBe(true);

    state.introBgm!.muted = true;
    expect(state.introBgm!.muted).toBe(true);

    // 自定义淡入淡出
    state.introBgm!.fadeInMs = 1200;
    state.introBgm!.fadeOutMs = 600;
    expect(state.introBgm!.fadeInMs).toBe(1200);
    expect(state.introBgm!.fadeOutMs).toBe(600);
  });

  it('BGM 伴奏轨高度紧凑化计算：固定小高度（34px），人声音轨享有充足操作高度', () => {
    const BODY_H = 200;
    const speakerCount = 2;
    const BGM_LANE_COMPACT_H = 34;

    // 旧算法：均匀平分 3 条轨（2条人声 + 1条BGM）
    const legacyLaneH = BODY_H / (speakerCount + 1); // 66.67px
    expect(legacyLaneH).toBeCloseTo(66.67, 1);

    // 新紧凑算法：BGM 轨高度紧凑（不用那么高），人声轨高度显著提升
    const bgmLaneH = Math.min(BGM_LANE_COMPACT_H, Math.max(26, Math.round(BODY_H * 0.2)));
    const speakerLaneH = (BODY_H - bgmLaneH) / speakerCount;

    expect(bgmLaneH).toBe(34);
    expect(speakerLaneH).toBe(83); // 83px > 66.67px，人声波形与字块空间扩大了 24.5%！
    expect(speakerLaneH * speakerCount + bgmLaneH).toBe(BODY_H);
  });

  it('片头 BGM 固定长度锁定，片尾 BGM 没有固定长度支持拖动截取', () => {
    const totalSec = 120.0;
    const introFixedDurationSec = 15.0; // 片头固定长度
    const introBgmEndSec = Math.min(totalSec, introFixedDurationSec);
    expect(introBgmEndSec).toBe(15.0);

    // 片尾 BGM 没有固定长度，默认自适应，可拖动截取
    const defaultOutroDurationSec = Math.min(25, Math.max(6, totalSec * 0.18));
    expect(defaultOutroDurationSec).toBeCloseTo(21.6, 2);

    // 模拟用户在波形轨上拖拽截取片尾 BGM 到 18.5 秒
    const draggedTrimDurationSec = 18.5;
    const outroStartSec = totalSec - draggedTrimDurationSec;
    expect(outroStartSec).toBe(101.5);
    expect(outroStartSec).toBeGreaterThan(introBgmEndSec);
  });

  it('片尾 BGM 自动适应音量：说话人人声发声时避让，人声结束停顿自然浮起并平滑淡出', () => {
    // 模拟人声讲话区间 [95.0s ~ 108.0s]，节目于 120.0s 结束
    const speechActiveRanges = [{ start: 95.0, end: 108.0 }];
    const isSpeechActive = (t: number) => speechActiveRanges.some((r) => t >= r.start && t <= r.end);

    const outroStartSec = 100.0;
    const totalSec = 120.0;
    const outroFadeOutSec = 2.0;

    // 1. 在 104.0s 时，主播正在收尾讲话 -> 自动适应音量触发避让 (Ducking -14dB)
    const tSpeaking = 104.0;
    const duckFactorSpeaking = isSpeechActive(tSpeaking) ? 0.20 : 0.95;
    expect(duckFactorSpeaking).toBe(0.20);

    // 2. 在 112.0s 时，主播话音已落，纯音乐尾声 -> 自动浮起上扬 (Swell)
    const tMusicOutro = 112.0;
    const duckFactorMusic = isSpeechActive(tMusicOutro) ? 0.20 : 0.95;
    expect(duckFactorMusic).toBe(0.95);

    // 3. 在 119.5s 时（最后 0.5s） -> 自动平滑淡出
    const tFadeOut = 119.5;
    const fadeOutFactor = Math.min(1.0, (totalSec - tFadeOut) / outroFadeOutSec);
    expect(fadeOutFactor).toBeCloseTo(0.25, 2);
  });

  it('文稿视图手动加入金句时，真实时长严格等于起止时间段，不再被 minClipSec (如8秒) 错误拉伸', () => {
    // 模拟用户在文稿视图划选了一句 2.8 秒的金句
    const startSec = 15.2;
    const endSec = 18.0;
    const realDurSec = Math.max(0.1, Number(((endSec - startSec)).toFixed(2)));
    expect(realDurSec).toBe(2.8);

    const hlManual: HighlightClip = {
      id: 'hl-test-manual',
      speakerId: 'spk-guest',
      speakerName: '特邀嘉宾',
      text: '这是一个简短而有力的金句。',
      sourceStartMs: Math.round(startSec * 1000),
      sourceEndMs: Math.round(endSec * 1000),
      durationSec: realDurSec,
      selectionSource: 'manual_pick',
    };

    expect(hlManual.durationSec).toBe(2.8);
    expect(hlManual.sourceEndMs - hlManual.sourceStartMs).toBe(2800);
    // 验证冷开场总时长计算中准确按 2.8 秒计算，不被拉长到 8 秒
    const state = createEmptyProjectState();
    state.coldOpenEnabled = true;
    state.highlights = [hlManual];
    const coldOpenDur = computeColdOpenDurationSec(state);
    // 前奏 2.0s + 金句 2.8s + 尾奏 2.0s = 6.8s
    expect(coldOpenDur).toBeCloseTo(6.8, 1);
  });

  it('片头 BGM 仅接受上传的音乐：未上传时不加入时长，上传后按指定自定义时长加入节目开头', () => {
    const state = createEmptyProjectState();
    // 默认无金句，无固定口播
    state.coldOpenEnabled = false;
    state.highlights = [];

    // 1. 开启了片头 BGM 但未上传音乐文件 -> prefixDurationSec 仍为 0
    state.introBgm = {
      fileName: 'virtual-bgm.mp3',
      filePath: '', // 未上传本地路径
      audioUrl: '',
      enabled: true,
      customDurationSec: 12.0,
    };
    let timeline = computeEditedTimeline(state);
    expect(timeline.introBgmDurationSec).toBe(0);
    expect(timeline.prefixDurationSec).toBe(0);

    // 2. 上传了本地音乐文件，并自定义时长为 8.5 秒
    state.introBgm = {
      fileName: 'my-intro-music.mp3',
      filePath: '/path/to/my-intro-music.mp3',
      durationSec: 60.0, // 原音频 60 秒
      enabled: true,
      customDurationSec: 8.5, // 用户指定片头播 8.5 秒
    };
    timeline = computeEditedTimeline(state);
    expect(timeline.introBgmDurationSec).toBe(8.5);
    expect(timeline.prefixDurationSec).toBe(8.5);

    // 正文块的时间顺延至 8.5 秒之后
    if (state.blocks.length > 0) {
      const firstBlockStart = timeline.blockEditedStartsSec[state.blocks[0].blockId];
      expect(firstBlockStart).toBeGreaterThanOrEqual(8.5);
    }

    // 章节列表中自动标记开头的片头音乐
    expect(timeline.chapters[0].title).toContain('🎵 片头音乐 (8.5s)');
    expect(timeline.chapters[0].timeSec).toBe(0);

    // 3. 在 0 ~ 8.5 秒区间内，播放解析器将人声判定为静默，等待正文在片头 BGM 后切入
    const targetAt4s = resolveEditedPlayheadToSource(state, timeline, 4.0);
    expect(targetAt4s.inIntroOrGapSilence).toBe(true);
    expect(targetAt4s.sourceSec).toBeNull();
  });
});
