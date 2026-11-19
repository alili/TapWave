import { invoke } from '@tauri-apps/api/core';
import { buildEdlKeepSegments, resolveEffectiveHighlightGapSec } from './timelineEngine';
import {
  AsrConfig,
  DetectedSpeechSegmentDto,
  GlossaryItem,
  PodcastProjectState,
  SpeakerTrack,
} from '../types/podcast';
import {
  buildPodAudioUrl,
  getNativeAudioServerPort,
  parsePodcraftProjectJson,
  serializeProjectToPodcraftJson,
  setNativeAudioServerPort,
} from '../data/emptyProject';
import { SidecarTrackTranscribeDto } from './transcriptBuilder';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function ensureNativeAudioServerPort(): Promise<number> {
  if (!isTauriRuntime()) return 0;
  const cached = getNativeAudioServerPort();
  if (cached > 0) return cached;
  try {
    const port = await invoke<number>('get_audio_server_port');
    if (port > 0) {
      setNativeAudioServerPort(port);
      return port;
    }
  } catch {
    // Fallback to Vite /api/audio-stream in dev or default port 19847
  }
  return 0;
}

if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
  void ensureNativeAudioServerPort();
}

export interface NativeInspectedTrackDto {
  id: string;
  name: string;
  role: string;
  color: string;
  normalizedWavPath: string;
  durationMs: number;
  syncOffsetMs: number;
  driftRatio: number;
  measuredLufs: number;
  autoGainDb: number;
  roomToneRangeMs: { startMs: number; endMs: number };
  peaks: number[];
  detectedSegments?: DetectedSpeechSegmentDto[];
  isRef: boolean;
}

export async function inspectAndAlignNativeTracks(
  recordingMode: PodcastProjectState['recordingMode'],
  tracks: Array<{
    id: string;
    name: string;
    role: string;
    color: string;
    filePath: string;
    isRef: boolean;
  }>
): Promise<SpeakerTrack[] | null> {
  if (!isTauriRuntime()) return null;
  await ensureNativeAudioServerPort();
  const inspected = await invoke<NativeInspectedTrackDto[]>('inspect_and_align_tracks', {
    req: {
      recordingMode,
      workDir: '/tmp/podcraft_active_session',
      tracks,
    },
  });

  const sourceById = new Map(tracks.map((t) => [t.id, t.filePath]));

  return inspected.map((item) => {
    const origPath = sourceById.get(item.id);
    const origName = origPath ? origPath.split(/[/\\]/).pop() : undefined;
    return {
      id: item.id,
      name: item.name,
      role: (item.role as SpeakerTrack['role']) || 'guest',
      roleLabel:
        item.role === 'host'
          ? '主持人 Host'
          : item.role === 'co_host'
          ? '常驻主播 Co-Host'
          : item.isRef
          ? '合并参考轨 (基准时钟)'
          : '飞行嘉宾 Guest',
      color: item.color,
      sourceFileName: origName,
      sourceFilePath: origPath,
      filePath: item.normalizedWavPath,
      audioUrl: buildPodAudioUrl(item.normalizedWavPath),
      durationMs: item.durationMs,
      rawLufs: item.measuredLufs,
      autoGainDb: item.autoGainDb,
      syncOffsetMs: item.syncOffsetMs,
      roomToneStartMs: item.roomToneRangeMs.startMs,
      roomToneEndMs: item.roomToneRangeMs.endMs,
      peaks: item.peaks,
      detectedSegments: item.detectedSegments ?? [],
      solo: false,
      muted: item.isRef,
      isRef: item.isRef,
    };
  });
}

export async function uploadBrowserAudioFilesForAsr(
  files: File[],
  onProgress?: (pct: number, msg: string) => void
): Promise<string[] | null> {
  if (isTauriRuntime() || files.length === 0) return null;
  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress?.(
      50 + Math.round(((i + 0.5) / files.length) * 8),
      `正在准备神经网络语音识别音频缓存 (${i + 1}/${files.length}): ${f.name} ...`
    );
    const resp = await fetch(`/api/upload-track?name=${encodeURIComponent(f.name)}`, {
      method: 'POST',
      body: f,
    });
    if (!resp.ok) {
      throw new Error(`上传本地识别缓存失败 (${resp.status})`);
    }
    const data = (await resp.json()) as { ok?: boolean; filePath?: string; error?: string };
    if (!data.ok || !data.filePath) {
      throw new Error(data.error || '未能生成临时识别音频路径');
    }
    paths.push(data.filePath);
  }
  return paths;
}

