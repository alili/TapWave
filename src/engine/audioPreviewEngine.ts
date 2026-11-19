import {
  buildAudioMixEndpoints,
  extractFilePathFromPodAudioUrl,
  normalizePlayableAudioUrl,
} from '../data/emptyProject';
import {
  AuxAudioSlot,
  HighlightClip,
  HighlightMuteInterval,
  PodcastProjectState,
  SpeakerTrack,
} from '../types/podcast';
import {
  MappedTokenTimeline,
  PlaybackSpan,
  resolveColdOpenClipWindows,
  resolveEffectiveHighlightGapSec,
  TimelineComputation,
} from './timelineEngine';
import {
  buildAcousticProfileMap,
  sampleNormalizedVocalActivity,
  TrackAcousticProfile,
} from './waveformAligner';

function hashSpeakerPitch(speakerId: string): number {
  let h = 0;
  for (let i = 0; i < speakerId.length; i++) {
    h = (h * 31 + speakerId.charCodeAt(i)) | 0;
  }
  return 125 + (Math.abs(h) % 85);
}

export interface ResolvedPlayheadTarget {
  inColdOpen: boolean;
  inIntroOrGapSilence: boolean;
  spanIndex: number;
  sourceSec: number | null;
  activeSpeakerId: string | null;
  mutedSpeakerId: string | null;
  activeBlockId: string | null;
  activeTokenId: string | null;
  isSilenceToken: boolean;
  isLaughter: boolean;
  isTrackMuted: boolean;
  isMouthClickCleaned: boolean;
  isBleeped: boolean;
  activeHighlight?: HighlightClip | null;
}

interface ColdOpenTokenEntry {
  m: MappedTokenTimeline;
  startSec: number;
  endSec: number;
}

interface ColdOpenSpeakerIndex {
  entries: ColdOpenTokenEntry[];
  maxEndPrefix: number[];
}

const coldOpenSpeakerIndexCache = new WeakMap<
  TimelineComputation,
  Map<string, ColdOpenSpeakerIndex>
>();

function getColdOpenSpeakerIndex(
  timeline: TimelineComputation
): Map<string, ColdOpenSpeakerIndex> {
  const cached = coldOpenSpeakerIndexCache.get(timeline);
  if (cached) return cached;

  const grouped = new Map<string, ColdOpenTokenEntry[]>();
  for (const m of timeline.mappedTokens) {
    if (m.token.deleted) continue;
    const startSec = m.effectiveSourceStartSec;
    const endSec = Math.max(
      startSec,
      startSec + Math.max(0, m.editedEndSec - m.editedStartSec),
      m.token.sourceEndMs / 1000
    );
    let list = grouped.get(m.speakerId);
    if (!list) {
      list = [];
      grouped.set(m.speakerId, list);
    }
    list.push({ m, startSec, endSec });
  }

  const indexMap = new Map<string, ColdOpenSpeakerIndex>();
  grouped.forEach((entries, spId) => {
    let sorted = true;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].startSec < entries[i - 1].startSec) {
        sorted = false;
        break;
      }
    }
    if (!sorted) {
      entries.sort((a, b) => a.startSec - b.startSec);
    }
    const maxEndPrefix = new Array<number>(entries.length);
    let runMax = -Infinity;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].endSec > runMax) runMax = entries[i].endSec;
      maxEndPrefix[i] = runMax;
    }
    indexMap.set(spId, { entries, maxEndPrefix });
  });

  coldOpenSpeakerIndexCache.set(timeline, indexMap);
  return indexMap;
}

function findBodyPlaybackSpan(
  spans: PlaybackSpan[],
  playheadSec: number
): { span: PlaybackSpan; arrayIdx: number } | null {
  if (!spans || spans.length === 0) return null;
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const sp = spans[mid];
    if (playheadSec < sp.editedStartSec - 0.002) {
      hi = mid - 1;
    } else if (playheadSec > sp.editedEndSec + 0.002) {
      lo = mid + 1;
    } else {
      // If sitting right on a splice boundary between two spans, prefer the forward span
      if (
        mid + 1 < spans.length &&
        playheadSec >= sp.editedEndSec - 0.0005 &&
        playheadSec >= spans[mid + 1].editedStartSec - 0.0005
      ) {
        return { span: spans[mid + 1], arrayIdx: mid + 1 };
      }
      return { span: sp, arrayIdx: mid };
    }
  }
  if (playheadSec <= spans[0].editedStartSec) {
    return { span: spans[0], arrayIdx: 0 };
  }
  const lastIdx = spans.length - 1;
  return { span: spans[lastIdx], arrayIdx: lastIdx };
}

/**
 * Maps an edited timeline playhead position (in seconds) back to source audio timestamp (in seconds)
 * using continuous PlaybackSpans + O(log N) binary search over tokens.
 * Guarantees 100% linear, monotonic sourceSec without boundary dropouts or spanIndex flicker!
 */
export function resolveEditedPlayheadToSource(
  state: PodcastProjectState,
  timeline: TimelineComputation,
  playheadSec: number
): ResolvedPlayheadTarget {
  // 1. Check Cold Open region [0 .. coldOpenDurationSec]
  if (
    state.coldOpenEnabled &&
    state.highlights.length > 0 &&
    playheadSec < timeline.coldOpenDurationSec
  ) {
    const gapSec = resolveEffectiveHighlightGapSec(state);
    const clipWindows = resolveColdOpenClipWindows(state.highlights, gapSec);
    const firstClipStart = clipWindows.length > 0 ? Math.min(2.0, clipWindows[0].startSec) : 2.0;
    if (playheadSec < firstClipStart) {
      return {
        inColdOpen: true,
        inIntroOrGapSilence: true,
        spanIndex: -100,
        sourceSec: null,
        activeSpeakerId: null,
        mutedSpeakerId: null,
        activeBlockId: null,
        activeTokenId: null,
        isSilenceToken: true,
        isLaughter: false,
        isTrackMuted: false,
        isMouthClickCleaned: false,
        isBleeped: false,
      };
    }
    for (let hlIdx = 0; hlIdx < clipWindows.length; hlIdx++) {
      const { highlight: hl, startSec: clipStart, endSec: end } = clipWindows[hlIdx];
      if (playheadSec >= clipStart && playheadSec <= end) {
        const offsetInClip = playheadSec - clipStart;
        const srcSec = hl.sourceStartMs / 1000 + offsetInClip;
        const hlStartSec = hl.sourceStartMs / 1000;
        const hlEndSec = hl.sourceEndMs / 1000;
        let coldMatch: (typeof timeline.mappedTokens)[number] | null = null;
        let bestDist = Infinity;
        const speakerIndex = getColdOpenSpeakerIndex(timeline).get(hl.speakerId);
        if (speakerIndex && speakerIndex.entries.length > 0) {
          const { entries, maxEndPrefix } = speakerIndex;
          const minWindowSec = Math.min(hlStartSec - 0.25, srcSec - 0.05);
          const maxWindowSec = Math.max(hlEndSec + 0.25, srcSec + 0.05);

          let lo = 0;
          let hi = entries.length - 1;
          let startIdx = entries.length;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (maxEndPrefix[mid] >= minWindowSec) {
              startIdx = mid;
              hi = mid - 1;
            } else {
              lo = mid + 1;
            }
          }

          for (let i = startIdx; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.startSec > maxWindowSec) break;
            const tokStartSec = entry.startSec;
            const tokEndSec = entry.endSec;
            if (srcSec >= tokStartSec - 0.05 && srcSec <= tokEndSec + 0.05) {
              coldMatch = entry.m;
              if (srcSec <= tokEndSec) break;
            } else if (tokEndSec >= hlStartSec - 0.25 && tokStartSec <= hlEndSec + 0.25) {
              const d = srcSec < tokStartSec ? tokStartSec - srcSec : srcSec - tokEndSec;
              if (d < bestDist) {
                bestDist = d;
                coldMatch = entry.m;
              }
            }
          }
        }
        return {
          inColdOpen: true,
          inIntroOrGapSilence: false,
          spanIndex: -(hlIdx + 1),
          sourceSec: srcSec,
          activeSpeakerId: hl.speakerId,
          mutedSpeakerId: null,
          activeBlockId: coldMatch?.blockId ?? null,
          activeTokenId: coldMatch?.token.id ?? null,
          isSilenceToken: false,
          isLaughter: false,
          isTrackMuted: false,
          isMouthClickCleaned: false,
          isBleeped: false,
          activeHighlight: hl,
        };
      }
      const nextStart = hlIdx + 1 < clipWindows.length ? clipWindows[hlIdx + 1].startSec : end;
      if (playheadSec > end && playheadSec < nextStart) {
        return {
          inColdOpen: true,
          inIntroOrGapSilence: true,
          spanIndex: -101 - hlIdx,
          sourceSec: null,
          activeSpeakerId: null,
          mutedSpeakerId: null,
          activeBlockId: null,
          activeTokenId: null,
          isSilenceToken: true,
          isLaughter: false,
          isTrackMuted: false,
          isMouthClickCleaned: false,
          isBleeped: false,
          activeHighlight: hl,
        };
      }
    }
    return {
      inColdOpen: true,
      inIntroOrGapSilence: true,
      spanIndex: -199,
      sourceSec: null,
      activeSpeakerId: null,
      mutedSpeakerId: null,
      activeBlockId: null,
      activeTokenId: null,
      isSilenceToken: true,
      isLaughter: false,
      isTrackMuted: false,
      isMouthClickCleaned: false,
      isBleeped: false,
    };
  }

  // 1b. Check Fixed Intro Voiceover region
  const voStart = timeline.introVoiceoverStartSec ?? timeline.coldOpenDurationSec;
  const voEnd = voStart + timeline.introVoiceoverDurationSec;
  if (
    timeline.introVoiceoverDurationSec > 0 &&
    playheadSec >= voStart &&
    playheadSec < voEnd
  ) {
    return {
      inColdOpen: false,
      inIntroOrGapSilence: true,
      spanIndex: -200,
      sourceSec: null,
      activeSpeakerId: null,
      mutedSpeakerId: null,
      activeBlockId: null,
      activeTokenId: null,
      isSilenceToken: true,
      isLaughter: false,
      isTrackMuted: false,
      isMouthClickCleaned: false,
      isBleeped: false,
    };
  }

  // 1c. Check Intro BGM / Prefix Gap region
  if (playheadSec < (timeline.prefixDurationSec ?? 0)) {
    return {
      inColdOpen: false,
      inIntroOrGapSilence: true,
      spanIndex: -300,
      sourceSec: null,
      activeSpeakerId: null,
      mutedSpeakerId: null,
      activeBlockId: null,
      activeTokenId: null,
      isSilenceToken: true,
      isLaughter: false,
      isTrackMuted: false,
      isMouthClickCleaned: false,
      isBleeped: false,
    };
  }

  // 2. Body region: resolve continuous PlaybackSpan first so sourceSec & spanIndex NEVER flicker
  const spanHit = findBodyPlaybackSpan(timeline.playbackSpans, playheadSec);

  const arr = timeline.mappedTokens;
  let lo = 0;
  let hi = arr.length - 1;
  let matchedToken: (typeof arr)[number] | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const item = arr[mid];
    if (playheadSec < item.editedStartSec) {
      hi = mid - 1;
    } else if (playheadSec > item.editedEndSec + 0.002) {
      lo = mid + 1;
    } else {
      let left = mid;
      while (left > 0 && arr[left - 1].editedEndSec >= playheadSec - 0.004) {
        left--;
      }
      for (let k = left; k < arr.length && arr[k].editedStartSec <= playheadSec + 0.004; k++) {
        const m = arr[k];
        if (m.token.deleted) continue;
        if (playheadSec >= m.editedStartSec && playheadSec <= m.editedEndSec) {
          matchedToken = m;
          if (playheadSec < m.editedEndSec) break;
        } else if (
          !matchedToken &&
          playheadSec >= m.editedStartSec - 0.002 &&
          playheadSec <= m.editedEndSec + 0.004
        ) {
          matchedToken = m;
        }
      }
      break;
    }
  }

  if (matchedToken) {
    const offsetSec = Math.max(0, playheadSec - matchedToken.editedStartSec);
    const srcSec = matchedToken.effectiveSourceStartSec + offsetSec;
    const isSilence = matchedToken.token.type === 'silence';
    const isMuted = Boolean(matchedToken.token.trackMuted);
    return {
      inColdOpen: false,
      inIntroOrGapSilence: false,
      spanIndex: matchedToken.spanIndex,
      sourceSec: srcSec,
      activeSpeakerId: isSilence ? null : matchedToken.speakerId,
      mutedSpeakerId: isMuted ? matchedToken.speakerId : null,
      activeBlockId: matchedToken.blockId,
      activeTokenId: matchedToken.token.id,
      isSilenceToken: isSilence,
      isLaughter: matchedToken.token.type === 'laughter',
      isTrackMuted: isMuted,
      isMouthClickCleaned: Boolean(matchedToken.token.mouthClickCleaned),
      isBleeped: Boolean(matchedToken.token.bleeped),
    };
  }

  // Find nearest non-deleted transcript token around inter-word breath gaps so UI focus stays continuous
  let nearestToken: (typeof arr)[number] | null = null;
  if (arr.length > 0) {
    const isVisibleWord = (m: (typeof arr)[number]) =>
      !m.token.deleted && (m.token.type !== 'silence' || m.token.durationSec >= 0.55 || Boolean(m.token.mouthClickCleaned));
    let prevTok: (typeof arr)[number] | null = null;
    for (let i = Math.min(arr.length - 1, Math.max(0, hi)); i >= 0; i--) {
      if (isVisibleWord(arr[i])) {
        prevTok = arr[i];
        break;
      }
    }
    let nextTok: (typeof arr)[number] | null = null;
    for (let i = Math.max(0, Math.min(arr.length - 1, lo)); i < arr.length; i++) {
      if (isVisibleWord(arr[i])) {
        nextTok = arr[i];
        break;
      }
    }
    if (prevTok && nextTok) {
      const prevDist = Math.abs(playheadSec - prevTok.editedEndSec);
      const nextDist = Math.abs(nextTok.editedStartSec - playheadSec);
      nearestToken = prevDist <= nextDist ? prevTok : nextTok;
    } else {
      nearestToken = prevTok ?? nextTok;
    }
  }

  // Playhead is inside a preserved natural inter-word breath within `spanHit`
  if (spanHit) {
    const clampedInSpan = Math.max(
      spanHit.span.editedStartSec,
      Math.min(spanHit.span.editedEndSec, playheadSec)
    );
    const srcSec =
      spanHit.span.sourceStartSec + (clampedInSpan - spanHit.span.editedStartSec);
    return {
      inColdOpen: false,
      inIntroOrGapSilence: false,
      spanIndex: spanHit.span.spanIndex,
      sourceSec: srcSec,
      activeSpeakerId: null,
      mutedSpeakerId: null,
      activeBlockId: nearestToken?.blockId ?? null,
      activeTokenId: nearestToken?.token.id ?? null,
      isSilenceToken: false,
      isLaughter: false,
      isTrackMuted: false,
      isMouthClickCleaned: false,
      isBleeped: false,
    };
  }

  return {
    inColdOpen: false,
    inIntroOrGapSilence: false,
    spanIndex: 0,
    sourceSec: Math.max(
      0,
      playheadSec - (timeline.prefixDurationSec ?? (timeline.coldOpenDurationSec + timeline.introVoiceoverDurationSec))
    ),
    activeSpeakerId: null,
    mutedSpeakerId: null,
    activeBlockId: nearestToken?.blockId ?? null,
    activeTokenId: nearestToken?.token.id ?? null,
    isSilenceToken: false,
    isLaughter: false,
    isTrackMuted: false,
    isMouthClickCleaned: false,
    isBleeped: false,
  };
}

