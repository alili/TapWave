import {
  BgmTrackAsset,
  PodCraftProjectFileEnvelope,
  PodcastProjectState,
  SpeakerRole,
  SpeakerTrack,
} from '../types/podcast';
import { refineProjectBlocksWithWaveform } from '../engine/waveformAligner';
import { repairMisalignedHighlights } from '../engine/timelineEngine';

let nativeAudioServerPort = 0;

export function setNativeAudioServerPort(port: number): void {
  if (Number.isFinite(port) && port > 0) {
    nativeAudioServerPort = Math.floor(port);
  }
}

export function getNativeAudioServerPort(): number {
  return nativeAudioServerPort;
}

export function extractFilePathFromPodAudioUrl(rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  if (rawUrl.startsWith('podaudio://')) {
    const stripped = rawUrl.replace(/^podaudio:\/\/localhost\/?/, '');
    try {
      const decoded = decodeURIComponent(stripped);
      if (!decoded) return undefined;
      return decoded.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(decoded) ? decoded : `/${decoded}`;
    } catch {
      return undefined;
    }
  }
  if (rawUrl.includes('/api/audio-stream?') || rawUrl.includes('/audio?')) {
    try {
      const u = new URL(rawUrl, 'http://localhost');
      const p = u.searchParams.get('path');
      if (p) return p;
    } catch {
      // Ignore malformed URL
    }
  }
  return undefined;
}

/**
 * Builds a standard HTTP/1.1 byte-range audio streaming URL compatible with macOS WKWebView
 * AVFoundation `<audio>`, packaged Tauri apps (`127.0.0.1:<port>/audio`), and Vite dev server.
 * Avoids custom `podaudio://` URI schemes because WebKit's out-of-process media decoder rejects
 * custom `WKURLSchemeHandler` protocols on `<audio>` elements.
 */
export function buildPodAudioUrl(
  filePath?: string,
  isTauri = true,
  forceTranscodeWav = false
): string | undefined {
  if (!filePath) return undefined;
  const qs = `path=${encodeURIComponent(filePath)}${forceTranscodeWav ? '&transcode=wav' : ''}`;

  if (nativeAudioServerPort > 0) {
    return `http://127.0.0.1:${nativeAudioServerPort}/audio?${qs}`;
  }

  if (
    typeof window !== 'undefined' &&
    (window.location?.protocol === 'http:' || window.location?.protocol === 'https:') &&
    (window.location?.hostname === 'localhost' || window.location?.hostname === '127.0.0.1')
  ) {
    return `/api/audio-stream?${qs}`;
  }

  if (isTauri) {
    return `http://127.0.0.1:19847/audio?${qs}`;
  }

  return `/api/audio-stream?${qs}`;
}

export function buildAudioMixEndpoints(): { configUrl: string; streamBaseUrl: string } {
  if (nativeAudioServerPort > 0) {
    return {
      configUrl: `http://127.0.0.1:${nativeAudioServerPort}/audio-mix-config`,
      streamBaseUrl: `http://127.0.0.1:${nativeAudioServerPort}/audio-mix`,
    };
  }

  if (
    typeof window !== 'undefined' &&
    (window.location?.protocol === 'http:' || window.location?.protocol === 'https:') &&
    (window.location?.hostname === 'localhost' || window.location?.hostname === '127.0.0.1')
  ) {
    return {
      configUrl: '/api/audio-mix-config',
      streamBaseUrl: '/api/audio-mix',
    };
  }

  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (isTauri) {
    return {
      configUrl: 'http://127.0.0.1:19847/audio-mix-config',
      streamBaseUrl: 'http://127.0.0.1:19847/audio-mix',
    };
  }

  return {
    configUrl: '/api/audio-mix-config',
    streamBaseUrl: '/api/audio-mix',
  };
}

export function normalizePlayableAudioUrl(
  rawUrl?: string,
  filePath?: string,
  forceTranscodeWav = false
): string | undefined {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  if (forceTranscodeWav) {
    const resolved = filePath || extractFilePathFromPodAudioUrl(rawUrl);
    if (resolved) {
      return buildPodAudioUrl(resolved, isTauri, true);
    }
  }

  if (rawUrl && (rawUrl.startsWith('blob:') || rawUrl.startsWith('data:'))) {
    return rawUrl;
  }

  const resolvedPath = filePath || extractFilePathFromPodAudioUrl(rawUrl);
  if (resolvedPath) {
    return buildPodAudioUrl(resolvedPath, isTauri, false);
  }

  return rawUrl;
}

