import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { PodcastProjectState } from '../types/podcast';
import {
  LiveOutlineItem,
  LiveQuestion,
  LiveSessionPhase,
  LiveSessionPrep,
  LiveSessionSnapshot,
  LiveSidecarEvent,
  LiveSpeaker,
  LiveSpeakerAnalysisMode,
  LiveSpeakerRole,
  LiveSpeakerSuggestionCandidate,
  LiveTargetFieldItem,
  LiveUtterance,
  LiveUtteranceUploadState,
  RecentLiveSessionItem,
  SuspectedDuplicateSpeakerPair,
} from '../types/liveSession';
import {
  buildAsrConfigFromPlatform,
  buildLlmConfigForFeature,
  getCachedAiPlatformConfig,
} from './aiPlatformConfig';
import {
  int16ToBase64,
  LiveAudioCaptureHandle,
  startLiveAudioCapture,
} from './liveAudioCapture';
import { LiveTransportHandle, startLiveSessionTransport } from './liveSessionBridge';
import { buildLiveSessionMarkdown } from './liveMinutesExporter';
import { computeLiveSpeechAnalytics } from './liveSpeechAnalytics';
import { analyzeLiveSpeakersByContent, isTauriRuntime } from './tauriBridge';

export function createInitialLiveSnapshot(): LiveSessionSnapshot {
  return {
    sessionId: null,
    phase: 'idle',
    scenario: 'interview',
    title: '',
    prep: null,
    speakers: [],
    outputDir: null,
    wavPath: null,
    sessionJsonPath: null,
    minutesPath: null,
    reportPath: null,
    asrEngine: null,
    engineNotice: null,
    asrStatus: 'idle',
    asrMessage: null,
    llmStatus: 'idle',
    llmMessage: null,
    elapsedMs: 0,
    utterances: [],
    partial: null,
    profile: { background: [], stories: [], viewpoints: [] },
    questions: [],
    turnSummaries: [],
    keyPoints: [],
    outline: [],
    targetFields: [],
    currentTopic: '',
    topicFlow: [],
    lastInsightAt: null,
    analyzingUpToUtteranceId: null,
    analyzedUpToUtteranceId: null,
    finalSummary: null,
    errorMessage: null,
    speakerAnalysisMode: 'hybrid',
    contentDuplicateHints: [],
    speakerAnalysisStatus: 'idle',
    speakerAnalysisSummary: null,
  };
}

/**
 * Pure reducer applying a single sidecar NDJSON event onto a LiveSessionSnapshot.
 */
const MAX_STORED_LIVE_QUESTIONS = 60;

function normalizeLiveQuestionText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s，。？！、；：,.?!;:「」『』“”"'`（）()]+/g, '');
}

