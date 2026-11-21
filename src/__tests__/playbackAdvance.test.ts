import { describe, expect, it } from 'vitest';
import { audioPreview } from '../engine/audioPreviewEngine';
import { createEmptyProjectState, parsePodcraftProjectJson, serializeProjectToPodcraftJson } from '../data/emptyProject';
import { computeEditedTimeline } from '../engine/timelineEngine';

describe('Multi-Track Playback Continuity & Splice Resilience', () => {
  it('advances smoothly across tight cuts even with laggy seeking or stalled/ended hardware clock', () => {
    // @ts-expect-error test mock
    globalThis.window = globalThis;
    const seekHistory: number[] = [];

    class RealisticWebKitAudio {
      _currentTime = 0;
      duration = 30;
      paused = true;
      readyState = 4;
      ended = false;
      seeking = false;
      volume = 1;
      src = '';
      playbackRate = 1;
      preservesPitch = true;
      listeners: Record<string, Array<() => void>> = {};

      get currentTime() {
        return this._currentTime;
      }
      set currentTime(val: number) {
        seekHistory.push(Number(val.toFixed(3)));
        this._currentTime = val;
        this.ended = false;
      }
      play() {
        this.paused = false;
        return Promise.resolve();
      }
      pause() {
        this.paused = true;
      }
      load() {}
      addEventListener(ev: string, cb: () => void) {
        this.listeners[ev] = this.listeners[ev] || [];
        this.listeners[ev].push(cb);
      }
      removeEventListener() {}
      removeAttribute() {}
    }
    // @ts-expect-error test mock
    globalThis.Audio = RealisticWebKitAudio;

    const base = createEmptyProjectState();
    const state = {
      ...base,
      tracks: [
        {
          id: 't1',
          name: 'Host',
          role: 'host' as const,
          roleLabel: '主持人 Host',
          color: '#3b82f6',
          filePath: '/path/host.wav',
          sourceFilePath: '/orig/host.wav',
          durationMs: 30000,
          rawLufs: -18,
          autoGainDb: 0,
          syncOffsetMs: 0,
          roomToneStartMs: 0,
          roomToneEndMs: 1000,
          peaks: [0.1, 0.2, 0.3],
          solo: false,
          muted: false,
        },
      ],
      blocks: [
        {
          blockId: 'b1',
          speakerId: 't1',
          chapterTitle: '第一段',
          tokens: [
            {
              id: 'tok1',
              type: 'word' as const,
              text: 'Word1',
              sourceStartMs: 0,
              sourceEndMs: 500,
              durationSec: 0.5,
              origDurationSec: 0.5,
            },
            {
              id: 'tok2',
              type: 'word' as const,
              text: 'DeletedCut',
              deleted: true,
              sourceStartMs: 500,
              sourceEndMs: 2500,
              durationSec: 2.0,
              origDurationSec: 2.0,
            },
            {
              id: 'tok3',
              type: 'word' as const,
              text: 'Word2',
              sourceStartMs: 2500,
              sourceEndMs: 2600, // Tight 100ms span (<120ms!)
              durationSec: 0.1,
              origDurationSec: 0.1,
            },
            {
              id: 'tok4',
              type: 'word' as const,
              text: 'DeletedCut2',
              deleted: true,
              sourceStartMs: 2600,
              sourceEndMs: 4000,
              durationSec: 1.4,
              origDurationSec: 1.4,
            },
            {
              id: 'tok5',
              type: 'word' as const,
              text: 'Word3',
              sourceStartMs: 4000,
              sourceEndMs: 6000,
              durationSec: 2.0,
              origDurationSec: 2.0,
            },
          ],
        },
      ],
    };
    const timeline = computeEditedTimeline(state);
    expect(timeline.totalEditedDurationSec).toBe(2.6);

    audioPreview.stopAll();
    audioPreview.startFromUserGesture(state, timeline, 0);

    let playhead = 0;
    let reachedEndAtFrame = -1;

    for (let frame = 0; frame < 220; frame++) {
      const holder = (audioPreview as unknown as { trackElements: Map<string, { audio: RealisticWebKitAudio }> }).trackElements.get('t1');
      // Simulate hardware clock stalling near the end of Span 0 (0.48s) to ensure playhead never deadlocks at span.editedEndSec - 0.001
      if (holder && !holder.audio.paused) {
        if (Math.abs(holder.audio._currentTime - 0.48) > 0.005) {
          holder.audio._currentTime += 0.016;
        }
      }

      const { nextPlayheadSec } = audioPreview.advanceAndSyncPlayback(
        state,
        timeline,
        playhead,
        0.016
      );

      expect(nextPlayheadSec).toBeGreaterThan(playhead);
      playhead = nextPlayheadSec;

      if (nextPlayheadSec >= timeline.totalEditedDurationSec) {
        reachedEndAtFrame = frame;
        break;
      }
    }

    // Must not stop prematurely in first second, and must cleanly finish near ~162 frames (2.6s / 0.016s)
    expect(reachedEndAtFrame).toBeGreaterThan(140);
    expect(playhead).toBe(timeline.totalEditedDurationSec);
    // Must have sought across BOTH cut boundaries (to ~2.5s and ~4.0s) despite the 100ms short middle span!
    expect(seekHistory.some((s) => s >= 2.49 && s <= 2.55)).toBe(true);
    expect(seekHistory.some((s) => s >= 3.99 && s <= 4.05)).toBe(true);
  });

  it('falls back to sourceFilePath if cached normalized filePath fails on load', () => {
    // @ts-expect-error test mock
    globalThis.window = globalThis;
    const loadedUrls: string[] = [];

    class FallbackTestAudio {
      _currentTime = 0;
      duration = 10;
      paused = true;
      readyState = 4;
      ended = false;
      seeking = false;
      volume = 1;
      src = '';
      playbackRate = 1;
      preservesPitch = true;
      listeners: Record<string, Array<() => void>> = {};

      load() {
        loadedUrls.push(this.src);
        if (this.src.includes('missing_tmp.wav')) {
          (this.listeners['error'] || []).forEach((fn) => fn());
        }
      }
      play() {
        this.paused = false;
        return Promise.resolve();
      }
      pause() {
        this.paused = true;
      }
      addEventListener(ev: string, cb: () => void) {
        this.listeners[ev] = this.listeners[ev] || [];
        this.listeners[ev].push(cb);
      }
      removeEventListener() {}
      removeAttribute() {}
    }
    // @ts-expect-error test mock
    globalThis.Audio = FallbackTestAudio;

    const base = createEmptyProjectState();
    const rawState = {
      ...base,
      tracks: [
        {
          id: 'sp_fallback',
          name: 'Guest',
          role: 'guest' as const,
          roleLabel: '飞行嘉宾 Guest',
          color: '#10b981',
          filePath: '/tmp/podcraft_active_session/missing_tmp.wav',
          sourceFilePath: '/Users/demo/orig_guest.wav',
          durationMs: 10000,
          rawLufs: -16,
          autoGainDb: 0,
          syncOffsetMs: 0,
          roomToneStartMs: 0,
          roomToneEndMs: 500,
          peaks: [0.2, 0.4],
          solo: false,
          muted: false,
        },
      ],
    };

    const json = serializeProjectToPodcraftJson(rawState);
    const rehydrated = parsePodcraftProjectJson(json, undefined, true);
    audioPreview.stopAll();
    audioPreview.preloadTracks(rehydrated);

    expect(loadedUrls.some((u) => u.includes('orig_guest.wav'))).toBe(true);
  });

  it('keeps audio paused when pauseMultiTrackPlayback is called before async play() resolves or a stale rAF frame fires', async () => {
    // @ts-expect-error test mock
    globalThis.window = globalThis;
    const pendingResolvers: Array<() => void> = [];

    class DeferredPlayAudio {
      currentTime = 0;
      duration = 20;
      paused = true;
      readyState = 4;
      ended = false;
      seeking = false;
      volume = 1;
      src = '';
      playbackRate = 1;
      preservesPitch = true;

      play() {
        return new Promise<void>((resolve) => {
          pendingResolvers.push(() => {
            this.paused = false;
            resolve();
          });
        });
      }
      pause() {
        this.paused = true;
      }
      load() {}
      addEventListener() {}
      removeEventListener() {}
      removeAttribute() {}
    }
    // @ts-expect-error test mock
    globalThis.Audio = DeferredPlayAudio;

    const base = createEmptyProjectState();
    const state = {
      ...base,
      tracks: [
        {
          id: 't_race',
          name: 'Host',
          role: 'host' as const,
          roleLabel: '主持人 Host',
          color: '#3b82f6',
          filePath: '/path/race_host.wav',
          sourceFilePath: '/orig/race_host.wav',
          durationMs: 20000,
          rawLufs: -18,
          autoGainDb: 0,
          syncOffsetMs: 0,
          roomToneStartMs: 0,
          roomToneEndMs: 500,
          peaks: [0.1, 0.2],
          solo: false,
          muted: false,
        },
      ],
      blocks: [
        {
          blockId: 'b_race',
          speakerId: 't_race',
          chapterTitle: '第一段',
          tokens: [
            {
              id: 'tok_r1',
              type: 'word' as const,
              text: 'Hello',
              sourceStartMs: 0,
              sourceEndMs: 2000,
              durationSec: 2,
              origDurationSec: 2,
            },
          ],
        },
      ],
    };
    const timeline = computeEditedTimeline(state);

    audioPreview.stopAll();
    audioPreview.startFromUserGesture(state, timeline, 0);

    // User immediately hits Stop before deferred play() settles
    audioPreview.pauseMultiTrackPlayback();

    // A stale rAF frame arriving right after stop must not restart playback
    const staleRes = audioPreview.advanceAndSyncPlayback(state, timeline, 0.1, 0.016);
    expect(staleRes.nextPlayheadSec).toBe(0.1);
    expect(staleRes.resolved).toBeNull();

    // Resolve the deferred play() promise; generation guard must immediately re-pause it
    for (const r of pendingResolvers) r();
    await Promise.resolve();
    await Promise.resolve();

    const holder = (
      audioPreview as unknown as { trackElements: Map<string, { audio: DeferredPlayAudio }> }
    ).trackElements.get('t_race');
    expect(holder?.audio.paused).toBe(true);
  });
});
