import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  HardDrive,
  KeyRound,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Sliders,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  AI_FEATURES_CATALOG,
  AI_PROVIDERS_CATALOG,
  AiFeatureId,
  AiPlatformConfig,
  AiProviderId,
  GEMINI_RECOMMENDED_MODELS,
  LlmFeatureProvider,
  clearAllAiPlatformSecrets,
  getAiPlatformStorageDisplayPath,
  hasProviderCredentials,
  isFeatureUsingProvider,
  maskSecretKey,
  removeProviderCredentials,
  toggleFeatureForProvider,
} from '../engine/aiPlatformConfig';

interface AiConfigPlatformModalProps {
  open: boolean;
  config: AiPlatformConfig;
  onClose: () => void;
  onSaveConfig: (nextConfig: AiPlatformConfig) => Promise<void>;
  onOpenDepGuide?: () => void;
}

interface SecretInputFieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  revealed: boolean;
  onToggleReveal: () => void;
  hint?: string;
}

const SecretInputField: React.FC<SecretInputFieldProps> = ({
  label,
  value,
  onChange,
  placeholder,
  revealed,
  onToggleReveal,
  hint,
}) => {
  const configured = Boolean(value.trim());
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-zinc-300 font-medium">{label}</span>
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono ${
            configured
              ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
              : 'bg-zinc-800/80 text-zinc-500 border border-zinc-700/60'
          }`}
        >
          {configured ? (revealed ? '明文显示中' : maskSecretKey(value)) : '未配置'}
        </span>
      </div>
      <div className="relative flex items-center">
        <input
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="w-full pl-2.5 pr-9 py-1.5 rounded-lg border border-zinc-700 focus:border-cyan-500 bg-zinc-950 text-xs font-mono text-zinc-100 focus:outline-none"
        />
        <button
          type="button"
          onClick={onToggleReveal}
          title={revealed ? '隐藏 API Key' : '显示 API Key'}
          aria-label={revealed ? '隐藏 API Key' : '显示 API Key'}
          className="absolute right-1.5 p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition cursor-pointer"
        >
          {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>
      {hint && <div className="text-[10px] text-zinc-500">{hint}</div>}
    </div>
  );
};

export const AiConfigPlatformModal: React.FC<AiConfigPlatformModalProps> = ({
  open,
  config,
  onClose,
  onSaveConfig,
  onOpenDepGuide,
}) => {
  const [draft, setDraft] = useState<AiPlatformConfig>(config);
  const [addedProviders, setAddedProviders] = useState<AiProviderId[]>([]);
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<AiProviderId>(() => {
    const firstConfigured = AI_PROVIDERS_CATALOG.find((p) =>
      hasProviderCredentials(config, p.id)
    );
    return firstConfigured?.id ?? 'local_sensevoice';
  });
  const [revealedKeys, setRevealedKeys] = useState<Record<string, boolean>>({});
  const [revealAll, setRevealAll] = useState(false);
  const [storagePath, setStoragePath] = useState<string>('~/.tapwave/ai_config.json');
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(config);
    setAddedProviders([]);
    setAddPickerOpen(false);
    const firstConfigured = AI_PROVIDERS_CATALOG.find((p) =>
      hasProviderCredentials(config, p.id)
    );
    setSelectedProvider(firstConfigured?.id ?? 'local_sensevoice');
    setRevealedKeys({});
    setRevealAll(false);
    setConfirmClear(false);
    void getAiPlatformStorageDisplayPath().then(setStoragePath);
  }, [open, config]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const isFieldRevealed = (fieldId: string) => revealAll || Boolean(revealedKeys[fieldId]);
  const toggleFieldReveal = (fieldId: string) => {
    if (revealAll) {
      setRevealAll(false);
      setRevealedKeys({ [fieldId]: false });
      return;
    }
    setRevealedKeys((prev) => ({ ...prev, [fieldId]: !prev[fieldId] }));
  };

  const visibleProviders = AI_PROVIDERS_CATALOG.filter(
    (p) => hasProviderCredentials(draft, p.id) || addedProviders.includes(p.id)
  );
  const addableProviders = AI_PROVIDERS_CATALOG.filter(
    (p) => !visibleProviders.some((v) => v.id === p.id)
  );

  const activeProviderMeta =
    visibleProviders.find((p) => p.id === selectedProvider) ??
    visibleProviders[0] ??
    AI_PROVIDERS_CATALOG.find((p) => p.id === selectedProvider) ??
    AI_PROVIDERS_CATALOG[0];

  const handleAddProvider = (providerId: AiProviderId) => {
    setAddedProviders((prev) => (prev.includes(providerId) ? prev : [...prev, providerId]));
    setSelectedProvider(providerId);
    setAddPickerOpen(false);
  };

  const handleRemoveProvider = (providerId: AiProviderId) => {
    if (providerId === 'local_sensevoice') return;
    const nextDraft = removeProviderCredentials(draft, providerId);
    const nextAdded = addedProviders.filter((id) => id !== providerId);
    setDraft(nextDraft);
    setAddedProviders(nextAdded);
    if (selectedProvider === providerId) {
      const remaining = AI_PROVIDERS_CATALOG.filter(
        (p) => hasProviderCredentials(nextDraft, p.id) || nextAdded.includes(p.id)
      );
      setSelectedProvider(remaining[0]?.id ?? 'local_sensevoice');
    }
  };

  const handleToggleAllReveal = () => {
    const next = !revealAll;
    setRevealAll(next);
    if (!next) setRevealedKeys({});
  };

  const handleToggleFeature = (featureId: AiFeatureId, providerId: AiProviderId) => {
    setDraft((prev) => toggleFeatureForProvider(prev, featureId, providerId));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSaveConfig(draft);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const renderFeatureToggleBadge = (providerId: AiProviderId, featureId: AiFeatureId) => {
    const featureMeta = AI_FEATURES_CATALOG.find((f) => f.id === featureId);
    if (!featureMeta) return null;
    const active = isFeatureUsingProvider(draft, featureId, providerId);

    return (
      <div
        key={featureId}
        className={`p-2.5 rounded-xl border transition flex items-center justify-between gap-3 ${
          active
            ? 'border-cyan-500/60 bg-cyan-500/10'
            : 'border-zinc-800 bg-zinc-950/70 hover:border-zinc-700'
        }`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-zinc-100">{featureMeta.name}</span>
            {active && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 text-[10px] font-semibold">
                <CheckCircle2 className="w-2.5 h-2.5" />
                当前启用
              </span>
            )}
          </div>
          <p className="text-[11px] text-zinc-400 mt-0.5">{featureMeta.description}</p>
        </div>

        <button
          type="button"
          onClick={() => handleToggleFeature(featureId, providerId)}
          className={`shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition cursor-pointer ${
            active
              ? 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-sm'
              : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700'
          }`}
        >
          {active ? '已启用' : '切换至此 AI'}
        </button>
      </div>
    );
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl rounded-2xl border border-zinc-700/90 bg-zinc-900 shadow-2xl flex flex-col max-h-[90vh] overflow-hidden"
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between gap-3 shrink-0 bg-zinc-950/60">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-600/20 border border-cyan-500/30 flex items-center justify-center shrink-0">
              <Sliders className="w-4 h-4 text-cyan-400" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                <span>AI 配置平台</span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3" />
                  本地文件隔离存储
                </span>
              </h2>
              <p className="text-[11px] text-zinc-400 truncate">
                统一管理各 AI 平台 API Key 与模型参数，按功能自由切换引擎（密钥仅存本机，不随工程或代码上传）
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleToggleAllReveal}
              className="px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800/80 hover:bg-zinc-700 text-[11px] font-medium text-zinc-200 flex items-center gap-1.5 cursor-pointer transition"
              title={revealAll ? '隐藏所有 API Key' : '显示所有 API Key'}
            >
              {revealAll ? <EyeOff className="w-3.5 h-3.5 text-amber-400" /> : <Eye className="w-3.5 h-3.5 text-cyan-400" />}
              <span>{revealAll ? '全部隐藏' : '全部显示'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer transition"
              aria-label="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 本地配置文件安全提示条 */}
        <div className="px-5 py-2 bg-emerald-950/25 border-b border-emerald-500/20 flex items-center justify-between gap-3 text-[11px] shrink-0">
          <div className="flex items-center gap-2 text-emerald-200/90 min-w-0">
            <HardDrive className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span className="truncate">
              配置文件位置：<code className="px-1.5 py-0.5 rounded bg-zinc-950/80 border border-emerald-500/20 font-mono text-[10px] text-emerald-300">{storagePath}</code>
            </span>
          </div>
          <span className="text-emerald-400/80 shrink-0 hidden sm:inline">
            保存工程 (.podcraft) 时会自动剥离所有密钥
          </span>
        </div>

        {/* 顶部功能项路由总览 */}
        <div className="px-5 py-3 border-b border-zinc-800 bg-zinc-950/40 shrink-0">
          <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-2 flex items-center gap-1.5">
            <Sparkles className="w-3 h-3 text-amber-400" />
            <span>当前功能项 AI 引擎分配（可快捷切换）</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs">
            {/* ASR 路由 */}
            <div className="p-2.5 rounded-xl border border-zinc-800 bg-zinc-900/90 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-zinc-200">语音转写 (ASR)</span>
                <span className="text-[10px] text-zinc-500">字幕与时间轴</span>
              </div>
              <select
                value={draft.routing.asrProvider}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    routing: {
                      ...p.routing,
                      asrProvider: e.target.value as AiPlatformConfig['routing']['asrProvider'],
                    },
                  }))
                }
                className="w-full px-2 py-1 rounded-lg border border-zinc-700 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500"
              >
                <option value="local_sensevoice">本地离线 SenseVoice</option>
                <option value="deepseek">DeepSeek 云端 ASR</option>
                <option value="volcengine_doubao">火山引擎豆包语音</option>
              </select>
              <label className="flex items-center gap-1.5 text-[10px] text-zinc-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.routing.asrFallbackToLocal}
                  onChange={(e) =>
                    setDraft((p) => ({
                      ...p,
                      routing: { ...p.routing, asrFallbackToLocal: e.target.checked },
                    }))
                  }
                />
                <span>云端异常时自动回退本地模型</span>
              </label>
            </div>

            {/* 节目摘要与控场诊断路由 */}
            <div className="p-2.5 rounded-xl border border-zinc-800 bg-zinc-900/90 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-zinc-200">节目摘要与控场诊断</span>
                <span className="text-[10px] text-zinc-500">AI 工作台</span>
              </div>
              <select
                value={draft.routing.analysisProvider}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    routing: {
                      ...p.routing,
                      analysisProvider: e.target.value as LlmFeatureProvider,
                    },
                  }))
                }
                className="w-full px-2 py-1 rounded-lg border border-zinc-700 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500"
              >
                <option value="local_only">仅本地统计分析（不请求云端）</option>
                <option value="deepseek">DeepSeek</option>
                <option value="gemini">Google Gemini</option>
                <option value="openai">OpenAI / 兼容网关</option>
              </select>
              <div className="text-[10px] text-zinc-500">
                {draft.routing.analysisProvider === 'local_only'
                  ? '仅使用本地词库与语速/口癖分析'
                  : hasProviderCredentials(draft, draft.routing.analysisProvider)
                  ? '已配置对应 API Key，可直接调用'
                  : '⚠️ 尚未填写该平台 API Key'}
              </div>
            </div>

            {/* Shownotes 生成路由 */}
            <div className="p-2.5 rounded-xl border border-zinc-800 bg-zinc-900/90 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-zinc-200">Shownotes 智能生成</span>
                <span className="text-[10px] text-zinc-500">简介与时间轴</span>
              </div>
              <select
                value={draft.routing.shownotesProvider}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    routing: {
                      ...p.routing,
                      shownotesProvider: e.target.value as LlmFeatureProvider,
                    },
                  }))
                }
                className="w-full px-2 py-1 rounded-lg border border-zinc-700 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500"
              >
                <option value="local_only">仅本地模板生成（不请求云端）</option>
                <option value="deepseek">DeepSeek</option>
                <option value="gemini">Google Gemini</option>
                <option value="openai">OpenAI / 兼容网关</option>
              </select>
              <div className="text-[10px] text-zinc-500">
                {draft.routing.shownotesProvider === 'local_only'
                  ? '使用本地章节与关键字模板生成'
                  : hasProviderCredentials(draft, draft.routing.shownotesProvider)
                  ? '已配置对应 API Key，可直接调用'
                  : '⚠️ 尚未填写该平台 API Key'}
              </div>
            </div>

            {/* 录制模式流式辅助纠正路由 */}
            <div className="p-2.5 rounded-xl border border-zinc-800 bg-zinc-900/90 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-zinc-200">录制流式纠错</span>
                <span className="text-[10px] text-zinc-500">辅助纠正</span>
              </div>
              <select
                value={draft.routing.liveCorrectionProvider}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    routing: {
                      ...p.routing,
                      liveCorrectionProvider: e.target.value as LlmFeatureProvider,
                    },
                  }))
                }
                className="w-full px-2 py-1 rounded-lg border border-zinc-700 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500"
              >
                <option value="local_only">仅本地快速识别（不纠错）</option>
                <option value="deepseek">DeepSeek 流式纠错</option>
                <option value="gemini">Google Gemini 流式纠错</option>
                <option value="openai">OpenAI / 兼容流式纠错</option>
              </select>
              <div className="text-[10px] text-zinc-500">
                {draft.routing.liveCorrectionProvider === 'local_only'
                  ? '仅使用本地识别原文，不请求云端'
                  : hasProviderCredentials(draft, draft.routing.liveCorrectionProvider)
                  ? '已配置对应 API Key，流式纠错就绪'
                  : '⚠️ 尚未填写该平台 API Key'}
              </div>
            </div>
          </div>
        </div>

        {/* 主体区域：左侧 AI 列表 + 右侧凭据与功能项切换 */}
        <div className="flex-1 min-h-0 flex flex-col sm:flex-row overflow-hidden">
          {/* 左侧 AI 列表（仅显示已配置与待配置平台，支持增减） */}
          <div className="w-full sm:w-64 border-b sm:border-b-0 sm:border-r border-zinc-800 bg-zinc-950/50 p-2.5 space-y-1.5 overflow-y-auto shrink-0">
            <div className="px-1.5 py-1 flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                已配置平台 ({visibleProviders.length})
              </span>
              {addableProviders.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAddPickerOpen((v) => !v)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-300 text-[10px] font-medium cursor-pointer transition"
                  title="添加新的 AI 服务平台"
                >
                  <Plus className="w-3 h-3" />
                  <span>添加</span>
                </button>
              )}
            </div>

            {addPickerOpen && addableProviders.length > 0 && (
              <div className="p-2 rounded-xl border border-cyan-500/35 bg-zinc-900/95 space-y-1.5">
                <div className="flex items-center justify-between text-[10px] text-zinc-400 px-1">
                  <span>选择要添加的平台</span>
                  <button
                    type="button"
                    onClick={() => setAddPickerOpen(false)}
                    className="text-zinc-500 hover:text-zinc-200 cursor-pointer"
                  >
                    收起
                  </button>
                </div>
                {addableProviders.map((ap) => (
                  <button
                    key={ap.id}
                    type="button"
                    onClick={() => handleAddProvider(ap.id)}
                    className="w-full text-left px-2 py-1.5 rounded-lg bg-zinc-950/80 hover:bg-cyan-500/15 border border-zinc-800 hover:border-cyan-500/40 transition cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="text-[11px] font-semibold text-zinc-100 truncate">
                        {ap.name}
                      </span>
                      <span className="text-[9px] text-cyan-300 shrink-0">+ 添加</span>
                    </div>
                    <div className="text-[10px] text-zinc-500 truncate mt-0.5">{ap.badge}</div>
                  </button>
                ))}
              </div>
            )}

            {visibleProviders.map((p) => {
              const isSelected = activeProviderMeta.id === p.id;
              const configured = hasProviderCredentials(draft, p.id);
              const activeCount = p.supportedFeatures.filter((fid) =>
                isFeatureUsingProvider(draft, fid, p.id)
              ).length;

              return (
                <div
                  key={p.id}
                  className={`group relative rounded-xl border transition ${
                    isSelected
                      ? 'border-cyan-500/70 bg-cyan-500/10'
                      : 'border-transparent hover:border-zinc-800 hover:bg-zinc-900/70'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedProvider(p.id)}
                    className="w-full text-left p-2.5 cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-zinc-100 truncate">
                        {p.name}
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {p.requiresKey && (
                          <span
                            role="button"
                            tabIndex={0}
                            title={`移除 ${p.name} 配置`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveProvider(p.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                handleRemoveProvider(p.id);
                              }
                            }}
                            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-rose-500/20 text-zinc-500 hover:text-rose-300 transition"
                          >
                            <Trash2 className="w-3 h-3" />
                          </span>
                        )}
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            configured ? 'bg-emerald-400' : 'bg-amber-400'
                          }`}
                          title={configured ? '已配置凭据' : '待填写 API Key'}
                        />
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-1.5 mt-1">
                      <span className="text-[10px] text-zinc-400 truncate">{p.badge}</span>
                      {activeCount > 0 && (
                        <span className="px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-medium shrink-0">
                          {activeCount} 项启用
                        </span>
                      )}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>

          {/* 右侧详情：API Key 配置 + 支持功能项 */}
          <div className="flex-1 min-w-0 p-5 overflow-y-auto space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-zinc-100">{activeProviderMeta.name}</h3>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-zinc-800 text-zinc-300 border border-zinc-700">
                    {activeProviderMeta.vendor}
                  </span>
                </div>
                <p className="text-xs text-zinc-400 mt-1">{activeProviderMeta.description}</p>
              </div>
              {activeProviderMeta.requiresKey && (
                <button
                  type="button"
                  onClick={() => handleRemoveProvider(activeProviderMeta.id)}
                  title="清空该平台凭据并从已配置列表中移除"
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-rose-500/15 border border-zinc-800 hover:border-rose-500/40 text-zinc-400 hover:text-rose-300 text-[11px] transition cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>移除平台</span>
                </button>
              )}
            </div>

            {/* 凭据配置区 */}
            {selectedProvider === 'deepseek' && (
              <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-950/70 space-y-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                  <KeyRound className="w-3.5 h-3.5 text-cyan-400" />
                  <span>DeepSeek 凭据与接口配置</span>
                </div>
                <SecretInputField
                  label="DeepSeek API Key"
                  value={draft.providers.deepseek.apiKey}
                  onChange={(val) =>
                    setDraft((p) => ({
                      ...p,
                      providers: {
                        ...p.providers,
                        deepseek: { ...p.providers.deepseek, apiKey: val },
                      },
                    }))
                  }
                  placeholder="输入 sk-... (也可设环境变量 DEEPSEEK_API_KEY)"
                  revealed={isFieldRevealed('ds_key')}
                  onToggleReveal={() => toggleFieldReveal('ds_key')}
                />
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-400">对话模型 (Model)</label>
                    <input
                      type="text"
                      value={draft.providers.deepseek.model}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          providers: {
                            ...p.providers,
                            deepseek: { ...p.providers.deepseek, model: e.target.value },
                          },
                        }))
                      }
                      placeholder="deepseek-chat"
                      className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-100 font-mono text-[11px]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-400">LLM Base URL</label>
                    <input
                      type="text"
                      value={draft.providers.deepseek.llmBaseUrl}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          providers: {
                            ...p.providers,
                            deepseek: { ...p.providers.deepseek, llmBaseUrl: e.target.value },
                          },
                        }))
                      }
                      placeholder="https://api.deepseek.com/v1"
                      className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-100 font-mono text-[11px]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-400">ASR Base URL</label>
                    <input
                      type="text"
                      value={draft.providers.deepseek.asrBaseUrl}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          providers: {
                            ...p.providers,
                            deepseek: { ...p.providers.deepseek, asrBaseUrl: e.target.value },
                          },
                        }))
                      }
                      placeholder="https://api.deepseek.com"
                      className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-100 font-mono text-[11px]"
                    />
                  </div>
                </div>
              </div>
            )}

            {selectedProvider === 'gemini' && (
              <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-950/70 space-y-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                  <KeyRound className="w-3.5 h-3.5 text-blue-400" />
                  <span>Google Gemini 凭据与模型配置</span>
                </div>
                <SecretInputField
                  label="Gemini API Key"
                  value={draft.providers.gemini.apiKey}
                  onChange={(val) =>
                    setDraft((p) => ({
                      ...p,
                      providers: {
                        ...p.providers,
                        gemini: { ...p.providers.gemini, apiKey: val },
                      },
                    }))
                  }
                  placeholder="输入 AIza... (也可设环境变量 GEMINI_API_KEY)"
                  revealed={isFieldRevealed('gm_key')}
                  onToggleReveal={() => toggleFieldReveal('gm_key')}
                />
                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] text-zinc-400">Gemini 模型名称</label>
                    <span className="text-[10px] text-zinc-500">
                      支持手动输入或点选当前主流模型
                    </span>
                  </div>
                  <input
                    type="text"
                    list="gemini-recommended-models"
                    value={draft.providers.gemini.model}
                    onChange={(e) =>
                      setDraft((p) => ({
                        ...p,
                        providers: {
                          ...p.providers,
                          gemini: { ...p.providers.gemini, model: e.target.value },
                        },
                      }))
                    }
                    placeholder="例如 gemini-4-hydrogen / gemini-3.8-flash"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-100 font-mono text-[11px]"
                  />
                  <datalist id="gemini-recommended-models">
                    {GEMINI_RECOMMENDED_MODELS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                        {preset.tag ? ` (${preset.tag})` : ''} - {preset.description}
                      </option>
                    ))}
                  </datalist>
                  <div className="flex flex-wrap gap-1.5">
                    {GEMINI_RECOMMENDED_MODELS.map((preset) => {
                      const active = draft.providers.gemini.model.trim() === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          title={preset.description}
                          onClick={() =>
                            setDraft((p) => ({
                              ...p,
                              providers: {
                                ...p.providers,
                                gemini: { ...p.providers.gemini, model: preset.id },
                              },
                            }))
                          }
                          className={`px-2 py-1 rounded-md border text-[10px] transition flex items-center gap-1 cursor-pointer ${
                            active
                              ? 'border-blue-500/70 bg-blue-950/60 text-blue-200'
                              : 'border-zinc-700/80 bg-zinc-900 hover:bg-zinc-800 text-zinc-300'
                          }`}
                        >
                          <span className="font-mono">{preset.id}</span>
                          {preset.tag && (
                            <span
                              className={`px-1 py-0.2 rounded text-[9px] ${
                                active
                                  ? 'bg-blue-500/20 text-blue-300'
                                  : preset.tag === '旧版兼容'
                                    ? 'bg-zinc-800 text-zinc-500'
                                    : 'bg-zinc-800 text-zinc-400'
                              }`}
                            >
                              {preset.tag}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {(() => {
                    const matched = GEMINI_RECOMMENDED_MODELS.find(
                      (m) => m.id === draft.providers.gemini.model.trim(),
                    );
                    return matched ? (
                      <p className="text-[11px] text-zinc-400 leading-relaxed">
                        <span className="text-zinc-300 font-medium">{matched.label}：</span>
                        {matched.description}
                      </p>
                    ) : null;
                  })()}
                </div>
              </div>
            )}

            {selectedProvider === 'openai' && (
              <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-950/70 space-y-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                  <KeyRound className="w-3.5 h-3.5 text-emerald-400" />
                  <span>OpenAI / 兼容网关配置</span>
                </div>
                <SecretInputField
                  label="API Key"
                  value={draft.providers.openai.apiKey}
                  onChange={(val) =>
                    setDraft((p) => ({
                      ...p,
                      providers: {
                        ...p.providers,
                        openai: { ...p.providers.openai, apiKey: val },
                      },
                    }))
                  }
                  placeholder="输入 sk-... (也可设环境变量 OPENAI_API_KEY)"
                  revealed={isFieldRevealed('oa_key')}
                  onToggleReveal={() => toggleFieldReveal('oa_key')}
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-400">Base URL (兼容 /v1)</label>
                    <input
                      type="text"
                      value={draft.providers.openai.baseUrl}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          providers: {
                            ...p.providers,
                            openai: { ...p.providers.openai, baseUrl: e.target.value },
                          },
                        }))
                      }
                      placeholder="https://api.openai.com/v1"
                      className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-100 font-mono text-[11px]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-400">模型名称 (Model)</label>
                    <input
                      type="text"
                      value={draft.providers.openai.model}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          providers: {
                            ...p.providers,
                            openai: { ...p.providers.openai, model: e.target.value },
                          },
                        }))
                      }
                      placeholder="gpt-4o-mini"
                      className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-100 font-mono text-[11px]"
                    />
                  </div>
                </div>
              </div>
            )}

            {selectedProvider === 'volcengine_doubao' && (
              <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-950/70 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                    <KeyRound className="w-3.5 h-3.5 text-amber-400" />
                    <span>火山引擎豆包语音认证凭据</span>
                  </div>
                  <select
                    value={draft.providers.volcengine_doubao.volcSsdVersion}
                    onChange={(e) =>
                      setDraft((p) => ({
                        ...p,
                        providers: {
                          ...p.providers,
                          volcengine_doubao: {
                            ...p.providers.volcengine_doubao,
                            volcSsdVersion: e.target.value === '300' ? '300' : '200',
                          },
                        },
                      }))
                    }
                    className="px-2 py-1 rounded border border-zinc-700 bg-zinc-900 text-[11px] text-zinc-200"
                  >
                    <option value="200">豆包大模型 2.0 (推荐)</option>
                    <option value="300">豆包大模型 3.0</option>
                  </select>
                </div>

                <SecretInputField
                  label="方式一：X-Api-Key 直连密钥 (推荐)"
                  value={draft.providers.volcengine_doubao.volcApiKey}
                  onChange={(val) =>
                    setDraft((p) => ({
                      ...p,
                      providers: {
                        ...p.providers,
                        volcengine_doubao: {
                          ...p.providers.volcengine_doubao,
                          volcApiKey: val,
                        },
                      },
                    }))
                  }
                  placeholder="输入火山引擎豆包语音 API Key"
                  revealed={isFieldRevealed('volc_apikey')}
                  onToggleReveal={() => toggleFieldReveal('volc_apikey')}
                />

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1 border-t border-zinc-800/80">
                  <SecretInputField
                    label="方式二：IAM AccessKey ID (AK)"
                    value={draft.providers.volcengine_doubao.volcAccessKeyId}
                    onChange={(val) =>
                      setDraft((p) => ({
                        ...p,
                        providers: {
                          ...p.providers,
                          volcengine_doubao: {
                            ...p.providers.volcengine_doubao,
                            volcAccessKeyId: val,
                          },
                        },
                      }))
                    }
                    placeholder="AKLT..."
                    revealed={isFieldRevealed('volc_ak')}
                    onToggleReveal={() => toggleFieldReveal('volc_ak')}
                  />
                  <SecretInputField
                    label="IAM SecretAccessKey (SK)"
                    value={draft.providers.volcengine_doubao.volcSecretAccessKey}
                    onChange={(val) =>
                      setDraft((p) => ({
                        ...p,
                        providers: {
                          ...p.providers,
                          volcengine_doubao: {
                            ...p.providers.volcengine_doubao,
                            volcSecretAccessKey: val,
                          },
                        },
                      }))
                    }
                    placeholder="Secret Key..."
                    revealed={isFieldRevealed('volc_sk')}
                    onToggleReveal={() => toggleFieldReveal('volc_sk')}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1 border-t border-zinc-800/80">
                  <SecretInputField
                    label="方式三（旧版）：AppID"
                    value={draft.providers.volcengine_doubao.volcAppId}
                    onChange={(val) =>
                      setDraft((p) => ({
                        ...p,
                        providers: {
                          ...p.providers,
                          volcengine_doubao: {
                            ...p.providers.volcengine_doubao,
                            volcAppId: val,
                          },
                        },
                      }))
                    }
                    placeholder="可选 AppID"
                    revealed={isFieldRevealed('volc_appid')}
                    onToggleReveal={() => toggleFieldReveal('volc_appid')}
                  />
                  <SecretInputField
                    label="Access Token"
                    value={draft.providers.volcengine_doubao.volcAccessToken}
                    onChange={(val) =>
                      setDraft((p) => ({
                        ...p,
                        providers: {
                          ...p.providers,
                          volcengine_doubao: {
                            ...p.providers.volcengine_doubao,
                            volcAccessToken: val,
                          },
                        },
                      }))
                    }
                    placeholder="可选 Access Token"
                    revealed={isFieldRevealed('volc_token')}
                    onToggleReveal={() => toggleFieldReveal('volc_token')}
                  />
                </div>
              </div>
            )}

            {selectedProvider === 'local_sensevoice' && (
              <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-950/70 flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-300">
                    <Cpu className="w-4 h-4" />
                    <span>纯本地离线计算，无需任何 API Key</span>
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    使用本机 SenseVoice INT8 + Silero VAD + CT-Punctuation 模型，音频数据零上传。
                  </p>
                </div>
                {onOpenDepGuide && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenDepGuide();
                    }}
                    className="px-3 py-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 text-xs font-semibold shrink-0 cursor-pointer transition"
                  >
                    检测 / 下载本地模型 →
                  </button>
                )}
              </div>
            )}

            {/* 该 AI 对应的功能项展示与切换 */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-zinc-200">
                  该 AI 支持的功能项（可独立开启或切换）
                </span>
                <span className="text-[11px] text-zinc-500">
                  共 {activeProviderMeta.supportedFeatures.length} 项能力
                </span>
              </div>
              <div className="space-y-2">
                {activeProviderMeta.supportedFeatures.map((fid) =>
                  renderFeatureToggleBadge(selectedProvider, fid)
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-800 bg-zinc-950/70 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2">
            {!confirmClear ? (
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                className="px-2.5 py-1.5 rounded-lg border border-zinc-700 hover:border-red-500/50 hover:bg-red-500/10 text-zinc-400 hover:text-red-300 text-xs flex items-center gap-1.5 cursor-pointer transition"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>清空全部本地 Key</span>
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setDraft((p) => clearAllAiPlatformSecrets(p));
                    setConfirmClear(false);
                  }}
                  className="px-2.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold cursor-pointer transition"
                >
                  确认清空
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClear(false)}
                  className="px-2 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 text-xs cursor-pointer"
                >
                  取消
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => setDraft(config)}
              className="px-2.5 py-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 text-xs flex items-center gap-1 cursor-pointer transition"
              title="还原为当前已保存的配置"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>重置修改</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-700 hover:bg-zinc-800 text-zinc-300 text-xs cursor-pointer transition"
            >
              取消
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={handleSave}
              className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 shadow-sm cursor-pointer transition"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{saving ? '保存中...' : '保存至本地文件并应用'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
