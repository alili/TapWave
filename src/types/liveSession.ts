export type LiveScenario = 'chat' | 'dialogue' | 'listen' | 'interview' | 'sales';
export type LiveAsrEngineMode = 'auto' | 'volcengine' | 'local';
export type LiveSpeakerRole = 'self' | 'counterpart';
export type LiveSpeakerKind =
  | 'host'
  | 'guest'
  | 'interviewer'
  | 'respondent'
  | 'keynote'
  | 'audience';
export type LiveSpeakerAnalysisMode = 'hybrid' | 'voiceprint' | 'content';
export type LiveSpeakerSource =
  | 'cloud'
  | 'voiceprint'
  | 'content'
  | 'hybrid'
  | 'manual'
  | 'fallback';
export type LiveUtteranceUploadState = 'none' | 'pending' | 'uploading' | 'uploaded';

export interface LiveSpeaker {
  id: string;
  name: string;
  role: LiveSpeakerRole;
  speakerKind?: LiveSpeakerKind;
  /** 内容分析推断的建议姓名（如从自我介绍或他人称呼中提取） */
  inferredName?: string;
  /** 内容分析推断的身份/角色/立场视角 */
  inferredIdentity?: string;
  /** 内容身份推断的依据摘要 */
  identityEvidence?: string;
  /** 内容身份推断置信度 (0 ~ 1) */
  identityConfidence?: number;
}

export interface LiveOutlineItem {
  id: string;
  text: string;
  status: 'not_started' | 'partial' | 'covered';
  note?: string;
}

export interface LiveTargetFieldItem {
  id: string;
  label: string;
  status: 'missing' | 'partial' | 'captured';
  value?: string;
  evidenceMs?: number;
}

export interface LiveSessionPrep {
  scenario: LiveScenario;
  title: string;
  topic: string;
  goals: string;
  counterpartName: string;
  counterpartNames?: string[];
  counterpartBackground: string;
  selfName: string;
  speakerCount: number;
  firstSpeakerId: string;
  hasHost?: boolean;
  captureAudience?: boolean;
  asrEngine: LiveAsrEngineMode;
  enableStreamCorrection?: boolean;
  speakerAnalysisMode?: LiveSpeakerAnalysisMode;
  outline: Array<{ id: string; text: string }>;
  targetFields?: Array<{ id: string; label: string }>;
}

export interface LiveUtterance {
  id: string;
  text: string;
  rawText?: string;
  correctionStatus?: 'pending' | 'streaming' | 'done' | 'unchanged';
  streamingCorrectedText?: string;
  startMs: number;
  endMs: number;
  speakerId: string;
  speakerLabel?: string;
  speakerSource: LiveSpeakerSource;
  /** 该段语音保留的声纹簇标识（如 v0 / v1 / c1），手动修改发言人后仍保留 */
  voiceprintCluster?: string;
  /** 声纹匹配置信度 (0 ~ 1) */
  voiceprintConfidence?: number;
  /** 轻量声纹特征向量摘要，用于跨段声纹比对与建议 */
  voiceprintVector?: number[];
  /** 内容/语义分析置信度 (0 ~ 1) */
  contentConfidence?: number;
  /** 内容分析或融合判定的简短原因说明 */
  speakerReason?: string;
}

export interface LiveSpeakerSuggestionCandidate {
  utteranceId: string;
  reason: string;
  similarity?: number;
}

export interface LivePartial {
  text: string;
  startMs: number;
  endMs: number;
  speakerId?: string;
}

export interface LiveProfileBackgroundItem {
  text: string;
  evidenceMs: number;
}

export interface LiveProfileStoryItem {
  title: string;
  gist: string;
  evidenceMs: number;
}

export interface LiveProfileViewpointItem {
  claim: string;
  support: string;
  evidenceMs: number;
}

export interface LiveSalesObjection {
  text: string;
  handled: boolean;
  evidenceMs: number;
}

export interface LiveSalesSignal {
  text: string;
  polarity: 'positive' | 'negative';
  evidenceMs: number;
}

export interface LiveSalesProfile {
  painPoints: string[];
  needs: string[];
  objections: LiveSalesObjection[];
  decisionSignals: LiveSalesSignal[];
}

export interface LiveProfile {
  background: LiveProfileBackgroundItem[];
  stories: LiveProfileStoryItem[];
  viewpoints: LiveProfileViewpointItem[];
  sales?: LiveSalesProfile;
}

export type LiveQuestionType =
  | 'follow_up'
  | 'deepen'
  | 'pivot'
  | 'handle_objection'
  | 'advance';

export interface LiveQuestion {
  id: string;
  type: LiveQuestionType;
  text: string;
  why: string;
  relatedTo: string;
  targetField?: string;
  status: 'new' | 'adopted' | 'dismissed';
  /** 生成该提问的 AI 洞察轮次序号 */
  insightSeq?: number;
  /** 首次生成时间戳 (ms) */
  createdAt?: number;
  /** 是否属于最新一轮 AI 推送（false 表示历史轮次保留） */
  isLatest?: boolean;
}

export interface LiveTurnSummary {
  speakerId: string;
  startMs: number;
  summary: string;
}

export interface LiveTopicFlowItem {
  id: string;
  topic: string;
  status: 'active' | 'ended';
  relevance: 'high' | 'medium' | 'off_topic';
  relevanceNote?: string;
  transitionFrom?: string;
  startMs: number;
  endMs?: number;
  speakers?: string[];
}

