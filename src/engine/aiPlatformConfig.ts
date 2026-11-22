import { invoke } from '@tauri-apps/api/core';
import { AsrConfig, LlmConfig, PodcastProjectState } from '../types/podcast';

export type AiProviderId =
  | 'local_sensevoice'
  | 'deepseek'
  | 'gemini'
  | 'openai'
  | 'volcengine_doubao';

export type AiFeatureId =
  | 'asr_transcribe'
  | 'speaker_separation'
  | 'live_correction'
  | 'transcript_analysis'
  | 'shownotes_generate';

export type LlmFeatureProvider = 'local_only' | 'deepseek' | 'gemini' | 'openai';

export interface AiPlatformConfig {
  version: 1;
  providers: {
    deepseek: {
      apiKey: string;
      asrBaseUrl: string;
      llmBaseUrl: string;
      model: string;
    };
    gemini: {
      apiKey: string;
      model: string;
    };
    openai: {
      apiKey: string;
      baseUrl: string;
      model: string;
    };
    volcengine_doubao: {
      volcApiKey: string;
      volcAccessKeyId: string;
      volcSecretAccessKey: string;
      volcAppId: string;
      volcAccessToken: string;
      volcSsdVersion: '200' | '300';
      volcUsername: string;
      volcAccountId: string;
    };
  };
  routing: {
    asrProvider: 'local_sensevoice' | 'deepseek' | 'volcengine_doubao';
    asrFallbackToLocal: boolean;
    enableSingleFileSpeakerSep: boolean;
    analysisProvider: LlmFeatureProvider;
    shownotesProvider: LlmFeatureProvider;
    liveCorrectionProvider: LlmFeatureProvider;
  };
}

export interface AiFeatureDescriptor {
  id: AiFeatureId;
  name: string;
  shortLabel: string;
  description: string;
}

export interface AiProviderDescriptor {
  id: AiProviderId;
  name: string;
  vendor: string;
  badge: string;
  description: string;
  requiresKey: boolean;
  supportedFeatures: AiFeatureId[];
}

export const AI_FEATURES_CATALOG: AiFeatureDescriptor[] = [
  {
    id: 'asr_transcribe',
    name: '语音转写与词级时间轴',
    shortLabel: '语音转写 ASR',
    description: '将多轨或单轨播客音频转为带时间戳与标点的逐字文稿',
  },
  {
    id: 'speaker_separation',
    name: '单文件多说话人分离',
    shortLabel: '说话人分离',
    description: '从单条混音音频中自动区分主持人与嘉宾声纹并拆轨',
  },
  {
    id: 'live_correction',
    name: '录制模式流式纠错',
    shortLabel: '流式辅助纠正',
    description: '录制时先用本地模型快速出字，再由云端大模型流式纠正同音错字与专有名词',
  },
  {
    id: 'transcript_analysis',
    name: 'AI 节目摘要与控场诊断',
    shortLabel: '节目摘要分析',
    description: '生成高点击率标题候选、节目概要与主客控场节奏点评',
  },
  {
    id: 'shownotes_generate',
    name: 'Shownotes 智能生成',
    shortLabel: 'Shownotes 生成',
    description: '提炼结构化节目简介、时间轴章节、活动海报与听友福利',
  },
];