function applyPitchPreservingPlaybackRate(el: HTMLAudioElement, rate: number): void {
  const safeRate = Math.max(0.5, Math.min(3.5, rate || 1.0));
  if (Math.abs(el.playbackRate - safeRate) > 0.005) {
    el.playbackRate = safeRate;
  }
  const anyEl = el as HTMLAudioElement & {
    preservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
    mozPreservesPitch?: boolean;
  };
  if (anyEl.preservesPitch !== true) anyEl.preservesPitch = true;
  if (anyEl.webkitPreservesPitch !== true) anyEl.webkitPreservesPitch = true;
  if (anyEl.mozPreservesPitch !== true) anyEl.mozPreservesPitch = true;
}

function selectPlayableTracks(state: PodcastProjectState): SpeakerTrack[] {
  return state.tracks.some((t) => !t.isRef)
    ? state.tracks.filter((t) => !t.isRef)
    : state.tracks;
}

interface ManagedAudioHolder {
  sourceKey: string;
  url: string;
  filePath?: string;
  fallbackFilePath?: string;
  label: string;
  audio: HTMLAudioElement;
  smoothedVolume: number;
  pendingSeekSec: number | null;
  lastSeekPerfMs: number;
  lastPlayRetryPerfMs: number;
  retriedSourcePath: boolean;
  retriedTranscode: boolean;
  failedFatal: boolean;
}

interface LiveMixPayloadResult {
  mixHash: string;
  spec: {
    clientRev: number;
    recordingMode: string;
    loudnessAligned: boolean;
    autoSoloMode: string;
    duckAttenuationDb: number;
    deClickEnabled: boolean;
    deClickStrength: string;
    bgmDuckDb: number;
    highlightGapSec?: number;
    coldOpenEnabled: boolean;
    coldOpenDurationSec: number;
    introVoiceoverDurationSec: number;
    totalEditedDurationSec: number;
    tracks: Array<{
      id: string;
      filePath: string;
      syncOffsetMs: number;
      autoGainDb: number;
      muted: boolean;
      solo: boolean;
    }>;
    playbackSpans: Array<{
      editedStartSec: number;
      editedEndSec: number;
      sourceStartSec: number;
      sourceEndSec: number;
    }>;
    highlights: Array<{ speakerId: string; sourceStartMs: number; durationSec: number }>;
    introVoiceover: { filePath: string; durationSec: number; enabled: boolean } | null;
    introBgm: { filePath: string; durationSec: number; enabled: boolean } | null;
    outroBgm: { filePath: string; durationSec: number; enabled: boolean } | null;
    activeIntervals: Array<{ trackId: string; startMs: number; endMs: number }>;
    primaryIntervals: Array<{ trackId: string; startMs: number; endMs: number }>;
    laughterRanges: Array<{ startMs: number; endMs: number }>;
    trackMutes: Array<{ trackId: string; startMs: number; endMs: number }>;
    mouthClickRanges: Array<{ trackId: string; startMs: number; endMs: number }>;
    bleepRanges: Array<{ startMs: number; endMs: number }>;
  };
}

