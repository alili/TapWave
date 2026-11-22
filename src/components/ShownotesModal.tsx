import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Award,
  BookOpen,
  Check,
  Clock,
  Copy,
  Download,
  FileText,
  Gift,
  Image as ImageIcon,
  Link2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import {
  GuestSocialAccount,
  LotteryDrawCondition,
  PodcastProjectState,
  PodcastShownotes,
  PosterTheme,
  ShownotesGuest,
  ShownotesReferenceCategory,
} from '../types/podcast';
import { TimelineComputation } from '../engine/timelineEngine';
import {
  buildGuestsFromTracks,
  buildLocalShownotes,
  buildPureSrtTranscript,
  buildTimelineItemsFromProject,
  countSummaryChars,
  DRAW_CONDITION_LABELS,
  formatGuestBioTags,
  formatGuestSocialSummary,
  formatGuestWechat,
  formatShownotesMarkdown,
  formatShownotesPlainText,
  formatTimecode,
  formatTimelineRow,
  mergeCloudShownotes,
  REFERENCE_CATEGORY_LABELS,
} from '../engine/shownotesGenerator';
import { runPythonSidecarShownotes } from '../engine/tauriBridge';
import {
  buildLlmConfigForFeature,
  getCachedAiPlatformConfig,
} from '../engine/aiPlatformConfig';
import {
  POSTER_THEME_OPTIONS,
  renderActivityPosterDataUrl,
} from '../engine/posterRenderer';

type ShownotesSection = 'summary' | 'guests' | 'timeline' | 'activity' | 'benefits';

interface ShownotesModalProps {
  open: boolean;
  initialTab?: ShownotesSection;
  state: PodcastProjectState;
  timeline: TimelineComputation;
  onUpdateState: (updater: (prev: PodcastProjectState) => PodcastProjectState) => void;
  onSeekToSec: (sec: number) => void;
  onNotify: (msg: string) => void;
  onClose: () => void;
}