export const AI_PROVIDERS_CATALOG: AiProviderDescriptor[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: '深度求索',
    badge: 'ASR + LLM 全能',
    description: '同时支持云端语音转写 (/v1/tools/asr) 与高性价比中文大模型分析',
    requiresKey: true,
    supportedFeatures: [
      'asr_transcribe',
      'live_correction',
      'transcript_analysis',
      'shownotes_generate',
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    vendor: 'Google AI',
    badge: '长文本 LLM',
    description: '超大上下文窗口，适合整期长播客文稿摘要与 Shownotes 提炼',
    requiresKey: true,
    supportedFeatures: ['live_correction', 'transcript_analysis', 'shownotes_generate'],
  },
  {
    id: 'openai',
    name: 'OpenAI / 兼容网关',
    vendor: 'OpenAI Compatible',
    badge: '通用接口',
    description: '支持 OpenAI 官方及各类兼容 /v1/chat/completions 的第三方中转/本地网关',
    requiresKey: true,
    supportedFeatures: ['live_correction', 'transcript_analysis', 'shownotes_generate'],
  },
  {
    id: 'volcengine_doubao',
    name: '火山引擎豆包语音',
    vendor: '字节跳动 · 火山引擎',
    badge: '高精 ASR + 分轨',
    description: '提供高精度中文语音识别与单文件多说话人自动分离 (200/300)',
    requiresKey: true,
    supportedFeatures: ['asr_transcribe', 'speaker_separation'],
  },
  {
    id: 'local_sensevoice',
    name: '本地离线引擎',
    vendor: 'SenseVoice + Silero VAD',
    badge: '离线免费',
    description: '完全在本机运行的神经网络语音识别与声学分轨，无需网络与 API Key',
    requiresKey: false,
    supportedFeatures: [
      'asr_transcribe',
      'speaker_separation',
      'live_correction',
      'transcript_analysis',
      'shownotes_generate',
    ],
  },
];

const BROWSER_STORAGE_KEY = 'tapwave_local_ai_config_v1';

export interface GeminiModelPreset {
  id: string;
  label: string;
  tag?: string;
  description: string;
}

export const GEMINI_RECOMMENDED_MODELS: GeminiModelPreset[] = [
  {
    id: 'gemini-4-hydrogen',
    label: 'Gemini 4 Hydrogen',
    tag: '推荐',
    description: '新一代高速主力模型，兼顾理解力与响应速度，适合日常文稿分析与纠错',
  },
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    tag: '高效推理',
    description: '高性价比推理模型，推理更快、Token 消耗更低',
  },
  {
    id: 'gemini-4-neon',
    label: 'Gemini 4 Neon',
    tag: '均衡',
    description: '均衡深度推理与长文本归纳能力，适合复杂节目分析与 Shownotes',
  },
  {
    id: 'gemini-4-carbon',
    label: 'Gemini 4 Carbon',
    tag: '旗舰',
    description: '旗舰级复杂推理模型，1M 上下文窗口，适合超长播客深度提炼',
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    tag: 'Flash',
    description: 'Gemini 3 系列最新高性价比 Flash 模型，高吞吐低延迟',
  },
  {
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro',
    tag: 'Preview',
    description: 'Gemini 3 系列高能力 Pro 预览版',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    tag: '旧版兼容',
    description: '旧版快速模型（官方正逐步迁移至新版 Flash / Gemini 4 系列）',
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    tag: '旧版兼容',
    description: '旧版稳定推理模型，保留向后兼容',
  },
];

export function createDefaultAiPlatformConfig(): AiPlatformConfig {
  return {
    version: 1,
    providers: {
      deepseek: {
        apiKey: '',
        asrBaseUrl: 'https://api.deepseek.com',
        llmBaseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
      },
      gemini: {
        apiKey: '',
        model: 'gemini-2.5-flash',
      },
      openai: {
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
      },
      volcengine_doubao: {
        volcApiKey: '',
        volcAccessKeyId: '',
        volcSecretAccessKey: '',
        volcAppId: '',
        volcAccessToken: '',
        volcSsdVersion: '200',
        volcUsername: '',
        volcAccountId: '',
      },
    },
    routing: {
      asrProvider: 'local_sensevoice',
      asrFallbackToLocal: true,
      enableSingleFileSpeakerSep: true,
      analysisProvider: 'deepseek',
      shownotesProvider: 'deepseek',
      liveCorrectionProvider: 'deepseek',
    },
  };
}

