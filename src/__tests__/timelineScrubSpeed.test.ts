import { describe, expect, it } from 'vitest';
import { computeHoverScrubRate, HOVER_SCRUB_MAX_RATE, HOVER_SCRUB_MIN_RATE } from '../engine/timelineScrubSpeed';
import { computePreviewTrackLoudnessScale } from '../engine/audioPreviewEngine';

describe('computeHoverScrubRate', () => {
  it('returns 1.0x and direction 0 on initial sample', () => {
    const res = computeHoverScrubRate(null, 10.0, 1000);
    expect(res.rate).toBe(1.0);
    expect(res.direction).toBe(0);
    expect(res.nextSample.timeSec).toBe(10.0);
  });

  it('keeps 1.0x original speed when mouse moves slowly in timeline space', () => {
    let sample = computeHoverScrubRate(null, 10.0, 1000).nextSample;
    for (let i = 1; i <= 8; i += 1) {
      const res = computeHoverScrubRate(sample, 10.0 + i * 0.05, 1000 + i * 100);
      expect(res.direction).toBe(1);
      expect(res.rate).toBe(1.0);
      sample = res.nextSample;
    }
    expect(sample.smoothedRate).toBe(1.0);
  });

  it('keeps 1.0x original speed when mouse sweeps fast', () => {
    let sample = computeHoverScrubRate(null, 10.0, 1000).nextSample;
    for (let i = 1; i <= 10; i += 1) {
      const res = computeHoverScrubRate(sample, 10.0 + i * 0.5, 1000 + i * 50);
      expect(res.direction).toBe(1);
      expect(res.rate).toBe(1.0);
      sample = res.nextSample;
    }
    expect(sample.smoothedRate).toBe(1.0);
  });

  it('reports direction -1 when moving backward along timeline', () => {
    const first = computeHoverScrubRate(null, 20.0, 1000).nextSample;
    const res = computeHoverScrubRate(first, 19.8, 1100);
    expect(res.direction).toBe(-1);
    expect(res.rate).toBeGreaterThanOrEqual(HOVER_SCRUB_MIN_RATE);
    expect(res.rate).toBeLessThanOrEqual(HOVER_SCRUB_MAX_RATE);
  });
});

describe('computePreviewTrackLoudnessScale', () => {
  it('aligns louder and quieter tracks to exact relative dB difference within [0, 0.94]', () => {
    const allGains = [0, 10]; // Track A is -16 LUFS (0dB), Track B is -26 LUFS (+10dB)
    const scaleA = computePreviewTrackLoudnessScale(0, allGains, true);
    const scaleB = computePreviewTrackLoudnessScale(10, allGains, true);

    expect(scaleB).toBeCloseTo(0.94, 4);
    expect(scaleA).toBeCloseTo(0.94 * Math.pow(10, -10 / 20), 4);
    expect(20 * Math.log10(scaleB / scaleA)).toBeCloseTo(10, 2);
  });

  it('returns uniform 0.92 when loudnessAligned is disabled', () => {
    expect(computePreviewTrackLoudnessScale(12, [0, 12], false)).toBe(0.92);
  });
});
