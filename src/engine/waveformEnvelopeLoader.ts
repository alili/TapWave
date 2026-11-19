import { extractFilePathFromPodAudioUrl, getNativeAudioServerPort } from '../data/emptyProject';
import { SpeakerTrack } from '../types/podcast';

export interface TrackAcousticCalibration {
  noiseFloorPeak: number;
  noiseFloorRms: number;
  p95Peak: number;
  p992Peak: number;
}

export interface HiResWaveformEnvelope extends TrackAcousticCalibration {
  binMs: number;
  numBins: number;
  durationMs: number;
  /** Interleaved [posPeak16, negPeak16, rms16] per bin, length = numBins * 3 */
  triples: Uint16Array;
}

export interface SampledBipolarPoint {
  posPeak: number; // calibrated [0..0.98]
  negPeak: number; // calibrated [0..0.98]
  rms: number; // calibrated [0..0.92]
  rawPeak: number; // uncalibrated [0..1]
}

const INV_U16_MAX = 1 / 65535;
const envelopeCache = new Map<string, HiResWaveformEnvelope>();
const inFlightMap = new Map<string, Promise<HiResWaveformEnvelope | null>>();

function sortedPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function calibrateBins(peakSamples: number[], rmsSamples: number[]): TrackAcousticCalibration {
  if (peakSamples.length === 0) {
    return {
      noiseFloorPeak: 0.01,
      noiseFloorRms: 0.006,
      p95Peak: 0.55,
      p992Peak: 0.72,
    };
  }
  const sortedPeak = [...peakSamples].sort((a, b) => a - b);
  const sortedRms = [...rmsSamples].sort((a, b) => a - b);

  const noiseFloorPeak = sortedPercentile(sortedPeak, 0.18);
  const noiseFloorRms = sortedPercentile(sortedRms, 0.18);
  const voiceGate = Math.max(0.01, noiseFloorPeak * 2.4);
  const voicedSorted = sortedPeak.filter((v) => v > voiceGate);

  const p95Peak =
    voicedSorted.length >= 8
      ? sortedPercentile(voicedSorted, 0.95)
      : Math.max(0.05, sortedPercentile(sortedPeak, 0.95));
  const p992Peak =
    voicedSorted.length >= 8
      ? Math.max(p95Peak, sortedPercentile(voicedSorted, 0.988))
      : Math.max(0.08, p95Peak, sortedPercentile(sortedPeak, 0.988));

  return {
    noiseFloorPeak,
    noiseFloorRms,
    p95Peak,
    p992Peak,
  };
}

/**
 * Parses a binary WENV v1 stream:
 *   Header (16B LE): "WENV", version=1 (u32), bin_ms (u32), num_bins (u32)
 *   Payload (num_bins * 6B LE): interleaved [pos_u16, neg_u16, rms_u16]
 */
export function parseWaveformEnvelopeBinary(buffer: ArrayBuffer): HiResWaveformEnvelope | null {
  if (buffer.byteLength < 22) return null;
  const view = new DataView(buffer);
  // Magic ASCII "WENV"
  if (
    view.getUint8(0) !== 0x57 ||
    view.getUint8(1) !== 0x45 ||
    view.getUint8(2) !== 0x4e ||
    view.getUint8(3) !== 0x56
  ) {
    return null;
  }
  const version = view.getUint32(4, true);
  const binMs = view.getUint32(8, true);
  const numBins = view.getUint32(12, true);
  if (version !== 1 || binMs === 0 || numBins === 0) return null;
  if (buffer.byteLength < 16 + numBins * 6) return null;

  const triples = new Uint16Array(numBins * 3);
  const sampleStride = Math.max(1, Math.floor(numBins / 8192));
  const peakSamples: number[] = [];
  const rmsSamples: number[] = [];

  for (let i = 0; i < numBins; i++) {
    const byteOff = 16 + i * 6;
    const posU16 = view.getUint16(byteOff, true);
    const negU16 = view.getUint16(byteOff + 2, true);
    const rmsU16 = view.getUint16(byteOff + 4, true);
    const base = i * 3;
    triples[base] = posU16;
    triples[base + 1] = negU16;
    triples[base + 2] = rmsU16;

    if (i % sampleStride === 0) {
      peakSamples.push(Math.max(posU16, negU16) * INV_U16_MAX);
      rmsSamples.push(rmsU16 * INV_U16_MAX);
    }
  }

  const cal = calibrateBins(peakSamples, rmsSamples);
  return {
    ...cal,
    binMs,
    numBins,
    durationMs: numBins * binMs,
    triples,
  };
}