export function normalizeAiPlatformConfig(raw: unknown): AiPlatformConfig {
  const def = createDefaultAiPlatformConfig();
  if (!raw || typeof raw !== 'object') return def;
  const obj = raw as Record<string, unknown>;
  const providers = (obj.providers && typeof obj.providers === 'object'
    ? obj.providers
    : {}) as Record<string, unknown>;
  const ds = (providers.deepseek && typeof providers.deepseek === 'object'
    ? providers.deepseek
    : {}) as Record<string, unknown>;
  const gm = (providers.gemini && typeof providers.gemini === 'object'
    ? providers.gemini
    : {}) as Record<string, unknown>;
  const oa = (providers.openai && typeof providers.openai === 'object'
    ? providers.openai
    : {}) as Record<string, unknown>;
  const volc = (providers.volcengine_doubao && typeof providers.volcengine_doubao === 'object'
    ? providers.volcengine_doubao
    : {}) as Record<string, unknown>;
  const routing = (obj.routing && typeof obj.routing === 'object'
    ? obj.routing
    : {}) as Record<string, unknown>;

  const asrProvider =
    routing.asrProvider === 'deepseek' ||
    routing.asrProvider === 'volcengine_doubao' ||
    routing.asrProvider === 'local_sensevoice'
      ? routing.asrProvider
      : def.routing.asrProvider;

  const normalizeLlmProvider = (val: unknown, fallback: LlmFeatureProvider): LlmFeatureProvider =>
    val === 'local_only' || val === 'deepseek' || val === 'gemini' || val === 'openai'
      ? val
      : fallback;

  return {
    version: 1,
    providers: {
      deepseek: {
        apiKey: typeof ds.apiKey === 'string' ? ds.apiKey : def.providers.deepseek.apiKey,
        asrBaseUrl:
          typeof ds.asrBaseUrl === 'string' && ds.asrBaseUrl.trim()
            ? ds.asrBaseUrl
            : def.providers.deepseek.asrBaseUrl,
        llmBaseUrl:
          typeof ds.llmBaseUrl === 'string' && ds.llmBaseUrl.trim()
            ? ds.llmBaseUrl
            : def.providers.deepseek.llmBaseUrl,
        model:
          typeof ds.model === 'string' && ds.model.trim()
            ? ds.model
            : def.providers.deepseek.model,
      },
      gemini: {
        apiKey: typeof gm.apiKey === 'string' ? gm.apiKey : def.providers.gemini.apiKey,
        model:
          typeof gm.model === 'string' && gm.model.trim()
            ? gm.model
            : def.providers.gemini.model,
      },
      openai: {
        apiKey: typeof oa.apiKey === 'string' ? oa.apiKey : def.providers.openai.apiKey,
        baseUrl:
          typeof oa.baseUrl === 'string' && oa.baseUrl.trim()
            ? oa.baseUrl
            : def.providers.openai.baseUrl,
        model:
          typeof oa.model === 'string' && oa.model.trim()
            ? oa.model
            : def.providers.openai.model,
      },
      volcengine_doubao: {
        volcApiKey:
          typeof volc.volcApiKey === 'string'
            ? volc.volcApiKey
            : def.providers.volcengine_doubao.volcApiKey,
        volcAccessKeyId:
          typeof volc.volcAccessKeyId === 'string'
            ? volc.volcAccessKeyId
            : def.providers.volcengine_doubao.volcAccessKeyId,
        volcSecretAccessKey:
          typeof volc.volcSecretAccessKey === 'string'
            ? volc.volcSecretAccessKey
            : def.providers.volcengine_doubao.volcSecretAccessKey,
        volcAppId:
          typeof volc.volcAppId === 'string'
            ? volc.volcAppId
            : def.providers.volcengine_doubao.volcAppId,
        volcAccessToken:
          typeof volc.volcAccessToken === 'string'
            ? volc.volcAccessToken
            : def.providers.volcengine_doubao.volcAccessToken,
        volcSsdVersion: volc.volcSsdVersion === '300' ? '300' : '200',
        volcUsername:
          typeof volc.volcUsername === 'string'
            ? volc.volcUsername
            : def.providers.volcengine_doubao.volcUsername,
        volcAccountId:
          typeof volc.volcAccountId === 'string'
            ? volc.volcAccountId
            : def.providers.volcengine_doubao.volcAccountId,
      },
    },
    routing: {
      asrProvider,
      asrFallbackToLocal:
        typeof routing.asrFallbackToLocal === 'boolean'
          ? routing.asrFallbackToLocal
          : def.routing.asrFallbackToLocal,
      enableSingleFileSpeakerSep:
        typeof routing.enableSingleFileSpeakerSep === 'boolean'
          ? routing.enableSingleFileSpeakerSep
          : def.routing.enableSingleFileSpeakerSep,
      analysisProvider: normalizeLlmProvider(
        routing.analysisProvider,
        def.routing.analysisProvider
      ),
      shownotesProvider: normalizeLlmProvider(
        routing.shownotesProvider,
        def.routing.shownotesProvider
      ),
      liveCorrectionProvider: normalizeLlmProvider(
        routing.liveCorrectionProvider,
        def.routing.liveCorrectionProvider
      ),
    },
  };
}

