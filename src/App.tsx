import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Clock,
  FileJson,
  FolderPlus,
  History,
  Mic,
  PanelLeftOpen,
  PanelRightOpen,
  Radio,
  Save,
  Scissors,
  Sparkles,
} from 'lucide-react';
import {
  clearRecentProjects,
  formatRecentTime,
  loadRecentProjects,
  recordRecentProject,
  removeRecentProject,
  RecentProjectItem,
} from './engine/recentProjects';
import {
  applyPreferenceSmartCut,
  isProtectedAffirmation,
  PreferenceSmartCutOutcome,
  SmartCutActionItem,
} from './engine/preferenceCutEngine';
import { SmartCutConfirmModal } from './components/SmartCutConfirmModal';
import { HighlightEditModal } from './components/HighlightEditModal';
import {
  DEFAULT_PERSONAL_EDITING_PROFILE,
  applyPersonalProfileDefaults,
} from './data/editingPreferenceProfile';
import {
  applySpeakerTrackProfileUpdate,
  buildPodAudioUrl,
  createEmptyProjectState,
  SPEAKER_ROLE_LABELS,
} from './data/emptyProject';
import {
  applyTrackMuteSelectionToProject,
  applyWaveformSelectionToBlocks,
  computeEditedTimeline,
  formatMmSs,
  remapPlayheadAfterTimelineEdit,
  TimelineComputation,
} from './engine/timelineEngine';
import {
  buildTranscriptBlocksFromImportedTracks,
  inspectBrowserAudioFilesWithProgress,
} from './engine/transcriptBuilder';
import { scanAndCleanMouthClicks } from './engine/mouthClickCleaner';
import {
  buildAcousticProfileMap,
  hasAudibleVoiceInInterval,
  refineProjectBlocksWithWaveform,
} from './engine/waveformAligner';
import { audioPreview, resolveEditedPlayheadToSource } from './engine/audioPreviewEngine';

const LazyShownotesModal = React.lazy(() =>
  import('./components/ShownotesModal').then((m) => ({ default: m.ShownotesModal }))
);
import {
  ensureNativeAudioServerPort,
  exportMasteredPodcastAudio,
  hydrateSeparatedTracks,
  inspectAndAlignNativeTracks,
  isTauriRuntime,
  openPodcraftProjectNative,
  loadPodcraftProjectFromPath,
  getPendingOpenFileNative,
  registerFileAssociationNative,
  readPodcraftProjectBrowserFile,
  readSubtitleBrowserFile,
  runPythonSidecarAnalysis,
  runPythonSidecarTranscribe,
  cancelPythonSidecarTranscribe,
  savePodcraftProject,
  uploadBrowserAudioFilesForAsr,
  getDependenciesStatus,
} from './engine/tauriBridge';
import { DependencyGuideModal } from './components/DependencyGuideModal';
import { RetranscribeConfirmModal } from './components/RetranscribeConfirmModal';
import {
  AsrConfig,
  AuxAudioSlot,
  BgmTrackAsset,
  HighlightClip,
  LoadingProgressState,
  PodcastProjectState,
  SpeakerRole,
  SpeakerTrack,
  TranscriptBlock,
  TranscriptToken,
  WaveformSelectionMode,
} from './types/podcast';
import { PLAYBACK_RATES, TopStudioBar } from './components/TopStudioBar';
import { LeftTrackAndChapterPane } from './components/LeftTrackAndChapterPane';
import { TranscriptWorkspace } from './components/TranscriptWorkspace';
import { RightAiWorkbench } from './components/RightAiWorkbench';
import { WaveformEditorBar } from './components/WaveformEditorBar';
import { LoadingProgressModal } from './components/LoadingProgressModal';
import { ShortcutsModal } from './components/ShortcutsModal';
import { GlobalAuxLibraryModal } from './components/GlobalAuxLibraryModal';
import {
  addGlobalAuxItem,
  getDefaultGlobalAuxAssets,
  GlobalAuxPresetItem,
  loadGlobalAuxLibrary,
  removeGlobalAuxItem,
  setDefaultGlobalAuxItem,
  toBgmTrackAsset,
} from './engine/globalAuxLibrary';

const LazyImportTracksModal = React.lazy(() =>
  import('./components/ImportTracksModal').then((m) => ({ default: m.ImportTracksModal }))
);
const LazySubtitleCorrectionModal = React.lazy(() =>
  import('./components/SubtitleCorrectionModal').then((m) => ({
    default: m.SubtitleCorrectionModal,
  }))
);

const DEFAULT_LEFT_PANE_WIDTH = 300;
const MIN_LEFT_PANE_WIDTH = 220;
const MAX_LEFT_PANE_WIDTH = 520;
const DEFAULT_RIGHT_PANE_WIDTH = 360;
const MIN_RIGHT_PANE_WIDTH = 260;
const MAX_RIGHT_PANE_WIDTH = 580;
const MIN_CENTER_STAGE_WIDTH = 360;

function readStoredPaneNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return Math.round(Math.max(min, Math.min(max, parsed)));
      }
    }
  } catch {
    // ignore storage errors
  }
  return fallback;
}

function readStoredPaneBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // ignore storage errors
  }
  return fallback;
}

function useLatestCallback<T extends (...args: never[]) => unknown>(fn: T): T {
  const ref = useRef<T>(fn);
  ref.current = fn;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(((...args: Parameters<T>) => ref.current(...args)) as T, []);
}

function createProjectWithGlobalDefaults(): PodcastProjectState {
  const base = createEmptyProjectState();
  const defaults = getDefaultGlobalAuxAssets();
  return {
    ...base,
    introVoiceover: defaults.introVoiceover,
    introBgm: defaults.introBgm,
    bgmWavPath: defaults.introBgm?.filePath,
    outroBgm: defaults.outroBgm,
  };
}

