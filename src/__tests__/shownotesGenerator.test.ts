import { describe, expect, it } from 'vitest';
import {
  applySpeakerTrackProfileUpdate,
  createEmptyProjectState,
  parsePodcraftProjectJson,
  serializeProjectToPodcraftJson,
} from '../data/emptyProject';
import { computeEditedTimeline } from '../engine/timelineEngine';
import {
  buildGuestsFromTracks,
  buildLocalShownotes,
  countSummaryChars,
  formatShownotesMarkdown,
  formatShownotesPlainText,
  formatTimecode,
  formatPodcastTimestamps,
} from '../engine/shownotesGenerator';
import { PodcastProjectState, ShownotesTimelineItem } from '../types/podcast';

function buildSampleEditedProject(): PodcastProjectState {
  const base = createEmptyProjectState();
  return {
    ...base,
    projectTitle: '独立开发者播客第42期：AI硬件的真实落地',
    coldOpenEnabled: true,
    tracks: [
      {
        id: 't_host',
        name: '林深',
        role: 'host',
        roleLabel: '主持人',
        color: '#3b82f6',
        rawLufs: -18,
        autoGainDb: 2,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 500,
        peaks: [0.2, 0.5, 0.3],
        solo: false,
        muted: false,
      },
      {
        id: 't_guest',
        name: '陈默',
        role: 'guest',
        roleLabel: '飞行嘉宾 Guest',
        color: '#f59e0b',
        rawLufs: -17,
        autoGainDb: 1,
        syncOffsetMs: 0,
        roomToneStartMs: 0,
        roomToneEndMs: 500,
        peaks: [0.3, 0.6, 0.4],
        solo: false,
        muted: false,
      },
    ],
    highlights: [
      {
        id: 'hl_1',
        speakerId: 't_guest',
        speakerName: '陈默',
        text: '做硬件最怕的是用软件思维去赌供应链周期。',
        sourceStartMs: 5000,
        sourceEndMs: 11000,
        durationSec: 6,
        selectionSource: 'ai_auto',
      },
    ],
    blocks: [
      {
        blockId: 'b_1',
        speakerId: 't_host',
        chapterTitle: '开场：为什么今年大家都在聊AI硬件',
        tokens: [
          {
            id: 'tok_1',
            type: 'word',
            text: '欢迎收听本期节目，今天请到了硬件创业者陈默聊一聊真实的一线踩坑经历。',
            sourceStartMs: 0,
            sourceEndMs: 5000,
            durationSec: 5,
            origDurationSec: 5,
          },
        ],
      },
      {
        blockId: 'b_2',
        speakerId: 't_guest',
        chapterTitle: '供应链避坑与产品定义',
        tokens: [
          {
            id: 'tok_2',
            type: 'word',
            text: '做硬件最怕的是用软件思维去赌供应链周期，我们的某',
            sourceStartMs: 5000,
            sourceEndMs: 11000,
            durationSec: 6,
            origDurationSec: 6,
          },
          {
            id: 'tok_secret',
            type: 'word',
            text: '机密代号X99',
            sourceStartMs: 11000,
            sourceEndMs: 12000,
            durationSec: 1,
            origDurationSec: 1,
            bleeped: true,
          },
          {
            id: 'tok_3',
            type: 'word',
            text: '项目就因此延期了三个月。',
            sourceStartMs: 12000,
            sourceEndMs: 15000,
            durationSec: 3,
            origDurationSec: 3,
          },
        ],
      },
    ],
    glossary: [{ id: 'g1', word: 'AI硬件', type: 'hotword' }],
  };
}

