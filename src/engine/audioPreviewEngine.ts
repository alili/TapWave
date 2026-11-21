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
  computeIntroBgmDuckMultiplier,
  IntroBgmVoiceWindow,
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
import { timeStretchAudioBufferWsola } from './wsolaTimeStretch';

/**
 * Computes a relative linear gain in (0, 0.94] for previewing multi-track audio via HTMLAudioElement.
 * Because HTMLAudioElement.volume cannot exceed 1.0, tracks are normalized relative to the
 * highest positive autoGainDb among all playable tracks so quieter and louder speakers align
 * accurately during editing without clipping.
 */
export function computePreviewTrackLoudnessScale(
  trackAutoGainDb: number,
  allPlayableAutoGainDbs: number[],
  loudnessAligned: boolean
): number {
  if (!loudnessAligned) return 0.92;
  const clampedSelf = Math.min(18, Math.max(-12, trackAutoGainDb || 0));
  const maxPositiveGainDb = allPlayableAutoGainDbs.reduce(
    (maxDb, db) => Math.max(maxDb, Math.min(18, Math.max(-12, db || 0))),
    0
  );
  const relativeDb = clampedSelf - maxPositiveGainDb;
  const linear = Math.pow(10, relativeDb / 20);
  return Math.max(0.05, Math.min(1.0, 0.94 * linear));
}

function appendProxyParamIfEnabled(resolvedUrl: string | undefined, useProxy: boolean): string | undefined {
  if (!resolvedUrl || !useProxy) return resolvedUrl;
  if (
    resolvedUrl.startsWith('/api/audio-stream') ||
    resolvedUrl.startsWith('http://127.0.0.1:')
  ) {
    if (resolvedUrl.includes('proxy=')) return resolvedUrl;
    return `${resolvedUrl}${resolvedUrl.includes('?') ? '&' : '?'}proxy=1`;
  }
  return resolvedUrl;
}

const SKIM_CHUNK_DURATION_SEC = 30;