export const App: React.FC = () => {
  const [state, setState] = useState<PodcastProjectState>(() =>
    createProjectWithGlobalDefaults()
  );
  const [globalAuxItems, setGlobalAuxItems] = useState<GlobalAuxPresetItem[]>(() =>
    loadGlobalAuxLibrary()
  );
  const [auxLibraryModal, setAuxLibraryModal] = useState<{
    open: boolean;
    slot: AuxAudioSlot;
  }>({ open: false, slot: 'intro_vo' });
  const bgmImportToLibraryRef = useRef<boolean>(false);
  const [isDirty, setIsDirty] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProjectItem[]>(() =>
    loadRecentProjects()
  );
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(() =>
    readStoredPaneBool('podcraft.autoSaveEnabled', true)
  );
  const [autoSaveIntervalSec, setAutoSaveIntervalSec] = useState(() =>
    readStoredPaneNumber('podcraft.autoSaveIntervalSec', 60, 15, 600)
  );
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState<number | null>(null);
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  const isSavingRef = useRef(false);
  const newEmptyProjectRef = useRef<() => void>(() => {});
  const [shownotesModal, setShownotesModal] = useState<{
    open: boolean;
    initialTab?: 'summary' | 'guests' | 'timeline' | 'activity' | 'benefits';
  }>({ open: false, initialTab: 'summary' });
  const handleOpenShownotes = useCallback(
    (tab?: 'summary' | 'guests' | 'timeline' | 'activity' | 'benefits') => {
      setShownotesModal({ open: true, initialTab: tab || 'summary' });
    },
    []
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastClickedIdx, setLastClickedIdx] = useState<number | null>(null);
  const [activeRightTab, setActiveRightTab] = useState<'coach' | 'glossary'>('coach');
  const [leftPaneCollapsed, setLeftPaneCollapsed] = useState(() =>
    readStoredPaneBool('podcraft.leftPaneCollapsed', false)
  );
  const [rightPaneCollapsed, setRightPaneCollapsed] = useState(() =>
    readStoredPaneBool('podcraft.rightPaneCollapsed', false)
  );
  const [leftPaneWidth, setLeftPaneWidth] = useState(() =>
    readStoredPaneNumber(
      'podcraft.leftPaneWidth',
      DEFAULT_LEFT_PANE_WIDTH,
      MIN_LEFT_PANE_WIDTH,
      MAX_LEFT_PANE_WIDTH
    )
  );
  const [rightPaneWidth, setRightPaneWidth] = useState(() =>
    readStoredPaneNumber(
      'podcraft.rightPaneWidth',
      DEFAULT_RIGHT_PANE_WIDTH,
      MIN_RIGHT_PANE_WIDTH,
      MAX_RIGHT_PANE_WIDTH
    )
  );
  const [resizingSide, setResizingSide] = useState<'left' | 'right' | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [activeTokenId, setActiveTokenId] = useState<string | null>(null);
  const [waveformFocusRequest, setWaveformFocusRequest] = useState<{
    startSec: number;
    endSec: number;
    speakerId?: string;
    anchorSec?: number;
    preserveHigherZoom?: boolean;
    seq: number;
  } | null>(null);
  const [undoDepth, setUndoDepth] = useState(0);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [retranscribeModalOpen, setRetranscribeModalOpen] = useState(false);
  const isRetranscribeAbortedRef = useRef(false);
  const [depGuideModalOpen, setDepGuideModalOpen] = useState(false);
  const [globalEditingHighlight, setGlobalEditingHighlight] = useState<HighlightClip | null>(null);
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);
  const [subtitleModalOpen, setSubtitleModalOpen] = useState(false);
  const [droppedSubtitle, setDroppedSubtitle] = useState<{
    fileName: string;
    content: string;
  } | null>(null);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgressState>({
    active: false,
    title: '',
    stage: '',
    percent: 0,
    message: '',
  });
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const toastTimerRef = useRef<number | null>(null);
  const browserProjectInputRef = useRef<HTMLInputElement | null>(null);
  const browserAudioInputRef = useRef<HTMLInputElement | null>(null);
  const browserBgmInputRef = useRef<HTMLInputElement | null>(null);
  const bgmImportSlotRef = useRef<AuxAudioSlot>('intro');
  const undoStackRef = useRef<PodcastProjectState[]>([]);
  const playheadRef = useRef<number>(0);
  const workspaceRowRef = useRef<HTMLDivElement | null>(null);
  const paneLayoutRef = useRef({
    leftPaneCollapsed,
    rightPaneCollapsed,
    leftPaneWidth,
    rightPaneWidth,
    hasContent: state.tracks.length > 0,
  });
  paneLayoutRef.current = {
    leftPaneCollapsed,
    rightPaneCollapsed,
    leftPaneWidth,
    rightPaneWidth,
    hasContent: state.tracks.length > 0,
  };

  useEffect(() => {
    try {
      window.localStorage.setItem('podcraft.leftPaneCollapsed', String(leftPaneCollapsed));
      window.localStorage.setItem('podcraft.rightPaneCollapsed', String(rightPaneCollapsed));
      window.localStorage.setItem('podcraft.leftPaneWidth', String(leftPaneWidth));
      window.localStorage.setItem('podcraft.rightPaneWidth', String(rightPaneWidth));
      window.localStorage.setItem('podcraft.autoSaveEnabled', String(autoSaveEnabled));
      window.localStorage.setItem('podcraft.autoSaveIntervalSec', String(autoSaveIntervalSec));
    } catch {
      // ignore storage errors
    }
  }, [leftPaneCollapsed, rightPaneCollapsed, leftPaneWidth, rightPaneWidth, autoSaveEnabled, autoSaveIntervalSec]);

  // 定时自动保存引擎：当检测到工程有修改且满足时间间隔时，静默原地保存磁盘（已有路径）或缓存到本地存储快照
  useEffect(() => {
    if (!autoSaveEnabled || autoSaveIntervalSec <= 0) return;

    const intervalId = window.setInterval(async () => {
      if (!isDirtyRef.current || isSavingRef.current) return;
      const curState = stateRef.current;
      if (!curState || curState.tracks.length === 0) return;

      isSavingRef.current = true;
      try {
        const currentPlayhead = Number((playheadRef.current ?? 0).toFixed(3));
        const stateToSave: PodcastProjectState = {
          ...curState,
          savedPlayheadSec: Math.max(0, currentPlayhead),
        };

        if (curState.projectFilePath) {
          const res = await savePodcraftProject(stateToSave, false);
          if (res) {
            setState((prev) => ({
              ...prev,
              savedPlayheadSec: stateToSave.savedPlayheadSec,
              lastSavedAt: res.savedAt,
            }));
            setIsDirty(false);
            setLastAutoSavedAt(Date.now());
          }
        } else {
          try {
            window.localStorage.setItem(
              'podcraft.autoSaveDraft',
              JSON.stringify({
                savedAt: new Date().toISOString(),
                state: stateToSave,
              })
            );
            setLastAutoSavedAt(Date.now());
          } catch (storageErr) {
            console.warn('Auto save draft storage warning:', storageErr);
          }
        }
      } catch (err) {
        console.warn('Auto save failed:', err);
      } finally {
        isSavingRef.current = false;
      }
    }, Math.max(10, autoSaveIntervalSec) * 1000);

    return () => window.clearInterval(intervalId);
  }, [autoSaveEnabled, autoSaveIntervalSec]);

  useEffect(() => {
    try {
      const seen = window.localStorage.getItem('tapwave_dep_guide_seen');
      if (seen === 'true') return;
    } catch {
      // ignore
    }
    const timer = setTimeout(() => {
      void getDependenciesStatus().then((status) => {
        if (status && !status.modelsReady) {
          setDepGuideModalOpen(true);
        }
      });
    }, 1000);
    return () => clearTimeout(timer);
  }, []);

  const handleStartResizeSidePane = useCallback(
    (side: 'left' | 'right', e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const snap = paneLayoutRef.current;
      const wasCollapsed = side === 'left' ? snap.leftPaneCollapsed : snap.rightPaneCollapsed;
      const startWidth =
        side === 'left'
          ? wasCollapsed
            ? MIN_LEFT_PANE_WIDTH
            : snap.leftPaneWidth
          : wasCollapsed
          ? MIN_RIGHT_PANE_WIDTH
          : snap.rightPaneWidth;

      setResizingSide(side);
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      let rafId: number | null = null;
      let lastClientX = startX;

      const applyResizeAt = (clientX: number) => {
        const cur = paneLayoutRef.current;
        const rowRect = workspaceRowRef.current?.getBoundingClientRect();
        const rowWidth = rowRect?.width ?? window.innerWidth;

        if (side === 'left') {
          const rawWidth = wasCollapsed
            ? clientX - (rowRect?.left ?? 0)
            : startWidth + (clientX - startX);
          if (rawWidth < 135) {
            setLeftPaneCollapsed(true);
            return;
          }
          const rightOccupied = cur.hasContent
            ? cur.rightPaneCollapsed
              ? 28
              : cur.rightPaneWidth
            : 0;
          const allowedMax = Math.min(
            MAX_LEFT_PANE_WIDTH,
            Math.max(MIN_LEFT_PANE_WIDTH, rowWidth - rightOccupied - MIN_CENTER_STAGE_WIDTH)
          );
          const nextW = Math.round(Math.max(MIN_LEFT_PANE_WIDTH, Math.min(allowedMax, rawWidth)));
          setLeftPaneCollapsed(false);
          setLeftPaneWidth(nextW);
        } else {
          const rowRight = rowRect?.right ?? window.innerWidth;
          const rawWidth = wasCollapsed
            ? rowRight - clientX
            : startWidth + (startX - clientX);
          if (rawWidth < 150) {
            setRightPaneCollapsed(true);
            return;
          }
          const leftOccupied = cur.leftPaneCollapsed ? 28 : cur.leftPaneWidth;
          const allowedMax = Math.min(
            MAX_RIGHT_PANE_WIDTH,
            Math.max(MIN_RIGHT_PANE_WIDTH, rowWidth - leftOccupied - MIN_CENTER_STAGE_WIDTH)
          );
          const nextW = Math.round(Math.max(MIN_RIGHT_PANE_WIDTH, Math.min(allowedMax, rawWidth)));
          setRightPaneCollapsed(false);
          setRightPaneWidth(nextW);
        }
      };

      const onPointerMove = (ev: PointerEvent) => {
        lastClientX = ev.clientX;
        if (rafId !== null) return;
        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          applyResizeAt(lastClientX);
        });
      };

      const cleanup = () => {
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }
        setResizingSide(null);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', cleanup);
      window.addEventListener('pointercancel', cleanup);
    },
    []
  );

  const notify = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => setToastMsg(null), 3200);
  }, []);

  /** Wrapper around setState that marks project modified, optionally recording a 25-step undo snapshot */
  const mutateProject = useCallback(
    (updater: (prev: PodcastProjectState) => PodcastProjectState, recordUndo = false) => {
      setState((prev) => {
        if (recordUndo) {
          undoStackRef.current = [...undoStackRef.current.slice(-24), prev];
          setUndoDepth(undoStackRef.current.length);
        }
        return updater(prev);
      });
      setIsDirty(true);
    },
    []
  );

  const clearUndoHistory = useCallback(() => {
    undoStackRef.current = [];
    setUndoDepth(0);
  }, []);

  const handleUndoLastEdit = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const prevSnapshot = stack[stack.length - 1];
    undoStackRef.current = stack.slice(0, -1);
    setUndoDepth(undoStackRef.current.length);
    const prevTl = timelineRef.current;
    const nextTl = computeEditedTimeline(prevSnapshot);
    const nextSec = remapPlayheadAfterTimelineEdit(prevTl, nextTl, playheadRef.current);
    playheadRef.current = nextSec;
    setPlayheadSec(nextSec);
    audioPreview.requestSeek();
    setState((curr) => ({
      ...prevSnapshot,
      playbackRate: curr.playbackRate,
    }));
    setIsDirty(true);
    notify('↩ 已撤销上一步编辑，原文字与对应音频切片已恢复');
  }, [notify]);

  const timeline = useMemo(
    () => computeEditedTimeline(state),
    [
      state.coldOpenEnabled,
      state.highlights,
      state.introVoiceover,
      state.blocks,
      state.tracks,
      state.recordingMode,
    ]
  );

  const stateRef = useRef(state);
  stateRef.current = state;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const seekToSec = useCallback((sec: number) => {
    const maxDur = Math.max(0, timelineRef.current.totalEditedDurationSec);
    const clamped = Math.max(0, Math.min(maxDur, Number(sec.toFixed(3))));
    playheadRef.current = clamped;
    audioPreview.requestSeek();
    if (isPlayingRef.current) {
      audioPreview.syncMultiTrackPlayback(
        stateRef.current,
        timelineRef.current,
        clamped,
        true
      );
    }
    const resolved = resolveEditedPlayheadToSource(
      stateRef.current,
      timelineRef.current,
      clamped
    );
    const uiBlockId = resolved.inColdOpen ? null : resolved.activeBlockId;
    const uiTokenId = resolved.inColdOpen ? null : resolved.activeTokenId;
    setActiveBlockId((prev) => (prev === uiBlockId ? prev : uiBlockId));
    setActiveTokenId((prev) => (prev === uiTokenId ? prev : uiTokenId));
    setPlayheadSec((prev) => (prev === clamped ? prev : clamped));
  }, []);

  const applyRemappedPlayhead = useCallback(
    (nextState: PodcastProjectState) => {
      const nextTl = computeEditedTimeline(nextState);
      const nextSec = remapPlayheadAfterTimelineEdit(
        timelineRef.current,
        nextTl,
        playheadRef.current
      );
      playheadRef.current = nextSec;
      setPlayheadSec(nextSec);
      audioPreview.requestSeek();
    },
    []
  );

  const stepPlayhead = useCallback(
    (deltaSec: number) => {
      seekToSec(playheadRef.current + deltaSec);
    },
    [seekToSec]
  );

  const lastCustomPlaybackRateRef = useRef<number>(
    state.playbackRate && Math.abs(state.playbackRate - 1.0) > 0.01
      ? state.playbackRate
      : 1.5
  );

  const handleChangePlaybackRate = useCallback(
    (rate: number) => {
      const clamped = Math.max(0.5, Math.min(3.5, rate));
      if (Math.abs(clamped - 1.0) > 0.01) {
        lastCustomPlaybackRateRef.current = clamped;
      }
      setState((prev) => ({ ...prev, playbackRate: clamped }));
      notify(`⏩ 播放倍速已切换为 ${clamped}x（保持原声声调不变）`);
    },
    [notify]
  );

  const handleTogglePlaybackRate = useCallback(() => {
    const currentRate = stateRef.current.playbackRate ?? 1.0;
    if (Math.abs(currentRate - 1.0) > 0.01) {
      lastCustomPlaybackRateRef.current = currentRate;
      setState((prev) => ({ ...prev, playbackRate: 1.0 }));
      notify(`⏪ 播放倍速已切换为 1.0x 原速（按 \\ 可切回 ${currentRate}x）`);
    } else {
      const targetRate =
        lastCustomPlaybackRateRef.current > 0 &&
        Math.abs(lastCustomPlaybackRateRef.current - 1.0) > 0.01
          ? lastCustomPlaybackRateRef.current
          : 1.5;
      setState((prev) => ({ ...prev, playbackRate: targetRate }));
      notify(`⏩ 播放倍速已切换为 ${targetRate}x（按 \\ 可切回 1.0x）`);
    }
  }, [notify]);

  const handleToggleCutPrerollEnabled = useCallback(() => {
    setState((prev) => {
      const nextVal = !(prev.cutPrerollEnabled ?? true);
      notify(
        nextVal
          ? `⏪ 已开启剪辑自动回溯播放 (${prev.cutPrerollSec ?? 3}s)`
          : '⏹️ 已关闭剪辑自动回溯播放'
      );
      return { ...prev, cutPrerollEnabled: nextVal };
    });
  }, [notify]);

  const handleTogglePauseCutJumpEnabled = useCallback(() => {
    setState((prev) => {
      const nextVal = !(prev.pauseCutJumpEnabled ?? true);
      notify(
        nextVal
          ? '📍 已开启暂停剪辑定位接缝（删除后往前跳转并播放）'
          : '📍 已关闭暂停剪辑定位接缝（删除后没有任何多余行为）'
      );
      return { ...prev, pauseCutJumpEnabled: nextVal };
    });
  }, [notify]);

  const handleChangeCutPrerollSec = useCallback((sec: number) => {
    const clamped = Math.max(0.5, Math.min(15, Number(sec.toFixed(1))));
    setState((prev) => ({ ...prev, cutPrerollSec: clamped }));
    notify(`⏱️ 剪辑自动回溯时长已设为 ${clamped}s`);
  }, [notify]);

  const playFromCutSeamPreroll = useCallback(
    (
      nextState: PodcastProjectState,
      nextTimeline: TimelineComputation,
      seamSec: number,
      fallbackPlayheadSec?: number
    ) => {
      const maxDur = nextTimeline.totalEditedDurationSec;
      if (maxDur <= 0.05 || nextState.tracks.length === 0) {
        setIsPlaying(false);
        return;
      }
      const clampedSeam = Math.max(0, Math.min(maxDur, seamSec));

      // 若当前是暂停状态：
      // 根据 pauseCutJumpEnabled 配置：
      // 开启时：删除后往前跳转并播放审听；
      // 关闭时：删除后没有任何多余行为（保持暂停、游标原位不跳转、不自动起播、不发起 seek）
      if (!isPlayingRef.current) {
        const isPauseCutJumpEnabled = nextState.pauseCutJumpEnabled ?? true;
        if (!isPauseCutJumpEnabled) {
          const cur = playheadRef.current;
          if (cur > maxDur) {
            playheadRef.current = maxDur;
            setPlayheadSec(maxDur);
          }
          return;
        }

        const backSec =
          typeof nextState.cutPrerollSec === 'number' && nextState.cutPrerollSec >= 0
            ? nextState.cutPrerollSec
            : 3.0;
        const prerollSec = Math.max(0, Number((clampedSeam - backSec).toFixed(3)));
        playheadRef.current = prerollSec;
        setPlayheadSec(prerollSec);
        audioPreview.requestSeek();
        const resolved = resolveEditedPlayheadToSource(nextState, nextTimeline, prerollSec);
        setActiveBlockId((prev) => (prev === resolved.activeBlockId ? prev : resolved.activeBlockId));
        setActiveTokenId((prev) => (prev === resolved.activeTokenId ? prev : resolved.activeTokenId));
        audioPreview.startFromUserGesture(nextState, nextTimeline, prerollSec, notify);
        setIsPlaying(true);
        return;
      }

      // 若当前正在播放中：
      const isPrerollEnabled = nextState.cutPrerollEnabled ?? true;
      if (!isPrerollEnabled) {
        playheadRef.current = clampedSeam;
        setPlayheadSec(clampedSeam);
        audioPreview.requestSeek();
        const resolved = resolveEditedPlayheadToSource(nextState, nextTimeline, clampedSeam);
        setActiveBlockId((prev) => (prev === resolved.activeBlockId ? prev : resolved.activeBlockId));
        setActiveTokenId((prev) => (prev === resolved.activeTokenId ? prev : resolved.activeTokenId));
        audioPreview.startFromUserGesture(nextState, nextTimeline, clampedSeam, notify);
        setIsPlaying(true);
        return;
      }

      const backSec =
        typeof nextState.cutPrerollSec === 'number' && nextState.cutPrerollSec >= 0
          ? nextState.cutPrerollSec
          : 3.0;
      const prerollSec = Math.max(0, Number((clampedSeam - backSec).toFixed(3)));
      playheadRef.current = prerollSec;
      setPlayheadSec(prerollSec);
      audioPreview.requestSeek();
      const resolved = resolveEditedPlayheadToSource(nextState, nextTimeline, prerollSec);
      setActiveBlockId((prev) => (prev === resolved.activeBlockId ? prev : resolved.activeBlockId));
      setActiveTokenId((prev) => (prev === resolved.activeTokenId ? prev : resolved.activeTokenId));
      audioPreview.startFromUserGesture(nextState, nextTimeline, prerollSec, notify);
      setIsPlaying(true);
    },
    [notify]
  );

  const lastTogglePlayTimeRef = useRef<number>(0);
  const spaceKeyHandledRef = useRef<boolean>(false);

  /**
   * Toggles playback synchronously inside the user's click / Space / K gesture so WebKit
   * WKWebView unlocks AudioContext and <audio> elements immediately without autoplay rejection.
   */
  const handleTogglePlay = useCallback(() => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastTogglePlayTimeRef.current < 160) {
      return;
    }
    lastTogglePlayTimeRef.current = now;

    if (isPlayingRef.current) {
      isPlayingRef.current = false;
      audioPreview.pauseMultiTrackPlayback();
      setIsPlaying(false);
      return;
    }
    if (stateRef.current.tracks.length === 0) {
      notify('⚠️ 当前工程尚未导入音频轨道，请先点击「导入音频」或打开已有工程');
      return;
    }
    if (timelineRef.current.totalEditedDurationSec <= 0.05) {
      notify('⚠️ 当前工程可播放时长不足，请先导入音频');
      return;
    }
    let startSec = playheadRef.current;
    if (startSec >= timelineRef.current.totalEditedDurationSec - 0.05) {
      startSec = 0;
      playheadRef.current = 0;
      setPlayheadSec(0);
      audioPreview.requestSeek();
    }
    isPlayingRef.current = true;
    audioPreview.startFromUserGesture(stateRef.current, timelineRef.current, startSec, notify);
    setIsPlaying(true);
  }, [notify]);

  const handleRenameSpeakerTrack = useCallback(
    (trackId: string, newName?: string, newRole?: SpeakerRole) => {
      const currTrack = stateRef.current.tracks.find((t) => t.id === trackId);
      if (!currTrack) return;
      const trimmed = newName !== undefined ? newName.trim() : undefined;
      const nameChanged = Boolean(trimmed && trimmed !== currTrack.name);
      const roleChanged = Boolean(newRole && newRole !== currTrack.role);
      if (!nameChanged && !roleChanged) return;

      mutateProject(
        (prev) => applySpeakerTrackProfileUpdate(prev, trackId, trimmed, newRole),
        true
      );

      if (nameChanged && trimmed) {
        notify(`🎙️ 已将音轨发言人姓名设为「${trimmed}」，文稿与金句已同步更新`);
      } else if (roleChanged && newRole) {
        notify(`🎙️ 已将「${currTrack.name}」角色设为「${SPEAKER_ROLE_LABELS[newRole]}」`);
      }
    },
    [mutateProject, notify]
  );

  // Pre-warm <audio> elements whenever imported tracks change so pressing Space starts with 0ms lag
  useEffect(() => {
    if (state.tracks.length > 0) {
      if (isTauriRuntime()) {
        void ensureNativeAudioServerPort().then(() => {
          audioPreview.preloadTracks(stateRef.current);
        });
      } else {
        audioPreview.preloadTracks(state);
      }
    }
  }, [
    state.tracks,
    state.introBgm,
    state.outroBgm,
    state.introVoiceover,
    state.coldOpenEnabled,
    state.highlights,
  ]);

  // Subscribe to real-time Tauri backend "load-progress" events
  useEffect(() => {
    if (!isTauriRuntime()) return;
    void ensureNativeAudioServerPort();
    let unlistenFn: (() => void) | null = null;
    void import('@tauri-apps/api/event').then(({ listen }) => {
      void listen<{ percent: number; stage: string; message: string }>(
        'load-progress',
        (event) => {
          setLoadingProgress((prev) =>
            prev.active
              ? {
                  ...prev,
                  percent: Math.max(prev.percent, event.payload.percent),
                  stage: event.payload.stage,
                  message: event.payload.message,
                }
              : prev
          );
        }
      ).then((fn) => {
        unlistenFn = fn;
      });
    });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  // Hardware-locked 60fps requestAnimationFrame multi-track playback loop (zero stutter / zero pause-thrashing)
  useEffect(() => {
    if (!isPlaying) {
      audioPreview.pauseMultiTrackPlayback();
      return;
    }
    if (timelineRef.current.totalEditedDurationSec <= 0.05) {
      setIsPlaying(false);
      return;
    }

    // If user pressed Play at the very end of the timeline, restart cleanly from 00:00
    if (playheadRef.current >= timelineRef.current.totalEditedDurationSec - 0.05) {
      playheadRef.current = 0;
      setPlayheadSec(0);
      audioPreview.requestSeek();
    }

    let rafId = 0;
    let lastFrameMs = performance.now();
    let lastUiCommitSec = playheadRef.current;
    let lastUiCommitTok: string | null = null;
    let prevWasBleeped = false;

    const tick = (nowMs: number) => {
      const dtRealSec = Math.min(0.12, Math.max(0, (nowMs - lastFrameMs) / 1000));
      lastFrameMs = nowMs;

      const curState = stateRef.current;
      const curTimeline = timelineRef.current;
      const { nextPlayheadSec: nextSec, resolved } = audioPreview.advanceAndSyncPlayback(
        curState,
        curTimeline,
        playheadRef.current,
        dtRealSec
      );

      if (nextSec >= curTimeline.totalEditedDurationSec) {
        if (playheadRef.current >= curTimeline.totalEditedDurationSec - 0.08) {
          playheadRef.current = 0;
          setPlayheadSec(0);
          setActiveBlockId(null);
          setActiveTokenId(null);
          setIsPlaying(false);
          audioPreview.pauseMultiTrackPlayback();
          return;
        }
        playheadRef.current = Math.min(
          curTimeline.totalEditedDurationSec - 0.001,
          playheadRef.current + dtRealSec * (curState.playbackRate || 1.0)
        );
      } else {
        playheadRef.current = nextSec;
      }

      if (resolved?.isBleeped && !prevWasBleeped) {
        audioPreview.playBleepTone(0.32);
      }
      prevWasBleeped = Boolean(resolved?.isBleeped);

      const nextBlk = resolved?.inColdOpen ? null : (resolved?.activeBlockId ?? null);
      const nextTok = resolved?.inColdOpen ? null : (resolved?.activeTokenId ?? null);

      // Keep UI playhead, activeBlockId, and activeTokenId strictly locked to the exact same frame commit
      // so text highlight and waveform/scrubber playhead never drift out of sync.
      if (Math.abs(nextSec - lastUiCommitSec) >= 0.025 || nextTok !== lastUiCommitTok) {
        lastUiCommitSec = nextSec;
        lastUiCommitTok = nextTok;
        setActiveBlockId((prev) => (prev === nextBlk ? prev : nextBlk));
        setActiveTokenId((prev) => (prev === nextTok ? prev : nextTok));
        setPlayheadSec(Number(nextSec.toFixed(3)));
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [isPlaying]);

  // Immediately update live track gains / playbackRate / BGM beds if user toggles Solo/Mute/Loudness/Speed/BGM while playing
  useEffect(() => {
    if (isPlaying) {
      audioPreview.syncMultiTrackPlayback(state, timeline, playheadRef.current, true);
    }
  }, [
    isPlaying,
    state.playbackRate,
    state.loudnessAligned,
    state.deClickEnabled,
    state.deClickStrength,
    state.autoSoloMode,
    state.duckAttenuationDb,
    state.tracks,
    state.blocks,
    state.trackMuteRanges,
    state.introVoiceover,
    state.introBgm,
    state.outroBgm,
  ]);

  const handleGlobalKeyDown = useLatestCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    const isSliderOrCheckbox =
      target instanceof HTMLInputElement &&
      (target.type === 'range' || target.type === 'checkbox' || target.type === 'radio');
    const inInput =
      !isSliderOrCheckbox &&
      (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable);

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      newEmptyProjectRef.current?.();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void handleSaveProjectFile(e.shiftKey);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      void handleOpenProjectFile();
      return;
    }
    if (!inInput && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      if (undoStackRef.current.length > 0) {
        e.preventDefault();
        handleUndoLastEdit();
      }
      return;
    }

    if (
      inInput ||
      importModalOpen ||
      retranscribeModalOpen ||
      depGuideModalOpen ||
      subtitleModalOpen ||
      auxLibraryModal.open ||
      loadingProgress.active ||
      globalEditingHighlight !== null
    )
      return;

    if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
      e.preventDefault();
      setShortcutsModalOpen((v) => !v);
      return;
    }

    if (shortcutsModalOpen) return;

    // 切换视图快捷键: ⌥ 1 (音轨视图) / ⌥ 2 (文稿视图)
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.key === '1') {
        e.preventDefault();
        mutateProject((p) => ({ ...p, workspaceLayout: 'multitrack' }));
        return;
      }
      if (e.key === '2') {
        e.preventDefault();
        mutateProject((p) => ({ ...p, workspaceLayout: 'transcript' }));
        return;
      }
    }

    // 折叠区域快捷键: ⌘ [ (折叠/展开左侧音轨栏) / ⌘ ] (折叠/展开右侧AI栏)
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      if (e.key === '[' || e.key === '【') {
        e.preventDefault();
        setLeftPaneCollapsed((v) => !v);
        return;
      }
      if (e.key === ']' || e.key === '】') {
        e.preventDefault();
        setRightPaneCollapsed((v) => !v);
        return;
      }
    }

    if (e.key === 'Escape' && selectedIds.size > 0) {
      e.preventDefault();
      setSelectedIds(new Set());
      return;
    }

    const isDeleteOrBackspace = e.key === 'Backspace' || e.key === 'Delete';
    const isPlainDelete =
      isDeleteOrBackspace && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    const isCmdShiftDelete =
      isDeleteOrBackspace && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey;
    if ((isPlainDelete || isCmdShiftDelete) && selectedIds.size > 0) {
      e.preventDefault();
      handleRippleDeleteSelected();
      return;
    }

    const lower = e.key.toLowerCase();
    if (!e.metaKey && !e.ctrlKey && !e.altKey && lower === 'b' && selectedIds.size > 0) {
      e.preventDefault();
      handleBleepSelected();
      return;
    }

    const isSpaceKey =
      e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
    const isPlayToggleKey =
      isSpaceKey || (!e.metaKey && !e.ctrlKey && !e.altKey && lower === 'k');

    if (isPlayToggleKey) {
      e.preventDefault();
      if (e.repeat) return;
      if (isSpaceKey) {
        spaceKeyHandledRef.current = true;
      }
      if (target && (isSliderOrCheckbox || tag === 'BUTTON')) {
        target.blur();
      }
      if (
        document.activeElement instanceof HTMLElement &&
        (document.activeElement.tagName === 'BUTTON' ||
          (document.activeElement instanceof HTMLInputElement &&
            (document.activeElement.type === 'range' ||
              document.activeElement.type === 'checkbox' ||
              document.activeElement.type === 'radio')))
      ) {
        document.activeElement.blur();
      }
      handleTogglePlay();
      return;
    }

    if (state.tracks.length === 0) return; else if (e.key === 'ArrowLeft' || (!e.metaKey && !e.ctrlKey && lower === 'j')) {
      e.preventDefault();
      stepPlayhead(e.shiftKey ? -1 : -5);
    } else if (e.key === 'ArrowRight' || (!e.metaKey && !e.ctrlKey && lower === 'l')) {
      e.preventDefault();
      stepPlayhead(e.shiftKey ? 1 : 5);
    } else if (e.key === 'Home' || (!e.metaKey && !e.ctrlKey && e.key === '0')) {
      e.preventDefault();
      seekToSec(0);
    } else if (e.key === '[' || e.key === '【') {
      e.preventDefault();
      const curr = state.playbackRate || 1.0;
      const prevIdx = Math.max(
        0,
        PLAYBACK_RATES.findIndex((r) => r >= curr - 0.01) - 1
      );
      handleChangePlaybackRate(PLAYBACK_RATES[prevIdx]);
    } else if (e.key === ']' || e.key === '】') {
      e.preventDefault();
      const curr = state.playbackRate || 1.0;
      const curIdx = PLAYBACK_RATES.findIndex((r) => r >= curr - 0.01);
      const nextIdx = Math.min(
        PLAYBACK_RATES.length - 1,
        (curIdx === -1 ? 1 : curIdx) + 1
      );
      handleChangePlaybackRate(PLAYBACK_RATES[nextIdx]);
    } else if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === '\\' || e.key === '、')) {
      e.preventDefault();
      handleTogglePlaybackRate();
    } else if (!e.metaKey && !e.ctrlKey && !e.altKey && lower === 'n') {
      e.preventDefault();
      const nextMode: WaveformSelectionMode =
        (state.waveformSelectionMode ?? 'snap') === 'snap' ? 'free' : 'snap';
      stableSetWaveformSelectionMode(nextMode);
    }
  });

  // Global keyboard shortcuts: Play/Pause (Space/K), Seek (←/→/J/L/0/Home), Speed ([/]), Undo (⌘Z), Save/Open, Delete
  useEffect(() => {
    const handleGlobalKeyUpCapture = (e: KeyboardEvent) => {
      const isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
      if (isSpace && spaceKeyHandledRef.current) {
        spaceKeyHandledRef.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    window.addEventListener('keyup', handleGlobalKeyUpCapture, true);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
      window.removeEventListener('keyup', handleGlobalKeyUpCapture, true);
    };
  }, [handleGlobalKeyDown]);

  // ==================== Project File Management (New / Open / Save / Save As) ====================

  const applyLoadedProject = useCallback(
    (loaded: PodcastProjectState) => {
      audioPreview.stopAll();
      setIsPlaying(false);
      const targetTl = computeEditedTimeline(loaded);
      const maxDur = targetTl.totalEditedDurationSec;
      const rawSaved = loaded.savedPlayheadSec ?? 0;
      const targetSec = Math.max(
        0,
        maxDur > 0 ? Math.min(maxDur, rawSaved) : rawSaved
      );
      const clampedTarget = Number(targetSec.toFixed(3));
      playheadRef.current = clampedTarget;
      setPlayheadSec(clampedTarget);
      const resolved = resolveEditedPlayheadToSource(loaded, targetTl, clampedTarget);
      setActiveBlockId(resolved.activeBlockId);
      setActiveTokenId(resolved.activeTokenId);
      audioPreview.requestSeek();
      setSelectedIds(new Set());
      clearUndoHistory();
      setState(loaded);
      setIsDirty(false);
      if (clampedTarget > 0) {
        notify(
          `📂 已打开工程「${loaded.projectTitle}」（共 ${loaded.tracks.length} 轨，游标已重定位至 ${clampedTarget.toFixed(2)}s）`
        );
      } else {
        notify(`📂 已打开工程「${loaded.projectTitle}」（共 ${loaded.tracks.length} 轨）`);
      }
    },
    [clearUndoHistory, notify]
  );

  const handleNewEmptyProject = () => {
    if (isDirty && state.tracks.length > 0) {
      const ok = window.confirm('当前工程有未保存的修改，确定新建空白工程吗？');
      if (!ok) return;
    }
    audioPreview.stopAll();
    setIsPlaying(false);
    playheadRef.current = 0;
    setPlayheadSec(0);
    setSelectedIds(new Set());
    clearUndoHistory();
    setState(createProjectWithGlobalDefaults());
    setIsDirty(false);
    const hasDefaults = globalAuxItems.some((it) => it.isDefault);
    notify(
      hasDefaults
        ? '📄 已创建全新播客工程，并自动载入全局默认口播 / BGM'
        : '📄 已创建全新空白播客工程'
    );
  };
  newEmptyProjectRef.current = handleNewEmptyProject;

  const handleSaveProjectFile = async (saveAs = false) => {
    try {
      const currentPlayhead = Number(
        (playheadRef.current ?? playheadSec ?? 0).toFixed(3)
      );
      const stateToSave: PodcastProjectState = {
        ...state,
        savedPlayheadSec: Math.max(0, currentPlayhead),
      };
      const res = await savePodcraftProject(stateToSave, saveAs);
      if (!res) return;
      setState((prev) => ({
        ...prev,
        savedPlayheadSec: stateToSave.savedPlayheadSec,
        projectFilePath: res.savedPath,
        lastSavedAt: res.savedAt,
      }));
      recordRecentProject(
        res.savedPath,
        stateToSave.projectTitle,
        stateToSave.tracks?.length
      );
      setRecentProjects(loadRecentProjects());
      setIsDirty(false);
      notify(
        currentPlayhead > 0
          ? `💾 工程已保存: ${res.savedPath}（游标已记录在 ${currentPlayhead.toFixed(2)}s）`
          : `💾 工程已保存: ${res.savedPath}`
      );
    } catch (err) {
      notify(`保存工程失败: ${String(err)}`);
    }
  };

  const handleOpenProjectFilePath = useCallback(
    async (filePath: string) => {
      if (!isTauriRuntime()) return;
      try {
        setLoadingProgress({
          active: true,
          title: '正在加载播客工程文件 (.podcraft)',
          stage: 'project_read',
          percent: 15,
          message: `正在读取 ${filePath.split(/[/\\]/).pop()}...`,
          startedAtMs: Date.now(),
        });
        const loaded = await loadPodcraftProjectFromPath(filePath);
        setLoadingProgress((prev) => ({
          ...prev,
          active: true,
          stage: 'restore_ui',
          percent: 100,
          message: '工程状态恢复完成！',
        }));
        await new Promise((r) => window.setTimeout(r, 140));
        applyLoadedProject(loaded);
        recordRecentProject(
          filePath,
          loaded.projectTitle,
          loaded.tracks?.length
        );
        setRecentProjects(loadRecentProjects());
        notify(`📂 已成功载入工程: ${loaded.projectTitle || filePath.split(/[/\\]/).pop()}`);
      } catch (err) {
        notify(`打开工程失败: ${String(err)}`);
      } finally {
        setLoadingProgress((p) => ({ ...p, active: false }));
      }
    },
    [applyLoadedProject, notify]
  );

  const handleRegisterFileAssociation = useCallback(async () => {
    if (!isTauriRuntime()) {
      notify('仅在 macOS 桌面端支持注册 .podcraft 系统打开方式');
      return;
    }
    try {
      const ok = await registerFileAssociationNative();
      if (ok) {
        notify('✓ 成功向 macOS 注册 .podcraft 文件关联！双击工程文件即可直达打开');
      } else {
        notify('⚠️ 未检测到系统 LaunchServices 注册命令，但已写入应用包关联配置');
      }
    } catch (err) {
      notify(`注册文件关联失败: ${String(err)}`);
    }
  }, [notify]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    getPendingOpenFileNative()
      .then((pending) => {
        if (pending) {
          void handleOpenProjectFilePath(pending);
        }
      })
      .catch(console.error);

    import('@tauri-apps/api/event')
      .then(({ listen }) => {
        listen<string>('open-file', (event) => {
          if (event.payload) {
            void handleOpenProjectFilePath(event.payload);
          }
        }).then((un) => {
          unlisten = un;
        });
      })
      .catch(console.error);

    return () => {
      unlisten?.();
    };
  }, [handleOpenProjectFilePath]);

  const handleOpenProjectFile = async () => {
    if (isTauriRuntime()) {
      try {
        setLoadingProgress({
          active: true,
          title: '正在加载播客工程文件 (.podcraft)',
          stage: 'open_dialog',
          percent: 8,
          message: '请选择要打开的 .podcraft 工程文件...',
          startedAtMs: Date.now(),
        });
        const loaded = await openPodcraftProjectNative();
        if (!loaded) {
          setLoadingProgress((p) => ({ ...p, active: false }));
          return;
        }
        setLoadingProgress((prev) => ({
          ...prev,
          active: true,
          stage: 'restore_ui',
          percent: 100,
          message: '工程状态恢复完成！',
        }));
        await new Promise((r) => window.setTimeout(r, 140));
        applyLoadedProject(loaded);
        if (loaded.projectFilePath) {
          recordRecentProject(
            loaded.projectFilePath,
            loaded.projectTitle,
            loaded.tracks?.length
          );
          setRecentProjects(loadRecentProjects());
        }
      } catch (err) {
        notify(`打开工程失败: ${String(err)}`);
      } finally {
        setLoadingProgress((p) => ({ ...p, active: false }));
      }
    } else {
      browserProjectInputRef.current?.click();
    }
  };

  const handleClearRecentProjects = useCallback(() => {
    clearRecentProjects();
    setRecentProjects([]);
    notify('已清空最近工程打开历史记录');
  }, [notify]);

  const handleBrowserProjectFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    try {
      setLoadingProgress({
        active: true,
        title: '正在加载播客工程文件 (.podcraft)',
        stage: 'browser_read',
        percent: 5,
        message: `准备读取 ${file.name}...`,
        subDetail: file.name,
        startedAtMs: Date.now(),
      });
      const loaded = await readPodcraftProjectBrowserFile(file, (pct, msg) => {
        setLoadingProgress((prev) => ({
          ...prev,
          active: true,
          percent: pct,
          message: msg,
        }));
      });
      await new Promise((r) => window.setTimeout(r, 140));
      applyLoadedProject(loaded);
    } catch (err) {
      notify(`工程文件解析失败: ${String(err)}`);
    } finally {
      setLoadingProgress((p) => ({ ...p, active: false }));
    }
  };

  // ==================== Multi-Track Audio Import with Progress Bar ====================

  const handlePickNativeAudioFiles = async () => {
    if (!isTauriRuntime()) return;
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const selected = await openDialog({
        multiple: true,
        filters: [
          {
            name: '播客音频轨道',
            extensions: ['wav', 'mp3', 'm4a', 'flac', 'aac', 'ogg', 'mp4'],
          },
        ],
      });
      if (!selected || (Array.isArray(selected) && selected.length === 0)) return;
      const paths = Array.isArray(selected) ? selected : [selected];

      audioPreview.stopAll();
      setIsPlaying(false);

      setLoadingProgress({
        active: true,
        title: `正在导入并识别 ${paths.length} 条音频轨道`,
        stage: 'dsp_inspect',
        percent: 5,
        message: '正在启动流式音频解码、响度测量与时钟对齐...',
        subDetail: paths.map((p) => p.split(/[/\\]/).pop()).join(' · '),
        startedAtMs: Date.now(),
      });

      const colors = ['#3b82f6', '#10b981', '#a855f7', '#f59e0b', '#ec4899', '#06b6d4'];
      let nonRefIdx = 0;
      let hasAssignedRef = false;
      const inputs = paths.map((p, idx) => {
        const base = p.split(/[/\\]/).pop() ?? `Track_${idx + 1}`;
        const lower = base.toLowerCase();
        const looksLikeRef =
          lower.includes('ref') || lower.includes('mix') || lower.includes('参考');
        // Never mark a single imported file as reference track, and assign at most 1 reference track
        const isRef = paths.length >= 2 && looksLikeRef && !hasAssignedRef;
        if (isRef) {
          hasAssignedRef = true;
        }
        const role = isRef ? 'ref' : nonRefIdx++ === 0 ? 'host' : 'guest';
        return {
          id: isRef ? `ref_${idx + 1}` : `sp_${idx + 1}`,
          name: base.replace(/\.[^.]+$/, ''),
          role,
          color: isRef ? '#64748b' : colors[idx % colors.length],
          filePath: p,
          isRef,
        };
      });

      const alignedTracks = await inspectAndAlignNativeTracks(state.recordingMode, inputs);
      if (!alignedTracks || alignedTracks.length === 0) {
        throw new Error('未能解析所选音频轨道');
      }

      const isDeepSeekAsr = state.asrConfig?.provider === 'deepseek';
      const isVolcAsr = state.asrConfig?.provider === 'volcengine_doubao';
      setLoadingProgress((prev) => ({
        ...prev,
        percent: Math.max(prev.percent, 50),
        stage: 'asr_transcribe',
        message: isVolcAsr
          ? '正在调用火山引擎豆包语音说话人分离 (SSD) 识别并拆分子角色...'
          : isDeepSeekAsr
          ? '正在调用 DeepSeek 语音识别 API (/v1/tools/asr) 转写逐字文稿...'
          : '正在启动 SenseVoice + Silero VAD 神经网络识别语音文字与停顿空白...',
      }));

      let sidecarRes: Awaited<ReturnType<typeof runPythonSidecarTranscribe>> = null;
      let asrErrText = '';
      try {
        sidecarRes = await runPythonSidecarTranscribe(
          alignedTracks,
          state.glossary,
          state.recordingMode,
          (pct, msg) => {
            setLoadingProgress((prev) => ({
              ...prev,
              active: true,
              stage: 'asr_ai',
              percent: Math.max(prev.percent, pct),
              message: msg,
            }));
          },
          state.asrConfig
        );
      } catch (asrErr) {
        asrErrText = String(asrErr);
        sidecarRes = null;
      }

      const finalTracks =
        sidecarRes?.separatedTracks && sidecarRes.separatedTracks.length >= 2
          ? hydrateSeparatedTracks(sidecarRes.separatedTracks, alignedTracks[0])
          : alignedTracks;

      setLoadingProgress((prev) => ({
        ...prev,
        percent: 92,
        stage: 'timeline_build',
        message: '正在生成多轨波形、逐字对话段落与动态时间轴...',
      }));
      await new Promise((r) => window.setTimeout(r, 60));

      const { blocks, emotionCurve } = buildTranscriptBlocksFromImportedTracks(
        finalTracks,
        sidecarRes?.tracks ?? null,
        state.glossary,
        state.recordingMode
      );

      const firstStemName = alignedTracks[0]?.name ?? '多轨播客';
      const nextTitle =
        state.projectTitle === '未命名播客工程'
          ? `${firstStemName} (${finalTracks.length}轨工程)`
          : state.projectTitle;

      setLoadingProgress((prev) => ({
        ...prev,
        percent: 100,
        stage: 'done',
        message: '全部步骤完成：音轨对齐、逐字识别与波形时间轴已就绪！',
      }));
      await new Promise((r) => window.setTimeout(r, 260));

      playheadRef.current = 0;
      setPlayheadSec(0);
      setSelectedIds(new Set());
      clearUndoHistory();
      setState((prev) => ({
        ...prev,
        projectTitle: nextTitle,
        tracks: finalTracks,
        blocks,
        highlights: [],
        emotionCurve,
        coldOpenEnabled: false,
        aiEpisodeSummary: undefined,
      }));
      setIsDirty(true);

      const recognizedCount = Object.values(sidecarRes?.tracks ?? {}).reduce(
        (sum, tr) => sum + (tr.tokens?.length ?? 0),
        0
      );
      if (recognizedCount > 0) {
        const engineLabel =
          sidecarRes?.engine === 'volcengine_doubao'
            ? '火山引擎豆包语音 (SSD 分角色)'
            : sidecarRes?.engine === 'deepseek_asr'
            ? 'DeepSeek ASR'
            : '本地 SenseVoice';
        const fallbackNote = sidecarRes?.fallbackUsed
          ? `（云端 API 不可用已自动回退本地模型: ${sidecarRes.fallbackReason || ''}）`
          : '';
        const sepNote =
          sidecarRes?.separatedTracks && sidecarRes.separatedTracks.length >= 2
            ? `，单文件已拆分为 ${finalTracks.length} 条独立角色音轨`
            : '';
        notify(
          `✓ 已导入 ${finalTracks.length} 条音轨，经 ${engineLabel} 识别 ${recognizedCount} 个逐字/词切片与空白胶囊${sepNote}${fallbackNote}`
        );
      } else if (asrErrText) {
        notify(`⚠️ 音轨已导入，但语音识别异常: ${asrErrText}`);
      } else {
        notify(
          `✓ 已导入 ${finalTracks.length} 条音轨（未检测到清晰人声，已生成声学空白区间）`
        );
      }
    } catch (err) {
      notify(`导入音频失败: ${String(err)}`);
    } finally {
      setLoadingProgress((p) => ({ ...p, active: false }));
    }
  };

  const handlePickBrowserAudioFiles = async (fileList: FileList) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    audioPreview.stopAll();
    setIsPlaying(false);

    try {
      setLoadingProgress({
        active: true,
        title: `正在导入并识别 ${files.length} 条音频文件`,
        stage: 'web_decode',
        percent: 5,
        message: '正在初始化音频解码引擎...',
        subDetail: files.map((f) => f.name).join(' · '),
        startedAtMs: Date.now(),
      });

      const inspectedTracks: SpeakerTrack[] = await inspectBrowserAudioFilesWithProgress(
        files,
        (pct, msg) => {
          setLoadingProgress((prev) => ({
            ...prev,
            active: true,
            percent: Math.max(prev.percent, pct),
            message: msg,
          }));
        }
      );

      let tracksForProject = inspectedTracks;
      let sidecarRes: Awaited<ReturnType<typeof runPythonSidecarTranscribe>> = null;
      let asrErrText = '';

      try {
        const uploadedPaths = await uploadBrowserAudioFilesForAsr(files, (pct, msg) => {
          setLoadingProgress((prev) => ({
            ...prev,
            active: true,
            stage: 'asr_upload',
            percent: Math.max(prev.percent, pct),
            message: msg,
          }));
        });
        if (uploadedPaths && uploadedPaths.length === inspectedTracks.length) {
          tracksForProject = inspectedTracks.map((tr, idx) => ({
            ...tr,
            filePath: uploadedPaths[idx],
          }));
        }

        const isDeepSeekAsr = state.asrConfig?.provider === 'deepseek';
        const isVolcAsr = state.asrConfig?.provider === 'volcengine_doubao';
        setLoadingProgress((prev) => ({
          ...prev,
          active: true,
          stage: 'asr_transcribe',
          percent: Math.max(prev.percent, 52),
          message: isVolcAsr
            ? '正在调用火山引擎豆包语音说话人分离 (SSD) 识别并拆分子角色...'
            : isDeepSeekAsr
            ? '正在调用 DeepSeek 语音识别 API (/v1/tools/asr) 转写逐字文稿...'
            : '正在运行本地 SenseVoice + Silero VAD 神经网络识别逐字中文/英文文稿...',
        }));

        sidecarRes = await runPythonSidecarTranscribe(
          tracksForProject,
          state.glossary,
          state.recordingMode,
          (pct, msg) => {
            setLoadingProgress((prev) => ({
              ...prev,
              active: true,
              stage: 'asr_ai',
              percent: Math.max(prev.percent, pct),
              message: msg,
            }));
          },
          state.asrConfig
        );
      } catch (asrErr) {
        asrErrText = String(asrErr);
        sidecarRes = null;
      }

      const finalTracks =
        sidecarRes?.separatedTracks && sidecarRes.separatedTracks.length >= 2
          ? hydrateSeparatedTracks(sidecarRes.separatedTracks, tracksForProject[0])
          : tracksForProject;

      setLoadingProgress((prev) => ({
        ...prev,
        percent: 94,
        stage: 'timeline_build',
        message: '正在组装逐字文稿、空白停顿胶囊与多轨对话时间轴...',
      }));
      await new Promise((r) => window.setTimeout(r, 80));

      const { blocks, emotionCurve } = buildTranscriptBlocksFromImportedTracks(
        finalTracks,
        sidecarRes?.tracks ?? null,
        state.glossary,
        state.recordingMode
      );

      const firstStemName = tracksForProject[0]?.name ?? '多轨播客';
      const nextTitle =
        state.projectTitle === '未命名播客工程'
          ? `${firstStemName} (${finalTracks.length}轨工程)`
          : state.projectTitle;

      setLoadingProgress((prev) => ({
        ...prev,
        percent: 100,
        stage: 'done',
        message: '全部步骤完成：音轨波形、逐字文稿与空白胶囊已就绪！',
      }));
      await new Promise((r) => window.setTimeout(r, 260));

      playheadRef.current = 0;
      setPlayheadSec(0);
      setSelectedIds(new Set());
      clearUndoHistory();
      setState((prev) => ({
        ...prev,
        projectTitle: nextTitle,
        tracks: finalTracks,
        blocks,
        highlights: [],
        emotionCurve,
        coldOpenEnabled: false,
        aiEpisodeSummary: undefined,
      }));
      setIsDirty(true);

      const recognizedCount = Object.values(sidecarRes?.tracks ?? {}).reduce(
        (sum, tr) => sum + (tr.tokens?.length ?? 0),
        0
      );
      if (recognizedCount > 0) {
        const engineLabel =
          sidecarRes?.engine === 'volcengine_doubao'
            ? '火山引擎豆包语音 (SSD 分角色)'
            : sidecarRes?.engine === 'deepseek_asr'
            ? 'DeepSeek ASR'
            : '本地 SenseVoice';
        const fallbackNote = sidecarRes?.fallbackUsed
          ? `（云端 API 不可用已自动回退本地模型: ${sidecarRes.fallbackReason || ''}）`
          : '';
        const sepNote =
          sidecarRes?.separatedTracks && sidecarRes.separatedTracks.length >= 2
            ? `，单文件已拆分为 ${finalTracks.length} 条独立角色音轨`
            : '';
        notify(
          `✓ 已导入 ${finalTracks.length} 条音轨，经 ${engineLabel} 识别 ${recognizedCount} 个逐字/词切片与空白胶囊${sepNote}${fallbackNote}`
        );
      } else if (asrErrText) {
        notify(`⚠️ 音轨已导入，但语音识别服务异常: ${asrErrText}`);
      } else {
        notify(`✓ 已导入 ${finalTracks.length} 条音频轨道并提取空白区间`);
      }
    } catch (err) {
      notify(`解析音频失败: ${String(err)}`);
    } finally {
      setLoadingProgress((p) => ({ ...p, active: false }));
    }
  };

  const handleCancelRetranscribe = async () => {
    isRetranscribeAbortedRef.current = true;
    try {
      await cancelPythonSidecarTranscribe();
    } catch (e) {
      console.warn('cancelPythonSidecarTranscribe failed:', e);
    }
    setLoadingProgress((p) => ({ ...p, active: false }));
    notify('已停止语音识别');
  };

  const handleRetranscribeCurrentTracks = async (overrideConfig?: AsrConfig) => {
    if (state.tracks.length === 0) {
      notify('请先导入音频轨道');
      return;
    }
    const tracksWithPaths = state.tracks.filter((t) => Boolean(t.filePath));
    if (tracksWithPaths.length === 0) {
      if (!isTauriRuntime()) {
        notify('当前工程缺少本地音频缓存路径，请重新选择音频文件导入并自动识别');
        browserAudioInputRef.current?.click();
      } else {
        notify('当前工程音轨未关联本地音频路径，请点击「导入音频」重新选择音轨');
      }
      return;
    }

    audioPreview.stopAll();
    setIsPlaying(false);
    isRetranscribeAbortedRef.current = false;

    const activeConfig = overrideConfig ?? state.asrConfig;

    try {
      const isDeepSeekAsr = activeConfig?.provider === 'deepseek';
      const isVolcAsr = activeConfig?.provider === 'volcengine_doubao';
      setLoadingProgress({
        active: true,
        title: `正在重新识别 ${tracksWithPaths.length} 条音频轨道的语音文字`,
        stage: 'asr_retranscribe',
        percent: 28,
        message: isVolcAsr
          ? '正在调用火山引擎豆包语音说话人分离 (SSD) 重新识别与分角色...'
          : isDeepSeekAsr
          ? '正在调用 DeepSeek 语音识别 API (/v1/tools/asr) 重新转写...'
          : '正在启动 SenseVoice + Silero VAD 本地神经网络转写引擎...',
        startedAtMs: Date.now(),
      });

      const sidecarRes = await runPythonSidecarTranscribe(
        state.tracks,
        state.glossary,
        state.recordingMode,
        (pct, msg) => {
          if (isRetranscribeAbortedRef.current) return;
          setLoadingProgress((prev) => ({
            ...prev,
            active: true,
            stage: 'asr_ai',
            percent: Math.max(prev.percent, pct),
            message: msg,
          }));
        },
        activeConfig
      );

      if (isRetranscribeAbortedRef.current) {
        return;
      }

      const finalTracks =
        sidecarRes?.separatedTracks && sidecarRes.separatedTracks.length >= 2
          ? hydrateSeparatedTracks(sidecarRes.separatedTracks, state.tracks[0])
          : state.tracks;

      setLoadingProgress((prev) => ({
        ...prev,
        percent: 94,
        stage: 'timeline_rebuild',
        message: '正在根据最新识别结果重建逐字对话流与空白胶囊...',
      }));
      await new Promise((r) => window.setTimeout(r, 80));

      if (isRetranscribeAbortedRef.current) {
        return;
      }

      const { blocks, emotionCurve } = buildTranscriptBlocksFromImportedTracks(
        finalTracks,
        sidecarRes?.tracks ?? null,
        state.glossary,
        state.recordingMode
      );

      setLoadingProgress((prev) => ({
        ...prev,
        percent: 100,
        stage: 'done',
        message: '语音重新识别全部完成！',
      }));
      await new Promise((r) => window.setTimeout(r, 240));

      if (isRetranscribeAbortedRef.current) {
        return;
      }

      setSelectedIds(new Set());
      mutateProject(
        (prev) => ({
          ...prev,
          tracks: finalTracks,
          blocks,
          emotionCurve,
        }),
        true
      );

      const recognizedCount = Object.values(sidecarRes?.tracks ?? {}).reduce(
        (sum, tr) => sum + (tr.tokens?.length ?? 0),
        0
      );
      const engineLabel =
        sidecarRes?.engine === 'volcengine_doubao'
          ? '火山引擎豆包语音 (SSD 分角色)'
          : sidecarRes?.engine === 'deepseek_asr'
          ? 'DeepSeek ASR'
          : '本地 SenseVoice';
      const fallbackNote = sidecarRes?.fallbackUsed
        ? `（云端 API 不可用已自动回退本地模型: ${sidecarRes.fallbackReason || ''}）`
        : '';
      const sepNote =
        sidecarRes?.separatedTracks && sidecarRes.separatedTracks.length >= 2
          ? `，单文件已拆分为 ${finalTracks.length} 条独立角色音轨`
          : '';
      notify(
        recognizedCount > 0
          ? `🎙️ ${engineLabel} 重新识别完成：共生成 ${recognizedCount} 个逐字/词时间戳切片${sepNote}！${fallbackNote}`
          : '⚠️ 已完成扫描，但所选音轨未检测到清晰语音内容'
      );
    } catch (err: unknown) {
      if (isRetranscribeAbortedRef.current || (err instanceof Error && err.name === 'AbortError')) {
        notify('已停止语音识别');
      } else {
        notify(`语音识别失败: ${String(err)}`);
      }
    } finally {
      setLoadingProgress((p) => ({ ...p, active: false }));
    }
  };

  // ==================== Editing Actions ====================

  const handleSelectToken = (
    tokenId: string,
    flatIndex: number,
    shiftKey: boolean,
    metaKey: boolean
  ) => {
    const flatIds: string[] = [];
    state.blocks.forEach((b) =>
      b.tokens.forEach((t) => {
        flatIds.push(t.id);
      })
    );

    setSelectedIds((prev) => {
      const next = new Set(metaKey ? prev : []);
      if (shiftKey && lastClickedIdx !== null) {
        const [s, e] = [Math.min(lastClickedIdx, flatIndex), Math.max(lastClickedIdx, flatIndex)];
        for (let i = s; i <= e; i++) {
          if (flatIds[i]) next.add(flatIds[i]);
        }
      } else {
        if (prev.has(tokenId) && prev.size === 1 && !metaKey) {
          return new Set();
        }
        next.add(tokenId);
        setLastClickedIdx(flatIndex);
      }
      return next;
    });
  };

  const handleSelectRange = (startFlatIndex: number, endFlatIndex: number, additive: boolean) => {
    const flatIds: string[] = [];
    state.blocks.forEach((b) =>
      b.tokens.forEach((t) => {
        flatIds.push(t.id);
      })
    );
    const [s, e] = [Math.min(startFlatIndex, endFlatIndex), Math.max(startFlatIndex, endFlatIndex)];
    setSelectedIds((prev) => {
      const next = new Set(additive ? prev : []);
      for (let i = s; i <= e; i++) {
        if (flatIds[i]) next.add(flatIds[i]);
      }
      return next;
    });
    setLastClickedIdx(endFlatIndex);
  };

  const handleRippleDeleteSelected = () => {
    if (selectedIds.size === 0) {
      notify('请先在文稿中选中字词/空白胶囊，或在下方多轨波形拖拽框选切除！');
      return;
    }
    let earliestStartSec = Number.POSITIVE_INFINITY;
    for (const m of timelineRef.current.mappedTokens) {
      if (!m.token.deleted && selectedIds.has(m.tokenId)) {
        earliestStartSec = Math.min(earliestStartSec, m.editedStartSec);
      }
    }
    const nextState: PodcastProjectState = {
      ...state,
      blocks: state.blocks.map((b) => ({
        ...b,
        tokens: b.tokens.map((t) =>
          selectedIds.has(t.id) ? { ...t, deleted: true, cutByWaveform: false } : t
        ),
      })),
    };
    const nextTimeline = computeEditedTimeline(nextState);
    const seamSec = Number.isFinite(earliestStartSec)
      ? earliestStartSec
      : remapPlayheadAfterTimelineEdit(timelineRef.current, nextTimeline, playheadRef.current);

    const wasPlaying = isPlayingRef.current;
    mutateProject(() => nextState, true);
    setSelectedIds(new Set());
    playFromCutSeamPreroll(nextState, nextTimeline, seamSec);
    const shouldPrerollPlay = wasPlaying
      ? (nextState.cutPrerollEnabled ?? true)
      : (nextState.pauseCutJumpEnabled ?? true);
    const backSec = nextState.cutPrerollSec ?? 3;
    notify(
      shouldPrerollPlay
        ? `✂️ 已删除并隐藏选中文字，全轨音频已同步缝合并从 ${backSec}s 前播放审听（按 ⌘Z 可撤销）`
        : '✂️ 已删除并隐藏选中文字，全轨音频已同步波纹缝合（按 ⌘Z 可撤销）'
    );
  };

  const handleMuteTrackSelected = () => {
    if (selectedIds.size === 0) {
      notify('请先选中需要单轨静音的片段（仅静音该发言人轨道，总时长不变）');
      return;
    }
    mutateProject(
      (prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) => ({
          ...b,
          tokens: b.tokens.map((t) =>
            selectedIds.has(t.id) && t.type !== 'silence' ? { ...t, trackMuted: true } : t
          ),
        })),
      }),
      true
    );
    setSelectedIds(new Set());
    notify('🔇 已对选中片段执行单轨静音填充底噪，多轨总时长保持不变');
  };

  const handleBleepSelected = () => {
    if (selectedIds.size === 0) {
      notify('请先在文稿中选中需要脱敏的字词或片段，再点击替换「哔」！');
      return;
    }

    const selTokens = timeline.mappedTokens.filter(
      (m) => !m.token.deleted && selectedIds.has(m.tokenId) && m.token.type !== 'silence'
    );
    const allBleeped = selTokens.length > 0 && selTokens.every((m) => Boolean(m.token.bleeped));
    const nextBleepVal = !allBleeped;

    if (nextBleepVal) {
      audioPreview.playBleepTone();
    }
    mutateProject(
      (prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) => ({
          ...b,
          tokens: b.tokens.map((t) =>
            selectedIds.has(t.id) && t.type !== 'silence'
              ? {
                  ...t,
                  bleeped: nextBleepVal,
                  bleepStyle: nextBleepVal ? 'sine_1khz_bleep' : undefined,
                }
              : t
          ),
        })),
      }),
      true
    );
    setSelectedIds(new Set());
    notify(
      nextBleepVal
        ? '🚨 已将选区替换为 1kHz「哔——」消音脱敏'
        : '🔊 已取消选区「哔」消音并恢复原声'
    );
  };

  const joinHighlightTokenTexts = (parts: string[]): string => {
    let out = '';
    for (const raw of parts) {
      const text = raw;
      if (!text) continue;
      if (
        out.length > 0 &&
        /[A-Za-z0-9]$/.test(out) &&
        /^[A-Za-z0-9]/.test(text)
      ) {
        out += ' ';
      }
      out += text;
    }
    return out.trim();
  };

  const handleAddSelectedToHighlight = (directOptions?: {
    text?: string;
    startSec?: number;
    endSec?: number;
    speakerId?: string;
  }) => {
    // 1. 支持从文稿模式直接传入文本或范围
    if (directOptions && directOptions.text) {
      const cleanText = directOptions.text.trim();
      if (!cleanText) return;

      let spId = directOptions.speakerId;
      let startMs: number;
      let endMs: number;

      if (
        typeof directOptions.startSec === 'number' &&
        typeof directOptions.endSec === 'number' &&
        directOptions.endSec >= directOptions.startSec
      ) {
        startMs = Math.round(directOptions.startSec * 1000);
        endMs = Math.round(directOptions.endSec * 1000);
        if (endMs <= startMs) {
          endMs = startMs + Math.max(500, Math.round((cleanText.length / 4.5) * 1000));
        }
      } else {
        // 未传明确时间戳时，尝试在全片 tokens 中检索该文本以获得真实源时间
        let matchedStartMs: number | null = null;
        let matchedEndMs: number | null = null;
        let matchedSpeakerId: string | null = null;

        for (const block of state.blocks) {
          const activeTokens = block.tokens.filter((t) => !t.deleted && t.type === 'word');
          const blockText = activeTokens.map((t) => t.text).join('');
          const foundIdx = blockText.indexOf(cleanText);
          if (foundIdx !== -1) {
            let curChar = 0;
            const chosenTokens: TranscriptToken[] = [];
            for (const t of activeTokens) {
              const tStart = curChar;
              curChar += t.text.length;
              const tEnd = curChar;
              if (tEnd > foundIdx && tStart < foundIdx + cleanText.length) {
                chosenTokens.push(t);
              }
            }
            if (chosenTokens.length > 0) {
              matchedStartMs = Math.min(...chosenTokens.map((t) => t.sourceStartMs));
              matchedEndMs = Math.max(...chosenTokens.map((t) => t.sourceEndMs));
              matchedSpeakerId = block.speakerId;
              break;
            }
          }
        }

        if (matchedStartMs !== null && matchedEndMs !== null) {
          startMs = matchedStartMs;
          endMs = matchedEndMs;
          if (!spId && matchedSpeakerId) spId = matchedSpeakerId;
        } else {
          startMs = Math.round(playheadRef.current * 1000);
          endMs = startMs + Math.max(500, Math.round((cleanText.length / 4.5) * 1000));
        }
      }

      if (!spId) {
        spId = state.tracks[0]?.id || 'sp_1';
      }
      const sp = state.tracks.find((tr) => tr.id === spId);
      const realDurSec = Math.max(0.1, Number(((endMs - startMs) / 1000).toFixed(2)));

      mutateProject((prev) => ({
        ...prev,
        coldOpenEnabled: true,
        highlights: [
          ...prev.highlights,
          {
            id: `hl_manual_${Date.now()}`,
            speakerId: spId!,
            speakerName: sp?.name ?? '发言人',
            text: cleanText,
            sourceStartMs: startMs,
            sourceEndMs: endMs,
            durationSec: realDurSec,
            selectionSource: 'manual_pick',
          },
        ],
      }));
      notify('✨ 已将所选文字加入左侧「高光片头与金句」（正文原处完整保留）');
      return;
    }

    // 2. 从多选选区 (selectedIds) 加入金句
    if (selectedIds.size === 0) {
      notify('请先在文稿中选中精彩文字再加入金句！');
      return;
    }
    const chosen: Array<{
      speakerId: string;
      text: string;
      startMs: number;
      endMs: number;
      dur: number;
    }> = [];
    state.blocks.forEach((b) =>
      b.tokens.forEach((t) => {
        if (selectedIds.has(t.id) && !t.deleted) {
          chosen.push({
            speakerId: b.speakerId,
            text: t.bleeped ? '[哔——]' : t.type === 'silence' ? '' : t.text,
            startMs: t.sourceStartMs,
            endMs: t.sourceEndMs,
            dur: t.durationSec,
          });
        }
      })
    );
    if (chosen.length === 0) return;

    // 按时间顺序对 chosen 进行排序
    chosen.sort((a, b) => a.startMs - b.startMs);

    const minStartMs = chosen[0].startMs;
    const maxEndMs = chosen[chosen.length - 1].endMs;
    const realDurSec = Math.max(0.1, Number(((maxEndMs - minStartMs) / 1000).toFixed(2)));
    const sp = state.tracks.find((tr) => tr.id === chosen[0].speakerId);
    const quoteText = joinHighlightTokenTexts(chosen.map((c) => c.text)) || '精选片段';

    mutateProject((prev) => ({
      ...prev,
      coldOpenEnabled: true,
      highlights: [
        ...prev.highlights,
        {
          id: `hl_manual_${Date.now()}`,
          speakerId: chosen[0].speakerId,
          speakerName: sp?.name ?? '发言人',
          text: quoteText,
          sourceStartMs: minStartMs,
          sourceEndMs: maxEndMs,
          durationSec: realDurSec,
          selectionSource: 'manual_pick',
        },
      ],
    }));
    setSelectedIds(new Set());
    notify('✨ 已将所选文字加入左侧「高光片头与金句」（正文原处完整保留）');
  };

  const handleAcceptAllAiCorrections = () => {
    let fixedCount = 0;
    mutateProject(
      (prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) => ({
          ...b,
          tokens: b.tokens.map((t) => {
            if (!t.deleted && t.aiSuggestedText && t.text !== t.aiSuggestedText) {
              fixedCount++;
              return { ...t, text: t.aiSuggestedText, correctedStatus: 'ai_applied' };
            }
            return t;
          }),
        })),
      }),
      true
    );
    notify(`✨ 已一键自动纠正 ${fixedCount} 处疑似错别字，原声时长毫发无损！`);
  };

  const handleApplyManualCorrection = (
    tokenId: string,
    newText: string,
    saveToGlossary: boolean
  ) => {
    let oldWord = '';
    state.blocks.forEach((b) =>
      b.tokens.forEach((t) => {
        if (t.id === tokenId) oldWord = t.text;
      })
    );

    mutateProject(
      (prev) => {
        const canBatchReplace =
          saveToGlossary &&
          oldWord &&
          !oldWord.startsWith('[语音 ') &&
          !oldWord.startsWith('[音轨片段');

        const nextBlocks = prev.blocks.map((b) => ({
          ...b,
          tokens: b.tokens.map((t) => {
            if (t.id === tokenId || (canBatchReplace && t.text === oldWord)) {
              return { ...t, text: newText, correctedStatus: 'manual' as const };
            }
            return t;
          }),
        }));

        const cleanGlossaryWord = newText.replace(/[，。？！、,.?!]/g, '').trim();
        const exists = prev.glossary.some((g) => g.word === cleanGlossaryWord);
        const nextGlossary =
          saveToGlossary && cleanGlossaryWord && !exists
            ? [
                { id: `g_${Date.now()}`, word: cleanGlossaryWord, type: 'hotword' as const },
                ...prev.glossary,
              ]
            : prev.glossary;

        return { ...prev, blocks: nextBlocks, glossary: nextGlossary };
      },
      true
    );

    notify(`✏️ 已无损改字「${oldWord} → ${newText}」，底层音频切片时长不变`);
  };

  const handleCleanSpeakerFillers = (speakerId: string) => {
    let removed = 0;
    let protectedCount = 0;
    const nextState: PodcastProjectState = {
      ...state,
      blocks: state.blocks.map((b) => {
        if (speakerId !== 'all' && b.speakerId !== speakerId) return b;
        return {
          ...b,
          tokens: b.tokens.map((t) => {
            if (t.fillerTag === 'pure' && !t.deleted) {
              // 尊重坚叔偏好：自动保护独立捧场词“嗯/对/啊”
              if (isProtectedAffirmation(t.text, b.tokens.length)) {
                protectedCount++;
                return t;
              }
              removed++;
              return { ...t, deleted: true, cutByWaveform: true };
            }
            return t;
          }),
        };
      }),
    };
    if (removed > 0) {
      applyRemappedPlayhead(nextState);
      mutateProject(() => nextState, true);
    }
    const targetName =
      speakerId === 'all'
        ? '全员'
        : state.tracks.find((x) => x.id === speakerId)?.name ?? '该发言人';
    notify(
      removed > 0
        ? `🧹 已按偏好精简${targetName}的 ${removed} 处卡壳口癖 (自动保留 ${protectedCount} 处自然附和捧场词)`
        : `${targetName}当前无待清理卡壳口癖 (已保护 ${protectedCount} 处自然附和)`
    );
  };

  const [smartCutModalOutcome, setSmartCutModalOutcome] = useState<PreferenceSmartCutOutcome | null>(null);
  const [auditioningCutItemId, setAuditioningCutItemId] = useState<string | null>(null);
  const auditioningCutItemIdRef = useRef<string | null>(null);
  auditioningCutItemIdRef.current = auditioningCutItemId;
  const cutAuditionTimerRef = useRef<number | null>(null);

  const handleStopCutAudition = useCallback(() => {
    const wasAuditioning =
      cutAuditionTimerRef.current !== null || auditioningCutItemIdRef.current !== null;
    if (cutAuditionTimerRef.current !== null) {
      window.clearTimeout(cutAuditionTimerRef.current);
      cutAuditionTimerRef.current = null;
    }
    setAuditioningCutItemId(null);
    if (wasAuditioning && isPlayingRef.current) {
      isPlayingRef.current = false;
      audioPreview.pauseMultiTrackPlayback();
      setIsPlaying(false);
    }
  }, []);

  const handleAuditionCutPoint = useCallback(
    (item: SmartCutActionItem) => {
      // 若当前正在收听同一项，再次点击则停止
      if (auditioningCutItemId === item.id && isPlayingRef.current) {
        handleStopCutAudition();
        return;
      }

      if (cutAuditionTimerRef.current !== null) {
        window.clearTimeout(cutAuditionTimerRef.current);
        cutAuditionTimerRef.current = null;
      }

      // 剪辑点前留 0.8s 预听上下文
      const prerollSec = Math.max(0, Number((item.timeSec - 0.8).toFixed(3)));
      // 试听时长：前置 0.8s + 剪辑点自身时长 + 后续上下文 1.5s（至少 2.8s，至多 6.0s）
      const listenDurationSec = Math.min(
        6.0,
        Math.max(2.8, 0.8 + (item.durationSec || 0.4) + 1.5)
      );

      playheadRef.current = prerollSec;
      setPlayheadSec(prerollSec);
      audioPreview.requestSeek();

      const resolved = resolveEditedPlayheadToSource(
        stateRef.current,
        timelineRef.current,
        prerollSec
      );
      setActiveBlockId(resolved.activeBlockId);
      setActiveTokenId(resolved.activeTokenId);

      audioPreview.startFromUserGesture(
        stateRef.current,
        timelineRef.current,
        prerollSec,
        notify
      );
      setIsPlaying(true);
      setAuditioningCutItemId(item.id);

      // 到达预听时长后自动暂停并重置试听状态
      cutAuditionTimerRef.current = window.setTimeout(() => {
        audioPreview.pauseMultiTrackPlayback();
        setIsPlaying(false);
        setAuditioningCutItemId(null);
        cutAuditionTimerRef.current = null;
      }, Math.round(listenDurationSec * 1000));
    },
    [auditioningCutItemId, handleStopCutAudition, notify]
  );

  const handleCancelPreferenceSmartCut = useCallback(() => {
    handleStopCutAudition();
    setSmartCutModalOutcome(null);
  }, [handleStopCutAudition]);

  const handleApplyPreferenceSmartCutAction = () => {
    const outcome = applyPreferenceSmartCut(state);
    if (
      outcome.hesitationsCut === 0 &&
      outcome.stuttersCut === 0 &&
      outcome.pausesTightened === 0 &&
      outcome.surgicalMutesAdded === 0
    ) {
      notify('✨ 当前对谈节奏已处于自然微创最佳状态，无需精剪');
      return;
    }
    // 打开精剪确认弹窗，展示剪辑明细
    setSmartCutModalOutcome(outcome);
  };

  const handleConfirmPreferenceSmartCut = () => {
    if (!smartCutModalOutcome) return;
    handleStopCutAudition();
    const outcome = smartCutModalOutcome;
    setSmartCutModalOutcome(null);

    applyRemappedPlayhead(outcome.nextState);
    mutateProject(() => outcome.nextState, true);

    const hintsStr =
      outcome.headTailHints.length > 0
        ? ` · 发现 ${outcome.headTailHints.map((h) => `${h.label}(${h.range})`).join('、')}`
        : '';
    notify(
      `✨ 已执行偏好风格精剪 (-${outcome.savedSec.toFixed(1)}s)：卡壳 -${outcome.hesitationsCut} · 口吃重说 -${outcome.stuttersCut} · 紧凑停顿 -${outcome.pausesTightened} · 单轨消音 +${outcome.surgicalMutesAdded} (保护捧场词 ${outcome.protectedBackchannels} 处)${hintsStr}`
    );
  };

  const handleCompressSpeakerSilence = (speakerId: string) => {
    let saved = 0;
    const profiles = buildAcousticProfileMap(state.tracks);
    const nextState: PodcastProjectState = {
      ...state,
      blocks: state.blocks.map((b) => {
        if (speakerId !== 'all' && b.speakerId !== speakerId) return b;
        return {
          ...b,
          tokens: b.tokens.map((t) => {
            if (
              t.type === 'silence' &&
              !t.deleted &&
              t.durationSec > 0.45 &&
              !hasAudibleVoiceInInterval(
                state.tracks,
                profiles,
                t.sourceStartMs,
                t.sourceEndMs,
                state.recordingMode
              )
            ) {
              saved += t.durationSec - 0.45;
              return { ...t, durationSec: 0.45 };
            }
            return t;
          }),
        };
      }),
    };
    if (saved > 0) {
      applyRemappedPlayhead(nextState);
      mutateProject(() => nextState, true);
    }
    notify(`⏩ 已按真实声学静音收紧停顿空白，共精简 ${saved.toFixed(1)}s`);
  };

  const handleCycleDeClick = () => {
    if (!state.deClickEnabled) {
      mutateProject((p) => {
        const scanned = scanAndCleanMouthClicks(p, 'all');
        // Top-bar toggle marks pause mouth-clicks non-destructively (keeps all word tokens intact)
        const nextBlocks = p.blocks.map((b, bi) => ({
          ...b,
          tokens: b.tokens.map((t, ti) => {
            const cand = scanned.nextBlocks[bi]?.tokens[ti];
            return t.type === 'silence' && cand?.mouthClickCleaned
              ? { ...t, trackMuted: true, mouthClickCleaned: true }
              : t;
          }),
        }));
        return { ...p, deClickEnabled: true, deClickStrength: 'medium', blocks: nextBlocks };
      });
      notify('💧 已开启「去口水音：标准」—— 自动静音停顿唇齿咂嘴声，并在导出 MP3 时启用瞬态去口水音');
    } else if (state.deClickStrength !== 'strong') {
      mutateProject((p) => ({ ...p, deClickEnabled: true, deClickStrength: 'strong' }));
      notify('💧 已切换为「去口水音：强力」—— 导出 MP3 时深度消除高频粘连口水音与呼吸咂嘴声');
    } else {
      mutateProject((p) => ({ ...p, deClickEnabled: false }));
      notify('已关闭实时气口去口水音与导出 DSP 滤波');
    }
  };

  const handleCleanMouthClicks = (speakerId = 'all') => {
    const res = scanAndCleanMouthClicks(state, speakerId);
    if (res.deletedMouthTokens > 0) {
      audioPreview.requestSeek();
    }
    mutateProject(
      (prev) => ({
        ...prev,
        deClickEnabled: true,
        blocks: res.nextBlocks,
      }),
      res.totalCleanedCount > 0
    );

    if (res.totalCleanedCount > 0) {
      notify(
        `💧 去口水音完成：已开启实时/导出瞬态修复滤波，并清理 ${res.totalCleanedCount} 处气口咂嘴与口水音片段（按 ⌘Z 可撤销）`
      );
    } else {
      notify('💧 已启用实时审听与导出 MP3 自回归去口水音滤波（当前停顿气口已处于干净状态）');
    }
  };

  const handleCancelDuckingForRange = (
    startSec: number,
    endSec: number,
    targetSpeakerId?: string
  ) => {
    const selStart = Math.min(startSec, endSec);
    const selEnd = Math.max(startSec, endSec);

    const matchedOverlaps = timeline.overlapRegions.filter(
      (ov) => ov.editedEndSec > selStart + 0.01 && ov.editedStartSec < selEnd - 0.01
    );

    const overlappingTokens = timeline.mappedTokens.filter(
      (m) =>
        !m.token.deleted &&
        m.editedEndSec > selStart + 0.01 &&
        m.editedStartSec < selEnd - 0.01
    );
    const overlappingBlockIds = new Set(
      overlappingTokens.map((m) => m.blockId).filter(Boolean)
    );

    const relevantBlocks = state.blocks.filter(
      (b) =>
        overlappingBlockIds.has(b.blockId) ||
        matchedOverlaps.some((ov) => ov.blockId === b.blockId)
    );

    if (relevantBlocks.length === 0 && matchedOverlaps.length === 0) {
      notify('选区内未发现语音内容或可避让音轨');
      return;
    }

    const allAreFull =
      relevantBlocks.length > 0 &&
      relevantBlocks.every((b) => Boolean(b.overlapNote?.keepFullVolume));

    const nextKeepFull = !allAreFull;

    mutateProject(
      (prev) => {
        const nextBlocks = prev.blocks.map((b) => {
          const matchedOv = matchedOverlaps.find((ov) => ov.blockId === b.blockId);
          const isOverlappingBlock = overlappingBlockIds.has(b.blockId);

          if (!matchedOv && !isOverlappingBlock) {
            return b;
          }

          if (b.overlapNote) {
            return {
              ...b,
              overlapNote: {
                ...b.overlapNote,
                keepFullVolume: nextKeepFull,
                muted: nextKeepFull ? false : b.overlapNote.muted,
              },
            };
          }

          if (matchedOv) {
            return {
              ...b,
              overlapNote: {
                id: `ov_${b.blockId}`,
                speakerId: matchedOv.secondarySpeakerId,
                speakerName: matchedOv.secondarySpeakerName,
                text: matchedOv.text || '[语音重合副轨]',
                sourceStartMs: matchedOv.sourceStartMs,
                sourceEndMs: matchedOv.sourceEndMs,
                muted: false,
                keepFullVolume: nextKeepFull,
              },
            };
          }

          const otherTrack =
            (targetSpeakerId && targetSpeakerId !== b.speakerId
              ? prev.tracks.find((t) => t.id === targetSpeakerId)
              : null) ??
            prev.tracks.find((t) => t.id !== b.speakerId && !t.isRef) ??
            prev.tracks[0];

          if (!otherTrack || otherTrack.id === b.speakerId) {
            return b;
          }

          const bTokens = timeline.mappedTokens.filter(
            (m) =>
              m.blockId === b.blockId &&
              !m.token.deleted &&
              m.editedEndSec > selStart + 0.01 &&
              m.editedStartSec < selEnd - 0.01
          );
          const sStart =
            bTokens.length > 0
              ? bTokens[0].token.sourceStartMs
              : Math.round(selStart * 1000);
          const sEnd =
            bTokens.length > 0
              ? bTokens[bTokens.length - 1].token.sourceEndMs
              : Math.round(selEnd * 1000);

          return {
            ...b,
            overlapNote: {
              id: `ov_${b.blockId}`,
              speakerId: otherTrack.id,
              speakerName: otherTrack.name,
              text: '[语音重合副轨]',
              sourceStartMs: sStart,
              sourceEndMs: sEnd,
              muted: false,
              keepFullVolume: nextKeepFull,
            },
          };
        });

        return { ...prev, blocks: nextBlocks };
      },
      true
    );

    notify(
      nextKeepFull
        ? '🔊 已取消选区主发言避让，副轨将保持全音量原声播放（按 ⌘Z 可撤销）'
        : '🔉 已恢复选区主发言避让（自动降音）（按 ⌘Z 可撤销）'
    );
  };

  const handleCancelDuckingSelected = () => {
    if (selectedIds.size === 0) {
      notify('请先在文稿中选中需要取消主发言避让的字句！');
      return;
    }
    const selectedMapped = timeline.mappedTokens.filter(
      (m) => !m.token.deleted && selectedIds.has(m.tokenId)
    );
    if (selectedMapped.length === 0) {
      notify('未找到有效的选中文字区间');
      return;
    }
    const minStartSec = Math.min(...selectedMapped.map((m) => m.editedStartSec));
    const maxEndSec = Math.max(...selectedMapped.map((m) => m.editedEndSec));
    handleCancelDuckingForRange(minStartSec, maxEndSec);
  };

  const handleWaveformCutAction = (
    startSec: number,
    endSec: number,
    action: 'ripple_all' | 'mute_lane' | 'bleep_range' | 'add_highlight' | 'cancel_ducking',
    targetSpeakerId?: string
  ) => {
    if (action === 'cancel_ducking') {
      handleCancelDuckingForRange(startSec, endSec, targetSpeakerId);
      return;
    }
    if (action === 'add_highlight') {
      const selStart = Math.min(startSec, endSec);
      const selEnd = Math.max(startSec, endSec);
      const overlappingWords = timeline.mappedTokens.filter(
        (m) =>
          !m.token.deleted &&
          m.token.type === 'word' &&
          m.editedEndSec > selStart + 0.01 &&
          m.editedStartSec < selEnd - 0.01
      );
      const speakerScopedWords = targetSpeakerId
        ? overlappingWords.filter((m) => m.speakerId === targetSpeakerId)
        : [];
      const chosenWords =
        speakerScopedWords.length > 0 ? speakerScopedWords : overlappingWords;

      // 按时间顺序对选中的词排序
      chosenWords.sort((a, b) => a.token.sourceStartMs - b.token.sourceStartMs);

      const fallbackSpId =
        chosenWords[0]?.speakerId ??
        targetSpeakerId ??
        state.tracks.find((t) => !t.isRef)?.id ??
        'speaker_1';
      const sp = state.tracks.find((t) => t.id === fallbackSpId);
      const extractedText = joinHighlightTokenTexts(
        chosenWords.map((m) => (m.token.bleeped ? '[哔——]' : m.token.text))
      );
      const sourceStartMs =
        chosenWords.length > 0
          ? chosenWords[0].token.sourceStartMs
          : Math.round(selStart * 1000);
      const sourceEndMs =
        chosenWords.length > 0
          ? chosenWords[chosenWords.length - 1].token.sourceEndMs
          : Math.round(selEnd * 1000);

      const realDurSec = Math.max(0.1, Number(((sourceEndMs - sourceStartMs) / 1000).toFixed(2)));

      mutateProject((prev) => ({
        ...prev,
        coldOpenEnabled: true,
        highlights: [
          ...prev.highlights,
          {
            id: `hl_wave_${Date.now()}`,
            speakerId: fallbackSpId,
            speakerName: sp?.name ?? '波形选区',
            text:
              extractedText ||
              `波形框选片段 (${selStart.toFixed(1)}s - ${selEnd.toFixed(1)}s)`,
            sourceStartMs,
            sourceEndMs,
            durationSec: realDurSec,
            selectionSource: 'waveform_pick',
          },
        ],
      }));
      notify('✨ 已将框选片段加入左侧「高光片头与金句」');
      return;
    }

    if (action === 'mute_lane') {
      const resolvedTrackId =
        targetSpeakerId ?? state.tracks.find((t) => !t.isRef)?.id ?? state.tracks[0]?.id;
      if (!resolvedTrackId) {
        notify('未找到可静音的目标音轨');
        return;
      }
      const muteOutcome = applyTrackMuteSelectionToProject(
        state,
        startSec,
        endSec,
        resolvedTrackId
      );
      if (muteOutcome.addedRanges.length === 0) {
        notify('当前选区过短或未落在有效音轨时长内，未执行静音');
        return;
      }
      mutateProject(
        (prev) => ({
          ...prev,
          blocks: muteOutcome.nextState.blocks,
          trackMuteRanges: muteOutcome.nextState.trackMuteRanges,
        }),
        true
      );
      const trackName =
        state.tracks.find((t) => t.id === resolvedTrackId)?.name ?? '当前悬停轨';
      notify(
        `🔇 已静音【${trackName}】选区 (${muteOutcome.mutedDurationSec.toFixed(2)}s)，多轨总时长保持不变（按 ⌘Z 可撤销）`
      );
      return;
    }

    const selectionMode = state.waveformSelectionMode ?? 'snap';
    const outcome = applyWaveformSelectionToBlocks(
      state,
      startSec,
      endSec,
      action,
      targetSpeakerId,
      { mode: selectionMode }
    );
    if (action === 'bleep_range') {
      audioPreview.playBleepTone();
      mutateProject((prev) => ({ ...prev, blocks: outcome.nextBlocks }), true);
      notify('🚨 已将波形选区替换为 1kHz「哔——」消音脱敏');
      return;
    }

    const prevTotalSec = timeline.totalEditedDurationSec;
    const nextState: PodcastProjectState = { ...state, blocks: outcome.nextBlocks };
    const nextTimeline = computeEditedTimeline(nextState);
    const nextTotalSec = nextTimeline.totalEditedDurationSec;
    const removedSec = Math.max(0, Number((prevTotalSec - nextTotalSec).toFixed(3)));

    const wasPlaying = isPlayingRef.current;
    mutateProject(() => nextState, true);
    playFromCutSeamPreroll(nextState, nextTimeline, startSec);
    const shouldPrerollPlay = wasPlaying
      ? (nextState.cutPrerollEnabled ?? true)
      : (nextState.pauseCutJumpEnabled ?? true);
    const backSec = nextState.cutPrerollSec ?? 3;
    notify(
      shouldPrerollPlay
        ? `✂️ 已删除全轨选区并自动从 ${backSec}s 前播放审听 (-${removedSec.toFixed(2)}s · 整段 ${outcome.fullDeletedCount} 项 / 边界与间隙 ${outcome.subwordTrimmedCount} 项)`
        : `✂️ 已删除全轨选区并后续吸附 (-${removedSec.toFixed(2)}s · 整段 ${outcome.fullDeletedCount} 项 / 边界与间隙 ${outcome.subwordTrimmedCount} 项)`
    );
  };

  const handleAiAutoFillHighlights = async () => {
    if (state.blocks.length === 0) {
      notify('请先导入音频轨道后再挑选高光片段');
      return;
    }

    // Try Python sidecar analyzer first; otherwise score actual blocks locally
    try {
      const res = await runPythonSidecarAnalysis(state);
      const recommended = res?.recommendedHighlights as
        | Array<{
            speakerId: string;
            speakerName: string;
            text: string;
            sourceStartMs: number;
            sourceEndMs: number;
            durationSec: number;
          }>
        | undefined;
      if (recommended && recommended.length > 0) {
        mutateProject((prev) => {
          const next = [...prev.highlights];
          let sum = next.reduce((a, c) => a + c.durationSec, 0);
          for (const c of recommended) {
            if (
              sum + c.durationSec <= prev.targetTotalHighlightSec + 2 &&
              !next.some((h) => h.sourceStartMs === c.sourceStartMs)
            ) {
              next.push({
                ...c,
                id: `hl_ai_${Math.random().toString(36).slice(2, 7)}`,
                selectionSource: 'ai_auto',
              });
              sum += c.durationSec;
            }
          }
          return { ...prev, coldOpenEnabled: next.length > 0, highlights: next };
        });
        notify(
          `🤖 已从当前工程自动挑选符合 [${state.minClipSec}s–${state.maxClipSec}s] 约束的高光片段`
        );
        return;
      }
    } catch {
      // Fall through to deterministic local block scoring
    }

    const spMap = Object.fromEntries(state.tracks.map((t) => [t.id, t]));
    const localCandidates = state.blocks
      .map((b) => {
        const keptWords = b.tokens.filter((t) => !t.deleted && t.type === 'word');
        if (keptWords.length === 0) return null;
        const rawDur = keptWords.reduce((a, t) => a + t.durationSec, 0);
        if (rawDur < 1.5) return null;
        const startMs = keptWords[0].sourceStartMs;
        const clippedDur = Math.min(
          state.maxClipSec,
          Math.max(state.minClipSec, Number(rawDur.toFixed(1)))
        );
        const txt = keptWords.map((t) => (t.bleeped ? '[哔——]' : t.text)).join('');
        return {
          speakerId: b.speakerId,
          speakerName: spMap[b.speakerId]?.name ?? '发言人',
          text: txt.slice(0, 80),
          sourceStartMs: startMs,
          sourceEndMs: startMs + Math.round(clippedDur * 1000),
          durationSec: clippedDur,
        };
      })
      .filter(Boolean) as Array<{
      speakerId: string;
      speakerName: string;
      text: string;
      sourceStartMs: number;
      sourceEndMs: number;
      durationSec: number;
    }>;

    if (localCandidates.length === 0) {
      notify('当前工程有效语音时长较短，暂无可自动提取的高光候选');
      return;
    }

    mutateProject((prev) => {
      const next = [...prev.highlights];
      let sum = next.reduce((a, c) => a + c.durationSec, 0);
      for (const c of localCandidates) {
        if (
          sum + c.durationSec <= prev.targetTotalHighlightSec + 2 &&
          !next.some((h) => h.sourceStartMs === c.sourceStartMs)
        ) {
          next.push({
            ...c,
            id: `hl_ai_${Math.random().toString(36).slice(2, 7)}`,
            selectionSource: 'ai_auto',
          });
          sum += c.durationSec;
        }
      }
      return { ...prev, coldOpenEnabled: next.length > 0, highlights: next };
    });
    notify(`🤖 已按 [${state.minClipSec}s–${state.maxClipSec}s] 约束挑选高光片段`);
  };

  const handleExportMasterAudio = async (format: 'mp3' | 'wav' = 'mp3') => {
    try {
      setLoadingProgress({
        active: true,
        title: `正在合并音轨并二次标准化成片 (-16.0 LUFS)`,
        stage: 'export_init',
        percent: 15,
        message: isTauriRuntime()
          ? `请选择 ${format.toUpperCase()} 保存位置...`
          : `正在多轨合并合成、应用防串音门限并执行二次音量标准化 (-16.0 LUFS)...`,
      });
      const out = await exportMasteredPodcastAudio(state, format);
      notify(`🎧 ${format.toUpperCase()} 成片已完成多轨合并与二次音量标准化 (-16.0 LUFS): ${out}`);
    } catch (err) {
      const msg = String(err);
      if (!msg.includes('取消')) {
        notify(`导出失败: ${msg}`);
      }
    } finally {
      setLoadingProgress((p) => ({ ...p, active: false }));
    }
  };

  const measureAudioDurationSec = (url: string): Promise<number | undefined> =>
    new Promise((resolve) => {
      try {
        const el = new Audio();
        let settled = false;
        const finish = (val?: number) => {
          if (settled) return;
          settled = true;
          el.removeAttribute('src');
          resolve(val && Number.isFinite(val) && val > 0 ? Number(val.toFixed(1)) : undefined);
        };
        const timer = window.setTimeout(() => finish(undefined), 2500);
        el.preload = 'metadata';
        el.onloadedmetadata = () => {
          window.clearTimeout(timer);
          finish(el.duration);
        };
        el.onerror = () => {
          window.clearTimeout(timer);
          finish(undefined);
        };
        el.src = url;
      } catch {
        resolve(undefined);
      }
    });

  const getAuxSlotLabel = (slot: AuxAudioSlot): string =>
    slot === 'intro_vo' ? '片头固定口播' : slot === 'intro' ? '片头 BGM' : '片尾 BGM';

  const handleImportBgm = async (slot: AuxAudioSlot) => {
    const slotLabel = getAuxSlotLabel(slot);
    if (isTauriRuntime()) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const chosen = await open({
          title: `选择${slotLabel}音频文件`,
          multiple: false,
          filters: [
            {
              name: '音频文件',
              extensions: ['wav', 'mp3', 'm4a', 'flac', 'aac', 'ogg'],
            },
          ],
        });
        if (!chosen || Array.isArray(chosen)) return;
        await ensureNativeAudioServerPort();
        const fileName = chosen.split(/[/\\]/).pop() || chosen;
        const audioUrl = buildPodAudioUrl(chosen, true);
        const durationSec = audioUrl ? await measureAudioDurationSec(audioUrl) : undefined;
        const asset: BgmTrackAsset = {
          fileName,
          filePath: chosen,
          audioUrl,
          durationSec,
          enabled: true,
        };
        mutateProject((prev) => ({
          ...prev,
          ...(slot === 'intro_vo'
            ? { introVoiceover: asset }
            : slot === 'intro'
            ? { introBgm: asset, bgmWavPath: chosen }
            : { outroBgm: asset }),
        }));
        notify(`${slot === 'intro_vo' ? '🎙️' : '🎵'} 已导入${slotLabel}：${fileName}`);
      } catch (err) {
        notify(`导入${slotLabel}失败: ${String(err)}`);
      }
    } else {
      bgmImportToLibraryRef.current = false;
      bgmImportSlotRef.current = slot;
      browserBgmInputRef.current?.click();
    }
  };

  const handleBrowserBgmFileSelected = async (file: File) => {
    const slot = bgmImportSlotRef.current;
    const toLibraryOnly = bgmImportToLibraryRef.current;
    bgmImportToLibraryRef.current = false;
    const slotLabel = getAuxSlotLabel(slot);
    const blobUrl = URL.createObjectURL(file);
    const durationSec = await measureAudioDurationSec(blobUrl);

    let uploadedPath: string | undefined;
    try {
      const paths = await uploadBrowserAudioFilesForAsr([file]);
      if (paths && paths.length > 0) {
        uploadedPath = paths[0];
      }
    } catch {
      // Optional server upload for FFmpeg export when running in browser dev mode
    }

    if (toLibraryOnly) {
      setGlobalAuxItems((prev) =>
        addGlobalAuxItem(
          {
            slot,
            name: file.name,
            fileName: file.name,
            filePath: uploadedPath,
            durationSec,
          },
          prev
        )
      );
      notify(`📚 已添加到全局${slotLabel}库：${file.name}`);
      return;
    }

    const asset: BgmTrackAsset = {
      fileName: file.name,
      filePath: uploadedPath,
      audioUrl: blobUrl,
      durationSec,
      enabled: true,
    };

    mutateProject((prev) => ({
      ...prev,
      ...(slot === 'intro_vo'
        ? { introVoiceover: asset }
        : slot === 'intro'
        ? { introBgm: asset, bgmWavPath: uploadedPath ?? prev.bgmWavPath }
        : { outroBgm: asset }),
    }));
    notify(`${slot === 'intro_vo' ? '🎙️' : '🎵'} 已导入${slotLabel}：${file.name}`);
  };

  const handleToggleBgmEnabled = (slot: AuxAudioSlot) => {
    mutateProject((prev) => {
      if (slot === 'intro_vo' && prev.introVoiceover) {
        return {
          ...prev,
          introVoiceover: { ...prev.introVoiceover, enabled: !prev.introVoiceover.enabled },
        };
      }
      if (slot === 'intro' && prev.introBgm) {
        const nextEnabled = !prev.introBgm.enabled;
        return {
          ...prev,
          introBgm: { ...prev.introBgm, enabled: nextEnabled },
        };
      }
      if (slot === 'outro' && prev.outroBgm) {
        const nextEnabled = !prev.outroBgm.enabled;
        return {
          ...prev,
          outroBgm: { ...prev.outroBgm, enabled: nextEnabled },
        };
      }
      return prev;
    });
  };

  const handleRemoveBgm = (slot: AuxAudioSlot) => {
    const slotLabel = getAuxSlotLabel(slot);
    mutateProject((prev) => ({
      ...prev,
      ...(slot === 'intro_vo'
        ? { introVoiceover: null }
        : slot === 'intro'
        ? { introBgm: null, bgmWavPath: undefined }
        : { outroBgm: null }),
    }));
    notify(`🗑️ 已移除${slotLabel}`);
  };

  const handleUpdateBgmAsset = useLatestCallback(
    (slot: AuxAudioSlot, patch: Partial<BgmTrackAsset>) => {
      mutateProject((prev) => {
        if (slot === 'intro') {
          const cur = prev.introBgm ?? { fileName: '片头 BGM', enabled: true };
          return {
            ...prev,
            introBgm: { ...cur, ...patch },
          };
        }
        if (slot === 'outro') {
          const cur = prev.outroBgm ?? { fileName: '片尾 BGM', enabled: true };
          return {
            ...prev,
            outroBgm: { ...cur, ...patch },
          };
        }
        if (slot === 'intro_vo') {
          const cur = prev.introVoiceover ?? { fileName: '片头固定口播', enabled: true };
          return {
            ...prev,
            introVoiceover: { ...cur, ...patch },
          };
        }
        return prev;
      });
    }
  );

  const handleAddFileToGlobalLibrary = async (slot: AuxAudioSlot) => {
    const slotLabel = getAuxSlotLabel(slot);
    if (isTauriRuntime()) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const chosen = await open({
          title: `添加${slotLabel}到全局库`,
          multiple: false,
          filters: [
            {
              name: '音频文件',
              extensions: ['wav', 'mp3', 'm4a', 'flac', 'aac', 'ogg'],
            },
          ],
        });
        if (!chosen || Array.isArray(chosen)) return;
        await ensureNativeAudioServerPort();
        const fileName = chosen.split(/[/\\]/).pop() || chosen;
        const audioUrl = buildPodAudioUrl(chosen, true);
        const durationSec = audioUrl ? await measureAudioDurationSec(audioUrl) : undefined;
        setGlobalAuxItems((prev) =>
          addGlobalAuxItem(
            {
              slot,
              name: fileName,
              fileName,
              filePath: chosen,
              durationSec,
            },
            prev
          )
        );
        notify(`📚 已添加到全局${slotLabel}库：${fileName}`);
      } catch (err) {
        notify(`添加${slotLabel}到全局库失败: ${String(err)}`);
      }
    } else {
      bgmImportToLibraryRef.current = true;
      bgmImportSlotRef.current = slot;
      browserBgmInputRef.current?.click();
    }
  };

  const handleSaveSlotToGlobalLibrary = (slot: AuxAudioSlot) => {
    const asset =
      slot === 'intro_vo'
        ? state.introVoiceover
        : slot === 'intro'
        ? state.introBgm
        : state.outroBgm;
    if (!asset) return;
    const slotLabel = getAuxSlotLabel(slot);
    setGlobalAuxItems((prev) =>
      addGlobalAuxItem(
        {
          slot,
          name: asset.fileName,
          fileName: asset.fileName,
          filePath: asset.filePath,
          durationSec: asset.durationSec,
        },
        prev
      )
    );
    notify(`📚 已将「${asset.fileName}」保存到全局${slotLabel}库`);
  };

  const handleApplyGlobalAuxPreset = async (item: GlobalAuxPresetItem) => {
    if (isTauriRuntime() && item.filePath) {
      await ensureNativeAudioServerPort();
    }
    const asset = toBgmTrackAsset(item);
    mutateProject((prev) => ({
      ...prev,
      ...(item.slot === 'intro_vo'
        ? { introVoiceover: asset }
        : item.slot === 'intro'
        ? { introBgm: asset, bgmWavPath: asset.filePath ?? prev.bgmWavPath }
        : { outroBgm: asset }),
    }));
    const slotLabel = getAuxSlotLabel(item.slot);
    notify(`✨ 已应用全局${slotLabel}：${item.name}`);
  };

  const handleToggleGlobalAuxDefault = (item: GlobalAuxPresetItem) => {
    const nextDefaultId = item.isDefault ? null : item.id;
    setGlobalAuxItems((prev) => setDefaultGlobalAuxItem(nextDefaultId, item.slot, prev));
    const slotLabel = getAuxSlotLabel(item.slot);
    notify(
      nextDefaultId
        ? `⭐ 已将「${item.name}」设为新建工程默认${slotLabel}`
        : `已取消「${item.name}」的默认${slotLabel}设置`
    );
  };

  const handleRemoveGlobalAuxItem = (item: GlobalAuxPresetItem) => {
    setGlobalAuxItems((prev) => removeGlobalAuxItem(item.id, prev));
    notify(`🗑️ 已从全局库移除：${item.name}`);
  };

  const handleSeekToHighlight = (hl: HighlightClip) => {
    const matched = timeline.mappedTokens.find(
      (m) => !m.token.deleted && m.token.sourceEndMs > hl.sourceStartMs
    );
    const targetSec = matched
      ? matched.editedStartSec
      : Math.min(
          Math.max(0, hl.sourceStartMs / 1000),
          Math.max(0, timeline.totalEditedDurationSec - 0.1)
        );
    seekToSec(targetSec);
    notify(`🎯 已定位到金句片段 @${formatMmSs(hl.sourceStartMs / 1000)}`);
  };

  const handleSeekAndPlay = useCallback(
    (targetSec: number) => {
      seekToSec(targetSec);
      if (stateRef.current.tracks.length === 0) {
        notify('⚠️ 当前工程尚未导入音频轨道，请先点击「导入音频」或打开已有工程');
        return;
      }
      if (timelineRef.current.totalEditedDurationSec <= 0.05) {
        notify('⚠️ 当前工程可播放时长不足，请先导入音频');
        return;
      }
      if (!isPlayingRef.current) {
        audioPreview.startFromUserGesture(stateRef.current, timelineRef.current, targetSec, notify);
        setIsPlaying(true);
      } else {
        audioPreview.syncMultiTrackPlayback(stateRef.current, timelineRef.current, targetSec, true);
      }
    },
    [seekToSec, notify]
  );

  const handleSaveHighlight = (updated: HighlightClip) => {
    mutateProject((prev) => ({
      ...prev,
      highlights: prev.highlights.map((h) => (h.id === updated.id ? updated : h)),
    }));
    notify(
      `💾 已保存金句修改 @${formatMmSs(updated.sourceStartMs / 1000)} (${updated.durationSec.toFixed(1)}s)`
    );
  };

  const handleCopyQuotes = () => {
    if (state.highlights.length === 0) return;
    const text = state.highlights
      .map(
        (hl, idx) =>
          `${idx + 1}. [${hl.speakerName} @${formatMmSs(hl.sourceStartMs / 1000)}] “${hl.text}”`
      )
      .join('\n');
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(text);
    }
    notify(`📋 已复制全部 ${state.highlights.length} 条金句`);
  };

  const handleRestoreAllEdits = () => {
    if (state.blocks.length === 0) return;
    audioPreview.requestSeek();
    mutateProject(
      (prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) => ({
          ...b,
          tokens: b.tokens.map((t) => ({
            ...t,
            deleted: false,
            trackMuted: false,
            bleeped: false,
            cutByWaveform: false,
            subwordTrimmed: false,
            durationSec: t.origDurationSec,
          })),
        })),
      }),
      true
    );
    setSelectedIds(new Set());
    notify('↺ 已恢复当前工程全部已切除、静音与消音片段');
  };

  // Permanently stable callbacks so memoized panels NEVER re-render during playheadSec ticks!
  const stableRenameProjectTitle = useLatestCallback((newTitle: string) =>
    mutateProject((p) => ({ ...p, projectTitle: newTitle }))
  );
  const stableNewEmptyProject = useLatestCallback(handleNewEmptyProject);
  const stableOpenProjectFile = useLatestCallback(() => void handleOpenProjectFile());
  const stableSaveProjectFile = useLatestCallback(
    (saveAs?: boolean) => void handleSaveProjectFile(Boolean(saveAs))
  );
  const stableToggleAutoSave = useLatestCallback(() => {
    setAutoSaveEnabled((prev) => {
      const next = !prev;
      notify(
        next
          ? `⏱️ 已开启定时自动保存（每 ${autoSaveIntervalSec} 秒）`
          : '⏸️ 已关闭定时自动保存'
      );
      return next;
    });
  });
  const stableChangeAutoSaveInterval = useLatestCallback((sec: number) => {
    setAutoSaveIntervalSec(sec);
    notify(`⏱️ 自动保存间隔已设置为 ${sec} 秒`);
  });
  const stableToggleRecordingMode = useLatestCallback(() =>
    mutateProject((p) => ({
      ...p,
      recordingMode:
        p.recordingMode === 'same_room_sync' ? 'multi_device_align' : 'same_room_sync',
    }))
  );
  const stableCycleAutoSolo = useLatestCallback(() =>
    mutateProject((p) => ({
      ...p,
      autoSoloMode:
        p.autoSoloMode === 'natural_ducking'
          ? 'hard_mute'
          : p.autoSoloMode === 'hard_mute'
          ? 'off'
          : 'natural_ducking',
    }))
  );
  const stableToggleLoudness = useLatestCallback(() =>
    mutateProject((p) => ({ ...p, loudnessAligned: !p.loudnessAligned }))
  );
  const stableCycleDeClick = useLatestCallback(handleCycleDeClick);
  const stableToggleStripSilence = useLatestCallback(() => {
    audioPreview.requestSeek();
    mutateProject((p) => {
      const nextFlag = !p.stripSilenceEnabled;
      const profiles = buildAcousticProfileMap(p.tracks);
      return {
        ...p,
        stripSilenceEnabled: nextFlag,
        blocks: p.blocks.map((b) => ({
          ...b,
          tokens: b.tokens.map((t) =>
            t.type === 'silence'
              ? {
                  ...t,
                  durationSec:
                    nextFlag &&
                    !hasAudibleVoiceInInterval(
                      p.tracks,
                      profiles,
                      t.sourceStartMs,
                      t.sourceEndMs,
                      p.recordingMode
                    )
                      ? Math.min(p.stripSilenceTargetSec, t.origDurationSec)
                      : t.origDurationSec,
                }
              : t
          ),
        })),
      };
    });
  });
  const stableTogglePlay = useLatestCallback(handleTogglePlay);
  const stableChangePlaybackRate = useLatestCallback(handleChangePlaybackRate);
  const stableOpenImportModal = useLatestCallback(() => setImportModalOpen(true));
  const stableQuickExportMp3 = useLatestCallback(() => void handleExportMasterAudio('mp3'));

  const stableToggleTrackSolo = useLatestCallback((trackId: string) =>
    mutateProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, solo: !t.solo } : t)),
    }))
  );
  const stableToggleTrackMute = useLatestCallback((trackId: string) =>
    mutateProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, muted: !t.muted } : t)),
    }))
  );
  const stableRenameSpeakerTrack = useLatestCallback(handleRenameSpeakerTrack);
  const stableReorderBlocks = useLatestCallback((newBlocks: TranscriptBlock[]) => {
    mutateProject((p) => ({ ...p, blocks: newBlocks }));
  });
  const stableSeekToHighlight = useLatestCallback(handleSeekToHighlight);
  const stableSeekAndPlay = useLatestCallback(handleSeekAndPlay);
  const stableRemoveHighlight = useLatestCallback((highlightId: string) =>
    mutateProject((p) => ({
      ...p,
      highlights: p.highlights.filter((h) => h.id !== highlightId),
    }))
  );
  const stableAiAutoFillHighlights = useLatestCallback(() => void handleAiAutoFillHighlights());
  const stableCopyQuotes = useLatestCallback(handleCopyQuotes);
  const stableImportBgm = useLatestCallback((slot: AuxAudioSlot) => void handleImportBgm(slot));
  const stableToggleBgmEnabled = useLatestCallback(handleToggleBgmEnabled);
  const stableRemoveBgm = useLatestCallback(handleRemoveBgm);
  const stableToggleBgmSolo = useLatestCallback(() =>
    mutateProject((p) => {
      const cur = p.introBgm ?? { fileName: '内置合成垫乐', enabled: true };
      return {
        ...p,
        introBgm: { ...cur, solo: !cur.solo },
      };
    })
  );
  const stableToggleBgmMute = useLatestCallback(() =>
    mutateProject((p) => {
      const cur = p.introBgm ?? { fileName: '内置合成垫乐', enabled: true };
      return {
        ...p,
        introBgm: { ...cur, muted: !cur.muted },
      };
    })
  );

  const stableSelectToken = useLatestCallback(handleSelectToken);
  const stableSelectRange = useLatestCallback(handleSelectRange);
  const stableClearSelection = useLatestCallback(() => setSelectedIds(new Set()));
  const stableSeekToSec = useLatestCallback(seekToSec);
  const stableSetGroupingMode = useLatestCallback(
    (mode: PodcastProjectState['groupingMode']) =>
      mutateProject((p) => ({ ...p, groupingMode: mode }))
  );
  const stableSetSpeakerFilter = useLatestCallback((spId: string) =>
    mutateProject((p) => ({ ...p, speakerFilter: spId }))
  );
  const stableSetInteractionMode = useLatestCallback(
    (mode: PodcastProjectState['interactionMode']) =>
      mutateProject((p) => ({ ...p, interactionMode: mode }))
  );
  const stableToggleHideDeleted = useLatestCallback(() =>
    mutateProject((p) => ({ ...p, hideDeletedTokens: !p.hideDeletedTokens }))
  );
  const stableRippleDeleteSelected = useLatestCallback(handleRippleDeleteSelected);
  const stableMuteTrackSelected = useLatestCallback(handleMuteTrackSelected);
  const stableBleepSelected = useLatestCallback(handleBleepSelected);
  const stableAddSelectedToHighlight = useLatestCallback(handleAddSelectedToHighlight);
  const stableCancelDuckingSelected = useLatestCallback(handleCancelDuckingSelected);
  const stableRestoreTokens = useLatestCallback((tokenIds: string[]) => {
    const restoreSet = new Set(tokenIds);
    audioPreview.requestSeek();
    mutateProject(
      (p) => ({
        ...p,
        blocks: p.blocks.map((b) => ({
          ...b,
          tokens: b.tokens.map((t) =>
            restoreSet.has(t.id)
              ? {
                  ...t,
                  deleted: false,
                  trackMuted: false,
                  cutByWaveform: false,
                  mouthClickCleaned: false,
                }
              : t
          ),
        })),
      }),
      true
    );
  });
  const stableShortenSilence = useLatestCallback((tokenId: string) => {
    audioPreview.requestSeek();
    mutateProject(
      (p) => ({
        ...p,
        blocks: p.blocks.map((b) => ({
          ...b,
          tokens: b.tokens.map((t) =>
            t.id === tokenId && t.type === 'silence' ? { ...t, durationSec: 0.45 } : t
          ),
        })),
      }),
      true
    );
  });
  const stableAcceptAllAiCorrections = useLatestCallback(handleAcceptAllAiCorrections);
  const stableApplyManualCorrection = useLatestCallback(handleApplyManualCorrection);
  const stableApplyPreferenceSmartCut = useLatestCallback(handleApplyPreferenceSmartCutAction);
  const stableCleanSpeakerFillers = useLatestCallback(handleCleanSpeakerFillers);
  const stableCompressSpeakerSilence = useLatestCallback(handleCompressSpeakerSilence);
  const stableCleanMouthClicks = useLatestCallback(handleCleanMouthClicks);
  const stableToggleRetakeExpand = useLatestCallback((blockId: string) =>
    mutateProject((p) => ({
      ...p,
      blocks: p.blocks.map((b) =>
        b.blockId === blockId ? { ...b, retakeExpanded: !b.retakeExpanded } : b
      ),
    }))
  );
  const stableToggleOverlapMute = useLatestCallback(
    (
      blockId: string,
      fallbackOv?: {
        speakerId: string;
        speakerName: string;
        text?: string;
        sourceStartMs: number;
        sourceEndMs: number;
      }
    ) =>
      mutateProject((p) => ({
        ...p,
        blocks: p.blocks.map((b) => {
          if (b.blockId !== blockId) return b;
          if (b.overlapNote) {
            const nextMuted = !b.overlapNote.muted;
            return {
              ...b,
              overlapNote: {
                ...b.overlapNote,
                muted: nextMuted,
                keepFullVolume: nextMuted ? false : b.overlapNote.keepFullVolume,
              },
            };
          }
          if (!fallbackOv) return b;
          return {
            ...b,
            overlapNote: {
              id: `ov_${blockId}`,
              speakerId: fallbackOv.speakerId,
              speakerName: fallbackOv.speakerName,
              text: fallbackOv.text || '[语音重合副轨]',
              sourceStartMs: fallbackOv.sourceStartMs,
              sourceEndMs: fallbackOv.sourceEndMs,
              muted: true,
              keepFullVolume: false,
            },
          };
        }),
      }))
  );
  const stableToggleOverlapKeepFull = useLatestCallback(
    (
      blockId: string,
      fallbackOv?: {
        speakerId: string;
        speakerName: string;
        text?: string;
        sourceStartMs: number;
        sourceEndMs: number;
      }
    ) =>
      mutateProject((p) => ({
        ...p,
        blocks: p.blocks.map((b) => {
          if (b.blockId !== blockId) return b;
          if (b.overlapNote) {
            const nextKeep = !b.overlapNote.keepFullVolume;
            return {
              ...b,
              overlapNote: {
                ...b.overlapNote,
                keepFullVolume: nextKeep,
                muted: nextKeep ? false : b.overlapNote.muted,
              },
            };
          }
          if (!fallbackOv) return b;
          return {
            ...b,
            overlapNote: {
              id: `ov_${blockId}`,
              speakerId: fallbackOv.speakerId,
              speakerName: fallbackOv.speakerName,
              text: fallbackOv.text || '[语音重合副轨]',
              sourceStartMs: fallbackOv.sourceStartMs,
              sourceEndMs: fallbackOv.sourceEndMs,
              muted: false,
              keepFullVolume: true,
            },
          };
        }),
      }))
  );
  const stableUndo = useLatestCallback(handleUndoLastEdit);
  const stableToggleCutPrerollEnabled = useLatestCallback(handleToggleCutPrerollEnabled);
  const stableTogglePauseCutJumpEnabled = useLatestCallback(handleTogglePauseCutJumpEnabled);
  const stableChangeCutPrerollSec = useLatestCallback(handleChangeCutPrerollSec);
  const stableResetAllEdits = useLatestCallback(handleRestoreAllEdits);
  const handleConfirmRetranscribe = (selectedAsrConfig: AsrConfig) => {
    setRetranscribeModalOpen(false);
    mutateProject((p) => ({ ...p, asrConfig: selectedAsrConfig }));
    void handleRetranscribeCurrentTracks(selectedAsrConfig);
  };
  const stableRetranscribe = useLatestCallback(() => {
    if (state.tracks.length === 0) {
      notify('请先导入音频轨道');
      return;
    }
    setRetranscribeModalOpen(true);
  });
  const stableOpenAsrSettings = useLatestCallback(() => setImportModalOpen(true));
  const stableOpenSubtitleCorrection = useLatestCallback(() => {
    setDroppedSubtitle(null);
    setSubtitleModalOpen(true);
  });
  const stableDropSubtitleFile = useLatestCallback((file: File) => {
    void readSubtitleBrowserFile(file)
      .then((loadedSub) => {
        setDroppedSubtitle(loadedSub);
        setSubtitleModalOpen(true);
      })
      .catch((err) => notify(`读取字幕文件失败: ${String(err)}`));
  });
  const stableSeekByRatio = useLatestCallback((ratio: number) =>
    seekToSec(Math.max(0, Math.min(1, ratio)) * timeline.totalEditedDurationSec)
  );
  const stableFocusWaveformBlock = useLatestCallback(
    (
      startSec: number,
      endSec: number,
      speakerId?: string,
      anchorSec?: number,
      preserveHigherZoom = false
    ) =>
      setWaveformFocusRequest((prev) => ({
        startSec,
        endSec,
        speakerId,
        anchorSec,
        preserveHigherZoom,
        seq: (prev?.seq ?? 0) + 1,
      }))
  );
  const stableExportAudio = useLatestCallback(
    (fmt: 'mp3' | 'wav') => void handleExportMasterAudio(fmt)
  );
  const stableStepPlayhead = useLatestCallback(stepPlayhead);
  const stableWaveformCutAction = useLatestCallback(handleWaveformCutAction);
  const stableSetWorkspaceLayout = useLatestCallback((mode: 'multitrack' | 'transcript') =>
    mutateProject((p) => ({ ...p, workspaceLayout: mode }))
  );
  const stableSetWaveformSelectionMode = useLatestCallback((mode: WaveformSelectionMode) => {
    mutateProject((p) => ({ ...p, waveformSelectionMode: mode }));
    notify(
      mode === 'snap'
        ? '🧲 已切换至吸附模式：框选波形将自动吸附到文字间隙'
        : '✂️ 已切换至自由模式：将严格按照精确选区删除内容'
    );
  });
  const stableToggleLeftPane = useLatestCallback(() => setLeftPaneCollapsed((v) => !v));
  const stableToggleRightPane = useLatestCallback(() => setRightPaneCollapsed((v) => !v));
  const stableSwitchToTranscriptView = useLatestCallback(() =>
    mutateProject((p) => ({ ...p, workspaceLayout: 'transcript' }))
  );
  const stableCleanFillersAll = useLatestCallback(() => handleCleanSpeakerFillers('all'));
  const stableCleanMouthClicksAll = useLatestCallback(() => handleCleanMouthClicks('all'));
  const stableDeleteTokenIds = useLatestCallback((tokenIds: string[]) => {
    if (tokenIds.length === 0) return;
    const idSet = new Set(tokenIds);
    let earliestStartSec = Number.POSITIVE_INFINITY;
    for (const m of timelineRef.current.mappedTokens) {
      if (!m.token.deleted && idSet.has(m.tokenId)) {
        earliestStartSec = Math.min(earliestStartSec, m.editedStartSec);
      }
    }
    const nextState: PodcastProjectState = {
      ...state,
      blocks: state.blocks.map((b) => ({
        ...b,
        tokens: b.tokens.map((t) =>
          idSet.has(t.id) ? { ...t, deleted: true, cutByWaveform: false } : t
        ),
      })),
    };
    const nextTimeline = computeEditedTimeline(nextState);
    const seamSec = Number.isFinite(earliestStartSec)
      ? earliestStartSec
      : remapPlayheadAfterTimelineEdit(timelineRef.current, nextTimeline, playheadRef.current);

    mutateProject(() => nextState, true);
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      idSet.forEach((id) => next.delete(id));
      return next;
    });
    const wasPlaying = isPlayingRef.current;
    playFromCutSeamPreroll(nextState, nextTimeline, seamSec);
    const shouldPrerollPlay = wasPlaying
      ? (nextState.cutPrerollEnabled ?? true)
      : (nextState.pauseCutJumpEnabled ?? true);
    const backSec = nextState.cutPrerollSec ?? 3;
    notify(
      shouldPrerollPlay
        ? `✂️ 已切除该发言段并自动从 ${backSec}s 前播放审听（按 ⌘Z 可撤销）`
        : '✂️ 已切除该发言段并同步缝合全轨音频（按 ⌘Z 可撤销）'
    );
  });
  const stableMuteTokenIds = useLatestCallback((tokenIds: string[]) => {
    if (tokenIds.length === 0) return;
    const idSet = new Set(tokenIds);
    mutateProject(
      (prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) => ({
          ...b,
          tokens: b.tokens.map((t) =>
            idSet.has(t.id) && t.type !== 'silence' ? { ...t, trackMuted: true } : t
          ),
        })),
      }),
      true
    );
    notify('🔇 已对该发言段执行单轨静音（按 ⌘Z 可撤销）');
  });

  const hasWorkspaceContent = state.tracks.length > 0;

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-zinc-950 text-zinc-100">
      {/* Hidden Browser File Inputs for .podcraft Open & Quick Audio Import */}
      <input
        ref={browserProjectInputRef}
        type="file"
        accept=".podcraft,.json,application/json"
        onChange={handleBrowserProjectFileSelected}
        className="hidden"
      />
      <input
        ref={browserAudioInputRef}
        type="file"
        multiple
        accept="audio/*,.wav,.mp3,.m4a,.flac"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            void handlePickBrowserAudioFiles(e.target.files);
            e.target.value = '';
          }
        }}
        className="hidden"
      />
      <input
        ref={browserBgmInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.m4a,.flac,.aac,.ogg"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            void handleBrowserBgmFileSelected(f);
            e.target.value = '';
          }
        }}
        className="hidden"
      />

      {toastMsg && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 rounded-xl bg-zinc-100 text-zinc-950 text-xs font-semibold shadow-2xl border border-zinc-300">
          {toastMsg}
        </div>
      )}

      <LoadingProgressModal
        progress={loadingProgress}
        onCancel={handleCancelRetranscribe}
      />
      <RetranscribeConfirmModal
        open={retranscribeModalOpen}
        state={state}
        onClose={() => setRetranscribeModalOpen(false)}
        onConfirm={handleConfirmRetranscribe}
      />
      <ShortcutsModal
        open={shortcutsModalOpen}
        onClose={() => setShortcutsModalOpen(false)}
      />
      <GlobalAuxLibraryModal
        open={auxLibraryModal.open}
        initialSlot={auxLibraryModal.slot}
        items={globalAuxItems}
        activeFiles={{
          intro_vo: state.introVoiceover?.fileName,
          intro: state.introBgm?.fileName,
          outro: state.outroBgm?.fileName,
        }}
        onClose={() => setAuxLibraryModal((prev) => ({ ...prev, open: false }))}
        onAddFileToLibrary={(slot) => void handleAddFileToGlobalLibrary(slot)}
        onApplyPreset={(item) => void handleApplyGlobalAuxPreset(item)}
        onToggleDefault={handleToggleGlobalAuxDefault}
        onRemoveItem={handleRemoveGlobalAuxItem}
      />

      <TopStudioBar
        state={state}
        isDirty={isDirty}
        savedDurationSec={timeline.savedDurationSec}
        isPlaying={isPlaying}
        autoSaveEnabled={autoSaveEnabled}
        autoSaveIntervalSec={autoSaveIntervalSec}
        lastAutoSavedAt={lastAutoSavedAt}
        onToggleAutoSave={stableToggleAutoSave}
        onChangeAutoSaveInterval={stableChangeAutoSaveInterval}
        onRenameProjectTitle={stableRenameProjectTitle}
        onNewEmptyProject={stableNewEmptyProject}
        onOpenProjectFile={stableOpenProjectFile}
        onSaveProjectFile={stableSaveProjectFile}
        recentProjects={recentProjects}
        onOpenRecentProject={(path) => void handleOpenProjectFilePath(path)}
        onClearRecentProjects={handleClearRecentProjects}
        onRegisterFileAssociation={handleRegisterFileAssociation}
        onSetWorkspaceLayout={stableSetWorkspaceLayout}
        onToggleRecordingMode={stableToggleRecordingMode}
        onCycleAutoSolo={stableCycleAutoSolo}
        onToggleLoudness={stableToggleLoudness}
        onCycleDeClick={stableCycleDeClick}
        onToggleStripSilence={stableToggleStripSilence}
        onToggleCutPrerollEnabled={stableToggleCutPrerollEnabled}
        onTogglePauseCutJumpEnabled={stableTogglePauseCutJumpEnabled}
        onChangeCutPrerollSec={stableChangeCutPrerollSec}
        onTogglePlay={stableTogglePlay}
        onChangePlaybackRate={stableChangePlaybackRate}
        onOpenImportModal={stableOpenImportModal}
        onQuickExportAudio={stableQuickExportMp3}
        onOpenShownotes={() => handleOpenShownotes('summary')}
        leftPaneCollapsed={leftPaneCollapsed}
        rightPaneCollapsed={rightPaneCollapsed}
        onToggleLeftPane={stableToggleLeftPane}
        onToggleRightPane={stableToggleRightPane}
        onOpenShortcuts={() => setShortcutsModalOpen(true)}
        onOpenGlobalAuxLibrary={(slot) => setAuxLibraryModal({ open: true, slot: slot || 'intro' })}
        onOpenDepGuide={() => setDepGuideModalOpen(true)}
        onImportBgm={stableImportBgm}
        onToggleBgmEnabled={stableToggleBgmEnabled}
        onRemoveBgm={stableRemoveBgm}
        onSaveSlotToGlobalLibrary={handleSaveSlotToGlobalLibrary}
        onUpdateState={mutateProject}
        onNotify={notify}
      />

      <div ref={workspaceRowRef} className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        {/* 左侧音轨与素材栏（仅在音轨视图展示；文稿视图全宽替换左右侧边栏） */}
        {(state.workspaceLayout ?? 'multitrack') !== 'transcript' &&
          (leftPaneCollapsed ? (
            <div className="relative w-7 shrink-0 border-r border-zinc-800 bg-zinc-900/90 flex flex-col items-center py-2.5 gap-2.5 select-none">
              <button
                type="button"
                onClick={stableToggleLeftPane}
                title="展开左侧音轨与素材栏（也可向右拖拽边缘拉出）"
                className="p-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 cursor-pointer transition"
              >
                <PanelLeftOpen className="w-3.5 h-3.5" />
              </button>
              <span className="px-1 py-0.5 rounded bg-zinc-800 text-[10px] font-mono text-zinc-300">
                {state.tracks.length}
              </span>
              <button
                type="button"
                onClick={stableToggleLeftPane}
                title="点击展开左侧音轨与素材栏"
                className="flex-1 flex items-center justify-center text-[11px] tracking-widest text-zinc-400 hover:text-zinc-200 cursor-pointer [writing-mode:vertical-rl]"
              >
                音轨与素材
              </button>
              <div
                onPointerDown={(e) => handleStartResizeSidePane('left', e)}
                title="向右拖拽拉出左侧音轨与素材栏"
                className="absolute inset-y-0 -right-1 w-2 cursor-col-resize hover:bg-blue-500/35 z-20 transition-colors"
              />
            </div>
          ) : (
            <>
              <div
                style={{ width: `${leftPaneWidth}px` }}
                className="shrink-0 h-full min-h-0 overflow-hidden"
              >
                <LeftTrackAndChapterPane
                  state={state}
                  onToggleTrackSolo={stableToggleTrackSolo}
                  onToggleTrackMute={stableToggleTrackMute}
                  onRenameSpeakerTrack={stableRenameSpeakerTrack}
                  onSeekToHighlight={stableSeekToHighlight}
                  onRemoveHighlight={stableRemoveHighlight}
                  onAiAutoFillHighlights={stableAiAutoFillHighlights}
                  onCopyQuotes={stableCopyQuotes}
                  onOpenImportModal={stableOpenImportModal}
                  onImportBgm={stableImportBgm}
                  onToggleBgmEnabled={stableToggleBgmEnabled}
                  onRemoveBgm={stableRemoveBgm}
                  onOpenGlobalAuxLibrary={(slot) => setAuxLibraryModal({ open: true, slot: slot || 'intro' })}
                  onSaveSlotToGlobalLibrary={handleSaveSlotToGlobalLibrary}
                  onUpdateState={mutateProject}
                  onNotify={notify}
                  onCollapsePane={stableToggleLeftPane}
                  onOpenHighlightEditModal={setGlobalEditingHighlight}
                />
              </div>
              <div
                onPointerDown={(e) => handleStartResizeSidePane('left', e)}
                onDoubleClick={() => setLeftPaneWidth(DEFAULT_LEFT_PANE_WIDTH)}
                title="左右拖拽调整左侧栏宽度（拖至最左自动收起 · 双击恢复默认宽度）"
                className="w-1.5 shrink-0 relative z-20 cursor-col-resize group flex items-center justify-center bg-zinc-950 border-x border-zinc-800/80 hover:bg-blue-500/15 transition-colors"
              >
                <div
                  className={`w-[2px] h-10 rounded-full transition-colors ${
                    resizingSide === 'left'
                      ? 'bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.9)]'
                      : 'bg-zinc-700/70 group-hover:bg-blue-400/80'
                  }`}
                />
                {resizingSide === 'left' && (
                  <span className="pointer-events-none absolute top-3 left-2.5 px-1.5 py-0.5 rounded bg-zinc-900/95 border border-blue-500/60 font-mono text-[10px] text-blue-300 shadow-lg whitespace-nowrap">
                    {leftPaneWidth}px
                  </span>
                )}
              </div>
            </>
          ))}

        {!hasWorkspaceContent ? (
          /* Clean Empty Studio Onboarding Screen — Zero Default Audio or Fake Text */
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const dropped = e.dataTransfer.files;
              if (!dropped || dropped.length === 0) return;
              if (dropped[0].name.endsWith('.podcraft') || dropped[0].name.endsWith('.json')) {
                void readPodcraftProjectBrowserFile(dropped[0], (pct, msg) =>
                  setLoadingProgress({
                    active: true,
                    title: '正在加载播客工程文件',
                    stage: 'drop_project',
                    percent: pct,
                    message: msg,
                  })
                )
                  .then((loaded) => {
                    applyLoadedProject(loaded);
                  })
                  .catch((err) => notify(`打开工程失败: ${String(err)}`))
                  .finally(() => setLoadingProgress((p) => ({ ...p, active: false })));
              } else {
                void handlePickBrowserAudioFiles(dropped);
              }
            }}
            className="flex-1 min-w-0 h-full min-h-0 overflow-y-auto flex items-center justify-center p-6 bg-zinc-950"
          >
            <div className="w-full max-w-2xl rounded-3xl border border-zinc-800/90 bg-zinc-900/65 p-8 shadow-2xl space-y-6">
              <div className="space-y-2 text-center">
                <div className="w-12 h-12 rounded-2xl bg-blue-500/15 border border-blue-500/30 text-blue-400 flex items-center justify-center mx-auto mb-3">
                  <Mic className="w-6 h-6" />
                </div>
                <h1 className="text-xl font-bold text-zinc-100 tracking-tight">
                  欢迎使用 点波 TapWave
                </h1>
                <p className="text-xs text-zinc-400 max-w-lg mx-auto leading-relaxed">
                  当前为空白工程，无任何预设音频或示例文字。请导入本地多轨发言人录音（可选放入一条合并参考轨），或打开已保存的{' '}
                  <code className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-200">.podcraft</code>{' '}
                  工程文件继续编辑。
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <button
                  onClick={() => {
                    if (isTauriRuntime()) {
                      void handlePickNativeAudioFiles();
                    } else {
                      browserAudioInputRef.current?.click();
                    }
                  }}
                  className="p-4 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white text-left space-y-1.5 shadow-lg transition cursor-pointer group"
                >
                  <div className="flex items-center gap-2 font-semibold text-sm">
                    <FolderPlus className="w-4 h-4" />
                    <span>导入多轨播客音频</span>
                  </div>
                  <p className="text-xs text-blue-100/85 leading-snug">
                    支持 WAV / MP3 / M4A / FLAC 多选导入，流式提取波形峰值、响度与空白停顿胶囊
                  </p>
                </button>

                <button
                  onClick={() => void handleOpenProjectFile()}
                  className="p-4 rounded-2xl border border-zinc-700 bg-zinc-800/80 hover:bg-zinc-800 text-zinc-100 text-left space-y-1.5 transition cursor-pointer"
                >
                  <div className="flex items-center gap-2 font-semibold text-sm">
                    <FileJson className="w-4 h-4 text-amber-400" />
                    <span>打开已有工程 (.podcraft)</span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-snug">
                    完整恢复音轨对齐、逐字修改、波纹剪切记录、片头高光篮与专属词库（快捷键 ⌘O）
                  </p>
                </button>
              </div>

              {recentProjects.length > 0 && (
                <div className="rounded-2xl border border-zinc-800/90 bg-zinc-950/60 p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between text-xs px-0.5">
                    <span className="flex items-center gap-1.5 font-medium text-zinc-300">
                      <History className="w-3.5 h-3.5 text-blue-400" />
                      <span>近期编辑工程</span>
                    </span>
                    <button
                      type="button"
                      onClick={handleClearRecentProjects}
                      className="text-[11px] text-zinc-500 hover:text-zinc-300 hover:underline cursor-pointer"
                    >
                      清空记录
                    </button>
                  </div>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-0.5">
                    {recentProjects.slice(0, 5).map((proj) => (
                      <div
                        key={proj.filePath}
                        onClick={() => void handleOpenProjectFilePath(proj.filePath)}
                        className="group flex items-center justify-between p-2.5 rounded-xl bg-zinc-900/90 hover:bg-zinc-850 hover:bg-zinc-800/90 border border-zinc-800/80 hover:border-zinc-700 transition cursor-pointer text-left"
                      >
                        <div className="min-w-0 flex-1 pr-3">
                          <div className="flex items-center gap-2">
                            <FileJson className="w-3.5 h-3.5 text-amber-400/90 shrink-0" />
                            <span className="text-xs font-medium text-zinc-200 group-hover:text-white truncate">
                              {proj.title}
                            </span>
                            {typeof proj.tracksCount === 'number' && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/60 shrink-0">
                                {proj.tracksCount} 轨
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-zinc-500 truncate mt-0.5 font-mono" title={proj.filePath}>
                            {proj.filePath}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[10px] text-zinc-400">
                            {formatRecentTime(proj.lastOpenedAt)}
                          </span>
                          <span className="text-xs text-blue-400 opacity-0 group-hover:opacity-100 transition font-medium">
                            打开 →
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-3 pt-2 border-t border-zinc-800/80 text-xs text-zinc-400">
                <div className="flex items-start gap-2">
                  <Radio className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>同屋 0ms 免校准 / 异地参考轨 GCC-PHAT 自动对齐</span>
                </div>
                <div className="flex items-start gap-2">
                  <Scissors className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                  <span>选字删全轨 + 下方波形框选精切 + 改字不伤音频</span>
                </div>
                <div className="flex items-start gap-2">
                  <Save className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <span>支持 ⌘S 随时保存与二次导入修改 .podcraft 工程文件</span>
                </div>
              </div>

              <div className="text-center">
                <button
                  onClick={() => setImportModalOpen(true)}
                  className="text-xs text-zinc-400 hover:text-zinc-200 underline inline-flex items-center gap-1 cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                  <span>导入前预先选择录制模式、片头片尾 BGM 或配置大模型 API Key</span>
                </button>
              </div>
            </div>
          </div>
        ) : (state.workspaceLayout ?? 'multitrack') === 'transcript' ? (
          <TranscriptWorkspace
            state={state}
            timeline={timeline}
            selectedIds={selectedIds}
            activeBlockId={activeBlockId}
            activeTokenId={activeTokenId}
            canUndo={undoDepth > 0}
            onSelectToken={stableSelectToken}
            onSelectRange={stableSelectRange}
            onClearSelection={stableClearSelection}
            onSeekToSec={stableSeekToSec}
            onFocusWaveformBlock={stableFocusWaveformBlock}
            onSetGroupingMode={stableSetGroupingMode}
            onSetSpeakerFilter={stableSetSpeakerFilter}
            onSetInteractionMode={stableSetInteractionMode}
            onToggleHideDeleted={stableToggleHideDeleted}
            onRippleDeleteSelected={stableRippleDeleteSelected}
            onMuteTrackSelected={stableMuteTrackSelected}
            onBleepSelected={stableBleepSelected}
            onAddSelectedToHighlight={stableAddSelectedToHighlight}
            onRestoreTokens={stableRestoreTokens}
            onShortenSilence={stableShortenSilence}
            onAcceptAllAiCorrections={stableAcceptAllAiCorrections}
            onApplyManualCorrection={stableApplyManualCorrection}
            onCleanSpeakerFillers={stableCleanSpeakerFillers}
            onCompressSpeakerSilence={stableCompressSpeakerSilence}
            onCleanMouthClicks={stableCleanMouthClicks}
            onToggleRetakeExpand={stableToggleRetakeExpand}
            onToggleOverlapMute={stableToggleOverlapMute}
            onToggleOverlapKeepFull={stableToggleOverlapKeepFull}
            onCancelDuckingSelected={stableCancelDuckingSelected}
            onWaveformCutAction={stableWaveformCutAction}
            onUndo={stableUndo}
            onResetAllEdits={stableResetAllEdits}
            onRetranscribe={stableRetranscribe}
            onOpenSubtitleCorrection={stableOpenSubtitleCorrection}
            onDropSubtitleFile={stableDropSubtitleFile}
            onRenameSpeakerTrack={stableRenameSpeakerTrack}
            onReorderBlocks={stableReorderBlocks}
            onOpenShownotes={handleOpenShownotes}
            onSeekToHighlight={stableSeekToHighlight}
            onRemoveHighlight={stableRemoveHighlight}
            onUpdateState={mutateProject}
            onAiAutoFillHighlights={stableAiAutoFillHighlights}
            onCopyQuotes={stableCopyQuotes}
            onNotify={notify}
            onOpenHighlightEditModal={setGlobalEditingHighlight}
            isPlaying={isPlaying}
            onTogglePlay={stableTogglePlay}
            onSeekAndPlay={stableSeekAndPlay}
          />
        ) : (
          <WaveformEditorBar
            isMainStage
            state={state}
            timeline={timeline}
            playheadSec={playheadSec}
            isPlaying={isPlaying}
            selectedTokenIds={selectedIds}
            activeBlockId={activeBlockId}
            activeTokenId={activeTokenId}
            canUndo={undoDepth > 0}
            rightPaneCollapsed={rightPaneCollapsed}
            onToggleRightPane={stableToggleRightPane}
            onSwitchToTranscriptView={stableSwitchToTranscriptView}
            onTogglePlay={stableTogglePlay}
            onStepPlayhead={stableStepPlayhead}
            onChangePlaybackRate={stableChangePlaybackRate}
            onSeekToSec={stableSeekToSec}
            onWaveformCutAction={stableWaveformCutAction}
            onToggleTrackSolo={stableToggleTrackSolo}
            onToggleTrackMute={stableToggleTrackMute}
            onToggleBgmSolo={stableToggleBgmSolo}
            onToggleBgmMute={stableToggleBgmMute}
            onImportBgm={stableImportBgm}
            onRenameSpeakerTrack={stableRenameSpeakerTrack}
            onSelectToken={stableSelectToken}
            onSelectRange={stableSelectRange}
            focusRequest={waveformFocusRequest}
            onClearSelection={stableClearSelection}
            onRippleDeleteSelected={stableRippleDeleteSelected}
            onMuteTrackSelected={stableMuteTrackSelected}
            onBleepSelected={stableBleepSelected}
            onAddSelectedToHighlight={stableAddSelectedToHighlight}
            onShortenSilence={stableShortenSilence}
            onDeleteTokenIds={stableDeleteTokenIds}
            onMuteTokenIds={stableMuteTokenIds}
            onCleanFillers={stableCleanFillersAll}
            onApplyPreferenceSmartCut={stableApplyPreferenceSmartCut}
            onCleanMouthClicks={stableCleanMouthClicksAll}
            onUndo={stableUndo}
            onRetranscribe={stableRetranscribe}
            onOpenAsrSettings={stableOpenAsrSettings}
            onApplyManualCorrection={stableApplyManualCorrection}
            onToggleOverlapMute={stableToggleOverlapMute}
            onToggleOverlapKeepFull={stableToggleOverlapKeepFull}
            onCancelDuckingSelected={stableCancelDuckingSelected}
            onSetWaveformSelectionMode={stableSetWaveformSelectionMode}
            onUpdateBgmAsset={handleUpdateBgmAsset}
            onNotify={notify}
          />
        )}

        {/* 右侧 AI 栏（仅在音轨视图展示；文稿视图全宽替换左右侧边栏） */}
        {hasWorkspaceContent &&
          (state.workspaceLayout ?? 'multitrack') !== 'transcript' &&
          (rightPaneCollapsed ? (
            <div className="relative w-7 shrink-0 border-l border-zinc-800 bg-zinc-900/90 flex flex-col items-center py-2.5 gap-2.5 select-none">
              <div
                onPointerDown={(e) => handleStartResizeSidePane('right', e)}
                title="向左拖拽拉出右侧 AI 工作台"
                className="absolute inset-y-0 -left-1 w-2 cursor-col-resize hover:bg-blue-500/35 z-20 transition-colors"
              />
              <button
                type="button"
                onClick={stableToggleRightPane}
                title="展开右侧 AI 工作台（也可向左拖拽边缘拉出）"
                className="p-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 cursor-pointer transition"
              >
                <PanelRightOpen className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={stableToggleRightPane}
                title="点击展开右侧高光·曲线·导出工作台"
                className="flex-1 flex items-center justify-center text-[11px] tracking-widest text-zinc-400 hover:text-zinc-200 cursor-pointer [writing-mode:vertical-rl]"
              >
                高光·曲线·导出
              </button>
            </div>
          ) : (
            <>
              <div
                onPointerDown={(e) => handleStartResizeSidePane('right', e)}
                onDoubleClick={() => setRightPaneWidth(DEFAULT_RIGHT_PANE_WIDTH)}
                title="左右拖拽调整右侧工作台宽度（拖至最右自动收起 · 双击恢复默认宽度）"
                className="w-1.5 shrink-0 relative z-20 cursor-col-resize group flex items-center justify-center bg-zinc-950 border-x border-zinc-800/80 hover:bg-blue-500/15 transition-colors"
              >
                <div
                  className={`w-[2px] h-10 rounded-full transition-colors ${
                    resizingSide === 'right'
                      ? 'bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.9)]'
                      : 'bg-zinc-700/70 group-hover:bg-blue-400/80'
                  }`}
                />
                {resizingSide === 'right' && (
                  <span className="pointer-events-none absolute top-3 right-2.5 px-1.5 py-0.5 rounded bg-zinc-900/95 border border-blue-500/60 font-mono text-[10px] text-blue-300 shadow-lg whitespace-nowrap">
                    {rightPaneWidth}px
                  </span>
                )}
              </div>
              <div
                style={{ width: `${rightPaneWidth}px` }}
                className="shrink-0 h-full min-h-0 overflow-hidden"
              >
                <RightAiWorkbench
                  state={state}
                  timeline={timeline}
                  activeTab={activeRightTab}
                  onSwitchTab={setActiveRightTab}
                  onUpdateState={mutateProject}
                  onAiAutoFillHighlights={stableAiAutoFillHighlights}
                  onCleanSpeakerFillers={stableCleanSpeakerFillers}
                  onSeekByRatio={stableSeekByRatio}
                  onSeekToSec={stableSeekToSec}
                  onExportAudio={stableExportAudio}
                  onOpenShownotes={() => handleOpenShownotes('summary')}
                  onNotify={notify}
                  onCollapsePane={stableToggleRightPane}
                />
              </div>
            </>
          ))}
      </div>

      {hasWorkspaceContent && (state.workspaceLayout ?? 'multitrack') === 'transcript' && (
        <WaveformEditorBar
          state={state}
          timeline={timeline}
          playheadSec={playheadSec}
          isPlaying={isPlaying}
          focusRequest={waveformFocusRequest}
          onTogglePlay={stableTogglePlay}
          onStepPlayhead={stableStepPlayhead}
          onChangePlaybackRate={stableChangePlaybackRate}
          onSeekToSec={stableSeekToSec}
          onWaveformCutAction={stableWaveformCutAction}
          onToggleTrackSolo={stableToggleTrackSolo}
          onToggleTrackMute={stableToggleTrackMute}
          onToggleBgmSolo={stableToggleBgmSolo}
          onToggleBgmMute={stableToggleBgmMute}
          onImportBgm={stableImportBgm}
          onRenameSpeakerTrack={stableRenameSpeakerTrack}
          onSetWaveformSelectionMode={stableSetWaveformSelectionMode}
          onUpdateBgmAsset={handleUpdateBgmAsset}
          onNotify={notify}
        />
      )}

      {importModalOpen && (
        <Suspense fallback={null}>
          <LazyImportTracksModal
            open={importModalOpen}
            state={state}
            onClose={() => setImportModalOpen(false)}
            onUpdateState={mutateProject}
            onPickNativeAudioFiles={() => void handlePickNativeAudioFiles()}
            onPickBrowserAudioFiles={(files) => void handlePickBrowserAudioFiles(files)}
            onOpenProjectFile={() => void handleOpenProjectFile()}
            onImportBgm={(slot) => void handleImportBgm(slot)}
            onOpenSubtitleCorrection={() => {
              setDroppedSubtitle(null);
              setSubtitleModalOpen(true);
            }}
            onRetranscribe={stableRetranscribe}
            onOpenDepGuide={() => setDepGuideModalOpen(true)}
          />
        </Suspense>
      )}

      {subtitleModalOpen && (
        <Suspense fallback={null}>
          <LazySubtitleCorrectionModal
            open={subtitleModalOpen}
            state={state}
            initialSubtitle={droppedSubtitle}
            onClose={() => {
              setSubtitleModalOpen(false);
              setDroppedSubtitle(null);
            }}
            onApplyCorrection={(updater) => {
              audioPreview.requestSeek();
              mutateProject((prev) => {
                const next = updater(prev);
                return {
                  ...next,
                  blocks: refineProjectBlocksWithWaveform(
                    next.blocks,
                    next.tracks,
                    next.recordingMode
                  ),
                };
              }, true);
            }}
            onNotify={notify}
          />
        </Suspense>
      )}

      {shownotesModal.open && (
        <Suspense fallback={null}>
          <LazyShownotesModal
            open={shownotesModal.open}
            initialTab={shownotesModal.initialTab}
            state={state}
            timeline={timeline}
            onUpdateState={mutateProject}
            onSeekToSec={stableSeekToSec}
            onNotify={notify}
            onClose={() => setShownotesModal((p) => ({ ...p, open: false }))}
          />
        </Suspense>
      )}

      <DependencyGuideModal
        open={depGuideModalOpen}
        onClose={() => setDepGuideModalOpen(false)}
        state={state}
        onUpdateState={mutateProject}
        onNotify={notify}
      />

      <SmartCutConfirmModal
        open={Boolean(smartCutModalOutcome)}
        outcome={smartCutModalOutcome}
        auditioningItemId={auditioningCutItemId}
        onAuditionCutPoint={handleAuditionCutPoint}
        onStopAudition={handleStopCutAudition}
        onConfirm={handleConfirmPreferenceSmartCut}
        onCancel={handleCancelPreferenceSmartCut}
        onSeekToSec={stableSeekToSec}
      />

      {globalEditingHighlight && (
        <HighlightEditModal
          open={Boolean(globalEditingHighlight)}
          highlight={globalEditingHighlight}
          tracks={state.tracks}
          onClose={() => setGlobalEditingHighlight(null)}
          onSave={handleSaveHighlight}
        />
      )}
    </div>
  );
};