export const ShownotesModal: React.FC<ShownotesModalProps> = ({
  open,
  initialTab,
  state,
  timeline,
  onUpdateState,
  onSeekToSec,
  onNotify,
  onClose,
}) => {
  const [activeSection, setActiveSection] = useState<ShownotesSection>(() => initialTab || 'summary');

  useEffect(() => {
    if (open && initialTab) {
      setActiveSection(initialTab);
    }
  }, [open, initialTab]);
  const [generating, setGenerating] = useState(false);
  const [lastEngineLabel, setLastEngineLabel] = useState<string>('');
  const [copiedType, setCopiedType] = useState<'md' | 'txt' | null>(null);
  const [posterUrl, setPosterUrl] = useState<string>('');
  const [renderingPoster, setRenderingPoster] = useState(false);
  const autoTriggeredRef = useRef(false);

  const cloudAvailability = useMemo(() => {
    const platformCfg = getCachedAiPlatformConfig();
    const routedLlm = platformCfg
      ? buildLlmConfigForFeature(platformCfg, 'shownotes_generate', state.llmConfig)
      : state.llmConfig;
    const forceLocalOnly = Boolean('forceLocalOnly' in routedLlm && routedLlm.forceLocalOnly);
    const hasKey = Boolean(
      routedLlm.apiKey.trim() ||
        state.llmConfig.apiKey.trim() ||
        (state.asrConfig?.provider === 'deepseek' && state.asrConfig?.apiKey?.trim())
    );
    return {
      canUseCloud: !forceLocalOnly && hasKey,
      provider: routedLlm.provider,
    };
  }, [state.llmConfig, state.asrConfig]);

  const shownotes: PodcastShownotes = useMemo(() => {
    if (state.shownotes) return state.shownotes;
    return buildLocalShownotes(state, timeline);
  }, [state, timeline]);

  const updateShownotes = useCallback(
    (updater: (prevSn: PodcastShownotes) => PodcastShownotes) => {
      onUpdateState((prev) => {
        const base = prev.shownotes ?? buildLocalShownotes(prev, timeline);
        return {
          ...prev,
          shownotes: updater(base),
        };
      });
    },
    [onUpdateState, timeline]
  );

  // 一键智能生成：将当前精剪播客文字稿发送给 AI 生成 Shownotes（无密钥或设为仅本地时回退本地智能生成）
  const handleOneClickGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      const localDraft = buildLocalShownotes(state, timeline, state.shownotes);
      const srtTranscript = buildPureSrtTranscript(state, timeline);

      if (!srtTranscript.trim()) {
        setLastEngineLabel('缺少有效录音转文字内容');
        onNotify('⚠️ 当前工程尚无有效的录音转文字内容，请先完成语音转文字后再生成 Shownotes。');
        return;
      }

      let finalShownotes = localDraft;
      let usedCloud = false;
      let fallbackReason = '';

      if (cloudAvailability.canUseCloud) {
        try {
          const res = await runPythonSidecarShownotes(
            state,
            srtTranscript
          );
          if (res?.shownotes && (res.shownotes.summary?.trim() || (res.shownotes.timeline?.length ?? 0) > 0)) {
            finalShownotes = mergeCloudShownotes(localDraft, res.shownotes);
            usedCloud = true;
          } else {
            fallbackReason = res?.fallbackReason || 'AI 返回内容为空或格式无效';
          }
        } catch (err) {
          fallbackReason = String(err);
        }

        if (!usedCloud) {
          setLastEngineLabel(`云端 AI 生成失败（${fallbackReason}）`);
          onNotify(
            `⚠️ 云端 AI 生成 Shownotes 失败（${fallbackReason}），请检查 AI 模型配置或网络后重试。`
          );
          return;
        }
      }

      onUpdateState((prev) => ({
        ...prev,
        shownotes: finalShownotes,
      }));

      if (usedCloud) {
        setLastEngineLabel(
          `已由 ${cloudAvailability.provider} AI 根据 SRT 文字稿（${srtTranscript.length} 字符）生成`
        );
        onNotify(
          `✨ 已将 SRT 录音转文字稿发送给 AI（${cloudAvailability.provider}）并生成 Shownotes！`
        );
      } else {
        setLastEngineLabel('本地智能生成（未配置云端 AI 密钥）');
        onNotify('✨ 已根据当前精剪文稿与时间轴在本地生成完整 Shownotes！');
      }
    } finally {
      setGenerating(false);
    }
  }, [state, timeline, cloudAvailability, onUpdateState, onNotify]);

  // 首次打开时如果工程中尚未持久化 shownotes：写入初始草稿，若已配置云端 AI 则自动把文字稿发给 AI 生成
  useEffect(() => {
    if (!open) {
      autoTriggeredRef.current = false;
      return;
    }
    if (!state.shownotes) {
      const initial = buildLocalShownotes(state, timeline);
      onUpdateState((prev) => ({
        ...prev,
        shownotes: prev.shownotes ?? initial,
      }));
      if (cloudAvailability.canUseCloud && !autoTriggeredRef.current) {
        autoTriggeredRef.current = true;
        void handleOneClickGenerate();
      }
    }
  }, [open, state, timeline, cloudAvailability.canUseCloud, onUpdateState, handleOneClickGenerate]);

  // 生成 / 刷新海报
  const handleRenderPoster = useCallback(
    async (sn: PodcastShownotes) => {
      setRenderingPoster(true);
      try {
        const url = await renderActivityPosterDataUrl(sn);
        setPosterUrl(url);
      } catch (err) {
        onNotify(`海报生成失败: ${String(err)}`);
      } finally {
        setRenderingPoster(false);
      }
    },
    [onNotify]
  );

  // 当切到活动/海报页或海报相关配置变更时自动刷新预览
  useEffect(() => {
    if (!open || activeSection !== 'activity') return;
    const timer = window.setTimeout(() => {
      void handleRenderPoster(shownotes);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [open, activeSection, shownotes, handleRenderPoster]);

  if (!open) return null;

  const summaryChars = countSummaryChars(shownotes.summary);
  const isSummaryIdeal = summaryChars >= 450 && summaryChars <= 580;

  const handleCopy = async (kind: 'md' | 'txt') => {
    const content =
      kind === 'md'
        ? formatShownotesMarkdown(shownotes)
        : formatShownotesPlainText(shownotes);
    try {
      await navigator.clipboard.writeText(content);
      setCopiedType(kind);
      onNotify(kind === 'md' ? '已复制 Markdown 格式 Shownotes' : '已复制纯文本 Shownotes');
      window.setTimeout(() => setCopiedType(null), 1800);
    } catch {
      onNotify('剪贴板写入失败，请手动复制右侧预览文本');
    }
  };

  const handleDownloadMarkdown = () => {
    const md = formatShownotesMarkdown(shownotes);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(shownotes.episodeTitle || 'shownotes').replace(/[\\/:*?"<>|]/g, '_')}_shownotes.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    onNotify('已导出 Shownotes Markdown 文件');
  };

  const handleDownloadPoster = async () => {
    const url = posterUrl || (await renderActivityPosterDataUrl(shownotes));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(shownotes.episodeTitle || 'podcast').replace(/[\\/:*?"<>|]/g, '_')}_活动抽奖海报.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    onNotify('🎨 高清活动抽奖海报 PNG 已下载！');
  };

  const handleAvatarUpload = (guestId: string, file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : undefined;
      if (!dataUrl) return;
      updateShownotes((sn) => ({
        ...sn,
        guests: sn.guests.map((g) =>
          g.id === guestId ? { ...g, customAvatarUrl: dataUrl } : g
        ),
      }));
    };
    reader.readAsDataURL(file);
  };

  const handleBenefitImageUpload = (benefitId: string, file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : undefined;
      if (!dataUrl) return;
      updateShownotes((sn) => ({
        ...sn,
        benefits: sn.benefits.map((b) =>
          b.id === benefitId ? { ...b, imageUrl: dataUrl } : b
        ),
      }));
    };
    reader.readAsDataURL(file);
  };

  const navTabs: Array<{ id: ShownotesSection; label: string; icon: React.ReactNode }> = [
    { id: 'summary', label: '节目简介', icon: <FileText className="w-3.5 h-3.5" /> },
    { id: 'guests', label: `节目嘉宾 (${shownotes.guests.length})`, icon: <Users className="w-3.5 h-3.5" /> },
    { id: 'timeline', label: `时间轴 (${shownotes.timeline.length})`, icon: <Clock className="w-3.5 h-3.5" /> },
    { id: 'activity', label: '活动与抽奖海报', icon: <Award className="w-3.5 h-3.5" /> },
    { id: 'benefits', label: `听友福利 (${shownotes.benefits.length})`, icon: <Gift className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-7xl h-[90vh] rounded-2xl border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-2xl flex flex-col overflow-hidden">
        {/* 顶部栏 */}
        <div className="shrink-0 px-5 py-3.5 border-b border-zinc-800 bg-zinc-900/90 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-zinc-100">
                一键生成 Shownotes 与活动抽奖海报
              </h2>
              <p className="text-[11px] text-zinc-400">
                {lastEngineLabel ||
                  (cloudAvailability.canUseCloud
                    ? `将发送精剪文字稿至 ${cloudAvailability.provider} AI 生成，支持随工程保存`
                    : '基于当前精剪文稿、动态章节与音轨在本地生成，支持随工程保存')}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleOneClickGenerate}
              disabled={generating}
              className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-sm transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${generating ? 'animate-spin' : ''}`} />
              <span>
                {generating
                  ? cloudAvailability.canUseCloud
                    ? 'AI 阅读文稿生成中...'
                    : '本地生成中...'
                  : cloudAvailability.canUseCloud
                  ? '发送文字稿给 AI 生成'
                  : '一键智能生成'}
              </span>
            </button>

            <button
              onClick={() => void handleCopy('md')}
              className="px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs font-medium flex items-center gap-1.5 cursor-pointer"
            >
              {copiedType === 'md' ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5 text-zinc-400" />
              )}
              <span>复制 Markdown</span>
            </button>

            <button
              onClick={() => void handleCopy('txt')}
              className="px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs font-medium flex items-center gap-1.5 cursor-pointer"
            >
              {copiedType === 'txt' ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5 text-zinc-400" />
              )}
              <span>复制纯文本</span>
            </button>

            <button
              onClick={handleDownloadMarkdown}
              className="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>导出 .md</span>
            </button>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer"
              title="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 二级导航 Tab */}
        <div className="shrink-0 px-5 py-2 border-b border-zinc-800 bg-zinc-900/50 flex items-center gap-1.5 overflow-x-auto">
          {navTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveSection(tab.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition cursor-pointer whitespace-nowrap ${
                activeSection === tab.id
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* 主体双栏区域：左侧编辑，右侧实时成稿/海报预览 */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
          {/* 左侧编辑区 */}
          <div className="lg:col-span-7 p-5 overflow-y-auto space-y-4 border-r border-zinc-800/80">
            {/* 1. 节目简介 */}
            {activeSection === 'summary' && (
              <div className="flex flex-col gap-4">
                <div className="shrink-0 space-y-2">
                  <label className="text-xs font-semibold text-zinc-300 block">
                    单集标题
                  </label>
                  <input
                    type="text"
                    value={shownotes.episodeTitle}
                    onChange={(e) =>
                      updateShownotes((sn) => ({ ...sn, episodeTitle: e.target.value }))
                    }
                    placeholder="输入播客单集标题..."
                    className="w-full px-3 py-2 rounded-lg border border-zinc-700 bg-zinc-900 text-sm text-zinc-100 focus:outline-none focus:border-blue-500"
                  />
                  {shownotes.titleOptions && shownotes.titleOptions.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      <span className="text-[11px] text-zinc-400 block">
                        备选标题（点击一键应用）：
                      </span>
                      <div className="grid grid-cols-1 gap-1.5">
                        {shownotes.titleOptions.map((opt, idx) => {
                          const isSelected = shownotes.episodeTitle.trim() === opt.title.trim();
                          return (
                            <button
                              key={`${opt.style}_${idx}`}
                              type="button"
                              onClick={() =>
                                updateShownotes((sn) => ({ ...sn, episodeTitle: opt.title }))
                              }
                              className={`text-left px-2.5 py-1.5 rounded-md border text-xs transition-colors flex items-center gap-2 cursor-pointer ${
                                isSelected
                                  ? 'border-blue-500/60 bg-blue-500/15 text-blue-200'
                                  : 'border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800/80 text-zinc-300'
                              }`}
                            >
                              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                                {opt.label}
                              </span>
                              <span className="truncate">{opt.title}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex flex-col">
                  <div className="shrink-0 flex items-center justify-between mb-1.5">
                    <label className="text-xs font-semibold text-zinc-300">
                      节目简介（建议 500 字左右）
                    </label>
                    <span
                      className={`text-[11px] font-mono px-2 py-0.5 rounded border ${
                        isSummaryIdeal
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                          : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                      }`}
                    >
                      当前 {summaryChars} 字 {isSummaryIdeal ? '✓ 500字标准区间' : '(推荐 450-580 字)'}
                    </span>
                  </div>
                  <textarea
                    value={shownotes.summary}
                    onChange={(e) =>
                      updateShownotes((sn) => ({ ...sn, summary: e.target.value }))
                    }
                    placeholder="点击上方「一键智能生成」，将自动根据精剪文稿生成高质量节目简介..."
                    className="min-h-[280px] w-full px-3 py-2.5 rounded-lg border border-zinc-700 bg-zinc-900 text-xs leading-relaxed text-zinc-100 focus:outline-none focus:border-blue-500 resize-y"
                  />
                </div>

                {/* 提及书影音 / 延伸资料 */}
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                      <BookOpen className="w-3.5 h-3.5 text-blue-400" />
                      <span>提及书影音 / 延伸资料</span>
                      <span className="text-[11px] font-normal text-zinc-500">
                        ({shownotes.references?.length ?? 0})
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        updateShownotes((sn) => ({
                          ...sn,
                          references: [
                            ...(sn.references ?? []),
                            {
                              id: `ref_${Date.now()}`,
                              category: 'book',
                              title: '',
                              note: '',
                            },
                          ],
                        }))
                      }
                      className="px-2 py-1 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[11px] text-zinc-200 flex items-center gap-1 cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                      添加资料
                    </button>
                  </div>
                  {!shownotes.references || shownotes.references.length === 0 ? (
                    <p className="text-[11px] text-zinc-500">
                      未从文稿中检测到提及的书影音或延伸资料，导出 Shownotes 时将自动省略此项。
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {shownotes.references.map((ref, idx) => (
                        <div key={ref.id} className="flex items-center gap-2">
                          <select
                            value={ref.category}
                            onChange={(e) => {
                              const cat = e.target.value as ShownotesReferenceCategory;
                              updateShownotes((sn) => ({
                                ...sn,
                                references: (sn.references ?? []).map((item, i) =>
                                  i === idx ? { ...item, category: cat } : item
                                ),
                              }));
                            }}
                            className="px-2 py-1 rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-200 focus:outline-none focus:border-blue-500"
                          >
                            {Object.entries(REFERENCE_CATEGORY_LABELS).map(([k, lbl]) => (
                              <option key={k} value={k}>
                                {lbl}
                              </option>
                            ))}
                          </select>
                          <input
                            type="text"
                            value={ref.title}
                            onChange={(e) => {
                              const title = e.target.value;
                              updateShownotes((sn) => ({
                                ...sn,
                                references: (sn.references ?? []).map((item, i) =>
                                  i === idx ? { ...item, title } : item
                                ),
                              }));
                            }}
                            placeholder="名称（如《原则》）"
                            className="flex-1 min-w-0 px-2.5 py-1 rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-100 focus:outline-none focus:border-blue-500"
                          />
                          <input
                            type="text"
                            value={ref.note ?? ''}
                            onChange={(e) => {
                              const note = e.target.value;
                              updateShownotes((sn) => ({
                                ...sn,
                                references: (sn.references ?? []).map((item, i) =>
                                  i === idx ? { ...item, note } : item
                                ),
                              }));
                            }}
                            placeholder="简短说明（可选）"
                            className="flex-1 min-w-0 px-2.5 py-1 rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-300 focus:outline-none focus:border-blue-500"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              updateShownotes((sn) => ({
                                ...sn,
                                references: (sn.references ?? []).filter((_, i) => i !== idx),
                              }))
                            }
                            className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800 cursor-pointer"
                            title="删除"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 2. 节目嘉宾 */}
            {activeSection === 'guests' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">
                    支持配置每位嘉宾的名字、联系方式、社交账户与头像
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() =>
                        updateShownotes((sn) => ({
                          ...sn,
                          guests: buildGuestsFromTracks(state.tracks, sn.guests),
                        }))
                      }
                      className="px-2.5 py-1 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-200 cursor-pointer"
                    >
                      从音轨同步
                    </button>
                    <button
                      onClick={() =>
                        updateShownotes((sn) => ({
                          ...sn,
                          guests: [
                            ...sn.guests,
                            {
                              id: `guest_manual_${Date.now()}`,
                              name: '新嘉宾',
                              roleLabel: '特邀嘉宾',
                              bio: '',
                              contact: '',
                              socialAccount: '',
                              socialAccounts: [],
                              avatarStyle: 'spark',
                              avatarBgColor: '#8b5cf6',
                              avatarSeed: `${Date.now()}`,
                            },
                          ],
                        }))
                      }
                      className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>添加嘉宾</span>
                    </button>
                  </div>
                </div>

                {shownotes.guests.map((guest: ShownotesGuest, guestIdx: number) => {
                  const socialList: GuestSocialAccount[] =
                    guest.socialAccounts && guest.socialAccounts.length > 0
                      ? guest.socialAccounts
                      : guest.socialAccount.trim()
                      ? [{ platform: '', handle: guest.socialAccount.trim(), url: '' }]
                      : [];
                  const updateSocialList = (nextList: GuestSocialAccount[]) => {
                    const summaryStr = nextList
                      .map((s) =>
                        [s.platform.trim(), s.handle.trim(), s.url?.trim()]
                          .filter(Boolean)
                          .join(' ')
                      )
                      .filter(Boolean)
                      .join(' · ');
                    updateShownotes((sn) => ({
                      ...sn,
                      guests: sn.guests.map((g) =>
                        g.id === guest.id
                          ? { ...g, socialAccounts: nextList, socialAccount: summaryStr }
                          : g
                      ),
                    }));
                  };

                  return (
                  <div
                    key={guest.id}
                    className="p-3.5 rounded-xl border border-zinc-800 bg-zinc-900/70 space-y-3"
                  >
                    <div className="flex items-start gap-3.5">
                      <div className="flex flex-col items-center gap-1.5 shrink-0">
                        {guest.customAvatarUrl ? (
                          <img
                            src={guest.customAvatarUrl}
                            alt={guest.name}
                            className="w-[60px] h-[60px] rounded-full object-cover border border-zinc-700"
                          />
                        ) : (
                          <div className="w-[60px] h-[60px] rounded-full bg-zinc-800 border border-dashed border-zinc-600 flex items-center justify-center text-zinc-300 text-lg font-semibold select-none">
                            {guest.name.trim().slice(0, 1) || <Users className="w-5 h-5 text-zinc-500" />}
                          </div>
                        )}
                        <label className="text-[10px] text-blue-400 hover:text-blue-300 cursor-pointer flex items-center gap-0.5">
                          <Upload className="w-2.5 h-2.5" />
                          <span>{guest.customAvatarUrl ? '更换头像' : '上传头像'}</span>
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) handleAvatarUpload(guest.id, f);
                              e.target.value = '';
                            }}
                          />
                        </label>
                        {guest.customAvatarUrl && (
                          <button
                            type="button"
                            onClick={() =>
                              updateShownotes((sn) => ({
                                ...sn,
                                guests: sn.guests.map((g) =>
                                  g.id === guest.id ? { ...g, customAvatarUrl: undefined } : g
                                ),
                              }))
                            }
                            className="text-[10px] text-zinc-400 hover:text-red-400 cursor-pointer"
                          >
                            移除
                          </button>
                        )}
                      </div>

                      <div className="flex-1 grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="text-[11px] text-zinc-400 block mb-0.5">名字</span>
                          <input
                            type="text"
                            value={guest.name}
                            onChange={(e) =>
                              updateShownotes((sn) => ({
                                ...sn,
                                guests: sn.guests.map((g) =>
                                  g.id === guest.id ? { ...g, name: e.target.value } : g
                                ),
                              }))
                            }
                            className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                          />
                        </div>
                        <div>
                          <span className="text-[11px] text-zinc-400 block mb-0.5">身份标签</span>
                          <input
                            type="text"
                            value={guest.roleLabel}
                            onChange={(e) =>
                              updateShownotes((sn) => ({
                                ...sn,
                                guests: sn.guests.map((g) =>
                                  g.id === guest.id ? { ...g, roleLabel: e.target.value } : g
                                ),
                              }))
                            }
                            className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                          />
                        </div>
                        <div>
                          <span className="text-[11px] text-zinc-400 block mb-0.5">
                            微信号（默认附在名字后）
                          </span>
                          <input
                            type="text"
                            value={guest.contact}
                            placeholder="例如：wx_id"
                            onChange={(e) =>
                              updateShownotes((sn) => ({
                                ...sn,
                                guests: sn.guests.map((g) =>
                                  g.id === guest.id ? { ...g, contact: e.target.value } : g
                                ),
                              }))
                            }
                            className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                          />
                        </div>
                        <div>
                          <span className="text-[11px] text-zinc-400 block mb-0.5">
                            简介内容标签（以 / 分割）
                          </span>
                          <input
                            type="text"
                            value={guest.bio ?? ''}
                            placeholder="例如：98年保险科班 / 二十年实战 / 剧本杀创始人"
                            onChange={(e) =>
                              updateShownotes((sn) => ({
                                ...sn,
                                guests: sn.guests.map((g) =>
                                  g.id === guest.id ? { ...g, bio: e.target.value } : g
                                ),
                              }))
                            }
                            onBlur={(e) => {
                              const formatted = formatGuestBioTags(e.target.value);
                              if (formatted !== (guest.bio ?? '')) {
                                updateShownotes((sn) => ({
                                  ...sn,
                                  guests: sn.guests.map((g) =>
                                    g.id === guest.id ? { ...g, bio: formatted } : g
                                  ),
                                }));
                              }
                            }}
                            className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                          />
                        </div>
                        <div className="col-span-2 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] text-zinc-400 flex items-center gap-1">
                              <Link2 className="w-3 h-3 text-blue-400" />
                              <span>社交账户与主页链接（可添加多个）</span>
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                updateSocialList([
                                  ...socialList,
                                  { platform: '小红书', handle: '', url: '' },
                                ])
                              }
                              className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[11px] text-blue-300 inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Plus className="w-3 h-3" />
                              <span>添加社交账户</span>
                            </button>
                          </div>
                          {socialList.length === 0 ? (
                            <div className="text-[11px] text-zinc-500 px-2.5 py-1.5 rounded border border-dashed border-zinc-800">
                              暂无社交账户，点击右上角「添加社交账户」可录入即刻、小红书、B站及对应链接
                            </div>
                          ) : (
                            <div className="space-y-1.5">
                              {socialList.map((soc, sIdx) => (
                                <div key={sIdx} className="grid grid-cols-12 gap-1.5 items-center">
                                  <input
                                    type="text"
                                    value={soc.platform}
                                    placeholder="平台(如即刻/小红书)"
                                    onChange={(e) =>
                                      updateSocialList(
                                        socialList.map((item, idx) =>
                                          idx === sIdx ? { ...item, platform: e.target.value } : item
                                        )
                                      )
                                    }
                                    className="col-span-3 px-2 py-1 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 text-[11px]"
                                  />
                                  <input
                                    type="text"
                                    value={soc.handle}
                                    placeholder="账号/昵称"
                                    onChange={(e) =>
                                      updateSocialList(
                                        socialList.map((item, idx) =>
                                          idx === sIdx ? { ...item, handle: e.target.value } : item
                                        )
                                      )
                                    }
                                    className="col-span-4 px-2 py-1 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 text-[11px]"
                                  />
                                  <input
                                    type="url"
                                    value={soc.url ?? ''}
                                    placeholder="链接 https://..."
                                    onChange={(e) =>
                                      updateSocialList(
                                        socialList.map((item, idx) =>
                                          idx === sIdx ? { ...item, url: e.target.value } : item
                                        )
                                      )
                                    }
                                    className="col-span-4 px-2 py-1 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 text-[11px]"
                                  />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateSocialList(socialList.filter((_, idx) => idx !== sIdx))
                                    }
                                    title="删除该社交账户"
                                    className="col-span-1 p-1 text-zinc-500 hover:text-red-400 cursor-pointer flex justify-center"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-col items-center gap-1 shrink-0">
                        <button
                          type="button"
                          disabled={guestIdx === 0}
                          onClick={() =>
                            updateShownotes((sn) => {
                              if (guestIdx === 0) return sn;
                              const next = [...sn.guests];
                              [next[guestIdx - 1], next[guestIdx]] = [
                                next[guestIdx],
                                next[guestIdx - 1],
                              ];
                              return { ...sn, guests: next };
                            })
                          }
                          title="上移嘉宾顺序"
                          className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-default cursor-pointer"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={guestIdx === shownotes.guests.length - 1}
                          onClick={() =>
                            updateShownotes((sn) => {
                              if (guestIdx >= sn.guests.length - 1) return sn;
                              const next = [...sn.guests];
                              [next[guestIdx], next[guestIdx + 1]] = [
                                next[guestIdx + 1],
                                next[guestIdx],
                              ];
                              return { ...sn, guests: next };
                            })
                          }
                          title="下移嘉宾顺序"
                          className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-default cursor-pointer"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() =>
                            updateShownotes((sn) => ({
                              ...sn,
                              guests: sn.guests.filter((g) => g.id !== guest.id),
                            }))
                          }
                          className="p-1 text-zinc-500 hover:text-red-400 cursor-pointer"
                          title="移除嘉宾"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}

            {/* 3. 时间轴 */}
            {activeSection === 'timeline' && (
              <div className="space-y-3">
                <div className="flex items-center justify-end gap-2 flex-nowrap">
                  <button
                    onClick={() => {
                      const hasOverHour = shownotes.timeline.some((item) => item.timeSec >= 3600);
                      const lines = shownotes.timeline
                        .slice()
                        .sort((a, b) => a.timeSec - b.timeSec)
                        .map((t) => formatTimelineRow(t, hasOverHour));
                      navigator.clipboard.writeText(lines.join('\n'));
                      onNotify('📋 已按标准格式复制时间轴至剪贴板');
                    }}
                    title="复制符合小宇宙/Apple Podcasts标准的时间轴文本（时间戳与标题间一个空格隔开，无破折号）"
                    className="px-2.5 py-1 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-200 flex items-center gap-1 cursor-pointer transition whitespace-nowrap shrink-0"
                  >
                    <Copy className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                    <span>复制</span>
                  </button>
                  <button
                    onClick={() => {
                      const sortedTimeline = [...shownotes.timeline].sort((a, b) => a.timeSec - b.timeSec);
                      if (sortedTimeline.length === 0) return;
                      onUpdateState((prev) => {
                        const updatedBlocks = prev.blocks.map((b) => {
                          const bStart = timeline.blockEditedStartsSec[b.blockId] ?? 0;
                          let matchedTitle = sortedTimeline[0]?.title || '';
                          for (let j = sortedTimeline.length - 1; j >= 0; j--) {
                            if (bStart >= sortedTimeline[j].timeSec - 0.5) {
                              matchedTitle = sortedTimeline[j].title;
                              break;
                            }
                          }
                          return { ...b, chapterTitle: matchedTitle };
                        });
                        return { ...prev, blocks: updatedBlocks };
                      });
                      onNotify(`✓ 已将 ${shownotes.timeline.length} 个 Shownotes 智能章节应用至文稿与波形时间轴`);
                    }}
                    title="将 Shownotes 提取的智能章节同步写回文稿各段落与波形时间轴"
                    className="px-2.5 py-1 rounded-lg border border-indigo-500/40 bg-indigo-500/15 hover:bg-indigo-500/25 text-xs text-indigo-300 font-medium flex items-center gap-1 cursor-pointer transition whitespace-nowrap shrink-0"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                    <span>应用到章节</span>
                  </button>
                  <button
                    onClick={() =>
                      updateShownotes((sn) => ({
                        ...sn,
                        timeline: buildTimelineItemsFromProject(state, timeline),
                      }))
                    }
                    title="同步精剪时间轴"
                    className="px-2.5 py-1 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-200 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    同步精剪
                  </button>
                  <button
                    onClick={() =>
                      updateShownotes((sn) => ({
                        ...sn,
                        timeline: [
                          ...sn.timeline,
                          {
                            id: `tl_m_${Date.now()}`,
                            timeSec: Math.round(timeline.totalEditedDurationSec / 2),
                            title: '新话题节点',
                            summary: '',
                          },
                        ],
                      }))
                    }
                    className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5 shrink-0" />
                    <span>添加节点</span>
                  </button>
                </div>

                {shownotes.timeline.map((item) => (
                  <div
                    key={item.id}
                    className="p-3 rounded-xl border border-zinc-800 bg-zinc-900/70 flex items-start gap-2.5 text-xs"
                  >
                    <button
                      onClick={() => onSeekToSec(item.timeSec)}
                      title="点击跳转播放位置"
                      className="px-2 py-1.5 rounded bg-blue-500/15 border border-blue-500/30 text-blue-300 font-mono font-semibold hover:bg-blue-500/25 cursor-pointer shrink-0"
                    >
                      {formatTimecode(item.timeSec)}
                    </button>

                    <div className="w-20 shrink-0">
                      <input
                        type="number"
                        min={0}
                        value={item.timeSec}
                        onChange={(e) => {
                          const val = Math.max(0, Number(e.target.value) || 0);
                          updateShownotes((sn) => ({
                            ...sn,
                            timeline: sn.timeline.map((t) =>
                              t.id === item.id ? { ...t, timeSec: val } : t
                            ),
                          }));
                        }}
                        className="w-full px-2 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-200 font-mono"
                        title="时间点（秒）"
                      />
                    </div>

                    <div className="flex-1 space-y-1.5">
                      <input
                        type="text"
                        value={item.title}
                        onChange={(e) =>
                          updateShownotes((sn) => ({
                            ...sn,
                            timeline: sn.timeline.map((t) =>
                              t.id === item.id ? { ...t, title: e.target.value } : t
                            ),
                          }))
                        }
                        placeholder="章节标题"
                        className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 font-medium"
                      />
                      <input
                        type="text"
                        value={item.summary ?? ''}
                        onChange={(e) =>
                          updateShownotes((sn) => ({
                            ...sn,
                            timeline: sn.timeline.map((t) =>
                              t.id === item.id ? { ...t, summary: e.target.value } : t
                            ),
                          }))
                        }
                        placeholder="一句话看点补充（可选）"
                        className="w-full px-2.5 py-1 rounded border border-zinc-800 bg-zinc-950 text-zinc-300"
                      />
                    </div>

                    <button
                      onClick={() =>
                        updateShownotes((sn) => ({
                          ...sn,
                          timeline: sn.timeline.filter((t) => t.id !== item.id),
                        }))
                      }
                      className="p-1 text-zinc-500 hover:text-red-400 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* 4. 活动信息、抽奖规则与海报配置 */}
            {activeSection === 'activity' && (
              <div className="space-y-4 text-xs">
                <div className="p-3.5 rounded-xl border border-zinc-800 bg-zinc-900/70 space-y-2.5">
                  <div className="font-semibold text-zinc-100">📣 活动基础信息</div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="col-span-2">
                      <span className="text-[11px] text-zinc-400 block mb-0.5">活动标题</span>
                      <input
                        type="text"
                        value={shownotes.activity.title}
                        onChange={(e) =>
                          updateShownotes((sn) => ({
                            ...sn,
                            activity: { ...sn.activity, title: e.target.value },
                          }))
                        }
                        className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                      />
                    </div>
                    <div>
                      <span className="text-[11px] text-zinc-400 block mb-0.5">活动时间</span>
                      <input
                        type="text"
                        value={shownotes.activity.eventTime}
                        onChange={(e) =>
                          updateShownotes((sn) => ({
                            ...sn,
                            activity: { ...sn.activity, eventTime: e.target.value },
                          }))
                        }
                        className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                      />
                    </div>
                    <div>
                      <span className="text-[11px] text-zinc-400 block mb-0.5">参与平台 / 地点</span>
                      <input
                        type="text"
                        value={shownotes.activity.locationOrPlatform}
                        onChange={(e) =>
                          updateShownotes((sn) => ({
                            ...sn,
                            activity: { ...sn.activity, locationOrPlatform: e.target.value },
                          }))
                        }
                        className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                      />
                    </div>
                    <div className="col-span-2">
                      <span className="text-[11px] text-zinc-400 block mb-0.5">活动说明</span>
                      <textarea
                        rows={2}
                        value={shownotes.activity.description}
                        onChange={(e) =>
                          updateShownotes((sn) => ({
                            ...sn,
                            activity: { ...sn.activity, description: e.target.value },
                          }))
                        }
                        className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                      />
                    </div>
                  </div>
                </div>

                {/* 抽奖规则配置 */}
                <div className="p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-amber-300">🎁 抽奖规则配置</span>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={shownotes.activity.lottery.enabled}
                        onChange={(e) =>
                          updateShownotes((sn) => ({
                            ...sn,
                            activity: {
                              ...sn.activity,
                              lottery: { ...sn.activity.lottery, enabled: e.target.checked },
                            },
                          }))
                        }
                        className="accent-amber-500"
                      />
                      <span className="text-zinc-200">开启本期抽奖</span>
                    </label>
                  </div>

                  {shownotes.activity.lottery.enabled && (
                    <div className="grid grid-cols-2 gap-2.5 pt-1">
                      <div>
                        <span className="text-[11px] text-zinc-400 block mb-0.5">奖品名称</span>
                        <input
                          type="text"
                          value={shownotes.activity.lottery.prizeName}
                          onChange={(e) =>
                            updateShownotes((sn) => ({
                              ...sn,
                              activity: {
                                ...sn.activity,
                                lottery: { ...sn.activity.lottery, prizeName: e.target.value },
                              },
                            }))
                          }
                          className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                        />
                      </div>
                      <div>
                        <span className="text-[11px] text-zinc-400 block mb-0.5">中奖名额（人）</span>
                        <input
                          type="number"
                          min={1}
                          value={shownotes.activity.lottery.winnerCount}
                          onChange={(e) =>
                            updateShownotes((sn) => ({
                              ...sn,
                              activity: {
                                ...sn.activity,
                                lottery: {
                                  ...sn.activity.lottery,
                                  winnerCount: Math.max(1, Number(e.target.value) || 1),
                                },
                              },
                            }))
                          }
                          className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                        />
                      </div>

                      <div className="col-span-2">
                        <span className="text-[11px] text-zinc-400 block mb-0.5">抽奖判定方式</span>
                        <select
                          value={shownotes.activity.lottery.drawCondition}
                          onChange={(e) =>
                            updateShownotes((sn) => ({
                              ...sn,
                              activity: {
                                ...sn.activity,
                                lottery: {
                                  ...sn.activity.lottery,
                                  drawCondition: e.target.value as LotteryDrawCondition,
                                },
                              },
                            }))
                          }
                          className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                        >
                          {Object.entries(DRAW_CONDITION_LABELS).map(([k, label]) => (
                            <option key={k} value={k}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </div>

                      {shownotes.activity.lottery.drawCondition === 'keyword_reply' && (
                        <div className="col-span-2">
                          <span className="text-[11px] text-zinc-400 block mb-0.5">互动暗号关键词</span>
                          <input
                            type="text"
                            value={shownotes.activity.lottery.keyword ?? ''}
                            onChange={(e) =>
                              updateShownotes((sn) => ({
                                ...sn,
                                activity: {
                                  ...sn.activity,
                                  lottery: { ...sn.activity.lottery, keyword: e.target.value },
                                },
                              }))
                            }
                            placeholder="例如：我要听下期"
                            className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                          />
                        </div>
                      )}

                      <div className="col-span-2">
                        <span className="text-[11px] text-zinc-400 block mb-0.5">详细参与规则说明</span>
                        <input
                          type="text"
                          value={shownotes.activity.lottery.participationMethod}
                          onChange={(e) =>
                            updateShownotes((sn) => ({
                              ...sn,
                              activity: {
                                ...sn.activity,
                                lottery: {
                                  ...sn.activity.lottery,
                                  participationMethod: e.target.value,
                                },
                              },
                            }))
                          }
                          className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                        />
                      </div>

                      <div>
                        <span className="text-[11px] text-zinc-400 block mb-0.5">开奖截止时间</span>
                        <input
                          type="text"
                          value={shownotes.activity.lottery.deadline}
                          onChange={(e) =>
                            updateShownotes((sn) => ({
                              ...sn,
                              activity: {
                                ...sn.activity,
                                lottery: { ...sn.activity.lottery, deadline: e.target.value },
                              },
                            }))
                          }
                          className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                        />
                      </div>
                      <div>
                        <span className="text-[11px] text-zinc-400 block mb-0.5">结果公布渠道</span>
                        <input
                          type="text"
                          value={shownotes.activity.lottery.announcementChannel}
                          onChange={(e) =>
                            updateShownotes((sn) => ({
                              ...sn,
                              activity: {
                                ...sn.activity,
                                lottery: {
                                  ...sn.activity.lottery,
                                  announcementChannel: e.target.value,
                                },
                              },
                            }))
                          }
                          className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* 海报样式配置 */}
                <div className="p-3.5 rounded-xl border border-zinc-800 bg-zinc-900/70 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-zinc-100 flex items-center gap-1.5">
                      <ImageIcon className="w-3.5 h-3.5 text-blue-400" />
                      海报视觉配置
                    </span>
                    <button
                      onClick={() => void handleDownloadPoster()}
                      className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-1 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>生成并下载 PNG 海报</span>
                    </button>
                  </div>

                  <div>
                    <span className="text-[11px] text-zinc-400 block mb-0.5">海报主标语</span>
                    <input
                      type="text"
                      value={shownotes.activity.posterSlogan}
                      onChange={(e) =>
                        updateShownotes((sn) => ({
                          ...sn,
                          activity: { ...sn.activity, posterSlogan: e.target.value },
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                    />
                  </div>

                  <div>
                    <span className="text-[11px] text-zinc-400 block mb-1">海报主题风格</span>
                    <div className="grid grid-cols-4 gap-2">
                      {POSTER_THEME_OPTIONS.map((th) => (
                        <button
                          key={th.id}
                          onClick={() =>
                            updateShownotes((sn) => ({
                              ...sn,
                              activity: {
                                ...sn.activity,
                                posterTheme: th.id as PosterTheme,
                              },
                            }))
                          }
                          className={`p-2 rounded-lg border text-center cursor-pointer transition ${
                            shownotes.activity.posterTheme === th.id
                              ? 'border-blue-500 bg-blue-500/15 text-blue-200'
                              : 'border-zinc-700 bg-zinc-950 text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          <span
                            className="w-4 h-4 rounded-full mx-auto mb-1 block border border-white/20"
                            style={{ backgroundColor: th.previewBg }}
                          />
                          <span className="text-[11px]">{th.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 5. 听友福利 */}
            {activeSection === 'benefits' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">
                    配置专属听友群、资料包、优惠码等福利信息
                  </span>
                  <button
                    onClick={() =>
                      updateShownotes((sn) => ({
                        ...sn,
                        benefits: [
                          ...sn.benefits,
                          {
                            id: `ben_${Date.now()}`,
                            title: '听友专属福利',
                            codeOrLink: '',
                            description: '填写领取方式与使用说明',
                          },
                        ],
                      }))
                    }
                    className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>添加福利</span>
                  </button>
                </div>

                {shownotes.benefits.map((ben) => (
                  <div
                    key={ben.id}
                    className="p-3.5 rounded-xl border border-zinc-800 bg-zinc-900/70 space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <input
                        type="text"
                        value={ben.title}
                        onChange={(e) =>
                          updateShownotes((sn) => ({
                            ...sn,
                            benefits: sn.benefits.map((b) =>
                              b.id === ben.id ? { ...b, title: e.target.value } : b
                            ),
                          }))
                        }
                        placeholder="福利名称"
                        className="flex-1 px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 font-semibold"
                      />
                      <button
                        onClick={() =>
                          updateShownotes((sn) => ({
                            ...sn,
                            benefits: sn.benefits.filter((b) => b.id !== ben.id),
                          }))
                        }
                        className="p-1 text-zinc-500 hover:text-red-400 cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <input
                      type="text"
                      value={ben.codeOrLink}
                      onChange={(e) =>
                        updateShownotes((sn) => ({
                          ...sn,
                          benefits: sn.benefits.map((b) =>
                            b.id === ben.id ? { ...b, codeOrLink: e.target.value } : b
                          ),
                        }))
                      }
                      placeholder="兑换暗号 / 专属链接 / 微信号"
                      className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-amber-300"
                    />

                    <textarea
                      rows={2}
                      value={ben.description}
                      onChange={(e) =>
                        updateShownotes((sn) => ({
                          ...sn,
                          benefits: sn.benefits.map((b) =>
                            b.id === ben.id ? { ...b, description: e.target.value } : b
                          ),
                        }))
                      }
                      placeholder="领取步骤、适用范围与有效期说明"
                      className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-300"
                    />

                    {/* 听友福利图片（二维码 / 礼品图 / 活动配图） */}
                    <div className="pt-1 flex items-center gap-3">
                      {ben.imageUrl ? (
                        <div className="flex items-center gap-3">
                          <img
                            src={ben.imageUrl}
                            alt={ben.title || '福利图片'}
                            className="w-20 h-20 rounded-lg border border-zinc-700 object-cover bg-zinc-950"
                          />
                          <div className="flex flex-col gap-1.5">
                            <label className="px-2.5 py-1 rounded border border-zinc-700 bg-zinc-950 hover:bg-zinc-800 text-[11px] text-blue-300 cursor-pointer inline-flex items-center gap-1">
                              <Upload className="w-3 h-3" />
                              <span>更换图片</span>
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={(e) => {
                                  const f = e.target.files?.[0];
                                  if (f) handleBenefitImageUpload(ben.id, f);
                                  e.target.value = '';
                                }}
                              />
                            </label>
                            <button
                              type="button"
                              onClick={() =>
                                updateShownotes((sn) => ({
                                  ...sn,
                                  benefits: sn.benefits.map((b) =>
                                    b.id === ben.id ? { ...b, imageUrl: undefined } : b
                                  ),
                                }))
                              }
                              className="px-2.5 py-1 rounded border border-zinc-800 hover:border-red-500/40 text-[11px] text-zinc-400 hover:text-red-400 cursor-pointer inline-flex items-center gap-1"
                            >
                              <Trash2 className="w-3 h-3" />
                              <span>移除图片</span>
                            </button>
                          </div>
                        </div>
                      ) : (
                        <label className="px-3 py-1.5 rounded-lg border border-dashed border-zinc-700 hover:border-blue-500/60 bg-zinc-950/60 hover:bg-zinc-900 text-[11px] text-zinc-400 hover:text-blue-300 cursor-pointer inline-flex items-center gap-1.5 transition">
                          <ImageIcon className="w-3.5 h-3.5" />
                          <span>上传福利图片（如听友群二维码、资料包封面或礼品图）</span>
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) handleBenefitImageUpload(ben.id, f);
                              e.target.value = '';
                            }}
                          />
                        </label>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 右侧实时预览区 */}
          <div className="lg:col-span-5 p-5 overflow-y-auto bg-zinc-900/40 space-y-4">
            {activeSection === 'activity' ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-zinc-200">
                    🎨 活动抽奖海报实时预览 (900×1260 PNG)
                  </span>
                  <button
                    onClick={() => void handleRenderPoster(shownotes)}
                    disabled={renderingPoster}
                    className="text-[11px] text-blue-400 hover:text-blue-300 cursor-pointer"
                  >
                    {renderingPoster ? '渲染中...' : '刷新海报'}
                  </button>
                </div>
                {posterUrl ? (
                  <div className="rounded-xl overflow-hidden border border-zinc-700 shadow-2xl bg-zinc-950">
                    <img
                      src={posterUrl}
                      alt="活动抽奖海报预览"
                      className="w-full h-auto block"
                    />
                  </div>
                ) : (
                  <div className="h-96 rounded-xl border border-zinc-800 flex items-center justify-center text-xs text-zinc-500">
                    正在渲染海报预览...
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-zinc-200">
                    📄 Shownotes 实时成稿预览
                  </span>
                  <span className="text-[11px] text-zinc-400">
                    可直接复制粘贴至小宇宙 / Apple Podcasts
                  </span>
                </div>

                <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-950 space-y-4 text-xs leading-relaxed">
                  <h3 className="text-base font-bold text-zinc-100">
                    {shownotes.episodeTitle}
                  </h3>

                  <div>
                    <div className="text-[11px] font-semibold text-blue-400 mb-1">
                      📝 节目简介
                    </div>
                    <p className="text-zinc-300 whitespace-pre-wrap">{shownotes.summary}</p>
                  </div>

                  <div>
                    <div className="text-[11px] font-semibold text-blue-400 mb-1.5">
                      🎙️ 节目嘉宾
                    </div>
                    <div className="space-y-2">
                      {shownotes.guests.map((g) => (
                        <div
                          key={g.id}
                          className="flex items-center gap-2.5 p-2 rounded-lg bg-zinc-900 border border-zinc-800/80"
                        >
                          {g.customAvatarUrl ? (
                            <img
                              src={g.customAvatarUrl}
                              alt={g.name}
                              className="w-[34px] h-[34px] rounded-full object-cover border border-zinc-700 shrink-0"
                            />
                          ) : (
                            <div className="w-[34px] h-[34px] rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-300 text-xs font-semibold shrink-0">
                              {g.name.trim().slice(0, 1) || '?'}
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-zinc-100 truncate">
                              {g.name}
                              {formatGuestWechat(g.contact) && (
                                <span className="ml-1.5 text-[10px] font-normal text-emerald-300">
                                  ({formatGuestWechat(g.contact)})
                                </span>
                              )}{' '}
                              <span className="text-[10px] font-normal text-zinc-400">
                                ({g.roleLabel})
                              </span>
                            </div>
                            <div className="text-[11px] text-zinc-400 truncate">
                              {[
                                formatGuestBioTags(g.bio),
                                formatGuestSocialSummary(g, false),
                              ]
                                .filter(Boolean)
                                .join(' ｜ ') || '暂未填写简介标签或社交账户'}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] font-semibold text-blue-400 mb-1">
                      ⏱️ 时间轴
                    </div>
                    <div className="space-y-1">
                      {shownotes.timeline.map((t) => (
                        <div key={t.id} className="flex items-baseline gap-2">
                          <button
                            onClick={() => onSeekToSec(t.timeSec)}
                            className="font-mono text-blue-400 hover:underline shrink-0 cursor-pointer"
                          >
                            {formatTimecode(t.timeSec)}
                          </button>
                          <span className="text-zinc-200">
                            - <strong className="font-semibold text-zinc-100">{t.title}</strong>
                            {t.summary?.trim() ? `：${t.summary.trim()}` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] font-semibold text-amber-400 mb-1">
                      🎉 活动信息 & 抽奖规则
                    </div>
                    <div className="p-2.5 rounded-lg bg-amber-500/5 border border-amber-500/20 text-zinc-300 space-y-1">
                      <div className="font-semibold text-zinc-100">
                        {shownotes.activity.title}
                      </div>
                      {shownotes.activity.lottery.enabled && (
                        <div>
                          奖品：{shownotes.activity.lottery.prizeName}（
                          {shownotes.activity.lottery.winnerCount} 名）·{' '}
                          {DRAW_CONDITION_LABELS[shownotes.activity.lottery.drawCondition]}
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] font-semibold text-emerald-400 mb-1">
                      🎁 听友福利
                    </div>
                    <ul className="space-y-2 text-zinc-300">
                      {shownotes.benefits.map((b) => (
                        <li key={b.id} className="space-y-1.5">
                          <div>
                            • <strong className="text-zinc-100">{b.title}</strong>
                            {b.codeOrLink ? `（${b.codeOrLink}）` : ''}：{b.description}
                          </div>
                          {b.imageUrl && (
                            <img
                              src={b.imageUrl}
                              alt={b.title || '福利图片'}
                              className="max-h-36 rounded-lg border border-zinc-800 object-contain bg-zinc-900"
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
