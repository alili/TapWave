import React, { useEffect, useMemo, useRef, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeftRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Download,
  FileText,
  FolderOpen,
  GitMerge,
  History,
  Loader2,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  UserCheck,
  UserPlus,
  Volume2,
  X,
} from 'lucide-react';
import { buildPodAudioUrl } from '../data/emptyProject';
import { PodcastProjectState } from '../types/podcast';
import {
  LiveAsrEngineMode,
  LiveQuestion,
  LiveQuestionType,
  LiveSpeakerSuggestionCandidate,
  LiveScenario,
  LiveSessionPrep,
  LiveSpeaker,
  LiveSpeakerAnalysisMode,
  LiveSpeakerRole,
  LiveUtterance,
  RecentLiveSessionItem,
} from '../types/liveSession';
import {
  buildAsrConfigFromPlatform,
  buildLlmConfigForFeature,
  getCachedAiPlatformConfig,
} from '../engine/aiPlatformConfig';
import {
  AudioInputDeviceOption,
  listAudioInputDevices,
  startLiveAudioCapture,
} from '../engine/liveAudioCapture';
import { buildLiveSessionMarkdown, formatLiveMmSs } from '../engine/liveMinutesExporter';
import {
  addAndAssignLivePartialSpeaker,
  addAndAssignLiveSpeaker,
  applyInferredSpeakerName,
  assignLivePartialSpeaker,
  assignLiveSpeaker,
  batchAssignLiveSpeaker,
  computeUtteranceUploadStates,
  dismissInferredSpeakerName,
  dismissLiveEngineNotice,
  findSpeakerReassignSuggestions,
  findSuspectedDuplicateSpeakers,
  loadRecentLiveSessions,
  mergeLiveSpeakers,
  openLiveSessionFromJsonText,
  openLiveSessionFromPath,
  overrideLiveOutline,
  pauseLiveSession,
  removeRecentLiveSession,
  renameLiveSpeaker,
  requestLiveInsight,
  requestLiveSpeakerContentAnalysis,
  resetLiveSession,
  resumeLiveSession,
  revertLiveUtteranceCorrection,
  saveLiveReportAndMinutes,
  setLiveQuestionStatus,
  setLiveSpeakerAnalysisMode,
  startLiveSession,
  stopLiveSession,
  useLiveMicLevel,
  useLiveSession,
} from '../engine/liveSessionStore';
import {
  checkSidecarCapabilities,
  getDependenciesStatus,
  isTauriRuntime,
  saveTextOrJsonFile,
} from '../engine/tauriBridge';
import { LiveAnalyticsCenterPane } from './LiveAnalyticsCenterPane';
import { computeLiveSpeechAnalytics } from '../engine/liveSpeechAnalytics';
import {
  aggregateLiveUtterances,
  AggregatedUtteranceBlock,
  buildSingleUtteranceBlock,
  separatorBetweenUtterances,
} from '../engine/liveTranscriptAggregator';

const PREP_STORAGE_KEY = 'tapwave_live_prep_v1';

interface RecordingWorkspaceProps {
  state: PodcastProjectState;
  onOpenAiPlatform: () => void;
  onOpenDepGuide: () => void;
  onNotify: (msg: string) => void;
}

interface StoredPrepForm {
  scenario: LiveScenario;
  title: string;
  topic: string;
  goals: string;
  counterpartName: string;
  counterpartBackground: string;
  selfName: string;
  speakerCount: number;
  hasHost: boolean;
  captureAudience: boolean;
  asrEngine: LiveAsrEngineMode;
  enableStreamCorrection: boolean;
  speakerAnalysisMode: LiveSpeakerAnalysisMode;
  outlineText: string;
  targetFieldsText: string;
  volcStreamResourceId: string;
}

const DEFAULT_PREP_FORM: StoredPrepForm = {
  scenario: 'chat',
  title: '',
  topic: '',
  goals: '',
  counterpartName: '',
  counterpartBackground: '',
  selfName: '我',
  speakerCount: 2,
  hasHost: true,
  captureAudience: true,
  asrEngine: 'auto',
  enableStreamCorrection: true,
  speakerAnalysisMode: 'hybrid',
  outlineText: '',
  targetFieldsText: '',
  volcStreamResourceId: '',
};

function loadStoredPrep(): StoredPrepForm {
  try {
    const raw = localStorage.getItem(PREP_STORAGE_KEY);
    if (!raw) return DEFAULT_PREP_FORM;
    const obj = JSON.parse(raw) as Partial<StoredPrepForm>;
    const scenario: LiveScenario =
      obj.scenario === 'dialogue' || obj.scenario === 'listen' ? obj.scenario : 'chat';
    const rawCount = Math.max(1, Math.min(6, Number(obj.speakerCount) || 2));
    return {
      ...DEFAULT_PREP_FORM,
      ...obj,
      scenario,
      hasHost: typeof obj.hasHost === 'boolean' ? obj.hasHost : true,
      captureAudience: typeof obj.captureAudience === 'boolean' ? obj.captureAudience : true,
      asrEngine:
        obj.asrEngine === 'volcengine' || obj.asrEngine === 'local' ? obj.asrEngine : 'auto',
      speakerAnalysisMode:
        obj.speakerAnalysisMode === 'voiceprint' || obj.speakerAnalysisMode === 'content'
          ? obj.speakerAnalysisMode
          : 'hybrid',
      speakerCount: scenario === 'listen' ? 1 : Math.max(2, rawCount),
    };
  } catch {
    return DEFAULT_PREP_FORM;
  }
}

const FORM_INPUT_CLS =
  'w-full h-9 px-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-blue-500';
const FORM_SELECT_CLS =
  'w-full h-9 pl-2.5 pr-7 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-blue-500 appearance-none cursor-pointer disabled:opacity-45';

const SPEAKER_COLORS = [
  { badge: 'bg-blue-500/20 text-blue-300 border-blue-500/40', border: 'border-blue-500/30' },
  {
    badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    border: 'border-emerald-500/30',
  },
  { badge: 'bg-amber-500/20 text-amber-300 border-amber-500/40', border: 'border-amber-500/30' },
  { badge: 'bg-purple-500/20 text-purple-300 border-purple-500/40', border: 'border-purple-500/30' },
];