let cachedPlatformConfig: AiPlatformConfig | null = null;

export function getCachedAiPlatformConfig(): AiPlatformConfig | null {
  return cachedPlatformConfig;
}

export function setCachedAiPlatformConfig(config: AiPlatformConfig): void {
  cachedPlatformConfig = config;
}

function isTauriEnv(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

export async function getAiPlatformStorageDisplayPath(): Promise<string> {
  if (isTauriEnv()) {
    try {
      return await invoke<string>('get_local_ai_config_path');
    } catch {
      return '~/.tapwave/ai_config.json';
    }
  }
  return '浏览器本地存储 (localStorage，仅限本机)';
}

export async function loadAiPlatformConfigLocal(): Promise<AiPlatformConfig> {
  let parsed: unknown = null;
  if (isTauriEnv()) {
    try {
      const raw = await invoke<string>('load_local_ai_config');
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = {};
    }
  } else if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(BROWSER_STORAGE_KEY);
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = {};
    }
  }
  const normalized = normalizeAiPlatformConfig(parsed);
  cachedPlatformConfig = normalized;
  return normalized;
}

export async function saveAiPlatformConfigLocal(
  config: AiPlatformConfig
): Promise<{ path: string; config: AiPlatformConfig }> {
  const normalized = normalizeAiPlatformConfig(config);
  cachedPlatformConfig = normalized;
  const jsonStr = JSON.stringify(normalized, null, 2);

  if (isTauriEnv()) {
    const savedPath = await invoke<string>('save_local_ai_config', {
      configJson: jsonStr,
    });
    return { path: savedPath, config: normalized };
  }

  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(BROWSER_STORAGE_KEY, jsonStr);
  }
  return { path: '浏览器本地存储 (localStorage)', config: normalized };
}

export function maskSecretKey(secret: string): string {
  const clean = secret.trim();
  if (!clean) return '未配置';
  if (clean.length <= 8) return '••••••••';
  return `${clean.slice(0, 4)}••••••${clean.slice(-4)}`;
}

export function hasProviderCredentials(
  config: AiPlatformConfig,
  providerId: AiProviderId
): boolean {
  switch (providerId) {
    case 'local_sensevoice':
      return true;
    case 'deepseek':
      return Boolean(config.providers.deepseek.apiKey.trim());
    case 'gemini':
      return Boolean(config.providers.gemini.apiKey.trim());
    case 'openai':
      return Boolean(config.providers.openai.apiKey.trim());
    case 'volcengine_doubao': {
      const v = config.providers.volcengine_doubao;
      return Boolean(
        v.volcApiKey.trim() ||
          (v.volcAccessKeyId.trim() && v.volcSecretAccessKey.trim()) ||
          (v.volcAppId.trim() && v.volcAccessToken.trim())
      );
    }
  }
}

export function isFeatureUsingProvider(
  config: AiPlatformConfig,
  featureId: AiFeatureId,
  providerId: AiProviderId
): boolean {
  switch (featureId) {
    case 'asr_transcribe':
      return config.routing.asrProvider === providerId;
    case 'speaker_separation':
      if (providerId === 'volcengine_doubao') {
        return (
          config.routing.asrProvider === 'volcengine_doubao' &&
          config.routing.enableSingleFileSpeakerSep
        );
      }
      if (providerId === 'local_sensevoice') {
        return (
          config.routing.asrProvider !== 'volcengine_doubao' ||
          !config.routing.enableSingleFileSpeakerSep
        );
      }
      return false;
    case 'transcript_analysis':
      if (providerId === 'local_sensevoice') {
        return config.routing.analysisProvider === 'local_only';
      }
      return config.routing.analysisProvider === providerId;
    case 'shownotes_generate':
      if (providerId === 'local_sensevoice') {
        return config.routing.shownotesProvider === 'local_only';
      }
      return config.routing.shownotesProvider === providerId;
    case 'live_correction':
      if (providerId === 'local_sensevoice') {
        return config.routing.liveCorrectionProvider === 'local_only';
      }
      return config.routing.liveCorrectionProvider === providerId;
  }
}