export interface LiveFinalSummary {
  overview: string;
  keyTakeaways: string[];
  nextSteps: string[];
}

export type LiveAsrStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'paused' | 'error';
export type LiveLlmStatus = 'idle' | 'thinking' | 'disabled' | 'error';
export type LiveSessionPhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'error';

export interface LiveContentDuplicateHint {
  sourceSpeakerId: string;
  targetSpeakerId: string;
  confidence: number;
  reason: string;
}

export interface LiveSessionSnapshot {
  sessionId: string | null;
  phase: LiveSessionPhase;
  scenario: LiveScenario;
  title: string;
  prep: LiveSessionPrep | null;
  speakers: LiveSpeaker[];
  outputDir: string | null;
  wavPath: string | null;
  sessionJsonPath: string | null;
  minutesPath: string | null;
  reportPath?: string | null;
  asrEngine: string | null;
  engineNotice: string | null;
  asrStatus: LiveAsrStatus;
  asrMessage: string | null;
  llmStatus: LiveLlmStatus;
  llmMessage: string | null;
  elapsedMs: number;
  utterances: LiveUtterance[];
  partial: LivePartial | null;
  profile: LiveProfile;
  questions: LiveQuestion[];
  turnSummaries: LiveTurnSummary[];
  keyPoints: string[];
  outline: LiveOutlineItem[];
  targetFields?: LiveTargetFieldItem[];
  currentTopic?: string;
  topicFlow?: LiveTopicFlowItem[];
  lastInsightAt: number | null;
  analyzingUpToUtteranceId: string | null;
  analyzedUpToUtteranceId: string | null;
  finalSummary: LiveFinalSummary | null;
  errorMessage: string | null;
  speakerAnalysisMode?: LiveSpeakerAnalysisMode;
  contentDuplicateHints?: LiveContentDuplicateHint[];
  speakerAnalysisStatus?: 'idle' | 'analyzing' | 'done' | 'error';
  speakerAnalysisSummary?: string | null;
}

export interface SuspectedDuplicateSpeakerPair {
  sourceSpeakerId: string;
  targetSpeakerId: string;
  similarity: number;
  reason: string;
  source?: 'voiceprint' | 'content' | 'name' | 'hybrid';
  sourceUtteranceCount: number;
  targetUtteranceCount: number;
}

export interface RecentLiveSessionItem {
  sessionId: string;
  title: string;
  scenario: LiveScenario;
  outputDir: string | null;
  reportPath: string;
  wavPath: string | null;
  minutesPath: string | null;
  durationMs: number;
  utteranceCount: number;
  speakerCount: number;
  updatedAt: number;
}

export type LiveSidecarEvent =
  | {
      type: 'ready';
      asrEngine: string;
      wavPath: string;
      outputDir: string;
    }
  | {
      type: 'engine';
      asrEngine: string;
      reason?: string;
    }
  | {
      type: 'status';
      asr?: LiveAsrStatus;
      llm?: LiveLlmStatus;
      message?: string;
    }
  | {
      type: 'partial';
      text: string;
      startMs: number;
      endMs: number;
      speakerId?: string;
    }
  | {
      type: 'final';
      utterance: LiveUtterance;
    }
  | {
      type: 'speaker_added';
      speaker: LiveSpeaker;
    }
  | {
      type: 'utterance_update';
      utteranceId: string;
      speakerId: string;
      speakerSource: LiveSpeakerSource;
      voiceprintCluster?: string;
      contentConfidence?: number;
      speakerReason?: string;
      suggestedUtterances?: LiveSpeakerSuggestionCandidate[];
    }
  | {
      type: 'speaker_analysis';
      mode: 'realtime' | 'manual';
      engine: string;
      reassignments: Array<{
        utteranceId: string;
        speakerId: string;
        speakerSource: 'content' | 'hybrid';
        contentConfidence: number;
        reason: string;
      }>;
      speakerProfiles: Array<{
        speakerId: string;
        inferredName?: string;
        inferredIdentity?: string;
        evidence?: string;
        confidence?: number;
      }>;
      duplicateHints?: LiveContentDuplicateHint[];
      newSpeakers?: LiveSpeaker[];
      summary?: string;
    }
  | {
      type: 'utterance_correction';
      utteranceId: string;
      status: 'streaming' | 'done' | 'unchanged';
      correctedText: string;
      rawText?: string;
    }
  | {
      type: 'insight_request';
      upToUtteranceId: string;
    }
  | {
      type: 'insight';
      seq: number;
      profile: LiveProfile;
      questions: Array<Omit<LiveQuestion, 'status'>>;
      turnSummaries: LiveTurnSummary[];
      keyPoints: string[];
      outlineCoverage: Array<{
        id: string;
        status: 'covered' | 'partial' | 'not_started';
        note?: string;
      }>;
      targetFieldUpdates?: Array<{
        id: string;
        status: 'missing' | 'partial' | 'captured';
        value?: string;
        evidenceMs?: number;
      }>;
      currentTopic?: string;
      topicFlow?: LiveTopicFlowItem[];
      basedOnUtteranceId?: string;
      generatedAt?: number;
    }
  | {
      type: 'final_summary';
      overview: string;
      keyTakeaways: string[];
      nextSteps: string[];
    }
  | {
      type: 'error';
      message: string;
      fatal: boolean;
    }
  | {
      type: 'stopped';
      wavPath: string;
      sessionJsonPath: string;
      durationMs: number;
    }
  | {
      type: 'process_exit';
    };