export interface SidecarSeparatedTrackDto {
  id: string;
  speakerKey?: string;
  name: string;
  role: SpeakerTrack['role'];
  roleLabel: string;
  color: string;
  filePath: string;
  durationMs: number;
  rawLufs: number;
  autoGainDb: number;
  syncOffsetMs: number;
  roomToneStartMs: number;
  roomToneEndMs: number;
  peaks: number[];
  detectedSegments?: DetectedSpeechSegmentDto[];
  isRef?: boolean;
}

export interface SidecarCapabilitiesDto {
  ok?: boolean;
  asrReady?: boolean;
  volcEnvConfigured?: boolean;
  volcAccountInfo?: {
    username?: string;
    accountId?: string;
  };
  engines?: Record<string, boolean>;
}

export async function checkSidecarCapabilities(): Promise<SidecarCapabilitiesDto | null> {
  const payloadJson = JSON.stringify({ command: 'check_capabilities' });
  try {
    if (isTauriRuntime()) {
      const raw = await invoke<string>('run_ai_sidecar', { payloadJson });
      return JSON.parse(raw) as SidecarCapabilitiesDto;
    }
    const resp = await fetch('/api/sidecar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payloadJson,
    });
    if (!resp.ok) return null;
    return (await resp.json()) as SidecarCapabilitiesDto;
  } catch {
    return null;
  }
}

export function hydrateSeparatedTracks(
  separated: SidecarSeparatedTrackDto[],
  origTrack?: SpeakerTrack
): SpeakerTrack[] {
  const tauri = isTauriRuntime();
  return separated.map((item, idx) => ({
    id: item.id || `sp_${idx + 1}`,
    name: item.name || (idx === 0 ? `主持人 (角色1)` : `嘉宾 ${idx} (角色${idx + 1})`),
    role: item.role || (idx === 0 ? 'host' : 'guest'),
    roleLabel:
      item.roleLabel ||
      (item.role === 'host'
        ? '主持人 Host'
        : item.role === 'co_host'
        ? '常驻主播 Co-Host'
        : '飞行嘉宾 Guest'),
    color: item.color || '#3b82f6',
    sourceFileName: origTrack?.sourceFileName,
    sourceFilePath: origTrack?.sourceFilePath,
    filePath: item.filePath,
    audioUrl: buildPodAudioUrl(item.filePath, tauri),
    durationMs: item.durationMs || origTrack?.durationMs,
    rawLufs: typeof item.rawLufs === 'number' ? item.rawLufs : origTrack?.rawLufs ?? -18,
    autoGainDb: typeof item.autoGainDb === 'number' ? item.autoGainDb : 0,
    syncOffsetMs: typeof item.syncOffsetMs === 'number' ? item.syncOffsetMs : 0,
    roomToneStartMs: typeof item.roomToneStartMs === 'number' ? item.roomToneStartMs : 0,
    roomToneEndMs: typeof item.roomToneEndMs === 'number' ? item.roomToneEndMs : 500,
    peaks: Array.isArray(item.peaks) ? item.peaks : origTrack?.peaks ?? [],
    detectedSegments: item.detectedSegments ?? [],
    solo: false,
    muted: false,
    isRef: false,
  }));
}

export interface SidecarTranscribeResponseDto {
  ok?: boolean;
  error?: string;
  engine?: string;
  tracks: Record<string, SidecarTrackTranscribeDto>;
  separatedTracks?: SidecarSeparatedTrackDto[];
  speakerCount?: number;
  asrModelReady?: boolean;
  fallbackUsed?: boolean;
  fallbackReason?: string;
}

let activeSidecarAbortController: AbortController | null = null;

export async function cancelPythonSidecarTranscribe(): Promise<boolean> {
  if (activeSidecarAbortController) {
    try {
      activeSidecarAbortController.abort();
    } catch {
      // ignore
    }
    activeSidecarAbortController = null;
  }
  if (isTauriRuntime()) {
    try {
      await invoke('cancel_ai_sidecar');
      return true;
    } catch (e) {
      console.warn('cancel_ai_sidecar error:', e);
    }
  }
  return true;
}

