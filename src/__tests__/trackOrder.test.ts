import { describe, expect, it } from 'vitest';
import { reorderItems, resolveTrackDisplayFileName } from '../engine/trackOrder';

describe('reorderItems', () => {
  it('moves an item forward and backward without mutating input', () => {
    const original = ['A', 'B', 'C', 'D'];
    expect(reorderItems(original, 0, 2)).toEqual(['B', 'C', 'A', 'D']);
    expect(reorderItems(original, 3, 1)).toEqual(['A', 'D', 'B', 'C']);
    expect(original).toEqual(['A', 'B', 'C', 'D']);
  });

  it('returns the original reference when indices are equal or out of bounds', () => {
    const original = ['A', 'B', 'C'];
    expect(reorderItems(original, 1, 1)).toBe(original);
    expect(reorderItems(original, -1, 1)).toBe(original);
    expect(reorderItems(original, 1, 5)).toBe(original);
  });
});

describe('resolveTrackDisplayFileName', () => {
  it('prefers fallbackName with audio extension or extracts basename from path', () => {
    expect(resolveTrackDisplayFileName('/tmp/host.wav', 'host.wav')).toBe('host.wav');
    expect(resolveTrackDisplayFileName('/Users/nemo/audio/guest_01.m4a', '嘉宾')).toBe('guest_01.m4a');
    expect(resolveTrackDisplayFileName(undefined, '主播')).toBe('主播.wav');
    expect(resolveTrackDisplayFileName(undefined, undefined)).toBe('未命名音频');
  });
});
