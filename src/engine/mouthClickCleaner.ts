import { PodcastProjectState, SpeakerTrack, TranscriptBlock } from '../types/podcast';
import { buildAcousticProfileMap, hasAudibleVoiceInInterval } from './waveformAligner';

const MOUTH_CLICK_WORDS = new Set([
  '啧',
  '啧啧',
  '嘶',
  '啪',
  '吸气',
  '[口水音]',
  '[唇齿音]',
  '[吸气]',
  '[咂嘴]',
]);

export interface MouthClickCleanResult {
  nextBlocks: TranscriptBlock[];
  deletedMouthTokens: number;
  mutedPauseClicks: number;
  totalCleanedCount: number;
}

function normalizeTokenPlainText(raw: string): string {
  return raw.replace(/[，。？！、；：,.?!—…~\s]+/g, '').trim();
}

function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

/**
 * Inspects a track's peak envelope within [startMs, endMs] to detect isolated impulsive
 * mouth-clicks / wet lip-smacks occurring inside a pause/breath interval.
 */
function hasPauseMouthClickImpulse(
  track: SpeakerTrack | undefined,
  startMs: number,
  endMs: number,
  trackSpeechRef: number
): boolean {
  if (!track || !track.peaks || track.peaks.length < 8) return false;
  const totalDurMs = Math.max(1000, track.durationMs || endMs || 1000);
  const offset = track.syncOffsetMs || 0;
  const localStart = Math.max(0, startMs - offset);
  const localEnd = Math.max(localStart + 40, endMs - offset);

  const i0 = Math.max(0, Math.floor((localStart / totalDurMs) * (track.peaks.length - 1)));
  const i1 = Math.min(
    track.peaks.length - 1,
    Math.ceil((localEnd / totalDurMs) * (track.peaks.length - 1))
  );
  if (i1 < i0) return false;

  const slice = track.peaks.slice(i0, i1 + 1);
  if (slice.length === 0) return false;

  let maxVal = 0;
  for (const v of slice) {
    if (v > maxVal) maxVal = v;
  }

  // Single-bin or multi-bin silence window: compare peak spike against median floor & speech level.
  // Rejects sustained speech (where >= 32% of bins are loud or median is elevated)!
  const sorted = [...slice].sort((a, b) => a - b);
  const medianVal = computePercentile(sorted, 0.5);
  const activeBins = slice.filter((v) => v >= Math.max(0.05, trackSpeechRef * 0.25)).length;

  if (slice.length >= 3) {
    // True isolated transient click: sharp spike above quiet pause floor, occupying < 30% of pause bins
    return (
      activeBins <= Math.max(2, Math.floor(slice.length * 0.28)) &&
      medianVal <= Math.max(0.045, trackSpeechRef * 0.22) &&
      maxVal >= 0.028 &&
      maxVal >= Math.max(medianVal * 1.95, medianVal + 0.022) &&
      maxVal <= Math.max(0.52, trackSpeechRef * 0.85)
    );
  }

  // Narrow pause window: detect brief lip-smack residual below full speech level
  return maxVal >= 0.035 && maxVal <= Math.max(0.38, trackSpeechRef * 0.65);
}

/**
 * Scans all blocks and speaker tracks to clean:
 * 1. Explicit ASR mouth-click / saliva / sharp-inhale tokens ('啧', '嘶', '[口水音]', etc.)
 * 2. Impulsive lip-smack / saliva click spikes inside inter-phrase silence capsules (muted cleanly)
 */
export function scanAndCleanMouthClicks(
  state: PodcastProjectState,
  speakerFilterId?: string
): MouthClickCleanResult {
  const trackMap = new Map<string, SpeakerTrack>();
  const trackSpeechRefMap = new Map<string, number>();
  const profiles = buildAcousticProfileMap(state.tracks);

  for (const tr of state.tracks) {
    trackMap.set(tr.id, tr);
    const sorted = [...(tr.peaks ?? [])].filter((v) => v > 0.01).sort((a, b) => a - b);
    trackSpeechRefMap.set(tr.id, Math.max(0.25, computePercentile(sorted, 0.75)));
  }

  let deletedMouthTokens = 0;
  let mutedPauseClicks = 0;

  const nextBlocks: TranscriptBlock[] = state.blocks.map((block) => {
    if (speakerFilterId && speakerFilterId !== 'all' && block.speakerId !== speakerFilterId) {
      return block;
    }

    const track = trackMap.get(block.speakerId);
    const speechRef = trackSpeechRefMap.get(block.speakerId) ?? 0.5;
    let blockChanged = false;

    const nextTokens = block.tokens.map((tok) => {
      if (tok.deleted) return tok;

      if (tok.type === 'word') {
        const plain = normalizeTokenPlainText(tok.text);
        if (
          (MOUTH_CLICK_WORDS.has(plain) || MOUTH_CLICK_WORDS.has(tok.text.trim())) &&
          tok.durationSec <= 0.75
        ) {
          deletedMouthTokens++;
          blockChanged = true;
          return {
            ...tok,
            deleted: true,
            mouthClickCleaned: true,
          };
        }
      }

      if (tok.type === 'silence' && !tok.trackMuted && tok.durationSec >= 0.25) {
        // Never flag a pause if any track has audible untranscribed speech/laughter inside it!
        if (
          !hasAudibleVoiceInInterval(
            state.tracks,
            profiles,
            tok.sourceStartMs,
            tok.sourceEndMs,
            state.recordingMode
          ) &&
          hasPauseMouthClickImpulse(track, tok.sourceStartMs, tok.sourceEndMs, speechRef)
        ) {
          mutedPauseClicks++;
          blockChanged = true;
          return {
            ...tok,
            trackMuted: true,
            mouthClickCleaned: true,
          };
        }
      }

      return tok;
    });

    return blockChanged ? { ...block, tokens: nextTokens } : block;
  });

  return {
    nextBlocks,
    deletedMouthTokens,
    mutedPauseClicks,
    totalCleanedCount: deletedMouthTokens + mutedPauseClicks,
  };
}