export function toggleFeatureForProvider(
  config: AiPlatformConfig,
  featureId: AiFeatureId,
  providerId: AiProviderId
): AiPlatformConfig {
  const next: AiPlatformConfig = {
    ...config,
    routing: { ...config.routing },
  };
  const currentlyActive = isFeatureUsingProvider(config, featureId, providerId);

  switch (featureId) {
    case 'asr_transcribe':
      if (
        providerId === 'local_sensevoice' ||
        providerId === 'deepseek' ||
        providerId === 'volcengine_doubao'
      ) {
        next.routing.asrProvider =
          currentlyActive && providerId !== 'local_sensevoice'
            ? 'local_sensevoice'
            : providerId;
      }
      break;
    case 'speaker_separation':
      if (providerId === 'volcengine_doubao') {
        if (currentlyActive) {
          next.routing.enableSingleFileSpeakerSep = false;
        } else {
          next.routing.asrProvider = 'volcengine_doubao';
          next.routing.enableSingleFileSpeakerSep = true;
        }
      } else if (providerId === 'local_sensevoice') {
        next.routing.enableSingleFileSpeakerSep = !currentlyActive;
      }
      break;
    case 'transcript_analysis':
      if (providerId === 'local_sensevoice') {
        next.routing.analysisProvider = 'local_only';
      } else if (providerId === 'deepseek' || providerId === 'gemini' || providerId === 'openai') {
        next.routing.analysisProvider = currentlyActive ? 'local_only' : providerId;
      }
      break;
    case 'shownotes_generate':
      if (providerId === 'local_sensevoice') {
        next.routing.shownotesProvider = 'local_only';
      } else if (providerId === 'deepseek' || providerId === 'gemini' || providerId === 'openai') {
        next.routing.shownotesProvider = currentlyActive ? 'local_only' : providerId;
      }
      break;
    case 'live_correction':
      if (providerId === 'local_sensevoice') {
        next.routing.liveCorrectionProvider = 'local_only';
      } else if (providerId === 'deepseek' || providerId === 'gemini' || providerId === 'openai') {
        next.routing.liveCorrectionProvider = currentlyActive ? 'local_only' : providerId;
      }
      break;
  }
  return next;
}

export function buildAsrConfigFromPlatform(
  config: AiPlatformConfig,
  existing?: AsrConfig
): AsrConfig {
  const v = config.providers.volcengine_doubao;
  const ds = config.providers.deepseek;
  return {
    ...(existing ?? {}),
    provider: config.routing.asrProvider,
    apiKey: ds.apiKey.trim(),
    baseUrl: ds.asrBaseUrl.trim() || 'https://api.deepseek.com',
    model: existing?.model ?? '',
    fallbackToLocal: config.routing.asrFallbackToLocal,
    volcApiKey: v.volcApiKey.trim(),
    volcAccessKeyId: v.volcAccessKeyId.trim(),
    volcSecretAccessKey: v.volcSecretAccessKey.trim(),
    volcAppId: v.volcAppId.trim(),
    volcAccessToken: v.volcAccessToken.trim(),
    volcSsdVersion: v.volcSsdVersion,
    volcUsername: v.volcUsername.trim(),
    volcAccountId: v.volcAccountId.trim(),
    enableSingleFileSpeakerSep: config.routing.enableSingleFileSpeakerSep,
  };
}

