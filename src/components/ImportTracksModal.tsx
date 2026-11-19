import React, { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Cloud,
  Cpu,
  FileAudio,
  FileJson,
  FileText,
  FolderOpen,
  GripVertical,
  KeyRound,
  RefreshCw,
  Users,
  X,
} from 'lucide-react';
import { AsrProvider, AuxAudioSlot, PodcastProjectState } from '../types/podcast';
import { formatMmSs } from '../engine/timelineEngine';
import { reorderItems, resolveTrackDisplayFileName } from '../engine/trackOrder';
import {
  checkSidecarCapabilities,
  isTauriRuntime,
  SidecarCapabilitiesDto,
} from '../engine/tauriBridge';

interface ImportTracksModalProps {
  open: boolean;
  state: PodcastProjectState;
  onClose: () => void;
  onUpdateState: (updater: (prev: PodcastProjectState) => PodcastProjectState) => void;
  onPickNativeAudioFiles: () => void;
  onPickBrowserAudioFiles: (files: FileList) => void;
  onOpenProjectFile: () => void;
  onImportBgm: (slot: AuxAudioSlot) => void;
  onOpenSubtitleCorrection?: () => void;
  onRetranscribe?: () => void;
  onOpenDepGuide?: () => void;
}

export const ImportTracksModal: React.FC<ImportTracksModalProps> = ({
  open,
  state,
  onClose,
  onUpdateState,
  onPickNativeAudioFiles,
  onPickBrowserAudioFiles,
  onOpenProjectFile,
  onImportBgm,
  onOpenSubtitleCorrection,
  onRetranscribe,
  onOpenDepGuide,
}) => {
  const [capabilities, setCapabilities] = useState<SidecarCapabilitiesDto | null>(null);
  const [showVolcAdvanced, setShowVolcAdvanced] = useState(false);
  const [dragTrackIndex, setDragTrackIndex] = useState<number | null>(null);
  const [dragOverTrackIndex, setDragOverTrackIndex] = useState<number | null>(null);

  const handleMoveTrack = (fromIndex: number, toIndex: number) => {
    onUpdateState((prev) => {
      const nextTracks = reorderItems(prev.tracks, fromIndex, toIndex);
      if (nextTracks === prev.tracks) return prev;
      return { ...prev, tracks: nextTracks };
    });
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void checkSidecarCapabilities().then((caps) => {
      if (!cancelled && caps) {
        setCapabilities(caps);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

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

  const asrConfig = state.asrConfig ?? {
    provider: 'local_sensevoice' as AsrProvider,
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: '',
    fallbackToLocal: true,
    volcSsdVersion: '200' as const,
    enableSingleFileSpeakerSep: true,
  };
  const missingStrictDeepSeekKey =
    asrConfig.provider === 'deepseek' &&
    !asrConfig.apiKey.trim() &&
    !asrConfig.fallbackToLocal;
  const hasVolcManualCreds = Boolean(
    asrConfig.volcApiKey?.trim() ||
      (asrConfig.volcAccessKeyId?.trim() && asrConfig.volcSecretAccessKey?.trim()) ||
      (asrConfig.volcAppId?.trim() && asrConfig.volcAccessToken?.trim())
  );
  const missingStrictVolcKey =
    asrConfig.provider === 'volcengine_doubao' &&
    !hasVolcManualCreds &&
    !capabilities?.volcEnvConfigured &&
    !asrConfig.fallbackToLocal;
  const retranscribeDisabled = missingStrictDeepSeekKey || missingStrictVolcKey;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl flex flex-col max-h-[86vh] overflow-hidden"
      >
        <div className="px-5 py-3.5 flex items-center justify-between border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-blue-400" />
            <h2 className="text-sm font-semibold text-zinc-100">
              导入音频与 AI 识别配置
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer transition"
            title="关闭 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1 min-h-0">
          {/* 快捷导入音频 / 工程 / 字幕矫正 */}
          <div
            className={`grid gap-2.5 text-xs ${
              state.tracks.length > 0 && onOpenSubtitleCorrection
                ? 'grid-cols-3'
                : 'grid-cols-2'
            }`}
          >
            {isTauriRuntime() ? (
              <button
                onClick={() => {
                  onClose();
                  onPickNativeAudioFiles();
                }}
                className="py-2.5 px-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold flex items-center justify-center gap-2 cursor-pointer transition"
              >
                <FolderOpen className="w-4 h-4 shrink-0" />
                <span>选择本地多轨音频</span>
              </button>
            ) : (
              <label className="py-2.5 px-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold flex items-center justify-center gap-2 cursor-pointer transition">
                <FolderOpen className="w-4 h-4 shrink-0" />
                <span>选择本地多轨音频</span>
                <input
                  type="file"
                  multiple
                  accept="audio/*,.wav,.mp3,.m4a,.flac,.aac,.ogg,.mp4"
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      const list = e.target.files;
                      onClose();
                      onPickBrowserAudioFiles(list);
                    }
                  }}
                  className="hidden"
                />
              </label>
            )}

            <button
              onClick={() => {
                onClose();
                onOpenProjectFile();
              }}
              className="py-2.5 px-3.5 rounded-xl border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-semibold flex items-center justify-center gap-2 cursor-pointer transition"
            >
              <FileJson className="w-4 h-4 text-amber-400 shrink-0" />
              <span>打开已有工程 (.podcraft)</span>
            </button>

            {state.tracks.length > 0 && onOpenSubtitleCorrection && (
              <button
                onClick={() => {
                  onClose();
                  onOpenSubtitleCorrection();
                }}
                className="py-2.5 px-3.5 rounded-xl border border-cyan-500/40 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 font-semibold flex items-center justify-center gap-2 cursor-pointer transition"
              >
                <FileText className="w-4 h-4 text-cyan-400 shrink-0" />
                <span>导入字幕智能矫正</span>
              </button>
            )}
          </div>

          {state.tracks.length > 0 && (
            <div className="p-3 rounded-xl border border-zinc-800 bg-zinc-950 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-semibold text-zinc-200">
                  <FileAudio className="w-3.5 h-3.5 text-blue-400" />
                  <span>已导入文件与音轨顺序 ({state.tracks.length})</span>
                </div>
                {state.tracks.length > 1 && (
                  <span className="text-[11px] text-zinc-500">
                    拖拽或点击箭头调整音轨显示顺序
                  </span>
                )}
              </div>

              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-0.5">
                {state.tracks.map((tr, idx) => {
                  const displayFile = resolveTrackDisplayFileName(
                    tr.sourceFilePath || tr.filePath,
                    tr.sourceFileName || tr.name
                  );
                  const canReorder = state.tracks.length > 1;
                  const isDragOver = dragOverTrackIndex === idx && dragTrackIndex !== idx;
                  return (
                    <div
                      key={tr.id}
                      draggable={canReorder}
                      onDragStart={(e) => {
                        if (!canReorder) return;
                        setDragTrackIndex(idx);
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', tr.id);
                      }}
                      onDragOver={(e) => {
                        if (dragTrackIndex === null) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        if (dragOverTrackIndex !== idx) {
                          setDragOverTrackIndex(idx);
                        }
                      }}
                      onDrop={(e) => {
                        if (dragTrackIndex === null) return;
                        e.preventDefault();
                        handleMoveTrack(dragTrackIndex, idx);
                        setDragTrackIndex(null);
                        setDragOverTrackIndex(null);
                      }}
                      onDragEnd={() => {
                        setDragTrackIndex(null);
                        setDragOverTrackIndex(null);
                      }}
                      className={`px-2.5 py-1.5 rounded-lg border flex items-center justify-between gap-2 transition ${
                        isDragOver
                          ? 'border-blue-400 ring-1 ring-blue-400/50 bg-blue-500/10'
                          : 'border-zinc-800 bg-zinc-900/90'
                      } ${dragTrackIndex === idx ? 'opacity-50' : ''}`}
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {canReorder && (
                          <span
                            title="拖拽调整顺序"
                            className="text-zinc-500 hover:text-zinc-300 cursor-grab active:cursor-grabbing shrink-0"
                          >
                            <GripVertical className="w-3.5 h-3.5" />
                          </span>
                        )}
                        <span className="font-mono text-[11px] text-zinc-500 w-4 shrink-0">
                          {idx + 1}.
                        </span>
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: tr.color }}
                        />
                        <span className="font-semibold text-zinc-100 truncate max-w-[120px]">
                          {tr.name}
                        </span>
                        <span className="text-zinc-500 shrink-0">·</span>
                        <span
                          title={tr.sourceFilePath || tr.filePath || displayFile}
                          className="font-mono text-[11px] text-zinc-400 truncate"
                        >
                          {displayFile}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {tr.durationMs ? (
                          <span className="font-mono text-[11px] text-zinc-500 mr-1">
                            {formatMmSs(tr.durationMs / 1000)}
                          </span>
                        ) : null}
                        {canReorder && (
                          <>
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => handleMoveTrack(idx, idx - 1)}
                              title="上移"
                              className="p-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === state.tracks.length - 1}
                              onClick={() => handleMoveTrack(idx, idx + 1)}
                              title="下移"
                              className="p-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

        {/* 语音识别 (ASR) 引擎配置 */}
        <div className="p-3 rounded-xl border border-zinc-800 bg-zinc-950 space-y-2.5 text-xs">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 font-semibold text-zinc-200">
              <Cloud className="w-3.5 h-3.5 text-cyan-400" />
              <span>语音识别引擎（本地 SenseVoice / 火山引擎豆包分角色 / DeepSeek）</span>
            </div>
            {state.tracks.length > 0 && onRetranscribe && (
              <button
                type="button"
                disabled={retranscribeDisabled}
                onClick={() => {
                  onClose();
                  onRetranscribe();
                }}
                title={
                  retranscribeDisabled
                    ? '请先填写对应引擎密钥或开启自动回退'
                    : '使用当前所选引擎重新识别已导入音轨并生成逐字时间戳'
                }
                className="px-2.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-45 disabled:cursor-not-allowed text-white font-semibold inline-flex items-center gap-1 cursor-pointer transition text-[11px]"
              >
                <RefreshCw className="w-3 h-3" />
                <span>立即用当前引擎重识别</span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() =>
                onUpdateState((p) => ({
                  ...p,
                  asrConfig: {
                    ...(p.asrConfig ?? asrConfig),
                    provider: 'local_sensevoice',
                  },
                }))
              }
              className={`p-2.5 rounded-lg border text-left space-y-0.5 cursor-pointer transition ${
                asrConfig.provider === 'local_sensevoice'
                  ? 'border-emerald-500 bg-emerald-500/10 text-zinc-100'
                  : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700'
              }`}
            >
              <div className="font-semibold flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>本地 SenseVoice</span>
                </div>
                {capabilities && !capabilities.engines?.sense_voice_int8 && onOpenDepGuide && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenDepGuide();
                    }}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 transition cursor-pointer"
                  >
                    未检测到模型 · 点击下载
                  </button>
                )}
              </div>
              <p className="text-[11px] text-zinc-400 leading-snug">
                Apple Silicon 本地神经网络 + Silero VAD，零网络延迟、免费离线。
              </p>
            </button>

            <button
              type="button"
              onClick={() =>
                onUpdateState((p) => ({
                  ...p,
                  asrConfig: {
                    ...(p.asrConfig ?? asrConfig),
                    provider: 'volcengine_doubao',
                    volcSsdVersion: p.asrConfig?.volcSsdVersion ?? '200',
                    enableSingleFileSpeakerSep:
                      p.asrConfig?.enableSingleFileSpeakerSep ?? true,
                  },
                }))
              }
              className={`p-2.5 rounded-lg border text-left space-y-0.5 cursor-pointer transition ${
                asrConfig.provider === 'volcengine_doubao'
                  ? 'border-amber-500 bg-amber-500/10 text-zinc-100'
                  : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700'
              }`}
            >
              <div className="font-semibold flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>豆包语音 (单文件分角色)</span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-snug">
                火山引擎 AUC + SSD 说话人分离，单个混音文件自动拆分为多角色音轨。
              </p>
            </button>

            <button
              type="button"
              onClick={() =>
                onUpdateState((p) => ({
                  ...p,
                  asrConfig: {
                    ...(p.asrConfig ?? asrConfig),
                    provider: 'deepseek',
                    baseUrl:
                      (p.asrConfig?.baseUrl ?? '').trim() || 'https://api.deepseek.com',
                  },
                }))
              }
              className={`p-2.5 rounded-lg border text-left space-y-0.5 cursor-pointer transition ${
                asrConfig.provider === 'deepseek'
                  ? 'border-cyan-500 bg-cyan-500/10 text-zinc-100'
                  : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700'
              }`}
            >
              <div className="font-semibold flex items-center gap-1.5">
                <Cloud className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                <span>DeepSeek ASR</span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-snug">
                调用 /v1/tools/asr，智能分段并发转写并回贴波形包络切点。
              </p>
            </button>
          </div>

          {asrConfig.provider === 'volcengine_doubao' && (
            <div className="p-2.5 rounded-lg border border-amber-500/30 bg-zinc-900/90 space-y-2.5">
              {capabilities?.volcEnvConfigured && (
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-[11px]">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    ✓ 已加载本地火山引擎账号{' '}
                    <strong>{capabilities.volcAccountInfo?.username || 'nemo'}</strong> (
                    {capabilities.volcAccountInfo?.accountId || '2134470279'}) 密钥，可直接分角色识别
                  </span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <div className="text-[11px] text-zinc-300">用户名</div>
                  <input
                    type="text"
                    value={
                      asrConfig.volcUsername ??
                      capabilities?.volcAccountInfo?.username ??
                      'nemo'
                    }
                    onChange={(e) =>
                      onUpdateState((p) => ({
                        ...p,
                        asrConfig: {
                          ...(p.asrConfig ?? asrConfig),
                          volcUsername: e.target.value,
                        },
                      }))
                    }
                    placeholder="nemo"
                    className="w-full px-2.5 py-1.5 rounded border border-zinc-700 focus:border-amber-500 bg-zinc-950 text-zinc-100 focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] text-zinc-300">所属主账号 ID</div>
                  <input
                    type="text"
                    value={
                      asrConfig.volcAccountId ??
                      capabilities?.volcAccountInfo?.accountId ??
                      '2134470279'
                    }
                    onChange={(e) =>
                      onUpdateState((p) => ({
                        ...p,
                        asrConfig: {
                          ...(p.asrConfig ?? asrConfig),
                          volcAccountId: e.target.value,
                        },
                      }))
                    }
                    placeholder="2134470279"
                    className="w-full px-2.5 py-1.5 rounded border border-zinc-700 focus:border-amber-500 bg-zinc-950 text-zinc-100 font-mono text-[11px] focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] text-zinc-300">
                    Access Key ID（留空时自动使用本地 .env.local）
                  </div>
                  <input
                    type="text"
                    value={asrConfig.volcAccessKeyId ?? ''}
                    onChange={(e) =>
                      onUpdateState((p) => ({
                        ...p,
                        asrConfig: {
                          ...(p.asrConfig ?? asrConfig),
                          volcAccessKeyId: e.target.value,
                        },
                      }))
                    }
                    placeholder={
                      capabilities?.volcEnvConfigured
                        ? '已通过本地 .env.local 自动注入'
                        : '输入 AKLT...'
                    }
                    className="w-full px-2.5 py-1.5 rounded border border-zinc-700 focus:border-amber-500 bg-zinc-950 text-zinc-100 font-mono text-[11px] focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] text-zinc-300">
                    Secret Access Key（仅驻留内存，不写入工程文件）
                  </div>
                  <input
                    type="password"
                    value={asrConfig.volcSecretAccessKey ?? ''}
                    onChange={(e) =>
                      onUpdateState((p) => ({
                        ...p,
                        asrConfig: {
                          ...(p.asrConfig ?? asrConfig),
                          volcSecretAccessKey: e.target.value,
                        },
                      }))
                    }
                    placeholder={
                      capabilities?.volcEnvConfigured
                        ? '已通过本地 .env.local 自动注入'
                        : '输入 Secret Access Key...'
                    }
                    className="w-full px-2.5 py-1.5 rounded border border-zinc-700 focus:border-amber-500 bg-zinc-950 text-zinc-100 font-mono text-[11px] focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-end">
                <div className="space-y-1">
                  <div className="text-[11px] text-zinc-300">
                    说话人分离模型版本 (SSD)
                  </div>
                  <select
                    value={asrConfig.volcSsdVersion ?? '200'}
                    onChange={(e) =>
                      onUpdateState((p) => ({
                        ...p,
                        asrConfig: {
                          ...(p.asrConfig ?? asrConfig),
                          volcSsdVersion: e.target.value as '200' | '300',
                        },
                      }))
                    }
                    className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 focus:outline-none"
                  >
                    <option value="200">200 - 标准对话版 (2-5人对谈推荐)</option>
                    <option value="300">300 - 会议多人版 (多人/插话推荐)</option>
                  </select>
                </div>

                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    onClick={() => setShowVolcAdvanced((v) => !v)}
                    className="text-[11px] text-amber-400 hover:text-amber-300 underline cursor-pointer"
                  >
                    {showVolcAdvanced ? '收起高级鉴权参数' : '展开可选 X-Api-Key / Resource ID'}
                  </button>
                </div>
              </div>

              {showVolcAdvanced && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 border-t border-zinc-800/80">
                  <div className="space-y-1">
                    <div className="text-[11px] text-zinc-400">
                      可选直填 X-Api-Key（跳过 AK/SK 自动换取）
                    </div>
                    <input
                      type="password"
                      value={asrConfig.volcApiKey ?? ''}
                      onChange={(e) =>
                        onUpdateState((p) => ({
                          ...p,
                          asrConfig: {
                            ...(p.asrConfig ?? asrConfig),
                            volcApiKey: e.target.value,
                          },
                        }))
                      }
                      placeholder="输入豆包语音 API Key..."
                      className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 font-mono text-[11px]"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="text-[11px] text-zinc-400">
                      可选 Resource ID（默认 volc.seedasr.auc）
                    </div>
                    <input
                      type="text"
                      value={asrConfig.volcResourceId ?? ''}
                      onChange={(e) =>
                        onUpdateState((p) => ({
                          ...p,
                          asrConfig: {
                            ...(p.asrConfig ?? asrConfig),
                            volcResourceId: e.target.value,
                          },
                        }))
                      }
                      placeholder="volc.seedasr.auc 或 volc.bigasr.auc"
                      className="w-full px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-950 text-zinc-100 font-mono text-[11px]"
                    />
                  </div>
                </div>
              )}

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px] pt-1">
                <label className="inline-flex items-center gap-1.5 text-zinc-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={asrConfig.enableSingleFileSpeakerSep ?? true}
                    onChange={(e) =>
                      onUpdateState((p) => ({
                        ...p,
                        asrConfig: {
                          ...(p.asrConfig ?? asrConfig),
                          enableSingleFileSpeakerSep: e.target.checked,
                        },
                      }))
                    }
                  />
                  <span>单文件自动拆分为多角色独立音轨 (20ms 无损互补淡化)</span>
                </label>

                <label className="inline-flex items-center gap-1.5 text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={asrConfig.fallbackToLocal}
                    onChange={(e) =>
                      onUpdateState((p) => ({
                        ...p,
                        asrConfig: {
                          ...(p.asrConfig ?? asrConfig),
                          fallbackToLocal: e.target.checked,
                        },
                      }))
                    }
                  />
                  <span>API 异常时回退本地模型 + 声学分角色</span>
                </label>
              </div>
            </div>
          )}

          {asrConfig.provider === 'deepseek' && (
            <div className="p-2.5 rounded-lg border border-cyan-500/30 bg-zinc-900/90 space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px] text-zinc-300">
                    <span>DeepSeek API Key (仅驻留内存，不写入工程文件)</span>
                    {!asrConfig.apiKey.trim() && state.llmConfig.apiKey.trim() && (
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateState((p) => ({
                            ...p,
                            asrConfig: {
                              ...(p.asrConfig ?? asrConfig),
                              apiKey: p.llmConfig.apiKey,
                            },
                          }))
                        }
                        className="text-cyan-400 hover:text-cyan-300 underline cursor-pointer"
                      >
                        复用下方 Key
                      </button>
                    )}
                  </div>
                  <input
                    type="password"
                    value={asrConfig.apiKey}
                    onChange={(e) =>
                      onUpdateState((p) => ({
                        ...p,
                        asrConfig: {
                          ...(p.asrConfig ?? asrConfig),
                          apiKey: e.target.value,
                        },
                      }))
                    }
                    placeholder="输入 sk-... (或设环境变量 DEEPSEEK_API_KEY)"
                    className="w-full px-2.5 py-1.5 rounded border border-zinc-700 focus:border-cyan-500 bg-zinc-950 text-zinc-100 focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] text-zinc-300">
                    API 地址 Base URL（自动适配 /v1/tools/asr）
                  </div>
                  <input
                    type="text"
                    value={asrConfig.baseUrl}
                    onChange={(e) =>
                      onUpdateState((p) => ({
                        ...p,
                        asrConfig: {
                          ...(p.asrConfig ?? asrConfig),
                          baseUrl: e.target.value,
                        },
                      }))
                    }
                    placeholder="https://api.deepseek.com"
                    className="w-full px-2.5 py-1.5 rounded border border-zinc-700 focus:border-cyan-500 bg-zinc-950 text-zinc-100 font-mono text-[11px] focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 flex-wrap text-[11px]">
                <label className="inline-flex items-center gap-1.5 text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={asrConfig.fallbackToLocal}
                    onChange={(e) =>
                      onUpdateState((p) => ({
                        ...p,
                        asrConfig: {
                          ...(p.asrConfig ?? asrConfig),
                          fallbackToLocal: e.target.checked,
                        },
                      }))
                    }
                  />
                  <span>API 失败或未填 Key 时自动回退本地 SenseVoice 识别</span>
                </label>
                <span className="text-zinc-500">
                  自动遵守单段 ≤55s / &lt;8 MiB 切分限制
                </span>
              </div>
            </div>
          )}
        </div>

        {/* 云端 LLM API Key 可选配置 */}
        <div className="p-3 rounded-xl border border-zinc-800 bg-zinc-950 space-y-2 text-xs">
          <div className="flex items-center gap-1.5 font-semibold text-zinc-200">
            <KeyRound className="w-3.5 h-3.5 text-amber-400" />
            <span>云端大模型分析配置（可选，未填时使用本地分析器）</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <select
              value={state.llmConfig.provider}
              onChange={(e) => {
                const nextProvider = e.target.value as 'gemini' | 'openai' | 'deepseek';
                onUpdateState((p) => {
                  const syncedKey =
                    !p.llmConfig.apiKey.trim() && nextProvider === 'deepseek'
                      ? p.asrConfig?.apiKey ?? ''
                      : p.llmConfig.apiKey;
                  const nextBaseUrl =
                    nextProvider === 'deepseek'
                      ? 'https://api.deepseek.com/v1'
                      : nextProvider === 'openai'
                      ? p.llmConfig.baseUrl === 'https://api.deepseek.com/v1' || !p.llmConfig.baseUrl
                        ? 'https://api.openai.com/v1'
                        : p.llmConfig.baseUrl
                      : p.llmConfig.baseUrl;
                  const nextModel =
                    nextProvider === 'deepseek'
                      ? 'deepseek-chat'
                      : nextProvider === 'gemini'
                      ? 'gemini-2.5-flash'
                      : p.llmConfig.model === 'deepseek-chat' ||
                        p.llmConfig.model.startsWith('gemini-')
                      ? 'gpt-4o-mini'
                      : p.llmConfig.model;
                  return {
                    ...p,
                    llmConfig: {
                      ...p.llmConfig,
                      provider: nextProvider,
                      apiKey: syncedKey,
                      baseUrl: nextBaseUrl,
                      model: nextModel,
                    },
                  };
                });
              }}
              className="px-2 py-1.5 rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
            >
              <option value="gemini">Gemini API</option>
              <option value="deepseek">DeepSeek 官方 API (deepseek-chat)</option>
              <option value="openai">OpenAI / 兼容网关</option>
            </select>
            <input
              type="password"
              value={state.llmConfig.apiKey}
              onChange={(e) =>
                onUpdateState((p) => ({
                  ...p,
                  llmConfig: { ...p.llmConfig, apiKey: e.target.value },
                }))
              }
              placeholder="输入 API Key (仅保存在本地运行内存)..."
              className="col-span-2 px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
            />
          </div>
        </div>
        </div>

        <div className="px-5 py-3 border-t border-zinc-800 bg-zinc-950/70 flex items-center justify-between gap-3 shrink-0">
          <span className="text-[11px] text-zinc-400">
            AI 识别引擎与大模型参数修改实时生效，确认后即可关闭弹窗
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition shadow-sm"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>确认并关闭</span>
          </button>
        </div>
      </div>
    </div>
  );
};
