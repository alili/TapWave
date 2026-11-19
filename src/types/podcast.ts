export type RecordingMode = 'same_room_sync' | 'multi_device_align';
export type AutoSoloMode = 'natural_ducking' | 'hard_mute' | 'off';
export type DeClickStrength = 'medium' | 'strong';
export type TranscriptGroupingMode = 'text_editor' | 'chronological' | 'by_speaker' | 'outline';
export type EditInteractionMode = 'audio_cut' | 'text_proofread';
export type WorkspaceLayoutMode = 'multitrack' | 'transcript' | 'intro' | 'outro';
export type WaveformSelectionMode = 'snap' | 'free';
export type SpeakerRole = 'host' | 'co_host' | 'guest' | 'ref' | 'bgm';

export interface DetectedSpeechSegmentDto {
  startMs: number;
  endMs: number;
  isSilence: boolean;
}

export interface SpeakerTrack {
  id: string;
  name: string;
  role: SpeakerRole;
  roleLabel: string;
  color: string;
  sourceFileName?: string;
  sourceFilePath?: string;
  filePath?: string;
  audioUrl?: string; // Runtime streaming URL (podaudio:// in Tauri or blob: in Browser)
  durationMs?: number;
  rawLufs: number;
  autoGainDb: number;
  syncOffsetMs: number;
  roomToneStartMs: number;
  roomToneEndMs: number;
  peaks: number[];
  detectedSegments?: DetectedSpeechSegmentDto[];
  solo: boolean;
  muted: boolean;
  isRef?: boolean;
}

export interface RetakeAttempt {
  id: string;
  label: string;
  text: string;
  durationSec: number;
  sourceStartMs: number;
  sourceEndMs: number;
}

export interface TranscriptToken {
  id: string;
  type: 'word' | 'silence' | 'laughter';
  text: string;
  origAsrText?: string;
  aiSuggestedText?: string;
  correctedStatus?: 'ai_applied' | 'manual' | null;
  sourceStartMs: number;
  sourceEndMs: number;
  durationSec: number;
  origDurationSec: number;
  fillerTag?: 'pure' | 'semantic_keep';
  sensitiveHint?: boolean;
  deleted?: boolean;
  cutByWaveform?: boolean;
  subwordTrimmed?: boolean;
  mouthClickCleaned?: boolean;
  trackMuted?: boolean;
  /**
   * 波形精剪后记录“紧邻前一个保留词之后的显式保留间隙（秒）”。
   * 未设置时，时间线沿用相邻保留词之间的自然源码间隔。
   */
  gapBeforeSec?: number;
  bleeped?: boolean;
  bleepStyle?: 'sine_1khz_bleep' | 'reverse_blur' | 'room_tone_mute';
  /** 是否为用户在音轨视图游标处手动插入的空白时长 */
  insertedSilence?: boolean;
}

export interface OverlapSideNote {
  id: string;
  speakerId: string;
  speakerName: string;
  text: string;
  sourceStartMs: number;
  sourceEndMs: number;
  muted: boolean;
  /** When true, overrides default non-primary auto-ducking and keeps secondary voice at full volume */
  keepFullVolume?: boolean;
}

export interface TranscriptBlock {
  blockId: string;
  speakerId: string;
  chapterTitle: string;
  emotionBadge?: string;
  retakeAttempts?: RetakeAttempt[];
  selectedRetakeIndex?: number;
  retakeExpanded?: boolean;
  tokens: TranscriptToken[];
  overlapNote?: OverlapSideNote;
}

/**
 * 单轨波形静音区间（按源码毫秒记录，支持静音气口或他人发言底噪区间）。
 */
export interface TrackMuteRange {
  id: string;
  trackId: string;
  sourceStartMs: number;
  sourceEndMs: number;
}

export interface HighlightMuteInterval {
  id: string;
  trackId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  label?: string;
}

export interface HighlightClip {
  id: string;
  speakerId: string;
  speakerName: string;
  text: string;
  sourceStartMs: number;
  sourceEndMs: number;
  durationSec: number;
  /** 片头编辑器中自定义的起始时间（秒，相对于 00:00）；未设置时按默认顺序自动拼接 */
  introStartSec?: number;
  selectionSource: 'ai_auto' | 'manual_pick' | 'waveform_pick';
  /** 在该金句区间被完全静音的音轨 ID 列表 */
  mutedTrackIds?: string[];
  /** 在该金句区间内部，某些音轨的部分时间片段静音区间 */
  partiallyMutedRanges?: HighlightMuteInterval[];
}

export interface GlossaryItem {
  id: string;
  word: string;
  type: 'hotword' | 'habit' | 'sensitive';
}

export interface SpeakerCoachReport {
  speakerId: string;
  cpm: number;
  fillerPerMin: number;
  trailingDropDb: number;
  speakingSec: number;
  speakingPct: number;
  tips: string[];
}

export interface EmotionMarker {
  timeRatio: number;
  energyScore: number;
  tag?: 'climax' | 'laughter' | 'low_energy';
  label?: string;
}

export interface WeChatVideoConfig {
  aspectRatio: '9:16' | '3:4';
  layout: 'group_left' | 'host_right';
  darkSkin: boolean;
  groupTitle: string;
  showTypingIndicator: boolean;
  laughterStickers: boolean;
}

export type AsrProvider = 'local_sensevoice' | 'deepseek' | 'volcengine_doubao';

export interface AsrConfig {
  provider: AsrProvider;
  apiKey: string;
  baseUrl: string;
  model?: string;
  fallbackToLocal: boolean;
  volcUsername?: string;
  volcAccountId?: string;
  volcAccessKeyId?: string;
  volcSecretAccessKey?: string;
  volcApiKey?: string;
  volcAppId?: string;
  volcAccessToken?: string;
  volcResourceId?: string;
  volcSsdVersion?: '200' | '300';
  enableSingleFileSpeakerSep?: boolean;
}

