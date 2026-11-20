import { describe, expect, it, vi } from 'vitest';
import { getPlayheadSec, setPlayheadSec, subscribePlayhead } from '../engine/playheadStore';

describe('playheadStore', () => {
  it('updates playhead and notifies subscribers only when value meaningfully changes', () => {
    setPlayheadSec(0);
    const listener = vi.fn();
    const unsub = subscribePlayhead(listener);

    setPlayheadSec(12.345);
    expect(getPlayheadSec()).toBe(12.345);
    expect(listener).toHaveBeenCalledTimes(1);

    // Same value should not re-notify
    setPlayheadSec(12.345);
    expect(listener).toHaveBeenCalledTimes(1);

    // Negative values are clamped to 0
    setPlayheadSec(-5);
    expect(getPlayheadSec()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(2);

    // Non-finite values are ignored
    setPlayheadSec(Number.NaN);
    expect(getPlayheadSec()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
    setPlayheadSec(3.5);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
