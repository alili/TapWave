import { buildPodAudioUrl } from '../data/emptyProject';
import { BgmTrackAsset } from '../types/podcast';

export type AuxAudioSlot = 'intro_vo' | 'intro' | 'outro';

export interface GlobalAuxPresetItem {
  id: string;
  slot: AuxAudioSlot;
  name: string;
  fileName: string;
  filePath?: string;
  durationSec?: number;
  isDefault?: boolean;
  addedAt: string;
}

const STORAGE_KEY = 'podcraft.globalAuxLibrary.v1';

function getSafeStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore storage access errors in restricted/test environments
  }
  return null;
}

export function loadGlobalAuxLibrary(): GlobalAuxPresetItem[] {
  const storage = getSafeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is GlobalAuxPresetItem =>
        Boolean(x) &&
        typeof x.id === 'string' &&
        (x.slot === 'intro_vo' || x.slot === 'intro' || x.slot === 'outro') &&
        typeof x.fileName === 'string'
    );
  } catch {
    return [];
  }
}

export function saveGlobalAuxLibrary(items: GlobalAuxPresetItem[]): void {
  const storage = getSafeStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Ignore quota errors
  }
}

export function addGlobalAuxItem(
  input: Omit<GlobalAuxPresetItem, 'id' | 'addedAt'>,
  currentItems?: GlobalAuxPresetItem[]
): GlobalAuxPresetItem[] {
  const items = currentItems ? [...currentItems] : loadGlobalAuxLibrary();
  const existingIdx = items.findIndex(
    (it) =>
      it.slot === input.slot &&
      ((input.filePath && it.filePath === input.filePath) ||
        (!input.filePath && it.fileName === input.fileName))
  );
  const now = new Date().toISOString();

  let next = items;
  if (input.isDefault) {
    next = next.map((it) => (it.slot === input.slot ? { ...it, isDefault: false } : it));
  }

  if (existingIdx >= 0) {
    const prev = next[existingIdx];
    next[existingIdx] = {
      ...prev,
      ...input,
      isDefault: input.isDefault ?? prev.isDefault,
      addedAt: now,
    };
  } else {
    const newItem: GlobalAuxPresetItem = {
      ...input,
      id: `aux_${input.slot}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      addedAt: now,
    };
    next = [newItem, ...next];
  }

  saveGlobalAuxLibrary(next);
  return next;
}

export function setDefaultGlobalAuxItem(
  itemId: string | null,
  slot: AuxAudioSlot,
  currentItems?: GlobalAuxPresetItem[]
): GlobalAuxPresetItem[] {
  const items = currentItems ? [...currentItems] : loadGlobalAuxLibrary();
  const next = items.map((it) => {
    if (it.slot !== slot) return it;
    return { ...it, isDefault: itemId !== null && it.id === itemId };
  });
  saveGlobalAuxLibrary(next);
  return next;
}

export function removeGlobalAuxItem(
  itemId: string,
  currentItems?: GlobalAuxPresetItem[]
): GlobalAuxPresetItem[] {
  const items = currentItems ? [...currentItems] : loadGlobalAuxLibrary();
  const next = items.filter((it) => it.id !== itemId);
  saveGlobalAuxLibrary(next);
  return next;
}

export function toBgmTrackAsset(item: GlobalAuxPresetItem): BgmTrackAsset {
  return {
    fileName: item.fileName,
    filePath: item.filePath,
    audioUrl: item.filePath ? buildPodAudioUrl(item.filePath, true) : undefined,
    durationSec: item.durationSec,
    enabled: true,
  };
}

export function getDefaultGlobalAuxAssets(items?: GlobalAuxPresetItem[]): {
  introVoiceover: BgmTrackAsset | null;
  introBgm: BgmTrackAsset | null;
  outroBgm: BgmTrackAsset | null;
} {
  const list = items ?? loadGlobalAuxLibrary();
  const defVo = list.find((it) => it.slot === 'intro_vo' && it.isDefault);
  const defIntro = list.find((it) => it.slot === 'intro' && it.isDefault);
  const defOutro = list.find((it) => it.slot === 'outro' && it.isDefault);
  return {
    introVoiceover: defVo ? toBgmTrackAsset(defVo) : null,
    introBgm: defIntro ? toBgmTrackAsset(defIntro) : null,
    outroBgm: defOutro ? toBgmTrackAsset(defOutro) : null,
  };
}
