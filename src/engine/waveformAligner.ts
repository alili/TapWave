import {
  RecordingMode,
  SpeakerTrack,
  TranscriptBlock,
  TranscriptToken,
} from '../types/podcast';
import { HiResWaveformEnvelope } from './waveformEnvelopeLoader';

export interface TrackAcousticProfile {
  trackId: string;
  binDurationMs: number;
  noiseFloor: number;
  speechRef: number;
  onsetThreshold: number;
  valleyThreshold: number;
  activeSpeechThreshold: number;
}

function percentileFromSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const clamped = Math.max(0, Math.min(1, p));
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * clamped));
  return sorted[idx];
}

const INV_U16 = 1 / 65535;

function readHiResBinEnergy(hiRes: HiResWaveformEnvelope, binIdx: number): number {
  const base = binIdx * 3;
  const pos = hiRes.triples[base] * INV_U16;
  const neg = hiRes.triples[base + 1] * INV_U16;
  const rms = hiRes.triples[base + 2] * INV_U16;
  const pk = pos > neg ? pos : neg;
  return 0.65 * pk + 0.35 * rms;
}

/**
 * Builds a dynamic noise-floor and vocal-level acoustic profile from a track's waveform peaks
 * (preferring 5ms HiResWaveformEnvelope when available).
 * Adapts automatically to quiet microphones, loud mastered stems, or close-talk dynamic mics.
 */
export function buildTrackAcousticProfile(
  track: SpeakerTrack,
  hiRes?: HiResWaveformEnvelope
): TrackAcousticProfile {
  let samples: number[];
  let binDurationMs: number;

  if (hiRes && hiRes.numBins >= 32) {
    binDurationMs = Math.max(1, hiRes.binMs);
    const stride = Math.max(1, Math.floor(hiRes.numBins / 8192));
    samples = [];
    for (let i = 0; i < hiRes.numBins; i += stride) {
      samples.push(readHiResBinEnergy(hiRes, i));
    }
  } else {
    samples = track.peaks ?? [];
    const durationMs = Math.max(1000, track.durationMs || 60000);
    binDurationMs = samples.length > 1 ? durationMs / samples.length : 50;
  }

  if (samples.length === 0) {
    return {
      trackId: track.id,
      binDurationMs: 50,
      noiseFloor: 0.012,
      speechRef: 0.38,
      onsetThreshold: 0.065,
      valleyThreshold: 0.045,
      activeSpeechThreshold: 0.095,
    };
  }

  const sortedAll = [...samples].sort((a, b) => a - b);
  const noiseFloor = Math.max(0.003, Math.min(0.12, percentileFromSorted(sortedAll, 0.16)));

  const nonSilent = sortedAll.filter((v) => v > Math.max(0.015, noiseFloor * 1.6));
  const rawSpeechRef =
    nonSilent.length >= 4
      ? percentileFromSorted(nonSilent, 0.82)
      : percentileFromSorted(sortedAll, 0.92);
  const speechRef = Math.max(noiseFloor + 0.06, rawSpeechRef);
  const dynamicSpan = Math.max(0.04, speechRef - noiseFloor);

  return {
    trackId: track.id,
    binDurationMs,
    noiseFloor,
    speechRef,
    onsetThreshold: Math.max(noiseFloor * 1.75, noiseFloor + dynamicSpan * 0.14),
    valleyThreshold: Math.max(noiseFloor * 1.4, noiseFloor + dynamicSpan * 0.09),
    activeSpeechThreshold: Math.max(0.022, noiseFloor + dynamicSpan * 0.22),
  };
}

export function buildAcousticProfileMap(
  tracks: SpeakerTrack[],
  hiResEnvelopes?: Map<string, HiResWaveformEnvelope>
): Map<string, TrackAcousticProfile> {
  const map = new Map<string, TrackAcousticProfile>();
  for (const tr of tracks) {
    map.set(tr.id, buildTrackAcousticProfile(tr, hiResEnvelopes?.get(tr.id)));
  }
  return map;
}

