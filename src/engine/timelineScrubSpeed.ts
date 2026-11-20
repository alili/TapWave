export interface TimelineScrubSample {
  timeSec: number;
  perfMs: number;
  smoothedRate: number;
}

export interface TimelineScrubResult {
  /** Clamped pitch-preserving playback rate in [0.5, 3.5]. */
  rate: number;
  /** 1 = forward, -1 = backward, 0 = stationary/initial. */
  direction: -1 | 0 | 1;
  nextSample: TimelineScrubSample;
}

export const HOVER_SCRUB_MIN_RATE = 0.5;
export const HOVER_SCRUB_MAX_RATE = 3.5;

/**
 * Computes a smoothed playback rate from mouse movement velocity along the timeline.
 * Slow movement plays back at 0.5x–1.2x for clear word-level auditioning;
 * faster sweeps accelerate smoothly up to 3.5x.
 */
export function computeHoverScrubRate(
  prevSample: TimelineScrubSample | null,
  currTimeSec: number,
  currPerfMs: number
): TimelineScrubResult {
  if (!prevSample) {
    return {
      rate: 1.0,
      direction: 0,
      nextSample: {
        timeSec: currTimeSec,
        perfMs: currPerfMs,
        smoothedRate: 1.0,
      },
    };
  }

  const dtSec = Math.max(0.012, (currPerfMs - prevSample.perfMs) / 1000);
  const deltaAudioSec = currTimeSec - prevSample.timeSec;

  if (Math.abs(deltaAudioSec) < 0.0005) {
    return {
      rate: Number(
        Math.max(HOVER_SCRUB_MIN_RATE, Math.min(HOVER_SCRUB_MAX_RATE, prevSample.smoothedRate)).toFixed(2)
      ),
      direction: 0,
      nextSample: {
        timeSec: currTimeSec,
        perfMs: currPerfMs,
        smoothedRate: prevSample.smoothedRate,
      },
    };
  }

  const instantSpeed = Math.abs(deltaAudioSec) / dtSec;
  const clampedInstant = Math.max(
    HOVER_SCRUB_MIN_RATE,
    Math.min(HOVER_SCRUB_MAX_RATE, instantSpeed)
  );
  const smoothed = prevSample.smoothedRate * 0.6 + clampedInstant * 0.4;
  const finalRate = Number(
    Math.max(HOVER_SCRUB_MIN_RATE, Math.min(HOVER_SCRUB_MAX_RATE, smoothed)).toFixed(2)
  );

  return {
    rate: finalRate,
    direction: deltaAudioSec > 0 ? 1 : -1,
    nextSample: {
      timeSec: currTimeSec,
      perfMs: currPerfMs,
      smoothedRate: finalRate,
    },
  };
}