export const SPEAKER_ROLE_LABELS: Record<SpeakerRole, string> = {
  host: '主持人 Host',
  co_host: '常驻主播 Co-Host',
  guest: '飞行嘉宾 Guest',
  ref: '合并参考轨 (基准时钟)',
  bgm: 'BGM 垫乐轨',
};

/**
 * Updates a speaker track's display name (guest/host name) and/or role, propagating the new
 * speaker name across highlights, overlap notes, and auto-generated chapter titles.
 */
export function applySpeakerTrackProfileUpdate(
  prev: PodcastProjectState,
  trackId: string,
  nextName?: string,
  nextRole?: SpeakerRole
): PodcastProjectState {
  const target = prev.tracks.find((t) => t.id === trackId);
  if (!target) return prev;

  const oldName = target.name;
  const trimmedName = nextName !== undefined ? nextName.trim() : target.name;
  const finalName = trimmedName.length > 0 ? trimmedName : target.name;
  const finalRole = nextRole ?? target.role;
  const nameChanged = finalName !== oldName;
  const roleChanged = finalRole !== target.role;

  if (!nameChanged && !roleChanged) {
    return prev;
  }

  const nextTracks: SpeakerTrack[] = prev.tracks.map((tr) => {
    if (tr.id !== trackId) return tr;
    const becameRef = finalRole === 'ref';
    const leftRef = tr.role === 'ref' && finalRole !== 'ref';
    return {
      ...tr,
      name: finalName,
      role: finalRole,
      roleLabel: SPEAKER_ROLE_LABELS[finalRole],
      isRef: becameRef,
      muted: becameRef ? true : leftRef ? false : tr.muted,
    };
  });

  const nextHighlights = nameChanged
    ? prev.highlights.map((hl) =>
        hl.speakerId === trackId ? { ...hl, speakerName: finalName } : hl
      )
    : prev.highlights;

  const nextBlocks = nameChanged
    ? prev.blocks.map((b) => {
        const updatedChapter =
          b.speakerId === trackId && oldName && b.chapterTitle.includes(oldName)
            ? b.chapterTitle.split(oldName).join(finalName)
            : b.chapterTitle;
        const updatedOverlap =
          b.overlapNote &&
          (b.overlapNote.speakerId === trackId || b.overlapNote.speakerName === oldName)
            ? { ...b.overlapNote, speakerName: finalName }
            : b.overlapNote;
        if (updatedChapter === b.chapterTitle && updatedOverlap === b.overlapNote) {
          return b;
        }
        return {
          ...b,
          chapterTitle: updatedChapter,
          overlapNote: updatedOverlap,
        };
      })
    : prev.blocks;

  const nextShownotes = prev.shownotes
    ? {
        ...prev.shownotes,
        guests: prev.shownotes.guests.map((g) =>
          g.trackId === trackId
            ? {
                ...g,
                name: finalName,
                roleLabel:
                  finalRole === 'host'
                    ? '主持人'
                    : finalRole === 'co_host'
                    ? '常驻主播'
                    : '飞行嘉宾',
              }
            : g
        ),
      }
    : undefined;

  return {
    ...prev,
    tracks: nextTracks,
    highlights: nextHighlights,
    blocks: nextBlocks,
    shownotes: nextShownotes,
  };
}

/**
 * Clean empty workspace state — zero hardcoded demo audio, zero fake speakers, zero preset text.
 */
