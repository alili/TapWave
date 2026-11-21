import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioPreview } from '../engine/audioPreviewEngine';

describe('AudioPreviewEngine stop & pause guarantees', () => {
  const originalWindow = globalThis.window;
  const originalAudio = globalThis.Audio;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
    if (originalAudio === undefined) {
      delete (globalThis as Record<string, unknown>).Audio;
    } else {
      (globalThis as Record<string, unknown>).Audio = originalAudio;
    }
    vi.restoreAllMocks();
  });

  it('immediately stops active Web Audio skim, main, aux, activeNodes, and BGM preview on pauseMultiTrackPlayback', () => {
    const stopMainMock = vi.fn();
    const stopAuxMock = vi.fn();
    const stopSkimMock = vi.fn();
    const stopOscMock = vi.fn();
    const disconnectMock = vi.fn();
    const bgmPauseMock = vi.fn();
    const bgmRemoveAttrMock = vi.fn();
    const bgmLoadMock = vi.fn();

    const engine = audioPreview as unknown as {
      ctx: AudioContext | null;
      wasPlaying: boolean;
      activeNodes: AudioNode[];
      activeSkimTracks: Map<string, { source: AudioBufferSourceNode; gainNode: GainNode; startedCtxTime: number; startedSourceSec: number; playbackRate: number }>;
      activeWebAudioMainTracks: Map<string, { source: AudioBufferSourceNode; gainNode: GainNode; chunkIdx: number; playbackRate: number; startedCtxTime: number; startedInChunkSec: number }>;
      activeWebAudioAux: Map<'intro_bgm' | 'outro_bgm' | 'intro_vo', { url: string; source: AudioBufferSourceNode; gainNode: GainNode; startedCtxTime: number; startOffsetSec: number; playbackRate: number; loop: boolean }>;
      bgmPreviewAudio: HTMLAudioElement | null;
      bgmPreviewSlot: string | null;
      pauseMultiTrackPlayback: () => void;
    };

    engine.ctx = { currentTime: 10 } as AudioContext;
    engine.wasPlaying = true;
    engine.activeNodes = [
      { stop: stopOscMock, disconnect: disconnectMock } as unknown as AudioNode,
    ];
    engine.activeSkimTracks.set('tr1', {
      source: { stop: stopSkimMock, disconnect: disconnectMock } as unknown as AudioBufferSourceNode,
      gainNode: { gain: { value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, disconnect: disconnectMock } as unknown as GainNode,
      startedCtxTime: 0,
      startedSourceSec: 0,
      playbackRate: 1,
    });
    engine.activeWebAudioMainTracks.set('tr1', {
      source: { stop: stopMainMock, disconnect: disconnectMock } as unknown as AudioBufferSourceNode,
      gainNode: { gain: { value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, disconnect: disconnectMock } as unknown as GainNode,
      chunkIdx: 0,
      playbackRate: 1,
      startedCtxTime: 0,
      startedInChunkSec: 0,
    });
    engine.activeWebAudioAux.set('intro_bgm', {
      url: 'test.mp3',
      source: { stop: stopAuxMock, disconnect: disconnectMock } as unknown as AudioBufferSourceNode,
      gainNode: { disconnect: disconnectMock } as unknown as GainNode,
      startedCtxTime: 0,
      startOffsetSec: 0,
      playbackRate: 1,
      loop: true,
    });
    engine.bgmPreviewAudio = {
      pause: bgmPauseMock,
      removeAttribute: bgmRemoveAttrMock,
      load: bgmLoadMock,
    } as unknown as HTMLAudioElement;
    engine.bgmPreviewSlot = 'intro';

    engine.pauseMultiTrackPlayback();

    expect(engine.wasPlaying).toBe(false);
    expect(stopSkimMock).toHaveBeenCalledWith();
    expect(stopMainMock).toHaveBeenCalledWith();
    expect(stopAuxMock).toHaveBeenCalledWith();
    expect(stopOscMock).toHaveBeenCalledTimes(1);
    expect(bgmPauseMock).toHaveBeenCalledTimes(1);
    expect(bgmRemoveAttrMock).toHaveBeenCalledWith('src');
    expect(bgmLoadMock).toHaveBeenCalledTimes(1);
    expect(engine.bgmPreviewAudio).toBeNull();
    expect(engine.activeNodes).toHaveLength(0);
    engine.ctx = null;
  });

  it('prevents stopped BGM preview from restarting on late onerror or play() resolution', async () => {
    let createdEl: {
      src: string;
      preload: string;
      volume: number;
      paused: boolean;
      onerror: (() => void) | null;
      onended: (() => void) | null;
      play: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      load: ReturnType<typeof vi.fn>;
      removeAttribute: ReturnType<typeof vi.fn>;
    } | null = null;

    let resolvePlay!: () => void;
    class MockAudio {
      src: string;
      preload = '';
      volume = 1;
      paused = false;
      onerror: (() => void) | null = null;
      onended: (() => void) | null = null;
      play = vi.fn(
        () =>
          new Promise<void>((res) => {
            resolvePlay = res;
          })
      );
      pause = vi.fn(() => {
        this.paused = true;
      });
      load = vi.fn();
      removeAttribute = vi.fn();
      constructor(url = '') {
        this.src = url;
        createdEl = this;
      }
    }

    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).Audio = MockAudio;

    const started = audioPreview.toggleBgmSlotPreview('intro', 'http://127.0.0.1:41234/audio?path=bgm.mp3');
    expect(started).toBe(true);
    expect(createdEl).not.toBeNull();

    // User clicks stop before play() resolves or before an error fires
    audioPreview.stopBgmPreview();
    expect(createdEl!.pause).toHaveBeenCalledTimes(1);

    // Late play() resolution should immediately re-pause
    resolvePlay();
    await Promise.resolve();
    expect(createdEl!.pause).toHaveBeenCalledTimes(2);

    // Late onerror should not reload fallback or call play() a second time
    createdEl!.onerror?.();
    expect(createdEl!.play).toHaveBeenCalledTimes(1);
  });
});