/**
 * O(1) sub-bin linear interpolation of a track's real waveform peak envelope at `timelineSourceMs`.
 * Automatically accounts for `syncOffsetMs` when `recordingMode === 'multi_device_align'`.
 */
export function sampleTrackEnvelopeAtMs(
  track: SpeakerTrack | undefined,
  timelineSourceMs: number,
  recordingMode: RecordingMode = 'same_room_sync',
  hiRes?: HiResWaveformEnvelope
): number {
  if (!track) return 0;
  const offsetMs = recordingMode === 'same_room_sync' ? 0 : track.syncOffsetMs || 0;
  const trackLocalMs = timelineSourceMs - offsetMs;

  if (hiRes && hiRes.numBins >= 16) {
    if (trackLocalMs < 0 || trackLocalMs > hiRes.durationMs) return 0;
    if (hiRes.numBins === 1) return readHiResBinEnergy(hiRes, 0);
    const exactIdx = Math.max(
      0,
      Math.min(hiRes.numBins - 1, trackLocalMs / Math.max(1, hiRes.binMs))
    );
    const i0 = Math.floor(exactIdx);
    const i1 = Math.min(hiRes.numBins - 1, i0 + 1);
    const frac = exactIdx - i0;
    return readHiResBinEnergy(hiRes, i0) * (1 - frac) + readHiResBinEnergy(hiRes, i1) * frac;
  }

  if (!track.peaks || track.peaks.length === 0) return 0;
  const durMs = Math.max(100, track.durationMs || 0);
  if (durMs <= 0) return 0;
  if (trackLocalMs < 0 || trackLocalMs > durMs) return 0;

  const peaks = track.peaks;
  if (peaks.length === 1) return peaks[0];

  const exactIdx = Math.max(0, Math.min(peaks.length - 1, (trackLocalMs / durMs) * (peaks.length - 1)));
  const i0 = Math.floor(exactIdx);
  const i1 = Math.min(peaks.length - 1, i0 + 1);
  const frac = exactIdx - i0;
  return peaks[i0] * (1 - frac) + peaks[i1] * frac;
}

/**
 * Samples local peak & mean waveform statistics over `[startMs, endMs]` on a track.
 */
export function measureTrackWindowStats(
  track: SpeakerTrack | undefined,
  startMs: number,
  endMs: number,
  recordingMode: RecordingMode = 'same_room_sync',
  hiRes?: HiResWaveformEnvelope
): { peak: number; mean: number; median: number; activeRatio: number } {
  const useHiRes = Boolean(hiRes && hiRes.numBins >= 16);
  if (!track || (!useHiRes && (!track.peaks || track.peaks.length === 0)) || endMs <= startMs) {
    return { peak: 0, mean: 0, median: 0, activeRatio: 0 };
  }
  const durMs = useHiRes ? hiRes!.durationMs : Math.max(100, track.durationMs || endMs);
  const offsetMs = recordingMode === 'same_room_sync' ? 0 : track.syncOffsetMs || 0;
  const localStart = Math.max(0, startMs - offsetMs);
  const localEnd = Math.min(durMs, Math.max(localStart + 10, endMs - offsetMs));
  if (localEnd <= 0 || localStart >= durMs) {
    return { peak: 0, mean: 0, median: 0, activeRatio: 0 };
  }

  const maxIdx = useHiRes ? hiRes!.numBins - 1 : track.peaks.length - 1;
  const i0 = useHiRes
    ? Math.max(0, Math.min(maxIdx, Math.floor(localStart / Math.max(1, hiRes!.binMs))))
    : Math.max(0, Math.floor((localStart / durMs) * maxIdx));
  const i1 = useHiRes
    ? Math.max(i0, Math.min(maxIdx, Math.ceil(localEnd / Math.max(1, hiRes!.binMs))))
    : Math.min(maxIdx, Math.ceil((localEnd / durMs) * maxIdx));

  if (i1 <= i0) {
    const v = sampleTrackEnvelopeAtMs(track, (startMs + endMs) * 0.5, recordingMode, hiRes);
    return { peak: v, mean: v, median: v, activeRatio: v > 0.03 ? 1 : 0 };
  }

  const vals: number[] = [];
  let sum = 0;
  let peak = 0;
  let activeCnt = 0;
  for (let i = i0; i <= i1; i++) {
    const v = useHiRes ? readHiResBinEnergy(hiRes!, i) : track.peaks[i];
    vals.push(v);
    sum += v;
    if (v > peak) peak = v;
    if (v >= 0.035) activeCnt++;
  }
  vals.sort((a, b) => a - b);
  const cnt = vals.length;
  return {
    peak,
    mean: cnt > 0 ? sum / cnt : 0,
    median: cnt > 0 ? vals[Math.floor(cnt * 0.5)] : 0,
    activeRatio: cnt > 0 ? activeCnt / cnt : 0,
  };
}

