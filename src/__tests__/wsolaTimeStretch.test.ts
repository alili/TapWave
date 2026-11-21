import { describe, expect, it } from 'vitest';
import { wsolaStretchChannel } from '../engine/wsolaTimeStretch';

function estimateFreqHz(samples: Float32Array, sampleRate: number, startIdx = 2000, len = 8000): number {
  let crossings = 0;
  const end = Math.min(samples.length - 1, startIdx + len);
  for (let i = startIdx; i < end; i++) {
    if (samples[i] <= 0 && samples[i + 1] > 0) {
      crossings++;
    }
  }
  const durSec = (end - startIdx) / sampleRate;
  return crossings / durSec;
}

describe('wsolaStretchChannel', () => {
  it('returns the original buffer reference near 1.0x', () => {
    const input = new Float32Array(4000);
    expect(wsolaStretchChannel(input, 48000, 1.0)).toBe(input);
    expect(wsolaStretchChannel(input, 48000, 1.01)).toBe(input);
  });

  it('scales duration accurately and preserves vocal pitch at 1.5x, 2.0x, and 0.75x', () => {
    const sampleRate = 48000;
    const durationSec = 1.0;
    const targetFreq = 180;
    const input = new Float32Array(sampleRate * durationSec);
    for (let i = 0; i < input.length; i++) {
      input[i] = 0.6 * Math.sin((2 * Math.PI * targetFreq * i) / sampleRate);
    }

    for (const rate of [0.75, 1.5, 2.0]) {
      const out = wsolaStretchChannel(input, sampleRate, rate);
      expect(out.length).toBe(Math.round(input.length / rate));

      let maxAbs = 0;
      for (let i = 0; i < out.length; i++) {
        expect(Number.isFinite(out[i])).toBe(true);
        const abs = Math.abs(out[i]);
        if (abs > maxAbs) maxAbs = abs;
      }
      expect(maxAbs).toBeGreaterThan(0.3);
      expect(maxAbs).toBeLessThanOrEqual(1.1);

      const estFreq = estimateFreqHz(out, sampleRate, 1500, Math.min(6000, out.length - 2000));
      expect(Math.abs(estFreq - targetFreq)).toBeLessThan(12);
    }
  });

  it('handles silent regions cleanly without NaNs', () => {
    const input = new Float32Array(24000);
    const out = wsolaStretchChannel(input, 48000, 1.5);
    expect(out.length).toBe(16000);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(0);
    }
  });
});