export function applyLiveEvent(
  snap: LiveSessionSnapshot,
  ev: LiveSidecarEvent
): LiveSessionSnapshot {
  switch (ev.type) {
    case 'ready':
      return {
        ...snap,
        phase: snap.phase === 'starting' ? 'recording' : snap.phase,
        asrEngine: ev.asrEngine,
        wavPath: ev.wavPath,
        outputDir: ev.outputDir || snap.outputDir,
      };

    case 'engine':
      return {
        ...snap,
        asrEngine: ev.asrEngine,
        engineNotice: ev.reason
          ? `已切换为本地离线识别：${ev.reason}`
          : `识别引擎已切换为 ${ev.asrEngine}`,
      };

    case 'status':
      return {
        ...snap,
        asrStatus: ev.asr ?? snap.asrStatus,
        asrMessage: ev.asr ? (ev.message ?? null) : snap.asrMessage,
        llmStatus: ev.llm ?? snap.llmStatus,
        llmMessage: ev.llm ? (ev.message ?? null) : snap.llmMessage,
        analyzingUpToUtteranceId:
          ev.llm === 'error' ? null : snap.analyzingUpToUtteranceId,
      };

    case 'partial':
      return {
        ...snap,
        partial: {
          text: ev.text,
          startMs: ev.startMs,
          endMs: ev.endMs,
          speakerId: ev.speakerId,
        },
      };

    case 'speaker_added': {
      const exists = snap.speakers.some((s) => s.id === ev.speaker.id);
      if (exists) return snap;
      return {
        ...snap,
        speakers: [...snap.speakers, ev.speaker],
      };
    }

    case 'final': {
      const hasSpeaker = snap.speakers.some((s) => s.id === ev.utterance.speakerId);
      const nextSpeakers = hasSpeaker
        ? snap.speakers
        : [
            ...snap.speakers,
            {
              id: ev.utterance.speakerId,
              name: `发言人 ${snap.speakers.length + 1}`,
              role: 'counterpart' as const,
            },
          ];
      return {
        ...snap,
        speakers: nextSpeakers,
        partial: null,
        utterances: [...snap.utterances, ev.utterance],
      };
    }

    case 'utterance_update':
      return {
        ...snap,
        utterances: snap.utterances.map((u) =>
          u.id === ev.utteranceId
            ? {
                ...u,
                speakerId: ev.speakerId,
                speakerSource: ev.speakerSource,
                voiceprintCluster: ev.voiceprintCluster ?? u.voiceprintCluster,
                contentConfidence: ev.contentConfidence ?? u.contentConfidence,
                speakerReason: ev.speakerReason ?? u.speakerReason,
              }
            : u
        ),
      };

    case 'speaker_analysis': {
      const nextSpeakers = [...snap.speakers];
      const spkIdxMap = new Map<string, number>();
      nextSpeakers.forEach((s, idx) => spkIdxMap.set(s.id, idx));

      for (const nsp of ev.newSpeakers ?? []) {
        if (!nsp.id || spkIdxMap.has(nsp.id)) continue;
        spkIdxMap.set(nsp.id, nextSpeakers.length);
        nextSpeakers.push(nsp);
      }

      for (const prof of ev.speakerProfiles ?? []) {
        const idx = spkIdxMap.get(prof.speakerId);
        if (idx === undefined) continue;
        const cur = nextSpeakers[idx];
        const cleanInfName = prof.inferredName?.trim();
        const nextInfName =
          cleanInfName && cleanInfName !== cur.name.trim()
            ? cleanInfName
            : cur.inferredName;
        nextSpeakers[idx] = {
          ...cur,
          inferredName: nextInfName,
          inferredIdentity: prof.inferredIdentity?.trim() || cur.inferredIdentity,
          identityEvidence: prof.evidence?.trim() || cur.identityEvidence,
          identityConfidence:
            typeof prof.confidence === 'number'
              ? prof.confidence
              : cur.identityConfidence,
        };
      }

      const reMap = new Map(ev.reassignments.map((r) => [r.utteranceId, r]));
      const nextUtterances = snap.utterances.map((u) => {
        if (u.speakerSource === 'manual') return u;
        const hit = reMap.get(u.id);
        if (!hit) return u;
        return {
          ...u,
          speakerId: hit.speakerId,
          speakerSource: hit.speakerSource,
          contentConfidence: hit.contentConfidence,
          speakerReason: hit.reason,
        };
      });

      const validSpkSet = new Set(nextSpeakers.map((s) => s.id));
      const nextDupHints = Array.isArray(ev.duplicateHints)
        ? ev.duplicateHints.filter(
            (h) =>
              h.sourceSpeakerId &&
              h.targetSpeakerId &&
              h.sourceSpeakerId !== h.targetSpeakerId &&
              validSpkSet.has(h.sourceSpeakerId) &&
              validSpkSet.has(h.targetSpeakerId)
          )
        : snap.contentDuplicateHints;

      return {
        ...snap,
        speakers: nextSpeakers,
        utterances: nextUtterances,
        contentDuplicateHints: nextDupHints,
        speakerAnalysisStatus: 'done',
        speakerAnalysisSummary: ev.summary ?? snap.speakerAnalysisSummary ?? null,
      };
    }

    case 'utterance_correction':
      return {
        ...snap,
        utterances: snap.utterances.map((u) => {
          if (u.id !== ev.utteranceId) return u;
          const rawText = ev.rawText ?? u.rawText ?? u.text;
          if (ev.status === 'streaming') {
            return {
              ...u,
              rawText,
              correctionStatus: 'streaming',
              streamingCorrectedText: ev.correctedText,
            };
          }
          if (ev.status === 'done') {
            return {
              ...u,
              rawText,
              text: ev.correctedText,
              correctionStatus: 'done',
              streamingCorrectedText: undefined,
            };
          }
          return {
            ...u,
            correctionStatus: 'unchanged',
            streamingCorrectedText: undefined,
          };
        }),
      };

    case 'insight_request':
      return {
        ...snap,
        analyzingUpToUtteranceId: ev.upToUtteranceId,
      };

    case 'insight': {
      const nowTs = ev.generatedAt ?? Date.now();
      const oldById = new Map<string, LiveQuestion>();
      const oldByNormText = new Map<string, LiveQuestion>();
      for (const q of snap.questions) {
        oldById.set(q.id, q);
        const norm = normalizeLiveQuestionText(q.text);
        if (norm && !oldByNormText.has(norm)) {
          oldByNormText.set(norm, q);
        }
      }

      const consumedOldIds = new Set<string>();
      const seenLatestNorm = new Set<string>();
      const latestQuestions: LiveQuestion[] = [];

      for (const q of ev.questions) {
        const norm = normalizeLiveQuestionText(q.text);
        if (norm && seenLatestNorm.has(norm)) {
          continue;
        }
        if (norm) {
          seenLatestNorm.add(norm);
        }
        const prev = oldById.get(q.id) ?? (norm ? oldByNormText.get(norm) : undefined);
        if (prev) {
          consumedOldIds.add(prev.id);
        }
        latestQuestions.push({
          ...q,
          status: prev?.status ?? 'new',
          insightSeq: ev.seq,
          createdAt: prev?.createdAt ?? nowTs,
          isLatest: true,
        });
      }

      const preservedHistory: LiveQuestion[] = [];
      for (const oldQ of snap.questions) {
        if (consumedOldIds.has(oldQ.id)) continue;
        preservedHistory.push({
          ...oldQ,
          isLatest: false,
        });
      }

      let mergedQuestions: LiveQuestion[] = [...latestQuestions, ...preservedHistory];
      if (mergedQuestions.length > MAX_STORED_LIVE_QUESTIONS) {
        const mustKeep = mergedQuestions.filter(
          (q) => q.isLatest === true || q.status === 'adopted'
        );
        const keepIdSet = new Set(mustKeep.map((q) => q.id));
        const others = mergedQuestions.filter((q) => !keepIdSet.has(q.id));
        const remainSlots = Math.max(0, MAX_STORED_LIVE_QUESTIONS - mustKeep.length);
        const keptOthers = others.slice(0, remainSlots);
        const finalIdSet = new Set([
          ...mustKeep.map((q) => q.id),
          ...keptOthers.map((q) => q.id),
        ]);
        mergedQuestions = mergedQuestions.filter((q) => finalIdSet.has(q.id));
      }

      const existingSummaryKeys = new Set(
        snap.turnSummaries.map((ts) => `${ts.startMs}|${ts.summary}`)
      );
      const newSummaries = ev.turnSummaries.filter(
        (ts) => !existingSummaryKeys.has(`${ts.startMs}|${ts.summary}`)
      );

      const covMap = new Map(ev.outlineCoverage.map((c) => [c.id, c]));
      const nextOutline: LiveOutlineItem[] = snap.outline.map((item) => {
        const hit = covMap.get(item.id);
        if (!hit) return item;
        return {
          ...item,
          status: hit.status,
          note: hit.note ?? item.note,
        };
      });

      const tfMap = new Map((ev.targetFieldUpdates ?? []).map((u) => [u.id, u]));
      const nextTargetFields: LiveTargetFieldItem[] = (snap.targetFields ?? []).map((tf) => {
        const hit = tfMap.get(tf.id);
        if (!hit) return tf;
        // 已经 captured 且新结果不是 captured 时保留原 captured 状态，避免遗忘已获取字段
        if (tf.status === 'captured' && hit.status !== 'captured') {
          return tf;
        }
        return {
          ...tf,
          status: hit.status,
          value: hit.value?.trim() ? hit.value.trim() : tf.value,
          evidenceMs:
            typeof hit.evidenceMs === 'number' && hit.evidenceMs >= 0
              ? hit.evidenceMs
              : tf.evidenceMs,
        };
      });

      return {
        ...snap,
        profile: ev.profile,
        questions: mergedQuestions,
        turnSummaries: [...snap.turnSummaries, ...newSummaries],
        keyPoints: ev.keyPoints,
        outline: nextOutline,
        targetFields: nextTargetFields,
        currentTopic:
          typeof ev.currentTopic === 'string' ? ev.currentTopic : snap.currentTopic,
        topicFlow: Array.isArray(ev.topicFlow) ? ev.topicFlow : snap.topicFlow,
        lastInsightAt: ev.generatedAt ?? Date.now(),
        analyzedUpToUtteranceId: ev.basedOnUtteranceId ?? snap.analyzedUpToUtteranceId,
        analyzingUpToUtteranceId: null,
      };
    }

    case 'final_summary': {
      const lastUttId =
        snap.utterances.length > 0
          ? snap.utterances[snap.utterances.length - 1].id
          : snap.analyzedUpToUtteranceId;
      return {
        ...snap,
        analyzedUpToUtteranceId: lastUttId,
        analyzingUpToUtteranceId: null,
        finalSummary: {
          overview: ev.overview,
          keyTakeaways: ev.keyTakeaways,
          nextSteps: ev.nextSteps,
        },
      };
    }

    case 'error':
      if (!ev.fatal) {
        return {
          ...snap,
          engineNotice: ev.message,
        };
      }
      return {
        ...snap,
        phase: 'error',
        errorMessage: ev.message,
      };

    case 'stopped':
      return {
        ...snap,
        phase: 'stopped',
        wavPath: ev.wavPath || snap.wavPath,
        sessionJsonPath: ev.sessionJsonPath || snap.sessionJsonPath,
        elapsedMs: ev.durationMs > 0 ? ev.durationMs : snap.elapsedMs,
        partial: null,
      };

    case 'process_exit':
      if (
        snap.phase === 'starting' ||
        snap.phase === 'recording' ||
        snap.phase === 'paused' ||
        snap.phase === 'stopping'
      ) {
        return {
          ...snap,
          phase: snap.utterances.length > 0 ? 'stopped' : 'error',
          errorMessage: snap.utterances.length > 0 ? null : '后台录制进程意外退出',
        };
      }
      return snap;

    default:
      return snap;
  }
}

export function computeUtteranceUploadStates(
  snap: LiveSessionSnapshot
): Map<string, LiveUtteranceUploadState> {
  const result = new Map<string, LiveUtteranceUploadState>();
  if (snap.llmStatus === 'disabled') {
    for (const u of snap.utterances) {
      result.set(u.id, 'none');
    }
    return result;
  }
  const analyzedIdx = snap.analyzedUpToUtteranceId
    ? snap.utterances.findIndex((u) => u.id === snap.analyzedUpToUtteranceId)
    : -1;
  const analyzingIdx = snap.analyzingUpToUtteranceId
    ? snap.utterances.findIndex((u) => u.id === snap.analyzingUpToUtteranceId)
    : -1;

  for (let i = 0; i < snap.utterances.length; i++) {
    const id = snap.utterances[i].id;
    if (i <= analyzedIdx) {
      result.set(id, 'uploaded');
    } else if (i <= analyzingIdx) {
      result.set(id, 'uploading');
    } else {
      result.set(id, 'pending');
    }
  }
  return result;
}

