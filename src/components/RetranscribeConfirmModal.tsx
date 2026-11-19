import React, { useState, useEffect } from 'react';
import {
  X,
  Cpu,
  RefreshCw,
  Sparkles,
  KeyRound,
  Layers,
  ShieldCheck,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';
import {
  AsrConfig,
  AsrProvider,
  PodcastProjectState,
  SpeakerTrack,
} from '../types/podcast';

interface RetranscribeConfirmModalProps {
  open: boolean;
  state: PodcastProjectState;
  onClose: () => void;
  onConfirm: (selectedAsrConfig: AsrConfig) => void;
}

export const RetranscribeConfirmModal: React.FC<RetranscribeConfirmModalProps> = ({
  open,
  state,
  onClose,
  onConfirm,
}) => {
  const currentConfig: AsrConfig = state.asrConfig ?? {
    provider: 'local_sensevoice',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: '',
    fallbackToLocal: true,
    volcSsdVersion: '200',
    enableSingleFileSpeakerSep: true,
  };

  const [provider, setProvider] = useState<AsrProvider>(currentConfig.provider);
  const [apiKey, setApiKey] = useState(currentConfig.apiKey || '');
  const [baseUrl, setBaseUrl] = useState(currentConfig.baseUrl || 'https://api.deepseek.com');
  const [fallbackToLocal, setFallbackToLocal] = useState(currentConfig.fallbackToLocal ?? true);
  const [volcApiKey, setVolcApiKey] = useState(currentConfig.volcApiKey || '');
  const [volcAccessKeyId, setVolcAccessKeyId] = useState(currentConfig.volcAccessKeyId || '');
  const [volcSecretAccessKey, setVolcSecretAccessKey] = useState(currentConfig.volcSecretAccessKey || '');
  const [volcAppId, setVolcAppId] = useState(currentConfig.volcAppId || '');
  const [volcAccessToken, setVolcAccessToken] = useState(currentConfig.volcAccessToken || '');
  const [volcSsdVersion, setVolcSsdVersion] = useState<'200' | '300'>(currentConfig.volcSsdVersion ?? '200');

  useEffect(() => {
    if (open) {
      const cfg = state.asrConfig ?? currentConfig;
      setProvider(cfg.provider);
      setApiKey(cfg.apiKey || '');
      setBaseUrl(cfg.baseUrl || 'https://api.deepseek.com');
      setFallbackToLocal(cfg.fallbackToLocal ?? true);
      setVolcApiKey(cfg.volcApiKey || '');
      setVolcAccessKeyId(cfg.volcAccessKeyId || '');
      setVolcSecretAccessKey(cfg.volcSecretAccessKey || '');
      setVolcAppId(cfg.volcAppId || '');
      setVolcAccessToken(cfg.volcAccessToken || '');
      setVolcSsdVersion(cfg.volcSsdVersion ?? '200');
    }
  }, [open, state.asrConfig]);

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

  const validTracks = state.tracks.filter((t) => Boolean(t.filePath));

  const handleStart = () => {
    const nextConfig: AsrConfig = {
      ...currentConfig,
      provider,
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      fallbackToLocal,
      volcApiKey: volcApiKey.trim(),
      volcAccessKeyId: volcAccessKeyId.trim(),
      volcSecretAccessKey: volcSecretAccessKey.trim(),
      volcAppId: volcAppId.trim(),
      volcAccessToken: volcAccessToken.trim(),
      volcSsdVersion,
    };
    onConfirm(nextConfig);
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-2xl border border-zinc-700/90 bg-zinc-900 shadow-2xl flex flex-col max-h-[90vh] overflow-hidden"
      >
        {/* 顶部标题栏 */}
        <div className="px-5 py-3.5 flex items-center justify-between border-b border-zinc-800 shrink-0 bg-zinc-900/90">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center">
              <RefreshCw className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-zinc-100">指定模型重新识别语音</h2>
              <p className="text-[11px] text-zinc-400">选择神经网络 ASR 引擎，确认后开始重新转写与对齐时间戳</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 弹窗主体内容 */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1 min-h-0 text-xs">
          {/* 音轨信息提示卡 */}
          <div className="p-3 rounded-xl bg-zinc-950/70 border border-zinc-800/80 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-zinc-400" />
              <span className="text-zinc-300">
                待识别音轨：<strong className="text-zinc-100">{validTracks.length}</strong> 条轨道
                {validTracks.length > 0 && (
                  <span className="text-zinc-500 ml-1">
                    ({validTracks.map((t) => t.name).join('、')})
                  </span>
                )}
              </span>
            </div>
            <span className="text-[11px] text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20">
              音频无损保留
            </span>
          </div>

          {/* 模型引擎选择（三选一） */}
          <div className="space-y-2">
            <div className="font-semibold text-zinc-200 flex items-center justify-between">
              <span>选择 ASR 语音识别模型</span>
              <span className="text-[11px] text-zinc-500 font-normal">点击切换不同识别模型</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {/* 本地 SenseVoice */}
              <button
                type="button"
                onClick={() => setProvider('local_sensevoice')}
                className={`p-3 rounded-xl border text-left space-y-1.5 transition cursor-pointer ${
                  provider === 'local_sensevoice'
                    ? 'border-emerald-500/80 bg-emerald-500/10 shadow-xs ring-1 ring-emerald-500/40'
                    : 'border-zinc-800 bg-zinc-950/50 hover:border-zinc-700 text-zinc-400'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-bold text-zinc-100">
                    <Cpu className="w-3.5 h-3.5 text-emerald-400" />
                    <span>本地 SenseVoice</span>
                  </div>
                  <span className="text-[9px] px-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    推荐·离线
                  </span>
                </div>
                <p className="text-[11px] text-zinc-400 leading-snug">
                  阿里开源多语言端到端模型，Silero VAD 高精度切片，毫秒级极速转写，免 API Key、隐私安全。
                </p>
              </button>

              {/* 火山引擎豆包语音 */}
              <button
                type="button"
                onClick={() => setProvider('volcengine_doubao')}
                className={`p-3 rounded-xl border text-left space-y-1.5 transition cursor-pointer ${
                  provider === 'volcengine_doubao'
                    ? 'border-indigo-500/80 bg-indigo-500/10 shadow-xs ring-1 ring-indigo-500/40'
                    : 'border-zinc-800 bg-zinc-950/50 hover:border-zinc-700 text-zinc-400'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-bold text-zinc-100">
                    <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                    <span>火山引擎豆包</span>
                  </div>
                  <span className="text-[9px] px-1 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                    SSD 角色分离
                  </span>
                </div>
                <p className="text-[11px] text-zinc-400 leading-snug">
                  字节跳动高精语音大模型，支持单文件/多设备音轨说话人角色分离 (SSD)，超高字准度。
                </p>
              </button>

              {/* DeepSeek 语音转写 */}
              <button
                type="button"
                onClick={() => setProvider('deepseek')}
                className={`p-3 rounded-xl border text-left space-y-1.5 transition cursor-pointer ${
                  provider === 'deepseek'
                    ? 'border-cyan-500/80 bg-cyan-500/10 shadow-xs ring-1 ring-cyan-500/40'
                    : 'border-zinc-800 bg-zinc-950/50 hover:border-zinc-700 text-zinc-400'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-bold text-zinc-100">
                    <KeyRound className="w-3.5 h-3.5 text-cyan-400" />
                    <span>DeepSeek ASR</span>
                  </div>
                  <span className="text-[9px] px-1 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                    长上下文
                  </span>
                </div>
                <p className="text-[11px] text-zinc-400 leading-snug">
                  基于 DeepSeek 语音 API (/v1/tools/asr)，深度结合语境理解，适合长段对话演讲。
                </p>
              </button>
            </div>
          </div>

          {/* 针对不同模型的配置选项 */}
          {provider === 'volcengine_doubao' && (
            <div className="p-3.5 rounded-xl border border-indigo-500/30 bg-indigo-950/20 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-indigo-200">火山引擎豆包语音凭据与选项</span>
                <span className="text-[10px] text-indigo-300/80">已优先检测系统环境变量</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                <div>
                  <label className="text-zinc-400 block mb-1">AccessKey ID / API Key</label>
                  <input
                    type="password"
                    value={volcApiKey || volcAccessKeyId}
                    onChange={(e) => {
                      setVolcApiKey(e.target.value);
                      setVolcAccessKeyId(e.target.value);
                    }}
                    placeholder="输入火山引擎密钥或留空读取环境变量"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="text-zinc-400 block mb-1">Secret Access Key</label>
                  <input
                    type="password"
                    value={volcSecretAccessKey}
                    onChange={(e) => setVolcSecretAccessKey(e.target.value)}
                    placeholder="输入火山引擎 Secret Key"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between text-[11px] pt-1">
                <label className="inline-flex items-center gap-1.5 text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={fallbackToLocal}
                    onChange={(e) => setFallbackToLocal(e.target.checked)}
                    className="rounded"
                  />
                  <span>调用失败或网络异常时自动回退本地 SenseVoice 识别</span>
                </label>
              </div>
            </div>
          )}

          {provider === 'deepseek' && (
            <div className="p-3.5 rounded-xl border border-cyan-500/30 bg-cyan-950/20 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-cyan-200">DeepSeek 语音转写配置</span>
                <span className="text-[10px] text-cyan-300/80">标准 OpenAI 兼容语音格式</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                <div>
                  <label className="text-zinc-400 block mb-1">DeepSeek API Key</label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="输入 sk-... (或设置环境变量)"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-100 focus:outline-none focus:border-cyan-500"
                  />
                </div>
                <div>
                  <label className="text-zinc-400 block mb-1">API Base URL</label>
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://api.deepseek.com"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-100 focus:outline-none focus:border-cyan-500 font-mono text-[10px]"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between text-[11px] pt-1">
                <label className="inline-flex items-center gap-1.5 text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={fallbackToLocal}
                    onChange={(e) => setFallbackToLocal(e.target.checked)}
                    className="rounded"
                  />
                  <span>未配置 Key 或服务超时自动回退本地 SenseVoice 识别</span>
                </label>
              </div>
            </div>
          )}

          {provider === 'local_sensevoice' && (
            <div className="p-3 rounded-xl border border-emerald-500/20 bg-emerald-950/15 flex items-start gap-2.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div className="space-y-0.5 text-zinc-300">
                <div className="font-semibold text-emerald-300">本地隐私离线模式已就绪</div>
                <div className="text-[11px] text-zinc-400 leading-relaxed">
                  直接在您的 Mac Apple Silicon 芯片硬件加速运行，所有音频与文本不会离开本地电脑。
                </div>
              </div>
            </div>
          )}

          {/* 重新识别注意事项 */}
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-start gap-2 text-amber-200/90">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-semibold text-amber-300">操作提示</div>
              <div className="text-[11px] text-amber-200/70 leading-relaxed">
                重新识别将根据所选模型生成全新的时间戳对齐结果并刷新文稿。原工程中的音频文件均完整保留，若识别中途需要中断，可随时点击进度框上的「停止识别」按钮。
              </div>
            </div>
          </div>
        </div>

        {/* 底部确认操作按钮 */}
        <div className="px-5 py-3 border-t border-zinc-800 flex items-center justify-between bg-zinc-900/90 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-300 hover:text-white hover:bg-zinc-700 transition cursor-pointer text-xs"
          >
            取消
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleStart}
              className="px-5 py-1.5 rounded-lg font-bold text-xs bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg transition cursor-pointer flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>确认开始重新识别</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