export async function runPythonSidecarTranscribe(
  tracks: SpeakerTrack[],
  glossary: GlossaryItem[],
  recordingMode: PodcastProjectState['recordingMode'] = 'same_room_sync',
  onProgress?: (pct: number, msg: string) => void,
  asrConfig?: AsrConfig
): Promise<SidecarTranscribeResponseDto | null> {
  const tracksWithPaths = tracks.filter((t) => Boolean(t.filePath));
  if (tracksWithPaths.length === 0) return null;

  activeSidecarAbortController = new AbortController();
  const currentSignal = activeSidecarAbortController.signal;

  const payload = {
    command: 'transcribe_stems',
    recordingMode,
    glossary,
    asrConfig: asrConfig
      ? {
          provider: asrConfig.provider,
          apiKey: asrConfig.apiKey,
          baseUrl: asrConfig.baseUrl,
          model: asrConfig.model ?? '',
          fallbackToLocal: asrConfig.fallbackToLocal,
          volcUsername: asrConfig.volcUsername ?? '',
          volcAccountId: asrConfig.volcAccountId ?? '',
          volcAccessKeyId: asrConfig.volcAccessKeyId ?? '',
          volcSecretAccessKey: asrConfig.volcSecretAccessKey ?? '',
          volcApiKey: asrConfig.volcApiKey ?? '',
          volcAppId: asrConfig.volcAppId ?? '',
          volcAccessToken: asrConfig.volcAccessToken ?? '',
          volcResourceId: asrConfig.volcResourceId ?? '',
          volcSsdVersion: asrConfig.volcSsdVersion ?? '200',
          enableSingleFileSpeakerSep: asrConfig.enableSingleFileSpeakerSep ?? true,
        }
      : undefined,
    tracks: tracksWithPaths.map((t) => ({
      id: t.id,
      name: t.name,
      role: t.role,
      filePath: t.filePath ?? '',
      syncOffsetMs: t.syncOffsetMs || 0,
      isRef: Boolean(t.isRef),
    })),
  };
  const payloadJson = JSON.stringify(payload);

  let rawJson = '';
  try {
    if (isTauriRuntime()) {
      rawJson = await invoke<string>('run_ai_sidecar', { payloadJson });
    } else {
      const resp = await fetch('/api/sidecar?stream=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payloadJson,
        signal: currentSignal,
      });

    if (resp.body && typeof resp.body.getReader === 'function') {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let pending = '';
      let lastJsonLine = '';

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed.startsWith('PROGRESS:')) {
          try {
            const pObj = JSON.parse(trimmed.slice('PROGRESS:'.length)) as {
              pct?: number;
              msg?: string;
            };
            if (typeof pObj.pct === 'number' && pObj.msg) {
              onProgress?.(pObj.pct, pObj.msg);
            }
          } catch {
            // Ignore malformed progress line
          }
        } else {
          lastJsonLine = trimmed;
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const parts = pending.split(/\r?\n/);
        pending = parts.pop() ?? '';
        for (const ln of parts) {
          handleLine(ln);
        }
      }
      pending += decoder.decode();
      for (const ln of pending.split(/\r?\n/)) {
        handleLine(ln);
      }
      rawJson = lastJsonLine;
    } else {
      rawJson = await resp.text();
    }

    if (!resp.ok && !rawJson.trim().startsWith('{')) {
      throw new Error(`语音识别服务调用失败 (${resp.status})`);
    }
  }

  const parsed = JSON.parse(rawJson) as SidecarTranscribeResponseDto;
  if (parsed.ok === false) {
    throw new Error(parsed.error || '语音识别服务执行失败');
  }
  return parsed;
  } finally {
    if (activeSidecarAbortController?.signal === currentSignal) {
      activeSidecarAbortController = null;
    }
  }
}