// --- Module-level singleton stores ---

let snapshot: LiveSessionSnapshot = createInitialLiveSnapshot();
const listeners = new Set<() => void>();

let micLevel = 0;
const levelListeners = new Set<() => void>();

let activeTransport: LiveTransportHandle | null = null;
let activeCapture: LiveAudioCaptureHandle | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let audioSeq = 0;
let partialSpeakerOverride: {
  speakerId: string;
  applyToLabel: boolean;
  startMs: number;
} | null = null;

function emitSnap(next: LiveSessionSnapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

function emitLevel(rms: number): void {
  micLevel = rms;
  for (const l of levelListeners) l();
}

function clearElapsedTimer(): void {
  if (elapsedTimer !== null) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function startElapsedTimer(): void {
  clearElapsedTimer();
  let lastTick = Date.now();
  elapsedTimer = setInterval(() => {
    const now = Date.now();
    const dt = now - lastTick;
    lastTick = now;
    if (snapshot.phase === 'recording') {
      emitSnap({ ...snapshot, elapsedMs: snapshot.elapsedMs + dt });
    }
  }, 1000);
}

async function cleanupHardwareAndTransport(): Promise<void> {
  clearElapsedTimer();
  partialSpeakerOverride = null;
  const cap = activeCapture;
  activeCapture = null;
  if (cap) {
    await cap.stop();
  }
  emitLevel(0);
  const tr = activeTransport;
  activeTransport = null;
  if (tr) {
    tr.dispose();
  }
}

const RECENT_LIVE_SESSIONS_KEY = 'podcraft.recentLiveSessions';
const MAX_RECENT_LIVE_SESSIONS = 20;

function getLocalStorageSafe(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // ignore
  }
  return null;
}

export function loadRecentLiveSessions(): RecentLiveSessionItem[] {
  try {
    const storage = getLocalStorageSafe();
    if (!storage) return [];
    const raw = storage.getItem(RECENT_LIVE_SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item) =>
          item &&
          typeof item === 'object' &&
          typeof item.reportPath === 'string' &&
          Boolean(item.reportPath.trim())
      )
      .slice(0, MAX_RECENT_LIVE_SESSIONS);
  } catch {
    return [];
  }
}

export function recordRecentLiveSession(snap: LiveSessionSnapshot, reportPath: string): void {
  const cleanPath = reportPath.trim();
  if (!cleanPath) return;
  const storage = getLocalStorageSafe();
  if (!storage) return;
  try {
    const item: RecentLiveSessionItem = {
      sessionId: snap.sessionId || `live_${Date.now()}`,
      title: snap.title?.trim() || snap.prep?.title?.trim() || '未命名录制',
      scenario: snap.scenario,
      outputDir: snap.outputDir,
      reportPath: cleanPath,
      wavPath: snap.wavPath,
      minutesPath: snap.minutesPath,
      durationMs: snap.elapsedMs,
      utteranceCount: snap.utterances.length,
      speakerCount: snap.speakers.length,
      updatedAt: Date.now(),
    };
    const current = loadRecentLiveSessions().filter((x) => x.reportPath !== cleanPath);
    const updated = [item, ...current].slice(0, MAX_RECENT_LIVE_SESSIONS);
    storage.setItem(RECENT_LIVE_SESSIONS_KEY, JSON.stringify(updated));
  } catch {
    // ignore storage quota errors
  }
}