/**
 * Returns normalized `[0..1.5]` vocal activity score for `track` around `timelineSourceMs`,
 * used by live Auto-Solo & bleed gating so real audible speech is NEVER muted/ducked!
 */
export function sampleNormalizedVocalActivity(
  track: SpeakerTrack | undefined,
  profile: TrackAcousticProfile | undefined,
  timelineSourceMs: number,
  recordingMode: RecordingMode = 'same_room_sync',
  halfWindowMs = 55
): number {
  if (!track || !profile || track.peaks.length === 0) return 0;
  const stats = measureTrackWindowStats(
    track,
    Math.max(0, timelineSourceMs - halfWindowMs),
    timelineSourceMs + halfWindowMs,
    recordingMode
  );
  const blended = stats.peak * 0.72 + stats.mean * 0.28;
  if (blended <= profile.noiseFloor * 1.25) return 0;
  const denom = Math.max(0.04, profile.speechRef - profile.noiseFloor);
  return Math.max(0, (blended - profile.noiseFloor) / denom);
}

/**
 * Checks whether anASR token on `speakerTrack` is actually microphone bleed from a much louder
 * concurrent speaker track (`> 2.6x` normalized vocal activity while this track is near its noise floor).
 */
export function isLikelyCrossTrackBleedToken(
  speakerTrack: SpeakerTrack,
  allSpeakerTracks: SpeakerTrack[],
  profiles: Map<string, TrackAcousticProfile>,
  startMs: number,
  endMs: number,
  recordingMode: RecordingMode = 'same_room_sync',
  hiResEnvelopes?: Map<string, HiResWaveformEnvelope>
): boolean {
  const myHiRes = hiResEnvelopes?.get(speakerTrack.id);
  if (allSpeakerTracks.length <= 1 || ((!myHiRes || myHiRes.numBins < 16) && speakerTrack.peaks.length < 16)) {
    return false;
  }
  const myProfile = profiles.get(speakerTrack.id);
  if (!myProfile) return false;

  const myStats = measureTrackWindowStats(speakerTrack, startMs, endMs, recordingMode, myHiRes);
  const mySpan = Math.max(0.04, myProfile.speechRef - myProfile.noiseFloor);
  const myNorm = Math.max(0, (myStats.peak * 0.65 + myStats.mean * 0.35 - myProfile.noiseFloor) / mySpan);

  // Never drop if this track clearly has strong direct vocal energy of its own
  if (myNorm >= 0.26 || myStats.peak >= myProfile.speechRef * 0.42) {
    return false;
  }

  let strongestOtherNorm = 0;
  for (const other of allSpeakerTracks) {
    const otherHiRes = hiResEnvelopes?.get(other.id);
    if (
      other.id === speakerTrack.id ||
      other.isRef ||
      ((!otherHiRes || otherHiRes.numBins < 16) && other.peaks.length < 16)
    ) {
      continue;
    }
    const otherProf = profiles.get(other.id);
    if (!otherProf) continue;
    const otherStats = measureTrackWindowStats(other, startMs, endMs, recordingMode, otherHiRes);
    const otherSpan = Math.max(0.04, otherProf.speechRef - otherProf.noiseFloor);
    const otherNorm = Math.max(
      0,
      (otherStats.peak * 0.65 + otherStats.mean * 0.35 - otherProf.noiseFloor) / otherSpan
    );
    if (otherNorm > strongestOtherNorm) {
      strongestOtherNorm = otherNorm;
    }
  }

  return strongestOtherNorm >= 0.42 && strongestOtherNorm >= Math.max(0.18, myNorm * 2.6);
}

