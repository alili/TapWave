import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Cpu,
  Download,
  FolderOpen,
  HardDrive,
  Info,
  Loader2,
  RefreshCw,
  Terminal,
  Users,
  X,
} from 'lucide-react';
import {
  DependenciesStatusDto,
  ModelDownloadProgressDto,
  getDependenciesStatus,
  listenModelDownloadProgress,
  setCustomModelsDir,
  startDownloadLocalModels,
} from '../engine/tauriBridge';
import { AsrProvider, PodcastProjectState } from '../types/podcast';

interface DependencyGuideModalProps {
  open: boolean;
  onClose: () => void;
  state: PodcastProjectState;
  onUpdateState: (updater: (prev: PodcastProjectState) => PodcastProjectState) => void;
  onNotify?: (msg: string) => void;
}

export const DependencyGuideModal: React.FC<DependencyGuideModalProps> = ({
  open,
  onClose,
  state,
  onUpdateState,
  onNotify,
}) => {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<DependenciesStatusDto | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ModelDownloadProgressDto | null>(null);
  const [customDirInput, setCustomDirInput] = useState('');
  const [showDirEditor, setShowDirEditor] = useState(false);

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const res = await getDependenciesStatus();
      if (res) {
        setStatus(res);
        setCustomDirInput(res.modelsDir);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void fetchStatus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cleanup: (() => void) | undefined;
    void listenModelDownloadProgress((payload) => {
      setProgress(payload);
      if (payload.isDone) {
        setDownloading(false);
        onNotify?.('🎉 本地离线语音识别模型已成功安装并就绪！');
        void fetchStatus();
      } else if (payload.error) {
        setDownloading(false);
        onNotify?.(`❌ 模型下载失败: ${payload.error}`);
      }
    }).then((unlisten) => {
      cleanup = unlisten;
    });

    return () => {
      if (cleanup) cleanup();
    };
  }, [open, onNotify]);

  const handleStartDownload = async () => {
    setDownloading(true);
    setProgress({
      percent: 5,
      stage: 'prepare',
      message: '正在初始化下载线程与目录...',
      isDone: false,
    });
    try {
      await startDownloadLocalModels();
    } catch (err) {
      setDownloading(false);
      onNotify?.(`下载请求异常: ${String(err)}`);
    }
  };

  const handleSetCustomDir = async () => {
    if (!customDirInput.trim()) return;
    try {
      const res = await setCustomModelsDir(customDirInput.trim());
      if (res) {
        setStatus(res);
        onNotify?.('已更新本地模型目录并重新检测');
      }
    } catch (e) {
      onNotify?.(`设置失败: ${String(e)}`);
    }
  };

  const handleSelectMode = (mode: AsrProvider) => {
    onUpdateState((prev) => ({
      ...prev,
      asrConfig: {
        ...(prev.asrConfig ?? {
          provider: mode,
          apiKey: '',
          baseUrl: 'https://api.deepseek.com',
          model: '',
          fallbackToLocal: true,
          volcSsdVersion: '200',
          enableSingleFileSpeakerSep: true,
        }),
        provider: mode,
      },
    }));
    const label =
      mode === 'local_sensevoice'
        ? '本地 SenseVoice 离线神经网络'
        : mode === 'volcengine_doubao'
        ? '火山引擎豆包语音 (多角色分离)'
        : 'DeepSeek ASR';
    onNotify?.(`已选择语音引擎：${label}`);
  };

  if (!open) return null;

  const currentProvider = state.asrConfig?.provider ?? 'local_sensevoice';
  const isModelsReady = Boolean(status?.modelsReady);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-200"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-2xl bg-zinc-900 border border-zinc-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-950/60">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/15 text-cyan-400 border border-cyan-500/30">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
                <span>AI 语音引擎与离线模型环境</span>
                {status && (
                  <span
                    className={`text-[11px] px-2 py-0.5 rounded-full font-medium border ${
                      isModelsReady
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                    }`}
                  >
                    {isModelsReady ? '● 离线模型就绪' : '▲ 离线模型待下载'}
                  </span>
                )}
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                点波 TapWave 支持「云端大模型极速免下载」与「本地 SenseVoice 离线私密」两种识别方案
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 内容滚轮区 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 text-sm">
          {/* 系统环境概览条 */}
          <div className="p-3 rounded-xl bg-zinc-950/70 border border-zinc-800/90 text-xs flex flex-wrap items-center justify-between gap-2.5 text-zinc-300">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-zinc-400" />
              <span>Python 引擎：</span>
              <span className="font-mono text-zinc-200">{status?.pythonBin || '检测中...'}</span>
              {status?.hasPython ? (
                <span className="text-emerald-400 text-[11px]">✓ 可用</span>
              ) : (
                <span className="text-amber-400 text-[11px]">未找到外部 python3 (使用内置)</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void fetchStatus()}
              disabled={loading}
              className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded bg-zinc-800/80 hover:bg-zinc-700/80 transition cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
              <span>重新检测</span>
            </button>
          </div>

          {/* 方案 A：云端大模型模式（免下载） */}
          <div
            className={`p-4 rounded-xl border transition relative ${
              currentProvider === 'volcengine_doubao' || currentProvider === 'deepseek'
                ? 'border-amber-500/60 bg-amber-500/10 shadow-sm'
                : 'border-zinc-800 bg-zinc-950/40 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                    免下载 · 即开即用
                  </span>
                  <h3 className="font-semibold text-zinc-100 flex items-center gap-1.5">
                    <Cloud className="w-4 h-4 text-amber-400" />
                    <span>方案一：云端大模型语音识别（推荐）</span>
                  </h3>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  无需在本地下载近 400MB 离线神经网络，通过火山引擎豆包大模型或 DeepSeek 接口转写。
                  不仅识别准确率极高，还支持<strong>单文件多人混音自动分离角色音轨</strong>。
                </p>
              </div>

              <div className="flex flex-col gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => handleSelectMode('volcengine_doubao')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition ${
                    currentProvider === 'volcengine_doubao'
                      ? 'bg-amber-500 text-zinc-950 shadow-md font-semibold'
                      : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200'
                  }`}
                >
                  {currentProvider === 'volcengine_doubao' ? '✓ 当前已选（豆包）' : '选用豆包单文件分轨'}
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectMode('deepseek')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition ${
                    currentProvider === 'deepseek'
                      ? 'bg-cyan-500 text-zinc-950 shadow-md font-semibold'
                      : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
                  }`}
                >
                  {currentProvider === 'deepseek' ? '✓ 当前已选（DeepSeek）' : '选用 DeepSeek ASR'}
                </button>
              </div>
            </div>
          </div>

          {/* 方案 B：本地 SenseVoice 离线模型 */}
          <div
            className={`p-4 rounded-xl border transition relative ${
              currentProvider === 'local_sensevoice'
                ? 'border-emerald-500/60 bg-emerald-500/10 shadow-sm'
                : 'border-zinc-800 bg-zinc-950/40 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    离线免联网 · 极致隐私
                  </span>
                  <h3 className="font-semibold text-zinc-100 flex items-center gap-1.5">
                    <HardDrive className="w-4 h-4 text-emerald-400" />
                    <span>方案二：本地 SenseVoiceSmall 离线模型</span>
                  </h3>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  阿里 FunAudioLLM SenseVoiceSmall 神经网络 + Silero VAD 模型（约 230MB~380MB），
                  数据全程在本地 Apple Silicon NPU/CPU 极速运算，无需上传任何音频到云端。
                </p>
              </div>

              <button
                type="button"
                onClick={() => handleSelectMode('local_sensevoice')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition shrink-0 ${
                  currentProvider === 'local_sensevoice'
                    ? 'bg-emerald-500 text-zinc-950 font-semibold shadow-md'
                    : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200'
                }`}
              >
                {currentProvider === 'local_sensevoice' ? '✓ 当前已选（本地）' : '选用本地 SenseVoice'}
              </button>
            </div>

            {/* 本地模型下载状态与进度条 */}
            <div className="mt-3 pt-3 border-t border-zinc-800/80">
              {isModelsReady ? (
                <div className="flex items-center gap-2 text-xs text-emerald-400">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>本地离线模型文件已完整就绪，可随时直接转写！</span>
                </div>
              ) : downloading ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-300 flex items-center gap-1.5">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                      <span>{progress?.message || '正在下载本地模型文件...'}</span>
                    </span>
                    <span className="font-mono text-cyan-300 font-semibold">
                      {progress?.percent ?? 10}%
                    </span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-300"
                      style={{ width: `${Math.max(5, progress?.percent ?? 10)}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    下载完成后将自动安装至 <code>~/.tapwave/models</code>，请保持网络连接。
                  </p>
                </div>
              ) : (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs text-amber-300">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>检测到本地尚未下载 SenseVoice 模型文件 (约 230MB)</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleStartDownload()}
                    className="flex items-center justify-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shadow-md transition cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>一键下载本地模型包</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 辅助折叠：自定义模型存放路径 */}
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowDirEditor((p) => !p)}
              className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1.5 transition cursor-pointer"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>{showDirEditor ? '收起自定义模型目录设置' : '高级：已有本地模型？指定模型目录'}</span>
            </button>

            {showDirEditor && (
              <div className="mt-2.5 p-3 rounded-lg bg-zinc-950/80 border border-zinc-800 space-y-2 text-xs">
                <div className="text-zinc-400 leading-snug">
                  若您之前已在其他位置下载过 <code>sherpa-onnx-sense-voice...</code> 或 <code>silero_vad.onnx</code>，可在下方指定路径：
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={customDirInput}
                    onChange={(e) => setCustomDirInput(e.target.value)}
                    placeholder="输入或粘贴模型文件夹绝对路径..."
                    className="flex-1 px-2.5 py-1.5 rounded border border-zinc-700 bg-zinc-900 text-zinc-100 font-mono text-[11px] focus:outline-none focus:border-cyan-500"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSetCustomDir()}
                    className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium cursor-pointer transition"
                  >
                    应用路径
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 底部按钮栏 */}
        <div className="px-6 py-3.5 border-t border-zinc-800 bg-zinc-950/70 flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
            <input
              type="checkbox"
              defaultChecked={false}
              onChange={(e) => {
                if (e.target.checked) {
                  localStorage.setItem('tapwave_dep_guide_seen', 'true');
                } else {
                  localStorage.removeItem('tapwave_dep_guide_seen');
                }
              }}
              className="rounded border-zinc-700 bg-zinc-900 text-cyan-500 focus:ring-0"
            />
            <span>不再主动弹出此环境向导</span>
          </label>

          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-xs shadow-lg shadow-cyan-900/30 transition cursor-pointer"
          >
            完成并进入工作室
          </button>
        </div>
      </div>
    </div>
  );
};
