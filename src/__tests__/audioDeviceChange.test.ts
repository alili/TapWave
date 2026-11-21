import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioPreview } from '../engine/audioPreviewEngine';

describe('AudioPreviewEngine device change recovery', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
    vi.restoreAllMocks();
  });

  it('closes old AudioContext and recreates a fresh one when playing on device change', () => {
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const resumeMock = vi.fn().mockResolvedValue(undefined);
    const addEventListenerMock = vi.fn();
    let createdCount = 0;

    class MockAudioContext {
      state = 'running';
      sampleRate = 48000;
      currentTime = 0;
      destination = {};
      close = closeMock;
      resume = resumeMock;
      addEventListener = addEventListenerMock;
      createBuffer = vi.fn(() => ({}));
      createBufferSource = vi.fn(() => ({
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
      }));
      constructor() {
        createdCount += 1;
      }
    }

    (globalThis as Record<string, unknown>).window = {
      AudioContext: MockAudioContext,
    };

    const engine = audioPreview as unknown as {
      ctx: AudioContext | null;
      wasPlaying: boolean;
      forceSeekPending: boolean;
      ensureContext: () => AudioContext | null;
      handleAudioDeviceChange: () => void;
    };

    engine.ctx = null;
    engine.wasPlaying = true;
    engine.forceSeekPending = false;

    const firstCtx = engine.ensureContext();
    expect(firstCtx).toBeTruthy();
    expect(createdCount).toBe(1);

    engine.handleAudioDeviceChange();

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(engine.forceSeekPending).toBe(true);
    expect(createdCount).toBe(2);
    expect(engine.ctx).not.toBe(firstCtx);

    engine.wasPlaying = false;
    engine.ctx = null;
  });

  it('rebinds loaded HTMLAudioElements via setSinkId and load while preserving currentTime', () => {
    const setSinkIdMock = vi.fn().mockResolvedValue(undefined);
    const pauseMock = vi.fn();
    const loadMock = vi.fn();

    const fakeEl = {
      src: 'http://127.0.0.1:41234/audio?path=test.wav',
      readyState: 4,
      paused: false,
      ended: false,
      currentTime: 42.5,
      setSinkId: setSinkIdMock,
      pause: pauseMock,
      load: loadMock,
      getAttribute: vi.fn(() => 'http://127.0.0.1:41234/audio?path=test.wav'),
    } as unknown as HTMLAudioElement;

    const engine = audioPreview as unknown as {
      wasPlaying: boolean;
      trackElements: Map<
        string,
        {
          audio: HTMLAudioElement;
          pendingSeekSec: number | null;
          lastPlayRetryPerfMs: number;
        }
      >;
      handleAudioDeviceChange: () => void;
    };

    engine.wasPlaying = false;
    engine.trackElements.set('sp_test_dev', {
      audio: fakeEl,
      pendingSeekSec: null,
      lastPlayRetryPerfMs: 1000,
    });

    try {
      engine.handleAudioDeviceChange();
      const holder = engine.trackElements.get('sp_test_dev')!;
      expect(setSinkIdMock).toHaveBeenCalledWith('');
      expect(pauseMock).toHaveBeenCalledTimes(1);
      expect(loadMock).toHaveBeenCalledTimes(1);
      expect(holder.pendingSeekSec).toBe(42.5);
      expect(holder.lastPlayRetryPerfMs).toBe(0);
    } finally {
      engine.trackElements.delete('sp_test_dev');
    }
  });
});