/**
 * Checks whether a `[⏸ 空白]` silence interval actually contains audible untranscribed speech/laughter
 * on ANY non-muted speaker track (used to protect real voice from strip-silence or de-click gating).
 */
export function hasAudibleVoiceInInterval(
  tracks: SpeakerTrack[],
  profiles: Map<string, TrackAcousticProfile>,
  startMs: number,
  endMs: number,
  recordingMode: RecordingMode = 'same_room_sync',
  hiResEnvelopes?: Map<string, HiResWaveformEnvelope>
): boolean {
  const speakerTracks = tracks.some((t) => !t.isRef) ? tracks.filter((t) => !t.isRef) : tracks;
  if (endMs - startMs < 120) return false;

  for (const tr of speakerTracks) {
    const hiRes = hiResEnvelopes?.get(tr.id);
    if (tr.muted || ((!hiRes || hiRes.numBins < 16) && tr.peaks.length < 16)) continue;
    const prof = profiles.get(tr.id) ?? buildTrackAcousticProfile(tr, hiRes);
    const stats = measureTrackWindowStats(tr, startMs + 35, endMs - 35, recordingMode, hiRes);
    const span = Math.max(0.04, prof.speechRef - prof.noiseFloor);
    const normMean = (stats.mean - prof.noiseFloor) / span;
    const normPeak = (stats.peak - prof.noiseFloor) / span;
    // Sustained vocal presence (distinguishes real missed speech/laughter from a brief 1-bin click!)
    if (normMean >= 0.24 && normPeak >= 0.36 && stats.activeRatio >= 0.35) {
      return true;
    }
  }
  return false;
}

/**
 * Snaps a word/laughter token's `[startMs, endMs]` to the real acoustic vocal onset & offset
 * in `track.peaks` at `10ms` scan resolution:
 *  1. Removes leading silence lag (e.g., when a previous `<450ms` pause was merged into `startMs`)
 *  2. Captures clipped consonant onsets up to `90ms` before `startMs` (bounded by `minStartMs`)
 *  3. Trims trailing dead silence attached to the end of a word
 *  4. Extends clipped final vowel/nasal tails up to `130ms` (bounded by `maxEndMs`)
 */
