import { useSyncExternalStore } from 'react';

let currentPlayheadSec = 0;
const listeners = new Set<() => void>();

let currentActiveBlockId: string | null = null;
let currentActiveTokenId: string | null = null;
const activeTargetListeners = new Set<() => void>();

export function getPlayheadSec(): number {
  return currentPlayheadSec;
}

export function setPlayheadSec(nextSec: number): void {
  if (!Number.isFinite(nextSec)) return;
  const normalized = Math.max(0, nextSec);
  if (Math.abs(normalized - currentPlayheadSec) < 1e-6) return;
  currentPlayheadSec = normalized;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribePlayhead(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePlayheadSec(): number {
  return useSyncExternalStore(subscribePlayhead, getPlayheadSec, getPlayheadSec);
}

export function getActiveBlockId(): string | null {
  return currentActiveBlockId;
}

export function getActiveTokenId(): string | null {
  return currentActiveTokenId;
}

export function setActivePlaybackTarget(
  blockId: string | null,
  tokenId: string | null
): void {
  if (
    blockId === currentActiveBlockId &&
    tokenId === currentActiveTokenId
  ) {
    return;
  }
  currentActiveBlockId = blockId;
  currentActiveTokenId = tokenId;
  for (const listener of activeTargetListeners) {
    listener();
  }
}

export function subscribeActiveTarget(listener: () => void): () => void {
  activeTargetListeners.add(listener);
  return () => {
    activeTargetListeners.delete(listener);
  };
}

export function useActiveBlockId(): string | null {
  return useSyncExternalStore(
    subscribeActiveTarget,
    getActiveBlockId,
    getActiveBlockId
  );
}

export function useActiveTokenId(): string | null {
  return useSyncExternalStore(
    subscribeActiveTarget,
    getActiveTokenId,
    getActiveTokenId
  );
}
