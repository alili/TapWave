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
  LiveSpeakerRole,
  LiveSpeakerSuggestionCandidate,
  LiveTargetFieldItem,
  LiveUtterance,
  LiveUtteranceUploadState,
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
import { isTauriRuntime } from './tauriBridge';

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
  };
}

/**
 * Pure reducer applying a single sidecar NDJSON event onto a LiveSessionSnapshot.
 */
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

    case 'final':
      return {
        ...snap,
        partial: null,
        utterances: [...snap.utterances, ev.utterance],
      };

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
              }
            : u
        ),
      };

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
      const oldStatusById = new Map<string, LiveQuestion['status']>();
      const oldAdoptedOrDismissed: LiveQuestion[] = [];
      for (const q of snap.questions) {
        oldStatusById.set(q.id, q.status);
        if (q.status !== 'new') {
          oldAdoptedOrDismissed.push(q);
        }
      }

      const incomingIds = new Set<string>();
      const mergedQuestions: LiveQuestion[] = ev.questions.map((q) => {
        incomingIds.add(q.id);
        return {
          ...q,
          status: oldStatusById.get(q.id) ?? 'new',
        };
      });
      for (const oldQ of oldAdoptedOrDismissed) {
        if (!incomingIds.has(oldQ.id)) {
          mergedQuestions.push(oldQ);
        }
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

async function autoSaveMinutesIfTauri(snap: LiveSessionSnapshot): Promise<void> {
  if (!isTauriRuntime() || !snap.outputDir) return;
  try {
    const sep = snap.outputDir.includes('\\') ? '\\' : '/';
    const filePath = `${snap.outputDir.replace(/[\\/]+$/, '')}${sep}纪要.md`;
    const md = buildLiveSessionMarkdown(snap);
    await invoke<string>('save_project_file', { filePath, contentJson: md });
    emitSnap({ ...snapshot, minutesPath: filePath });
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

/**
 * 在修改某段语音的发言人后，基于每段语音保留的声纹信息，找出建议一并修改的其他语音片段。
 */
export function findSpeakerReassignSuggestions(
  utterances: LiveUtterance[],
  sourceUtteranceId: string,
  targetSpeakerId: string
): LiveSpeakerSuggestionCandidate[] {
  const src = utterances.find((u) => u.id === sourceUtteranceId);
  if (!src) return [];

  const srcCluster = src.voiceprintCluster || src.speakerLabel || '';
  const srcVec = src.voiceprintVector;
  const oldSpeakerId = src.speakerId;

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
}

export function renameLiveSpeaker(speakerId: string, newName: string): void {
  const cleanName = newName.trim();
  if (!cleanName) return;
  emitSnap({
    ...snapshot,
    speakers: snapshot.speakers.map((s) =>
      s.id === speakerId ? { ...s, name: cleanName } : s
    ),
  });
  activeTransport?.send([{ type: 'rename_speaker', speakerId, name: cleanName }]);
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

export async function resetLiveSession(): Promise<void> {
  await cleanupHardwareAndTransport();
  emitSnap(createInitialLiveSnapshot());
}