describe('Shownotes 一键生成与持久化引擎', () => {
  it('生成约500字节目简介、自动脱敏消音词，并提取高光与章节时间轴', () => {
    const project = buildSampleEditedProject();
    const timeline = computeEditedTimeline(project);
    const sn = buildLocalShownotes(project, timeline);

    expect(sn.episodeTitle).toBe('独立开发者播客第42期：AI硬件的真实落地');
    expect(countSummaryChars(sn.summary)).toBeGreaterThanOrEqual(420);
    expect(sn.summary).not.toContain('机密代号X99');
    expect(sn.summary).toContain('[***]');
    // 确保绝对不包含引用原文的引号与机械引述
    expect(sn.summary).not.toContain('“');
    expect(sn.summary).not.toContain('”');
    expect(sn.summary).not.toContain('分享了关于');
    sn.timeline.forEach((t) => {
      if (t.summary) {
        expect(t.summary).not.toContain('“');
        expect(t.summary).not.toContain('”');
        expect(t.summary).not.toContain('他说');
      }
    });

    expect(sn.guests).toHaveLength(2);
    expect(sn.guests[0].name).toBe('林深');
    expect(sn.guests[1].name).toBe('陈默');
    expect(sn.guests[1].avatarStyle).toBeTruthy();

    expect(sn.timeline.length).toBeGreaterThanOrEqual(2);
    expect(sn.timeline[0].timeSec).toBe(0);
    expect(sn.timeline[0].title).toContain('高光片头');
  });

  it('支持配置抽奖规则、嘉宾联系/社交信息、听友福利并导出 Markdown 与纯文本', () => {
    const project = buildSampleEditedProject();
    const timeline = computeEditedTimeline(project);
    const sn = buildLocalShownotes(project, timeline);

    sn.guests[1].contact = 'chenmo@example.com';
    sn.guests[1].socialAccount = '即刻 @陈默硬件笔记';
    sn.guests[1].avatarStyle = 'glasses';

    sn.activity.lottery = {
      enabled: true,
      prizeName: '签名版《硬件创业手记》',
      winnerCount: 5,
      drawCondition: 'keyword_reply',
      participationMethod: '评论区带暗号留言并转发',
      keyword: '硬核出海',
      deadline: '2026-11-30 20:00',
      announcementChannel: '小宇宙评论区置顶',
    };

    sn.benefits = [
      {
        id: 'ben_custom',
        title: '听友专属供应链清单 PDF',
        codeOrLink: '暗号：AI42',
        description: '公众号后台回复暗号即可免费下载',
      },
    ];

    const md = formatShownotesMarkdown(sn);
    const txt = formatShownotesPlainText(sn);

    expect(md).toContain('chenmo@example.com');
    expect(md).toContain('即刻 @陈默硬件笔记');
    expect(md).toContain('签名版《硬件创业手记》');
    expect(md).toContain('硬核出海');
    expect(md).toContain('听友专属供应链清单 PDF');
    expect(md).toContain('暗号：AI42');

    expect(txt).toContain('【节目简介】');
    expect(txt).toContain('【节目嘉宾】');
    expect(txt).toContain('【时间轴】');
    expect(txt).toContain('【活动信息】');
    expect(txt).toContain('【听友福利】');
  });

  it('音轨改名同步嘉宾名称，且 .podcraft 序列化完整保留 shownotes', () => {
    const project = buildSampleEditedProject();
    const timeline = computeEditedTimeline(project);
    const sn = buildLocalShownotes(project, timeline);
    sn.guests[1].contact = 'wx_chenmo';
    project.shownotes = sn;

    const renamed = applySpeakerTrackProfileUpdate(project, 't_guest', '陈默老师', 'guest');
    expect(renamed.shownotes?.guests[1].name).toBe('陈默老师');
    expect(renamed.shownotes?.guests[1].contact).toBe('wx_chenmo');

    const json = serializeProjectToPodcraftJson(renamed);
    const restored = parsePodcraftProjectJson(json);
    expect(restored.shownotes?.guests[1].name).toBe('陈默老师');
    expect(restored.shownotes?.guests[1].contact).toBe('wx_chenmo');
    expect(restored.shownotes?.activity.lottery.enabled).toBe(true);
  });

  it('时间轴根据内容自然分割，大致收敛在 8-20 个分段范围内', () => {
    const base = createEmptyProjectState();
    const blocks = Array.from({ length: 28 }, (_, i) => ({
      blockId: `b_${i}`,
      speakerId: 't1',
      chapterTitle: `话题 ${Math.floor(i / 2) + 1}`,
      tokens: [
        {
          id: `k_${i}`,
          type: 'word' as const,
          text: `第${i + 1}段讨论具体实践案例与经验复盘，内容十分扎实。`,
          sourceStartMs: i * 45_000,
          sourceEndMs: (i + 1) * 45_000,
          durationSec: 45,
          origDurationSec: 45,
        },
      ],
    }));

    const longProject: PodcastProjectState = {
      ...base,
      projectTitle: '长对谈播客',
      coldOpenEnabled: false,
      tracks: [
        {
          id: 't1',
          name: '主播',
          role: 'host',
          roleLabel: '主持人',
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
      ],
      blocks,
    };

    const timeline = computeEditedTimeline(longProject);
    const sn = buildLocalShownotes(longProject, timeline);

    expect(sn.timeline.length).toBeGreaterThanOrEqual(8);
    expect(sn.timeline.length).toBeLessThanOrEqual(20);
    expect(sn.timeline[0].timeSec).toBe(0);
    expect(sn.timeline[1].timeSec).toBeGreaterThan(0);
  });

  it('时间轴生成「HH:MM:SS - 主题标签：概括说明」格式并避免机械摘抄首句', () => {
    expect(formatTimecode(77)).toBe('00:01:17');
    expect(formatTimecode(3645)).toBe('01:00:45');

    const base = createEmptyProjectState();
    const project: PodcastProjectState = {
      ...base,
      projectTitle: '保险剧本杀深度对谈',
      coldOpenEnabled: false,
      tracks: [
        {
          id: 't1',
          name: '德福',
          role: 'host',
          roleLabel: '主持人',
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
      ],
      blocks: [
        {
          blockId: 'b1',
          speakerId: 't1',
          chapterTitle: '章节 1',
          tokens: [
            {
              id: 'k1',
              type: 'word',
              text: '嗯，那个大家好，今天在小红书偶遇结缘后亲测一整天剧本杀火速邀约开聊。',
              sourceStartMs: 0,
              sourceEndMs: 77_000,
              durationSec: 77,
              origDurationSec: 77,
            },
          ],
        },
        {
          blockId: 'b2',
          speakerId: 't1',
          chapterTitle: '章节 2',
          tokens: [
            {
              id: 'k2',
              type: 'word',
              text: '我98年首经贸保险科班出身，拥有二十余年内外勤全岗位实战背景。',
              sourceStartMs: 77_000,
              sourceEndMs: 166_000,
              durationSec: 89,
              origDurationSec: 89,
            },
          ],
        },
        {
          blockId: 'b3',
          speakerId: 't1',
          chapterTitle: '章节 3',
          tokens: [
            {
              id: 'k3',
              type: 'word',
              text: '很多人好奇这个产品和传统沙盘的区别，本质上是算术之术与人生之道的差异。',
              sourceStartMs: 166_000,
              sourceEndMs: 250_000,
              durationSec: 84,
              origDurationSec: 84,
            },
          ],
        },
        {
          blockId: 'b4',
          speakerId: 't1',
          chapterTitle: '章节 4',
          tokens: [
            {
              id: 'k4',
              type: 'word',
              text: '最后给听友准备了免费内测共创福利，进群即可领取专属资料包。',
              sourceStartMs: 250_000,
              sourceEndMs: 320_000,
              durationSec: 70,
              origDurationSec: 70,
            },
          ],
        },
      ],
    };

    const tl = computeEditedTimeline(project);
    const sn = buildLocalShownotes(project, tl);
    const txt = formatShownotesPlainText(sn);

    expect(sn.timeline.some((t) => t.title === '开场介绍')).toBe(true);
    expect(sn.timeline.some((t) => t.title === '嘉宾履历')).toBe(true);
    expect(sn.timeline.some((t) => t.title === '维度对比')).toBe(true);
    expect(sn.timeline.some((t) => t.title === '听友福利')).toBe(true);

    expect(txt).toContain('00:00:00 开场介绍：');
    expect(txt).toContain('00:01:17 嘉宾履历：');
  });

  it('智能大纲导出严格符合播客标准：时间戳与标题由单个空格隔开，无破折号', () => {
    const mockTimeline: ShownotesTimelineItem[] = [
      { id: 't1', timeSec: 0, title: '开场', summary: '为什么我们决定在这个时间点聊这个话题？' },
      { id: 't2', timeSec: 225, title: '行业真相', summary: '被严重高估的三个所谓“风口”' },
      { id: 't3', timeSec: 680, title: '踩坑实录', summary: '花了一百万买来的教训，核心问题出在团队基因' },
      { id: 't4', timeSec: 1145, title: '破局方法论', summary: '如何在资源有限的情况下做冷启动？' },
      { id: 't5', timeSec: 1720, title: '快问快答', summary: '给新人入行的三条反常识建议' },
      { id: 't6', timeSec: 2112, title: '结尾彩蛋与下期预告' },
    ];

    const out = formatPodcastTimestamps(mockTimeline);
    expect(out).toContain('00:00 开场：为什么我们决定在这个时间点聊这个话题？');
    expect(out).toContain('03:45 行业真相：被严重高估的三个所谓“风口”');
    expect(out).toContain('11:20 踩坑实录：花了一百万买来的教训，核心问题出在团队基因');
    expect(out).toContain('19:05 破局方法论：如何在资源有限的情况下做冷启动？');
    expect(out).toContain('28:40 快问快答：给新人入行的三条反常识建议');
    expect(out).toContain('35:12 结尾彩蛋与下期预告');
    // 严格确保无破折号连接时间戳
    expect(out).not.toContain('00:00 -');
    expect(out).not.toContain('03:45 -');
  });

  it('支持嘉宾自定义排序、名字后默认加微信、多社交账户链接与斜杠分割简介标签', () => {
    const project = buildSampleEditedProject();
    const timeline = computeEditedTimeline(project);
    const sn = buildLocalShownotes(project, timeline);

    // 调换嘉宾顺序
    const reordered = [sn.guests[1], sn.guests[0]];
    reordered[0].contact = 'wx_chenmo';
    reordered[0].bio = '硬件创业者、AI产品经理, 开源作者';
    reordered[0].socialAccounts = [
      { platform: '即刻', handle: '@陈默', url: 'https://web.okjike.com/u/chenmo' },
      { platform: '小红书', handle: '@陈默笔记', url: 'https://xhs.example.com/123' },
    ];
    sn.guests = reordered;

    // 从音轨同步时保持自定义排序
    const synced = buildGuestsFromTracks(project.tracks, sn.guests);
    expect(synced[0].id).toBe('guest_t_guest');
    expect(synced[1].id).toBe('guest_t_host');

    const md = formatShownotesMarkdown(sn);
    const txt = formatShownotesPlainText(sn);

    expect(md).toContain('**陈默**（微信：wx_chenmo｜飞行嘉宾）');
    expect(md).toContain('硬件创业者 / AI产品经理 / 开源作者');
    expect(md).toContain('[即刻 @陈默](https://web.okjike.com/u/chenmo)');
    expect(md).toContain('[小红书 @陈默笔记](https://xhs.example.com/123)');

    expect(txt).toContain('• 陈默（微信：wx_chenmo｜飞行嘉宾）');
    expect(txt).toContain('硬件创业者 / AI产品经理 / 开源作者');
    expect(txt).toContain('即刻 @陈默 (https://web.okjike.com/u/chenmo)');
  });
});