export function createEmptyProjectState(): PodcastProjectState {
  return {
    projectTitle: '未命名播客工程',
    projectFilePath: undefined,
    lastSavedAt: undefined,
    savedPlayheadSec: 0,
    playbackRate: 1.0,
    hideDeletedTokens: true,
    recordingMode: 'same_room_sync',
    autoSoloMode: 'natural_ducking',
    duckAttenuationDb: -16,
    loudnessAligned: true,
    deClickEnabled: true,
    deClickStrength: 'medium',
    stripSilenceEnabled: false,
    stripSilenceThresholdSec: 1.2,
    stripSilenceTargetSec: 0.45,
    groupingMode: 'text_editor',
    speakerFilter: 'all',
    interactionMode: 'audio_cut',
    workspaceLayout: 'multitrack',
    waveformSelectionMode: 'free',
    cutPrerollEnabled: true,
    cutPrerollSec: 1.0,
    pauseCutJumpEnabled: true,
    coldOpenEnabled: false,
    minClipSec: 8,
    maxClipSec: 20,
    targetTotalHighlightSec: 90,
    highlightGapSec: 0.8,
    autoHighlightGap: true,
    bgmStyle: 'lofi',
    bgmDuckDb: -21,
    introVoiceover: null,
    introBgm: null,
    outroBgm: null,
    tracks: [],
    blocks: [],
    highlights: [],
    trackMuteRanges: [],
    glossary: [],
    emotionCurve: [],
    wechatConfig: {
      aspectRatio: '9:16',
      layout: 'group_left',
      darkSkin: true,
      groupTitle: '播客精选群聊',
      showTypingIndicator: true,
      laughterStickers: true,
    },
    llmConfig: {
      provider: 'deepseek',
      apiKey: '',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    },
    asrConfig: {
      provider: 'local_sensevoice',
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      model: '',
      fallbackToLocal: true,
      volcSsdVersion: '200',
      enableSingleFileSpeakerSep: true,
    },
  };
}

/**
 * Serializes a PodcastProjectState into a portable .podcraft JSON document.
 * Strips transient blob: URLs and in-memory API keys for safety while preserving
 * all file paths, waveform peaks, alignments, transcript edits, cuts, mutes, bleeps,
 * Cold Open highlights, glossary, and WeChat video config.
 */
export function serializeProjectToPodcraftJson(
  state: PodcastProjectState,
  filePath?: string
): string {
  const savedAt = new Date().toISOString();
  const sanitizedTracks: SpeakerTrack[] = state.tracks.map((tr) => ({
    ...tr,
    // Keep podaudio:// re-derivable from filePath; do not persist ephemeral browser blob: URLs
    audioUrl: tr.audioUrl?.startsWith('blob:') ? undefined : tr.audioUrl,
  }));

  const sanitizeBgm = (bgm?: BgmTrackAsset | null): BgmTrackAsset | null => {
    if (!bgm) return null;
    return {
      ...bgm,
      audioUrl: bgm.audioUrl?.startsWith('blob:') ? undefined : bgm.audioUrl,
    };
  };

  const envelope: PodCraftProjectFileEnvelope = {
    format: 'podcraft-project',
    version: '2.2',
    savedAt,
    project: {
      ...state,
      projectFilePath: filePath ?? state.projectFilePath,
      lastSavedAt: savedAt,
      savedPlayheadSec:
        typeof state.savedPlayheadSec === 'number' &&
        Number.isFinite(state.savedPlayheadSec) &&
        state.savedPlayheadSec >= 0
          ? Number(state.savedPlayheadSec.toFixed(3))
          : 0,
      tracks: sanitizedTracks,
      introVoiceover: sanitizeBgm(state.introVoiceover),
      introBgm: sanitizeBgm(state.introBgm),
      outroBgm: sanitizeBgm(state.outroBgm),
      llmConfig: {
        ...state.llmConfig,
        apiKey: '', // Never write secret API keys in plain text to project files
      },
      asrConfig: {
        ...(state.asrConfig ?? {
          provider: 'local_sensevoice',
          apiKey: '',
          baseUrl: 'https://api.deepseek.com',
          model: '',
          fallbackToLocal: true,
          volcSsdVersion: '200',
          enableSingleFileSpeakerSep: true,
        }),
        apiKey: '', // Never write secret API keys in plain text to project files
        volcSecretAccessKey: '',
        volcApiKey: '',
        volcAccessToken: '',
      },
    },
  };

  return JSON.stringify(envelope, null, 2);
}

/**
 * Parses and validates a .podcraft (or raw PodcastProjectState JSON) file,
 * rehydrating Tauri podaudio:// streaming URLs for local audio stems.
 */