export async function runPythonSidecarAnalysis(
  state: PodcastProjectState
): Promise<Record<string, unknown> | null> {
  const payload = {
    command: 'analyze_transcript',
    tracks: state.tracks,
    glossary: state.glossary,
    highlightConstraints: {
      minClipSec: state.minClipSec,
      maxClipSec: state.maxClipSec,
      targetTotalSec: state.targetTotalHighlightSec,
    },
    llmConfig: state.llmConfig,
    asrConfig: {
      provider: state.asrConfig?.provider,
      apiKey: state.asrConfig?.apiKey,
    },
    blocks: state.blocks.map((b) => ({
      blockId: b.blockId,
      speakerId: b.speakerId,
      tokens: b.tokens.map((t) => ({
        id: t.id,
        type: t.type,
        text: t.text,
        startMs: t.sourceStartMs,
        endMs: t.sourceEndMs,
        deleted: Boolean(t.deleted),
        bleeped: Boolean(t.bleeped),
      })),
    })),
  };
  const payloadJson = JSON.stringify(payload);

  if (isTauriRuntime()) {
    const rawJson = await invoke<string>('run_ai_sidecar', { payloadJson });
    return JSON.parse(rawJson) as Record<string, unknown>;
  }

  const resp = await fetch('/api/sidecar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payloadJson,
  });
  if (!resp.ok) return null;
  return (await resp.json()) as Record<string, unknown>;
}

export interface SidecarShownotesPayload {
  episodeTitle?: string;
  summary?: string;
  timeline?: Array<{ timeSec?: number; title?: string; summary?: string }>;
  activitySuggestion?: { title?: string; description?: string; posterSlogan?: string };
  benefitsSuggestion?: Array<{ title?: string; description?: string }>;
}

export interface ContentSegmentInput {
  startSec: number;
  timeLabel: string;
  chapterTitles: string[];
  excerpt: string;
}

export async function runPythonSidecarShownotes(
  state: PodcastProjectState,
  chapters: Array<{ timeSec: number; timeLabel: string; title: string }>,
  contentSegments?: ContentSegmentInput[]
): Promise<{ engine: string; shownotes: SidecarShownotesPayload | null } | null> {
  const payload = {
    command: 'generate_shownotes',
    projectTitle: state.projectTitle,
    tracks: state.tracks.map((t) => ({ id: t.id, name: t.name, role: t.role })),
    chapters,
    contentSegments: contentSegments ?? [],
    llmConfig: state.llmConfig,
    asrConfig: {
      provider: state.asrConfig?.provider,
      apiKey: state.asrConfig?.apiKey,
    },
    blocks: state.blocks.map((b) => ({
      blockId: b.blockId,
      speakerId: b.speakerId,
      tokens: b.tokens.map((t) => ({
        id: t.id,
        type: t.type,
        text: t.text,
        deleted: Boolean(t.deleted),
        bleeped: Boolean(t.bleeped),
      })),
    })),
  };
  const payloadJson = JSON.stringify(payload);

  if (isTauriRuntime()) {
    const rawJson = await invoke<string>('run_ai_sidecar', { payloadJson });
    return JSON.parse(rawJson) as { engine: string; shownotes: SidecarShownotesPayload | null };
  }

  const resp = await fetch('/api/sidecar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payloadJson,
  });
  if (!resp.ok) return null;
  return (await resp.json()) as { engine: string; shownotes: SidecarShownotesPayload | null };
}

function triggerBrowserBlobDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Saves current project as a .podcraft file (supports Save in-place & Save As in Tauri,
 * or .podcraft file download in Browser). Returns saved path/filename, or null if user cancelled.
 */
