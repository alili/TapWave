import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadRecentProjects,
  recordRecentProject,
  removeRecentProject,
  clearRecentProjects,
  formatRecentTime,
} from '../engine/recentProjects';

describe('recentProjects 单元测试', () => {
  let mockStore: Record<string, string> = {};

  beforeEach(() => {
    mockStore = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => mockStore[k] ?? null,
      setItem: (k: string, v: string) => {
        mockStore[k] = v;
      },
      removeItem: (k: string) => {
        delete mockStore[k];
      },
      clear: () => {
        mockStore = {};
      },
    };
  });

  it('初始状态下最近工程列表为空', () => {
    expect(loadRecentProjects()).toEqual([]);
  });

  it('正确记录最近工程并按最新打开置顶去重', () => {
    recordRecentProject('/Users/nemo/p1.podcraft', '节目第一期');
    recordRecentProject('/Users/nemo/p2.podcraft', '节目第二期');
    let recents = loadRecentProjects();
    expect(recents.length).toBe(2);
    expect(recents[0].title).toBe('节目第二期');

    // 再次打开第一期，第一期应被置顶
    recordRecentProject('/Users/nemo/p1.podcraft', '节目第一期-新标题');
    recents = loadRecentProjects();
    expect(recents.length).toBe(2);
    expect(recents[0].filePath).toBe('/Users/nemo/p1.podcraft');
    expect(recents[0].title).toBe('节目第一期-新标题');
  });

  it('支持删除单条与清空所有记录', () => {
    recordRecentProject('/Users/nemo/p1.podcraft', '项目1');
    recordRecentProject('/Users/nemo/p2.podcraft', '项目2');
    removeRecentProject('/Users/nemo/p1.podcraft');
    expect(loadRecentProjects().length).toBe(1);
    expect(loadRecentProjects()[0].filePath).toBe('/Users/nemo/p2.podcraft');

    clearRecentProjects();
    expect(loadRecentProjects()).toEqual([]);
  });

  it('格式化时间友好显示', () => {
    const now = Date.now();
    expect(formatRecentTime(now)).toBe('刚刚');
    expect(formatRecentTime(now - 120 * 1000)).toBe('2分钟前');
    expect(formatRecentTime(now - 3600 * 3 * 1000)).toBe('3小时前');
  });
});
