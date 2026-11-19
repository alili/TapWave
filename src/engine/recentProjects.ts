export interface RecentProjectItem {
  filePath: string;
  title: string;
  lastOpenedAt: number;
  tracksCount?: number;
  durationSec?: number;
}

const STORAGE_KEY = 'podcraft.recentProjects';
const MAX_RECENT_COUNT = 10;

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof globalThis !== 'undefined' && (globalThis as unknown as { localStorage?: Storage }).localStorage) {
      return (globalThis as unknown as { localStorage: Storage }).localStorage;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Loads the list of recent projects from localStorage.
 */
export function loadRecentProjects(): RecentProjectItem[] {
  try {
    const storage = getStorage();
    if (!storage) return [];
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item) =>
          item &&
          typeof item === 'object' &&
          typeof item.filePath === 'string' &&
          Boolean(item.filePath.trim())
      )
      .map((item) => ({
        filePath: item.filePath.trim(),
        title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : item.filePath.split(/[/\\]/).pop() || '未命名工程',
        lastOpenedAt: typeof item.lastOpenedAt === 'number' ? item.lastOpenedAt : Date.now(),
        tracksCount: typeof item.tracksCount === 'number' ? item.tracksCount : undefined,
        durationSec: typeof item.durationSec === 'number' ? item.durationSec : undefined,
      }))
      .slice(0, MAX_RECENT_COUNT);
  } catch (e) {
    console.warn('Failed to load recent projects from localStorage:', e);
    return [];
  }
}

/**
 * Saves or updates a project in the recent projects list, putting it at the front.
 */
export function recordRecentProject(
  filePath: string,
  title?: string,
  extraOrTracksCount?: { tracksCount?: number; durationSec?: number } | number,
  durationSecArg?: number
): RecentProjectItem[] {
  if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
    return loadRecentProjects();
  }

  let tracksCount: number | undefined;
  let durationSec: number | undefined;

  if (typeof extraOrTracksCount === 'number') {
    tracksCount = extraOrTracksCount;
    durationSec = durationSecArg;
  } else if (extraOrTracksCount && typeof extraOrTracksCount === 'object') {
    tracksCount = extraOrTracksCount.tracksCount;
    durationSec = extraOrTracksCount.durationSec;
  }

  const cleanPath = filePath.trim();
  const baseName = cleanPath.split(/[/\\]/).pop() || '未命名工程';
  const cleanTitle = title && title.trim() ? title.trim() : baseName;

  const current = loadRecentProjects();
  const existing = current.find((item) => item.filePath === cleanPath);

  const newItem: RecentProjectItem = {
    filePath: cleanPath,
    title: cleanTitle,
    lastOpenedAt: Date.now(),
    tracksCount: typeof tracksCount === 'number' ? tracksCount : existing?.tracksCount,
    durationSec: typeof durationSec === 'number' ? durationSec : existing?.durationSec,
  };

  const filtered = current.filter((item) => item.filePath !== cleanPath);
  const updated = [newItem, ...filtered].slice(0, MAX_RECENT_COUNT);

  try {
    const storage = getStorage();
    storage?.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn('Failed to persist recent projects to localStorage:', e);
  }

  return updated;
}

/**
 * Removes a specific project from the recent list.
 */
export function removeRecentProject(filePath: string): RecentProjectItem[] {
  if (!filePath) return loadRecentProjects();
  const current = loadRecentProjects();
  const filtered = current.filter((item) => item.filePath !== filePath.trim());
  try {
    const storage = getStorage();
    storage?.setItem(STORAGE_KEY, JSON.stringify(filtered));
  } catch (e) {
    console.warn('Failed to persist recent projects to localStorage:', e);
  }
  return filtered;
}

/**
 * Clears the entire list of recent projects.
 */
export function clearRecentProjects(): void {
  try {
    const storage = getStorage();
    storage?.removeItem(STORAGE_KEY);
  } catch (e) {
    console.warn('Failed to clear recent projects from localStorage:', e);
  }
}

/**
 * Formats a timestamp into a user-friendly relative or concise string.
 */
export function formatRecentTime(timestampMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSec < 60) return '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}天前`;

  const d = new Date(timestampMs);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}/${day}`;
}