export function removeRecentLiveSession(reportPath: string): RecentLiveSessionItem[] {
  const clean = reportPath.trim();
  const next = loadRecentLiveSessions().filter((x) => x.reportPath !== clean);
  try {
    getLocalStorageSafe()?.setItem(RECENT_LIVE_SESSIONS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export function buildLiveAnalysisReportDoc(snap: LiveSessionSnapshot) {
  const cleanSnap: LiveSessionSnapshot = {
    ...snap,
    phase: 'stopped',
    partial: null,
    analyzingUpToUtteranceId: null,
    asrStatus: 'idle',
    llmStatus: 'idle',
  };
  return {
    version: 1,
    savedAt: Date.now(),
    snapshot: cleanSnap,
    speechAnalytics: computeLiveSpeechAnalytics(cleanSnap),
  };
}

export function parseAndRestoreLiveSession(
  rawJson: string,
  sourcePath?: string
): LiveSessionSnapshot {
  const parsed = JSON.parse(rawJson) as Record<string, unknown>;
  const base = createInitialLiveSnapshot();
  const dirFromPath = sourcePath
    ? sourcePath.replace(/[\\/][^\\/]+$/, '')
    : null;

  // Case 1: analysis-report.json ({ version: 1, snapshot: { ... } })
  if (parsed && typeof parsed === 'object' && parsed.snapshot && typeof parsed.snapshot === 'object') {
    const s = parsed.snapshot as Partial<LiveSessionSnapshot>;
    return {
      ...base,
      ...s,
      phase: 'stopped',
      partial: null,
      asrStatus: 'idle',
      llmStatus: 'idle',
      analyzingUpToUtteranceId: null,
      outputDir: s.outputDir || dirFromPath,
      reportPath: sourcePath || s.reportPath || null,
      speakers: Array.isArray(s.speakers) ? s.speakers : [],
      utterances: Array.isArray(s.utterances) ? s.utterances : [],
      profile: s.profile ?? { background: [], stories: [], viewpoints: [] },
      questions: Array.isArray(s.questions) ? s.questions : [],
      turnSummaries: Array.isArray(s.turnSummaries) ? s.turnSummaries : [],
      keyPoints: Array.isArray(s.keyPoints) ? s.keyPoints : [],
      outline: Array.isArray(s.outline) ? s.outline : [],
      targetFields: Array.isArray(s.targetFields) ? s.targetFields : [],
      topicFlow: Array.isArray(s.topicFlow) ? s.topicFlow : [],
      speakerAnalysisMode: s.speakerAnalysisMode ?? 'hybrid',
      contentDuplicateHints: Array.isArray(s.contentDuplicateHints)
        ? s.contentDuplicateHints
        : [],
    };
  }

  // Case 2: sidecar session.json
  const latestInsight =
    parsed.latestInsight && typeof parsed.latestInsight === 'object'
      ? (parsed.latestInsight as Record<string, unknown>)
      : null;
  const prep =
    parsed.prep && typeof parsed.prep === 'object'
      ? (parsed.prep as LiveSessionPrep)
      : null;
  const rawOutline = Array.isArray(prep?.outline) ? prep!.outline : [];
  const outlineCov = Array.isArray(latestInsight?.outlineCoverage)
    ? (latestInsight!.outlineCoverage as Array<{ id: string; status: LiveOutlineItem['status']; note?: string }>)
    : [];
  const outline: LiveOutlineItem[] = rawOutline.map((o) => {
    const hit = outlineCov.find((c) => c.id === o.id);
    return {
      id: o.id,
      text: o.text,
      status: hit?.status ?? 'not_started',
      note: hit?.note,
    };
  });

  const rawTargetFields = Array.isArray(prep?.targetFields) ? prep!.targetFields : [];
  const tfUpdates = Array.isArray(latestInsight?.targetFieldUpdates)
    ? (latestInsight!.targetFieldUpdates as Array<{
        id: string;
        status: LiveTargetFieldItem['status'];
        value?: string;
        evidenceMs?: number;
      }>)
    : [];
  const targetFields: LiveTargetFieldItem[] = rawTargetFields.map((tf) => {
    const hit = tfUpdates.find((u) => u.id === tf.id);
    return {
      id: tf.id,
      label: tf.label,
      status: hit?.status ?? 'missing',
      value: hit?.value,
      evidenceMs: hit?.evidenceMs,
    };
  });

  const rawQuestions = Array.isArray(latestInsight?.questions)
    ? (latestInsight!.questions as Array<Omit<LiveQuestion, 'status'>>)
    : [];

  return {
    ...base,
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : `restored_${Date.now()}`,
    phase: 'stopped',
    scenario: (parsed.scenario as LiveSessionSnapshot['scenario']) || prep?.scenario || 'interview',
    title: typeof parsed.title === 'string' ? parsed.title : prep?.title || '已保存的录制',
    prep,
    speakers: Array.isArray(parsed.speakers) ? (parsed.speakers as LiveSpeaker[]) : [],
    outputDir: dirFromPath,
    wavPath: typeof parsed.wavPath === 'string' ? parsed.wavPath : null,
    sessionJsonPath: sourcePath || null,
    reportPath: sourcePath || null,
    elapsedMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : 0,
    utterances: Array.isArray(parsed.utterances) ? (parsed.utterances as LiveUtterance[]) : [],
    profile:
      latestInsight?.profile && typeof latestInsight.profile === 'object'
        ? (latestInsight.profile as LiveSessionSnapshot['profile'])
        : { background: [], stories: [], viewpoints: [] },
    questions: rawQuestions.map((q) => ({ ...q, status: 'new' as const })),
    turnSummaries: Array.isArray(latestInsight?.turnSummaries)
      ? (latestInsight!.turnSummaries as LiveSessionSnapshot['turnSummaries'])
      : [],
    keyPoints: Array.isArray(latestInsight?.keyPoints)
      ? (latestInsight!.keyPoints as string[])
      : [],
    outline,
    targetFields,
    currentTopic:
      typeof latestInsight?.currentTopic === 'string' ? latestInsight.currentTopic : '',
    topicFlow: Array.isArray(latestInsight?.topicFlow)
      ? (latestInsight!.topicFlow as LiveSessionSnapshot['topicFlow'])
      : [],
    finalSummary:
      parsed.finalSummary && typeof parsed.finalSummary === 'object'
        ? (parsed.finalSummary as LiveSessionSnapshot['finalSummary'])
        : null,
    speakerAnalysisMode: prep?.speakerAnalysisMode ?? 'hybrid',
    contentDuplicateHints: [],
  };
}

export async function saveLiveReportAndMinutes(
  snap: LiveSessionSnapshot = snapshot
): Promise<{ minutesPath: string | null; reportPath: string | null }> {
  if (!isTauriRuntime() || !snap.outputDir) {
    return { minutesPath: snap.minutesPath, reportPath: snap.reportPath ?? null };
  }
  const sep = snap.outputDir.includes('\\') ? '\\' : '/';
  const baseDir = snap.outputDir.replace(/[\\/]+$/, '');
  const minutesPath = `${baseDir}${sep}纪要.md`;
  const reportPath = `${baseDir}${sep}analysis-report.json`;

  const md = buildLiveSessionMarkdown(snap);
  const reportDoc = buildLiveAnalysisReportDoc({ ...snap, minutesPath, reportPath });
  const reportJson = JSON.stringify(reportDoc, null, 2);

  await invoke<string>('save_project_file', { filePath: minutesPath, contentJson: md });
  await invoke<string>('save_project_file', { filePath: reportPath, contentJson: reportJson });

  const nextSnap: LiveSessionSnapshot = {
    ...snapshot,
    minutesPath,
    reportPath,
  };
  emitSnap(nextSnap);
  recordRecentLiveSession(nextSnap, reportPath);
  return { minutesPath, reportPath };
}

export async function openLiveSessionFromPath(filePath: string): Promise<LiveSessionSnapshot> {
  const raw = await invoke<string>('load_project_file', { filePath });
  const restored = parseAndRestoreLiveSession(raw, filePath);
  await cleanupHardwareAndTransport();
  emitSnap(restored);
  recordRecentLiveSession(restored, filePath);
  return restored;
}

export async function openLiveSessionFromJsonText(
  rawJson: string,
  filePath?: string
): Promise<LiveSessionSnapshot> {
  const restored = parseAndRestoreLiveSession(rawJson, filePath);
  await cleanupHardwareAndTransport();
  emitSnap(restored);
  if (filePath) {
    recordRecentLiveSession(restored, filePath);
  }
  return restored;
}

async function autoSaveMinutesIfTauri(snap: LiveSessionSnapshot): Promise<void> {
  if (!isTauriRuntime() || !snap.outputDir) return;
  try {
    await saveLiveReportAndMinutes(snap);
  } catch {
    // ignore auto-save failure; user can still export manually
  }
}

export function getLiveSnapshot(): LiveSessionSnapshot {
  return snapshot;
}

export function subscribeLive(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLiveSession(): LiveSessionSnapshot {
  return useSyncExternalStore(subscribeLive, getLiveSnapshot, getLiveSnapshot);
}

export function getLivePhase(): LiveSessionPhase {
  return snapshot.phase;
}

export function useLivePhase(): LiveSessionPhase {
  return useSyncExternalStore(subscribeLive, getLivePhase, getLivePhase);
}

export function getLiveMicLevel(): number {
  return micLevel;
}

export function subscribeLiveMicLevel(listener: () => void): () => void {
  levelListeners.add(listener);
  return () => levelListeners.delete(listener);
}

export function useLiveMicLevel(): number {
  return useSyncExternalStore(subscribeLiveMicLevel, getLiveMicLevel, getLiveMicLevel);
}

export async function startLiveSession(opts: {
  prep: LiveSessionPrep;
  speakers: LiveSpeaker[];
  deviceId?: string;
  projectState: PodcastProjectState;
}): Promise<void> {
  if (
    snapshot.phase === 'starting' ||
    snapshot.phase === 'recording' ||
    snapshot.phase === 'paused' ||
    snapshot.phase === 'stopping'
  ) {
    return;
  }

  await cleanupHardwareAndTransport();
  audioSeq = 0;

  const sessionId = `live_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const initialOutline: LiveOutlineItem[] = opts.prep.outline.map((o) => ({
    id: o.id,
    text: o.text,
    status: 'not_started',
  }));
  const initialTargetFields: LiveTargetFieldItem[] = (opts.prep.targetFields ?? []).map((f) => ({
    id: f.id,
    label: f.label,
    status: 'missing',
  }));

  emitSnap({
    ...createInitialLiveSnapshot(),
    sessionId,
    phase: 'starting',
    scenario: opts.prep.scenario,
    title: opts.prep.title.trim() || opts.prep.topic.trim() || '未命名录制',
    prep: opts.prep,
    speakers: opts.speakers,
    outline: initialOutline,
    targetFields: initialTargetFields,
    speakerAnalysisMode: opts.prep.speakerAnalysisMode ?? 'hybrid',
  });

  const platformCfg = getCachedAiPlatformConfig();
  const asrConfig = platformCfg
    ? buildAsrConfigFromPlatform(platformCfg, opts.projectState.asrConfig)
    : opts.projectState.asrConfig;
  const llmConfig = platformCfg
    ? buildLlmConfigForFeature(platformCfg, 'transcript_analysis', opts.projectState.llmConfig)
    : opts.projectState.llmConfig;
  const correctionLlmConfig = platformCfg
    ? buildLlmConfigForFeature(platformCfg, 'live_correction', opts.projectState.llmConfig)
    : opts.projectState.llmConfig;
  const hotwords = opts.projectState.glossary
    .filter((g) => g.type === 'hotword' && g.word.trim())
    .map((g) => g.word.trim());

  const startPayload = {
    type: 'start',
    sessionId,
    asrEngine: opts.prep.asrEngine,
    enableStreamCorrection: opts.prep.enableStreamCorrection ?? true,
    speakerAnalysisMode: opts.prep.speakerAnalysisMode ?? 'hybrid',
    scenario: opts.prep.scenario,
    title: opts.prep.title.trim() || opts.prep.topic.trim() || '未命名录制',
    prep: {
      topic: opts.prep.topic,
      goals: opts.prep.goals,
      counterpartName: opts.prep.counterpartName,
      counterpartNames: opts.prep.counterpartNames,
      counterpartBackground: opts.prep.counterpartBackground,
      hasHost: opts.prep.hasHost,
      captureAudience: opts.prep.captureAudience,
      outline: opts.prep.outline,
      targetFields: opts.prep.targetFields ?? [],
    },
    speakers: opts.speakers,
    firstSpeakerId: opts.prep.firstSpeakerId,
    asrConfig,
    llmConfig,
    correctionLlmConfig,
    hotwords,
  };

  let captureReady = false;
  let aborted = false;
  const pendingChunks: Int16Array[] = [];
  let resolvedTransport: LiveTransportHandle | null = null;
  let resolvedCapture: LiveAudioCaptureHandle | null = null;

  try {
    const transportPromise = startLiveSessionTransport(startPayload, (ev) => {
      let next = applyLiveEvent(snapshot, ev);
      let deferredAssign: {
        utteranceId: string;
        speakerId: string;
        applyToLabel: boolean;
      } | null = null;

      if (ev.type === 'partial' && partialSpeakerOverride) {
        if (Math.abs(ev.startMs - partialSpeakerOverride.startMs) <= 2000 && next.partial) {
          next = {
            ...next,
            partial: {
              ...next.partial,
              speakerId: partialSpeakerOverride.speakerId,
            },
          };
        } else {
          partialSpeakerOverride = null;
        }
      } else if (ev.type === 'final' && partialSpeakerOverride) {
        const override = partialSpeakerOverride;
        partialSpeakerOverride = null;
        if (Math.abs(ev.utterance.startMs - override.startMs) <= 5000) {
          next = {
            ...next,
            utterances: next.utterances.map((u) =>
              u.id === ev.utterance.id
                ? { ...u, speakerId: override.speakerId, speakerSource: 'manual' }
                : u
            ),
          };
          deferredAssign = {
            utteranceId: ev.utterance.id,
            speakerId: override.speakerId,
            applyToLabel: override.applyToLabel,
          };
        }
      }

      if (!captureReady && next.phase === 'recording') {
        next = { ...next, phase: 'starting' };
      }
      emitSnap(next);

      if (deferredAssign) {
        activeTransport?.send([
          {
            type: 'assign_speaker',
            utteranceId: deferredAssign.utteranceId,
            speakerId: deferredAssign.speakerId,
            applyToLabel: deferredAssign.applyToLabel,
          },
        ]);
      }

      if (ev.type === 'error' && ev.fatal) {
        void cleanupHardwareAndTransport();
      } else if (ev.type === 'stopped') {
        void (async () => {
          await cleanupHardwareAndTransport();
          await autoSaveMinutesIfTauri(snapshot);
        })();
      } else if (ev.type === 'process_exit' && next.phase !== 'recording' && next.phase !== 'paused') {
        void cleanupHardwareAndTransport();
      }
    }).then((tr) => {
      resolvedTransport = tr;
      return tr;
    });

    const capturePromise = startLiveAudioCapture({
      deviceId: opts.deviceId,
      onLevel: (rms) => emitLevel(rms),
      onChunk: (pcm) => {
        if (aborted) return;
        if (
          snapshot.phase === 'paused' ||
          snapshot.phase === 'stopping' ||
          snapshot.phase === 'stopped' ||
          snapshot.phase === 'error'
        ) {
          return;
        }
        if (!activeTransport) {
          if (pendingChunks.length < 200) {
            pendingChunks.push(pcm);
          }
          return;
        }
        const seq = audioSeq++;
        activeTransport.send([{ type: 'audio', pcm: int16ToBase64(pcm), seq }]);
      },
    }).then((cap) => {
      resolvedCapture = cap;
      return cap;
    });

    const [transport, capture] = await Promise.all([transportPromise, capturePromise]);

    const currentPhase = getLivePhase();
    if (currentPhase === 'stopping' || currentPhase === 'stopped') {
      aborted = true;
      await capture.stop().catch(() => {});
      await transport.stop().catch(() => {});
      transport.dispose();
      return;
    }

    activeTransport = transport;
    activeCapture = capture;
    captureReady = true;

    if (pendingChunks.length > 0) {
      const cmds = pendingChunks.splice(0, pendingChunks.length).map((pcm) => ({
        type: 'audio',
        pcm: int16ToBase64(pcm),
        seq: audioSeq++,
      }));
      transport.send(cmds);
    }

    emitSnap({
      ...snapshot,
      outputDir: transport.outputDir || snapshot.outputDir,
      phase: 'recording',
    });
    startElapsedTimer();
  } catch (err) {
    aborted = true;
    pendingChunks.length = 0;
    const capToStop = resolvedCapture as LiveAudioCaptureHandle | null;
    if (capToStop && !activeCapture) {
      await capToStop.stop().catch(() => {});
    }
    const trToStop = resolvedTransport as LiveTransportHandle | null;
    if (trToStop && !activeTransport) {
      await trToStop.stop().catch(() => {});
      trToStop.dispose();
    }
    await cleanupHardwareAndTransport();
    emitSnap({
      ...snapshot,
      phase: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

export function pauseLiveSession(): void {
  if (snapshot.phase !== 'recording') return;
  activeCapture?.pause();
  activeTransport?.send([{ type: 'pause' }]);
  emitLevel(0);
  emitSnap({ ...snapshot, phase: 'paused' });
}

export function resumeLiveSession(): void {
  if (snapshot.phase !== 'paused') return;
  activeTransport?.send([{ type: 'resume' }]);
  activeCapture?.resume();
  emitSnap({ ...snapshot, phase: 'recording' });
}

export async function stopLiveSession(): Promise<void> {
  if (snapshot.phase !== 'recording' && snapshot.phase !== 'paused' && snapshot.phase !== 'starting') {
    return;
  }
  clearElapsedTimer();
  const cap = activeCapture;
  activeCapture = null;
  if (cap) {
    await cap.stop();
  }
  emitLevel(0);
  emitSnap({ ...snapshot, phase: 'stopping', partial: null });
  if (activeTransport) {
    try {
      await activeTransport.stop();
    } catch {
      await cleanupHardwareAndTransport();
      emitSnap({ ...snapshot, phase: 'stopped' });
    }
  } else {
    emitSnap({ ...snapshot, phase: 'stopped' });
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 1e-6 ? dot / denom : 0;
}

const CONTENT_CONTINUATION_RE =
  /^(?:然后|而且|并且|另外|还有|所以|比如|不过|但是|其实|也就是说|换句话说)/;
const CONTENT_QUESTION_RE =
  /(?:请问|怎么看|觉得|能不能|为什么|如何|是否|吗[？?]?$|呢[？?]?$|[？?]$)/;
const CONTENT_STOP_BIGRAMS = new Set([
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '什么',
  '怎么',
  '就是',
  '然后',
  '因为',
  '所以',
  '可以',
  '没有',
  '不是',
  '觉得',
  '还是',
  '一个',
  '一些',
  '如果',
]);

function extractChineseBigrams(text: string): Set<string> {
  const cleaned = text.replace(/[^\u4e00-\u9fa5]/g, '');
  const set = new Set<string>();
  for (let i = 0; i < cleaned.length - 1; i++) {
    const bg = cleaned.slice(i, i + 2);
    if (!CONTENT_STOP_BIGRAMS.has(bg)) {
      set.add(bg);
    }
  }
  return set;
}

function countSharedBigrams(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const item of a) {
    if (b.has(item)) count += 1;
  }
  return count;
}

/**
 * 在修改某段语音的发言人后，基于每段语音保留的声纹信息与内容上下文，找出建议一并修改的其他语音片段。
 */
export function findSpeakerReassignSuggestions(
  utterances: LiveUtterance[],
  sourceUtteranceId: string,
  targetSpeakerId: string,
  speakers?: LiveSpeaker[]
): LiveSpeakerSuggestionCandidate[] {
  const src = utterances.find((u) => u.id === sourceUtteranceId);
  if (!src) return [];

  const srcCluster = src.voiceprintCluster || src.speakerLabel || '';
  const srcVec = src.voiceprintVector;
  const oldSpeakerId = src.speakerId;
  const srcBigrams = extractChineseBigrams(src.text);
  const srcIsQuestion = CONTENT_QUESTION_RE.test(src.text.trim());
  const targetSpk = speakers?.find((s) => s.id === targetSpeakerId);
  const targetIsInterviewer =
    targetSpk?.role === 'self' || targetSpk?.speakerKind === 'host';

  const suggestions: LiveSpeakerSuggestionCandidate[] = [];
  for (const u of utterances) {
    if (u.id === sourceUtteranceId) continue;
    if (u.speakerId === targetSpeakerId) continue;
    if (u.speakerSource === 'manual') continue;

    const uCluster = u.voiceprintCluster || u.speakerLabel || '';
    if (srcCluster && uCluster && srcCluster === uCluster) {
      suggestions.push({
        utteranceId: u.id,
        reason: `相同声纹 (${srcCluster})`,
        similarity: 0.95,
      });
      continue;
    }

    if (srcVec && srcVec.length > 0 && u.voiceprintVector && u.voiceprintVector.length > 0) {
      const sim = cosineSimilarity(srcVec, u.voiceprintVector);
      if (sim >= 0.86) {
        suggestions.push({
          utteranceId: u.id,
          reason: `声纹相似度 ${Math.round(sim * 100)}%`,
          similarity: Number(sim.toFixed(2)),
        });
        continue;
      }
    }

    const uText = u.text.trim();
    const uBigrams = extractChineseBigrams(uText);
    const sharedBigrams = countSharedBigrams(srcBigrams, uBigrams);
    const timeDistMs = Math.abs(u.startMs - src.startMs);

    // 内容关联 1：同原发言人且时间相邻，语义延续或共享关键词
    if (
      u.speakerId === oldSpeakerId &&
      timeDistMs <= 25_000 &&
      (CONTENT_CONTINUATION_RE.test(uText) || sharedBigrams >= 2)
    ) {
      suggestions.push({
        utteranceId: u.id,
        reason: '内容语义连贯',
        similarity: 0.81,
      });
      continue;
    }

    // 内容关联 2：目标为提问/主持人角色且源句与候选句均属提问引导语境
    if (
      targetIsInterviewer &&
      srcIsQuestion &&
      CONTENT_QUESTION_RE.test(uText) &&
      uText.length <= 70
    ) {
      suggestions.push({
        utteranceId: u.id,
        reason: '同属提问/引导内容',
        similarity: 0.78,
      });
      continue;
    }

    // 内容关联 3：跨段内容主题/关键词高度重合
    if (sharedBigrams >= 3 && u.speakerId === oldSpeakerId) {
      suggestions.push({
        utteranceId: u.id,
        reason: '内容主题与视角关联',
        similarity: 0.76,
      });
      continue;
    }

    // 若缺少声纹特征（如极短句 fallback），当属于原发言人且时间相邻时提供次级建议
    if (
      !uCluster &&
      u.speakerId === oldSpeakerId &&
      Math.abs(u.startMs - src.startMs) <= 30_000
    ) {
      suggestions.push({
        utteranceId: u.id,
        reason: '相邻同原发言人短句',
        similarity: 0.72,
      });
    }
  }

  return suggestions;
}

export function assignLiveSpeaker(
  utteranceId: string,
  speakerId: string,
  applyToLabel = true
): void {
  emitSnap({
    ...snapshot,
    utterances: snapshot.utterances.map((u) =>
      u.id === utteranceId ? { ...u, speakerId, speakerSource: 'manual' } : u
    ),
  });
  activeTransport?.send([
    { type: 'assign_speaker', utteranceId, speakerId, applyToLabel },
  ]);
  if (snapshot.phase === 'stopped') {
    void autoSaveMinutesIfTauri(snapshot);
  }
}

export function batchAssignLiveSpeaker(
  utteranceIds: string[],
  speakerId: string,
  applyToLabel = true
): void {
  if (utteranceIds.length === 0) return;
  const idSet = new Set(utteranceIds);
  emitSnap({
    ...snapshot,
    utterances: snapshot.utterances.map((u) =>
      idSet.has(u.id) ? { ...u, speakerId, speakerSource: 'manual' } : u
    ),
  });
  activeTransport?.send(
    utteranceIds.map((utteranceId) => ({
      type: 'assign_speaker',
      utteranceId,
      speakerId,
      applyToLabel,
    }))
  );
  if (snapshot.phase === 'stopped') {
    void autoSaveMinutesIfTauri(snapshot);
  }
}

export function renameLiveSpeaker(speakerId: string, newName: string): void {
  const cleanName = newName.trim();
  if (!cleanName) return;
  const oldName = snapshot.speakers.find((s) => s.id === speakerId)?.name;
  emitSnap({
    ...snapshot,
    speakers: snapshot.speakers.map((s) =>
      s.id === speakerId ? { ...s, name: cleanName } : s
    ),
    topicFlow:
      oldName && oldName !== cleanName && snapshot.topicFlow
        ? snapshot.topicFlow.map((tf) => ({
            ...tf,
            speakers: tf.speakers?.map((n) => (n === oldName ? cleanName : n)),
          }))
        : snapshot.topicFlow,
  });
  activeTransport?.send([{ type: 'rename_speaker', speakerId, name: cleanName }]);
  if (snapshot.phase === 'stopped') {
    void autoSaveMinutesIfTauri(snapshot);
  }
}

function averageVoiceprintVector(utterances: LiveUtterance[]): number[] | null {
  const vecs = utterances
    .map((u) => u.voiceprintVector)
    .filter((v): v is number[] => Array.isArray(v) && v.length > 0);
  if (vecs.length === 0) return null;
  const dim = vecs[0].length;
  const acc = new Array<number>(dim).fill(0);
  let count = 0;
  for (const v of vecs) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) acc[i] += v[i];
    count += 1;
  }
  if (count === 0) return null;
  return acc.map((x) => x / count);
}

/**
 * 检测疑似同一人的发言人列表（基于声纹特征、内容重复线索、推断姓名或同名发言人）。
 */
export function findSuspectedDuplicateSpeakers(
  snap: LiveSessionSnapshot
): SuspectedDuplicateSpeakerPair[] {
  if (snap.speakers.length < 2) return [];
  const uttsBySpeaker = new Map<string, LiveUtterance[]>();
  for (const sp of snap.speakers) uttsBySpeaker.set(sp.id, []);
  for (const u of snap.utterances) {
    const arr = uttsBySpeaker.get(u.speakerId);
    if (arr) arr.push(u);
  }

  const clustersBySpeaker = new Map<string, Set<string>>();
  const avgVecBySpeaker = new Map<string, number[] | null>();
  for (const sp of snap.speakers) {
    const list = uttsBySpeaker.get(sp.id) ?? [];
    const clusters = new Set<string>();
    for (const u of list) {
      const c = u.voiceprintCluster || u.speakerLabel || '';
      if (c) clusters.add(c);
    }
    clustersBySpeaker.set(sp.id, clusters);
    avgVecBySpeaker.set(sp.id, averageVoiceprintVector(list));
  }

  const contentHintMap = new Map<string, { confidence: number; reason: string }>();
  for (const h of snap.contentDuplicateHints ?? []) {
    const key = [h.sourceSpeakerId, h.targetSpeakerId].sort().join('|');
    const prev = contentHintMap.get(key);
    if (!prev || h.confidence > prev.confidence) {
      contentHintMap.set(key, { confidence: h.confidence, reason: h.reason });
    }
  }

  const pairs: SuspectedDuplicateSpeakerPair[] = [];
  for (let i = 0; i < snap.speakers.length; i++) {
    for (let j = i + 1; j < snap.speakers.length; j++) {
      const spA = snap.speakers[i];
      const spB = snap.speakers[j];
      const countA = uttsBySpeaker.get(spA.id)?.length ?? 0;
      const countB = uttsBySpeaker.get(spB.id)?.length ?? 0;

      let similarity = 0;
      let reason = '';
      let sourceType: SuspectedDuplicateSpeakerPair['source'];

      // 1. 共有声纹簇
      const clA = clustersBySpeaker.get(spA.id)!;
      const clB = clustersBySpeaker.get(spB.id)!;
      const sharedCluster = Array.from(clA).find((c) => clB.has(c));
      if (sharedCluster) {
        similarity = 0.95;
        reason = `共有声纹簇 (${sharedCluster})`;
        sourceType = 'voiceprint';
      } else {
        // 2. 平均声纹向量余弦相似度
        const vA = avgVecBySpeaker.get(spA.id);
        const vB = avgVecBySpeaker.get(spB.id);
        if (vA && vB) {
          const sim = cosineSimilarity(vA, vB);
          if (sim >= 0.82) {
            similarity = Number(sim.toFixed(2));
            reason = `声纹特征高度相似 (${Math.round(sim * 100)}%)`;
            sourceType = 'voiceprint';
          }
        }
      }

      // 3. 内容分析重复线索 & 同推断姓名
      const pairKey = [spA.id, spB.id].sort().join('|');
      const contentHint = contentHintMap.get(pairKey);
      const infA = spA.inferredName?.trim();
      const infB = spB.inferredName?.trim();
      const sameInferred = Boolean(infA && infB && infA === infB);

      if (contentHint) {
        if (sourceType === 'voiceprint') {
          similarity = Math.max(similarity, Number(contentHint.confidence.toFixed(2)));
          reason = `${reason} · ${contentHint.reason}`;
          sourceType = 'hybrid';
        } else {
          similarity = Number(contentHint.confidence.toFixed(2));
          reason = contentHint.reason;
          sourceType = 'content';
        }
      } else if (sameInferred) {
        const infReason = `内容均识别为「${infA}」`;
        if (sourceType === 'voiceprint') {
          similarity = Math.max(similarity, 0.9);
          reason = `${reason} · ${infReason}`;
          sourceType = 'hybrid';
        } else {
          similarity = 0.88;
          reason = infReason;
          sourceType = 'content';
        }
      }

      // 4. 同名发言人
      if (!reason && spA.name.trim() && spA.name.trim() === spB.name.trim()) {
        similarity = 0.9;
        reason = '发言人名称相同';
        sourceType = 'name';
      }

      if (!reason) continue;

      // 优先保留发言更多或 role==='self' 的席位作为 target
      const keepA =
        spA.role === 'self' && spB.role !== 'self'
          ? true
          : spB.role === 'self' && spA.role !== 'self'
            ? false
            : countA >= countB;
      const target = keepA ? spA : spB;
      const source = keepA ? spB : spA;
      const targetCount = keepA ? countA : countB;
      const sourceCount = keepA ? countB : countA;

      pairs.push({
        sourceSpeakerId: source.id,
        targetSpeakerId: target.id,
        similarity,
        reason,
        source: sourceType,
        sourceUtteranceCount: sourceCount,
        targetUtteranceCount: targetCount,
      });
    }
  }

  return pairs.sort((a, b) => b.similarity - a.similarity);
}

/**
 * 将 sourceSpeakerId 合并到 targetSpeakerId：
 * 迁移所有发言段落、轮次小结、议题参与人，并移除源发言人席位。
 */
export function mergeLiveSpeakers(
  sourceSpeakerId: string,
  targetSpeakerId: string
): boolean {
  if (!sourceSpeakerId || !targetSpeakerId || sourceSpeakerId === targetSpeakerId) {
    return false;
  }
  const sourceSpeaker = snapshot.speakers.find((s) => s.id === sourceSpeakerId);
  const targetSpeaker = snapshot.speakers.find((s) => s.id === targetSpeakerId);
  if (!sourceSpeaker || !targetSpeaker) {
    return false;
  }

  const affectedUtteranceIds: string[] = [];
  const nextUtterances = snapshot.utterances.map((u) => {
    if (u.speakerId !== sourceSpeakerId) return u;
    affectedUtteranceIds.push(u.id);
    return { ...u, speakerId: targetSpeakerId, speakerSource: 'manual' as const };
  });

  const nextTurnSummaries = snapshot.turnSummaries.map((ts) =>
    ts.speakerId === sourceSpeakerId ? { ...ts, speakerId: targetSpeakerId } : ts
  );

  const nextTopicFlow = snapshot.topicFlow?.map((tf) => {
    if (!tf.speakers || tf.speakers.length === 0) return tf;
    const mapped = tf.speakers.map((name) =>
      name === sourceSpeaker.name ? targetSpeaker.name : name
    );
    return { ...tf, speakers: Array.from(new Set(mapped)) };
  });

  const nextPartial =
    snapshot.partial && snapshot.partial.speakerId === sourceSpeakerId
      ? { ...snapshot.partial, speakerId: targetSpeakerId }
      : snapshot.partial;

  const nextDupHints = (snapshot.contentDuplicateHints ?? []).filter(
    (h) => h.sourceSpeakerId !== sourceSpeakerId && h.targetSpeakerId !== sourceSpeakerId
  );

  emitSnap({
    ...snapshot,
    speakers: snapshot.speakers.filter((s) => s.id !== sourceSpeakerId),
    utterances: nextUtterances,
    turnSummaries: nextTurnSummaries,
    topicFlow: nextTopicFlow,
    partial: nextPartial,
    contentDuplicateHints: nextDupHints,
  });

  if (affectedUtteranceIds.length > 0) {
    activeTransport?.send(
      affectedUtteranceIds.map((utteranceId) => ({
        type: 'assign_speaker',
        utteranceId,
        speakerId: targetSpeakerId,
        applyToLabel: true,
      }))
    );
  }

  if (snapshot.phase === 'stopped') {
    void autoSaveMinutesIfTauri(snapshot);
  }
  return true;
}

export function addAndAssignLiveSpeaker(
  utteranceId: string,
  name: string,
  role: LiveSpeakerRole = 'counterpart',
  applyToLabel = true
): LiveSpeaker {
  const cleanName = name.trim() || `发言人 ${snapshot.speakers.length + 1}`;
  const speaker: LiveSpeaker = {
    id: `spk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: cleanName,
    role,
  };
  emitSnap({
    ...snapshot,
    speakers: [...snapshot.speakers, speaker],
    utterances: snapshot.utterances.map((u) =>
      u.id === utteranceId
        ? { ...u, speakerId: speaker.id, speakerSource: 'manual' }
        : u
    ),
  });
  activeTransport?.send([
    { type: 'add_speaker', speaker },
    { type: 'assign_speaker', utteranceId, speakerId: speaker.id, applyToLabel },
  ]);
  return speaker;
}

function findRecentUtteranceForPartial(startMs?: number): LiveUtterance | undefined {
  if (typeof startMs !== 'number' || snapshot.utterances.length === 0) return undefined;
  for (let i = snapshot.utterances.length - 1; i >= 0; i -= 1) {
    const u = snapshot.utterances[i];
    if (Math.abs(u.startMs - startMs) <= 5000) {
      return u;
    }
  }
  return undefined;
}

/**
 * 为正在实时听写中的片段（partial）指定发言人，并在其定稿后自动继承与同步。
 * 若点选瞬间该句恰好已定稿，则自动回落到对应的刚定稿语句。
 */
export function assignLivePartialSpeaker(
  speakerId: string,
  applyToLabel = true,
  fallbackStartMs?: number
): string | null {
  if (snapshot.partial) {
    partialSpeakerOverride = {
      speakerId,
      applyToLabel,
      startMs: snapshot.partial.startMs,
    };
    emitSnap({
      ...snapshot,
      partial: { ...snapshot.partial, speakerId },
    });
    return null;
  }
  const finalized = findRecentUtteranceForPartial(fallbackStartMs);
  if (finalized) {
    assignLiveSpeaker(finalized.id, speakerId, applyToLabel);
    return finalized.id;
  }
  return null;
}

/**
 * 新建发言人并立即切换给正在实时听写中的片段（partial）。
 * 若点选瞬间该句恰好已定稿，则自动回落到对应的刚定稿语句。
 */
export function addAndAssignLivePartialSpeaker(
  name: string,
  role: LiveSpeakerRole = 'counterpart',
  applyToLabel = true,
  fallbackStartMs?: number
): { speaker: LiveSpeaker; assignedUtteranceId: string | null } {
  const cleanName = name.trim() || `发言人 ${snapshot.speakers.length + 1}`;
  const speaker: LiveSpeaker = {
    id: `spk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: cleanName,
    role,
  };

  if (snapshot.partial) {
    partialSpeakerOverride = {
      speakerId: speaker.id,
      applyToLabel,
      startMs: snapshot.partial.startMs,
    };
    emitSnap({
      ...snapshot,
      speakers: [...snapshot.speakers, speaker],
      partial: { ...snapshot.partial, speakerId: speaker.id },
    });
    activeTransport?.send([{ type: 'add_speaker', speaker }]);
    return { speaker, assignedUtteranceId: null };
  }

  const finalized = findRecentUtteranceForPartial(fallbackStartMs);
  if (finalized) {
    emitSnap({
      ...snapshot,
      speakers: [...snapshot.speakers, speaker],
      utterances: snapshot.utterances.map((u) =>
        u.id === finalized.id
          ? { ...u, speakerId: speaker.id, speakerSource: 'manual' }
          : u
      ),
    });
    activeTransport?.send([
      { type: 'add_speaker', speaker },
      {
        type: 'assign_speaker',
        utteranceId: finalized.id,
        speakerId: speaker.id,
        applyToLabel,
      },
    ]);
    return { speaker, assignedUtteranceId: finalized.id };
  }

  emitSnap({
    ...snapshot,
    speakers: [...snapshot.speakers, speaker],
  });
  activeTransport?.send([{ type: 'add_speaker', speaker }]);
  return { speaker, assignedUtteranceId: null };
}

export function requestLiveInsight(): void {
  activeTransport?.send([{ type: 'request_insight' }]);
}

export function setLiveQuestionStatus(
  questionId: string,
  action: 'adopted' | 'dismissed'
): void {
  emitSnap({
    ...snapshot,
    questions: snapshot.questions.map((q) =>
      q.id === questionId ? { ...q, status: action } : q
    ),
  });
  activeTransport?.send([{ type: 'question_feedback', questionId, action }]);
}

export function overrideLiveOutline(
  id: string,
  status: 'not_started' | 'partial' | 'covered'
): void {
  emitSnap({
    ...snapshot,
    outline: snapshot.outline.map((item) =>
      item.id === id ? { ...item, status } : item
    ),
  });
  activeTransport?.send([{ type: 'outline_override', id, status }]);
}

export function dismissLiveEngineNotice(): void {
  emitSnap({ ...snapshot, engineNotice: null });
}

export function revertLiveUtteranceCorrection(utteranceId: string): void {
  emitSnap({
    ...snapshot,
    utterances: snapshot.utterances.map((u) =>
      u.id === utteranceId && u.rawText
        ? {
            ...u,
            text: u.rawText,
            correctionStatus: 'unchanged',
            streamingCorrectedText: undefined,
          }
        : u
    ),
  });
}

export function setLiveSpeakerAnalysisMode(mode: LiveSpeakerAnalysisMode): void {
  emitSnap({ ...snapshot, speakerAnalysisMode: mode });
  activeTransport?.send([{ type: 'set_speaker_analysis_mode', mode }]);
}

export function applyInferredSpeakerName(speakerId: string): void {
  const sp = snapshot.speakers.find((s) => s.id === speakerId);
  const cleanInf = sp?.inferredName?.trim();
  if (!sp || !cleanInf) return;
  renameLiveSpeaker(speakerId, cleanInf);
  emitSnap({
    ...snapshot,
    speakers: snapshot.speakers.map((s) =>
      s.id === speakerId ? { ...s, inferredName: undefined } : s
    ),
  });
}

export function dismissInferredSpeakerName(speakerId: string): void {
  emitSnap({
    ...snapshot,
    speakers: snapshot.speakers.map((s) =>
      s.id === speakerId ? { ...s, inferredName: undefined } : s
    ),
  });
}

export async function requestLiveSpeakerContentAnalysis(
  projectState: PodcastProjectState
): Promise<{
  ok: boolean;
  mode: 'live' | 'review';
  engine?: string;
  reassignedCount?: number;
  profileCount?: number;
  duplicateCount?: number;
  summary?: string;
  error?: string;
}> {
  const analysisMode = snapshot.speakerAnalysisMode ?? 'hybrid';
  if (snapshot.utterances.length === 0) {
    return { ok: false, mode: activeTransport ? 'live' : 'review', error: '暂无发言内容可分析' };
  }

  emitSnap({ ...snapshot, speakerAnalysisStatus: 'analyzing' });

  if (activeTransport) {
    activeTransport.send([{ type: 'analyze_speakers', mode: analysisMode }]);
    return { ok: true, mode: 'live' };
  }

  try {
    const res = await analyzeLiveSpeakersByContent({
      scenario: snapshot.scenario,
      prep: snapshot.prep,
      speakers: snapshot.speakers,
      utterances: snapshot.utterances,
      mode: analysisMode,
      allowNewSpeakers: snapshot.scenario === 'chat',
      projectState,
    });
    if (!res || res.ok === false) {
      const errMsg = res?.error || '内容辨人分析失败';
      emitSnap({ ...snapshot, speakerAnalysisStatus: 'error' });
      return { ok: false, mode: 'review', error: errMsg };
    }

    const nextSnap = applyLiveEvent(snapshot, {
      type: 'speaker_analysis',
      mode: 'manual',
      engine: res.engine,
      reassignments: res.reassignments ?? [],
      speakerProfiles: res.speakerProfiles ?? [],
      duplicateHints: res.duplicateHints ?? [],
      newSpeakers: res.newSpeakers ?? [],
      summary: res.summary,
    });
    emitSnap(nextSnap);
    if (nextSnap.phase === 'stopped') {
      void autoSaveMinutesIfTauri(nextSnap);
    }
    return {
      ok: true,
      mode: 'review',
      engine: res.engine,
      reassignedCount: res.reassignments?.length ?? 0,
      profileCount: res.speakerProfiles?.length ?? 0,
      duplicateCount: res.duplicateHints?.length ?? 0,
      summary: res.summary,
    };
  } catch (err) {
    emitSnap({ ...snapshot, speakerAnalysisStatus: 'error' });
    return {
      ok: false,
      mode: 'review',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function resetLiveSession(): Promise<void> {
  await cleanupHardwareAndTransport();
  emitSnap(createInitialLiveSnapshot());
}
