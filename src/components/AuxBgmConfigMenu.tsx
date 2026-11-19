import React, { useState } from 'react';
import {
  AlertCircle,
  Clock,
  FileAudio,
  Library,
  Mic,
  Music,
  Pause,
  Play,
  Trash2,
  Upload,
  Volume2,
} from 'lucide-react';
import {
  AuxAudioSlot,
  BgmTrackAsset,
  PodcastProjectState,
} from '../types/podcast';
import { formatMmSs } from '../engine/timelineEngine';
import { audioPreview } from '../engine/audioPreviewEngine';

interface AuxBgmConfigMenuProps {
  state: PodcastProjectState;
  onImportBgm: (slot: AuxAudioSlot) => void;
  onToggleBgmEnabled: (slot: AuxAudioSlot) => void;
  onRemoveBgm: (slot: AuxAudioSlot) => void;
  onSaveSlotToGlobalLibrary?: (slot: AuxAudioSlot) => void;
  onOpenGlobalAuxLibrary?: (slot: AuxAudioSlot) => void;
  onUpdateState: (updater: (prev: PodcastProjectState) => PodcastProjectState) => void;
  onNotify: (msg: string) => void;
  onClose?: () => void;
}

export const AuxBgmConfigMenu: React.FC<AuxBgmConfigMenuProps> = ({
  state,
  onImportBgm,
  onToggleBgmEnabled,
  onRemoveBgm,
  onSaveSlotToGlobalLibrary,
  onOpenGlobalAuxLibrary,
  onUpdateState,
  onNotify,
  onClose,
}) => {
  const [previewingSlot, setPreviewingSlot] = useState<AuxAudioSlot | null>(null);

  const handlePreviewBgm = (slot: AuxAudioSlot, bgm?: BgmTrackAsset | null) => {
    if (!bgm) return;
    const started = audioPreview.toggleBgmSlotPreview(
      slot,
      bgm.audioUrl,
      bgm.filePath,
      () => {
        setPreviewingSlot((curr) => (curr === slot ? null : curr));
      }
    );
    setPreviewingSlot(started ? slot : null);
  };

  const renderSlotCard = (
    slot: AuxAudioSlot,
    label: string,
    subTag: string,
    bgm?: BgmTrackAsset | null
  ) => {
    const isPreviewing = previewingSlot === slot;

    return (
      <div
        className={`p-2.5 rounded-lg border transition ${
          bgm
            ? bgm.enabled
              ? 'border-zinc-700/90 bg-zinc-900/90'
              : 'border-zinc-800 bg-zinc-900/40 opacity-70'
            : 'border-dashed border-zinc-800 bg-zinc-950/60'
        }`}
      >
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            {slot === 'intro_vo' ? (
              <Mic className="w-3.5 h-3.5 shrink-0 text-amber-400" />
            ) : (
              <Music
                className={`w-3.5 h-3.5 shrink-0 ${
                  slot === 'intro' ? 'text-blue-400' : 'text-emerald-400'
                }`}
              />
            )}
            <span className="text-xs font-semibold text-zinc-100 shrink-0">{label}</span>
            <span className="text-[11px] text-zinc-500 truncate">{subTag}</span>
          </div>

          {!bgm ? (
            <div className="flex items-center gap-1 shrink-0">
              {onOpenGlobalAuxLibrary && (
                <button
                  type="button"
                  onClick={() => onOpenGlobalAuxLibrary(slot)}
                  title={`从全局固定库选择${label}`}
                  className="px-2 py-0.5 rounded bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/35 text-[11px] text-purple-200 font-medium flex items-center gap-1 cursor-pointer transition"
                >
                  <Library className="w-3 h-3 text-purple-400" />
                  <span>从库选</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => onImportBgm(slot)}
                className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[11px] text-zinc-200 font-medium flex items-center gap-1 cursor-pointer transition"
              >
                <Upload className="w-3 h-3 text-blue-400" />
                <span>导入</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1 shrink-0">
              {(bgm.audioUrl || bgm.filePath) && (
                <button
                  type="button"
                  onClick={() => handlePreviewBgm(slot, bgm)}
                  title={isPreviewing ? '停止试听' : `试听${label}`}
                  className={`p-1 rounded text-xs cursor-pointer transition ${
                    isPreviewing
                      ? 'bg-emerald-500/25 text-emerald-300 border border-emerald-500/40'
                      : 'bg-zinc-800 text-zinc-300 hover:text-white'
                  }`}
                >
                  {isPreviewing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                </button>
              )}
              <button
                type="button"
                onClick={() => onToggleBgmEnabled(slot)}
                title={bgm.enabled ? '点击停用' : '点击启用'}
                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold cursor-pointer transition ${
                  bgm.enabled
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/35'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {bgm.enabled ? '已启用' : '已停用'}
              </button>
              {onSaveSlotToGlobalLibrary && (
                <button
                  type="button"
                  onClick={() => onSaveSlotToGlobalLibrary(slot)}
                  title="保存到全局固定库"
                  className="p-1 rounded bg-purple-500/15 hover:bg-purple-500/25 text-purple-300 cursor-pointer transition"
                >
                  <Library className="w-3 h-3" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onImportBgm(slot)}
                title={`更换${label}文件`}
                className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-300 cursor-pointer transition"
              >
                更换
              </button>
              <button
                type="button"
                onClick={() => {
                  if (isPreviewing) {
                    audioPreview.stopBgmPreview();
                    setPreviewingSlot(null);
                  }
                  onRemoveBgm(slot);
                }}
                title={`移除${label}`}
                className="p-1 text-zinc-500 hover:text-red-400 cursor-pointer transition"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {bgm ? (
          <div
            title={bgm.filePath || bgm.fileName}
            className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-zinc-400 bg-zinc-950/75 px-2 py-1 rounded border border-zinc-800/80"
          >
            <span className="inline-flex items-center gap-1.5 min-w-0 truncate text-zinc-200 font-mono">
              <FileAudio className="w-3 h-3 text-zinc-400 shrink-0" />
              <span className="truncate">{bgm.fileName}</span>
            </span>
            {typeof bgm.durationSec === 'number' && bgm.durationSec > 0 && (
              <span className="font-mono text-zinc-400 shrink-0">
                {formatMmSs(bgm.durationSec)}
              </span>
            )}
          </div>
        ) : (
          <div className="mt-1 text-[11px] text-zinc-500">
            {slot === 'intro_vo'
              ? '支持导入播客固定欢迎词/栏目导语录音，自动插在正片前'
              : slot === 'intro'
              ? '支持自定义背景垫乐，人声说话时自动稳压下潜'
              : '节目结尾自动平滑渐入垫乐收束'}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="w-[380px] max-w-[92vw] rounded-xl border border-zinc-700/90 bg-zinc-900/98 shadow-2xl p-3 z-50 text-xs backdrop-blur-md space-y-3.5 max-h-[85vh] overflow-y-auto select-none">
      <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
        <div className="flex items-center gap-1.5 font-bold text-zinc-100 text-xs">
          <Music className="w-4 h-4 text-blue-400" />
          <span>片头固定口播与 BGM 垫乐配置</span>
        </div>
        <span className="text-[10px] text-zinc-500 font-mono">
          {((state.introVoiceover?.enabled ? 1 : 0) +
            (state.introBgm?.enabled ? 1 : 0) +
            (state.outroBgm?.enabled ? 1 : 0))}/3 已启用
        </span>
      </div>

      {/* ================= 1. 片头固定口播 ================= */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
            <Mic className="w-3.5 h-3.5 text-amber-400" />
            <span>片头固定口播</span>
          </div>
          <label className="flex items-center gap-1 text-[11px] text-zinc-300 cursor-pointer hover:text-white">
            <input
              type="checkbox"
              checked={Boolean(state.introVoiceover?.enabled)}
              onChange={() => onToggleBgmEnabled('intro_vo')}
              className="rounded accent-amber-500"
            />
            <span>启用口播</span>
          </label>
        </div>

        {renderSlotCard('intro_vo', '固定口播', '开场导语', state.introVoiceover)}

        {state.introVoiceover && (
          <div className="p-2 rounded bg-zinc-950/70 border border-zinc-800 space-y-1.5 text-[11px]">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-zinc-400 flex items-center gap-1">
                <Clock className="w-3 h-3 text-amber-400" />
                <span>口播开始时间</span>
              </span>
              <span className="font-mono text-amber-300">
                {typeof state.introVoiceover.startOffsetSec === 'number'
                  ? `@${state.introVoiceover.startOffsetSec.toFixed(1)}s`
                  : '紧随金句之后 (自动)'}
              </span>
            </div>

            <div className="flex items-center gap-1 overflow-x-auto text-[10px]">
              <button
                type="button"
                onClick={() =>
                  onUpdateState((p) => ({
                    ...p,
                    introVoiceover: p.introVoiceover
                      ? { ...p.introVoiceover, startOffsetSec: undefined }
                      : null,
                  }))
                }
                className={`px-1.5 py-0.5 rounded border transition cursor-pointer shrink-0 ${
                  state.introVoiceover.startOffsetSec === undefined
                    ? 'bg-amber-600/30 text-amber-200 border-amber-500/60 font-medium'
                    : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                }`}
              >
                紧随金句 (自动)
              </button>
              <button
                type="button"
                onClick={() =>
                  onUpdateState((p) => ({
                    ...p,
                    introVoiceover: p.introVoiceover
                      ? { ...p.introVoiceover, startOffsetSec: 0 }
                      : null,
                  }))
                }
                className={`px-1.5 py-0.5 rounded border transition cursor-pointer shrink-0 ${
                  state.introVoiceover.startOffsetSec === 0
                    ? 'bg-amber-600/30 text-amber-200 border-amber-500/60 font-medium'
                    : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                }`}
              >
                00:00 片头最前
              </button>
              <button
                type="button"
                onClick={() =>
                  onUpdateState((p) => ({
                    ...p,
                    introVoiceover: p.introVoiceover
                      ? { ...p.introVoiceover, startOffsetSec: 2.0 }
                      : null,
                  }))
                }
                className={`px-1.5 py-0.5 rounded border transition cursor-pointer shrink-0 ${
                  state.introVoiceover.startOffsetSec === 2.0
                    ? 'bg-amber-600/30 text-amber-200 border-amber-500/60 font-medium'
                    : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                }`}
              >
                2.0s 紧随前奏
              </button>
              <div className="flex items-center gap-1 shrink-0 ml-auto">
                <input
                  type="number"
                  step="0.5"
                  min={0}
                  max={300}
                  value={state.introVoiceover.startOffsetSec ?? ''}
                  placeholder="秒"
                  onChange={(e) => {
                    const val = e.target.value === '' ? undefined : Number(e.target.value);
                    onUpdateState((p) => ({
                      ...p,
                      introVoiceover: p.introVoiceover
                        ? { ...p.introVoiceover, startOffsetSec: val }
                        : null,
                    }));
                  }}
                  className="w-12 px-1 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-[10px] text-center"
                />
                <span className="text-zinc-500 text-[10px]">s</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-zinc-800" />

      {/* ================= 2. 片头 BGM 与人声避让 ================= */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
            <Music className="w-3.5 h-3.5 text-blue-400" />
            <span>片头 BGM 垫乐</span>
          </div>
          <label className="flex items-center gap-1 text-[11px] text-zinc-300 cursor-pointer hover:text-white">
            <input
              type="checkbox"
              checked={Boolean(state.introBgm?.enabled)}
              onChange={() => onToggleBgmEnabled('intro')}
              className="rounded accent-blue-500"
            />
            <span>启用片头BGM</span>
          </label>
        </div>

        {/* 提示：仅接受上传的音乐 */}
        {(!state.introBgm || (!state.introBgm.filePath && !state.introBgm.audioUrl)) && (
          <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30 text-amber-200 text-[11px] flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
            <div className="leading-tight">
              <span className="font-semibold text-amber-300">仅接受本地上传的音乐</span>
              <p className="text-[10px] text-amber-200/80 mt-0.5">
                已取消乐段合成风格。请上传 MP3、WAV、AAC、M4A 或 FLAC 格式音乐，系统将按您指定的时长自动将其加入到节目开头。
              </p>
            </div>
          </div>
        )}

        {renderSlotCard('intro', '片头 BGM', `闪避深度 ${state.bgmDuckDb ?? -18}dB`, state.introBgm)}

        {/* 片头 BGM 指定播放时长（支持快捷选择 + 精准秒数自定义） */}
        <div className="p-2 rounded bg-zinc-950/70 border border-zinc-800 space-y-2 text-[11px]">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-zinc-400 flex items-center gap-1">
              <Clock className="w-3 h-3 text-blue-400" />
              <span>片头 BGM 开头播放时长</span>
            </span>
            <span className="font-mono text-blue-300">
              {typeof state.introBgm?.customDurationSec === 'number' &&
              state.introBgm.customDurationSec > 0
                ? `${state.introBgm.customDurationSec}s (自定义)`
                : typeof state.introBgm?.durationSec === 'number' && state.introBgm.durationSec > 0
                ? `${state.introBgm.durationSec.toFixed(1)}s (音频原长)`
                : '10.0s (默认)'}
            </span>
          </div>

          <div className="flex items-center gap-1 overflow-x-auto text-[10px]">
            <button
              type="button"
              onClick={() =>
                onUpdateState((p) => ({
                  ...p,
                  introBgm: p.introBgm
                    ? { ...p.introBgm, customDurationSec: undefined }
                    : null,
                }))
              }
              className={`px-1.5 py-0.5 rounded border transition cursor-pointer shrink-0 ${
                !state.introBgm?.customDurationSec
                  ? 'bg-blue-600/30 text-blue-200 border-blue-500/60 font-medium'
                  : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
              }`}
            >
              跟随音频
            </button>
            {[5, 10, 15, 30, 60].map((sec) => (
              <button
                key={sec}
                type="button"
                onClick={() =>
                  onUpdateState((p) => ({
                    ...p,
                    introBgm: p.introBgm
                      ? { ...p.introBgm, customDurationSec: sec }
                      : null,
                  }))
                }
                className={`px-1.5 py-0.5 rounded border transition cursor-pointer shrink-0 ${
                  state.introBgm?.customDurationSec === sec
                    ? 'bg-blue-600/30 text-blue-200 border-blue-500/60 font-medium'
                    : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                }`}
              >
                {sec}s
              </button>
            ))}

            {/* 精确数值自定义输入框 */}
            <div className="flex items-center gap-1 shrink-0 ml-auto pl-1">
              <span className="text-[10px] text-zinc-500">自定义:</span>
              <input
                type="number"
                step="0.5"
                min={1}
                max={600}
                value={state.introBgm?.customDurationSec ?? ''}
                placeholder="秒"
                onChange={(e) => {
                  const val = e.target.value === '' ? undefined : Math.max(0.5, Number(e.target.value));
                  onUpdateState((p) => ({
                    ...p,
                    introBgm: p.introBgm
                      ? { ...p.introBgm, customDurationSec: val }
                      : null,
                  }));
                }}
                className="w-12 px-1 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-[10px] text-center focus:border-blue-500 focus:outline-none"
              />
              <span className="text-zinc-500 text-[10px]">s</span>
            </div>
          </div>

          {/* 实时机制说明 */}
          <div className="text-[10px] text-zinc-400 bg-blue-950/20 border border-blue-800/30 rounded px-2 py-1.5 leading-relaxed">
            <span className="text-blue-300 font-semibold">自动编排：</span>
            片头 BGM 将按指定时长（
            <span className="text-blue-300 font-mono font-bold">
              {typeof state.introBgm?.customDurationSec === 'number' && state.introBgm.customDurationSec > 0
                ? `${state.introBgm.customDurationSec}s`
                : typeof state.introBgm?.durationSec === 'number' && state.introBgm.durationSec > 0
                ? `${state.introBgm.durationSec.toFixed(1)}s`
                : '10.0s'}
            </span>
            ）独立加入到节目最开头播放，正文人声与文字将在此之后切入。
          </div>
        </div>

        {/* 人声避让闪避深度调整 */}
        <div className="flex items-center justify-between p-2 rounded bg-zinc-950/50 border border-zinc-800 text-[11px]">
          <span className="text-zinc-400 text-[10px]">人声避让闪避深度 (Ducking)</span>
          <select
            value={state.bgmDuckDb ?? -18}
            onChange={(e) =>
              onUpdateState((p) => ({
                ...p,
                bgmDuckDb: Number(e.target.value),
              }))
            }
            className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-200 text-[10px] focus:outline-none"
          >
            <option value={-12}>较轻 (-12dB)</option>
            <option value={-18}>广播标准 (-18dB 推荐)</option>
            <option value={-24}>深度避让 (-24dB)</option>
          </select>
        </div>
      </div>

      <div className="border-t border-zinc-800" />

      {/* ================= 3. 片尾 BGM ================= */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
            <Music className="w-3.5 h-3.5 text-emerald-400" />
            <span>片尾 BGM 垫乐</span>
          </div>
          <label className="flex items-center gap-1 text-[11px] text-zinc-300 cursor-pointer hover:text-white">
            <input
              type="checkbox"
              checked={Boolean(state.outroBgm?.enabled)}
              onChange={() => onToggleBgmEnabled('outro')}
              className="rounded accent-emerald-500"
            />
            <span>启用片尾BGM</span>
          </label>
        </div>

        {renderSlotCard('outro', '片尾 BGM', '结尾收束垫乐', state.outroBgm)}
      </div>

      {/* ================= 4. 全局辅助音频库入口 ================= */}
      {onOpenGlobalAuxLibrary && (
        <div className="pt-1 border-t border-zinc-800">
          <button
            type="button"
            onClick={() => {
              if (onClose) onClose();
              onOpenGlobalAuxLibrary('intro');
            }}
            className="w-full py-1.5 rounded-lg bg-purple-600/15 hover:bg-purple-600/25 border border-purple-500/35 text-purple-200 flex items-center justify-center gap-1.5 text-xs font-medium cursor-pointer transition"
          >
            <Library className="w-3.5 h-3.5 text-purple-400" />
            <span>打开固定口播与 BGM 资产库...</span>
          </button>
        </div>
      )}
    </div>
  );
};