export function snapTokenBoundsToWaveform(
  rawStartMs: number,
  rawEndMs: number,
  minStartMs: number,
  maxEndMs: number,
  track: SpeakerTrack | undefined,
  profile: TrackAcousticProfile | undefined,
  recordingMode: RecordingMode = 'same_room_sync',
  hiRes?: HiResWaveformEnvelope
): { startMs: number; endMs: number } {
  const safeStart = Math.max(minStartMs, rawStartMs);
  const safeEnd = Math.min(maxEndMs, Math.max(safeStart + 50, rawEndMs));

  const hasHiRes = Boolean(hiRes && hiRes.numBins >= 32);
  // Only refine when we have sufficiently fine real waveform peaks (<= ~85ms per bin) or hiRes envelope
  if (
    !track ||
    !profile ||
    (!hasHiRes && (track.peaks.length < 32 || profile.binDurationMs > 90)) ||
    safeEnd - safeStart < 60
  ) {
    return { startMs: safeStart, endMs: safeEnd };
  }

  const stepMs = hasHiRes && hiRes!.binMs <= 10 ? 5 : 10;
  // Measure peak inside the candidate word window (+ small search margin) to calibrate local threshold
  const innerStats = measureTrackWindowStats(
    track,
    Math.max(minStartMs, safeStart - 50),
    Math.min(maxEndMs, safeEnd + 60),
    recordingMode,
    hiRes
  );

  // If the entire region is quiet (e.g. very soft whisper), preserve original ASR timestamps safely
  if (innerStats.peak < profile.onsetThreshold * 1.1) {
    return { startMs: safeStart, endMs: safeEnd };
  }

  const localSpan = Math.max(0.025, innerStats.peak - profile.noiseFloor);
  const localOnsetThresh = Math.max(
    profile.noiseFloor * 1.45,
    Math.min(profile.onsetThreshold * 1.25, profile.noiseFloor + localSpan * 0.18)
  );
  const localTailThresh = Math.max(
    profile.noiseFloor * 1.3,
    Math.min(profile.valleyThreshold * 1.25, profile.noiseFloor + localSpan * 0.13)
  );

  let refinedStart = safeStart;
  let refinedEnd = safeEnd;

  const envAtStart = sampleTrackEnvelopeAtMs(track, safeStart, recordingMode, hiRes);
  if (envAtStart < localOnsetThresh) {
    // Leading edge is currently sitting in silence -> scan forward inside token to find real vocal onset!
    const maxForwardMs = Math.min(safeEnd - 65, safeStart + 440);
    let foundRiseMs: number | null = null;
    for (let t = safeStart; t <= maxForwardMs; t += stepMs) {
      if (sampleTrackEnvelopeAtMs(track, t, recordingMode, hiRes) >= localOnsetThresh) {
        foundRiseMs = t;
        break;
      }
    }
    if (foundRiseMs !== null && foundRiseMs > safeStart + 15) {
      // Leave 18ms natural consonant pre-roll before threshold crossing
      refinedStart = Math.max(safeStart, foundRiseMs - 18);
    }
  } else {
    // Energy is ALREADY high at `safeStart` -> CTC peak likely fired after consonant onset!
    // Scan backward up to 90ms (bounded by `minStartMs`) to find the valley where the consonant started.
    const lookbackLimit = Math.max(minStartMs, safeStart - 90);
    let onsetValleyMs = safeStart;
    for (let t = safeStart - stepMs; t >= lookbackLimit; t -= stepMs) {
      const v = sampleTrackEnvelopeAtMs(track, t, recordingMode, hiRes);
      if (v < localOnsetThresh) {
        onsetValleyMs = Math.max(lookbackLimit, t);
        break;
      }
      onsetValleyMs = t;
    }
    refinedStart = onsetValleyMs;
  }

  // Now refine trailing edge `refinedEnd`
  const minWordDurMs = 65;
  const envAtEnd = sampleTrackEnvelopeAtMs(track, refinedEnd, recordingMode, hiRes);
  if (envAtEnd < localTailThresh && refinedEnd - refinedStart > 130) {
    // Trailing edge sits in silence -> scan backward to find where voice actually finished
    const minBackLimit = Math.max(refinedStart + minWordDurMs, refinedEnd - 440);
    let lastActiveMs: number | null = null;
    for (let t = refinedEnd; t >= minBackLimit; t -= stepMs) {
      if (sampleTrackEnvelopeAtMs(track, t, recordingMode, hiRes) >= localTailThresh) {
        lastActiveMs = t;
        break;
      }
    }
    if (lastActiveMs !== null) {
      // Keep 24ms gentle vocal release tail
      refinedEnd = Math.min(refinedEnd, Math.max(refinedStart + minWordDurMs, lastActiveMs + 24));
    }
  } else if (envAtEnd >= localTailThresh) {
    // Voice is still ringing at `refinedEnd` -> scan forward up to 130ms (bounded by `maxEndMs`)
    // until hitting an acoustic valley so syllable endings are never clipped!
    const lookaheadLimit = Math.min(maxEndMs, refinedEnd + 130);
    let tailEndMs = refinedEnd;
    for (let t = refinedEnd + stepMs; t <= lookaheadLimit; t += stepMs) {
      const v = sampleTrackEnvelopeAtMs(track, t, recordingMode, hiRes);
      if (v < localTailThresh) {
        tailEndMs = Math.min(lookaheadLimit, t + 12);
        break;
      }
      tailEndMs = t;
    }
    refinedEnd = Math.max(refinedEnd, tailEndMs);
  }

  if (refinedEnd - refinedStart < 55) {
    refinedEnd = Math.min(maxEndMs, refinedStart + 55);
  }

  return {
    startMs: Math.round(refinedStart),
    endMs: Math.round(Math.max(refinedStart + 45, refinedEnd)),
  };
}