function appendProxyChunkUrl(baseUrl: string | undefined, chunkIdx: number): string | undefined {
  if (!baseUrl) return undefined;
  if (
    baseUrl.startsWith('/api/audio-stream') ||
    baseUrl.startsWith('http://127.0.0.1:')
  ) {
    const withProxy = appendProxyParamIfEnabled(baseUrl, true)!;
    return `${withProxy}&chunk=${chunkIdx}`;
  }
  return baseUrl;
}

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
  if (Math.abs(el.playbackRate - safeRate) > 0.008) {
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

const playableTracksCache = new WeakMap<SpeakerTrack[], SpeakerTrack[]>();

function selectPlayableTracks(state: PodcastProjectState): SpeakerTrack[] {
  const cached = playableTracksCache.get(state.tracks);
  if (cached) return cached;
  const result = state.tracks.some((t) => !t.isRef)
    ? state.tracks.filter((t) => !t.isRef)
    : state.tracks;
  playableTracksCache.set(state.tracks, result);
  return result;
}

function pickPrimarySyncTrack(playableTracks: SpeakerTrack[]): SpeakerTrack | undefined {
  let best: SpeakerTrack | undefined;
  for (let i = 0; i < playableTracks.length; i++) {
    const t = playableTracks[i];
    if (!best) {
      best = t;
      continue;
    }
    const tMuted = t.muted ? 1 : 0;
    const bMuted = best.muted ? 1 : 0;
    if (
      tMuted < bMuted ||
      (tMuted === bMuted && Math.abs(t.syncOffsetMs || 0) < Math.abs(best.syncOffsetMs || 0))
    ) {
      best = t;
    }
  }
  return best;
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
  private playbackGeneration = 0;
  private playStartPerfMs = 0;
  private lastSpanIndex: number | null = null;
  private lastHeldSpeakerId: string | null = null;
  private speakerHoldUntilPerfMs: Map<string, number> = new Map();
  private cachedTracksRef: SpeakerTrack[] | null = null;
  private cachedAcousticProfiles: Map<string, TrackAcousticProfile> = new Map();
  private onPlaybackError: ((msg: string) => void) | null = null;
  private reportedErrorKeys: Set<string> = new Set();
  private deviceChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly handleDeviceChangeBound = () => {
    if (this.deviceChangeTimer) {
      clearTimeout(this.deviceChangeTimer);
    }
    this.deviceChangeTimer = setTimeout(() => {
      this.deviceChangeTimer = null;
      this.handleAudioDeviceChange();
    }, 220);
  };

  constructor() {
    if (
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.addEventListener === 'function'
    ) {
      try {
        navigator.mediaDevices.addEventListener('devicechange', this.handleDeviceChangeBound);
      } catch {
        // Ignore environments that disallow mediaDevices listeners
      }
    }
  }

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

  /**
   * Starts an HTMLAudioElement guarded by `playbackGeneration` so any async `play()` Promise
   * resolving after `pauseMultiTrackPlayback()` immediately re-pauses the element.
   */
  private safePlayElement(
    el: HTMLAudioElement,
    gen: number,
    onError?: (err: unknown) => void
  ): void {
    if (gen !== this.playbackGeneration || !this.wasPlaying) return;
    try {
      const p = el.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          if (gen !== this.playbackGeneration || !this.wasPlaying) {
            try {
              el.pause();
            } catch {
              // Ignore pause errors
            }
          }
        }).catch((err) => {
          onError?.(err);
        });
      }
    } catch (err) {
      onError?.(err);
    }
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
        this.safePlayElement(el, this.playbackGeneration);
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
  private lastPllAdjustPerfMs = 0;
  private decodedAuxBuffers = new Map<string, AudioBuffer>();
  private decodingAuxUrls = new Set<string>();
  private activeWebAudioAux = new Map<
    'intro_bgm' | 'outro_bgm' | 'intro_vo',
    {
      url: string;
      source: AudioBufferSourceNode;
      gainNode: GainNode;
      startedCtxTime: number;
      startOffsetSec: number;
      playbackRate: number;
      loop: boolean;
    }
  >();

  private setDecodedBufferWithLru(url: string, audioBuf: AudioBuffer): void {
    this.decodedAuxBuffers.delete(url);
    this.decodedAuxBuffers.set(url, audioBuf);

    const MAX_CACHED_BUFFERS = 24;
    const MAX_CACHED_BYTES = 512 * 1024 * 1024;
    const estimateBytes = (b: AudioBuffer) => b.length * b.numberOfChannels * 4;

    let totalBytes = 0;
    for (const b of this.decodedAuxBuffers.values()) {
      totalBytes += estimateBytes(b);
    }

    while (
      this.decodedAuxBuffers.size > 1 &&
      (this.decodedAuxBuffers.size > MAX_CACHED_BUFFERS || totalBytes > MAX_CACHED_BYTES)
    ) {
      const oldestKey = this.decodedAuxBuffers.keys().next().value;
      if (!oldestKey || oldestKey === url) break;
      const oldestBuf = this.decodedAuxBuffers.get(oldestKey);
      this.decodedAuxBuffers.delete(oldestKey);
      if (oldestBuf) {
        totalBytes -= estimateBytes(oldestBuf);
      }
    }
  }

  private preloadDecodedUrl(resolvedUrl: string | undefined): void {
    if (!resolvedUrl) return;
    if (this.decodedAuxBuffers.has(resolvedUrl) || this.decodingAuxUrls.has(resolvedUrl)) return;
    const ctx = this.ensureContext();
    if (!ctx || typeof fetch === 'undefined') return;
    this.decodingAuxUrls.add(resolvedUrl);
    void fetch(resolvedUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((arr) => ctx.decodeAudioData(arr))
      .then((audioBuf) => {
        this.setDecodedBufferWithLru(resolvedUrl, audioBuf);
      })
      .catch(() => {
        // Fallback smoothly to HTMLAudioElement if decode fails
      })
      .finally(() => {
        this.decodingAuxUrls.delete(resolvedUrl);
      });
  }

  private preloadDecodedAuxBuffer(
    rawUrl: string | undefined,
    filePath: string | undefined,
    useProxy = false
  ): void {
    const baseUrl = normalizePlayableAudioUrl(rawUrl, filePath, false);
    const resolvedUrl = appendProxyParamIfEnabled(baseUrl, useProxy);
    this.preloadDecodedUrl(resolvedUrl);
  }

  private stopWebAudioAux(slot: 'intro_bgm' | 'outro_bgm' | 'intro_vo'): void {
    const active = this.activeWebAudioAux.get(slot);
    if (!active) return;
    this.activeWebAudioAux.delete(slot);
    try {
      active.source.stop();
    } catch {
      // Ignore already stopped source
    }
    try {
      active.source.disconnect();
      active.gainNode.disconnect();
    } catch {
      // Ignore disconnect errors
    }
  }

  private syncWebAudioAux(
    slot: 'intro_bgm' | 'outro_bgm' | 'intro_vo',
    rawUrl: string | undefined,
    filePath: string | undefined,
    activeWindow: boolean,
    offsetSec: number,
    playbackRate: number,
    targetGain: number,
    loop: boolean,
    forceRestart: boolean,
    loopStartSec?: number,
    loopEndSec?: number
  ): boolean {
    if (!activeWindow) {
      this.stopWebAudioAux(slot);
      return false;
    }
    const resolvedUrl = normalizePlayableAudioUrl(rawUrl, filePath, false);
    if (!resolvedUrl) {
      this.stopWebAudioAux(slot);
      return false;
    }
    const buffer = this.decodedAuxBuffers.get(resolvedUrl);
    if (!buffer) {
      this.preloadDecodedAuxBuffer(rawUrl, filePath);
      return false;
    }
    const ctx = this.ensureContext();
    if (!ctx) return false;
    if (ctx.state !== 'running') {
      void ctx.resume();
      return false;
    }

    const dur = Math.max(0.05, buffer.duration);
    const hasCustomLoop =
      loop &&
      typeof loopStartSec === 'number' &&
      typeof loopEndSec === 'number' &&
      loopEndSec > loopStartSec + 0.05;
    const effLoopStart = hasCustomLoop ? Math.max(0, Math.min(dur - 0.05, loopStartSec!)) : 0;
    const effLoopEnd = hasCustomLoop ? Math.max(effLoopStart + 0.05, Math.min(dur, loopEndSec!)) : dur;
    const effSpan = Math.max(0.05, effLoopEnd - effLoopStart);

    const desiredOffset = loop
      ? effLoopStart + ((((offsetSec - effLoopStart) % effSpan) + effSpan) % effSpan)
      : Math.max(0, offsetSec);
    if (!loop && desiredOffset >= dur - 0.02) {
      this.stopWebAudioAux(slot);
      return true;
    }

    const now = ctx.currentTime;
    const existing = this.activeWebAudioAux.get(slot);
    if (existing && existing.url === resolvedUrl && !forceRestart) {
      const elapsed = Math.max(0, now - existing.startedCtxTime) * existing.playbackRate;
      const curPos = loop
        ? effLoopStart + (((existing.startOffsetSec - effLoopStart + elapsed) % effSpan + effSpan) % effSpan)
        : existing.startOffsetSec + elapsed;
      const drift = Math.abs(curPos - desiredOffset);
      const wrapDrift = loop ? Math.min(drift, effSpan - drift) : drift;
      if (wrapDrift <= 1.2) {
        if (Math.abs(existing.playbackRate - playbackRate) > 0.005) {
          existing.startOffsetSec = curPos;
          existing.startedCtxTime = now;
          existing.playbackRate = playbackRate;
          existing.source.playbackRate.setTargetAtTime(playbackRate, now, 0.02);
        }
        existing.gainNode.gain.setTargetAtTime(Math.max(0, Math.min(1, targetGain)), now, 0.045);
        return true;
      }
    }

    this.stopWebAudioAux(slot);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    if (hasCustomLoop) {
      source.loopStart = effLoopStart;
      source.loopEnd = effLoopEnd;
    }
    source.playbackRate.value = playbackRate;
    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(Math.max(0, Math.min(1, targetGain)), now);
    source.connect(gainNode);
    gainNode.connect(ctx.destination);
    source.start(0, desiredOffset);

    this.activeWebAudioAux.set(slot, {
      url: resolvedUrl,
      source,
      gainNode,
      startedCtxTime: now,
      startOffsetSec: desiredOffset,
      playbackRate,
      loop,
    });
    return true;
  }

  private unlockContextOnGesture(ctx: AudioContext): void {
    try {
      const stateStr = ctx.state as string;
      if (stateStr === 'suspended' || stateStr === 'interrupted') {
        void ctx.resume();
      }
      const buf = ctx.createBuffer(1, 1, Math.max(8000, ctx.sampleRate || 22050));
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      // Ignore unlock failures
    }
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (this.ctx && (this.ctx.state as string) === 'closed') {
      this.ctx = null;
    }
    if (!this.ctx) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        const created = new Ctx();
        created.addEventListener?.('statechange', () => {
          if (this.ctx !== created) return;
          const st = created.state as string;
          if ((st === 'suspended' || st === 'interrupted') && this.wasPlaying) {
            void created.resume().catch(() => {});
          } else if (st === 'closed') {
            this.ctx = null;
          }
        });
        this.ctx = created;
      }
    }
    if (this.ctx) {
      const st = this.ctx.state as string;
      if (st === 'suspended' || st === 'interrupted') {
        void this.ctx.resume().catch(() => {});
      }
    }
    return this.ctx;
  }

  private rebindAudioElementForDeviceChange(
    el: HTMLAudioElement,
    holder?: ManagedAudioHolder | null
  ): void {
    const sinkEl = el as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
    if (typeof sinkEl.setSinkId === 'function') {
      void sinkEl.setSinkId('').catch(() => {});
    }

    const hasSource = Boolean(el.getAttribute('src') || el.src);
    if (!hasSource || el.readyState === 0) return;

    const wasActive = !el.paused && !el.ended;
    const curTime = Number.isFinite(el.currentTime) ? Math.max(0, el.currentTime) : 0;

    if (holder) {
      holder.pendingSeekSec = curTime;
      holder.lastPlayRetryPerfMs = 0;
      try {
        el.pause();
      } catch {
        // Ignore pause errors
      }
      try {
        el.load();
      } catch {
        // Ignore load errors
      }
      return;
    }

    // Standalone HTMLAudioElement (e.g. bgmPreviewAudio)
    try {
      el.pause();
    } catch {
      // Ignore pause errors
    }
    const onReloaded = () => {
      el.removeEventListener('loadedmetadata', onReloaded);
      try {
        const maxDur =
          el.duration && Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.02) : curTime;
        el.currentTime = Math.max(0, Math.min(curTime, maxDur));
      } catch {
        // Ignore seek errors
      }
      if (wasActive) {
        void el.play().catch(() => {});
      }
    };
    el.addEventListener('loadedmetadata', onReloaded);
    try {
      el.load();
    } catch {
      el.removeEventListener('loadedmetadata', onReloaded);
    }
  }

  public handleAudioDeviceChange(): void {
    // 1. Tear down active WebAudio nodes & recreate AudioContext so OS audio unit binds to new output device
    this.stopSkim();
    this.stopWebAudioMainTracks(true);
    this.stopWebAudioAux('intro_bgm');
    this.stopWebAudioAux('outro_bgm');
    this.stopWebAudioAux('intro_vo');
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
    this.stretchedChunkCache.clear();

    if (this.ctx) {
      const oldCtx = this.ctx;
      this.ctx = null;
      try {
        void oldCtx.close().catch(() => {});
      } catch {
        // Ignore close errors
      }
    }

    // 2. Rebind native HTMLAudioElements to the new OS default output device
    for (const holder of this.trackElements.values()) {
      this.rebindAudioElementForDeviceChange(holder.audio, holder);
    }
    for (const clipHolder of this.coldOpenClipElements.values()) {
      this.rebindAudioElementForDeviceChange(clipHolder.audio, clipHolder);
    }
    for (const slot of ['intro', 'outro'] as const) {
      const b = this.bgmTimelineElements[slot];
      if (b) {
        this.rebindAudioElementForDeviceChange(b.audio, b);
      }
    }
    if (this.introVoiceoverTimelineEl) {
      this.rebindAudioElementForDeviceChange(
        this.introVoiceoverTimelineEl.audio,
        this.introVoiceoverTimelineEl
      );
    }
    if (this.mixHolder) {
      const el = this.mixHolder.audio;
      const sinkEl = el as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
      if (typeof sinkEl.setSinkId === 'function') {
        void sinkEl.setSinkId('').catch(() => {});
      }
      if (el.getAttribute('src') && el.readyState > 0) {
        const curTime = Number.isFinite(el.currentTime) ? Math.max(0, el.currentTime) : 0;
        this.mixHolder.pendingSeekSec = curTime;
        this.mixHolder.pendingPlayAfterLoad = this.wasPlaying;
        try {
          el.pause();
          el.load();
        } catch {
          // Ignore reload errors
        }
      }
    }
    if (this.bgmPreviewAudio) {
      this.rebindAudioElementForDeviceChange(this.bgmPreviewAudio, null);
    }

    // 3. Re-arm AudioContext & force next sync frame to re-sync playback smoothly if currently playing
    if (this.wasPlaying) {
      this.forceSeekPending = true;
      this.ensureContext();
    }
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
        this.safePlayElement(el, this.playbackGeneration);
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
            this.safePlayElement(el, this.playbackGeneration);
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
            this.safePlayElement(el, this.playbackGeneration);
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

    const useProxy = state.proxyEditingEnabled !== false;
    this.warmupTrackBuffersForSkim(playable, useProxy);
    const rate = state.playbackRate || 1.0;
    for (const tr of playable) {
      const sourceKey = `${tr.audioUrl ?? ''}|${tr.filePath ?? ''}|${tr.sourceFilePath ?? ''}|proxy=${useProxy ? 1 : 0}`;
      const existing = this.trackElements.get(tr.id);
      if (!existing || existing.sourceKey !== sourceKey || existing.failedFatal) {
        if (existing) {
          this.disposeHolder(existing);
          this.trackElements.delete(tr.id);
        }
        const previewAudioUrl = appendProxyParamIfEnabled(
          normalizePlayableAudioUrl(tr.audioUrl, tr.filePath, false),
          useProxy
        );
        const created = this.createManagedHolder(
          previewAudioUrl ?? tr.audioUrl,
          tr.filePath,
          tr.name,
          rate,
          false,
          tr.sourceFilePath
        );
        if (created) {
          created.sourceKey = sourceKey;
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

    // Pre-warm fixed intro voiceover element & Web Audio buffer so entering intro voiceover starts with 0ms lag
    if (
      state.introVoiceover?.enabled &&
      (state.introVoiceover.audioUrl || state.introVoiceover.filePath)
    ) {
      this.preloadDecodedAuxBuffer(state.introVoiceover.audioUrl, state.introVoiceover.filePath);
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

    // Pre-warm Intro & Outro BGM elements & Web Audio buffers so BGM plays with zero stutter
    const playbackRate = Math.max(0.5, Math.min(3.5, state.playbackRate || 1.0));
    for (const [slot, asset, label] of [
      ['intro', state.introBgm, '片头 BGM'],
      ['outro', state.outroBgm, '片尾 BGM'],
    ] as const) {
      const effectivePath = asset?.filePath || (slot === 'intro' ? state.bgmWavPath : undefined);
      if (asset?.enabled && (asset.audioUrl || effectivePath)) {
        this.preloadDecodedAuxBuffer(asset.audioUrl, effectivePath);
        const bgmKey = `${asset.audioUrl ?? ''}|${effectivePath ?? ''}|`;
        const existing = this.bgmTimelineElements[slot];
        if (!existing || existing.sourceKey !== bgmKey || existing.failedFatal) {
          this.disposeHolder(existing);
          this.bgmTimelineElements[slot] = this.createManagedHolder(
            asset.audioUrl,
            effectivePath,
            label,
            playbackRate,
            true
          );
        }
      }
    }
  }

  /**
   * Pre-seeks audio elements while paused so subsequent Play starts with zero decoder buffering lag.
   */
  public preSeekWhenPaused(
    state: PodcastProjectState,
    timeline: TimelineComputation,
    playheadSec: number
  ): void {
    if (typeof window === 'undefined' || typeof Audio === 'undefined') return;
    if (this.wasPlaying) return;
    this.lastKnownPlayheadSec = playheadSec;
    this.forceSeekPending = true;

    const playable = selectPlayableTracks(state);
    if (playable.length === 0) return;

    const mapped = resolveEditedPlayheadToSource(state, timeline, playheadSec);
    this.warmupTrackBuffersForSkim(
      playable,
      state.proxyEditingEnabled !== false,
      mapped.sourceSec ?? 0
    );
    if (mapped.sourceSec !== null && !mapped.inIntroOrGapSilence) {
      for (const tr of playable) {
        const holder = this.trackElements.get(tr.id);
        if (!holder || holder.failedFatal) continue;
        const effOffset = state.recordingMode === 'same_room_sync' ? 0 : (tr.syncOffsetMs || 0) / 1000;
        const targetSec = Math.max(0, mapped.sourceSec - effOffset);
        this.seekHolderOnSpliceOnly(holder, targetSec, true);
      }
    }

    if (mapped.inColdOpen && !mapped.inIntroOrGapSilence && mapped.activeHighlight) {
      const hl = mapped.activeHighlight;
      for (const tr of playable) {
        const clipHolder = this.coldOpenClipElements.get(`${hl.id}::${tr.id}`);
        if (!clipHolder || clipHolder.failedFatal) continue;
        const effOffset = state.recordingMode === 'same_room_sync' ? 0 : (tr.syncOffsetMs || 0) / 1000;
        const clipTarget =
          mapped.sourceSec !== null
            ? Math.max(0, mapped.sourceSec - effOffset)
            : Math.max(0, hl.sourceStartMs / 1000 - effOffset);
        this.seekHolderOnSpliceOnly(clipHolder, clipTarget, true);
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
    this.playbackGeneration += 1;
    const playGen = this.playbackGeneration;
    this.wasPlaying = true;
    this.reportedErrorKeys.clear();
    this.lastKnownPlayheadSec = playheadSec;
    const ctx = this.ensureContext();
    if (ctx && ctx.state !== 'running') {
      this.unlockContextOnGesture(ctx);
    }
    const playable = selectPlayableTracks(state);
    const needsTrackWarmup = playable.some((tr) => !this.trackElements.has(tr.id));
    if (needsTrackWarmup) {
      this.preloadTracks(state);
    }
    this.forceSeekPending = true;
    this.playStartPerfMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.lastSpanIndex = null;
    this.lastHeldSpeakerId = null;
    this.speakerHoldUntilPerfMs.clear();

    const prefixTotalSec =
      timeline.prefixDurationSec ??
      timeline.coldOpenDurationSec + timeline.introVoiceoverDurationSec;
    const inIntroOnlyStart = playheadSec < Math.max(0, prefixTotalSec - 1.5);

    // Seek BEFORE play() synchronously inside user gesture so AVPlayer unlocks needed stems.
    // Skip <audio> seek+play if WebAudio main tracks already have all current chunks decoded and ready,
    // avoiding a redundant seek -> play -> immediate-pause media pipeline thrash.
    const mapped = resolveEditedPlayheadToSource(state, timeline, playheadSec);
    const useProxy = state.proxyEditingEnabled !== false;
    const anySolo = state.tracks.some((t) => t.solo) || Boolean(state.introBgm?.solo);
    let webAudioMainReady =
      useProxy &&
      Boolean(ctx && ctx.state === 'running') &&
      !mapped.inColdOpen &&
      !mapped.inIntroOrGapSilence &&
      mapped.sourceSec !== null &&
      playable.length > 0;
    if (webAudioMainReady && mapped.sourceSec !== null) {
      for (const tr of playable) {
        if (tr.muted || (anySolo && !tr.solo)) continue;
        const effOffset =
          state.recordingMode === 'same_room_sync' ? 0 : (tr.syncOffsetMs || 0) / 1000;
        const trAbsSec = Math.max(0, mapped.sourceSec - effOffset);
        const chunkIdx = Math.max(0, Math.floor(trAbsSec / SKIM_CHUNK_DURATION_SEC));
        const baseUrl = normalizePlayableAudioUrl(tr.audioUrl, tr.filePath, false);
        const chunkUrl = appendProxyChunkUrl(baseUrl, chunkIdx);
        if (!chunkUrl || !this.decodedAuxBuffers.has(chunkUrl)) {
          webAudioMainReady = false;
          break;
        }
      }
    }

    if (!webAudioMainReady) {
      for (const tr of playable) {
        const holder = this.trackElements.get(tr.id);
        if (!holder || holder.failedFatal) continue;
        const effOffset =
          state.recordingMode === 'same_room_sync' ? 0 : (tr.syncOffsetMs || 0) / 1000;
        const targetSec =
          mapped.sourceSec !== null && !mapped.inIntroOrGapSilence
            ? Math.max(0, mapped.sourceSec - effOffset)
            : 0;
        this.seekHolderOnSpliceOnly(holder, targetSec, true);
        if (!inIntroOnlyStart && (holder.audio.paused || holder.audio.ended)) {
          holder.audio.volume = 0;
          holder.lastPlayRetryPerfMs = this.playStartPerfMs;
          this.safePlayElement(holder.audio, playGen);
        }
      }
    }

    if (mapped.inColdOpen) {
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
        if (isCurrentHl && (clipEl.paused || clipEl.ended)) {
          clipEl.volume = 0;
          clipHolder.lastPlayRetryPerfMs = this.playStartPerfMs;
          this.safePlayElement(clipEl, playGen);
        }
      }
    }

    const voStart = timeline.introVoiceoverStartSec ?? timeline.coldOpenDurationSec;
    const voEnd = voStart + timeline.introVoiceoverDurationSec;
    const inVoNow =
      Boolean(state.introVoiceover?.enabled) &&
      timeline.introVoiceoverDurationSec > 0 &&
      playheadSec >= voStart &&
      playheadSec < voEnd;
    if (inVoNow) {
      const voResolvedUrl = normalizePlayableAudioUrl(
        state.introVoiceover?.audioUrl,
        state.introVoiceover?.filePath,
        false
      );
      const voHasWebAudio = Boolean(voResolvedUrl && this.decodedAuxBuffers.has(voResolvedUrl));
      if (
        !voHasWebAudio &&
        this.introVoiceoverTimelineEl &&
        !this.introVoiceoverTimelineEl.failedFatal
      ) {
        const voTarget = Math.max(0, playheadSec - voStart);
        const voEl = this.introVoiceoverTimelineEl.audio;
        this.seekHolderOnSpliceOnly(this.introVoiceoverTimelineEl, voTarget, true);
        if (voEl.paused || voEl.ended) {
          voEl.volume = 0;
          this.introVoiceoverTimelineEl.lastPlayRetryPerfMs = this.playStartPerfMs;
          this.safePlayElement(voEl, playGen);
        }
      }
    }

    const playbackRate = Math.max(0.5, Math.min(3.5, state.playbackRate || 1.0));
    const voStartForBgm = timeline.introVoiceoverStartSec ?? timeline.coldOpenDurationSec;
    const voiceEndForBgm = Math.max(
      timeline.coldOpenDurationSec,
      state.introVoiceover?.enabled && timeline.introVoiceoverDurationSec > 0
        ? voStartForBgm + timeline.introVoiceoverDurationSec
        : 0
    );
    const customIntroBgmSec = state.introBgm?.customDurationSec;
    const rawIntroBgmSec =
      timeline.introBgmDurationSec && timeline.introBgmDurationSec > 0
        ? timeline.introBgmDurationSec
        : voiceEndForBgm > 0
        ? voiceEndForBgm
        : Math.min(10, timeline.totalEditedDurationSec * 0.35);
    const introEndSec =
      customIntroBgmSec && customIntroBgmSec > 0
        ? customIntroBgmSec
        : voiceEndForBgm > 0
        ? Math.min(rawIntroBgmSec, voiceEndForBgm)
        : rawIntroBgmSec;
    const customOutroSec = state.outroBgm?.customDurationSec;
    const outroSliceDur =
      state.outroBgm?.enabled && (state.outroBgm?.durationSec || state.outroBgm?.sourceEndSec)
        ? Math.max(
            0.5,
            (state.outroBgm.sourceEndSec ?? state.outroBgm.durationSec ?? 15) -
              (state.outroBgm.sourceStartSec ?? 0)
          ) * 1.2
        : 0;
    const outroWindowSec =
      typeof customOutroSec === 'number' && customOutroSec > 0
        ? customOutroSec
        : outroSliceDur > 0
        ? Number(outroSliceDur.toFixed(1))
        : Math.min(20, Math.max(6, timeline.totalEditedDurationSec * 0.18));
    const outroStartSec =
      typeof state.outroBgm?.startOffsetSec === 'number' && state.outroBgm.startOffsetSec >= 0
        ? Math.min(timeline.totalEditedDurationSec, state.outroBgm.startOffsetSec)
        : Math.max(introEndSec + 0.5, timeline.totalEditedDurationSec - outroWindowSec);
    const outroEndSec = Math.min(timeline.totalEditedDurationSec, outroStartSec + outroWindowSec);

    for (const slot of ['intro', 'outro'] as const) {
      const asset = slot === 'intro' ? state.introBgm : state.outroBgm;
      const effectivePath = asset?.filePath || (slot === 'intro' ? state.bgmWavPath : undefined);
      const resolvedBgmUrl = normalizePlayableAudioUrl(asset?.audioUrl, effectivePath, false);
      const hasWebAudio = Boolean(resolvedBgmUrl && this.decodedAuxBuffers.has(resolvedBgmUrl));
      const bgmHolder = this.bgmTimelineElements[slot];
      if (!hasWebAudio && bgmHolder && !bgmHolder.failedFatal) {
        const bgmEl = bgmHolder.audio;
        applyPitchPreservingPlaybackRate(bgmEl, playbackRate);
        const inWindowNow =
          slot === 'intro'
            ? Boolean(state.introBgm?.enabled) && playheadSec <= introEndSec
            : Boolean(state.outroBgm?.enabled) &&
              timeline.totalEditedDurationSec > 3 &&
              playheadSec >= outroStartSec &&
              playheadSec <= outroEndSec;
        const rawOffsetSec =
          slot === 'intro'
            ? Math.max(0, playheadSec)
            : Math.max(0, playheadSec - outroStartSec);
        const bgmTarget =
          inWindowNow && bgmEl.duration && Number.isFinite(bgmEl.duration)
            ? rawOffsetSec % Math.max(1, bgmEl.duration)
            : inWindowNow
            ? rawOffsetSec
            : 0;
        this.seekHolderOnSpliceOnly(bgmHolder, bgmTarget, true);
        if (inWindowNow && (bgmEl.paused || bgmEl.ended)) {
          bgmEl.volume = 0;
          bgmHolder.lastPlayRetryPerfMs = this.playStartPerfMs;
          this.safePlayElement(bgmEl, playGen);
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
      try {
        this.bgmPreviewAudio.pause();
        this.bgmPreviewAudio.removeAttribute('src');
        this.bgmPreviewAudio.load();
      } catch {
        // Ignore cleanup errors
      }
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
    const playPreviewEl = () => {
      try {
        const p = el.play();
        if (p && typeof p.then === 'function') {
          p.then(() => {
            if (this.bgmPreviewAudio !== el) {
              try {
                el.pause();
              } catch {
                // Ignore pause errors
              }
            }
          }).catch(() => {
            if (this.bgmPreviewAudio === el) {
              this.stopBgmPreview();
              onEnded?.();
            }
          });
        }
      } catch {
        if (this.bgmPreviewAudio === el) {
          this.stopBgmPreview();
          onEnded?.();
        }
      }
    };
    el.onerror = () => {
      if (this.bgmPreviewAudio !== el) return;
      if (!retried) {
        const fallback = normalizePlayableAudioUrl(audioUrl, filePath, true);
        if (fallback && fallback !== resolvedUrl) {
          retried = true;
          el.src = fallback;
          el.load();
          playPreviewEl();
          return;
        }
      }
      this.stopBgmPreview();
      onEnded?.();
    };
    el.onended = () => {
      if (this.bgmPreviewAudio !== el) return;
      this.bgmPreviewSlot = null;
      this.bgmPreviewAudio = null;
      onEnded?.();
    };
    this.bgmPreviewAudio = el;
    this.bgmPreviewSlot = slot;
    playPreviewEl();
    return true;
  }

  /**
   * 仅即时更新所有活跃音轨与 BGM 的倍速，不触发 seek、不重算 AutoSolo、不打断缓冲。
   */
  public setLivePlaybackRate(rate: number): void {
    const safeRate = Math.max(0.5, Math.min(3.5, rate || 1.0));
    if (this.mixHolder && !this.mixHolder.failed) {
      applyPitchPreservingPlaybackRate(this.mixHolder.audio, safeRate);
    }
    for (const entry of this.trackElements.values()) {
      if (!entry.failedFatal) {
        applyPitchPreservingPlaybackRate(entry.audio, safeRate);
      }
    }
    for (const entry of this.coldOpenClipElements.values()) {
      if (!entry.failedFatal) {
        applyPitchPreservingPlaybackRate(entry.audio, safeRate);
      }
    }
    if (this.introVoiceoverTimelineEl && !this.introVoiceoverTimelineEl.failedFatal) {
      applyPitchPreservingPlaybackRate(this.introVoiceoverTimelineEl.audio, safeRate);
    }
    for (const slot of ['intro', 'outro'] as const) {
      const h = this.bgmTimelineElements[slot];
      if (h && !h.failedFatal) {
        applyPitchPreservingPlaybackRate(h.audio, safeRate);
      }
    }
    const ctxNow = this.ctx && this.ctx.state === 'running' ? this.ctx.currentTime : null;
    for (const active of this.activeWebAudioAux.values()) {
      if (ctxNow !== null) {
        const elapsed = Math.max(0, ctxNow - active.startedCtxTime) * active.playbackRate;
        active.startOffsetSec += elapsed;
        active.startedCtxTime = ctxNow;
        active.playbackRate = safeRate;
        active.source.playbackRate.setTargetAtTime(safeRate, ctxNow, 0.015);
      } else {
        active.playbackRate = safeRate;
      }
    }
  }

  public pauseMultiTrackPlayback(): void {
    this.playbackGeneration += 1;
    this.wasPlaying = false;
    this.forceSeekPending = true;
    this.lastSpanIndex = null;
    this.stopSkim(true);
    this.stopWebAudioMainTracks(true);
    this.stopBgmPreview();
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
    if (this.mixHolder) {
      this.mixHolder.pendingPlayAfterLoad = false;
      try {
        this.mixHolder.audio.pause();
      } catch {
        // Ignore pause errors
      }
    }
    for (const entry of this.trackElements.values()) {
      try {
        entry.audio.pause();
      } catch {
        // Ignore pause errors
      }
    }
    for (const clipEntry of this.coldOpenClipElements.values()) {
      try {
        clipEntry.audio.pause();
      } catch {
        // Ignore pause errors
      }
    }
    if (this.introVoiceoverTimelineEl) {
      try {
        this.introVoiceoverTimelineEl.audio.pause();
      } catch {
        // Ignore pause errors
      }
    }
    this.stopWebAudioAux('intro_bgm');
    this.stopWebAudioAux('outro_bgm');
    this.stopWebAudioAux('intro_vo');
    for (const slot of ['intro', 'outro'] as const) {
      const b = this.bgmTimelineElements[slot];
      if (b) {
        try {
          b.audio.pause();
        } catch {
          // Ignore pause errors
        }
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
    if (!this.wasPlaying) {
      return { nextPlayheadSec: currentPlayheadSec, resolved: null };
    }
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
        if (this.ctx?.state === 'suspended' && nowPerf - this.playStartPerfMs < 350) {
          nextPlayheadSec = currentPlayheadSec;
        } else {
          // Prefix region: lock playhead tightly to sample-accurate Web Audio hardware clock when available
          const preMapped = resolveEditedPlayheadToSource(state, timeline, currentPlayheadSec);
          const webAudioVo = this.activeWebAudioAux.get('intro_vo');
          const webAudioBgm = this.activeWebAudioAux.get('intro_bgm');
          const ctxNow = this.ctx && this.ctx.state === 'running' ? this.ctx.currentTime : null;

          if (
            state.introVoiceover?.enabled &&
            timeline.introVoiceoverDurationSec > 0 &&
            currentPlayheadSec >= voStartSec &&
            currentPlayheadSec < voEndSec
          ) {
            if (webAudioVo && ctxNow !== null) {
              const hwEditedSec =
                voStartSec +
                webAudioVo.startOffsetSec +
                Math.max(0, ctxNow - webAudioVo.startedCtxTime) * webAudioVo.playbackRate;
              if (hwEditedSec >= voStartSec && hwEditedSec <= voEndSec) {
                const drift = hwEditedSec - nextPlayheadSec;
                if (Math.abs(drift) > 0.01 && Math.abs(drift) < 0.8) {
                  nextPlayheadSec = Math.max(currentPlayheadSec, nextPlayheadSec + drift * 0.65);
                }
              }
            } else {
              const voHolder = this.introVoiceoverTimelineEl;
              if (voHolder && !voHolder.failedFatal) {
                const voEl = voHolder.audio;
                if (!voEl.paused && !voEl.ended && !voEl.seeking && voEl.readyState >= 2) {
                  const hwEditedSec = voStartSec + voEl.currentTime;
                  if (hwEditedSec >= voStartSec && hwEditedSec <= voEndSec) {
                    const drift = hwEditedSec - nextPlayheadSec;
                    if (Math.abs(drift) > 0.025 && Math.abs(drift) < 1.0) {
                      nextPlayheadSec = Math.max(
                        currentPlayheadSec + stepSec * 0.25,
                        nextPlayheadSec + drift * 0.45
                      );
                    }
                  }
                }
              }
            }
          } else if (webAudioBgm && ctxNow !== null && !webAudioBgm.loop) {
            // Non-looping safety
          } else if (webAudioBgm && ctxNow !== null) {
            const bufDur = Math.max(0.05, webAudioBgm.source.buffer?.duration ?? 9999);
            const hwBgmSec =
              webAudioBgm.startOffsetSec +
              Math.max(0, ctxNow - webAudioBgm.startedCtxTime) * webAudioBgm.playbackRate;
            if (hwBgmSec < bufDur - 0.05) {
              const drift = hwBgmSec - nextPlayheadSec;
              if (Math.abs(drift) > 0.01 && Math.abs(drift) < 0.8) {
                nextPlayheadSec = Math.max(currentPlayheadSec, nextPlayheadSec + drift * 0.65);
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
              if (!el.paused && !el.ended && !el.seeking && el.readyState >= 2) {
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
                  if (Math.abs(drift) > 0.025 && Math.abs(drift) < 1.2) {
                    nextPlayheadSec = Math.max(
                      currentPlayheadSec + stepSec * 0.25,
                      nextPlayheadSec + drift * 0.45
                    );
                  }
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

        // 1. 起播前 220ms 内若所有音轨仍在初始解码缓冲，短暂保持游标等待首帧就绪（超时或任一主轨就绪后立即推进）
        if (this.activeWebAudioMainTracks.size === 0 && nowPerf - this.playStartPerfMs < 220) {
          let hasAnyValid = false;
          let hasAnyReady = false;
          for (let i = 0; i < playable.length; i++) {
            const h = this.trackElements.get(playable[i].id);
            if (!h || h.failedFatal) continue;
            hasAnyValid = true;
            if (!h.audio.seeking && h.audio.readyState >= 2) {
              hasAnyReady = true;
              break;
            }
          }
          if (hasAnyValid && !hasAnyReady) {
            nextPlayheadSec = currentPlayheadSec;
          }
        }

        // 2. 在连续未切剪片段内部（避开切片首尾接缝），锁相到硬件音频时钟：
        //    - 若当前由 Web Audio 分块引擎驱动，直接锁相到 AudioContext.currentTime，防止 rAF 掉帧引起假漂移和打断重播；
        //    - 否则从正在发声的 <audio> 硬件音轨做温和漂移软校准。
        if (
          this.activeWebAudioMainTracks.size > 0 &&
          spanHit &&
          this.lastSpanIndex === spanHit.span.spanIndex &&
          nextPlayheadSec > currentPlayheadSec &&
          this.ctx?.state === 'running'
        ) {
          const ctxNow = this.ctx.currentTime;
          const { span } = spanHit;
          for (const tr of playable) {
            const entry = this.activeWebAudioMainTracks.get(tr.id);
            if (!entry) continue;
            const effOffset =
              state.recordingMode === 'same_room_sync' ? 0 : (tr.syncOffsetMs || 0) / 1000;
            const hwInChunkSec =
              entry.startedInChunkSec +
              Math.max(0, ctxNow - entry.startedCtxTime) * entry.playbackRate;
            const hwSourceSec = entry.chunkIdx * SKIM_CHUNK_DURATION_SEC + hwInChunkSec + effOffset;
            const hwEditedSec = span.editedStartSec + (hwSourceSec - span.sourceStartSec);
            if (
              hwEditedSec >= span.editedStartSec &&
              hwEditedSec <= span.editedEndSec &&
              Math.abs(hwEditedSec - nextPlayheadSec) < 0.8
            ) {
              nextPlayheadSec = Math.max(currentPlayheadSec, hwEditedSec);
            }
            break;
          }
        } else if (
          this.activeWebAudioMainTracks.size === 0 &&
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
                  const rateScale = Math.max(1, playbackRate);
                  const inStartSettlingWindow = nowPerf - this.playStartPerfMs < 500;
                  if (Math.abs(drift) > 0.08 * rateScale && Math.abs(drift) < 0.5 * rateScale) {
                    nextPlayheadSec = Math.max(
                      currentPlayheadSec + stepSec * 0.8,
                      Math.min(currentPlayheadSec + stepSec * 1.2, nextPlayheadSec + drift * 0.12)
                    );
                  } else if (
                    !inStartSettlingWindow &&
                    Math.abs(drift) >= 0.5 * rateScale &&
                    Math.abs(drift) < 2.0 * rateScale
                  ) {
                    nextPlayheadSec =
                      drift > 0
                        ? Math.min(span.editedEndSec, nextPlayheadSec + drift * 0.25)
                        : currentPlayheadSec + stepSec * 0.75;
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
          // Cross-mic room echo/bleed filter: ignore secondary track residual below 52% of dominant track
          const notBleed = loudestNorm < 0.25 || s.normNow >= loudestNorm * 0.52 || s.normAhead >= loudestNorm * 0.55;
          if (notBleed && (s.normNow >= 0.24 || s.normAhead >= 0.28)) {
            this.speakerHoldUntilPerfMs.set(s.id, nowPerf + 420);
          }
        }
        if (!mapped.activeSpeakerId && loudestActiveId && loudestNorm >= 0.28) {
          this.lastHeldSpeakerId = loudestActiveId;
        }
      }
    }

    const dominantSpeakerId = mapped.activeSpeakerId ?? this.lastHeldSpeakerId;
    const playableAutoGainDbs = playableTracks.map((t) => t.autoGainDb || 0);

    // Dedicated Cold Open multi-track highlight playback (all tracks stay phase-locked at highlight source range)
    const inOrNearColdOpen =
      state.coldOpenEnabled &&
      state.highlights.length > 0 &&
      playheadSec <= timeline.coldOpenDurationSec + 0.8;
    const coldClipWindows = inOrNearColdOpen
      ? resolveColdOpenClipWindows(state.highlights, resolveEffectiveHighlightGapSec(state))
      : [];
    const activeColdHighlight =
      mapped.inColdOpen && !mapped.inIntroOrGapSilence ? mapped.activeHighlight : undefined;
    if (!inOrNearColdOpen) {
      for (const clipHolder of this.coldOpenClipElements.values()) {
        if (!clipHolder.failedFatal && !clipHolder.audio.paused) {
          this.applySlewedVolume(clipHolder, 0, true);
          clipHolder.audio.pause();
        }
      }
    } else {
      for (const [clipElemId, clipHolder] of this.coldOpenClipElements.entries()) {
        if (clipHolder.failedFatal) continue;
        const [hlId, trackId] = clipElemId.split('::');
        const clipEl = clipHolder.audio;
        if (!activeColdHighlight || activeColdHighlight.id !== hlId || mapped.sourceSec === null) {
          this.applySlewedVolume(clipHolder, 0, true);
          if (!clipEl.paused) {
            clipEl.pause();
          }
          // Pre-seek upcoming highlight within 0.6s so entry starts instantaneously on cue
          const upcomingWin = coldClipWindows.find((w) => w.highlight.id === hlId);
          if (upcomingWin && upcomingWin.startSec > playheadSec && upcomingWin.startSec - playheadSec <= 0.6) {
            const upTr = state.tracks.find((t) => t.id === trackId);
            const upOffset =
              upTr && state.recordingMode !== 'same_room_sync' ? (upTr.syncOffsetMs || 0) / 1000 : 0;
            const upStartSec = Math.max(0, upcomingWin.highlight.sourceStartMs / 1000 - upOffset);
            this.seekHolderOnSpliceOnly(clipHolder, upStartSec, false, 0.05, 500);
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
          if (tr) {
            clipGain *= computePreviewTrackLoudnessScale(
              tr.autoGainDb,
              playableAutoGainDbs,
              state.loudnessAligned
            );
          } else {
            clipGain *= 0.92;
          }

          // 与音轨模式保持一致的避让策略：减轻非发言时段音量，但保留他人对话音量
          const dominantColdSpeakerId = mapped.activeSpeakerId ?? activeColdHighlight.speakerId;
          const trackRecentlyOrSoonSpeaking =
            (this.speakerHoldUntilPerfMs.get(trackId) ?? 0) > nowPerf;
          const activeOvForTrack = timeline.overlapRegions.find(
            (ov) =>
              ov.secondarySpeakerId === trackId &&
              playheadSec >= ov.editedStartSec - 0.04 &&
              playheadSec <= ov.editedEndSec + 0.08
          );
          if (activeOvForTrack?.muted) {
            clipGain = 0.0;
          } else if (
            playableTracks.length > 1 &&
            state.autoSoloMode !== 'off' &&
            trackId !== dominantColdSpeakerId &&
            !trackRecentlyOrSoonSpeaking &&
            !activeOvForTrack
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
          isPrimaryHlTrack ? 0.18 : 0.25,
          isPrimaryHlTrack ? 900 : 1200
        );
        this.applySlewedVolume(clipHolder, clipGain, !this.wasPlaying || this.forceSeekPending);
        if ((clipEl.paused || clipEl.ended) && nowPerf - clipHolder.lastPlayRetryPerfMs > 240) {
          clipHolder.lastPlayRetryPerfMs = nowPerf;
          this.safePlayElement(clipEl, this.playbackGeneration);
        }
      }
    }

    // 选用稳定的主时钟音轨（不随发言人切换而跳变，避免主副轨角色互换引发 Seek 抖动和回音）
    const primarySyncTrack = pickPrimarySyncTrack(playableTracks);
    const primarySyncTrackId = primarySyncTrack?.id;
    let primaryActualSourceSec: number | null = null;
    if (!crossedCutOrScrub && primarySyncTrackId && mapped.sourceSec !== null && !mapped.inColdOpen && !mapped.inIntroOrGapSilence) {
      const pHolder = this.trackElements.get(primarySyncTrackId);
      if (pHolder && !pHolder.failedFatal && !pHolder.audio.paused && !pHolder.audio.seeking && pHolder.audio.readyState >= 2) {
        const pOffset = state.recordingMode === 'same_room_sync' ? 0 : (primarySyncTrack.syncOffsetMs || 0) / 1000;
        const cand = pHolder.audio.currentTime + pOffset;
        if (Math.abs(cand - mapped.sourceSec) <= 1.5) {
          primaryActualSourceSec = cand;
        }
      }
    }

    const useProxy = state.proxyEditingEnabled !== false;
    const canUseWebAudioMain =
      useProxy &&
      !mapped.inColdOpen &&
      !mapped.inIntroOrGapSilence &&
      mapped.sourceSec !== null &&
      this.trySyncWebAudioMainTracks(
        state,
        timeline,
        playableTracks,
        mapped.sourceSec,
        playheadSec,
        playbackRate,
        crossedCutOrScrub,
        anySolo,
        dominantSpeakerId,
        playableAutoGainDbs,
        nowPerf
      );

    if (canUseWebAudioMain) {
      // 暂停 <audio> 主轨防止双声，同时保持静默不销毁已加载元素
      for (const entry of this.trackElements.values()) {
        if (!entry.audio.paused) {
          entry.audio.pause();
        }
      }
      // 依然保留 BGM / 辅助轨同步
      this.syncTimelineAuxBeds(
        state,
        timeline,
        playheadSec,
        playbackRate,
        mapped,
        anySolo,
        crossedCutOrScrub,
        dominantSpeakerId,
        coldClipWindows,
        nowPerf
      );
      this.wasPlaying = true;
      this.forceSeekPending = false;
      this.lastSpanIndex = mapped.spanIndex;
      return mapped;
    }

    this.stopWebAudioMainTracks();

    for (const tr of playableTracks) {
      const sourceKey = `${tr.audioUrl ?? ''}|${tr.filePath ?? ''}|${tr.sourceFilePath ?? ''}|proxy=${useProxy ? 1 : 0}`;
      let holder = this.trackElements.get(tr.id);
      if (!holder || holder.sourceKey !== sourceKey) {
        if (holder) this.disposeHolder(holder);
        const previewAudioUrl = appendProxyParamIfEnabled(
          normalizePlayableAudioUrl(tr.audioUrl, tr.filePath, false),
          useProxy
        );
        const created = this.createManagedHolder(
          previewAudioUrl ?? tr.audioUrl,
          tr.filePath,
          tr.name,
          playbackRate,
          false,
          tr.sourceFilePath
        );
        if (!created) continue;
        created.sourceKey = sourceKey;
        holder = created;
        this.trackElements.set(tr.id, holder);
      }
      if (holder.failedFatal) continue;

      const audioEl = holder.audio;

      if (mapped.inColdOpen || mapped.sourceSec === null || mapped.inIntroOrGapSilence) {
        applyPitchPreservingPlaybackRate(audioEl, playbackRate);
        this.applySlewedVolume(holder, 0, !this.wasPlaying);
        // 静默区间保持音量为 0，不强行 pause audioEl，防止失去用户手势授权导致后续切回人声时被浏览器自动播放策略拦截
        continue;
      }

      const effectiveOffsetSec =
        state.recordingMode === 'same_room_sync' ? 0 : (tr.syncOffsetMs || 0) / 1000;
      const isPrimarySyncTrack = tr.id === primarySyncTrackId;
      // 副轨直接锁定主轨真实 <audio>.currentTime，消除浏览器解码/Seek 偏差导致的跨轨回音
      const baseSourceSec =
        !isPrimarySyncTrack && primaryActualSourceSec !== null
          ? primaryActualSourceSec
          : mapped.sourceSec;
      const targetTrackSec = Math.max(0, baseSourceSec - effectiveOffsetSec);

      if (
        isPrimarySyncTrack ||
        primaryActualSourceSec === null ||
        audioEl.paused ||
        audioEl.seeking ||
        crossedCutOrScrub ||
        Math.abs(playbackRate - 1.0) > 0.02
      ) {
        applyPitchPreservingPlaybackRate(audioEl, playbackRate);
      } else {
        // PLL 相位锁定（节流 + 10ms~25ms 区间）：紧锁主轨相位，消除多轨不同步产生的回声，同时避免每帧重置 WSOLA
        const signedDrift = targetTrackSec - audioEl.currentTime;
        if (Math.abs(signedDrift) <= 0.01) {
          applyPitchPreservingPlaybackRate(audioEl, playbackRate);
        } else if (Math.abs(signedDrift) < 0.08 && nowPerf - this.lastPllAdjustPerfMs >= 120) {
          this.lastPllAdjustPerfMs = nowPerf;
          const nudge = Math.max(-0.035, Math.min(0.035, signedDrift * 1.2));
          applyPitchPreservingPlaybackRate(audioEl, playbackRate * (1 + nudge));
        } else if (Math.abs(signedDrift) >= 0.08) {
          applyPitchPreservingPlaybackRate(audioEl, playbackRate);
        }
      }

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
        gain *= computePreviewTrackLoudnessScale(
          tr.autoGainDb,
          playableAutoGainDbs,
          state.loudnessAligned
        );

        // Primary-Speaker Priority Auto-Ducking fallback (only ducks low-level floor noise/bleed; genuine speech on other tracks is left to the editor)
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
          !trackRecentlyOrSoonSpeaking &&
          !activeOvForTrack
        ) {
          if (state.autoSoloMode === 'hard_mute') {
            gain *= 0.06;
          } else {
            const baseDuck = Math.max(
              0.02,
              Math.min(0.50, Math.pow(10, state.duckAttenuationDb / 20))
            );
            const silentTurnDuck =
              state.recordingMode === 'same_room_sync'
                ? Math.min(baseDuck, 0.04)
                : baseDuck;
            gain *= silentTurnDuck;
          }
        }
      }

      // 仅对可听音轨在切点执行强对齐，静默/压低副轨放宽容差以消除密集剪辑段（如密集去口癖区）的多轨同步卡顿
      const shouldForceSpliceSeek =
        this.forceSeekPending || !this.wasPlaying || (crossedCutOrScrub && gain > 0.05);
      this.seekHolderOnSpliceOnly(
        holder,
        targetTrackSec,
        shouldForceSpliceSeek,
        isPrimarySyncTrack ? 0.9 : gain > 0.05 ? 0.035 : 0.25,
        isPrimarySyncTrack ? 1000 : 350
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
        if (audioEl.ended || Math.abs(audioEl.currentTime - targetTrackSec) > 0.015) {
          try {
            audioEl.currentTime = targetTrackSec;
          } catch {
            // ignore
          }
        }
        this.safePlayElement(audioEl, this.playbackGeneration, (err) => {
          if (String(err).includes('NotAllowedError')) {
            this.emitPlaybackErrorOnce(
              `autoplay_${tr.id}`,
              '🔊 浏览器拦截了自动播放，请再次点击播放按钮解锁音频输出'
            );
          }
        });
      }
    }

    this.syncTimelineAuxBeds(
      state,
      timeline,
      playheadSec,
      playbackRate,
      mapped,
      anySolo,
      crossedCutOrScrub,
      dominantSpeakerId,
      coldClipWindows,
      nowPerf
    );

    this.wasPlaying = true;
    this.forceSeekPending = false;
    this.lastSpanIndex = mapped.spanIndex;
    return mapped;
  }

  private stretchedChunkCache = new Map<string, AudioBuffer>();

  private getOrCreateStretchedChunk(
    ctx: AudioContext,
    chunkUrl: string,
    rawBuf: AudioBuffer,
    playbackRate: number
  ): { buf: AudioBuffer; effectiveRate: number } {
    const safeRate = Math.max(0.5, Math.min(3.5, playbackRate || 1.0));
    if (Math.abs(safeRate - 1.0) <= 0.015) {
      return { buf: rawBuf, effectiveRate: 1.0 };
    }
    const rateKey = safeRate.toFixed(2);
    const cacheKey = `${chunkUrl}|${rateKey}`;
    const cached = this.stretchedChunkCache.get(cacheKey);
    if (cached) {
      this.stretchedChunkCache.delete(cacheKey);
      this.stretchedChunkCache.set(cacheKey, cached);
      return { buf: cached, effectiveRate: Number(rateKey) };
    }

    const stretched = timeStretchAudioBufferWsola(ctx, rawBuf, Number(rateKey));
    this.stretchedChunkCache.set(cacheKey, stretched);
    const MAX_STRETCHED_CHUNKS = 16;
    while (this.stretchedChunkCache.size > MAX_STRETCHED_CHUNKS) {
      const oldestKey = this.stretchedChunkCache.keys().next().value;
      if (!oldestKey || oldestKey === cacheKey) break;
      this.stretchedChunkCache.delete(oldestKey);
    }
    return { buf: stretched, effectiveRate: Number(rateKey) };
  }

  private activeWebAudioMainTracks: Map<
    string,
    {
      source: AudioBufferSourceNode;
      gainNode: GainNode;
      chunkIdx: number;
      playbackRate: number;
      startedCtxTime: number;
      startedInChunkSec: number;
    }
  > = new Map();

  private stopWebAudioMainTracks(immediate = false): void {
    if (this.activeWebAudioMainTracks.size === 0) return;
    const ctx = this.ctx;
    const entries = Array.from(this.activeWebAudioMainTracks.values());
    this.activeWebAudioMainTracks.clear();
    for (const entry of entries) {
      this.retireSkimTrack(entry, ctx, 0.012, immediate);
    }
  }

  private trySyncWebAudioMainTracks(
    state: PodcastProjectState,
    timeline: TimelineComputation,
    playableTracks: SpeakerTrack[],
    sourceSec: number,
    playheadSec: number,
    playbackRate: number,
    crossedCutOrScrub: boolean,
    anySolo: boolean,
    dominantSpeakerId: string | null,
    playableAutoGainDbs: number[],
    nowPerf: number
  ): boolean {
    const ctx = this.ensureContext();
    if (!ctx) return false;
    if (ctx.state !== 'running') {
      void ctx.resume();
      this.stopWebAudioMainTracks();
      return false;
    }

    const preloadTriggerInChunkSec = Math.max(
      6,
      SKIM_CHUNK_DURATION_SEC - 12 * Math.max(1, playbackRate)
    );

    // Verify all non-muted tracks' current 30s chunk is decoded (pre-fetching any missing chunks)
    let allReady = true;
    for (const tr of playableTracks) {
      if (tr.muted || (anySolo && !tr.solo)) continue;
      const effOffset = state.recordingMode === 'same_room_sync' ? 0 : (tr.syncOffsetMs || 0) / 1000;
      const trAbsSec = Math.max(0, sourceSec - effOffset);
      const chunkIdx = Math.max(0, Math.floor(trAbsSec / SKIM_CHUNK_DURATION_SEC));
      const baseUrl = normalizePlayableAudioUrl(tr.audioUrl, tr.filePath, false);
      const chunkUrl = appendProxyChunkUrl(baseUrl, chunkIdx);
      if (!chunkUrl || !this.decodedAuxBuffers.has(chunkUrl)) {
        this.preloadDecodedUrl(chunkUrl);
        allReady = false;
      } else if (trAbsSec - chunkIdx * SKIM_CHUNK_DURATION_SEC > preloadTriggerInChunkSec) {
        this.preloadDecodedUrl(appendProxyChunkUrl(baseUrl, chunkIdx + 1));
      }
    }
    if (!allReady) return false;

    const now = ctx.currentTime;
    const masterSrcMs = sourceSec * 1000;
    const activeIds = new Set<string>();

    for (const tr of playableTracks) {
      if (tr.muted || (anySolo && !tr.solo)) {
        const old = this.activeWebAudioMainTracks.get(tr.id);
        if (old) {
          this.activeWebAudioMainTracks.delete(tr.id);
          this.retireSkimTrack(old, ctx, 0.01);
        }
        continue;
      }

      const effOffset = state.recordingMode === 'same_room_sync' ? 0 : (tr.syncOffsetMs || 0) / 1000;
      const targetAbsSec = Math.max(0, sourceSec - effOffset);
      const chunkIdx = Math.max(0, Math.floor(targetAbsSec / SKIM_CHUNK_DURATION_SEC));
      const inChunkSec = targetAbsSec - chunkIdx * SKIM_CHUNK_DURATION_SEC;

      const baseUrl = normalizePlayableAudioUrl(tr.audioUrl, tr.filePath, false);
      const chunkUrl = appendProxyChunkUrl(baseUrl, chunkIdx);
      const buf = chunkUrl ? this.decodedAuxBuffers.get(chunkUrl) : undefined;
      if (!buf || inChunkSec < 0 || inChunkSec >= buf.duration - 0.02) {
        const old = this.activeWebAudioMainTracks.get(tr.id);
        if (old) {
          this.activeWebAudioMainTracks.delete(tr.id);
          this.retireSkimTrack(old, ctx, 0.01);
        }
        continue;
      }

      // Compute exact track gain (loudness alignment + mute ranges + Auto-Solo ducking)
      const inExplicitMuteRange = (state.trackMuteRanges ?? []).some(
        (tm) =>
          tm.trackId === tr.id &&
          masterSrcMs >= tm.sourceStartMs &&
          masterSrcMs <= tm.sourceEndMs
      );
      let gain = 1.0;
      if (inExplicitMuteRange) {
        gain = 0.0;
      } else {
        gain *= computePreviewTrackLoudnessScale(
          tr.autoGainDb,
          playableAutoGainDbs,
          state.loudnessAligned
        );
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
          !trackRecentlyOrSoonSpeaking &&
          !activeOvForTrack
        ) {
          if (state.autoSoloMode === 'hard_mute') {
            gain *= 0.06;
          } else {
            const baseDuck = Math.max(
              0.02,
              Math.min(0.5, Math.pow(10, state.duckAttenuationDb / 20))
            );
            const silentTurnDuck =
              state.recordingMode === 'same_room_sync'
                ? Math.min(baseDuck, 0.04)
                : baseDuck;
            gain *= silentTurnDuck;
          }
        }
      }

      const { buf: activeBuf, effectiveRate } = this.getOrCreateStretchedChunk(
        ctx,
        chunkUrl!,
        buf,
        playbackRate
      );
      const stretchedOffsetSec = Math.max(
        0,
        Math.min(activeBuf.duration - 0.01, inChunkSec / effectiveRate)
      );

      const existing = this.activeWebAudioMainTracks.get(tr.id);
      if (existing) {
        const expectedInChunk =
          existing.startedInChunkSec +
          Math.max(0, now - existing.startedCtxTime) * existing.playbackRate;
        const drift = Math.abs(inChunkSec - expectedInChunk);
        const needsResync =
          crossedCutOrScrub ||
          existing.chunkIdx !== chunkIdx ||
          Math.abs(existing.playbackRate - effectiveRate) > 0.015 ||
          drift > 0.15 * effectiveRate ||
          expectedInChunk >= buf.duration - 0.04 * effectiveRate;
        if (!needsResync) {
          existing.gainNode.gain.setTargetAtTime(Math.max(0.0001, gain), now, 0.015);
          activeIds.add(tr.id);
          continue;
        }
        this.activeWebAudioMainTracks.delete(tr.id);
        this.retireSkimTrack(existing, ctx, 0.008);
      }

      const source = ctx.createBufferSource();
      source.buffer = activeBuf;
      source.playbackRate.value = 1.0;

      const gainNode = ctx.createGain();
      gainNode.gain.setValueAtTime(0.0001, now);
      gainNode.gain.linearRampToValueAtTime(Math.max(0.0001, gain), now + 0.006);

      source.connect(gainNode).connect(ctx.destination);
      source.start(now, stretchedOffsetSec);

      const entry = {
        source,
        gainNode,
        chunkIdx,
        playbackRate: effectiveRate,
        startedCtxTime: now,
        startedInChunkSec: inChunkSec,
      };
      this.activeWebAudioMainTracks.set(tr.id, entry);
      activeIds.add(tr.id);

      source.onended = () => {
        if (this.activeWebAudioMainTracks.get(tr.id) === entry) {
          this.activeWebAudioMainTracks.delete(tr.id);
        }
        try {
          source.disconnect();
          gainNode.disconnect();
        } catch {
          // Ignore disconnect errors
        }
      };
    }

    for (const [id, entry] of this.activeWebAudioMainTracks.entries()) {
      if (!activeIds.has(id)) {
        this.activeWebAudioMainTracks.delete(id);
        this.retireSkimTrack(entry, ctx, 0.008);
      }
    }

    return true;
  }

  private syncTimelineAuxBeds(
    state: PodcastProjectState,
    timeline: TimelineComputation,
    playheadSec: number,
    playbackRate: number,
    mapped: ResolvedPlayheadTarget,
    anySolo: boolean,
    crossedCutOrScrub: boolean,
    dominantSpeakerId: string | null,
    coldClipWindows: ReturnType<typeof resolveColdOpenClipWindows>,
    nowPerf: number
  ): void {
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
      const offsetInVo = Math.max(0, playheadSec - voStartSec);
      const handledByWebAudio = this.syncWebAudioAux(
        'intro_vo',
        state.introVoiceover.audioUrl,
        state.introVoiceover.filePath,
        true,
        offsetInVo,
        playbackRate,
        0.90,
        false,
        this.forceSeekPending || !this.wasPlaying
      );
      if (handledByWebAudio) {
        if (this.introVoiceoverTimelineEl && !this.introVoiceoverTimelineEl.audio.paused) {
          this.introVoiceoverTimelineEl.audio.pause();
        }
      } else {
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
          const voNeedInitialSeek =
            this.forceSeekPending || !this.wasPlaying || Math.abs(voEl.currentTime - offsetInVo) > 0.15;
          this.seekHolderOnSpliceOnly(voHolder, offsetInVo, voNeedInitialSeek && crossedCutOrScrub, 0.9, 1200);
          if (voEl.paused && !voEl.ended && !voEl.seeking && nowPerf - voHolder.lastPlayRetryPerfMs > 300) {
            voHolder.lastPlayRetryPerfMs = nowPerf;
            this.safePlayElement(voEl, this.playbackGeneration);
          }
        }
      }
    } else {
      this.stopWebAudioAux('intro_vo');
      if (this.introVoiceoverTimelineEl) {
        this.applySlewedVolume(this.introVoiceoverTimelineEl, 0, true);
        if (!this.introVoiceoverTimelineEl.audio.paused) {
          this.introVoiceoverTimelineEl.audio.pause();
        }
        if (playheadSec < voStartSec) {
          this.seekHolderOnSpliceOnly(this.introVoiceoverTimelineEl, 0, false, 0.25, 450);
        }
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
      fadeFactor: number,
      customDuckMultiplier?: number,
      sourceSlice?: { startSec?: number; endSec?: number }
    ) => {
      const webAudioSlot = slot === 'intro' ? 'intro_bgm' : 'outro_bgm';
      let holder = this.bgmTimelineElements[slot];
      if (!enabled || (!bgmUrl && !bgmPath) || !activeWindow) {
        this.stopWebAudioAux(webAudioSlot);
        if (holder && !holder.audio.paused) {
          holder.audio.pause();
        }
        return;
      }

      const baseBedVol = 0.50; // -6.0 dB 广播垫乐基准，与导出 normalGainDb=-6.0 一致
      let targetVol: number;
      if (typeof customDuckMultiplier === 'number') {
        targetVol = Math.max(0, Math.min(1, baseBedVol * customDuckMultiplier * fadeFactor));
      } else {
        const voiceSpeaking =
          (Boolean(dominantSpeakerId) && !mapped.inIntroOrGapSilence) ||
          inFixedIntroVo;
        const duckedBedVol = baseBedVol * Math.pow(10, (state.bgmDuckDb || -18) / 20);
        targetVol = Math.max(
          0,
          Math.min(1, (voiceSpeaking ? duckedBedVol : baseBedVol) * fadeFactor)
        );
      }

      const sliceStart = Math.max(0, sourceSlice?.startSec ?? 0);
      const sliceEnd =
        typeof sourceSlice?.endSec === 'number' && sourceSlice.endSec > sliceStart + 0.05
          ? sourceSlice.endSec
          : undefined;
      const shouldLoop = slot === 'intro';
      const effectiveOffsetInBgm = sliceStart + offsetSecInBgm;
      if (!shouldLoop && sliceEnd !== undefined && effectiveOffsetInBgm >= sliceEnd - 0.02) {
        this.stopWebAudioAux(webAudioSlot);
        if (holder && !holder.audio.paused) {
          holder.audio.pause();
        }
        return;
      }

      // Primary: glitch-free Web Audio AudioBufferSourceNode + GainNode
      const handledByWebAudio = this.syncWebAudioAux(
        webAudioSlot,
        bgmUrl,
        bgmPath,
        true,
        effectiveOffsetInBgm,
        playbackRate,
        targetVol,
        shouldLoop,
        this.forceSeekPending || !this.wasPlaying,
        sliceStart,
        sliceEnd
      );
      if (handledByWebAudio) {
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
          playbackRate,
          true
        );
        this.bgmTimelineElements[slot] = holder;
      }
      if (!holder || holder.failedFatal) return;
      applyPitchPreservingPlaybackRate(holder.audio, playbackRate);

      this.applySlewedVolume(holder, targetVol, !this.wasPlaying);
      if (holder.audio.duration && Number.isFinite(holder.audio.duration)) {
        const modTime = offsetSecInBgm % Math.max(1, holder.audio.duration);
        const manualSeekOrStart = this.forceSeekPending || !this.wasPlaying;
        this.seekHolderOnSpliceOnly(holder, modTime, manualSeekOrStart, 2.0, 2500);
      }
      if (
        holder.audio.paused &&
        !holder.audio.ended &&
        !holder.audio.seeking &&
        nowPerf - holder.lastPlayRetryPerfMs > 300
      ) {
        holder.lastPlayRetryPerfMs = nowPerf;
        this.safePlayElement(holder.audio, this.playbackGeneration);
      }
    };

    const voiceEndForBgm = Math.max(
      timeline.coldOpenDurationSec,
      state.introVoiceover?.enabled && timeline.introVoiceoverDurationSec > 0
        ? voStartSec + timeline.introVoiceoverDurationSec
        : 0
    );
    const customIntroBgmSec = state.introBgm?.customDurationSec;
    const rawIntroBgmSec =
      timeline.introBgmDurationSec && timeline.introBgmDurationSec > 0
        ? timeline.introBgmDurationSec
        : voiceEndForBgm > 0
        ? voiceEndForBgm
        : Math.min(10, timeline.totalEditedDurationSec * 0.35);
    const introBgmStartSec = Math.max(0, state.introBgm?.startOffsetSec ?? 0);
    const introBgmDurSec =
      customIntroBgmSec && customIntroBgmSec > 0
        ? customIntroBgmSec
        : voiceEndForBgm > 0
        ? Math.min(rawIntroBgmSec, voiceEndForBgm)
        : rawIntroBgmSec;
    const introEndSec = introBgmStartSec + introBgmDurSec;
    const inIntroBed = playheadSec >= introBgmStartSec && playheadSec <= introEndSec;

    // 默认淡入淡出时间 800ms (0.8s)
    const introFadeInSec = (state.introBgm?.fadeInMs ?? 800) / 1000;
    const introFadeOutSec = (state.introBgm?.fadeOutMs ?? 800) / 1000;
    let introFade = 1.0;
    const introElapsed = playheadSec - introBgmStartSec;
    if (introElapsed < introFadeInSec) {
      introFade = Math.min(1.0, Math.max(0, introElapsed / Math.max(0.05, introFadeInSec)));
    } else if (introEndSec - introBgmStartSec > introFadeOutSec && playheadSec > introEndSec - introFadeOutSec) {
      introFade = Math.max(0, (introEndSec - playheadSec) / Math.max(0.05, introFadeOutSec));
    }

    const isIntroBgmMuted = Boolean(state.introBgm?.muted);
    const isIntroBgmSolo = Boolean(state.introBgm?.solo);
    const introBgmActive = Boolean(state.introBgm?.enabled) && !isIntroBgmMuted && (!anySolo || isIntroBgmSolo);

    let introDuckMultiplier = 1.0;
    if (inIntroBed && introBgmActive) {
      // 金句之间恢复 ducking 音量，金句与固定口播之前均按设置的淡入淡出值进行 ducking
      const introVoiceWindows: IntroBgmVoiceWindow[] = [];
      if (state.coldOpenEnabled && coldClipWindows.length > 0) {
        for (const w of coldClipWindows) {
          introVoiceWindows.push({ startSec: w.startSec, endSec: w.endSec });
        }
      }
      if (
        Boolean(state.introVoiceover?.enabled) &&
        Boolean(state.introVoiceover?.audioUrl || state.introVoiceover?.filePath) &&
        timeline.introVoiceoverDurationSec > 0
      ) {
        introVoiceWindows.push({
          startSec: voStartSec,
          endSec: voEndSec,
        });
      }
      if (
        playheadSec >= timeline.coldOpenDurationSec + timeline.introVoiceoverDurationSec &&
        Boolean(dominantSpeakerId) &&
        !mapped.inIntroOrGapSilence
      ) {
        introVoiceWindows.push({
          startSec: playheadSec,
          endSec: playheadSec + 0.1,
        });
      }
      const introDuckRatio = Math.pow(10, (state.bgmDuckDb || -18) / 20);
      introDuckMultiplier = computeIntroBgmDuckMultiplier(
        playheadSec,
        introVoiceWindows,
        introFadeInSec,
        introFadeOutSec,
        introDuckRatio
      );
    }

    syncBgmBed(
      'intro',
      state.introBgm?.audioUrl,
      state.introBgm?.filePath || state.bgmWavPath,
      introBgmActive,
      inIntroBed,
      Math.max(0, playheadSec - introBgmStartSec),
      introFade,
      introDuckMultiplier,
      {
        startSec: state.introBgm?.sourceStartSec,
        endSec: state.introBgm?.sourceEndSec,
      }
    );

    const isOutroBgmMuted = Boolean(state.outroBgm?.muted);
    const isOutroBgmSolo = Boolean(state.outroBgm?.solo);
    const outroBgmActive =
      Boolean(state.outroBgm?.enabled) && !isOutroBgmMuted && (!anySolo || isOutroBgmSolo);

    const customOutroSec = state.outroBgm?.customDurationSec;
    const outroSliceDur =
      state.outroBgm?.enabled && (state.outroBgm?.durationSec || state.outroBgm?.sourceEndSec)
        ? Math.max(
            0.5,
            (state.outroBgm.sourceEndSec ?? state.outroBgm.durationSec ?? 15) -
              (state.outroBgm.sourceStartSec ?? 0)
          ) * 1.2
        : 0;
    const outroWindowSec =
      typeof customOutroSec === 'number' && customOutroSec > 0
        ? customOutroSec
        : outroSliceDur > 0
        ? Number(outroSliceDur.toFixed(1))
        : Math.min(20, Math.max(6, timeline.totalEditedDurationSec * 0.18));
    const outroStartSec =
      typeof state.outroBgm?.startOffsetSec === 'number' && state.outroBgm.startOffsetSec >= 0
        ? Math.min(timeline.totalEditedDurationSec, state.outroBgm.startOffsetSec)
        : Math.max(introEndSec + 0.5, timeline.totalEditedDurationSec - outroWindowSec);
    const outroEndSec = Math.min(timeline.totalEditedDurationSec, outroStartSec + outroWindowSec);
    const inOutroBed =
      timeline.totalEditedDurationSec > 3 &&
      playheadSec >= outroStartSec &&
      playheadSec <= outroEndSec;

    // 片尾 BGM 淡入与淡出平滑包络（自动适应音量）
    const outroFadeInSec = (state.outroBgm?.fadeInMs ?? 1000) / 1000;
    const outroFadeOutSec = (state.outroBgm?.fadeOutMs ?? 2000) / 1000;
    let outroFade = 1.0;
    if (playheadSec - outroStartSec < outroFadeInSec) {
      outroFade = Math.min(1.0, Math.max(0, (playheadSec - outroStartSec) / Math.max(0.05, outroFadeInSec)));
    } else if (outroEndSec - outroStartSec > outroFadeOutSec && playheadSec > outroEndSec - outroFadeOutSec) {
      outroFade = Math.max(0, (outroEndSec - playheadSec) / Math.max(0.05, outroFadeOutSec));
    }

    syncBgmBed(
      'outro',
      state.outroBgm?.audioUrl,
      state.outroBgm?.filePath,
      outroBgmActive,
      inOutroBed,
      Math.max(0, playheadSec - outroStartSec),
      outroFade,
      undefined,
      {
        startSec: state.outroBgm?.sourceStartSec,
        endSec: state.outroBgm?.sourceEndSec,
      }
    );
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

  private activeSkimTracks: Map<
    string,
    {
      source: AudioBufferSourceNode;
      gainNode: GainNode;
      startedCtxTime: number;
      startedSourceSec: number;
      playbackRate: number;
    }
  > = new Map();

  private retireSkimTrack(
    entry: {
      source: AudioBufferSourceNode;
      gainNode: GainNode;
    },
    ctx: AudioContext | null,
    fadeSec = 0.014,
    immediate = false
  ): void {
    if (immediate) {
      try {
        entry.source.stop();
      } catch {
        // Ignore already-stopped source
      }
      try {
        entry.source.disconnect();
        entry.gainNode.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      return;
    }
    try {
      if (ctx) {
        const now = ctx.currentTime;
        entry.gainNode.gain.cancelScheduledValues(now);
        entry.gainNode.gain.setValueAtTime(Math.max(0.0001, entry.gainNode.gain.value), now);
        entry.gainNode.gain.linearRampToValueAtTime(0.0001, now + fadeSec);
        entry.source.stop(now + fadeSec + 0.004);
      } else {
        entry.source.stop();
      }
    } catch {
      try {
        entry.source.stop();
      } catch {
        // Ignore already-stopped source
      }
    }
  }

  /** Resumes Web AudioContext on user gesture (keydown / pointerdown) so skimming never stays muted */
  public resumeContextForUserGesture(): void {
    const ctx = this.ensureContext();
    if (ctx && ctx.state !== 'running') {
      this.unlockContextOnGesture(ctx);
    }
  }

  /** Pre-decodes the first 30s proxy chunk of each track in the background for instant skimming */
  public warmupTrackBuffersForSkim(tracks: SpeakerTrack[], useProxy = true, aroundSec = 0): void {
    const chunkIdx = Math.max(0, Math.floor(Math.max(0, aroundSec) / SKIM_CHUNK_DURATION_SEC));
    for (const tr of tracks) {
      if (tr.isRef) continue;
      const baseUrl = normalizePlayableAudioUrl(tr.audioUrl, tr.filePath, false);
      if (useProxy) {
        const chunkUrl = appendProxyChunkUrl(baseUrl, chunkIdx);
        this.preloadDecodedUrl(chunkUrl);
      } else {
        this.preloadDecodedAuxBuffer(tr.audioUrl, tr.filePath, false);
      }
    }
  }

  /** Smoothly fades out and stops all active Web Audio skim sources */
  public stopSkim(immediate = false): void {
    if (this.activeSkimTracks.size === 0) return;
    const ctx = this.ctx;
    const entries = Array.from(this.activeSkimTracks.values());
    this.activeSkimTracks.clear();
    for (const entry of entries) {
      this.retireSkimTrack(entry, ctx, 0.018, immediate);
    }
  }

  /**
   * Continuous Phase-Steered Web Audio Skimmer (Final Cut Pro style):
   * Maintains one continuous AudioBufferSourceNode per track while skimming forward and steers
   * playbackRate smoothly to stay locked to the mouse cursor with zero grain stutter.
   * Crossfades cleanly only on backward scrub or >55ms jumps.
   */
  public skimAtTimelineSec(
    state: PodcastProjectState,
    timeline: TimelineComputation,
    playheadSec: number,
    playbackRate: number
  ): boolean {
    const ctx = this.ensureContext();
    if (!ctx) return false;
    if (ctx.state !== 'running') {
      void ctx.resume();
      return false;
    }

    const useProxy = state.proxyEditingEnabled !== false;
    const playableTracks = state.tracks.filter((t) => !t.isRef);
    if (playableTracks.length === 0) return false;

    const mapped = resolveEditedPlayheadToSource(state, timeline, playheadSec);
    if (mapped.sourceSec === null || mapped.inIntroOrGapSilence || mapped.isBleeped) {
      this.stopSkim();
      return true;
    }

    let anyDecoded = false;
    for (const tr of playableTracks) {
      const baseUrl = normalizePlayableAudioUrl(tr.audioUrl, tr.filePath, false);
      const trSec = Math.max(0, mapped.sourceSec - (tr.syncOffsetMs || 0) / 1000);
      const chunkIdx = Math.max(0, Math.floor(trSec / SKIM_CHUNK_DURATION_SEC));
      const url = useProxy
        ? appendProxyChunkUrl(baseUrl, chunkIdx)
        : appendProxyParamIfEnabled(baseUrl, false);
      if (url && this.decodedAuxBuffers.has(url)) {
        anyDecoded = true;
        if (useProxy && trSec - chunkIdx * SKIM_CHUNK_DURATION_SEC > 20) {
          this.preloadDecodedUrl(appendProxyChunkUrl(baseUrl, chunkIdx + 1));
        }
      } else {
        this.preloadDecodedUrl(url);
      }
    }
    if (!anyDecoded) return false;

    const now = ctx.currentTime;
    const safeRate = 1.0;
    const anySolo = playableTracks.some((t) => t.solo);
    const playableAutoGainDbs = playableTracks.map((t) => t.autoGainDb || 0);
    const dominantSpeakerId = mapped.activeSpeakerId ?? this.lastHeldSpeakerId;
    const acousticProfiles = this.getAcousticProfiles(state.tracks);
    const activeIds = new Set<string>();

    for (const tr of playableTracks) {
      if (tr.muted || (anySolo && !tr.solo)) {
        const old = this.activeSkimTracks.get(tr.id);
        if (old) {
          this.activeSkimTracks.delete(tr.id);
          this.retireSkimTrack(old, ctx, 0.012);
        }
        continue;
      }

      const baseUrl = normalizePlayableAudioUrl(tr.audioUrl, tr.filePath, false);
      const targetAbsSec = mapped.sourceSec - (tr.syncOffsetMs || 0) / 1000;
      if (targetAbsSec < 0) continue;
      const chunkIdx = useProxy ? Math.max(0, Math.floor(targetAbsSec / SKIM_CHUNK_DURATION_SEC)) : 0;
      const url = useProxy
        ? appendProxyChunkUrl(baseUrl, chunkIdx)
        : appendProxyParamIfEnabled(baseUrl, false);
      if (!url) continue;
      const buf = this.decodedAuxBuffers.get(url);
      if (!buf) continue;

      const targetSec = useProxy ? targetAbsSec - chunkIdx * SKIM_CHUNK_DURATION_SEC : targetAbsSec;
      if (targetSec < 0 || targetSec >= buf.duration - 0.02) {
        const old = this.activeSkimTracks.get(tr.id);
        if (old) {
          this.activeSkimTracks.delete(tr.id);
          this.retireSkimTrack(old, ctx, 0.012);
        }
        continue;
      }

      let gain = computePreviewTrackLoudnessScale(
        tr.autoGainDb,
        playableAutoGainDbs,
        state.loudnessAligned
      );
      const skimVocalActivity = sampleNormalizedVocalActivity(
        tr,
        acousticProfiles.get(tr.id),
        mapped.sourceSec * 1000,
        state.recordingMode,
        55
      );
      if (
        playableTracks.length > 1 &&
        state.autoSoloMode !== 'off' &&
        dominantSpeakerId &&
        dominantSpeakerId !== tr.id &&
        skimVocalActivity < 0.24
      ) {
        if (state.autoSoloMode === 'hard_mute') {
          gain *= 0.06;
        } else {
          const baseDuck = Math.max(
            0.1,
            Math.pow(10, (state.duckAttenuationDb ?? -20) / 20)
          );
          gain *= baseDuck;
        }
      }

      const existing = this.activeSkimTracks.get(tr.id);
      if (existing) {
        const expectedSec =
          existing.startedSourceSec + (now - existing.startedCtxTime) * existing.playbackRate;
        const drift = targetSec - expectedSec;
        if (drift >= -0.025 && drift <= 0.055 && expectedSec < buf.duration - 0.05) {
          existing.startedSourceSec = expectedSec;
          existing.startedCtxTime = now;
          existing.playbackRate = safeRate;
          existing.source.playbackRate.setTargetAtTime(safeRate, now, 0.015);
          existing.gainNode.gain.setTargetAtTime(Math.max(0.0001, gain), now, 0.015);
          activeIds.add(tr.id);
          continue;
        }
        this.activeSkimTracks.delete(tr.id);
        this.retireSkimTrack(existing, ctx, 0.012);
      }

      if (gain <= 0.002) continue;

      const source = ctx.createBufferSource();
      source.buffer = buf;
      source.playbackRate.value = safeRate;

      const gainNode = ctx.createGain();
      gainNode.gain.setValueAtTime(0.0001, now);
      gainNode.gain.linearRampToValueAtTime(gain, now + 0.01);

      source.connect(gainNode).connect(ctx.destination);
      source.start(now, targetSec);

      const entry = {
        source,
        gainNode,
        startedCtxTime: now,
        startedSourceSec: targetSec,
        playbackRate: safeRate,
      };
      this.activeSkimTracks.set(tr.id, entry);
      activeIds.add(tr.id);

      source.onended = () => {
        if (this.activeSkimTracks.get(tr.id) === entry) {
          this.activeSkimTracks.delete(tr.id);
        }
        try {
          source.disconnect();
          gainNode.disconnect();
        } catch {
          // Ignore disconnect errors
        }
      };
    }

    for (const [id, entry] of this.activeSkimTracks.entries()) {
      if (!activeIds.has(id)) {
        this.activeSkimTracks.delete(id);
        this.retireSkimTrack(entry, ctx, 0.012);
      }
    }

    return true;
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