export async function savePodcraftProject(
  state: PodcastProjectState,
  forceSaveAs = false
): Promise<{ savedPath: string; savedAt: string } | null> {
  const safeBase = (state.projectTitle || '未命名播客工程').replace(/[/\\?%*:|"<>]/g, '_');

  if (isTauriRuntime()) {
    let targetPath = !forceSaveAs ? state.projectFilePath : undefined;
    if (!targetPath) {
      const { save: saveDialog } = await import('@tauri-apps/plugin-dialog');
      const chosen = await saveDialog({
        defaultPath: `${safeBase}.podcraft`,
        filters: [{ name: 'PodCraft 播客工程文件', extensions: ['podcraft'] }],
      });
      if (!chosen) return null;
      targetPath = chosen.endsWith('.podcraft') ? chosen : `${chosen}.podcraft`;
    }

    const contentJson = serializeProjectToPodcraftJson(state, targetPath);
    const savedPath = await invoke<string>('save_project_file', {
      filePath: targetPath,
      contentJson,
    });
    return { savedPath, savedAt: new Date().toISOString() };
  }

  // Browser environment: download .podcraft JSON directly
  const filename = `${safeBase}.podcraft`;
  const contentJson = serializeProjectToPodcraftJson(state, filename);
  triggerBrowserBlobDownload(
    filename,
    new Blob([contentJson], { type: 'application/json;charset=utf-8' })
  );
  return { savedPath: filename, savedAt: new Date().toISOString() };
}

/**
 * Opens a .podcraft project file via native macOS dialog (Tauri) with real-time progress events.
 */
export async function openPodcraftProjectNative(): Promise<PodcastProjectState | null> {
  if (!isTauriRuntime()) return null;
  await ensureNativeAudioServerPort();
  const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: 'PodCraft 播客工程文件', extensions: ['podcraft', 'json'] }],
  });
  if (!selected || Array.isArray(selected)) return null;

  const rawJson = await invoke<string>('load_project_file', {
    filePath: selected,
  });
  return parsePodcraftProjectJson(rawJson, selected, true);
}

/**
 * Loads a .podcraft project directly from an absolute file path (e.g. system open-file event or double click).
 */
export async function loadPodcraftProjectFromPath(filePath: string): Promise<PodcastProjectState> {
  await ensureNativeAudioServerPort();
  const rawJson = await invoke<string>('load_project_file', {
    filePath,
  });
  return parsePodcraftProjectJson(rawJson, filePath, true);
}

/**
 * Retrieves pending file to open from application cold start if launched via double-clicking a .podcraft file.
 */
export async function getPendingOpenFileNative(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  return invoke<string | null>('get_pending_open_file');
}

/**
 * Registers macOS LaunchServices file association for .podcraft files.
 */
export async function registerFileAssociationNative(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>('register_file_association');
}

/**
 * Decodes subtitle bytes supporting UTF-8 (with/without BOM), UTF-16LE/BE, and GB18030/GBK.
 */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

/**
 * Opens a third-party subtitle / proofread transcript file (.srt/.vtt/.ass/.ssa/.lrc/.txt/.md/.json) via native macOS dialog.
 */
export async function openSubtitleFileNative(): Promise<{
  fileName: string;
  content: string;
} | null> {
  if (!isTauriRuntime()) return null;
  await ensureNativeAudioServerPort();
  const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
  const selected = await openDialog({
    multiple: false,
    title: '选择第三方字幕或校对文稿文件',
    filters: [
      {
        name: '字幕与文稿文件 (.srt / .vtt / .ass / .lrc / .txt / .md / .json)',
        extensions: ['srt', 'vtt', 'ass', 'ssa', 'lrc', 'txt', 'md', 'json', 'bcc'],
      },
    ],
  });
  if (!selected || Array.isArray(selected)) return null;
  const fileName = selected.split(/[/\\]/).pop() || selected;
  const rawBytes = await invoke<number[]>('read_subtitle_bytes', {
    filePath: selected,
  });
  const content = decodeSubtitleBytes(new Uint8Array(rawBytes));
  return { fileName, content };
}

/**
 * Reads a browser File object for third-party subtitle alignment with automatic UTF-8/UTF-16/GB18030 decoding.
 */
export async function readSubtitleBrowserFile(
  file: File
): Promise<{ fileName: string; content: string }> {
  const buf = await file.arrayBuffer();
  const content = decodeSubtitleBytes(new Uint8Array(buf));
  return { fileName: file.name, content };
}

/**
 * Reads a .podcraft File in Browser mode with smooth percentage progress updates.
 */
export function readPodcraftProjectBrowserFile(
  file: File,
  onProgress: (pct: number, msg: string) => void
): Promise<PodcastProjectState> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        const pct = Math.min(82, Math.max(10, Math.round((ev.loaded / ev.total) * 80)));
        onProgress(pct, `正在加载工程文件 (${Math.round((ev.loaded / ev.total) * 100)}%): ${file.name}`);
      }
    };
    reader.onerror = () => reject(new Error(`读取文件失败: ${file.name}`));
    reader.onload = () => {
      try {
        onProgress(90, '正在解析音轨峰值、文稿切片与剪辑状态...');
        const raw = String(reader.result ?? '');
        const parsed = parsePodcraftProjectJson(raw, file.name, isTauriRuntime());
        onProgress(100, '工程加载完成');
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    };
    onProgress(8, `正在读取工程文件: ${file.name} ...`);
    reader.readAsText(file, 'utf-8');
  });
}

