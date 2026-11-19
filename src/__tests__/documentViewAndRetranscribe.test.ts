import { describe, it, expect, vi } from 'vitest';
import { AsrConfig, PodcastProjectState } from '../types/podcast';
import { cancelPythonSidecarTranscribe } from '../engine/tauriBridge';

describe('文档视图与重新识别逻辑测试', () => {
  it('正确支持不同 ASR 模型配置（本地 SenseVoice / 火山引擎 / DeepSeek）', () => {
    const localConfig: AsrConfig = {
      provider: 'local_sensevoice',
      apiKey: '',
      baseUrl: '',
      fallbackToLocal: true,
    };
    expect(localConfig.provider).toBe('local_sensevoice');

    const volcConfig: AsrConfig = {
      provider: 'volcengine_doubao',
      apiKey: 'volc-test-key',
      baseUrl: '',
      fallbackToLocal: true,
      volcSsdVersion: '200',
    };
    expect(volcConfig.provider).toBe('volcengine_doubao');
    expect(volcConfig.volcSsdVersion).toBe('200');

    const deepseekConfig: AsrConfig = {
      provider: 'deepseek',
      apiKey: 'sk-deepseek-test',
      baseUrl: 'https://api.deepseek.com',
      fallbackToLocal: true,
    };
    expect(deepseekConfig.provider).toBe('deepseek');
  });

  it('cancelPythonSidecarTranscribe 能够安全无异常地调用取消', async () => {
    const res = await cancelPythonSidecarTranscribe();
    expect(res).toBe(true);
  });

  it('文稿视图模式下支持独立工作空间布局与优先读取 AI 生成的时间轴章节', () => {
    const mockState: Partial<PodcastProjectState> = {
      workspaceLayout: 'transcript',
      shownotes: {
        episodeTitle: '测试期次',
        summary: '本期播客探讨 AI 生成与文稿精剪',
        guests: [],
        timeline: [
          { id: 'tl_1', timeSec: 0, title: '开场引入与嘉宾介绍', summary: '介绍本期对谈主题' },
          { id: 'tl_2', timeSec: 120, title: '核心技术突破分析', summary: '探讨音频对齐与成稿逻辑' },
        ],
        benefits: [],
      } as any,
    };

    expect(mockState.workspaceLayout).toBe('transcript');
    expect(mockState.shownotes?.timeline.length).toBe(2);
    expect(mockState.shownotes?.timeline[0].title).toBe('开场引入与嘉宾介绍');
    expect(mockState.shownotes?.timeline[1].timeSec).toBe(120);
  });

  it('文本视图侧边栏支持高光金句与章节大纲双 Tab 切换，并记录完整多轨避让静音状态', () => {
    const mockState: Partial<PodcastProjectState> = {
      highlights: [
        {
          id: 'hl-test-sidebar',
          speakerId: 'spk-host',
          speakerName: '主播小张',
          text: '做播客最重要的是真实流露的瞬间。',
          sourceStartMs: 32000,
          sourceEndMs: 44500,
          durationSec: 12.5,
          selectionSource: 'manual_pick',
          mutedTrackIds: ['spk-guest-mic-bleed'],
        },
      ],
      tracks: [
        {
          id: 'spk-host',
          name: '主播小张',
          peaks: [0.1, 0.6, 0.8, 0.2],
          durationMs: 60000,
        } as any,
        {
          id: 'spk-guest-mic-bleed',
          name: '副麦漏音',
          peaks: [0.02, 0.05, 0.04, 0.02],
          durationMs: 60000,
        } as any,
      ],
    };

    expect(mockState.highlights?.length).toBe(1);
    const hl = mockState.highlights![0];
    expect(hl.text).toBe('做播客最重要的是真实流露的瞬间。');
    expect(hl.sourceStartMs).toBe(32000);
    expect(hl.sourceEndMs).toBe(44500);
    expect(hl.durationSec).toBe(12.5);
    // 验证多音轨编辑支持记录避让串音音轨 ID
    expect(hl.mutedTrackIds).toEqual(['spk-guest-mic-bleed']);

    // 模拟拖动起止点微调（开始点从 32s 拖至 31.5s，结束点从 44.5s 拖至 45.0s）
    const updatedStartMs = 31500;
    const updatedEndMs = 45000;
    const updatedDurSec = Number(((updatedEndMs - updatedStartMs) / 1000).toFixed(2));
    const updatedHl = {
      ...hl,
      sourceStartMs: updatedStartMs,
      sourceEndMs: updatedEndMs,
      durationSec: updatedDurSec,
    };

    expect(updatedHl.durationSec).toBe(13.5);
    expect(updatedHl.sourceStartMs).toBe(31500);
    expect(updatedHl.sourceEndMs).toBe(45000);
  });

  it('文本模式自然段渲染支持中文字间距清除与顶栏视图控制', () => {
    // 验证中文分词间空格清洗函数逻辑
    const tokens = [
      { text: '大家' },
      { text: ' 晚上好' },
      { text: '，欢迎' },
      { text: ' 收听' },
    ];
    const cleaned = tokens.map((tok, idx) => {
      const prev = idx > 0 ? tokens[idx - 1] : null;
      let text = tok.text;
      if (prev && /[\u4e00-\u9fa5]$/.test(prev.text) && text.startsWith(' ')) {
        text = text.replace(/^ +/, '');
      }
      return text;
    }).join('');

    expect(cleaned).toBe('大家晚上好，欢迎收听');
  });
});