/**
 * Non-destructively refines word/laughter token boundaries across `TranscriptBlock[]` using
 * each speaker track's real waveform envelope (`track.peaks`), while keeping adjacent `silence`
 * tokens contiguous and preserving all user edits (`deleted`, `subwordTrimmed`, `durationSec` compressions).
 */
export function refineProjectBlocksWithWaveform(
  blocks: TranscriptBlock[],
  tracks: SpeakerTrack[],
  recordingMode: RecordingMode = 'same_room_sync',
  hiResEnvelopes?: Map<string, HiResWaveformEnvelope>
): TranscriptBlock[] {
  if (blocks.length === 0 || tracks.length === 0) return blocks;
  const hasRealPeaks = tracks.some(
    (t) =>
      (hiResEnvelopes?.get(t.id)?.numBins ?? 0) >= 32 ||
      ((t.peaks?.length ?? 0) >= 32 && (t.durationMs ?? 0) > 0)
  );
  if (!hasRealPeaks) return blocks;

  const trackMap = new Map<string, SpeakerTrack>(tracks.map((t) => [t.id, t]));
  const profiles = buildAcousticProfileMap(tracks, hiResEnvelopes);

  // Flatten references to non-deleted tokens in timeline order to enforce strict non-overlapping bounds
  interface FlatRef {
    bIdx: number;
    tIdx: number;
    speakerId: string;
    tok: TranscriptToken;
  }
  const flat: FlatRef[] = [];
  blocks.forEach((b, bIdx) => {
    b.tokens.forEach((tok, tIdx) => {
      if (!tok.deleted) {
        flat.push({ bIdx, tIdx, speakerId: b.speakerId, tok });
      }
    });
  });

  if (flat.length === 0) return blocks;

  const clonedBlocks: TranscriptBlock[] = blocks.map((b) => ({
    ...b,
    tokens: b.tokens.map((t) => ({ ...t })),
  }));

  // Pass 1: Snap non-trimmed word & laughter tokens to real vocal waveform onsets/offsets
  for (let i = 0; i < flat.length; i++) {
    const ref = flat[i];
    const targetTok = clonedBlocks[ref.bIdx].tokens[ref.tIdx];
    if (
      targetTok.type === 'silence' ||
      targetTok.subwordTrimmed ||
      typeof targetTok.gapBeforeSec === 'number' ||
      targetTok.text.startsWith('[语音 ') ||
      targetTok.text.startsWith('[音轨片段')
    ) {
      continue;
    }

    const tr = trackMap.get(ref.speakerId);
    const prof = profiles.get(ref.speakerId);
    const hiRes = hiResEnvelopes?.get(ref.speakerId);
    if (!tr || !prof || ((!hiRes || hiRes.numBins < 32) && tr.peaks.length < 32)) continue;

    const prevRef = i > 0 ? flat[i - 1] : null;
    const nextRef = i + 1 < flat.length ? flat[i + 1] : null;
    const prevTok = prevRef ? clonedBlocks[prevRef.bIdx].tokens[prevRef.tIdx] : null;
    const nextTok = nextRef ? clonedBlocks[nextRef.bIdx].tokens[nextRef.tIdx] : null;

    // Allow onset lookback into an adjacent uncompressed silence token, or up to previous word's endMs
    const minStartMs = prevTok
      ? prevTok.type === 'silence'
        ? Math.max(prevTok.sourceStartMs + 60, targetTok.sourceStartMs - 90)
        : prevTok.sourceEndMs
      : 0;

    // Allow tail extension into an adjacent silence token, or up to next word's raw startMs
    const trackMaxMs = tr.durationMs && tr.durationMs > 0 ? tr.durationMs : Infinity;
    const maxEndMs = Math.min(
      trackMaxMs,
      nextTok
        ? typeof nextTok.gapBeforeSec === 'number'
          ? targetTok.sourceEndMs
          : nextTok.type === 'silence'
            ? Math.min(nextTok.sourceEndMs - 60, targetTok.sourceEndMs + 130)
            : Math.max(targetTok.sourceEndMs, nextTok.sourceStartMs)
        : targetTok.sourceEndMs + 160
    );

    if (maxEndMs <= minStartMs + 50) continue;

    const snapped = snapTokenBoundsToWaveform(
      targetTok.sourceStartMs,
      targetTok.sourceEndMs,
      minStartMs,
      maxEndMs,
      tr,
      prof,
      recordingMode,
      hiRes
    );

    if (
      snapped.startMs !== targetTok.sourceStartMs ||
      snapped.endMs !== targetTok.sourceEndMs
    ) {
      const newDur = Number(((snapped.endMs - snapped.startMs) / 1000).toFixed(3));
      targetTok.sourceStartMs = snapped.startMs;
      targetTok.sourceEndMs = snapped.endMs;
      targetTok.durationSec = Math.max(0.045, newDur);
      targetTok.origDurationSec = Math.max(0.045, newDur);
    }
  }

  // Pass 2: Re-stitch explicit `silence` tokens cleanly to adjacent snapped word boundaries
  // (preserving user's shortened `durationSec` ratio if pause was compressed!)
  for (let i = 0; i < flat.length; i++) {
    const ref = flat[i];
    const silTok = clonedBlocks[ref.bIdx].tokens[ref.tIdx];
    if (silTok.type !== 'silence' || silTok.subwordTrimmed) continue;

    const prevRef = i > 0 ? flat[i - 1] : null;
    const nextRef = i + 1 < flat.length ? flat[i + 1] : null;
    const prevTok = prevRef ? clonedBlocks[prevRef.bIdx].tokens[prevRef.tIdx] : null;
    const nextTok = nextRef ? clonedBlocks[nextRef.bIdx].tokens[nextRef.tIdx] : null;

    const wasCompressed = Math.abs(silTok.durationSec - silTok.origDurationSec) > 0.04;
    const newSilStart = prevTok ? prevTok.sourceEndMs : silTok.sourceStartMs;
    const newSilEnd = nextTok ? Math.max(newSilStart + 50, nextTok.sourceStartMs) : silTok.sourceEndMs;
    const newOrigDur = Number(((newSilEnd - newSilStart) / 1000).toFixed(3));

    if (newOrigDur >= 0.05) {
      silTok.sourceStartMs = newSilStart;
      silTok.sourceEndMs = newSilEnd;
      silTok.origDurationSec = newOrigDur;
      silTok.durationSec = wasCompressed ? Math.min(silTok.durationSec, newOrigDur) : newOrigDur;
    }

    // Clear any false mouthClickCleaned flag if this pause actually contains audible vocal speech!
    if (
      silTok.mouthClickCleaned &&
      hasAudibleVoiceInInterval(
        tracks,
        profiles,
        silTok.sourceStartMs,
        silTok.sourceEndMs,
        recordingMode,
        hiResEnvelopes
      )
    ) {
      silTok.mouthClickCleaned = false;
      silTok.trackMuted = false;
    }
  }

  return clonedBlocks;
}