export async function exportMasteredPodcastAudio(
  state: PodcastProjectState,
  format: 'wav' | 'mp3' = 'mp3'
): Promise<string> {
  if (state.tracks.length === 0 || state.blocks.length === 0) {
    throw new Error('当前工程暂无已导入的音频轨道或文稿，请先导入音频！');
  }

  const keepSegments = buildEdlKeepSegments(state);
  const safeBase = (state.projectTitle || 'PodCraft_Master').replace(/[/\\?%*:|"<>]/g, '_');

  if (isTauriRuntime()) {
    const tracksWithPaths = state.tracks.filter((t) => Boolean(t.filePath));
    if (tracksWithPaths.length === 0) {
      throw new Error('当前工程音轨未关联本地音频文件路径，请重新导入本地音频轨道');
    }

    const { save: saveDialog } = await import('@tauri-apps/plugin-dialog');
    const chosenOut = await saveDialog({
      defaultPath: `${safeBase}.${format}`,
      filters: [
        {
          name: format === 'mp3' ? 'MP3 音频 (.mp3)' : 'WAV 音频 (.wav)',
          extensions: [format],
        },
      ],
    });
    if (!chosenOut) {
      throw new Error('已取消导出');
    }

    const expectedExt = `.${format}`;
    const finalOutPath = chosenOut.toLowerCase().endsWith(expectedExt)
      ? chosenOut
      : `${chosenOut}${expectedExt}`;

    const activeIntervals: Array<{
      trackId: string;
      startMs: number;
      endMs: number;
      isLaughterOrOverlap: boolean;
    }> = [];
    const primaryIntervals: Array<{ trackId: string; startMs: number; endMs: number }> = [];
    const trackMutes: Array<{ trackId: string; startMs: number; endMs: number }> = [];
    const redactions: Array<{ startMs: number; endMs: number; style: string }> = [];

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
        primaryIntervals.push({
          trackId: b.speakerId,
          startMs: b.overlapNote.sourceStartMs,
          endMs: b.overlapNote.sourceEndMs,
        });
        if (b.overlapNote.keepFullVolume) {
          primaryIntervals.push({
            trackId: b.overlapNote.speakerId,
            startMs: b.overlapNote.sourceStartMs,
            endMs: b.overlapNote.sourceEndMs,
          });
        }
      }
      for (const tok of b.tokens) {
        if (!tok.deleted && tok.type !== 'silence' && !tok.trackMuted) {
          primaryIntervals.push({
            trackId: b.speakerId,
            startMs: tok.sourceStartMs,
            endMs: tok.sourceEndMs,
          });
        }
        if (tok.type !== 'silence') {
          activeIntervals.push({
            trackId: b.speakerId,
            startMs: tok.sourceStartMs,
            endMs: tok.sourceEndMs,
            isLaughterOrOverlap: tok.type === 'laughter',
          });
        }
        if (tok.trackMuted && !tok.mouthClickCleaned) {
          trackMutes.push({
            trackId: b.speakerId,
            startMs: tok.sourceStartMs,
            endMs: tok.sourceEndMs,
          });
        }
        if (tok.bleeped) {
          redactions.push({
            startMs: tok.sourceStartMs,
            endMs: tok.sourceEndMs,
            style: tok.bleepStyle || 'sine_1khz_bleep',
          });
        }
      }
    }

    const res = await invoke<{ outputPath: string; durationMs: number }>('render_podcast_export', {
      req: {
        outputPath: finalOutPath,
        targetLufs: -16.0,
        autoSoloMode: state.autoSoloMode,
        duckAttenuationDb: state.duckAttenuationDb,
        loudnessAlignEnabled: state.loudnessAligned,
        deClickEnabled: Boolean(state.deClickEnabled),
        deClickStrength: state.deClickStrength || 'medium',
        tracks: tracksWithPaths.map((t) => ({
          id: t.id,
          name: t.name,
          role: t.role,
          color: t.color,
          normalizedWavPath: t.filePath || '',
          durationMs: t.durationMs || 60000,
          syncOffsetMs: t.syncOffsetMs,
          driftRatio: 1.0,
          measuredLufs: t.rawLufs,
          autoGainDb: t.autoGainDb,
          roomToneRangeMs: { startMs: t.roomToneStartMs, endMs: t.roomToneEndMs },
          peaks: t.peaks,
          detectedSegments: t.detectedSegments ?? [],
          isRef: Boolean(t.isRef),
        })),
        activeIntervals,
        primaryIntervals,
        trackMutes,
        redactions,
        keepSegments,
        coldOpen: {
          enabled: state.coldOpenEnabled,
          clips: state.highlights.map((h) => ({
            sourceStartMs: h.sourceStartMs,
            sourceEndMs: h.sourceEndMs,
            mutedTrackIds: h.mutedTrackIds ?? [],
          })),
          bgmWavPath:
            (state.introBgm?.enabled ? state.introBgm.filePath : undefined) ||
            null,
          introLeadInMs: 2000,
          outroTailMs: 2000,
          normalGainDb: -6.0,
          duckedGainDb: state.bgmDuckDb,
          gapMs: Math.round(resolveEffectiveHighlightGapSec(state) * 1000),
          introVoWavPath: state.introVoiceover?.enabled ? state.introVoiceover.filePath : null,
          introVoStartOffsetMs: typeof state.introVoiceover?.startOffsetSec === 'number'
            ? Math.round(state.introVoiceover.startOffsetSec * 1000)
            : null,
          introBgmDurationMs: state.introBgm?.enabled
            ? Math.round(
                (typeof state.introBgm.customDurationSec === 'number' && state.introBgm.customDurationSec > 0
                  ? state.introBgm.customDurationSec
                  : typeof state.introBgm.durationSec === 'number' && state.introBgm.durationSec > 0
                  ? state.introBgm.durationSec
                  : 10) * 1000
              )
            : null,
          introBgmFadeInMs: state.introBgm?.fadeInMs ?? 800,
          introBgmFadeOutMs: state.introBgm?.fadeOutMs ?? 800,
        },
      },
    });
    return res.outputPath;
  }

  const candidateTracks = state.tracks.some((t) => !t.isRef)
    ? state.tracks.filter((t) => !t.isRef)
    : state.tracks;
  const hasSolo = candidateTracks.some((t) => t.solo);
  const exportTracks = candidateTracks.filter((t) => {
    if (!t.filePath) return false;
    if (hasSolo) return Boolean(t.solo);
    return !t.muted;
  });

  if (exportTracks.length > 0) {
    const muteRanges: Array<{ startMs: number; endMs: number }> = [];
    for (const b of state.blocks) {
      for (const tok of b.tokens) {
        if (!tok.deleted && tok.trackMuted && tok.mouthClickCleaned) {
          muteRanges.push({ startMs: tok.sourceStartMs, endMs: tok.sourceEndMs });
        }
      }
    }

    const resp = await fetch('/api/export-mp3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tracks: exportTracks.map((t) => ({
          filePath: t.filePath,
          syncOffsetMs: t.syncOffsetMs || 0,
          autoGainDb: t.autoGainDb || 0,
        })),
        keepSegments,
        muteRanges,
        loudnessAligned: state.loudnessAligned,
        deClickEnabled: Boolean(state.deClickEnabled),
        deClickStrength: state.deClickStrength || 'medium',
        introVoiceoverPath: state.introVoiceover?.enabled
          ? state.introVoiceover.filePath
          : undefined,
      }),
    });

    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const errData = (await resp.json()) as { error?: string };
        if (errData?.error) detail = errData.error;
      } catch {
        // ignore JSON parse failure
      }
      throw new Error(detail);
    }

    const mp3Blob = await resp.blob();
    const outFileName = `${safeBase}.mp3`;
    triggerBrowserBlobDownload(outFileName, mp3Blob);
    return outFileName;
  }

  throw new Error('当前音轨未关联本地缓存文件，请重新导入音频或在桌面端导出 MP3 成片');
}