export function computeLegacyPeaksCalibration(peaks: number[]): TrackAcousticCalibration {
  if (!peaks || peaks.length === 0) {
    return calibrateBins([], []);
  }
  const stride = Math.max(1, Math.floor(peaks.length / 8192));
  const peakSamples: number[] = [];
  const rmsSamples: number[] = [];
  for (let i = 0; i < peaks.length; i += stride) {
    const v = Math.max(0, Math.min(1, peaks[i] || 0));
    peakSamples.push(v);
    rmsSamples.push(v * 0.62);
  }
  return calibrateBins(peakSamples, rmsSamples);
}

function buildWaveformEnvelopeUrl(localPath: string): string {
  const qs = `path=${encodeURIComponent(localPath)}`;
  const port = getNativeAudioServerPort();
  if (port > 0) {
    return `http://127.0.0.1:${port}/waveform-envelope?${qs}`;
  }
  if (
    typeof window !== 'undefined' &&
    (window.location.protocol === 'http:' || window.location.protocol === 'https:') &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ) {
    return `/api/waveform-envelope?${qs}`;
  }
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (isTauri) {
    return `http://127.0.0.1:19847/waveform-envelope?${qs}`;
  }
  return `/api/waveform-envelope?${qs}`;
}

async function decodeBlobToHiResEnvelope(
  blobUrl: string,
  binMs = 5
): Promise<HiResWaveformEnvelope | null> {
  if (typeof window === 'undefined') return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;

  const resp = await fetch(blobUrl);
  if (!resp.ok) return null;
  const arrBuf = await resp.arrayBuffer();
  const ctx = new AudioCtx();
  try {
    const audioBuf = await ctx.decodeAudioData(arrBuf);
    const ch0 = audioBuf.getChannelData(0);
    const ch1 = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : null;
    const binSamples = Math.max(1, Math.round((audioBuf.sampleRate * binMs) / 1000));
    const numBins = Math.max(1, Math.ceil(ch0.length / binSamples));
    const triples = new Uint16Array(numBins * 3);
    const sampleStride = Math.max(1, Math.floor(numBins / 8192));
    const peakSamples: number[] = [];
    const rmsSamples: number[] = [];

    for (let b = 0; b < numBins; b++) {
      const start = b * binSamples;
      const end = Math.min(ch0.length, start + binSamples);
      let posMax = 0;
      let negMax = 0;
      let sumSq = 0;
      const cnt = Math.max(1, end - start);
      for (let i = start; i < end; i++) {
        const s = ch1 ? 0.5 * (ch0[i] + ch1[i]) : ch0[i];
        if (s > posMax) posMax = s;
        if (-s > negMax) negMax = -s;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / cnt);
      const base = b * 3;
      triples[base] = Math.min(65535, Math.max(0, Math.round(posMax * 65535)));
      triples[base + 1] = Math.min(65535, Math.max(0, Math.round(negMax * 65535)));
      triples[base + 2] = Math.min(65535, Math.max(0, Math.round(rms * 65535)));
      if (b % sampleStride === 0) {
        peakSamples.push(Math.max(posMax, negMax));
        rmsSamples.push(rms);
      }
    }

    const cal = calibrateBins(peakSamples, rmsSamples);
    return {
      ...cal,
      binMs,
      numBins,
      durationMs: Math.round(audioBuf.duration * 1000),
      triples,
    };
  } finally {
    if (ctx.state !== 'closed') {
      void ctx.close().catch(() => {});
    }
  }
}