export function parsePodcraftProjectJson(
  rawJson: string,
  loadedFilePath?: string,
  isTauri = false
): PodcastProjectState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`工程文件 JSON 格式损坏，无法解析: ${String(err)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('无效的播客工程文件内容');
  }

  const obj = parsed as Partial<PodCraftProjectFileEnvelope> & Partial<PodcastProjectState>;
  const rawProject: Partial<PodcastProjectState> =
    obj.format === 'podcraft-project' && obj.project ? obj.project : (obj as Partial<PodcastProjectState>);

  if (!Array.isArray(rawProject.tracks) || !Array.isArray(rawProject.blocks)) {
    throw new Error('该文件缺少多轨音轨 (tracks) 或文稿切片 (blocks) 字段，不是有效的 .podcraft 工程文件');
  }

  const base = createEmptyProjectState();
  const rehydratedTracks: SpeakerTrack[] = rawProject.tracks.map((tr) => {
    const recoveredPath =
      tr.filePath || extractFilePathFromPodAudioUrl(tr.audioUrl) || tr.sourceFilePath;
    return {
      ...tr,
      filePath: recoveredPath ?? tr.filePath,
      audioUrl: recoveredPath
        ? buildPodAudioUrl(recoveredPath, isTauri)
        : tr.audioUrl && !tr.audioUrl.startsWith('blob:')
        ? tr.audioUrl
        : undefined,
    };
  });

  const rehydrateBgm = (bgm?: BgmTrackAsset | null): BgmTrackAsset | null => {
    if (!bgm) return null;
    const recoveredPath = bgm.filePath || extractFilePathFromPodAudioUrl(bgm.audioUrl);
    return {
      ...bgm,
      filePath: recoveredPath ?? bgm.filePath,
      audioUrl: recoveredPath
        ? buildPodAudioUrl(recoveredPath, isTauri)
        : bgm.audioUrl && !bgm.audioUrl.startsWith('blob:')
        ? bgm.audioUrl
        : undefined,
    };
  };

  const effectiveRecordingMode = rawProject.recordingMode ?? base.recordingMode;
  const refinedBlocks = refineProjectBlocksWithWaveform(
    rawProject.blocks,
    rehydratedTracks,
    effectiveRecordingMode
  );

  return {
    ...base,
    ...rawProject,
    savedPlayheadSec:
      typeof rawProject.savedPlayheadSec === 'number' &&
      Number.isFinite(rawProject.savedPlayheadSec) &&
      rawProject.savedPlayheadSec >= 0
        ? Number(rawProject.savedPlayheadSec.toFixed(3))
        : 0,
    workspaceLayout:
      rawProject.workspaceLayout === 'transcript'
        ? 'transcript'
        : rawProject.workspaceLayout === 'intro'
        ? 'intro'
        : rawProject.workspaceLayout === 'outro'
        ? 'outro'
        : 'multitrack',
    waveformSelectionMode:
      rawProject.waveformSelectionMode === 'free' ? 'free' : 'snap',
    cutPrerollEnabled:
      typeof rawProject.cutPrerollEnabled === 'boolean'
        ? rawProject.cutPrerollEnabled
        : base.cutPrerollEnabled ?? true,
    cutPrerollSec:
      typeof rawProject.cutPrerollSec === 'number' &&
      Number.isFinite(rawProject.cutPrerollSec) &&
      rawProject.cutPrerollSec >= 0
        ? rawProject.cutPrerollSec
        : base.cutPrerollSec ?? 3.0,
    pauseCutJumpEnabled:
      typeof rawProject.pauseCutJumpEnabled === 'boolean'
        ? rawProject.pauseCutJumpEnabled
        : base.pauseCutJumpEnabled ?? true,
    projectFilePath: loadedFilePath ?? rawProject.projectFilePath,
    tracks: rehydratedTracks,
    introVoiceover: rehydrateBgm(rawProject.introVoiceover),
    introBgm: rehydrateBgm(rawProject.introBgm),
    outroBgm: rehydrateBgm(rawProject.outroBgm),
    blocks: refinedBlocks,
    highlights: Array.isArray(rawProject.highlights)
      ? repairMisalignedHighlights(rawProject.highlights, refinedBlocks)
      : [],
    trackMuteRanges: Array.isArray(rawProject.trackMuteRanges) ? rawProject.trackMuteRanges : [],
    glossary: Array.isArray(rawProject.glossary) ? rawProject.glossary : [],
    emotionCurve: Array.isArray(rawProject.emotionCurve) ? rawProject.emotionCurve : [],
    wechatConfig: {
      ...base.wechatConfig,
      ...(rawProject.wechatConfig ?? {}),
    },
    llmConfig: {
      ...base.llmConfig,
      ...(rawProject.llmConfig ?? {}),
    },
    asrConfig: {
      ...base.asrConfig,
      ...(rawProject.asrConfig ?? {}),
      provider:
        rawProject.asrConfig?.provider === 'deepseek'
          ? 'deepseek'
          : rawProject.asrConfig?.provider === 'volcengine_doubao'
          ? 'volcengine_doubao'
          : 'local_sensevoice',
    },
  };
}