function fnv1aHashString(input: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

class AudioPreviewEngine {
  private ctx: AudioContext | null = null;
  private activeNodes: AudioNode[] = [];
  private trackElements: Map<string, ManagedAudioHolder> = new Map();
  private mixHolder: {
    audio: HTMLAudioElement;
    pendingSeekSec: number | null;
    pendingPlayAfterLoad: boolean;
    lastSeekPerfMs: number;
    rev: number;
    failed: boolean;
  } | null = null;
  private mixClientRev = 0;
  private activeMixHash = '';
  private inFlightMixHash = '';
  private readyMixRev = 0;
  private serverMixFailed = false;
  private lastKnownPlayheadSec = 0;
  private bgmPreviewAudio: HTMLAudioElement | null = null;
  private bgmPreviewSlot: AuxAudioSlot | null = null;
  private bgmTimelineElements: Record<'intro' | 'outro', ManagedAudioHolder | null> = {
    intro: null,
    outro: null,
  };
  private introVoiceoverTimelineEl: ManagedAudioHolder | null = null;
  private forceSeekPending = true;
  private wasPlaying = false;
  private playStartPerfMs = 0;
  private lastSpanIndex: number | null = null;
  private lastHeldSpeakerId: string | null = null;
  private speakerHoldUntilPerfMs: Map<string, number> = new Map();
  private cachedTracksRef: SpeakerTrack[] | null = null;
  private cachedAcousticProfiles: Map<string, TrackAcousticProfile> = new Map();
  private onPlaybackError: ((msg: string) => void) | null = null;
  private reportedErrorKeys: Set<string> = new Set();

  private resolveLocalFilePath(rawUrl?: string, filePath?: string): string | undefined {
    if (filePath && filePath.trim().length > 0) return filePath;
    return extractFilePathFromPodAudioUrl(rawUrl);
  }

  private buildLiveMixPayload(
    state: PodcastProjectState,
    timeline: TimelineComputation
  ): LiveMixPayloadResult | null {
    const playable = selectPlayableTracks(state);
    if (playable.length === 0) return null;

    const mixTracks: LiveMixPayloadResult['spec']['tracks'] = [];
    for (const tr of playable) {
      const fp = this.resolveLocalFilePath(tr.audioUrl, tr.filePath);
      if (!fp) return null;
      mixTracks.push({
        id: tr.id,
        filePath: fp,
        syncOffsetMs: tr.syncOffsetMs || 0,
        autoGainDb: tr.autoGainDb || 0,
        muted: Boolean(tr.muted),
        solo: Boolean(tr.solo),
      });
    }

    const resolveAux = (aux?: PodcastProjectState['introVoiceover']) => {
      if (!aux || !aux.enabled) return null;
      const fp = this.resolveLocalFilePath(aux.audioUrl, aux.filePath);
      if (!fp) return null;
      return { filePath: fp, durationSec: aux.durationSec || 0, enabled: Boolean(aux.enabled) };
    };

    const rawActiveBySp = new Map<string, Array<{ startMs: number; endMs: number }>>();
    const rawPrimaryBySp = new Map<string, Array<{ startMs: number; endMs: number }>>();
    const pushRange = (
      map: Map<string, Array<{ startMs: number; endMs: number }>>,
      spId: string,
      startMs: number,
      endMs: number
    ) => {
      if (endMs <= startMs) return;
      let list = map.get(spId);
      if (!list) {
        list = [];
        map.set(spId, list);
      }
      list.push({ startMs, endMs });
    };

    const laughterRanges: Array<{ startMs: number; endMs: number }> = [];
    const trackMutes: Array<{ trackId: string; startMs: number; endMs: number }> = [];
    const mouthClickRanges: Array<{ trackId: string; startMs: number; endMs: number }> = [];
    const bleepRanges: Array<{ startMs: number; endMs: number }> = [];

    if (state.coldOpenEnabled) {
      for (const hl of state.highlights) {
        pushRange(rawPrimaryBySp, hl.speakerId, hl.sourceStartMs, hl.sourceEndMs);
      }
    }

    for (const tm of state.trackMuteRanges ?? []) {
      if (tm.sourceEndMs > tm.sourceStartMs) {
        trackMutes.push({
          trackId: tm.trackId,
          startMs: tm.sourceStartMs,
          endMs: tm.sourceEndMs,
        });
      }
    }

    for (const b of state.blocks) {
      if (b.overlapNote?.muted) {
        trackMutes.push({
          trackId: b.overlapNote.speakerId,
          startMs: b.overlapNote.sourceStartMs,
          endMs: b.overlapNote.sourceEndMs,
        });
      } else if (b.overlapNote) {
        pushRange(
          rawPrimaryBySp,
          b.speakerId,
          b.overlapNote.sourceStartMs,
          b.overlapNote.sourceEndMs
        );
        if (b.overlapNote.keepFullVolume) {
          pushRange(
            rawPrimaryBySp,
            b.overlapNote.speakerId,
            b.overlapNote.sourceStartMs,
            b.overlapNote.sourceEndMs
          );
        }
      }
      for (const tok of b.tokens) {
        if (tok.deleted) continue;
        if (tok.bleeped) {
          bleepRanges.push({ startMs: tok.sourceStartMs, endMs: tok.sourceEndMs });
        }
        if (tok.trackMuted) {
          if (tok.mouthClickCleaned) {
            mouthClickRanges.push({
              trackId: b.speakerId,
              startMs: tok.sourceStartMs,
              endMs: tok.sourceEndMs,
            });
          } else {
            trackMutes.push({
              trackId: b.speakerId,
              startMs: tok.sourceStartMs,
              endMs: tok.sourceEndMs,
            });
          }
          continue;
        }
        if (tok.type === 'laughter') {
          laughterRanges.push({ startMs: tok.sourceStartMs, endMs: tok.sourceEndMs });
        }
        if (tok.type === 'word' || tok.type === 'laughter') {
          pushRange(rawActiveBySp, b.speakerId, tok.sourceStartMs, tok.sourceEndMs);
          pushRange(rawPrimaryBySp, b.speakerId, tok.sourceStartMs, tok.sourceEndMs);
        }
      }
    }

    for (const ov of timeline.overlapRegions) {
      if (ov.muted) {
        trackMutes.push({
          trackId: ov.secondarySpeakerId,
          startMs: ov.sourceStartMs,
          endMs: ov.sourceEndMs,
        });
      } else if (ov.keepFullVolume) {
        pushRange(rawPrimaryBySp, ov.secondarySpeakerId, ov.sourceStartMs, ov.sourceEndMs);
      } else {
        pushRange(rawPrimaryBySp, ov.primarySpeakerId, ov.sourceStartMs, ov.sourceEndMs);
      }
    }

    const collapseIntervals = (
      map: Map<string, Array<{ startMs: number; endMs: number }>>,
      mergeGapMs: number
    ): Array<{ trackId: string; startMs: number; endMs: number }> => {
      const out: Array<{ trackId: string; startMs: number; endMs: number }> = [];
      for (const [trackId, ranges] of map.entries()) {
        ranges.sort((a, b) => a.startMs - b.startMs);
        let curS = -1;
        let curE = -1;
        for (const r of ranges) {
          if (curS < 0) {
            curS = r.startMs;
            curE = r.endMs;
          } else if (r.startMs <= curE + mergeGapMs) {
            curE = Math.max(curE, r.endMs);
          } else {
            out.push({ trackId, startMs: curS, endMs: curE });
            curS = r.startMs;
            curE = r.endMs;
          }
        }
        if (curS >= 0) {
          out.push({ trackId, startMs: curS, endMs: curE });
        }
      }
      return out;
    };

    const activeIntervals = collapseIntervals(rawActiveBySp, 350);
    const primaryIntervals = collapseIntervals(rawPrimaryBySp, 220);

    const introVoiceover = resolveAux(state.introVoiceover);
    const introBgm = resolveAux(state.introBgm);
    const outroBgm = resolveAux(state.outroBgm);

    const spansCompact = timeline.playbackSpans.map((s) => ({
      editedStartSec: s.editedStartSec,
      editedEndSec: s.editedEndSec,
      sourceStartSec: s.sourceStartSec,
      sourceEndSec: s.sourceEndSec,
    }));
    const highlightsCompact = state.coldOpenEnabled
      ? state.highlights.map((h) => ({
          speakerId: h.speakerId,
          sourceStartMs: h.sourceStartMs,
          durationSec: h.durationSec,
        }))
      : [];

    const hashSig = fnv1aHashString(
      JSON.stringify([
        state.recordingMode,
        state.loudnessAligned,
        state.autoSoloMode,
        state.duckAttenuationDb,
        state.deClickEnabled !== false,
        state.deClickStrength,
        state.bgmDuckDb,
        state.coldOpenEnabled,
        timeline.coldOpenDurationSec,
        timeline.introVoiceoverDurationSec,
        timeline.totalEditedDurationSec,
        mixTracks,
        spansCompact,
        highlightsCompact,
        introVoiceover,
        introBgm,
        outroBgm,
        activeIntervals.length,
        primaryIntervals,
        laughterRanges.length,
        trackMutes,
        mouthClickRanges.length,
        bleepRanges,
      ])
    );

    return {
      mixHash: hashSig,
      spec: {
        clientRev: this.mixClientRev + 1,
        recordingMode: state.recordingMode || 'same_room_sync',
        loudnessAligned: state.loudnessAligned !== false,
        autoSoloMode: state.autoSoloMode || 'natural_ducking',
        duckAttenuationDb: state.duckAttenuationDb ?? -16,
        deClickEnabled: state.deClickEnabled !== false,
        deClickStrength: state.deClickStrength || 'medium',
        bgmDuckDb: state.bgmDuckDb ?? -18,
        highlightGapSec: resolveEffectiveHighlightGapSec(state),
        coldOpenEnabled: Boolean(state.coldOpenEnabled),
        coldOpenDurationSec: timeline.coldOpenDurationSec,
        introVoiceoverDurationSec: timeline.introVoiceoverDurationSec,
        totalEditedDurationSec: timeline.totalEditedDurationSec,
        tracks: mixTracks,
        playbackSpans: spansCompact,
        highlights: highlightsCompact,
        introVoiceover,
        introBgm,
        outroBgm,
        activeIntervals,
        primaryIntervals,
        laughterRanges,
        trackMutes,
        mouthClickRanges,
        bleepRanges,
      },
    };
  }

  private ensureMixAudioHolder(): NonNullable<AudioPreviewEngine['mixHolder']> | null {
    if (typeof window === 'undefined' || typeof Audio === 'undefined') return null;
    if (this.mixHolder) return this.mixHolder;

    const el = new Audio();
    el.preload = 'auto';
    el.volume = 1.0;

    const holder: NonNullable<AudioPreviewEngine['mixHolder']> = {
      audio: el,
      pendingSeekSec: null,
      pendingPlayAfterLoad: false,
      lastSeekPerfMs: 0,
      rev: 0,
      failed: false,
    };

    el.addEventListener('loadedmetadata', () => {
      if (holder.pendingSeekSec !== null) {
        const target = holder.pendingSeekSec;
        holder.pendingSeekSec = null;
        try {
          const maxDur =
            el.duration && Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.02) : target;
          el.currentTime = Math.max(0, Math.min(target, maxDur));
        } catch {
          // Ignore transient seek race
        }
      }
      if (holder.pendingPlayAfterLoad && this.wasPlaying && el.paused) {
        holder.pendingPlayAfterLoad = false;
        void el.play().catch(() => {});
      }
    });

    el.addEventListener('error', () => {
      // Ignore spurious errors when src wasn't assigned yet (idle pre-warm)
      if (!el.getAttribute('src')) return;
      holder.failed = true;
      this.serverMixFailed = true;
    });

    this.mixHolder = holder;
    return holder;
  }

  public prepareLiveMix(_state: PodcastProjectState, _timeline: TimelineComputation): void {
    // 实时预览统一采用原生零延迟多轨 HTMLAudioElement 硬件流式播放：
    // 1. 避免后台动态 WAV 合成流在 macOS WKWebView / AVFoundation Range 跳转中引发缓冲断流或自动暂停；
    // 2. 避免脱离用户手势异步切换音频源导致 NotAllowedError；
    // 3. 避免大工程几万个 Token 在主线程序列化阻塞帧率。
  }

  private isReadyServerMixActive(_state: PodcastProjectState): boolean {
    return false;
  }

  private getAcousticProfiles(tracks: SpeakerTrack[]): Map<string, TrackAcousticProfile> {
    if (this.cachedTracksRef !== tracks) {
      this.cachedTracksRef = tracks;
      this.cachedAcousticProfiles = buildAcousticProfileMap(tracks);
    }
    return this.cachedAcousticProfiles;
  }

  private coldOpenClipElements = new Map<string, ManagedAudioHolder>();
  private lastAutoSoloEvalPerfMs = 0;

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        this.ctx = new Ctx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  private emitPlaybackErrorOnce(key: string, message: string): void {
    if (this.reportedErrorKeys.has(key)) return;
    this.reportedErrorKeys.add(key);
    this.onPlaybackError?.(message);
  }

  /**
   * Pure native OS HTMLAudioElement (NO createMediaElementSource / NO crossOrigin).
   * Keeps CoreAudio / AVFoundation / Chromium hardware ring-buffer streaming 100% isolated
   * from main-thread JS renders, preventing WebKit pull-resampler underruns & skips!
   */
  private createManagedHolder(
    rawUrl: string | undefined,
    filePath: string | undefined,
    label: string,
    playbackRate: number,
    loop = false,
    fallbackFilePath?: string
  ): ManagedAudioHolder | null {
    const resolvedUrl =
      normalizePlayableAudioUrl(rawUrl, filePath, false) ||
      (fallbackFilePath ? normalizePlayableAudioUrl(undefined, fallbackFilePath, false) : undefined);
    if (!resolvedUrl) return null;

    const sourceKey = `${rawUrl ?? ''}|${filePath ?? ''}|${fallbackFilePath ?? ''}`;
    const el = new Audio();
    el.preload = 'auto';
    el.loop = loop;
    applyPitchPreservingPlaybackRate(el, playbackRate);

    const holder: ManagedAudioHolder = {
      sourceKey,
      url: resolvedUrl,
      filePath,
      fallbackFilePath,
      label,
      audio: el,
      smoothedVolume: 0.9,
      pendingSeekSec: null,
      lastSeekPerfMs: 0,
      lastPlayRetryPerfMs: 0,
      retriedSourcePath: false,
      retriedTranscode: false,
      failedFatal: false,
    };

    el.addEventListener('loadedmetadata', () => {
      applyPitchPreservingPlaybackRate(el, playbackRate);
      if (holder.pendingSeekSec !== null) {
        const target = holder.pendingSeekSec;
        holder.pendingSeekSec = null;
        try {
          const maxDur =
            el.duration && Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.02) : target;
          el.currentTime = Math.max(0, Math.min(target, maxDur));
        } catch {
          // Ignore transient seek race
        }
      }
      if (this.wasPlaying && el.paused && !el.ended) {
        void el.play().catch(() => {});
      }
    });

    el.addEventListener('error', () => {
      // 1. 优先尝试回退到原始导入音频路径（防止 /tmp 会话归一化缓存被系统清理后工程无法播放）
      if (!holder.retriedSourcePath && fallbackFilePath && fallbackFilePath !== filePath) {
        const altSourceUrl = normalizePlayableAudioUrl(undefined, fallbackFilePath, false);
        if (altSourceUrl && altSourceUrl !== holder.url) {
          holder.retriedSourcePath = true;
          holder.filePath = fallbackFilePath;
          holder.url = altSourceUrl;
          el.src = altSourceUrl;
          el.load();
          if (this.wasPlaying) {
            void el.play().catch(() => {});
          }
          return;
        }
      }
      // 2. 尝试通过服务端 FFmpeg 实时转码为标准 48kHz WAV 流
      if (!holder.retriedTranscode) {
        const activePath = holder.filePath || fallbackFilePath || filePath;
        const fallbackWavUrl = normalizePlayableAudioUrl(rawUrl, activePath, true);
        if (fallbackWavUrl && fallbackWavUrl !== holder.url) {
          holder.retriedTranscode = true;
          holder.url = fallbackWavUrl;
          el.src = fallbackWavUrl;
          el.load();
          if (this.wasPlaying) {
            void el.play().catch(() => {});
          }
          return;
        }
      }
      holder.failedFatal = true;
      this.emitPlaybackErrorOnce(
        sourceKey,
        `⚠️ 音轨「${label}」音频流加载失败，请检查本地音频文件是否仍存在或重新导入音频`
      );
    });

    el.src = resolvedUrl;
    el.load();
    return holder;
  }

  private disposeHolder(holder: ManagedAudioHolder | null | undefined): void {
    if (!holder) return;
    try {
      holder.audio.pause();
      holder.audio.removeAttribute('src');
      holder.audio.load();
    } catch {
      // Ignore cleanup errors
    }
  }

  private applySlewedVolume(
    holder: ManagedAudioHolder,
    targetGain: number,
    immediate: boolean
  ): void {
    const clamped = Math.max(0, Math.min(1, targetGain));
    if (immediate) {
      holder.smoothedVolume = clamped;
    } else if (clamped >= holder.smoothedVolume) {
      // Fast smooth attack (~50ms) so speech onsets are never clipped
      holder.smoothedVolume += (clamped - holder.smoothedVolume) * 0.42;
      if (clamped - holder.smoothedVolume < 0.008) holder.smoothedVolume = clamped;
    } else {
      // Gentle natural release (~220ms) so Auto-Solo ducking never pumps or clicks
      holder.smoothedVolume += (clamped - holder.smoothedVolume) * 0.12;
      if (holder.smoothedVolume - clamped < 0.006) holder.smoothedVolume = clamped;
    }

    const nextVol = Math.max(0, Math.min(1, holder.smoothedVolume));
    if (
      Math.abs(holder.audio.volume - nextVol) > 0.004 ||
      (nextVol === 0 && holder.audio.volume !== 0)
    ) {
      holder.audio.volume = nextVol;
    }
  }

  /**
   * Seeks immediately on initial Play start, manual user scrub, or crossing an edit splice (`forceSeek === true`).
   * During continuous uncut playback (`forceSeek === false`), avoids touching `el.currentTime` unless a track
   * drifted beyond 0.38s, keeping OS CoreAudio / AVFoundation ring-buffers uninterrupted!
   */
  private seekHolderOnSpliceOnly(
    holder: ManagedAudioHolder,
    targetSec: number,
    forceSeek: boolean,
    maxContinuousDriftSec = 0.9,
    cooldownMs = 1000
  ): void {
    const clampedTarget = Math.max(0, targetSec);
    const el = holder.audio;
    if (el.readyState === 0) {
      holder.pendingSeekSec = clampedTarget;
      return;
    }

    const drift = Math.abs(el.currentTime - clampedTarget);
    const nowPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();

    if (forceSeek || this.forceSeekPending) {
      const minForceDelta = this.forceSeekPending ? 0.015 : 0.025;
      if (drift > minForceDelta || el.ended) {
        holder.pendingSeekSec = null;
        holder.lastSeekPerfMs = nowPerf;
        try {
          const maxDur =
            el.duration && Number.isFinite(el.duration) && el.duration > 0
              ? Math.max(0, el.duration - 0.02)
              : clampedTarget;
          el.currentTime = Math.min(clampedTarget, maxDur);
        } catch {
          holder.pendingSeekSec = clampedTarget;
        }
      }
      return;
    }

    // Continuous uncut playback: keep primary clock smooth while tightly locking follower tracks (<65ms) to prevent echo
    if (el.seeking || nowPerf - holder.lastSeekPerfMs < cooldownMs) {
      return;
    }
    if (drift > maxContinuousDriftSec) {
      holder.pendingSeekSec = null;
      holder.lastSeekPerfMs = nowPerf;
      try {
        const maxDur =
          el.duration && Number.isFinite(el.duration) && el.duration > 0
            ? Math.max(0, el.duration - 0.02)
            : clampedTarget;
        el.currentTime = Math.min(clampedTarget, maxDur);
      } catch {
        holder.pendingSeekSec = clampedTarget;
      }
    }
  }

  /** Marks that the user manually scrubbed/jumped playhead so next sync seeks immediately */
  public requestSeek(): void {
    this.forceSeekPending = true;
    this.playStartPerfMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /** Pre-warms <audio> elements as soon as tracks are loaded so pressing Space starts immediately */
  public preloadTracks(state: PodcastProjectState): void {
    if (typeof window === 'undefined' || typeof Audio === 'undefined') return;
    const playable = selectPlayableTracks(state);
    const playableIds = new Set(playable.map((t) => t.id));
    if (playable.length === 0) {
      this.activeMixHash = '';
      this.inFlightMixHash = '';
      this.readyMixRev = 0;
      if (this.mixHolder) {
        this.mixHolder.audio.pause();
        this.mixHolder.audio.removeAttribute('src');
        this.mixHolder.rev = 0;
      }
    }

    for (const [id, entry] of this.trackElements.entries()) {
      if (!playableIds.has(id)) {
        this.disposeHolder(entry);
        this.trackElements.delete(id);
      }
    }

    const rate = state.playbackRate || 1.0;
    for (const tr of playable) {
      const sourceKey = `${tr.audioUrl ?? ''}|${tr.filePath ?? ''}|${tr.sourceFilePath ?? ''}`;
      const existing = this.trackElements.get(tr.id);
      if (!existing || existing.sourceKey !== sourceKey || existing.failedFatal) {
        if (existing) {
          this.disposeHolder(existing);
          this.trackElements.delete(tr.id);
        }
        const created = this.createManagedHolder(
          tr.audioUrl,
          tr.filePath,
          tr.name,
          rate,
          false,
          tr.sourceFilePath
        );
        if (created) {
          this.trackElements.set(tr.id, created);
        }
      }
    }

    // Pre-warm dedicated Cold Open highlight clip elements for all speaker tracks (multi-track slice per highlight)
    const activeColdOpenKeys = new Set<string>();
    const playableColdTracks = selectPlayableTracks(state);
    if (state.coldOpenEnabled && state.highlights.length > 0) {
      for (const hl of state.highlights) {
        for (const tr of playableColdTracks) {
          const clipElemId = `${hl.id}::${tr.id}`;
          activeColdOpenKeys.add(clipElemId);
          const effOffset = state.recordingMode === 'same_room_sync' ? 0 : (tr.syncOffsetMs || 0) / 1000;
          const clipStartSec = Math.max(0, hl.sourceStartMs / 1000 - effOffset);
          const clipKey = `${clipElemId}|${tr.audioUrl ?? ''}|${tr.filePath ?? ''}|${tr.sourceFilePath ?? ''}|${clipStartSec.toFixed(3)}`;
          const existing = this.coldOpenClipElements.get(clipElemId);
          if (!existing || existing.sourceKey !== clipKey || existing.failedFatal) {
            if (existing) {
              this.disposeHolder(existing);
              this.coldOpenClipElements.delete(clipElemId);
            }
            const created = this.createManagedHolder(
              tr.audioUrl,
              tr.filePath,
              `片头金句_${tr.name}`,
              rate,
              false,
              tr.sourceFilePath
            );
            if (created) {
              created.sourceKey = clipKey;
              this.seekHolderOnSpliceOnly(created, clipStartSec, true);
              this.coldOpenClipElements.set(clipElemId, created);
            }
          }
        }
      }
    }
    for (const [clipElemId, holder] of this.coldOpenClipElements.entries()) {
      if (!activeColdOpenKeys.has(clipElemId)) {
        this.disposeHolder(holder);
        this.coldOpenClipElements.delete(clipElemId);
      }
    }

    // Pre-warm fixed intro voiceover element so entering intro voiceover starts with 0ms lag
    if (
      state.introVoiceover?.enabled &&
      (state.introVoiceover.audioUrl || state.introVoiceover.filePath)
    ) {
      const voKey = `${state.introVoiceover.audioUrl ?? ''}|${state.introVoiceover.filePath ?? ''}|`;
      if (
        !this.introVoiceoverTimelineEl ||
        this.introVoiceoverTimelineEl.sourceKey !== voKey ||
        this.introVoiceoverTimelineEl.failedFatal
      ) {
        this.disposeHolder(this.introVoiceoverTimelineEl);
        this.introVoiceoverTimelineEl = this.createManagedHolder(
          state.introVoiceover.audioUrl,
          state.introVoiceover.filePath,
          '片头固定口播',
          rate,
          false
        );
      }
    }

    // Pre-warm Intro & Outro BGM elements so entering BGM beds starts immediately
    for (const [slot, asset, label] of [
      ['intro', state.introBgm, '片头 BGM'],
      ['outro', state.outroBgm, '片尾 BGM'],
    ] as const) {
      const effectivePath = asset?.filePath || (slot === 'intro' ? state.bgmWavPath : undefined);
      if (asset?.enabled && (asset.audioUrl || effectivePath)) {
        const bgmKey = `${asset.audioUrl ?? ''}|${effectivePath ?? ''}|`;
        const existing = this.bgmTimelineElements[slot];
        if (!existing || existing.sourceKey !== bgmKey || existing.failedFatal) {
          this.disposeHolder(existing);
          this.bgmTimelineElements[slot] = this.createManagedHolder(
            asset.audioUrl,
            effectivePath,
            label,
            1.0,
            true
          );
        }
      }
    }
  }

  /**
   * Must be invoked synchronously inside a click / keydown event handler when starting playback!
   * Unlocks WebKit's user-gesture autoplay policy and starts native hardware streaming.
   */
  public startFromUserGesture(
    state: PodcastProjectState,
    timeline: TimelineComputation,
    playheadSec: number,
    onError?: (msg: string) => void
  ): void {
    if (onError) {
      this.onPlaybackError = onError;
    }
    this.reportedErrorKeys.clear();
    this.lastKnownPlayheadSec = playheadSec;
    this.preloadTracks(state);
    this.forceSeekPending = true;
    this.playStartPerfMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.lastSpanIndex = null;
    this.lastHeldSpeakerId = null;
    this.speakerHoldUntilPerfMs.clear();

    // Seek BEFORE play() synchronously inside user gesture so AVPlayer unlocks every stem immediately
    const mapped = resolveEditedPlayheadToSource(state, timeline, playheadSec);
    for (const tr of selectPlayableTracks(state)) {
      const holder = this.trackElements.get(tr.id);
      if (!holder || holder.failedFatal) continue;
      const effOffset = state.recordingMode === 'same_room_sync' ? 0 : (tr.syncOffsetMs || 0) / 1000;
      const targetSec =
        mapped.sourceSec !== null && !mapped.inIntroOrGapSilence
          ? Math.max(0, mapped.sourceSec - effOffset)
          : 0;
      this.seekHolderOnSpliceOnly(holder, targetSec, true);
      if (holder.audio.paused || holder.audio.ended) {
        holder.audio.volume = 0;
        holder.lastPlayRetryPerfMs = this.playStartPerfMs;
        void holder.audio.play().catch(() => {});
      }
    }

    for (const [clipElemId, clipHolder] of this.coldOpenClipElements.entries()) {
      if (clipHolder.failedFatal) continue;
      const [hlId, trackId] = clipElemId.split('::');
      const isCurrentHl =
        mapped.inColdOpen && !mapped.inIntroOrGapSilence && mapped.activeHighlight?.id === hlId;
      const hl = state.highlights.find((h) => h.id === hlId);
      const tr = state.tracks.find((t) => t.id === trackId);
      const effOffset =
        tr && state.recordingMode !== 'same_room_sync' ? (tr.syncOffsetMs || 0) / 1000 : 0;
      const clipTarget =
        isCurrentHl && mapped.sourceSec !== null
          ? Math.max(0, mapped.sourceSec - effOffset)
          : hl
          ? Math.max(0, hl.sourceStartMs / 1000 - effOffset)
          : 0;
      this.seekHolderOnSpliceOnly(clipHolder, clipTarget, true);
      const clipEl = clipHolder.audio;
      if (clipEl.paused || clipEl.ended) {
        clipEl.volume = 0;
        void clipEl.play().then(() => {
          if (!isCurrentHl) {
            clipEl.pause();
          }
        }).catch(() => {});
      }
    }

    if (this.introVoiceoverTimelineEl && !this.introVoiceoverTimelineEl.failedFatal) {
      const voStart = timeline.introVoiceoverStartSec ?? timeline.coldOpenDurationSec;
      const voEnd = voStart + timeline.introVoiceoverDurationSec;
      const inVoNow =
        Boolean(state.introVoiceover?.enabled) &&
        timeline.introVoiceoverDurationSec > 0 &&
        playheadSec >= voStart &&
        playheadSec < voEnd;
      const voTarget = inVoNow ? Math.max(0, playheadSec - voStart) : 0;
      const voEl = this.introVoiceoverTimelineEl.audio;
      this.seekHolderOnSpliceOnly(this.introVoiceoverTimelineEl, voTarget, true);
      if (voEl.paused || voEl.ended) {
        voEl.volume = 0;
        void voEl.play().then(() => {
          if (!this.wasPlaying || playheadSec >= voEnd) {
            voEl.pause();
          }
        }).catch(() => {});
      }
    }

    for (const slot of ['intro', 'outro'] as const) {
      const bgmHolder = this.bgmTimelineElements[slot];
      if (bgmHolder && !bgmHolder.failedFatal) {
        const bgmEl = bgmHolder.audio;
        if (bgmEl.paused || bgmEl.ended) {
          bgmEl.volume = 0;
          void bgmEl.play().then(() => {
            if (!this.wasPlaying) {
              bgmEl.pause();
            }
          }).catch(() => {});
        }
      }
    }

    this.syncMultiTrackPlayback(state, timeline, playheadSec, true);
  }

  public stopAll(): void {
    for (const node of this.activeNodes) {
      try {
        if ('stop' in node && typeof (node as OscillatorNode).stop === 'function') {
          (node as OscillatorNode).stop();
        }
        node.disconnect();
      } catch {
        // Ignore already stopped nodes
      }
    }
    this.activeNodes = [];
    this.stopBgmPreview();
    this.pauseMultiTrackPlayback();
  }

  public stopBgmPreview(): void {
    if (this.bgmPreviewAudio) {
      this.bgmPreviewAudio.pause();
      this.bgmPreviewAudio.removeAttribute('src');
      this.bgmPreviewAudio = null;
    }
    this.bgmPreviewSlot = null;
  }

  public toggleBgmSlotPreview(
    slot: AuxAudioSlot,
    audioUrl?: string,
    filePath?: string,
    onEnded?: () => void
  ): boolean {
    if (typeof window === 'undefined' || typeof Audio === 'undefined') {
      return false;
    }
    const resolvedUrl = normalizePlayableAudioUrl(audioUrl, filePath, false);
    if (!resolvedUrl) return false;

    if (this.bgmPreviewAudio && this.bgmPreviewSlot === slot && !this.bgmPreviewAudio.paused) {
      this.stopBgmPreview();
      return false;
    }
    this.stopBgmPreview();

    const el = new Audio(resolvedUrl);
    el.preload = 'auto';
    el.volume = slot === 'intro_vo' ? 0.94 : 0.78;
    let retried = false;
    el.onerror = () => {
      if (!retried) {
        const fallback = normalizePlayableAudioUrl(audioUrl, filePath, true);
        if (fallback && fallback !== resolvedUrl) {
          retried = true;
          el.src = fallback;
          el.load();
          void el.play().catch(() => {
            this.stopBgmPreview();
            onEnded?.();
          });
          return;
        }
      }
      this.stopBgmPreview();
      onEnded?.();
    };
    el.onended = () => {
      this.bgmPreviewSlot = null;
      this.bgmPreviewAudio = null;
      onEnded?.();
    };
    this.bgmPreviewAudio = el;
    this.bgmPreviewSlot = slot;
    void el.play().catch(() => {
      this.stopBgmPreview();
      onEnded?.();
    });
    return true;
  }

  public pauseMultiTrackPlayback(): void {
    this.wasPlaying = false;
    this.forceSeekPending = true;
    this.lastSpanIndex = null;
    if (this.mixHolder) {
      this.mixHolder.pendingPlayAfterLoad = false;
      if (!this.mixHolder.audio.paused) {
        this.mixHolder.audio.pause();
      }
    }
    for (const entry of this.trackElements.values()) {
      if (!entry.audio.paused) {
        entry.audio.pause();
      }
    }
    for (const clipEntry of this.coldOpenClipElements.values()) {
      if (!clipEntry.audio.paused) {
        clipEntry.audio.pause();
      }
    }
    if (this.introVoiceoverTimelineEl && !this.introVoiceoverTimelineEl.audio.paused) {
      this.introVoiceoverTimelineEl.audio.pause();
    }
    for (const slot of ['intro', 'outro'] as const) {
      const b = this.bgmTimelineElements[slot];
      if (b && !b.audio.paused) {
        b.audio.pause();
      }
    }
  }

  /**
   * Pure Audio-Master Timeline Progression:
   * - In Unified Server Mix mode (all local WAV/MP3/M4A sessions), drives playhead 1:1 from ONE single
   *   sample-accurate 48kHz WAV mix stream (`mixHolder`), eliminating inter-track phase skew, cut seeks, and volume pumping!
   * - In ephemeral blob: fallback mode, uses primary track hardware clock + splice-only sync.
   */
  public advanceAndSyncPlayback(
    state: PodcastProjectState,
    timeline: TimelineComputation,
    currentPlayheadSec: number,
    dtRealSec: number
  ): { nextPlayheadSec: number; resolved: ResolvedPlayheadTarget | null } {
    this.lastKnownPlayheadSec = currentPlayheadSec;
    const playbackRate = Math.max(0.5, Math.min(3.5, state.playbackRate || 1.0));
    const prefixSec =
      timeline.prefixDurationSec ??
      timeline.coldOpenDurationSec + timeline.introVoiceoverDurationSec;
    const stepSec = dtRealSec * playbackRate;
    let nextPlayheadSec = currentPlayheadSec + stepSec;

    if (!this.forceSeekPending && this.wasPlaying) {
      const nowPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const voStartSec = timeline.introVoiceoverStartSec ?? timeline.coldOpenDurationSec;
      const voEndSec = voStartSec + timeline.introVoiceoverDurationSec;

      if (currentPlayheadSec < prefixSec - 0.002) {
        // Prefix region: Cold Open highlights & Fixed Intro Voiceover hardware clock sync
        const preMapped = resolveEditedPlayheadToSource(state, timeline, currentPlayheadSec);

        if (
          state.introVoiceover?.enabled &&
          timeline.introVoiceoverDurationSec > 0 &&
          currentPlayheadSec >= voStartSec &&
          currentPlayheadSec < voEndSec
        ) {
          const voHolder = this.introVoiceoverTimelineEl;
          if (voHolder && !voHolder.failedFatal) {
            const voEl = voHolder.audio;
            if (
              nowPerf - Math.max(this.playStartPerfMs, voHolder.lastSeekPerfMs) < 450 &&
              (voEl.seeking || voEl.readyState < 2)
            ) {
              nextPlayheadSec = currentPlayheadSec;
            } else if (!voEl.paused && !voEl.ended && !voEl.seeking && voEl.readyState >= 2) {
              const hwEditedSec = voStartSec + voEl.currentTime;
              if (hwEditedSec >= voStartSec && hwEditedSec <= voEndSec) {
                const drift = hwEditedSec - nextPlayheadSec;
                if (Math.abs(drift) > 0.045 && Math.abs(drift) < 0.35) {
                  nextPlayheadSec = Math.max(
                    currentPlayheadSec + stepSec * 0.5,
                    nextPlayheadSec + drift * 0.25
                  );
                } else if (Math.abs(drift) >= 0.35 && Math.abs(drift) < 2.0) {
                  nextPlayheadSec =
                    drift > 0
                      ? Math.min(voEndSec, nextPlayheadSec + drift * 0.45)
                      : currentPlayheadSec + stepSec * 0.25;
                }
              }
            }
          }
        } else if (
          preMapped.inColdOpen &&
          !preMapped.inIntroOrGapSilence &&
          preMapped.activeSpeakerId &&
          preMapped.activeHighlight &&
          preMapped.sourceSec !== null
        ) {
          const clipHolder =
            this.coldOpenClipElements.get(`${preMapped.activeHighlight.id}::${preMapped.activeSpeakerId}`) ??
            this.trackElements.get(preMapped.activeSpeakerId);
          const clipTrack = state.tracks.find((t) => t.id === preMapped.activeSpeakerId);
          if (clipHolder && !clipHolder.failedFatal && clipTrack) {
            const el = clipHolder.audio;
            if (
              nowPerf - Math.max(this.playStartPerfMs, clipHolder.lastSeekPerfMs) < 450 &&
              (el.seeking || el.readyState < 2)
            ) {
              nextPlayheadSec = currentPlayheadSec;
            } else if (!el.paused && !el.ended && !el.seeking && el.readyState >= 2) {
              const offsetSec =
                state.recordingMode === 'same_room_sync'
                  ? 0
                  : (clipTrack.syncOffsetMs || 0) / 1000;
              const actualSourceSec = el.currentTime + offsetSec;
              const hlStartSrc = preMapped.activeHighlight.sourceStartMs / 1000;
              const hlEndSrc = preMapped.activeHighlight.sourceEndMs / 1000;
              if (actualSourceSec >= hlStartSrc - 0.02 && actualSourceSec <= hlEndSrc + 0.02) {
                const hwEditedSec = currentPlayheadSec + (actualSourceSec - preMapped.sourceSec);
                const drift = hwEditedSec - nextPlayheadSec;
                if (Math.abs(drift) > 0.045 && Math.abs(drift) < 0.35) {
                  nextPlayheadSec = Math.max(
                    currentPlayheadSec + stepSec * 0.5,
                    nextPlayheadSec + drift * 0.25
                  );
                } else if (Math.abs(drift) >= 0.35 && Math.abs(drift) < 2.0) {
                  nextPlayheadSec =
                    drift > 0
                      ? Math.min(timeline.coldOpenDurationSec, nextPlayheadSec + drift * 0.45)
                      : currentPlayheadSec + stepSec * 0.25;
                }
              }
            }
          }
        }
      } else if (
        state.tracks.length > 0 &&
        currentPlayheadSec >= prefixSec - 0.002 &&
        timeline.playbackSpans.length > 0
      ) {
        const spanHit = findBodyPlaybackSpan(timeline.playbackSpans, currentPlayheadSec);
        const playable = selectPlayableTracks(state);

        // 1. 起播前 450ms 内若所有音轨仍在初始解码缓冲，短暂保持游标等待首帧就绪（超时后绝不阻塞推进）
        if (nowPerf - this.playStartPerfMs < 450) {
          const validHolders = playable
            .map((t) => this.trackElements.get(t.id))
            .filter((h): h is ManagedAudioHolder => Boolean(h && !h.failedFatal));
          if (
            validHolders.length > 0 &&
            validHolders.every((h) => h.audio.seeking || h.audio.readyState < 2)
          ) {
            nextPlayheadSec = currentPlayheadSec;
          }
        }

        // 2. 在连续未切剪片段内部（避开切片首尾接缝），挑选一条正在发声的硬件音轨做温和漂移软校准
        //    严格保证每帧至少前进 0.5 * stepSec，彻底杜绝因单轨提前 ended 或边界钳制造成游标卡死！
        if (
          spanHit &&
          this.lastSpanIndex === spanHit.span.spanIndex &&
          nextPlayheadSec > currentPlayheadSec
        ) {
          const { span } = spanHit;
          const insideSafeBody =
            currentPlayheadSec >= span.editedStartSec + 0.06 &&
            currentPlayheadSec <= span.editedEndSec - 0.08;
          if (insideSafeBody) {
            const activeClockTrack = playable
              .filter((t) => {
                const h = this.trackElements.get(t.id);
                return (
                  h &&
                  !h.failedFatal &&
                  !h.audio.paused &&
                  !h.audio.ended &&
                  !h.audio.seeking &&
                  h.audio.readyState >= 2
                );
              })
              .sort(
                (a, b) =>
                  (a.muted ? 1 : 0) - (b.muted ? 1 : 0) ||
                  Math.abs(a.syncOffsetMs || 0) - Math.abs(b.syncOffsetMs || 0)
              )[0];

            if (activeClockTrack) {
              const holder = this.trackElements.get(activeClockTrack.id);
              if (holder) {
                const el = holder.audio;
                const offsetSec =
                  state.recordingMode === 'same_room_sync'
                    ? 0
                    : (activeClockTrack.syncOffsetMs || 0) / 1000;
                const actualSourceSec = el.currentTime + offsetSec;
                const sourceOffset = actualSourceSec - span.sourceStartSec;
                if (sourceOffset >= 0 && actualSourceSec <= span.sourceEndSec) {
                  const hwEditedSec = span.editedStartSec + sourceOffset;
                  const drift = hwEditedSec - nextPlayheadSec;
                  if (Math.abs(drift) > 0.045 && Math.abs(drift) < 0.35) {
                    nextPlayheadSec = Math.max(
                      currentPlayheadSec + stepSec * 0.5,
                      nextPlayheadSec + drift * 0.2
                    );
                  } else if (Math.abs(drift) >= 0.35 && Math.abs(drift) < 2.0) {
                    nextPlayheadSec =
                      drift > 0
                        ? Math.min(span.editedEndSec, nextPlayheadSec + drift * 0.45)
                        : currentPlayheadSec + stepSec * 0.25;
                  }
                }
              }
            }
          }
        }
      }
    }

    if (nextPlayheadSec >= timeline.totalEditedDurationSec) {
      if (currentPlayheadSec >= timeline.totalEditedDurationSec - 0.15) {
        return { nextPlayheadSec: timeline.totalEditedDurationSec, resolved: null };
      } else {
        nextPlayheadSec = Math.min(
          timeline.totalEditedDurationSec - 0.001,
          currentPlayheadSec + stepSec
        );
      }
    }

    const resolved = this.syncMultiTrackPlayback(state, timeline, nextPlayheadSec, true);
    return { nextPlayheadSec, resolved };
  }

  /**
   * Synchronizes multi-track <audio> elements without interrupting continuous playback:
   * - Never calls preloadTracks() in a hot loop if tracks already exist
   * - Only seeks when crossing an actual edit splice (`spanIndex` change) or manual scrub
   * - Uses lookahead + holdover Auto-Solo smoothing so speech never pumps or chops!
   */
  public syncMultiTrackPlayback(
    state: PodcastProjectState,
    timeline: TimelineComputation,
    playheadSec: number,
    isPlaying: boolean
  ): ResolvedPlayheadTarget | null {
    if (typeof window === 'undefined' || typeof Audio === 'undefined') return null;

    if (!isPlaying || state.tracks.length === 0) {
      this.pauseMultiTrackPlayback();
      return null;
    }

    const playbackRate = Math.max(0.5, Math.min(3.5, state.playbackRate || 1.0));
    const mapped = resolveEditedPlayheadToSource(state, timeline, playheadSec);
    this.lastKnownPlayheadSec = playheadSec;

    const anySolo = state.tracks.some((t) => t.solo) || Boolean(state.introBgm?.solo);

    // Deterministic splice check: ONLY true on initial start, manual user seek, or real cut boundary!
    const crossedCutOrScrub =
      this.forceSeekPending || !this.wasPlaying || mapped.spanIndex !== this.lastSpanIndex;

    const playableTracks = selectPlayableTracks(state);
    const nowPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // 1. Transcript-guided lookahead (220ms) + holdover (480ms)
    if (mapped.activeSpeakerId) {
      this.lastHeldSpeakerId = mapped.activeSpeakerId;
      this.speakerHoldUntilPerfMs.set(mapped.activeSpeakerId, nowPerf + 480);
    }
    const shouldEvalAutoSolo =
      crossedCutOrScrub || nowPerf - this.lastAutoSoloEvalPerfMs >= 65;
    if (shouldEvalAutoSolo && playableTracks.length > 1 && state.autoSoloMode !== 'off') {
      this.lastAutoSoloEvalPerfMs = nowPerf;
      const acousticProfiles = this.getAcousticProfiles(state.tracks);
      const lookahead = resolveEditedPlayheadToSource(
        state,
        timeline,
        Math.min(timeline.totalEditedDurationSec, playheadSec + 0.22 * playbackRate)
      );
      if (lookahead.activeSpeakerId) {
        this.speakerHoldUntilPerfMs.set(lookahead.activeSpeakerId, nowPerf + 480);
      }

      // 2. Waveform-Volume-Guided Acoustic Activity Override:
      // If ANY speaker track's real waveform volume shows active speech right now or 140ms ahead,
      // keep that mic open even if ASR missed or mis-timed a word -> zero blank/muffled words!
      if (mapped.sourceSec !== null) {
        const curSrcMs = mapped.sourceSec * 1000;
        const aheadSrcMs = curSrcMs + 140 * playbackRate;
        let loudestActiveId: string | null = null;
        let loudestNorm = 0;

        const samples: Array<{ id: string; normNow: number; normAhead: number }> = [];
        for (const tr of playableTracks) {
          if (tr.muted || tr.peaks.length === 0) continue;
          const prof = acousticProfiles.get(tr.id);
          const normNow = sampleNormalizedVocalActivity(
            tr,
            prof,
            curSrcMs,
            state.recordingMode,
            55
          );
          const normAhead = sampleNormalizedVocalActivity(
            tr,
            prof,
            aheadSrcMs,
            state.recordingMode,
            55
          );
          samples.push({ id: tr.id, normNow, normAhead });
          if (normNow > loudestNorm) {
            loudestNorm = normNow;
            loudestActiveId = tr.id;
          }
        }
        for (const s of samples) {
          // Cross-mic room echo/bleed filter: ignore secondary track residual below 42% of dominant track
          const notBleed = loudestNorm < 0.25 || s.normNow >= loudestNorm * 0.42 || s.normAhead >= loudestNorm * 0.45;
          if (notBleed && (s.normNow >= 0.22 || s.normAhead >= 0.25)) {
            this.speakerHoldUntilPerfMs.set(s.id, nowPerf + 480);
          }
        }
        if (!mapped.activeSpeakerId && loudestActiveId && loudestNorm >= 0.28) {
          this.lastHeldSpeakerId = loudestActiveId;
        }
      }
    }

    const dominantSpeakerId = mapped.activeSpeakerId ?? this.lastHeldSpeakerId;

    // Dedicated Cold Open multi-track highlight playback (all tracks stay phase-locked at highlight source range)
    const activeColdHighlight =
      mapped.inColdOpen && !mapped.inIntroOrGapSilence ? mapped.activeHighlight : undefined;
    for (const [clipElemId, clipHolder] of this.coldOpenClipElements.entries()) {
      if (clipHolder.failedFatal) continue;
      const [hlId, trackId] = clipElemId.split('::');
      const clipEl = clipHolder.audio;
      if (!activeColdHighlight || activeColdHighlight.id !== hlId || mapped.sourceSec === null) {
        this.applySlewedVolume(clipHolder, 0, true);
        if (!clipEl.paused) {
          clipEl.pause();
        }
        continue;
      }
      const tr = state.tracks.find((t) => t.id === trackId);
      const effOffset =
        tr && state.recordingMode !== 'same_room_sync' ? (tr.syncOffsetMs || 0) / 1000 : 0;
      const targetClipSec = Math.max(0, mapped.sourceSec - effOffset);
      const masterSrcMs = mapped.sourceSec * 1000;
      const isMuted =
        Boolean(tr?.muted) ||
        (anySolo && !tr?.solo) ||
        Boolean(
          activeColdHighlight.mutedTrackIds?.includes(trackId) ||
            activeColdHighlight.partiallyMutedRanges?.some(
              (pm: HighlightMuteInterval) =>
                pm.trackId === trackId &&
                masterSrcMs >= pm.sourceStartMs &&
                masterSrcMs <= pm.sourceEndMs
            )
        );
      let clipGain = 1.0;
      if (isMuted) {
        clipGain = 0.0;
      } else {
        if (tr && state.loudnessAligned) {
          const dbFactor = Math.pow(10, Math.min(8, Math.max(-12, tr.autoGainDb)) / 20);
          clipGain *= Math.min(1.0, 0.9 * dbFactor);
        } else {
          clipGain *= 0.92;
        }
        if (
          playableTracks.length > 1 &&
          state.autoSoloMode !== 'off' &&
          trackId !== activeColdHighlight.speakerId
        ) {
          if (state.autoSoloMode === 'hard_mute') {
            clipGain *= 0.06;
          } else {
            const baseDuck = Math.max(
              0.10,
              Math.min(0.50, Math.pow(10, state.duckAttenuationDb / 20))
            );
            clipGain *= baseDuck;
          }
        }
      }
      const isPrimaryHlTrack = trackId === activeColdHighlight.speakerId;
      applyPitchPreservingPlaybackRate(clipEl, playbackRate);
      this.seekHolderOnSpliceOnly(
        clipHolder,
        targetClipSec,
        crossedCutOrScrub,
        isPrimaryHlTrack ? 0.9 : 0.08,
        isPrimaryHlTrack ? 1000 : 600
      );
      this.applySlewedVolume(clipHolder, clipGain, !this.wasPlaying || this.forceSeekPending);
      if ((clipEl.paused || clipEl.ended) && nowPerf - clipHolder.lastPlayRetryPerfMs > 240) {
        clipHolder.lastPlayRetryPerfMs = nowPerf;
        void clipEl.play().catch(() => {});
      }
    }

    for (const tr of playableTracks) {
      const sourceKey = `${tr.audioUrl ?? ''}|${tr.filePath ?? ''}|${tr.sourceFilePath ?? ''}`;
      let holder = this.trackElements.get(tr.id);
      if (!holder || holder.sourceKey !== sourceKey) {
        if (holder) this.disposeHolder(holder);
        const created = this.createManagedHolder(
          tr.audioUrl,
          tr.filePath,
          tr.name,
          playbackRate,
          false,
          tr.sourceFilePath
        );
        if (!created) continue;
        holder = created;
        this.trackElements.set(tr.id, holder);
      }
      if (holder.failedFatal) continue;

      const audioEl = holder.audio;
      applyPitchPreservingPlaybackRate(audioEl, playbackRate);

      if (mapped.inColdOpen || mapped.sourceSec === null || mapped.inIntroOrGapSilence) {
        this.applySlewedVolume(holder, 0, !this.wasPlaying);
        // 静默区间保持音量为 0，不强行 pause audioEl，防止失去用户手势授权导致后续切回人声时被浏览器自动播放策略拦截
        continue;
      }

      const effectiveOffsetSec =
        state.recordingMode === 'same_room_sync' ? 0 : (tr.syncOffsetMs || 0) / 1000;
      const targetTrackSec = Math.max(0, mapped.sourceSec - effectiveOffsetSec);

      const masterSrcMs = mapped.sourceSec * 1000;
      const inExplicitMuteRange = (state.trackMuteRanges ?? []).some(
        (tm) =>
          tm.trackId === tr.id &&
          masterSrcMs >= tm.sourceStartMs &&
          masterSrcMs <= tm.sourceEndMs
      );

      // 金句区间音轨整轨静音与部分静音处理
      const inHighlightTrackMute =
        mapped.inColdOpen &&
        mapped.activeHighlight &&
        Boolean(
          mapped.activeHighlight.mutedTrackIds?.includes(tr.id) ||
          mapped.activeHighlight.partiallyMutedRanges?.some(
            (pm: HighlightMuteInterval) => pm.trackId === tr.id && masterSrcMs >= pm.sourceStartMs && masterSrcMs <= pm.sourceEndMs
          )
        );

      let gain = 1.0;
      if (tr.muted || (anySolo && !tr.solo)) {
        gain = 0.0;
      } else if (mapped.isBleeped || inHighlightTrackMute) {
        gain = 0.0;
      } else if (
        inExplicitMuteRange ||
        (mapped.isTrackMuted &&
          !mapped.isMouthClickCleaned &&
          mapped.mutedSpeakerId === tr.id)
      ) {
        // Explicit manual single-track mute by user
        gain = 0.0;
      } else {
        if (state.loudnessAligned) {
          const dbFactor = Math.pow(10, Math.min(8, Math.max(-12, tr.autoGainDb)) / 20);
          gain *= Math.min(1.0, 0.9 * dbFactor);
        } else {
          gain *= 0.92;
        }

        // Primary-Speaker Priority Auto-Ducking fallback (automatically lowers non-primary speaker tracks, including during speech overlaps!)
        const trackRecentlyOrSoonSpeaking =
          (this.speakerHoldUntilPerfMs.get(tr.id) ?? 0) > nowPerf;

        const activeOvForTrack = timeline.overlapRegions.find(
          (ov) =>
            ov.secondarySpeakerId === tr.id &&
            playheadSec >= ov.editedStartSec - 0.04 &&
            playheadSec <= ov.editedEndSec + 0.08
        );

        if (activeOvForTrack?.muted) {
          gain = 0.0;
        } else if (
          playableTracks.length > 1 &&
          state.autoSoloMode !== 'off' &&
          dominantSpeakerId &&
          dominantSpeakerId !== tr.id &&
          !activeOvForTrack?.keepFullVolume
        ) {
          if (state.autoSoloMode === 'hard_mute') {
            gain *= 0.06;
          } else {
            const baseDuck = Math.max(
              0.10,
              Math.min(0.50, Math.pow(10, state.duckAttenuationDb / 20))
            );
            const overlapDuck = Math.max(0.22, Math.min(0.38, baseDuck * 2.0));
            gain *= trackRecentlyOrSoonSpeaking || activeOvForTrack ? overlapDuck : baseDuck;
          }
        }
      }

      // Primary/dominant track uses relaxed 0.9s drift guard (zero audio stutter);
      // secondary/follower tracks stay tightly phase-locked (<65ms) to eliminate multi-track echo!
      const isPrimarySyncTrack =
        dominantSpeakerId ? tr.id === dominantSpeakerId : playableTracks[0]?.id === tr.id;
      this.seekHolderOnSpliceOnly(
        holder,
        targetTrackSec,
        crossedCutOrScrub,
        isPrimarySyncTrack ? 0.9 : 0.065,
        isPrimarySyncTrack ? 1000 : 450
      );
      this.applySlewedVolume(holder, gain, !this.wasPlaying || this.forceSeekPending);

      const decodedDurSec =
        audioEl.duration && Number.isFinite(audioEl.duration) && audioEl.duration > 0.1
          ? audioEl.duration
          : tr.durationMs && tr.durationMs > 100
          ? tr.durationMs / 1000
          : Infinity;

      if (
        (audioEl.paused || audioEl.ended) &&
        targetTrackSec < decodedDurSec - 0.05 &&
        nowPerf - holder.lastPlayRetryPerfMs > 240
      ) {
        holder.lastPlayRetryPerfMs = nowPerf;
        if (audioEl.ended) {
          try {
            audioEl.currentTime = targetTrackSec;
          } catch {
            // ignore
          }
        }
        void audioEl.play().catch((err) => {
          if (String(err).includes('NotAllowedError')) {
            this.emitPlaybackErrorOnce(
              `autoplay_${tr.id}`,
              '🔊 浏览器拦截了自动播放，请再次点击播放按钮解锁音频输出'
            );
          }
        });
      }
    }

    // Sync Fixed Intro Voiceover
    const voStartSec = timeline.introVoiceoverStartSec ?? timeline.coldOpenDurationSec;
    const voEndSec = voStartSec + timeline.introVoiceoverDurationSec;
    const inFixedIntroVo =
      Boolean(state.introVoiceover?.enabled) &&
      Boolean(state.introVoiceover?.audioUrl || state.introVoiceover?.filePath) &&
      timeline.introVoiceoverDurationSec > 0 &&
      playheadSec >= voStartSec &&
      playheadSec < voEndSec;

    if (inFixedIntroVo && state.introVoiceover) {
      const voKey = `${state.introVoiceover.audioUrl ?? ''}|${state.introVoiceover.filePath ?? ''}|`;
      if (!this.introVoiceoverTimelineEl || this.introVoiceoverTimelineEl.sourceKey !== voKey) {
        this.disposeHolder(this.introVoiceoverTimelineEl);
        this.introVoiceoverTimelineEl = this.createManagedHolder(
          state.introVoiceover.audioUrl,
          state.introVoiceover.filePath,
          '片头固定口播',
          playbackRate,
          false
        );
      }
      const voHolder = this.introVoiceoverTimelineEl;
      if (voHolder && !voHolder.failedFatal) {
        const voEl = voHolder.audio;
        applyPitchPreservingPlaybackRate(voEl, playbackRate);
        this.applySlewedVolume(voHolder, 0.94, !this.wasPlaying);
        const offsetInVo = Math.max(0, playheadSec - voStartSec);
        const voNeedInitialSeek =
          this.forceSeekPending || !this.wasPlaying || Math.abs(voEl.currentTime - offsetInVo) > 0.15;
        this.seekHolderOnSpliceOnly(voHolder, offsetInVo, voNeedInitialSeek && crossedCutOrScrub, 0.9, 1200);
        if (voEl.paused && !voEl.ended) {
          void voEl.play().catch(() => {});
        }
      }
    } else if (this.introVoiceoverTimelineEl) {
      this.applySlewedVolume(this.introVoiceoverTimelineEl, 0, true);
      if (playheadSec < voStartSec) {
        this.seekHolderOnSpliceOnly(this.introVoiceoverTimelineEl, 0, false, 0.25, 450);
      } else if (!this.introVoiceoverTimelineEl.audio.paused) {
        this.introVoiceoverTimelineEl.audio.pause();
      }
    }

    // Sync imported Intro BGM & Outro BGM with smooth auto-ducking
    const syncBgmBed = (
      slot: 'intro' | 'outro',
      bgmUrl: string | undefined,
      bgmPath: string | undefined,
      enabled: boolean,
      activeWindow: boolean,
      offsetSecInBgm: number,
      fadeFactor: number
    ) => {
      let holder = this.bgmTimelineElements[slot];
      if (!enabled || (!bgmUrl && !bgmPath) || !activeWindow) {
        if (holder && !holder.audio.paused) {
          holder.audio.pause();
        }
        return;
      }
      const bgmKey = `${bgmUrl ?? ''}|${bgmPath ?? ''}|`;
      if (!holder || holder.sourceKey !== bgmKey) {
        this.disposeHolder(holder);
        holder = this.createManagedHolder(
          bgmUrl,
          bgmPath,
          slot === 'intro' ? '片头 BGM' : '片尾 BGM',
          1.0,
          true
        );
        this.bgmTimelineElements[slot] = holder;
      }
      if (!holder || holder.failedFatal) return;

      // 片头金句整段闪避（不考虑段内的音量连续）：
      // 在片头金句发声段（从 2.0s 前奏垫音结束，直到金句全部播放完成），全程持续闪避，不因句内停顿或句间 gap 回弹！
      const coldQuotesEndSec = Math.max(2.0, timeline.coldOpenDurationSec - 2.0);
      const inColdOpenQuotesSection =
        Boolean(mapped.inColdOpen) &&
        playheadSec >= 2.0 &&
        playheadSec <= coldQuotesEndSec;

      const voiceSpeaking =
        inColdOpenQuotesSection ||
        (Boolean(dominantSpeakerId) && !mapped.inIntroOrGapSilence) ||
        inFixedIntroVo;
      const baseBedVol = 0.55;
      const duckedBedVol = baseBedVol * Math.pow(10, (state.bgmDuckDb || -18) / 20);
      const targetVol = Math.max(
        0,
        Math.min(1, (voiceSpeaking ? duckedBedVol : baseBedVol) * fadeFactor)
      );
      this.applySlewedVolume(holder, targetVol, !this.wasPlaying);
      if (holder.audio.duration && Number.isFinite(holder.audio.duration)) {
        const modTime = offsetSecInBgm % Math.max(1, holder.audio.duration);
        const manualSeekOrStart = this.forceSeekPending || !this.wasPlaying;
        this.seekHolderOnSpliceOnly(holder, modTime, manualSeekOrStart, 1.5, 2000);
      }
      if (holder.audio.paused) {
        void holder.audio.play().catch(() => {});
      }
    };

    const prefixTotalSec = timeline.prefixDurationSec ?? (timeline.coldOpenDurationSec + timeline.introVoiceoverDurationSec);
    const customIntroBgmSec = state.introBgm?.customDurationSec;
    const introEndSec =
      customIntroBgmSec && customIntroBgmSec > 0
        ? customIntroBgmSec
        : (timeline.introBgmDurationSec && timeline.introBgmDurationSec > 0)
        ? timeline.introBgmDurationSec
        : prefixTotalSec > 0
        ? prefixTotalSec
        : Math.min(10, timeline.totalEditedDurationSec * 0.35);
    const inIntroBed = playheadSec <= introEndSec;

    // 默认淡入淡出时间 800ms (0.8s)
    const introFadeInSec = (state.introBgm?.fadeInMs ?? 800) / 1000;
    const introFadeOutSec = (state.introBgm?.fadeOutMs ?? 800) / 1000;
    let introFade = 1.0;
    if (playheadSec < introFadeInSec) {
      introFade = Math.min(1.0, Math.max(0, playheadSec / Math.max(0.05, introFadeInSec)));
    } else if (introEndSec > introFadeOutSec && playheadSec > introEndSec - introFadeOutSec) {
      introFade = Math.max(0, (introEndSec - playheadSec) / Math.max(0.05, introFadeOutSec));
    }

    const isIntroBgmMuted = Boolean(state.introBgm?.muted);
    const isIntroBgmSolo = Boolean(state.introBgm?.solo);
    const introBgmActive = Boolean(state.introBgm?.enabled) && !isIntroBgmMuted && (!anySolo || isIntroBgmSolo);

    syncBgmBed(
      'intro',
      state.introBgm?.audioUrl,
      state.introBgm?.filePath || state.bgmWavPath,
      introBgmActive,
      inIntroBed,
      playheadSec,
      introFade
    );

    const isOutroBgmMuted = Boolean(state.outroBgm?.muted);
    const isOutroBgmSolo = Boolean(state.outroBgm?.solo);
    const outroBgmActive =
      Boolean(state.outroBgm?.enabled) && !isOutroBgmMuted && (!anySolo || isOutroBgmSolo);

    const customOutroSec = state.outroBgm?.customDurationSec;
    const outroWindowSec =
      typeof customOutroSec === 'number' && customOutroSec > 0
        ? customOutroSec
        : Math.min(20, Math.max(6, timeline.totalEditedDurationSec * 0.18));
    const outroStartSec = Math.max(
      introEndSec + 0.5,
      timeline.totalEditedDurationSec - outroWindowSec
    );
    const inOutroBed = timeline.totalEditedDurationSec > 3 && playheadSec >= outroStartSec;

    // 片尾 BGM 淡入与淡出平滑包络（自动适应音量）
    const outroFadeInSec = (state.outroBgm?.fadeInMs ?? 1000) / 1000;
    const outroFadeOutSec = (state.outroBgm?.fadeOutMs ?? 2000) / 1000;
    let outroFade = 1.0;
    if (playheadSec - outroStartSec < outroFadeInSec) {
      outroFade = Math.min(1.0, Math.max(0, (playheadSec - outroStartSec) / Math.max(0.05, outroFadeInSec)));
    } else if (playheadSec > timeline.totalEditedDurationSec - outroFadeOutSec) {
      outroFade = Math.max(0, (timeline.totalEditedDurationSec - playheadSec) / Math.max(0.05, outroFadeOutSec));
    }

    syncBgmBed(
      'outro',
      state.outroBgm?.audioUrl,
      state.outroBgm?.filePath,
      outroBgmActive,
      inOutroBed,
      Math.max(0, playheadSec - outroStartSec),
      outroFade
    );

    this.wasPlaying = true;
    this.forceSeekPending = false;
    this.lastSpanIndex = mapped.spanIndex;
    return mapped;
  }

  /** Plays standard broadcast 1000Hz Bleep (-14dBFS) with 10ms smooth cosine ramp */
  public playBleepTone(durationSec = 0.34): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1000, now);

    gain.gain.setValueAtTime(0.0005, now);
    gain.gain.linearRampToValueAtTime(0.085, now + 0.012);
    gain.gain.setValueAtTime(0.085, now + Math.max(0.03, durationSec - 0.015));
    gain.gain.exponentialRampToValueAtTime(0.0005, now + durationSec);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + durationSec + 0.02);
    this.activeNodes.push(osc, gain);
  }

  /** Auditions a 1.75s splice point: left phrase -> 25ms equal-power crossfade -> right phrase */
  public playSpliceAudition(speakerId: string): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const baseFreq = hashSpeakerPitch(speakerId);
    const now = ctx.currentTime;

    const makePhrase = (startOffset: number, dur: number, f0: number) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f0, now + startOffset);
      osc.frequency.linearRampToValueAtTime(f0 * 1.08, now + startOffset + dur * 0.5);
      osc.frequency.linearRampToValueAtTime(f0 * 0.96, now + startOffset + dur);

      g.gain.setValueAtTime(0.0005, now + startOffset);
      g.gain.linearRampToValueAtTime(0.06, now + startOffset + 0.025);
      g.gain.setValueAtTime(0.055, now + startOffset + dur - 0.03);
      g.gain.linearRampToValueAtTime(0.0005, now + startOffset + dur);

      osc.connect(g).connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + dur + 0.02);
      this.activeNodes.push(osc, g);
    };

    makePhrase(0.0, 0.85, baseFreq);
    makePhrase(0.825, 0.9, baseFreq * 1.04);
  }

  /** Auditions Cold Open BGM swell -> Auto-Ducking drop (-18dB) when speaker enters -> Outro swell */
  public playColdOpenDuckingPreview(
    bgmStyle: PodcastProjectState['bgmStyle'],
    duckDb: number
  ): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const chord =
      bgmStyle === 'pulse'
        ? [196.0, 246.94, 293.66, 392.0]
        : bgmStyle === 'acoustic'
        ? [164.81, 207.65, 246.94, 329.63]
        : [220.0, 261.63, 329.63, 392.0];

    const normalAmp = 0.045;
    const duckLinear = normalAmp * Math.pow(10, duckDb / 20);

    chord.forEach((freq) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);

      g.gain.setValueAtTime(0.001, now);
      g.gain.linearRampToValueAtTime(normalAmp, now + 0.35);
      g.gain.setValueAtTime(normalAmp, now + 0.8);
      g.gain.linearRampToValueAtTime(duckLinear, now + 1.1);
      g.gain.setValueAtTime(duckLinear, now + 2.25);
      g.gain.linearRampToValueAtTime(normalAmp, now + 2.65);
      g.gain.exponentialRampToValueAtTime(0.0005, now + 3.25);

      osc.connect(g).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 3.3);
      this.activeNodes.push(osc, g);
    });

    const voiceOsc = ctx.createOscillator();
    const voiceGain = ctx.createGain();
    voiceOsc.type = 'triangle';
    voiceOsc.frequency.setValueAtTime(146, now + 1.05);
    voiceOsc.frequency.linearRampToValueAtTime(168, now + 1.65);
    voiceOsc.frequency.linearRampToValueAtTime(138, now + 2.25);

    voiceGain.gain.setValueAtTime(0.0005, now + 1.05);
    voiceGain.gain.linearRampToValueAtTime(0.075, now + 1.12);
    voiceGain.gain.setValueAtTime(0.07, now + 2.15);
    voiceGain.gain.exponentialRampToValueAtTime(0.0005, now + 2.28);

    voiceOsc.connect(voiceGain).connect(ctx.destination);
    voiceOsc.start(now + 1.05);
    voiceOsc.stop(now + 2.3);
    this.activeNodes.push(voiceOsc, voiceGain);
  }
}

export const audioPreview = new AudioPreviewEngine();