function questionTypeMeta(
  t: LiveQuestionType,
  isListen = false
): { label: string; cls: string } {
  switch (t) {
    case 'deepen':
      return {
        label: isListen ? '原理深挖' : '深挖',
        cls: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
      };
    case 'pivot':
      return {
        label: isListen ? '应用拓展' : '转场',
        cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
      };
    case 'handle_objection':
      return { label: '化解异议', cls: 'bg-rose-500/20 text-rose-300 border-rose-500/40' };
    case 'advance':
      return { label: '推进下一步', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' };
    default:
      return {
        label: isListen ? '延伸追问' : '追问',
        cls: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
      };
  }
}

export const RecordingWorkspace: React.FC<RecordingWorkspaceProps> = ({
  state,
  onOpenAiPlatform,
  onOpenDepGuide,
  onNotify,
}) => {
  const snap = useLiveSession();
  const micLevel = useLiveMicLevel();

  const [form, setForm] = useState<StoredPrepForm>(loadStoredPrep);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [devices, setDevices] = useState<AudioInputDeviceOption[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [testingMic, setTestingMic] = useState(false);
  const [testLevel, setTestLevel] = useState(0);
  const testHandleRef = useRef<{ stop: () => Promise<void> } | null>(null);

  const [localModelsReady, setLocalModelsReady] = useState<boolean | null>(null);
  const [volcEnvConfigured, setVolcEnvConfigured] = useState(false);

  // Recent live sessions & reopen state
  const [recentSessions, setRecentSessions] = useState<RecentLiveSessionItem[]>(() =>
    loadRecentLiveSessions()
  );
  const reportFileInputRef = useRef<HTMLInputElement | null>(null);

  // Speaker profile switching & merge state
  const [selectedProfileSpeakerId, setSelectedProfileSpeakerId] = useState<string | null>(null);
  const [showManualMerge, setShowManualMerge] = useState(false);
  const [manualMergeSourceId, setManualMergeSourceId] = useState<string>('');
  const [manualMergeTargetId, setManualMergeTargetId] = useState<string>('');
  const [swappedDupPairs, setSwappedDupPairs] = useState<Record<string, boolean>>({});

  // Audio playback state (for stopped / review mode)
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [audioCurrentMs, setAudioCurrentMs] = useState(0);
  const [audioDurationMs, setAudioDurationMs] = useState(0);
  const [playbackRate, setPlaybackRate] = useState<number>(1);

  useEffect(() => {
    if (snap.phase === 'idle' || snap.phase === 'stopped') {
      setRecentSessions(loadRecentLiveSessions());
    }
    if (snap.phase !== 'stopped') {
      setIsPlayingAudio(false);
      setAudioCurrentMs(0);
    }
  }, [snap.phase, snap.reportPath]);

  useEffect(() => {
    if (snap.speakers.length === 0) {
      setSelectedProfileSpeakerId(null);
      return;
    }
    const stillExists =
      selectedProfileSpeakerId &&
      snap.speakers.some((s) => s.id === selectedProfileSpeakerId);
    if (!stillExists) {
      const def =
        snap.speakers.find((s) => s.role === 'counterpart') ?? snap.speakers[0];
      setSelectedProfileSpeakerId(def.id);
    }
  }, [snap.speakers, selectedProfileSpeakerId]);

  // Transcript scroll & speaker popover state
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [highlightedUttId, setHighlightedUttId] = useState<string | null>(null);
  const [editingUttId, setEditingUttId] = useState<string | null>(null);
  const [applyToLabel, setApplyToLabel] = useState(true);
  const [renamingSpeakerId, setRenamingSpeakerId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [speakerSuggestion, setSpeakerSuggestion] = useState<{
    targetSpeakerId: string;
    targetSpeakerName: string;
    sourceUtteranceId: string;
    candidates: LiveSpeakerSuggestionCandidate[];
    selectedIds: string[];
  } | null>(null);

  const triggerSpeakerSuggestion = (
    utteranceId: string,
    targetSpeakerId: string,
    targetSpeakerName: string
  ) => {
    const candidates = findSpeakerReassignSuggestions(
      snap.utterances,
      utteranceId,
      targetSpeakerId,
      snap.speakers
    );
    if (candidates.length > 0) {
      setSpeakerSuggestion({
        targetSpeakerId,
        targetSpeakerName,
        sourceUtteranceId: utteranceId,
        candidates,
        selectedIds: candidates.map((c) => c.utteranceId),
      });
    } else {
      setSpeakerSuggestion(null);
    }
  };
  const [showAdoptedDrawer, setShowAdoptedDrawer] = useState(false);
  const [showHistoryQuestionsDrawer, setShowHistoryQuestionsDrawer] = useState(true);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [aggregateTranscript, setAggregateTranscript] = useState(true);

  useEffect(() => {
    setSelectedTopicId(null);
  }, [snap.sessionId]);
  const [speakerCtxMenu, setSpeakerCtxMenu] = useState<
    | { kind: 'utterance'; utteranceId: string; x: number; y: number }
    | { kind: 'partial'; startMs: number; x: number; y: number }
    | null
  >(null);
  const [creatingNewSpeaker, setCreatingNewSpeaker] = useState(false);
  const [newSpeakerName, setNewSpeakerName] = useState('');
  const [newSpeakerRole, setNewSpeakerRole] = useState<LiveSpeakerRole>('counterpart');
  const speakerCtxMenuRef = useRef<HTMLDivElement | null>(null);

  const openSpeakerCtxMenu = (
    e: React.MouseEvent,
    target: { kind: 'utterance'; utteranceId: string } | { kind: 'partial'; startMs: number }
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const maxW = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const maxH = typeof window !== 'undefined' ? window.innerHeight : 800;
    const x = Math.min(e.clientX, Math.max(12, maxW - 260));
    const y = Math.min(e.clientY, Math.max(12, maxH - 320));
    setSpeakerCtxMenu({ ...target, x, y });
    setCreatingNewSpeaker(false);
    setNewSpeakerName('');
    setNewSpeakerRole('counterpart');
  };

  useEffect(() => {
    if (!speakerCtxMenu) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (speakerCtxMenuRef.current && !speakerCtxMenuRef.current.contains(e.target as Node)) {
        setSpeakerCtxMenu(null);
        setCreatingNewSpeaker(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSpeakerCtxMenu(null);
        setCreatingNewSpeaker(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [speakerCtxMenu]);

  useEffect(() => {
    try {
      localStorage.setItem(PREP_STORAGE_KEY, JSON.stringify(form));
    } catch {
      // ignore storage errors
    }
  }, [form]);

  useEffect(() => {
    let active = true;
    void listAudioInputDevices()
      .then((list) => {
        if (!active) return;
        setDevices(list);
        if (!selectedDeviceId && list.length > 0) {
          setSelectedDeviceId(list[0].deviceId);
        }
      })
      .catch(() => {
        // ignore
      });

    if (isTauriRuntime()) {
      void getDependenciesStatus()
        .then((st) => {
          if (active && st) setLocalModelsReady(Boolean(st.modelsReady));
        })
        .catch(() => {});
    } else {
      void checkSidecarCapabilities()
        .then((cap) => {
          if (!active || !cap) return;
          const eng = cap.engines ?? {};
          const ready = Boolean(cap.asrReady && eng.silero_vad);
          setLocalModelsReady(ready);
          if (cap.volcEnvConfigured) setVolcEnvConfigured(true);
        })
        .catch(() => {});
    }

    return () => {
      active = false;
      if (testHandleRef.current) {
        void testHandleRef.current.stop();
        testHandleRef.current = null;
      }
    };
  }, []);

  // Auto-scroll transcript when new utterances or partial arrive
  useEffect(() => {
    if (!autoScroll) return;
    const el = transcriptScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [snap.utterances.length, snap.partial?.text, autoScroll]);

  const effectiveConfigs = useMemo(() => {
    const platformCfg = getCachedAiPlatformConfig();
    const asr = platformCfg
      ? buildAsrConfigFromPlatform(platformCfg, state.asrConfig)
      : state.asrConfig;
    const llm = platformCfg
      ? buildLlmConfigForFeature(platformCfg, 'transcript_analysis', state.llmConfig)
      : state.llmConfig;
    return { asr, llm };
  }, [state.asrConfig, state.llmConfig]);

  const hasVolcCreds = useMemo(() => {
    const a = effectiveConfigs.asr;
    return Boolean(
      a.volcApiKey?.trim() ||
        (a.volcAppId?.trim() && a.volcAccessToken?.trim()) ||
        (a.volcAccessKeyId?.trim() && a.volcSecretAccessKey?.trim()) ||
        volcEnvConfigured
    );
  }, [effectiveConfigs.asr, volcEnvConfigured]);

  const hasLlmCreds = useMemo(() => {
    const l = effectiveConfigs.llm as { apiKey?: string; forceLocalOnly?: boolean };
    return Boolean(!l.forceLocalOnly && l.apiKey?.trim());
  }, [effectiveConfigs.llm]);

  const canStart = useMemo(() => {
    if (form.asrEngine === 'volcengine') return hasVolcCreds;
    if (form.asrEngine === 'local') return localModelsReady !== false;
    return hasVolcCreds || localModelsReady !== false;
  }, [form.asrEngine, hasVolcCreds, localModelsReady]);

  const handleToggleTestMic = async () => {
    if (testingMic && testHandleRef.current) {
      await testHandleRef.current.stop();
      testHandleRef.current = null;
      setTestingMic(false);
      setTestLevel(0);
      return;
    }
    try {
      const handle = await startLiveAudioCapture({
        deviceId: selectedDeviceId || undefined,
        onChunk: () => {},
        onLevel: (rms) => setTestLevel(rms),
      });
      testHandleRef.current = handle;
      setTestingMic(true);
    } catch (err) {
      onNotify(`麦克风测试失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleStartRecording = async () => {
    if (testingMic && testHandleRef.current) {
      await testHandleRef.current.stop();
      testHandleRef.current = null;
      setTestingMic(false);
    }

    const counterpartDefault =
      form.scenario === 'listen' ? '主讲人' : form.scenario === 'chat' ? '参与者' : '嘉宾';
    const selfDefault = form.scenario === 'dialogue' ? '主持人' : '我';
    const selfName = form.selfName.trim() || selfDefault;
    const parsedCounterparts = form.counterpartName
      .split(/[,，、/]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const primaryCounterpartName = parsedCounterparts[0] || counterpartDefault;

    let speakers: LiveSpeaker[] = [];
    let effectiveSpeakerCount = form.speakerCount;
    let firstSpeakerId = 'spk_self';

    if (form.scenario === 'listen') {
      // 演讲模式：1 位主讲人 + 可选分离现场提问/私下讨论槽位
      speakers = [
        {
          id: 'spk_other_1',
          name: primaryCounterpartName,
          role: 'counterpart',
          speakerKind: 'keynote',
        },
      ];
      if (form.captureAudience) {
        speakers.push({
          id: 'spk_audience',
          name: '提问/私下讨论',
          role: 'self',
          speakerKind: 'audience',
        });
      }
      effectiveSpeakerCount = speakers.length;
      firstSpeakerId = 'spk_other_1';
    } else if (form.scenario === 'dialogue') {
      // 对谈模式：固定人数，有或者没有主持人
      const fixedCount = Math.max(2, Math.min(6, form.speakerCount));
      effectiveSpeakerCount = fixedCount;
      if (form.hasHost) {
        speakers.push({
          id: 'spk_self',
          name: selfName,
          role: 'self',
          speakerKind: 'host',
        });
        for (let i = 1; i < fixedCount; i++) {
          const guestName =
            parsedCounterparts[i - 1] ||
            (fixedCount === 2 ? primaryCounterpartName : `${counterpartDefault}${i}`);
          speakers.push({
            id: `spk_other_${i}`,
            name: guestName,
            role: 'counterpart',
            speakerKind: 'guest',
          });
        }
        firstSpeakerId = 'spk_self';
      } else {
        for (let i = 1; i <= fixedCount; i++) {
          const guestName = parsedCounterparts[i - 1] || `${counterpartDefault}${i}`;
          speakers.push({
            id: `spk_other_${i}`,
            name: guestName,
            role: 'counterpart',
            speakerKind: 'guest',
          });
        }
        firstSpeakerId = 'spk_other_1';
      }
    } else {
      // 聊天模式：自由发言讨论，无需预先指定人数与称呼，录制中自动识别发言人
      effectiveSpeakerCount = 0;
      speakers = [
        {
          id: 'spk_1',
          name: '发言人 1',
          role: 'counterpart',
          speakerKind: 'guest',
        },
      ];
      firstSpeakerId = 'spk_1';
    }

    const outline = form.outlineText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((text, idx) => ({ id: `ol_${idx + 1}`, text }));

    const targetFields =
      form.scenario === 'chat' || form.scenario === 'interview'
        ? form.targetFieldsText
            .split(/\r?\n|[,，、]+/)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 12)
            .map((label, idx) => ({ id: `tf_${idx + 1}`, label }))
        : undefined;

    const counterpartNames = speakers
      .filter((s) => s.role === 'counterpart')
      .map((s) => s.name);

    const isChatScenario = form.scenario === 'chat';
    const prep: LiveSessionPrep = {
      scenario: form.scenario,
      title: form.title.trim() || form.topic.trim() || '未命名录制',
      topic: form.topic.trim(),
      goals: form.goals.trim(),
      counterpartName: isChatScenario ? '' : primaryCounterpartName,
      counterpartNames: isChatScenario ? [] : counterpartNames,
      counterpartBackground: form.counterpartBackground.trim(),
      selfName: isChatScenario ? '' : selfName,
      speakerCount: effectiveSpeakerCount,
      firstSpeakerId,
      hasHost: form.scenario === 'dialogue' ? form.hasHost : undefined,
      captureAudience: form.scenario === 'listen' ? form.captureAudience : undefined,
      asrEngine: form.asrEngine,
      enableStreamCorrection: form.enableStreamCorrection,
      speakerAnalysisMode: form.speakerAnalysisMode,
      outline,
      targetFields: targetFields && targetFields.length > 0 ? targetFields : undefined,
    };

    const projectWithOverride: PodcastProjectState = form.volcStreamResourceId.trim()
      ? {
          ...state,
          asrConfig: {
            ...state.asrConfig,
            volcStreamResourceId: form.volcStreamResourceId.trim(),
          },
        }
      : state;

    await startLiveSession({
      prep,
      speakers,
      deviceId: selectedDeviceId || undefined,
      projectState: projectWithOverride,
    });
  };

  const scrollToUtteranceMs = (ms: number) => {
    if (snap.phase === 'stopped' && audioRef.current) {
      const sec = Math.max(0, ms / 1000);
      audioRef.current.currentTime = sec;
      setAudioCurrentMs(ms);
    }
    const hit = snap.utterances.find((u) => u.endMs >= ms) ?? snap.utterances[0];
    if (!hit) return;
    setAutoScroll(false);
    setHighlightedUttId(hit.id);
    const el = document.getElementById(`live-utt-${hit.id}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => {
      setHighlightedUttId((cur) => (cur === hit.id ? null : cur));
    }, 1600);
  };

  const handleOpenReportFile = async () => {
    if (isTauriRuntime()) {
      try {
        const selected = await openFileDialog({
          multiple: false,
          title: '打开录制分析报告 (analysis-report.json / session.json)',
          filters: [{ name: '录制报告 JSON', extensions: ['json'] }],
        });
        if (typeof selected === 'string' && selected.trim()) {
          const restored = await openLiveSessionFromPath(selected.trim());
          onNotify(`已打开录制报告：${restored.title}`);
        }
      } catch (err) {
        onNotify(`打开报告失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      reportFileInputRef.current?.click();
    }
  };

  const handleWebReportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const restored = await openLiveSessionFromJsonText(text, file.name);
      onNotify(`已打开录制报告：${restored.title}`);
    } catch (err) {
      onNotify(`解析报告失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleTogglePlayAudio = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch((err) => {
        onNotify(`音频播放失败：${err instanceof Error ? err.message : String(err)}`);
      });
    } else {
      audio.pause();
    }
  };

  const handleCyclePlaybackRate = () => {
    const rates = [1, 1.25, 1.5, 2];
    const next = rates[(rates.indexOf(playbackRate) + 1) % rates.length];
    setPlaybackRate(next);
    if (audioRef.current) {
      audioRef.current.playbackRate = next;
    }
  };

  const suspectedDuplicates = useMemo(
    () => findSuspectedDuplicateSpeakers(snap),
    [snap.speakers, snap.utterances]
  );

  const handleExportMarkdown = async () => {
    const md = buildLiveSessionMarkdown(snap);
    const baseName = (snap.title || '录制纪要').replace(/[\\/:*?"<>|]/g, '_');
    const saved = await saveTextOrJsonFile(`${baseName}-纪要.md`, md, 'Markdown 纪要', ['md']);
    if (saved) {
      onNotify(`纪要已导出：${saved}`);
    }
  };

  const handleCopyMarkdown = async () => {
    const md = buildLiveSessionMarkdown(snap);
    await navigator.clipboard.writeText(md);
    onNotify('已复制完整 Markdown 纪要到剪贴板');
  };

  const speakerMap = useMemo(() => {
    const m = new Map<string, { speaker: LiveSpeaker; idx: number }>();
    snap.speakers.forEach((s, idx) => m.set(s.id, { speaker: s, idx }));
    return m;
  }, [snap.speakers]);

  const summariesAfterUtt = useMemo(() => {
    const m = new Map<string, Array<{ speakerId: string; startMs: number; summary: string }>>();
    if (snap.utterances.length === 0) return m;
    for (const ts of snap.turnSummaries) {
      let target: LiveUtterance | undefined;
      for (const u of snap.utterances) {
        if (u.startMs >= ts.startMs) {
          target = u;
          break;
        }
      }
      const key = (target ?? snap.utterances[snap.utterances.length - 1]).id;
      const arr = m.get(key) ?? [];
      arr.push(ts);
      m.set(key, arr);
    }
    return m;
  }, [snap.turnSummaries, snap.utterances]);

  const uploadStates = useMemo(
    () => computeUtteranceUploadStates(snap),
    [
      snap.utterances,
      snap.analyzedUpToUtteranceId,
      snap.analyzingUpToUtteranceId,
      snap.llmStatus,
    ]
  );

  const pendingStats = useMemo(() => {
    let count = 0;
    let chars = 0;
    for (const u of snap.utterances) {
      if (uploadStates.get(u.id) === 'pending') {
        count += 1;
        chars += u.text.length;
      }
    }
    return { count, chars };
  }, [snap.utterances, uploadStates]);

  const displayBlocks = useMemo<AggregatedUtteranceBlock[]>(() => {
    if (!aggregateTranscript) {
      return snap.utterances.map((u) => buildSingleUtteranceBlock(u));
    }
    return aggregateLiveUtterances(snap.utterances);
  }, [snap.utterances, aggregateTranscript]);

  // ---------------- 1. IDLE (PREP FORM) ----------------
  if (snap.phase === 'idle') {
    const isListenForm = form.scenario === 'listen';
    const isDialogueForm = form.scenario === 'dialogue';
    const isChatForm = form.scenario === 'chat';
    const counterpartLabel = isListenForm
      ? '主讲人 / 分享嘉宾'
      : isDialogueForm
        ? form.hasHost
          ? '对谈嘉宾称呼（多位用逗号分隔）'
          : '对谈参与者称呼（多位用逗号分隔）'
        : '参与人称呼（多位用逗号分隔）';
    const bgPlaceholder = isListenForm
      ? '例如：某公司技术负责人，我想重点关注成本控制与工程落地难点'
      : isChatForm
        ? '例如：产品、研发与设计同事一起脑暴 Q4 AI 功能优先级'
        : '例如：前某大厂架构师，目前创业做开源音视频工具';

    return (
      <div className="flex-1 min-w-0 h-full overflow-y-auto bg-zinc-950 p-6 flex items-start justify-center">
        <div className="w-full max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-900/75 p-6 shadow-2xl space-y-5 my-auto">
          <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-400 flex items-center justify-center">
                <Mic className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-bold text-zinc-100">实时录制与 AI 对话助手</h2>
                <p className="text-xs text-zinc-400">
                  {isListenForm
                    ? '演讲模式：主讲人核心信息提炼（议题相对固定），自动分离并过滤旁听私下讨论与现场提问'
                    : isDialogueForm
                      ? '对谈模式：固定人数多方对话（可选有/无主持人），议题相对固定，持续提炼观点碰撞'
                      : '聊天模式：自由发言讨论，无需预设人数与称呼，自动识别发言人并追踪议题流转'}
                </p>
              </div>
            </div>

            <div className="flex items-center bg-zinc-950 p-1 rounded-lg border border-zinc-800">
              {(
                [
                  { id: 'chat', label: '聊天' },
                  { id: 'dialogue', label: '对谈' },
                  { id: 'listen', label: '演讲' },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      scenario: item.id,
                      speakerCount:
                        item.id === 'listen'
                          ? 1
                          : Math.max(2, f.speakerCount <= 1 ? 2 : f.speakerCount),
                    }))
                  }
                  className={`px-3 py-1 rounded-md text-xs font-semibold transition cursor-pointer ${
                    form.scenario === item.id
                      ? 'bg-rose-600 text-white shadow'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* 识别引擎与状态提示 */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3.5 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-zinc-300">实时语音识别引擎</span>
              <div className="flex items-center bg-zinc-900 p-0.5 rounded-lg border border-zinc-800">
                {(
                  [
                    { id: 'auto', label: '自动（推荐）' },
                    { id: 'volcengine', label: '火山云端' },
                    { id: 'local', label: '本地离线' },
                  ] as const
                ).map((eng) => (
                  <button
                    key={eng.id}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, asrEngine: eng.id }))}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition cursor-pointer ${
                      form.asrEngine === eng.id
                        ? 'bg-blue-600 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {eng.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 pt-1 border-t border-zinc-800/80">
              <label className="flex items-center gap-2 text-xs text-zinc-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.enableStreamCorrection}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, enableStreamCorrection: e.target.checked }))
                  }
                  className="rounded border-zinc-600 bg-zinc-900 text-cyan-500"
                />
                <span>
                  启用云端流式辅助纠正
                  <span className="text-[11px] text-zinc-400 ml-1.5">
                    （本地模型秒出字 + 云端大模型后台流式纠正错别字与热词）
                  </span>
                </span>
              </label>
            </div>

            <div className="space-y-1.5 pt-1.5 border-t border-zinc-800/80">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-zinc-300">发言人分析方式</span>
                <div className="flex items-center bg-zinc-900 p-0.5 rounded-lg border border-zinc-800">
                  {(
                    [
                      { id: 'hybrid', label: '声纹 + 内容（推荐）' },
                      { id: 'voiceprint', label: '仅声纹' },
                      { id: 'content', label: '内容优先' },
                    ] as const
                  ).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, speakerAnalysisMode: m.id }))}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition cursor-pointer ${
                        form.speakerAnalysisMode === m.id
                          ? 'bg-emerald-600 text-white'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[11px] text-zinc-400">
                结合声纹特征与对话上下文（问答逻辑、称呼点名、角色视角）辨别与纠偏发言人，并推断身份姓名
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span
                className={`inline-flex items-center gap-1 ${
                  hasVolcCreds ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {hasVolcCreds ? '✓ 火山凭证已配置' : '○ 未配置火山凭证'}
              </span>
              <span
                className={`inline-flex items-center gap-1 ${
                  localModelsReady === true
                    ? 'text-emerald-400'
                    : localModelsReady === false
                      ? 'text-amber-400'
                      : 'text-zinc-400'
                }`}
              >
                {localModelsReady === true
                  ? '✓ 本地 SenseVoice 模型就绪'
                  : localModelsReady === false
                    ? '○ 本地模型未下载'
                    : '… 检测本地模型'}
              </span>
              <span
                className={`inline-flex items-center gap-1 ${
                  hasLlmCreds ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {hasLlmCreds ? '✓ 大模型 AI 洞察已启用' : '○ 未配置大模型 Key（仅转写）'}
              </span>

              <div className="ml-auto flex items-center gap-2">
                {localModelsReady === false && (
                  <button
                    type="button"
                    onClick={onOpenDepGuide}
                    className="text-xs text-blue-400 hover:underline cursor-pointer"
                  >
                    打开依赖向导
                  </button>
                )}
                <button
                  type="button"
                  onClick={onOpenAiPlatform}
                  className="text-xs text-blue-400 hover:underline cursor-pointer"
                >
                  配置 AI 平台
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div className="space-y-1">
              <label className="text-xs text-zinc-400">录制标题（可选）</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder={
                  isListenForm
                    ? '例如：AI Agent 工程化实践分享'
                    : isChatForm
                      ? '例如：产品周会 / 多人头脑风暴'
                      : '例如：EP24 深度对谈'
                }
                className={FORM_INPUT_CLS}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-zinc-400">
                {isListenForm ? '讲座主题 / 关注目标' : isChatForm ? '核心主题 / 讨论主线' : '本次话题 / 目标'}
              </label>
              <input
                type="text"
                value={form.topic}
                onChange={(e) => setForm((f) => ({ ...f, topic: e.target.value }))}
                placeholder={
                  isListenForm
                    ? '例如：2026 年度架构演进、了解成本控制与落地难点'
                    : isChatForm
                      ? '例如：Q4 产品规划与 AI 功能落地（用于评估议题相关性）'
                      : '例如：复盘创业转折点、技术选型与经验总结'
                }
                className={FORM_INPUT_CLS}
              />
            </div>

            {!isChatForm && (
              <>
                <div className="space-y-1">
                  <label className="text-xs text-zinc-400">{counterpartLabel}</label>
                  <input
                    type="text"
                    value={form.counterpartName}
                    onChange={(e) => setForm((f) => ({ ...f, counterpartName: e.target.value }))}
                    placeholder={
                      isListenForm
                        ? '主讲人姓名'
                        : '例如：嘉宾A, 嘉宾B'
                    }
                    className={FORM_INPUT_CLS}
                  />
                </div>

                {isListenForm ? (
                  <div className="space-y-1">
                    <label className="text-xs text-zinc-400">现场声道分离</label>
                    <label
                      className="w-full h-9 flex items-center gap-2.5 px-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 cursor-pointer"
                      title="仅重点提炼主讲人信息，自动过滤旁听私下闲聊"
                    >
                      <input
                        type="checkbox"
                        checked={form.captureAudience}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, captureAudience: e.target.checked }))
                        }
                        className="rounded border-zinc-600 bg-zinc-900 text-rose-500 shrink-0"
                      />
                      <span className="font-medium text-zinc-100 truncate">
                        分离现场提问 / 私下讨论
                      </span>
                    </label>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-xs text-zinc-400">
                        {isDialogueForm
                          ? form.hasHost
                            ? '主持人称呼'
                            : '对谈结构'
                          : '我的称呼'}
                      </label>
                      {isDialogueForm && !form.hasHost ? (
                        <button
                          type="button"
                          onClick={() => setForm((f) => ({ ...f, hasHost: true }))}
                          className="w-full h-9 px-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-amber-300 hover:border-amber-500/50 transition cursor-pointer text-left truncate"
                          title="点击切换为有主持人模式"
                        >
                          无主持人 (点击切换)
                        </button>
                      ) : (
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            value={form.selfName}
                            onChange={(e) => setForm((f) => ({ ...f, selfName: e.target.value }))}
                            className="w-full min-w-0 h-9 px-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-blue-500"
                          />
                          {isDialogueForm && (
                            <button
                              type="button"
                              onClick={() => setForm((f) => ({ ...f, hasHost: false }))}
                              className="shrink-0 h-9 px-2 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer"
                              title="切换为无主持人平等对谈"
                            >
                              去主持
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-zinc-400">
                        {isDialogueForm ? '固定人数' : '讨论人数'}
                      </label>
                      <div className="relative">
                        <select
                          value={Math.max(2, form.speakerCount)}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, speakerCount: Number(e.target.value) }))
                          }
                          className={FORM_SELECT_CLS}
                        >
                          <option value={2}>2 人对谈</option>
                          <option value={3}>3 人对谈</option>
                          <option value={4}>4 人对谈</option>
                          <option value={5}>5 人对谈</option>
                          <option value={6}>6 人对谈</option>
                        </select>
                        <ChevronDown className="w-3.5 h-3.5 text-zinc-400 pointer-events-none absolute right-2 top-1/2 -translate-y-1/2" />
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div className="space-y-1">
              <label className="text-xs text-zinc-400">
                {isListenForm
                  ? '主讲人背景 / 关注重点（帮助 AI 总结与推荐提问）'
                  : isChatForm
                    ? '参与方背景 / 讨论上下文（帮助 AI 评估议题相关性）'
                    : '对方背景资料（帮助 AI 更好追问）'}
              </label>
              <textarea
                rows={3}
                value={form.counterpartBackground}
                onChange={(e) =>
                  setForm((f) => ({ ...f, counterpartBackground: e.target.value }))
                }
                placeholder={bgPlaceholder}
                className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-blue-500 resize-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-zinc-400">
                {isListenForm
                  ? '关注议程 / 想弄懂的问题（可选，每行一条）'
                  : isChatForm
                    ? '参考议题 / 关注方向（可选，每行一条，用于对照流转）'
                    : '沟通提纲（每行一个问题，实时跟踪覆盖）'}
              </label>
              <textarea
                rows={3}
                value={form.outlineText}
                onChange={(e) => setForm((f) => ({ ...f, outlineText: e.target.value }))}
                placeholder={
                  isListenForm
                    ? '核心架构是如何演进的？\n相比传统方案成本下降了多少？\n落地时最大的坑是什么？'
                    : isChatForm
                      ? '目前最大的卡点在哪里？\n各自对方案优先级的看法？\n下一步分工与时间节点？'
                      : '为什么决定做这件事？\n当时遇到的最大阻力是什么？\n接下来的规划？'
                }
                className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-blue-500 resize-none"
              />
            </div>
          </div>

          {isChatForm && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-xs text-zinc-400">
                  希望聊透的关键信息 / 待确认事项（可选，每行一项或逗号分隔）
                </label>
                <span className="text-[11px] text-cyan-400/90">
                  录制中将实时追踪获取状态并适时提醒推荐提问
                </span>
              </div>
              <textarea
                rows={2}
                value={form.targetFieldsText}
                onChange={(e) => setForm((f) => ({ ...f, targetFieldsText: e.target.value }))}
                placeholder="例如：核心结论、责任人分工、预算范围、排期节点"
                className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500 resize-none"
              />
            </div>
          )}

          {/* 麦克风选择与电平测试 */}
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
            <Volume2 className="w-4 h-4 text-zinc-400 shrink-0" />
            <div className="relative flex-1 min-w-48">
              <select
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
                className="w-full h-9 pl-3 pr-7 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-blue-500 appearance-none cursor-pointer"
              >
                {devices.length === 0 ? (
                  <option value="">默认系统麦克风</option>
                ) : (
                  devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))
                )}
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-zinc-400 pointer-events-none absolute right-2 top-1/2 -translate-y-1/2" />
            </div>
            <button
              type="button"
              onClick={() => void handleToggleTestMic()}
              className="h-9 px-3 rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 cursor-pointer inline-flex items-center"
            >
              {testingMic ? '停止测试' : '测试电平'}
            </button>
            <div className="w-24 h-2 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all duration-75"
                style={{ width: `${Math.min(100, Math.round(testLevel * 450))}%` }}
              />
            </div>
          </div>

          {/* 高级选项折叠 */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-xs text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1 cursor-pointer"
            >
              <Settings2 className="w-3.5 h-3.5" />
              <span>{showAdvanced ? '收起高级选项' : '高级选项（流式 Resource ID 等）'}</span>
            </button>
            {showAdvanced && (
              <div className="mt-2 p-3 rounded-xl border border-zinc-800 bg-zinc-950/60 space-y-2">
                <div className="space-y-1">
                  <label className="text-xs text-zinc-400">
                    火山流式 Resource ID（留空则依次尝试 volc.bigasr.sauc.duration / volc.seedasr.sauc.duration）
                  </label>
                  <input
                    type="text"
                    value={form.volcStreamResourceId}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, volcStreamResourceId: e.target.value }))
                    }
                    placeholder="volc.bigasr.sauc.duration"
                    className="w-full h-9 px-3 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 font-mono focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-zinc-800">
            <div className="flex items-center gap-2">
              <input
                ref={reportFileInputRef}
                type="file"
                accept=".json"
                onChange={(e) => void handleWebReportFileChange(e)}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => void handleOpenReportFile()}
                className="px-3.5 py-2 rounded-xl border border-zinc-700 bg-zinc-800/80 hover:bg-zinc-700 text-xs font-medium text-zinc-200 inline-flex items-center gap-1.5 cursor-pointer transition"
              >
                <FolderOpen className="w-3.5 h-3.5 text-blue-400" />
                <span>打开已有录音/报告</span>
              </button>
            </div>

            <div className="flex items-center gap-3">
              {!canStart && (
                <span className="text-xs text-amber-400">
                  当前所选识别引擎缺少凭证或本地模型，请先配置后再开始
                </span>
              )}
              <button
                type="button"
                disabled={!canStart}
                onClick={() => void handleStartRecording()}
                className="px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-45 disabled:cursor-not-allowed text-white text-sm font-semibold inline-flex items-center gap-2 shadow-lg cursor-pointer transition"
              >
                <Mic className="w-4 h-4" />
                <span>开始录制</span>
              </button>
            </div>
          </div>

          {recentSessions.length > 0 && (
            <div className="pt-4 border-t border-zinc-800 space-y-2.5">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5 text-blue-400" />
                  <span>最近录制与分析报告</span>
                </h3>
                <span className="text-[11px] text-zinc-500">
                  点击可直接重新打开录音与分析报告
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-0.5">
                {recentSessions.map((item) => {
                  const scLabel =
                    item.scenario === 'listen'
                      ? '演讲'
                      : item.scenario === 'dialogue'
                        ? '对谈'
                        : item.scenario === 'chat'
                          ? '聊天'
                          : '采访';
                  return (
                    <div
                      key={item.reportPath}
                      className="group rounded-xl border border-zinc-800 bg-zinc-950/70 hover:border-blue-500/45 hover:bg-zinc-900/90 p-2.5 flex items-start justify-between gap-2 transition"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (!isTauriRuntime()) {
                            onNotify('浏览器预览模式请通过「打开已有录音/报告」选择本地 JSON 文件');
                            return;
                          }
                          void openLiveSessionFromPath(item.reportPath)
                            .then((restored) => {
                              onNotify(`已打开录制报告：${restored.title}`);
                            })
                            .catch((err) => {
                              onNotify(
                                `打开失败（文件可能已移动）：${err instanceof Error ? err.message : String(err)}`
                              );
                            });
                        }}
                        className="min-w-0 flex-1 text-left space-y-1 cursor-pointer"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="px-1.5 py-0.5 rounded bg-blue-500/15 border border-blue-500/30 text-[10px] text-blue-300 shrink-0">
                            {scLabel}
                          </span>
                          <span className="text-xs font-semibold text-zinc-100 truncate">
                            {item.title}
                          </span>
                        </div>
                        <div className="text-[11px] text-zinc-400 flex flex-wrap items-center gap-2 font-mono">
                          <span>{formatLiveMmSs(item.durationMs)}</span>
                          <span>·</span>
                          <span>{item.utteranceCount} 段</span>
                          <span>·</span>
                          <span>{item.speakerCount} 人</span>
                          <span>·</span>
                          <span className="text-zinc-500">
                            {new Date(item.updatedAt).toLocaleDateString('zh-CN')}
                          </span>
                        </div>
                      </button>
                      <button
                        type="button"
                        title="从最近列表移除"
                        onClick={() => {
                          setRecentSessions(removeRecentLiveSession(item.reportPath));
                        }}
                        className="p-1 rounded text-zinc-500 hover:text-rose-400 hover:bg-zinc-800 opacity-0 group-hover:opacity-100 transition cursor-pointer shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---------------- 2. FATAL ERROR (NO UTTERANCES) ----------------
  if (snap.phase === 'error' && snap.utterances.length === 0) {
    const isListenSummary = snap.scenario === 'listen';
    return (
      <div className="flex-1 min-w-0 h-full overflow-y-auto bg-zinc-950 p-6 flex items-start justify-center">
        <div className="w-full max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-2xl space-y-5 my-auto">
          <div className="flex items-start justify-between gap-4 border-b border-zinc-800 pb-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                {snap.phase === 'error' ? (
                  <AlertTriangle className="w-5 h-5 text-rose-400" />
                ) : (
                  <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                )}
                <h2 className="text-base font-bold text-zinc-100">
                  {snap.phase === 'error' ? '录制异常中断' : '录制已结束'} · {snap.title}
                </h2>
              </div>
              <p className="text-xs text-zinc-400">
                时长 {formatLiveMmSs(snap.elapsedMs)} · 共 {snap.utterances.length} 段发言
              </p>
              {snap.outputDir && (
                <p className="text-[11px] text-zinc-500 font-mono break-all">
                  保存目录：{snap.outputDir}
                </p>
              )}
              {snap.minutesPath && (
                <p className="text-[11px] text-emerald-400 font-mono break-all">
                  已自动保存纪要：{snap.minutesPath}
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={() => void resetLiveSession()}
              className="px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 inline-flex items-center gap-1.5 cursor-pointer shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>新建录制</span>
            </button>
          </div>

          {snap.errorMessage && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-300">
              {snap.errorMessage}
            </div>
          )}

          {snap.finalSummary ? (
            <div className="space-y-4">
              {snap.finalSummary.overview && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 space-y-1.5">
                  <h3 className="text-xs font-semibold text-zinc-300">全场总结</h3>
                  <p className="text-xs text-zinc-200 leading-relaxed">
                    {snap.finalSummary.overview}
                  </p>
                </div>
              )}

              {snap.finalSummary.keyTakeaways.length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 space-y-2">
                  <h3 className="text-xs font-semibold text-zinc-300">
                    {isListenSummary ? '关键收获' : '关键要点'}
                  </h3>
                  <ul className="space-y-1 text-xs text-zinc-200 list-disc pl-4">
                    {snap.finalSummary.keyTakeaways.map((k, i) => (
                      <li key={i}>{k}</li>
                    ))}
                  </ul>
                </div>
              )}

              {snap.finalSummary.nextSteps.length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 space-y-2">
                  <h3 className="text-xs font-semibold text-zinc-300">
                    {isListenSummary ? '延伸思考与行动' : '下一步行动'}
                  </h3>
                  <ul className="space-y-1 text-xs text-emerald-300 list-disc pl-4">
                    {snap.finalSummary.nextSteps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            snap.keyPoints.length > 0 && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 space-y-2">
                <h3 className="text-xs font-semibold text-zinc-300">过程关键要点</h3>
                <ul className="space-y-1 text-xs text-zinc-200 list-disc pl-4">
                  {snap.keyPoints.map((k, i) => (
                    <li key={i}>{k}</li>
                  ))}
                </ul>
              </div>
            )
          )}

          <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2 border-t border-zinc-800">
            <button
              type="button"
              onClick={() => void handleCopyMarkdown()}
              className="px-4 py-2 rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 inline-flex items-center gap-1.5 cursor-pointer"
            >
              <ClipboardCopy className="w-3.5 h-3.5" />
              <span>复制纪要</span>
            </button>
            <button
              type="button"
              onClick={() => void handleExportMarkdown()}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>导出纪要 Markdown</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------------- 3. RECORDING / PAUSED / STARTING / STOPPING ----------------
  const isListenMode = snap.scenario === 'listen';
  const activeQuestions = snap.questions.filter((q) => q.status === 'new');
  const latestQuestions = activeQuestions.filter((q) => q.isLatest !== false);
  const historyPendingQuestions = activeQuestions.filter((q) => q.isLatest === false);
  const adoptedQuestions = snap.questions.filter((q) => q.status === 'adopted');
  const engineLabel =
    snap.asrEngine === 'local_sensevoice'
      ? '本地离线'
      : snap.asrEngine === 'volcengine_sauc_bigmodel'
        ? '火山云端'
        : '准备中';
  const modeBadge =
    snap.scenario === 'listen'
      ? snap.prep?.captureAudience !== false
        ? '演讲 · 主讲+提问分离'
        : '演讲 · 单主讲人'
      : snap.scenario === 'dialogue'
        ? `${snap.prep?.hasHost === false ? '对谈 · 无主持' : '对谈 · 有主持'} · ${snap.speakers.length}人`
        : snap.scenario === 'chat'
          ? `聊天 · ${snap.speakers.length}人自由讨论`
          : `采访 · 1问${Math.max(1, snap.speakers.length - 1)}答`;

  return (
    <div className="relative flex-1 min-w-0 h-full flex flex-col bg-zinc-950 overflow-hidden">
      {/* 停止收尾遮罩 */}
      {snap.phase === 'stopping' && (
        <div className="absolute inset-0 z-40 bg-zinc-950/80 backdrop-blur-xs flex items-center justify-center">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 px-6 py-5 flex items-center gap-3 shadow-2xl">
            <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
            <span className="text-sm font-medium text-zinc-100">
              正在收尾录音并生成会话纪要…
            </span>
          </div>
        </div>
      )}

      {/* 顶部控制条 */}
      {(() => {
        const isReviewMode = snap.phase === 'stopped' || snap.phase === 'error';
        const wavUrl = snap.wavPath
          ? buildPodAudioUrl(snap.wavPath, isTauriRuntime())
          : undefined;
        const effectiveDurationMs =
          audioDurationMs > 0 ? audioDurationMs : snap.elapsedMs;

        return (
          <div className="shrink-0 min-h-12 px-4 py-1.5 border-b border-zinc-800 bg-zinc-900/90 flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-3 min-w-0">
              {isReviewMode ? (
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border shrink-0 ${
                    snap.phase === 'error'
                      ? 'bg-rose-500/15 text-rose-300 border-rose-500/35'
                      : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
                  }`}
                >
                  {snap.phase === 'error' ? (
                    <AlertTriangle className="w-3.5 h-3.5" />
                  ) : (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  )}
                  <span>{snap.phase === 'error' ? '异常中断 · 回看' : '已保存 · 回看报告'}</span>
                  <span className="font-mono">{formatLiveMmSs(snap.elapsedMs)}</span>
                </span>
              ) : (
                <>
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border shrink-0 ${
                      snap.phase === 'starting'
                        ? 'bg-blue-500/15 text-blue-300 border-blue-500/35'
                        : snap.phase === 'paused'
                          ? 'bg-amber-500/15 text-amber-300 border-amber-500/35'
                          : 'bg-rose-500/15 text-rose-300 border-rose-500/35'
                    }`}
                  >
                    {snap.phase === 'starting' ? (
                      <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
                    ) : (
                      <span
                        className={`w-2 h-2 rounded-full ${
                          snap.phase === 'paused' ? 'bg-amber-400' : 'bg-rose-500 animate-pulse'
                        }`}
                      />
                    )}
                    <span>
                      {snap.phase === 'starting'
                        ? '正在启动麦克风…'
                        : snap.phase === 'paused'
                          ? '已暂停'
                          : 'REC'}
                    </span>
                    {snap.phase !== 'starting' && (
                      <span className="font-mono">{formatLiveMmSs(snap.elapsedMs)}</span>
                    )}
                  </span>

                  {/* 音量条 */}
                  <div className="w-20 h-2 rounded-full bg-zinc-800 overflow-hidden shrink-0" title="麦克风输入电平">
                    <div
                      className="h-full bg-emerald-400 transition-all duration-75"
                      style={{ width: `${Math.min(100, Math.round(micLevel * 450))}%` }}
                    />
                  </div>
                </>
              )}

              <span className="text-xs font-medium text-zinc-200 truncate max-w-[220px]" title={snap.title}>
                {snap.title}
              </span>
            </div>

            {/* 回看模式音频播放器 */}
            {isReviewMode && wavUrl && (
              <div className="flex items-center gap-2 px-2.5 py-1 rounded-xl border border-zinc-800 bg-zinc-950/80">
                <audio
                  ref={audioRef}
                  src={wavUrl}
                  onPlay={() => setIsPlayingAudio(true)}
                  onPause={() => setIsPlayingAudio(false)}
                  onEnded={() => setIsPlayingAudio(false)}
                  onTimeUpdate={(e) => {
                    setAudioCurrentMs(Math.round(e.currentTarget.currentTime * 1000));
                  }}
                  onLoadedMetadata={(e) => {
                    const dur = e.currentTarget.duration;
                    if (Number.isFinite(dur) && dur > 0) {
                      setAudioDurationMs(Math.round(dur * 1000));
                    }
                    e.currentTarget.playbackRate = playbackRate;
                  }}
                />
                <button
                  type="button"
                  onClick={handleTogglePlayAudio}
                  className="w-7 h-7 rounded-lg bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center cursor-pointer shrink-0"
                  title={isPlayingAudio ? '暂停录音' : '播放录音'}
                >
                  {isPlayingAudio ? (
                    <Pause className="w-3.5 h-3.5" />
                  ) : (
                    <Play className="w-3.5 h-3.5 ml-0.5" />
                  )}
                </button>
                <span className="text-[11px] font-mono text-zinc-300 shrink-0">
                  {formatLiveMmSs(audioCurrentMs)} / {formatLiveMmSs(effectiveDurationMs)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1000, effectiveDurationMs)}
                  value={Math.min(audioCurrentMs, Math.max(1000, effectiveDurationMs))}
                  onChange={(e) => {
                    const ms = Number(e.target.value);
                    setAudioCurrentMs(ms);
                    if (audioRef.current) {
                      audioRef.current.currentTime = ms / 1000;
                    }
                  }}
                  className="w-28 sm:w-36 accent-blue-500 cursor-pointer"
                />
                <button
                  type="button"
                  onClick={handleCyclePlaybackRate}
                  className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[10px] font-mono text-zinc-300 cursor-pointer"
                  title="切换播放倍速"
                >
                  {playbackRate}x
                </button>
              </div>
            )}

            <div className="flex items-center gap-2 shrink-0">
              <span className="px-2 py-0.5 rounded-md bg-rose-500/10 border border-rose-500/30 text-[11px] text-rose-300">
                {modeBadge}
              </span>

              {!isReviewMode ? (
                <>
                  <span className="px-2 py-0.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-300">
                    引擎：{engineLabel}
                  </span>

                  <span
                    title={snap.asrMessage ?? undefined}
                    className={`px-2 py-0.5 rounded-md border text-[11px] ${
                      snap.asrStatus === 'connected'
                        ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                        : snap.asrStatus === 'error'
                          ? 'bg-rose-500/10 text-rose-300 border-rose-500/30'
                          : 'bg-zinc-800 text-zinc-300 border-zinc-700'
                    }`}
                  >
                    ASR: {snap.asrStatus}
                  </span>

                  <span
                    title={snap.llmMessage ?? undefined}
                    className="px-2 py-0.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-300 inline-flex items-center gap-1"
                  >
                    {snap.llmStatus === 'thinking' && (
                      <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
                    )}
                    <span>
                      AI:{' '}
                      {snap.llmStatus === 'thinking'
                        ? '分析中'
                        : snap.llmStatus === 'disabled'
                          ? '未启用'
                          : snap.llmStatus === 'error'
                            ? '异常'
                            : '就绪'}
                    </span>
                  </span>

                  {snap.phase === 'recording' ? (
                    <button
                      type="button"
                      onClick={pauseLiveSession}
                      className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-100 inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Pause className="w-3.5 h-3.5" />
                      <span>暂停</span>
                    </button>
                  ) : snap.phase === 'paused' ? (
                    <button
                      type="button"
                      onClick={resumeLiveSession}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>继续</span>
                    </button>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => void stopLiveSession()}
                    className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs font-semibold text-white inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Square className="w-3 h-3 fill-current" />
                    <span>结束</span>
                  </button>
                </>
              ) : (
                <>
                  {isTauriRuntime() && snap.outputDir && (
                    <button
                      type="button"
                      onClick={() => {
                        void saveLiveReportAndMinutes(snap)
                          .then((res) => {
                            onNotify(
                              `已保存报告与纪要：${res.reportPath || res.minutesPath || snap.outputDir}`
                            );
                          })
                          .catch((err) => {
                            onNotify(
                              `保存失败：${err instanceof Error ? err.message : String(err)}`
                            );
                          });
                      }}
                      className="px-2.5 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-xs font-medium text-emerald-200 inline-flex items-center gap-1 cursor-pointer"
                      title={snap.reportPath ?? snap.outputDir ?? undefined}
                    >
                      <FileText className="w-3.5 h-3.5" />
                      <span>保存报告</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleCopyMarkdown()}
                    className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-200 inline-flex items-center gap-1 cursor-pointer"
                  >
                    <ClipboardCopy className="w-3.5 h-3.5" />
                    <span>复制纪要</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleExportMarkdown()}
                    className="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>导出纪要</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void resetLiveSession()}
                    className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-200 inline-flex items-center gap-1 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>新建录制</span>
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* 回退/非致命通知横幅 */}
      {snap.engineNotice && (
        <div className="shrink-0 px-4 py-1.5 bg-amber-500/15 border-b border-amber-500/30 text-xs text-amber-200 flex items-center justify-between gap-2">
          <span>{snap.engineNotice}</span>
          <button
            type="button"
            onClick={dismissLiveEngineNotice}
            className="p-0.5 hover:text-white cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 三栏主区域 */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* 左栏：上边是讲者基本情况（随收听分析动态扩展字段），下面还是原提问区 */}
        <aside className="w-[330px] xl:w-[350px] shrink-0 border-r border-zinc-800 bg-zinc-900/40 flex flex-col overflow-hidden">
          {/* 左上：讲者/发言人基本情况（支持切换不同人 & 合并疑似相同发言人） */}
          <div className="max-h-[48%] min-h-[190px] overflow-y-auto border-b border-zinc-800 p-3.5 space-y-2.5">
            {(() => {
              const primaryCounterpart =
                snap.speakers.find((s) => s.role === 'counterpart') ?? snap.speakers[0];
              const activeSpeaker =
                snap.speakers.find((s) => s.id === selectedProfileSpeakerId) ??
                primaryCounterpart ??
                snap.speakers[0] ??
                null;
              const activeSpeakerIdx = activeSpeaker
                ? Math.max(0, snap.speakers.findIndex((s) => s.id === activeSpeaker.id))
                : 0;
              const speakerDisplayName =
                activeSpeaker?.name ||
                snap.prep?.counterpartName?.trim() ||
                '待识别';
              const speakerKindLabel =
                activeSpeaker?.speakerKind === 'host'
                  ? '主持人'
                  : activeSpeaker?.speakerKind === 'guest'
                    ? '嘉宾'
                    : activeSpeaker?.speakerKind === 'keynote'
                      ? '主讲人'
                      : activeSpeaker?.speakerKind === 'audience'
                        ? '现场提问'
                        : activeSpeaker?.role === 'self'
                          ? '我方视角'
                          : '对方发言人';
              const roleBackground =
                activeSpeaker?.inferredIdentity?.trim() ||
                (activeSpeaker?.role === 'self'
                  ? `${speakerKindLabel}${snap.prep?.selfName ? ` · ${snap.prep.selfName}` : ''}`
                  : activeSpeaker?.id === primaryCounterpart?.id
                    ? snap.prep?.counterpartBackground?.trim() ||
                      snap.profile.background[0]?.text ||
                      speakerKindLabel
                    : speakerKindLabel);
              const flow = snap.topicFlow ?? [];
              const activeTopicIdx = (() => {
                const idx = flow.findIndex((f) => f.status === 'active');
                return idx !== -1 ? idx : flow.length - 1;
              })();
              const viewedTopicIdx = (() => {
                if (flow.length === 0) return -1;
                if (selectedTopicId) {
                  const matched = flow.findIndex(
                    (f, idx) => (f.id || `${f.topic}-${idx}`) === selectedTopicId
                  );
                  if (matched !== -1) return matched;
                }
                return activeTopicIdx;
              })();
              const viewedTopic = viewedTopicIdx >= 0 ? flow[viewedTopicIdx] : undefined;
              const topicLabel =
                viewedTopic?.topic ||
                snap.currentTopic?.trim() ||
                snap.prep?.topic?.trim() ||
                snap.title?.trim() ||
                '未设定';

              // 随收听分析动态计算当前选中发言人画像字段
              const targetSpeakerId = activeSpeaker?.id ?? null;
              const speakerAnalytics = computeLiveSpeechAnalytics(snap, targetSpeakerId);
              const speakerShare = speakerAnalytics.speakers.find(
                (s) => s.speakerId === targetSpeakerId
              );

              const dynamicFields: Array<{
                key: string;
                label: string;
                value: React.ReactNode;
              }> = [];

              if (speakerShare && speakerAnalytics.utteranceCount > 0) {
                dynamicFields.push({
                  key: 'share',
                  label: '发言占比',
                  value: (
                    <span className="text-zinc-200 font-mono">
                      {speakerShare.sharePct}% · {speakerShare.charCount} 字 ·{' '}
                      {speakerShare.utteranceCount} 段
                    </span>
                  ),
                });
              }

              if (speakerAnalytics.pace.overallCpm > 0) {
                dynamicFields.push({
                  key: 'pace',
                  label: '平均语速',
                  value: (
                    <span className="text-zinc-200">
                      <span className="font-mono">{speakerAnalytics.pace.overallCpm}</span> 字/分 ·{' '}
                      <span className="text-blue-300">{speakerAnalytics.pace.paceLabel}</span>
                    </span>
                  ),
                });
              }

              if (speakerAnalytics.utteranceCount >= 2) {
                dynamicFields.push({
                  key: 'pattern',
                  label: '表达风格',
                  value: (
                    <span className="text-emerald-300 font-medium">
                      {speakerAnalytics.habits.dominantPattern}
                    </span>
                  ),
                });
                dynamicFields.push({
                  key: 'density',
                  label: '信息密度',
                  value: (
                    <span className="text-zinc-200">
                      <span className="font-mono">{speakerAnalytics.density.score}</span>/100 ·{' '}
                      <span className="text-cyan-300">{speakerAnalytics.density.levelLabel}</span>
                    </span>
                  ),
                });
              }

              if (speakerAnalytics.fillers.topWords.length > 0) {
                const topText = speakerAnalytics.fillers.topWords
                  .slice(0, 2)
                  .map((w) => `${w.word}×${w.count}`)
                  .join(' · ');
                dynamicFields.push({
                  key: 'fillers',
                  label: '高频口语词',
                  value: <span className="text-amber-300">{topText}</span>,
                });
              }

              if (
                snap.profile.viewpoints.length > 0 ||
                snap.profile.stories.length > 0 ||
                snap.profile.background.length > 0
              ) {
                dynamicFields.push({
                  key: 'extracted',
                  label: '内容沉淀',
                  value: (
                    <span className="text-zinc-300 font-mono">
                      背景 {snap.profile.background.length} · 案例 {snap.profile.stories.length} · 观点{' '}
                      {snap.profile.viewpoints.length}
                    </span>
                  ),
                });
              }

              const handleSwitchSpeakerStep = (delta: number) => {
                if (snap.speakers.length <= 1) return;
                const nextIdx =
                  (activeSpeakerIdx + delta + snap.speakers.length) % snap.speakers.length;
                setSelectedProfileSpeakerId(snap.speakers[nextIdx].id);
              };

              return (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-bold text-zinc-200 flex items-center gap-1.5">
                      <UserCheck className="w-3.5 h-3.5 text-emerald-400" />
                      <span>{isListenMode ? '讲者基本情况' : '发言人基本情况'}</span>
                    </h3>
                    <div className="flex items-center gap-1">
                      {snap.speakers.length > 1 && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleSwitchSpeakerStep(-1)}
                            title="上一位发言人"
                            className="p-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer"
                          >
                            <ChevronLeft className="w-3.5 h-3.5" />
                          </button>
                          <span className="text-[10px] font-mono text-zinc-400 px-1">
                            {activeSpeakerIdx + 1}/{snap.speakers.length}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleSwitchSpeakerStep(1)}
                            title="下一位发言人"
                            className="p-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer"
                          >
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                      {snap.speakers.length >= 2 && (
                        <button
                          type="button"
                          onClick={() => {
                            setShowManualMerge((v) => {
                              const next = !v;
                              if (next && snap.speakers.length >= 2) {
                                const defTarget = activeSpeaker?.id ?? snap.speakers[0].id;
                                const defSrc =
                                  snap.speakers.find((s) => s.id !== defTarget)?.id ?? '';
                                setManualMergeTargetId(defTarget);
                                setManualMergeSourceId(defSrc);
                              }
                              return next;
                            });
                          }}
                          title="手动合并发言人"
                          className={`ml-1 px-1.5 py-0.5 rounded border text-[10px] inline-flex items-center gap-1 cursor-pointer ${
                            showManualMerge
                              ? 'bg-amber-500/20 border-amber-500/40 text-amber-200'
                              : 'bg-zinc-800 hover:bg-zinc-700 border-zinc-700 text-zinc-300'
                          }`}
                        >
                          <GitMerge className="w-3 h-3" />
                          <span>合并</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 疑似相同发言人自动合并提示 */}
                  {suspectedDuplicates.length > 0 && (
                    <div className="rounded-lg border border-amber-500/45 bg-amber-950/25 p-2 space-y-1.5 text-[11px]">
                      <div className="flex items-center justify-between gap-1 text-amber-200 font-semibold">
                        <span className="inline-flex items-center gap-1">
                          <GitMerge className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          <span>检测到疑似相同发言人 ({suspectedDuplicates.length})</span>
                        </span>
                      </div>
                      <div className="space-y-1">
                        {suspectedDuplicates.slice(0, 3).map((pair) => {
                          const pairKey = `${pair.sourceSpeakerId}->${pair.targetSpeakerId}`;
                          const swapped = Boolean(swappedDupPairs[pairKey]);
                          const srcId = swapped ? pair.targetSpeakerId : pair.sourceSpeakerId;
                          const tgtId = swapped ? pair.sourceSpeakerId : pair.targetSpeakerId;
                          const srcSpk = snap.speakers.find((s) => s.id === srcId);
                          const tgtSpk = snap.speakers.find((s) => s.id === tgtId);
                          if (!srcSpk || !tgtSpk) return null;
                          return (
                            <div
                              key={pairKey}
                              className="rounded border border-zinc-800 bg-zinc-950/75 px-2 py-1.5 flex items-center justify-between gap-1.5"
                            >
                              <div className="min-w-0">
                                <div className="text-zinc-100 truncate flex items-center gap-1">
                                  <span className="font-medium text-amber-200">{srcSpk.name}</span>
                                  <span className="text-zinc-500">→</span>
                                  <span className="font-medium text-emerald-300">{tgtSpk.name}</span>
                                  {pair.source && (
                                    <span className="px-1 py-0.2 rounded bg-zinc-800 border border-zinc-700 text-[9px] text-zinc-300 shrink-0">
                                      {pair.source === 'hybrid'
                                        ? '声纹+内容'
                                        : pair.source === 'content'
                                          ? '内容'
                                          : pair.source === 'name'
                                            ? '同名'
                                            : '声纹'}
                                    </span>
                                  )}
                                </div>
                                <div className="text-[10px] text-zinc-400 truncate">
                                  {pair.reason}
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  type="button"
                                  title="交换保留的发言人名称"
                                  onClick={() =>
                                    setSwappedDupPairs((prev) => ({
                                      ...prev,
                                      [pairKey]: !prev[pairKey],
                                    }))
                                  }
                                  className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer"
                                >
                                  <ArrowLeftRight className="w-3 h-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (mergeLiveSpeakers(srcId, tgtId)) {
                                      setSelectedProfileSpeakerId(tgtId);
                                      onNotify(
                                        `已将「${srcSpk.name}」合并至「${tgtSpk.name}」`
                                      );
                                    }
                                  }}
                                  className="px-2 py-0.5 rounded bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold text-[10px] cursor-pointer"
                                >
                                  合并
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* 手动合并面板 */}
                  {showManualMerge && snap.speakers.length >= 2 && (
                    <div className="rounded-lg border border-zinc-700 bg-zinc-950/85 p-2.5 space-y-2 text-[11px]">
                      <div className="flex items-center justify-between text-zinc-300 font-medium">
                        <span>手动合并发言人</span>
                        <button
                          type="button"
                          onClick={() => setShowManualMerge(false)}
                          className="text-zinc-500 hover:text-zinc-200 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
                        <select
                          value={manualMergeSourceId}
                          onChange={(e) => setManualMergeSourceId(e.target.value)}
                          className="h-7 px-1.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-200 text-[11px] min-w-0"
                        >
                          {snap.speakers.map((s) => (
                            <option key={s.id} value={s.id}>
                              移出: {s.name}
                            </option>
                          ))}
                        </select>
                        <span className="text-zinc-500">→</span>
                        <select
                          value={manualMergeTargetId}
                          onChange={(e) => setManualMergeTargetId(e.target.value)}
                          className="h-7 px-1.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-200 text-[11px] min-w-0"
                        >
                          {snap.speakers.map((s) => (
                            <option key={s.id} value={s.id}>
                              保留: {s.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="button"
                          disabled={
                            !manualMergeSourceId ||
                            !manualMergeTargetId ||
                            manualMergeSourceId === manualMergeTargetId
                          }
                          onClick={() => {
                            const srcName =
                              snap.speakers.find((s) => s.id === manualMergeSourceId)?.name ?? '';
                            const tgtName =
                              snap.speakers.find((s) => s.id === manualMergeTargetId)?.name ?? '';
                            if (mergeLiveSpeakers(manualMergeSourceId, manualMergeTargetId)) {
                              setSelectedProfileSpeakerId(manualMergeTargetId);
                              setShowManualMerge(false);
                              onNotify(`已将「${srcName}」合并至「${tgtName}」`);
                            }
                          }}
                          className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-45 text-white font-medium text-[11px] cursor-pointer"
                        >
                          确认合并
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 divide-y divide-zinc-800/80 text-[11px]">
                    <div className="grid grid-cols-[76px_1fr] items-center gap-2 px-2.5 py-1.5">
                      <span className="text-zinc-500 font-medium shrink-0">
                        {isListenMode ? '当前讲者' : '当前查看'}
                      </span>
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-zinc-100 font-semibold truncate">
                            {speakerDisplayName}
                          </span>
                          {activeSpeaker && (
                            <span className="px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-400 text-[10px] shrink-0">
                              {activeSpeaker.role === 'self' ? '我方' : '对方'}
                            </span>
                          )}
                        </div>
                        {activeSpeaker?.inferredName &&
                          activeSpeaker.inferredName !== activeSpeaker.name && (
                            <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-cyan-300">
                              <span>内容识别可能是「{activeSpeaker.inferredName}」</span>
                              <button
                                type="button"
                                onClick={() => {
                                  applyInferredSpeakerName(activeSpeaker.id);
                                  onNotify(`已采纳改名为「${activeSpeaker.inferredName}」`);
                                }}
                                className="px-1.5 py-0.2 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 cursor-pointer"
                              >
                                采纳改名
                              </button>
                              <button
                                type="button"
                                onClick={() => dismissInferredSpeakerName(activeSpeaker.id)}
                                className="px-1 py-0.2 rounded text-zinc-400 hover:text-zinc-200 cursor-pointer"
                              >
                                忽略
                              </button>
                            </div>
                          )}
                      </div>
                    </div>
                    <div className="grid grid-cols-[76px_1fr] items-start gap-2 px-2.5 py-1.5">
                      <span className="text-zinc-500 font-medium shrink-0">身份定位</span>
                      <div className="min-w-0 space-y-0.5">
                        <span className={roleBackground ? 'text-zinc-200 leading-snug block' : 'text-zinc-500 block'}>
                          {roleBackground || '待从发言中自动识别…'}
                        </span>
                        {activeSpeaker?.inferredIdentity && activeSpeaker.identityEvidence && (
                          <span className="text-[10px] text-zinc-400 block truncate" title={activeSpeaker.identityEvidence}>
                            依据：{activeSpeaker.identityEvidence}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-[76px_1fr] items-start gap-2 px-2.5 py-1.5">
                      <span className="text-zinc-500 font-medium shrink-0 pt-0.5">当前议题</span>
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="text-zinc-200 truncate font-medium" title={topicLabel}>
                            {topicLabel}
                          </span>
                          {flow.length > 1 && (
                            <div className="inline-flex items-center rounded border border-zinc-700 bg-zinc-900 overflow-hidden shrink-0">
                              <button
                                type="button"
                                disabled={viewedTopicIdx <= 0}
                                onClick={() => {
                                  const nextIdx = Math.max(0, viewedTopicIdx - 1);
                                  const t = flow[nextIdx];
                                  setSelectedTopicId(t.id || `${t.topic}-${nextIdx}`);
                                }}
                                className="px-1 py-0.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-35 cursor-pointer"
                                title="上一个议题"
                              >
                                <ChevronLeft className="w-2.5 h-2.5" />
                              </button>
                              <span className="px-1 text-[9.5px] font-mono text-zinc-400">
                                {viewedTopicIdx + 1}/{flow.length}
                              </span>
                              <button
                                type="button"
                                disabled={viewedTopicIdx >= flow.length - 1}
                                onClick={() => {
                                  const nextIdx = Math.min(flow.length - 1, viewedTopicIdx + 1);
                                  const t = flow[nextIdx];
                                  setSelectedTopicId(t.id || `${t.topic}-${nextIdx}`);
                                }}
                                className="px-1 py-0.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-35 cursor-pointer"
                                title="下一个议题"
                              >
                                <ChevronRight className="w-2.5 h-2.5" />
                              </button>
                            </div>
                          )}
                        </div>
                        {flow.length > 1 && (
                          <div className="flex flex-wrap gap-1">
                            {flow.map((tf, tIdx) => {
                              const tKey = tf.id || `${tf.topic}-${tIdx}`;
                              const isSelectedTopic = tIdx === viewedTopicIdx;
                              return (
                                <button
                                  key={tKey}
                                  type="button"
                                  onClick={() => setSelectedTopicId(tKey)}
                                  title={`切换查看议题：${tf.topic}`}
                                  className={`px-1.5 py-0.2 rounded border text-[9.5px] truncate max-w-[120px] cursor-pointer transition ${
                                    isSelectedTopic
                                      ? 'border-cyan-400/75 bg-cyan-500/20 text-cyan-200 font-semibold'
                                      : 'border-zinc-800 bg-zinc-900/70 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                                  }`}
                                >
                                  {tf.topic}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-[76px_1fr] items-start gap-2 px-2.5 py-1.5">
                      <span className="text-zinc-500 font-medium shrink-0 pt-0.5">切换席位</span>
                      <div className="flex flex-wrap gap-1">
                        {snap.speakers.map((sp, sIdx) => {
                          const c = SPEAKER_COLORS[sIdx % SPEAKER_COLORS.length];
                          const isSelected = sp.id === activeSpeaker?.id;
                          return (
                            <button
                              key={sp.id}
                              type="button"
                              onClick={() => setSelectedProfileSpeakerId(sp.id)}
                              title={`点击切换查看「${sp.name}」的基本情况`}
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] cursor-pointer transition ${
                                isSelected
                                  ? `${c.badge} ring-1 ring-white/50 shadow-sm`
                                  : 'border-zinc-800 bg-zinc-900/70 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                              }`}
                            >
                              <span className="font-semibold">{sp.name}</span>
                              <span className="opacity-75">
                                ({sp.role === 'self' ? '我方' : '对方'})
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {dynamicFields.map((field) => (
                      <div
                        key={field.key}
                        className="grid grid-cols-[76px_1fr] items-center gap-2 px-2.5 py-1.5 bg-zinc-900/30"
                      >
                        <span className="text-zinc-400 font-medium shrink-0">{field.label}</span>
                        <div className="truncate">{field.value}</div>
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}

            {/* 目标信息 / 字段采集清单（采访模式） */}
            {(snap.targetFields?.length ?? 0) > 0 && (
              <div className="rounded-lg border border-cyan-500/30 bg-cyan-950/20 p-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/30 text-[10px] font-semibold text-cyan-300">
                    待获取信息 / 字段清单
                  </span>
                  <span className="text-[10px] font-mono text-cyan-300/90">
                    {snap.targetFields!.filter((f) => f.status === 'captured').length}/
                    {snap.targetFields!.length} 已获取
                  </span>
                </div>
                <div className="space-y-1.5">
                  {snap.targetFields!.map((tf) => (
                    <div
                      key={tf.id}
                      className="rounded border border-zinc-800/90 bg-zinc-950/75 px-2 py-1.5 text-xs space-y-0.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-zinc-100">{tf.label}</span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] border ${
                            tf.status === 'captured'
                              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
                              : tf.status === 'partial'
                                ? 'bg-amber-500/15 text-amber-300 border-amber-500/35'
                                : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                          }`}
                        >
                          {tf.status === 'captured'
                            ? '已获取'
                            : tf.status === 'partial'
                              ? '部分提及'
                              : '待提问'}
                        </span>
                      </div>
                      {tf.value && (
                        <div className="flex items-center justify-between gap-2 text-[11px] text-emerald-300/95">
                          <span className="leading-snug">{tf.value}</span>
                          {typeof tf.evidenceMs === 'number' && tf.evidenceMs > 0 && (
                            <button
                              type="button"
                              onClick={() => scrollToUtteranceMs(tf.evidenceMs!)}
                              className="shrink-0 text-[10px] font-mono text-blue-400 hover:underline cursor-pointer"
                            >
                              [{formatLiveMmSs(tf.evidenceMs)}]
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>

          {/* 右下：原提问区 */}
          <div className="flex-1 min-h-0 overflow-y-auto p-3.5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-bold text-zinc-200 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  <span>{isListenMode ? 'Q&A 提问建议' : '推动提问建议'}</span>
                  {historyPendingQuestions.length > 0 && (
                    <span className="px-1.5 py-0.2 rounded bg-zinc-800 border border-zinc-700 text-[9.5px] font-mono text-zinc-300">
                      最新 {latestQuestions.length} · 历史 {historyPendingQuestions.length}
                    </span>
                  )}
                </h3>
                {snap.lastInsightAt && (
                  <p className="text-[10px] text-zinc-500">
                    更新于 {new Date(snap.lastInsightAt).toLocaleTimeString('zh-CN')}
                  </p>
                )}
              </div>
              <button
                type="button"
                disabled={snap.llmStatus === 'disabled' || snap.llmStatus === 'thinking'}
                onClick={requestLiveInsight}
                className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-45 border border-zinc-700 text-xs text-zinc-200 cursor-pointer"
              >
                立即生成建议
              </button>
            </div>

            {(() => {
              const renderQuestionCard = (q: LiveQuestion, isHistory: boolean) => {
                const meta = questionTypeMeta(q.type, isListenMode);
                return (
                  <div
                    key={q.id}
                    className={`rounded-xl border p-3 space-y-2 ${
                      isHistory
                        ? 'border-zinc-800/80 bg-zinc-900/50'
                        : 'border-zinc-800 bg-zinc-900/85'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className={`px-1.5 py-0.5 rounded border text-[10px] shrink-0 ${meta.cls}`}>
                          {meta.label}
                        </span>
                        {isHistory && (
                          <span className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-[9.5px] text-zinc-400 shrink-0">
                            {q.insightSeq ? `第${q.insightSeq}轮` : '历史保留'}
                          </span>
                        )}
                        {q.targetField && (
                          <span
                            className="px-1.5 py-0.5 rounded border bg-cyan-500/15 text-cyan-300 border-cyan-500/35 text-[10px] font-medium truncate"
                            title={`该提问可获取「${q.targetField}」信息`}
                          >
                            可获取：{q.targetField}
                          </span>
                        )}
                      </div>
                      {q.relatedTo && (
                        <span className="text-[10px] text-zinc-500 truncate">{q.relatedTo}</span>
                      )}
                    </div>
                    <p
                      className={`text-sm font-medium leading-snug ${
                        isHistory ? 'text-zinc-200' : 'text-zinc-100'
                      }`}
                    >
                      {q.text}
                    </p>
                    {q.why && <p className="text-[11px] text-zinc-400">{q.why}</p>}
                    <div className="flex items-center justify-end gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(q.text);
                          onNotify('已复制提问到剪贴板');
                        }}
                        className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-300 cursor-pointer"
                      >
                        复制
                      </button>
                      <button
                        type="button"
                        onClick={() => setLiveQuestionStatus(q.id, 'dismissed')}
                        className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-400 cursor-pointer"
                      >
                        ✕ 忽略
                      </button>
                      <button
                        type="button"
                        onClick={() => setLiveQuestionStatus(q.id, 'adopted')}
                        className="px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-500 text-[11px] text-white inline-flex items-center gap-1 cursor-pointer"
                      >
                        <Check className="w-3 h-3" />
                        <span>已问</span>
                      </button>
                    </div>
                  </div>
                );
              };

              if (activeQuestions.length === 0) {
                return (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-500">
                    {snap.llmStatus === 'disabled'
                      ? '未配置大模型 API Key，仅保留实时转写。'
                      : isListenMode
                        ? '讲座内容积累到一定程度后，AI 会自动提炼总结并给出 Q&A 提问建议…'
                        : '对话积累到一定内容后，AI 会自动给出追问/深挖建议…'}
                  </div>
                );
              }

              return (
                <div className="space-y-3">
                  {latestQuestions.length > 0 ? (
                    <div className="space-y-2.5">
                      {latestQuestions.map((q) => renderQuestionCard(q, false))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px] text-zinc-400">
                      本轮建议已全部处理，下方保留历史待问问题
                    </div>
                  )}

                  {historyPendingQuestions.length > 0 && (
                    <div className="pt-2 border-t border-zinc-800/80 space-y-2">
                      <button
                        type="button"
                        onClick={() => setShowHistoryQuestionsDrawer((v) => !v)}
                        className="text-xs font-medium text-zinc-400 hover:text-zinc-200 cursor-pointer"
                      >
                        {showHistoryQuestionsDrawer
                          ? `▾ 历史保留问题 (${historyPendingQuestions.length})`
                          : `▸ 历史保留问题 (${historyPendingQuestions.length})`}
                      </button>
                      {showHistoryQuestionsDrawer && (
                        <div className="space-y-2">
                          {historyPendingQuestions.map((q) => renderQuestionCard(q, true))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* 已问过的问题 */}
            {adoptedQuestions.length > 0 && (
              <div className="pt-3 border-t border-zinc-800 space-y-2">
                <button
                  type="button"
                  onClick={() => setShowAdoptedDrawer((v) => !v)}
                  className="text-xs font-medium text-zinc-400 hover:text-zinc-200 cursor-pointer"
                >
                  {showAdoptedDrawer
                    ? `▾ 收起已问过的问题 (${adoptedQuestions.length})`
                    : `▸ 已问过的问题 (${adoptedQuestions.length})`}
                </button>
                {showAdoptedDrawer && (
                  <div className="space-y-1.5">
                    {adoptedQuestions.map((q) => (
                      <div
                        key={q.id}
                        className="rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-2 text-xs text-zinc-400 line-through"
                      >
                        {q.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>

        {/* 中栏主视图：提取的内容（发言习惯分析、语速、口语词、信息密度、逻辑连接导图等） */}
        <LiveAnalyticsCenterPane
          snap={snap}
          isListenMode={isListenMode}
          onJumpToMs={scrollToUtteranceMs}
          onOverrideOutline={overrideLiveOutline}
          onQuestionAction={setLiveQuestionStatus}
          selectedTopicId={selectedTopicId}
          onSelectTopicId={setSelectedTopicId}
        />

        {/* 右栏：流式文本原文 */}
        <aside className="relative w-[360px] xl:w-[400px] shrink-0 border-l border-zinc-800 flex flex-col bg-zinc-950 overflow-hidden">
          {/* 图例与待上传统计条 */}
          <div className="shrink-0 px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/60 flex flex-wrap items-center gap-2.5 text-[11px]">
            <span className="inline-flex items-center gap-1 text-zinc-400">
              <span className="w-2 h-2 rounded-full bg-zinc-500 animate-pulse" />
              <span>识别中</span>
            </span>
            <span className="inline-flex items-center gap-1 text-amber-300">
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              <span>待上传</span>
            </span>
            <span className="inline-flex items-center gap-1 text-blue-300">
              <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
              <span>上传中</span>
            </span>
            <span className="inline-flex items-center gap-1 text-emerald-300">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span>已上传</span>
            </span>

            <div className="ml-auto flex items-center gap-1.5">
              {(() => {
                const curMode = snap.speakerAnalysisMode ?? 'hybrid';
                const nextMode: LiveSpeakerAnalysisMode =
                  curMode === 'hybrid'
                    ? 'content'
                    : curMode === 'content'
                      ? 'voiceprint'
                      : 'hybrid';
                const modeLabel =
                  curMode === 'hybrid'
                    ? '声纹+内容'
                    : curMode === 'content'
                      ? '内容优先'
                      : '仅声纹';
                const isAnalyzingSpeakers = snap.speakerAnalysisStatus === 'analyzing';
                return (
                  <>
                    <button
                      type="button"
                      onClick={() => setLiveSpeakerAnalysisMode(nextMode)}
                      className="px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-300 cursor-pointer transition"
                      title="点击切换发言人分析方式（声纹+内容 / 内容优先 / 仅声纹）"
                    >
                      {modeLabel}
                    </button>
                    <button
                      type="button"
                      disabled={snap.utterances.length === 0 || isAnalyzingSpeakers}
                      onClick={() => {
                        void requestLiveSpeakerContentAnalysis(state).then((res) => {
                          if (!res.ok) {
                            onNotify(res.error || '内容辨人失败');
                            return;
                          }
                          if (res.mode === 'live') {
                            onNotify('已触发实时内容辨人分析…');
                          } else {
                            onNotify(
                              res.summary ||
                                `内容辨人完成（优化 ${res.reassignedCount ?? 0} 段）`
                            );
                          }
                        });
                      }}
                      className="px-1.5 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-45 text-[10px] text-emerald-200 font-medium inline-flex items-center gap-1 cursor-pointer transition"
                      title="结合对话内容、问答逻辑与自我介绍重新辨别发言人并推断身份姓名"
                    >
                      {isAnalyzingSpeakers && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                      <span>内容辨人</span>
                    </button>
                  </>
                );
              })()}
              <button
                type="button"
                onClick={() => setAggregateTranscript((v) => !v)}
                className={`px-1.5 py-0.5 rounded border text-[10px] cursor-pointer transition ${
                  aggregateTranscript
                    ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-200 font-medium'
                    : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200'
                }`}
                title="在确认发言人后自动聚合连续同发言人短句，避免过短内容独占区块"
              >
                {aggregateTranscript ? '已聚合' : '逐句'}
              </button>
              {snap.llmStatus === 'disabled' ? (
                <span className="text-zinc-500">仅实时转写</span>
              ) : (
                <>
                  <span className="text-zinc-400">
                    待传 <strong className="text-amber-300">{pendingStats.count}</strong>段/
                    <strong className="text-amber-300">{pendingStats.chars}</strong>字
                  </span>
                  {pendingStats.count > 0 && snap.llmStatus !== 'thinking' && (
                    <button
                      type="button"
                      onClick={requestLiveInsight}
                      className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 text-[10px] font-medium cursor-pointer transition"
                    >
                      立即分析
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {speakerSuggestion && speakerSuggestion.candidates.length > 0 && (
            <div className="shrink-0 mx-3 mt-2.5 rounded-xl border border-amber-500/45 bg-amber-950/25 p-2.5 space-y-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-0.5">
                  <div className="font-semibold text-amber-200 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span>
                      已改为「{speakerSuggestion.targetSpeakerName}」，建议同步修改其他关联发言人
                    </span>
                  </div>
                  <p className="text-[11px] text-amber-200/75">
                    检测到 {speakerSuggestion.candidates.length} 段声纹或内容关联的历史语音：
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSpeakerSuggestion(null)}
                  className="text-[11px] text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0"
                >
                  忽略
                </button>
              </div>

              <div className="max-h-32 overflow-y-auto space-y-1 pr-0.5">
                {speakerSuggestion.candidates.map((cand) => {
                  const candUtt = snap.utterances.find((x) => x.id === cand.utteranceId);
                  if (!candUtt) return null;
                  const checked = speakerSuggestion.selectedIds.includes(cand.utteranceId);
                  const oldName = speakerMap.get(candUtt.speakerId)?.speaker.name ?? '发言人';
                  return (
                    <label
                      key={cand.utteranceId}
                      className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950/75 px-2 py-1.5 cursor-pointer hover:border-zinc-700"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setSpeakerSuggestion((prev) => {
                            if (!prev) return null;
                            const nextIds = e.target.checked
                              ? [...prev.selectedIds, cand.utteranceId]
                              : prev.selectedIds.filter((id) => id !== cand.utteranceId);
                            return { ...prev, selectedIds: nextIds };
                          });
                        }}
                        className="mt-0.5 shrink-0"
                      />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex items-center justify-between gap-1.5 text-[10px]">
                          <span className="text-zinc-400">
                            <span className="font-mono text-blue-400 mr-1">
                              [{formatLiveMmSs(candUtt.startMs)}]
                            </span>
                            原：{oldName}
                          </span>
                          <span className="px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                            {cand.reason}
                          </span>
                        </div>
                        <p className="text-[11px] text-zinc-200 truncate">{candUtt.text}</p>
                      </div>
                    </label>
                  );
                })}
              </div>

              <div className="flex items-center justify-end gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={() => setSpeakerSuggestion(null)}
                  className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-300 cursor-pointer"
                >
                  暂不修改
                </button>
                <button
                  type="button"
                  disabled={speakerSuggestion.selectedIds.length === 0}
                  onClick={() => {
                    const count = speakerSuggestion.selectedIds.length;
                    batchAssignLiveSpeaker(
                      speakerSuggestion.selectedIds,
                      speakerSuggestion.targetSpeakerId,
                      applyToLabel
                    );
                    onNotify(
                      `已将 ${count} 段关联语音同步修改为「${speakerSuggestion.targetSpeakerName}」`
                    );
                    setSpeakerSuggestion(null);
                  }}
                  className="px-2.5 py-1 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-45 text-zinc-950 font-semibold text-[11px] cursor-pointer"
                >
                  一键全部修改 ({speakerSuggestion.selectedIds.length})
                </button>
              </div>
            </div>
          )}

          <div
            ref={transcriptScrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              setAutoScroll(atBottom);
            }}
            className="flex-1 overflow-y-auto p-3 space-y-2.5"
          >
            {snap.utterances.length === 0 && !snap.partial && (
              <div className="h-full flex items-center justify-center text-xs text-zinc-500 text-center px-4">
                {isListenMode
                  ? '正在实时聆听讲座/分享，开口即实时显示听到的文字…'
                  : '正在实时聆听对话，开口说话即实时显示听到的文字…'}
              </div>
            )}

            {displayBlocks.map((block) => {
              const spkInfo = speakerMap.get(block.speakerId);
              const color = SPEAKER_COLORS[(spkInfo?.idx ?? 0) % SPEAKER_COLORS.length];
              const spkName = spkInfo?.speaker.name ?? '发言人';
              const uncertain = block.isUncertain;
              const blockSummaries = block.utteranceIds.flatMap(
                (id) => summariesAfterUtt.get(id) ?? []
              );
              const blockStates = block.utteranceIds.map(
                (id) => uploadStates.get(id) ?? 'none'
              );
              const uploadState = blockStates.includes('uploading')
                ? 'uploading'
                : blockStates.includes('pending')
                  ? 'pending'
                  : blockStates.includes('uploaded')
                    ? 'uploaded'
                    : 'none';
              const isHighlighted = block.utteranceIds.includes(highlightedUttId ?? '');
              const firstUtt = block.utterances[0];
              const correctedUtts = block.utterances.filter(
                (u) => u.correctionStatus === 'done' && u.rawText && u.rawText !== u.text
              );
              const streamingUtt = block.utterances.find(
                (u) => u.correctionStatus === 'streaming'
              );

              const cardStyle =
                uploadState === 'uploading'
                  ? 'border border-blue-500/50 bg-blue-500/5'
                  : uploadState === 'pending'
                    ? 'border border-dashed border-amber-500/50 bg-amber-500/5'
                    : `border ${color.border} bg-zinc-900/60`;

              return (
                <React.Fragment key={block.id}>
                  <div
                    onContextMenu={(e) =>
                      openSpeakerCtxMenu(e, { kind: 'utterance', utteranceId: firstUtt.id })
                    }
                    title={
                      block.utterances.length > 1
                        ? '已聚合连续同发言人段落（点击发言人改全段，右键单句可单独拆分修改）'
                        : '右键可切换或新建发言人'
                    }
                    className={`relative rounded-xl ${cardStyle} ${
                      isHighlighted ? 'ring-2 ring-cyan-400/80 transition-shadow' : ''
                    } p-2.5 space-y-1.5`}
                  >
                    <div className="flex items-center gap-1.5 text-xs flex-wrap">
                      <button
                        type="button"
                        onClick={() =>
                          setEditingUttId(editingUttId === block.id ? null : block.id)
                        }
                        className={`px-2 py-0.5 rounded-md border text-[11px] font-semibold cursor-pointer ${color.badge}`}
                        title="点击纠正发言人"
                      >
                        {spkName}
                        {uncertain ? ' ?' : ''}
                      </button>
                      {uncertain && (
                        <button
                          type="button"
                          onClick={() => {
                            batchAssignLiveSpeaker(
                              block.utteranceIds,
                              block.speakerId,
                              applyToLabel
                            );
                            triggerSpeakerSuggestion(
                              firstUtt.id,
                              block.speakerId,
                              spkName
                            );
                          }}
                          className="px-1.5 py-0.5 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 text-[10px] text-emerald-300 cursor-pointer transition"
                          title="确认该发言人归属，并自动聚合相邻同发言人段落"
                        >
                          确认
                        </button>
                      )}
                      <span className="text-[10px] font-mono text-zinc-500">
                        {block.utterances.length > 1
                          ? `${formatLiveMmSs(block.startMs)} - ${formatLiveMmSs(block.endMs)}`
                          : formatLiveMmSs(block.startMs)}
                      </span>
                      {block.utterances.length > 1 && (
                        <span className="px-1.5 py-0.2 rounded bg-zinc-800/90 border border-zinc-700/80 text-[9.5px] font-mono text-zinc-400">
                          合 {block.utterances.length} 段
                        </span>
                      )}
                      {block.voiceprintCluster && (
                        <span
                          title={
                            block.voiceprintConfidence
                              ? `声纹标识：${block.voiceprintCluster} · 匹配度 ${Math.round(
                                  block.voiceprintConfidence * 100
                                )}%`
                              : `声纹标识：${block.voiceprintCluster}`
                          }
                          className="px-1.5 py-0.5 rounded border border-zinc-700/80 bg-zinc-950/70 text-[10px] font-mono text-zinc-400"
                        >
                          声纹 {block.voiceprintCluster}
                          {typeof block.voiceprintConfidence === 'number'
                            ? ` · ${Math.round(block.voiceprintConfidence * 100)}%`
                            : ''}
                        </span>
                      )}
                      {block.speakerSource === 'hybrid' && (
                        <span
                          title={block.speakerReason || '声纹特征与对话内容交叉印证'}
                          className="px-1.5 py-0.5 rounded border border-emerald-500/35 bg-emerald-500/10 text-[10px] text-emerald-300"
                        >
                          声纹+内容
                        </span>
                      )}
                      {block.speakerSource === 'content' && (
                        <span
                          title={block.speakerReason || '基于对话内容与上下文分析'}
                          className="px-1.5 py-0.5 rounded border border-cyan-500/35 bg-cyan-500/10 text-[10px] text-cyan-300"
                        >
                          内容分析
                          {typeof block.contentConfidence === 'number'
                            ? ` · ${Math.round(block.contentConfidence * 100)}%`
                            : ''}
                        </span>
                      )}

                      <div className="ml-auto flex items-center gap-1.5">
                        {streamingUtt && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 text-[10px]">
                            <Sparkles className="w-2.5 h-2.5 animate-pulse" />
                            <span>纠错中…</span>
                          </span>
                        )}
                        {correctedUtts.length > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              correctedUtts.forEach((u) =>
                                revertLiveUtteranceCorrection(u.id)
                              );
                            }}
                            title={`原识别文本：${correctedUtts
                              .map((u) => u.rawText)
                              .join(' ')}\n点击还原为原始识别文本`}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 text-[10px] cursor-pointer transition"
                          >
                            <Sparkles className="w-2.5 h-2.5" />
                            <span>已纠错 · 还原</span>
                          </button>
                        )}
                        {uploadState === 'uploaded' && (
                          <span className="text-[10px] text-emerald-400/90">✓ 已上传</span>
                        )}
                        {uploadState === 'uploading' && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-blue-300">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>分析中</span>
                          </span>
                        )}
                        {uploadState === 'pending' && (
                          <span className="px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/15 text-amber-300 text-[10px]">
                            待上传
                          </span>
                        )}
                      </div>
                    </div>

                    {editingUttId === block.id && (
                      <div className="mt-1 p-2.5 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl space-y-2">
                        {block.utterances.length > 1 && (
                          <div className="text-[10.5px] text-cyan-300/90">
                            将同步修改本聚合块内 {block.utterances.length} 段发言（右键单句可单独拆分修改）
                          </div>
                        )}
                        <div className="flex flex-wrap gap-1.5">
                          {snap.speakers.map((sp) => (
                            <div key={sp.id} className="inline-flex items-center gap-1">
                              {renamingSpeakerId === sp.id ? (
                                <form
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    const nextName = renameDraft.trim();
                                    if (nextName) {
                                      renameLiveSpeaker(sp.id, nextName);
                                      if (block.speakerId !== sp.id) {
                                        if (block.utterances.length > 1) {
                                          batchAssignLiveSpeaker(
                                            block.utteranceIds,
                                            sp.id,
                                            applyToLabel
                                          );
                                        } else {
                                          assignLiveSpeaker(
                                            firstUtt.id,
                                            sp.id,
                                            applyToLabel
                                          );
                                        }
                                      }
                                      triggerSpeakerSuggestion(
                                        firstUtt.id,
                                        sp.id,
                                        nextName
                                      );
                                      onNotify(`已将发言人更名为「${nextName}」`);
                                    }
                                    setRenamingSpeakerId(null);
                                    setEditingUttId(null);
                                  }}
                                  className="inline-flex items-center gap-1"
                                >
                                  <input
                                    type="text"
                                    value={renameDraft}
                                    onChange={(e) => setRenameDraft(e.target.value)}
                                    autoFocus
                                    placeholder="输入新名字"
                                    className="w-24 px-1.5 py-0.5 rounded bg-zinc-950 border border-blue-500 text-xs text-zinc-100 outline-none"
                                  />
                                  <button
                                    type="submit"
                                    className="px-1.5 py-0.5 rounded bg-blue-600 text-[10px] text-white cursor-pointer"
                                  >
                                    保存
                                  </button>
                                </form>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (block.utterances.length > 1) {
                                        batchAssignLiveSpeaker(
                                          block.utteranceIds,
                                          sp.id,
                                          applyToLabel
                                        );
                                      } else {
                                        assignLiveSpeaker(
                                          firstUtt.id,
                                          sp.id,
                                          applyToLabel
                                        );
                                      }
                                      triggerSpeakerSuggestion(
                                        firstUtt.id,
                                        sp.id,
                                        sp.name
                                      );
                                      setEditingUttId(null);
                                    }}
                                    className={`px-2 py-1 rounded text-xs cursor-pointer border ${
                                      sp.id === block.speakerId
                                        ? 'bg-blue-600 text-white border-blue-500'
                                        : 'bg-zinc-800 text-zinc-200 border-zinc-700 hover:bg-zinc-700'
                                    }`}
                                  >
                                    {sp.name}
                                  </button>
                                  <button
                                    type="button"
                                    title={`修改「${sp.name}」的名字`}
                                    onClick={() => {
                                      setRenamingSpeakerId(sp.id);
                                      setRenameDraft(sp.name);
                                    }}
                                    className="px-1 py-0.5 rounded text-[10px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer"
                                  >
                                    改名
                                  </button>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                        <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={applyToLabel}
                            onChange={(e) => setApplyToLabel(e.target.checked)}
                          />
                          <span>此后同一声纹都归为此人</span>
                        </label>
                      </div>
                    )}

                    <p
                      className={`text-[13px] leading-relaxed ${
                        uploadState === 'pending' ? 'text-zinc-200' : 'text-zinc-100'
                      }`}
                    >
                      {block.utterances.map((u, uIdx) => {
                        const prevU = uIdx > 0 ? block.utterances[uIdx - 1] : null;
                        const sep = prevU
                          ? separatorBetweenUtterances(prevU.text, u.text)
                          : '';
                        const isUttHighlighted = highlightedUttId === u.id;
                        return (
                          <React.Fragment key={u.id}>
                            {sep}
                            <span
                              id={`live-utt-${u.id}`}
                              onContextMenu={(e) =>
                                openSpeakerCtxMenu(e, {
                                  kind: 'utterance',
                                  utteranceId: u.id,
                                })
                              }
                              title={
                                block.utterances.length > 1
                                  ? `右键可单独拆分修改此句发言人 [${formatLiveMmSs(u.startMs)}]`
                                  : '右键可切换或新建发言人'
                              }
                              className={
                                isUttHighlighted
                                  ? 'bg-cyan-500/25 text-cyan-50 rounded px-0.5'
                                  : undefined
                              }
                            >
                              {u.text}
                            </span>
                          </React.Fragment>
                        );
                      })}
                    </p>
                    {streamingUtt && streamingUtt.streamingCorrectedText && (
                      <div className="mt-1 px-2.5 py-1.5 rounded-lg bg-cyan-950/35 border border-cyan-500/25 text-xs text-cyan-200 leading-relaxed flex items-start gap-1.5">
                        <Sparkles className="w-3 h-3 text-cyan-400 shrink-0 mt-0.5 animate-pulse" />
                        <span>
                          {streamingUtt.streamingCorrectedText}
                          <span className="inline-block w-1.5 h-3.5 ml-0.5 align-middle bg-cyan-400/80 animate-pulse" />
                        </span>
                      </div>
                    )}
                  </div>

                  {blockSummaries.map((ts, idx) => (
                    <div
                      key={`${block.id}-sum-${idx}`}
                      className="mx-1 px-2.5 py-1.5 rounded-lg bg-zinc-900/90 border border-zinc-800 text-[11px] text-zinc-400 flex items-center gap-2"
                    >
                      <Sparkles className="w-3 h-3 text-blue-400 shrink-0" />
                      <span>
                        <strong className="text-zinc-300">
                          {speakerMap.get(ts.speakerId)?.speaker.name ?? '发言'}小结：
                        </strong>
                        {ts.summary}
                      </span>
                    </div>
                  ))}
                </React.Fragment>
              );
            })}

            {snap.partial && (
              <div
                onContextMenu={(e) =>
                  openSpeakerCtxMenu(e, { kind: 'partial', startMs: snap.partial!.startMs })
                }
                title="右键可切换或新建发言人"
                className="rounded-xl border border-cyan-500/40 bg-cyan-950/20 p-2.5 space-y-1.5 shadow-sm"
              >
                <div className="flex items-center gap-2 text-xs">
                  {snap.partial.speakerId && speakerMap.get(snap.partial.speakerId) && (
                    <span
                      className={`px-2 py-0.5 rounded-md border text-[11px] font-semibold ${
                        SPEAKER_COLORS[
                          (speakerMap.get(snap.partial.speakerId)!.idx) % SPEAKER_COLORS.length
                        ].badge
                      }`}
                    >
                      {speakerMap.get(snap.partial.speakerId)!.speaker.name}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1.5 text-[10px] text-cyan-300 font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                    <span>实时听写中…</span>
                  </span>
                </div>
                <p className="text-[13px] text-zinc-100 leading-relaxed">
                  {snap.partial.text}
                  <span className="inline-block w-1.5 h-4 ml-0.5 align-middle bg-cyan-400/80 animate-pulse" />
                </p>
              </div>
            )}
          </div>

          {!autoScroll && (
            <button
              type="button"
              onClick={() => {
                setAutoScroll(true);
                const el = transcriptScrollRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
              className="absolute bottom-4 right-4 px-3 py-1.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium shadow-lg inline-flex items-center gap-1 cursor-pointer"
            >
              <ArrowDown className="w-3.5 h-3.5" />
              <span>回到最新</span>
            </button>
          )}

          {speakerCtxMenu && (() => {
            const targetUtt =
              speakerCtxMenu.kind === 'utterance'
                ? snap.utterances.find((x) => x.id === speakerCtxMenu.utteranceId)
                : undefined;
            if (speakerCtxMenu.kind === 'utterance' && !targetUtt) return null;

            const currentSpeakerId =
              speakerCtxMenu.kind === 'utterance'
                ? targetUtt!.speakerId
                : (snap.partial?.speakerId ?? '');
            const displayStartMs =
              speakerCtxMenu.kind === 'utterance'
                ? targetUtt!.startMs
                : (snap.partial?.startMs ?? speakerCtxMenu.startMs);

            const handleCreateAndAssign = () => {
              const trimmed = newSpeakerName.trim();
              if (!trimmed) return;
              if (speakerCtxMenu.kind === 'utterance') {
                const added = addAndAssignLiveSpeaker(
                  targetUtt!.id,
                  trimmed,
                  newSpeakerRole,
                  applyToLabel
                );
                triggerSpeakerSuggestion(targetUtt!.id, added.id, added.name);
                onNotify(`已新建发言人「${added.name}」并切换当前语句`);
              } else {
                const { speaker: added, assignedUtteranceId } =
                  addAndAssignLivePartialSpeaker(
                    trimmed,
                    newSpeakerRole,
                    applyToLabel,
                    speakerCtxMenu.startMs
                  );
                if (assignedUtteranceId) {
                  triggerSpeakerSuggestion(assignedUtteranceId, added.id, added.name);
                }
                onNotify(`已新建发言人「${added.name}」并切换当前听写`);
              }
              setSpeakerCtxMenu(null);
              setCreatingNewSpeaker(false);
              setNewSpeakerName('');
            };
            return (
              <div
                ref={speakerCtxMenuRef}
                style={{ left: speakerCtxMenu.x, top: speakerCtxMenu.y }}
                className="fixed z-50 w-60 rounded-xl border border-zinc-700 bg-zinc-900/95 backdrop-blur-md shadow-2xl p-1.5 text-xs select-none"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center justify-between">
                  <span>切换发言人</span>
                  <span className="font-mono text-zinc-500">{formatLiveMmSs(displayStartMs)}</span>
                </div>

                <div className="max-h-44 overflow-y-auto space-y-0.5 my-1">
                  {snap.speakers.map((sp, sIdx) => {
                    const c = SPEAKER_COLORS[sIdx % SPEAKER_COLORS.length];
                    const isCurrent = sp.id === currentSpeakerId;
                    return (
                      <button
                        key={sp.id}
                        type="button"
                        onClick={() => {
                          if (speakerCtxMenu.kind === 'utterance') {
                            assignLiveSpeaker(targetUtt!.id, sp.id, applyToLabel);
                            triggerSpeakerSuggestion(targetUtt!.id, sp.id, sp.name);
                          } else {
                            const assignedUttId = assignLivePartialSpeaker(
                              sp.id,
                              applyToLabel,
                              speakerCtxMenu.startMs
                            );
                            if (assignedUttId) {
                              triggerSpeakerSuggestion(assignedUttId, sp.id, sp.name);
                            }
                          }
                          setSpeakerCtxMenu(null);
                        }}
                        className={`w-full px-2 py-1.5 rounded-lg flex items-center justify-between gap-2 cursor-pointer transition ${
                          isCurrent
                            ? 'bg-blue-600/20 text-blue-200 border border-blue-500/40'
                            : 'hover:bg-zinc-800 text-zinc-200 border border-transparent'
                        }`}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span className={`w-2 h-2 rounded-full shrink-0 border ${c.badge}`} />
                          <span className="truncate font-medium">{sp.name}</span>
                          <span className="text-[10px] text-zinc-500 shrink-0">
                            {sp.role === 'self' ? '我方' : '对方'}
                          </span>
                        </span>
                        {isCurrent && <Check className="w-3.5 h-3.5 text-blue-400 shrink-0" />}
                      </button>
                    );
                  })}
                </div>

                <div className="my-1 border-t border-zinc-800" />

                <label className="px-2 py-1 flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={applyToLabel}
                    onChange={(e) => setApplyToLabel(e.target.checked)}
                  />
                  <span>此后同一声纹都归为此人</span>
                </label>

                <div className="my-1 border-t border-zinc-800" />

                {!creatingNewSpeaker ? (
                  <button
                    type="button"
                    onClick={() => setCreatingNewSpeaker(true)}
                    className="w-full px-2 py-1.5 rounded-lg hover:bg-emerald-500/15 text-emerald-300 flex items-center gap-1.5 font-medium cursor-pointer transition"
                  >
                    <UserPlus className="w-3.5 h-3.5" />
                    <span>新建发言人并切换…</span>
                  </button>
                ) : (
                  <div className="p-1.5 space-y-2 bg-zinc-950/70 rounded-lg border border-zinc-800">
                    <input
                      type="text"
                      autoFocus
                      value={newSpeakerName}
                      onChange={(e) => setNewSpeakerName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleCreateAndAssign();
                        }
                      }}
                      placeholder="输入新发言人姓名..."
                      className="w-full h-7 px-2 rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500"
                    />
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="relative">
                        <select
                          value={newSpeakerRole}
                          onChange={(e) => setNewSpeakerRole(e.target.value as LiveSpeakerRole)}
                          className="h-7 pl-2 pr-6 rounded border border-zinc-700 bg-zinc-900 text-[11px] text-zinc-200 appearance-none cursor-pointer focus:outline-none focus:border-emerald-500"
                        >
                          <option value="counterpart">嘉宾 / 对方</option>
                          <option value="self">主持人 / 我方</option>
                        </select>
                        <ChevronDown className="w-3 h-3 text-zinc-400 pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2" />
                      </div>
                      <button
                        type="button"
                        disabled={!newSpeakerName.trim()}
                        onClick={handleCreateAndAssign}
                        className="h-7 px-2.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-[11px] font-semibold cursor-pointer inline-flex items-center"
                      >
                        创建并切换
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </aside>
      </div>
    </div>
  );
};
