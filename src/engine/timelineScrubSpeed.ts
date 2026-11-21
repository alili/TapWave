export interface TimelineScrubSample {
  timeSec: number;
  perfMs: number;
  smoothedRate: number;
}

export interface TimelineScrubResult {
  /** Fixed 1.0x original-speed playback rate during hover scrub. */
  rate: number;
  /** 1 = forward, -1 = backward, 0 = stationary/initial. */
  direction: -1 | 0 | 1;
  nextSample: TimelineScrubSample;
}

export const HOVER_SCRUB_MIN_RATE = 1.0;
export const HOVER_SCRUB_MAX_RATE = 1.0;

/**
 * Tracks hover-scrub direction along the timeline while keeping playback at original 1.0x speed.
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