export async function exportReaperDawSession(state: PodcastProjectState): Promise<string> {
  if (state.tracks.length === 0) {
    throw new Error('当前工程暂无音轨，无法导出 Reaper 工程');
  }
  const keepSegments = buildEdlKeepSegments(state);
  const safeBase = (state.projectTitle || 'PodCraft_Session').replace(/[/\\?%*:|"<>]/g, '_');

  if (isTauriRuntime()) {
    const { save: saveDialog } = await import('@tauri-apps/plugin-dialog');
    const chosenOut = await saveDialog({
      defaultPath: `${safeBase}.rpp`,
      filters: [{ name: 'Reaper Project', extensions: ['rpp'] }],
    });
    if (!chosenOut) {
      throw new Error('已取消导出');
    }

    return await invoke<string>('export_daw_project', {
      req: {
        outputRppPath: chosenOut,
        projectTitle: state.projectTitle,
        tracks: state.tracks.map((t) => ({
          id: t.id,
          name: t.name,
          role: t.role,
          color: t.color,
          normalizedWavPath: t.filePath || `${t.name}.wav`,
          durationMs: t.durationMs || 60000,
          syncOffsetMs: t.syncOffsetMs,
          driftRatio: 1.0,
          measuredLufs: t.rawLufs,
          autoGainDb: t.autoGainDb,
          roomToneRangeMs: { startMs: t.roomToneStartMs, endMs: t.roomToneEndMs },
          peaks: t.peaks,
          detectedSegments: t.detectedSegments ?? [],
          isRef: Boolean(t.isRef),
        })),
        keepSegments,
      },
    });
  }

  let rpp = `<REAPER_PROJECT 0.1 "7.0"\n  SAMPLERATE 48000 0 0\n`;
  for (const tr of state.tracks.filter((t) => !t.isRef)) {
    rpp += `  <TRACK\n    NAME "${tr.name} (${tr.roleLabel})"\n`;
    let pos = 0;
    for (const seg of keepSegments) {
      const len = (seg.sourceEndMs - seg.sourceStartMs) / 1000;
      rpp += `    <ITEM\n      POSITION ${pos.toFixed(3)}\n      LENGTH ${len.toFixed(3)}\n      SOFFS ${(seg.sourceStartMs / 1000).toFixed(3)}\n    >\n`;
      pos += len + seg.pauseAfterMs / 1000;
    }
    rpp += `  >\n`;
  }
  rpp += `>\n`;
  const fname = `${safeBase}.rpp`;
  triggerBrowserBlobDownload(fname, new Blob([rpp], { type: 'text/plain;charset=utf-8' }));
  return fname;
}

export interface DependenciesStatusDto {
  hasPython: boolean;
  pythonBin: string;
  hasSidecar: boolean;
  sidecarPath?: string;
  modelsDir: string;
  hasSenseVoice: boolean;
  hasSileroVad: boolean;
  hasParaformer: boolean;
  modelsReady: boolean;
  missingModels: string[];
  recommendedMode: 'local_sensevoice' | 'volcengine_doubao' | 'deepseek';
}

export interface ModelDownloadProgressDto {
  percent: number;
  stage: string;
  message: string;
  isDone: boolean;
  error?: string;
}

export async function getDependenciesStatus(): Promise<DependenciesStatusDto | null> {
  if (!isTauriRuntime()) {
    return {
      hasPython: true,
      pythonBin: 'python3',
      hasSidecar: true,
      modelsDir: 'models',
      hasSenseVoice: true,
      hasSileroVad: true,
      hasParaformer: true,
      modelsReady: true,
      missingModels: [],
      recommendedMode: 'local_sensevoice',
    };
  }
  try {
    return await invoke<DependenciesStatusDto>('get_dependencies_status');
  } catch (e) {
    console.warn('获取依赖项状态失败:', e);
    return null;
  }
}

export async function startDownloadLocalModels(): Promise<string> {
  if (!isTauriRuntime()) {
    return 'Web 演示环境无需下载离线模型';
  }
  return await invoke<string>('start_download_local_models');
}

export async function setCustomModelsDir(path: string): Promise<DependenciesStatusDto | null> {
  if (!isTauriRuntime()) return null;
  return await invoke<DependenciesStatusDto>('set_custom_models_dir', { path });
}

export async function listenModelDownloadProgress(
  cb: (payload: ModelDownloadProgressDto) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => {};
  }
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<ModelDownloadProgressDto>('model-download-progress', (event) => {
      cb(event.payload);
    });
    return unlisten;
  } catch {
    return () => {};
  }
}