export async function loadTrackHiResEnvelope(
  track: Pick<SpeakerTrack, 'id' | 'filePath' | 'audioUrl' | 'durationMs'>
): Promise<HiResWaveformEnvelope | null> {
  const localPath = track.filePath || extractFilePathFromPodAudioUrl(track.audioUrl);
  const cacheKey = localPath || track.audioUrl;
  if (!cacheKey) return null;

  const cached = envelopeCache.get(cacheKey);
  if (cached) return cached;

  const pending = inFlightMap.get(cacheKey);
  if (pending) return pending;

  const job = (async (): Promise<HiResWaveformEnvelope | null> => {
    try {
      if (localPath) {
        const url = buildWaveformEnvelopeUrl(localPath);
        const resp = await fetch(url);
        if (resp.ok) {
          const buf = await resp.arrayBuffer();
          const parsed = parseWaveformEnvelopeBinary(buf);
          if (parsed) {
            if (track.durationMs && track.durationMs > 0) {
              parsed.durationMs = track.durationMs;
            }
            envelopeCache.set(cacheKey, parsed);
            return parsed;
          }
        }
      }
      if (track.audioUrl?.startsWith('blob:')) {
        const env = await decodeBlobToHiResEnvelope(track.audioUrl, 5);
        if (env) {
          envelopeCache.set(cacheKey, env);
          return env;
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      inFlightMap.delete(cacheKey);
    }
  })();

  inFlightMap.set(cacheKey, job);
  return job;
}

export function computeTrackLinearGain(autoGainDb: number, loudnessAligned: boolean): number {
  if (!loudnessAligned) return 1.0;
  return Math.pow(10, Math.max(-12, Math.min(16, autoGainDb || 0)) / 20);
}

export function computeSharedReferenceCeiling(
  items: Array<{ p992Peak: number; gainLinear: number }>
): number {
  const maxScaled = items.reduce(
    (mx, it) => Math.max(mx, Math.max(0, it.p992Peak) * Math.max(0, it.gainLinear)),
    0
  );
  return Math.max(0.16, maxScaled * 1.06);
}

/**
 * Downward noise-floor expander + proportional linear loudness scaling + soft upper shoulder (>0.88).
 * Collapses room hiss / reverb tails into flat gaps while preserving 1:1 relative speech dynamics.
 */
export function mapCalibratedAmplitude(
  rawVal: number,
  gainLinear: number,
  noiseFloor: number,
  sharedRefCeiling: number
): number {
  const safeVal = Math.max(0, rawVal);
  if (safeVal <= 0) return 0;

  const kneeLow = Math.max(0.0025, noiseFloor * 1.3);
  const kneeHigh = Math.max(0.006, noiseFloor * 2.8);

  let gated: number;
  if (safeVal <= kneeLow) {
    gated = safeVal * 0.05;
  } else if (safeVal < kneeHigh && kneeHigh > kneeLow) {
    const t = (safeVal - kneeLow) / (kneeHigh - kneeLow);
    gated = safeVal * (0.05 + 0.95 * t * t);
  } else {
    gated = safeVal;
  }

  const norm = (gated * gainLinear) / Math.max(0.05, sharedRefCeiling);
  if (norm <= 0.88) return norm;
  return 0.88 + 0.1 * Math.tanh((norm - 0.88) / 0.18);
}

/**
 * Valley-preserving bipolar waveform + true RMS sampler supporting both 5ms `WENV` binary
 * envelopes (preferred) and legacy `peaks` arrays.
 */
export function sampleCalibratedWaveformPoint(
  hiRes: HiResWaveformEnvelope | undefined,
  legacyPeaks: number[],
  sourceRatio: number,
  halfWindowRatio: number,
  gainLinear: number,
  calibration: TrackAcousticCalibration,
  sharedRefCeiling: number
): SampledBipolarPoint {
  const useHiRes = Boolean(hiRes && hiRes.numBins > 0);
  const numBins = useHiRes ? hiRes!.numBins : legacyPeaks.length;
  if (numBins === 0) {
    return { posPeak: 0, negPeak: 0, rms: 0, rawPeak: 0 };
  }

  const maxIdx = numBins - 1;
  const center = Math.max(0, Math.min(0.999999, sourceRatio)) * maxIdx;
  const halfBins = Math.max(0, halfWindowRatio * maxIdx);

  let rawPos = 0;
  let rawNeg = 0;
  let rawRms = 0;

  if (halfBins <= 0.65) {
    // Sub-bin / character zoom: strict linear interpolation, never dilating neighbor bins
    const i0 = Math.floor(center);
    const i1 = Math.min(maxIdx, i0 + 1);
    const frac = center - i0;
    if (useHiRes) {
      const t = hiRes!.triples;
      const b0 = i0 * 3;
      const b1 = i1 * 3;
      rawPos = (t[b0] * (1 - frac) + t[b1] * frac) * INV_U16_MAX;
      rawNeg = (t[b0 + 1] * (1 - frac) + t[b1 + 1] * frac) * INV_U16_MAX;
      rawRms = (t[b0 + 2] * (1 - frac) + t[b1 + 2] * frac) * INV_U16_MAX;
    } else {
      const v = legacyPeaks[i0] * (1 - frac) + legacyPeaks[i1] * frac;
      rawPos = v;
      rawNeg = v;
      rawRms = v * 0.62;
    }
  } else {
    // Multi-bin / sentence & overview zoom: non-overlapping pixel bin range
    const b0 = Math.max(0, Math.min(maxIdx, Math.round(center - halfBins)));
    const b1 = Math.max(
      b0,
      Math.min(maxIdx, Math.round(center + halfBins) - (halfBins >= 1 ? 1 : 0))
    );
    let minPeak = Infinity;
    let sumRmsSq = 0;
    let cnt = 0;

    if (useHiRes) {
      const t = hiRes!.triples;
      for (let b = b0; b <= b1; b++) {
        const base = b * 3;
        const p = t[base] * INV_U16_MAX;
        const n = t[base + 1] * INV_U16_MAX;
        const r = t[base + 2] * INV_U16_MAX;
        if (p > rawPos) rawPos = p;
        if (n > rawNeg) rawNeg = n;
        const binPk = p > n ? p : n;
        if (binPk < minPeak) minPeak = binPk;
        sumRmsSq += r * r;
        cnt++;
      }
    } else {
      for (let b = b0; b <= b1; b++) {
        const v = Math.max(0, legacyPeaks[b] || 0);
        if (v > rawPos) rawPos = v;
        if (v > rawNeg) rawNeg = v;
        if (v < minPeak) minPeak = v;
        const r = v * 0.62;
        sumRmsSq += r * r;
        cnt++;
      }
    }

    rawRms = cnt > 0 ? Math.sqrt(sumRmsSq / cnt) : 0;

    // Sub-pixel gap straddle notch: carve inter-character closures that span part of a column
    const maxPeak = Math.max(rawPos, rawNeg);
    if (halfBins <= 5.5 && maxPeak > 1e-5 && Number.isFinite(minPeak)) {
      const valleyRatio = minPeak / maxPeak;
      if (valleyRatio < 0.25) {
        const weight = (0.25 - valleyRatio) / 0.25;
        const notchKeep = 0.34 + 0.66 * Math.min(1, (rawRms / maxPeak) * 1.15);
        const scale = 1 - weight + weight * notchKeep;
        rawPos *= scale;
        rawNeg *= scale;
      }
    }
  }

  const rawPeak = Math.max(rawPos, rawNeg);
  const posPeak = mapCalibratedAmplitude(
    rawPos,
    gainLinear,
    calibration.noiseFloorPeak,
    sharedRefCeiling
  );
  const negPeak = mapCalibratedAmplitude(
    rawNeg,
    gainLinear,
    calibration.noiseFloorPeak,
    sharedRefCeiling
  );
  const rmsMapped = mapCalibratedAmplitude(
    rawRms,
    gainLinear,
    calibration.noiseFloorRms,
    sharedRefCeiling
  );
  const rms = Math.min(rmsMapped, Math.max(posPeak, negPeak) * 0.92);

  return { posPeak, negPeak, rms, rawPeak };
}