export interface LlmConfig {
  provider: 'gemini' | 'openai' | 'deepseek';
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface LoadingProgressState {
  active: boolean;
  title: string;
  stage: string;
  percent: number;
  message: string;
  subDetail?: string;
  startedAtMs?: number;
}

export type AuxAudioSlot = 'intro_vo' | 'intro' | 'outro';

export const DEFAULT_BGM_FADE_MS = 800;

export interface BgmTrackAsset {
  fileName: string;
  filePath?: string;
  audioUrl?: string;
  durationSec?: number;
  enabled: boolean;
  /** 自定义/指定播放时长（秒，用于片头/片尾 BGM 等） */
  customDurationSec?: number;
  /** 自定义/指定开始播放时间（秒，用于片头固定口播及片头/片尾 BGM 时间轴起止偏移） */
  startOffsetSec?: number;
  /** 从 BGM 音频文件内部截取的起始时间（秒，默认 0） */
  sourceStartSec?: number;
  /** 从 BGM 音频文件内部截取的结束时间（秒，默认等于文件总时长） */
  sourceEndSec?: number;
  /** 默认淡入时间（毫秒，默认 800ms） */
  fadeInMs?: number;
  /** 默认淡出时间（毫秒，默认 800ms） */
  fadeOutMs?: number;
  /** 伴奏轨音量增益 (dB) */
  gainDb?: number;
  /** 是否静音该 BGM 轨 */
  muted?: boolean;
  /** 是否独奏该 BGM 轨 */
  solo?: boolean;
  /** 波形峰值采样缓存 */
  peaks?: number[];
}

export type CartoonAvatarStyle = 'mic' | 'glasses' | 'headphones' | 'spark' | 'cat' | 'astro';

export type LotteryDrawCondition =
  | 'comment_like'
  | 'keyword_reply'
  | 'random_comment'
  | 'share_screenshot';

export type PosterTheme =
  | 'amber_studio'
  | 'midnight_neon'
  | 'emerald_fresh'
  | 'editorial_cream';

export interface GuestSocialAccount {
  platform: string;
  handle: string;
  url?: string;
}

export interface ShownotesGuest {
  id: string;
  trackId?: string;
  name: string;
  roleLabel: string;
  bio?: string;
  contact: string;
  socialAccount: string;
  socialAccounts?: GuestSocialAccount[];
  avatarStyle: CartoonAvatarStyle;
  avatarBgColor: string;
  avatarSeed: string;
  customAvatarUrl?: string;
}

export interface ShownotesTimelineItem {
  id: string;
  timeSec: number;
  title: string;
  summary?: string;
}

export interface LotteryRuleConfig {
  enabled: boolean;
  prizeName: string;
  winnerCount: number;
  drawCondition: LotteryDrawCondition;
  participationMethod: string;
  keyword?: string;
  deadline: string;
  announcementChannel: string;
}

export interface ShownotesActivityInfo {
  title: string;
  description: string;
  eventTime: string;
  locationOrPlatform: string;
  posterTheme: PosterTheme;
  posterSlogan: string;
  lottery: LotteryRuleConfig;
}

export interface ListenerBenefitItem {
  id: string;
  title: string;
  codeOrLink: string;
  description: string;
}

export interface PodcastShownotes {
  generatedAt?: string;
  episodeTitle: string;
  summary: string;
  guests: ShownotesGuest[];
  timeline: ShownotesTimelineItem[];
  activity: ShownotesActivityInfo;
  benefits: ListenerBenefitItem[];
}

export interface PodcastProjectState {
  projectTitle: string;
  projectFilePath?: string;
  lastSavedAt?: string;
  savedPlayheadSec?: number;
  workDir?: string;
  bgmWavPath?: string;
  introVoiceover?: BgmTrackAsset | null;
  introBgm?: BgmTrackAsset | null;
  outroBgm?: BgmTrackAsset | null;
  aiEpisodeSummary?: string;
  shownotes?: PodcastShownotes;
  playbackRate: number;
  hideDeletedTokens: boolean;
  recordingMode: RecordingMode;
  autoSoloMode: AutoSoloMode;
  duckAttenuationDb: number;
  loudnessAligned: boolean;
  deClickEnabled: boolean;
  deClickStrength: DeClickStrength;
  stripSilenceEnabled: boolean;
  stripSilenceThresholdSec: number;
  stripSilenceTargetSec: number;
  groupingMode: TranscriptGroupingMode;
  speakerFilter: string; // 'all' | speakerId
  interactionMode: EditInteractionMode;
  workspaceLayout?: WorkspaceLayoutMode;
  waveformSelectionMode?: WaveformSelectionMode;
  cutPrerollEnabled?: boolean;
  cutPrerollSec?: number;
  pauseCutJumpEnabled?: boolean;
  coldOpenEnabled: boolean;
  minClipSec: number;
  maxClipSec: number;
  targetTotalHighlightSec: number;
  highlightGapSec?: number;
  autoHighlightGap?: boolean;
  bgmStyle: 'lofi' | 'pulse' | 'acoustic';
  bgmDuckDb: number;
  tracks: SpeakerTrack[];
  blocks: TranscriptBlock[];
  highlights: HighlightClip[];
  trackMuteRanges?: TrackMuteRange[];
  glossary: GlossaryItem[];
  emotionCurve: EmotionMarker[];
  wechatConfig: WeChatVideoConfig;
  llmConfig: LlmConfig;
  asrConfig: AsrConfig;
}

export interface PodCraftProjectFileEnvelope {
  format: 'podcraft-project';
  version: '2.2';
  savedAt: string;
  project: PodcastProjectState;
}