export function buildLlmConfigForFeature(
  config: AiPlatformConfig,
  feature: 'transcript_analysis' | 'shownotes_generate' | 'live_correction',
  fallback?: LlmConfig
): LlmConfig & { forceLocalOnly?: boolean } {
  const chosen =
    feature === 'transcript_analysis'
      ? config.routing.analysisProvider
      : feature === 'shownotes_generate'
      ? config.routing.shownotesProvider
      : config.routing.liveCorrectionProvider;

  if (chosen === 'local_only') {
    return {
      provider: fallback?.provider ?? 'deepseek',
      apiKey: '',
      baseUrl: '',
      model: '',
      forceLocalOnly: true,
    };
  }
  if (chosen === 'gemini') {
    return {
      provider: 'gemini',
      apiKey: config.providers.gemini.apiKey.trim(),
      baseUrl: '',
      model: config.providers.gemini.model.trim() || 'gemini-2.5-flash',
    };
  }
  if (chosen === 'openai') {
    return {
      provider: 'openai',
      apiKey: config.providers.openai.apiKey.trim(),
      baseUrl: config.providers.openai.baseUrl.trim() || 'https://api.openai.com/v1',
      model: config.providers.openai.model.trim() || 'gpt-4o-mini',
    };
  }
  return {
    provider: 'deepseek',
    apiKey: config.providers.deepseek.apiKey.trim(),
    baseUrl: config.providers.deepseek.llmBaseUrl.trim() || 'https://api.deepseek.com/v1',
    model: config.providers.deepseek.model.trim() || 'deepseek-chat',
  };
}

export function applyPlatformConfigToProjectState(
  state: PodcastProjectState,
  config: AiPlatformConfig
): PodcastProjectState {
  const nextAsr = buildAsrConfigFromPlatform(config, state.asrConfig);
  const nextLlm = buildLlmConfigForFeature(config, 'transcript_analysis', state.llmConfig);
  return {
    ...state,
    asrConfig: nextAsr,
    llmConfig: {
      provider: nextLlm.provider,
      apiKey: nextLlm.apiKey,
      baseUrl: nextLlm.baseUrl,
      model: nextLlm.model,
    },
  };
}

export function clearAllAiPlatformSecrets(config: AiPlatformConfig): AiPlatformConfig {
  return {
    ...config,
    providers: {
      deepseek: { ...config.providers.deepseek, apiKey: '' },
      gemini: { ...config.providers.gemini, apiKey: '' },
      openai: { ...config.providers.openai, apiKey: '' },
      volcengine_doubao: {
        ...config.providers.volcengine_doubao,
        volcApiKey: '',
        volcAccessKeyId: '',
        volcSecretAccessKey: '',
        volcAppId: '',
        volcAccessToken: '',
      },
    },
  };
}

export function countConfiguredProviders(config: AiPlatformConfig): number {
  const cloudIds: AiProviderId[] = ['deepseek', 'gemini', 'openai', 'volcengine_doubao'];
  return cloudIds.filter((id) => hasProviderCredentials(config, id)).length;
}

/** 移除指定云端平台的凭据，并将指向该平台的功能路由重置为本地默认 */
export function removeProviderCredentials(
  config: AiPlatformConfig,
  providerId: AiProviderId
): AiPlatformConfig {
  if (providerId === 'local_sensevoice') return config;

  const nextProviders = { ...config.providers };
  if (providerId === 'deepseek') {
    nextProviders.deepseek = { ...nextProviders.deepseek, apiKey: '' };
  } else if (providerId === 'gemini') {
    nextProviders.gemini = { ...nextProviders.gemini, apiKey: '' };
  } else if (providerId === 'openai') {
    nextProviders.openai = { ...nextProviders.openai, apiKey: '' };
  } else if (providerId === 'volcengine_doubao') {
    nextProviders.volcengine_doubao = {
      ...nextProviders.volcengine_doubao,
      volcApiKey: '',
      volcAccessKeyId: '',
      volcSecretAccessKey: '',
      volcAppId: '',
      volcAccessToken: '',
      volcUsername: '',
      volcAccountId: '',
    };
  }

  const nextRouting = { ...config.routing };
  if (nextRouting.asrProvider === providerId) {
    nextRouting.asrProvider = 'local_sensevoice';
  }
  if (providerId === 'volcengine_doubao') {
    nextRouting.enableSingleFileSpeakerSep = false;
  }
  if (nextRouting.analysisProvider === providerId) {
    nextRouting.analysisProvider = 'local_only';
  }
  if (nextRouting.shownotesProvider === providerId) {
    nextRouting.shownotesProvider = 'local_only';
  }
  if (nextRouting.liveCorrectionProvider === providerId) {
    nextRouting.liveCorrectionProvider = 'local_only';
  }

  return {
    ...config,
    providers: nextProviders,
    routing: nextRouting,
  };
}
