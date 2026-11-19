import React, { useEffect, useState } from 'react';
import {
  Check,
  FolderPlus,
  Library,
  Mic,
  Music,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { AuxAudioSlot, GlobalAuxPresetItem } from '../engine/globalAuxLibrary';

interface GlobalAuxLibraryModalProps {
  open: boolean;
  initialSlot?: AuxAudioSlot;
  items: GlobalAuxPresetItem[];
  activeFiles: {
    intro_vo?: string;
    intro?: string;
    outro?: string;
  };
  onClose: () => void;
  onAddFileToLibrary: (slot: AuxAudioSlot) => void;
  onApplyPreset: (item: GlobalAuxPresetItem) => void;
  onToggleDefault: (item: GlobalAuxPresetItem) => void;
  onRemoveItem: (item: GlobalAuxPresetItem) => void;
}

const SLOT_TABS: Array<{ id: AuxAudioSlot; label: string; desc: string }> = [
  { id: 'intro_vo', label: '片头固定口播', desc: '栏目固定开场导语，自动插在正片前' },
  { id: 'intro', label: '片头 BGM', desc: '片头背景垫乐，支持人声智能闪避' },
  { id: 'outro', label: '片尾 BGM', desc: '正片结尾渐入垫乐' },
];

export const GlobalAuxLibraryModal: React.FC<GlobalAuxLibraryModalProps> = ({
  open,
  initialSlot = 'intro_vo',
  items,
  activeFiles,
  onClose,
  onAddFileToLibrary,
  onApplyPreset,
  onToggleDefault,
  onRemoveItem,
}) => {
  const [activeSlot, setActiveSlot] = useState<AuxAudioSlot>(initialSlot);

  useEffect(() => {
    if (open) {
      setActiveSlot(initialSlot);
    }
  }, [open, initialSlot]);

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

  const slotItems = items.filter((it) => it.slot === activeSlot);
  const currentTabMeta = SLOT_TABS.find((t) => t.id === activeSlot)!;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-2xl border border-zinc-700/90 bg-zinc-900 shadow-2xl overflow-hidden flex flex-col max-h-[82vh]"
      >
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/95">
          <div className="flex items-center gap-2">
            <Library className="w-4 h-4 text-purple-400" />
            <h2 className="text-sm font-semibold text-zinc-100">全局固定口播 / BGM 库</h2>
            <span className="text-[11px] text-zinc-500">跨工程持久保存 · 支持设为新工程默认</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition cursor-pointer"
            title="关闭 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pt-3 border-b border-zinc-800 flex items-center justify-between gap-2 bg-zinc-950/40">
          <div className="flex items-center gap-1">
            {SLOT_TABS.map((tab) => {
              const count = items.filter((it) => it.slot === tab.id).length;
              const isActive = activeSlot === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveSlot(tab.id)}
                  className={`px-3 py-2 text-xs font-semibold border-b-2 transition cursor-pointer flex items-center gap-1.5 ${
                    isActive
                      ? 'border-purple-500 text-purple-200'
                      : 'border-transparent text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {tab.id === 'intro_vo' ? (
                    <Mic className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Music className="w-3.5 h-3.5 text-purple-400" />
                  )}
                  <span>{tab.label}</span>
                  <span className="px-1.5 py-0 rounded-full bg-zinc-800 text-[10px] font-mono text-zinc-400">
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => onAddFileToLibrary(activeSlot)}
            className="mb-1.5 px-2.5 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            <span>添加音频到库</span>
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-3 flex-1">
          <div className="text-xs text-zinc-400 flex items-center justify-between">
            <span>{currentTabMeta.desc}</span>
            <span className="text-[11px] text-zinc-500">
              设为「默认」后，新建工程将自动载入该音频
            </span>
          </div>

          {slotItems.length === 0 ? (
            <div className="p-8 rounded-xl border border-dashed border-zinc-800 text-center space-y-2">
              <p className="text-xs text-zinc-400">
                当前「{currentTabMeta.label}」库中暂无预设音频
              </p>
              <button
                type="button"
                onClick={() => onAddFileToLibrary(activeSlot)}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-200 inline-flex items-center gap-1.5 cursor-pointer transition"
              >
                <FolderPlus className="w-3.5 h-3.5 text-purple-400" />
                <span>选择本地音频文件加入库</span>
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {slotItems.map((item) => {
                const isApplied =
                  activeFiles[activeSlot] !== undefined &&
                  activeFiles[activeSlot] === item.fileName;
                return (
                  <div
                    key={item.id}
                    className={`p-3 rounded-xl border transition flex items-center justify-between gap-3 ${
                      item.isDefault
                        ? 'border-amber-500/45 bg-amber-500/5'
                        : 'border-zinc-800 bg-zinc-950/60 hover:border-zinc-700'
                    }`}
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-semibold text-zinc-100 truncate">
                          {item.name}
                        </span>
                        {item.durationSec !== undefined && (
                          <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] font-mono text-zinc-400 shrink-0">
                            {item.durationSec.toFixed(1)}s
                          </span>
                        )}
                        {item.isDefault && (
                          <span className="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-[10px] font-medium text-amber-300 shrink-0">
                            新工程默认
                          </span>
                        )}
                        {isApplied && (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-[10px] font-medium text-emerald-300 shrink-0">
                            当前工程已用
                          </span>
                        )}
                      </div>
                      {item.filePath && (
                        <p className="text-[11px] text-zinc-500 font-mono truncate">
                          {item.filePath}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => onToggleDefault(item)}
                        title={item.isDefault ? '取消新工程默认' : '设为新工程默认'}
                        className={`px-2 py-1 rounded-lg border text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer transition ${
                          item.isDefault
                            ? 'border-amber-500/50 bg-amber-500/20 text-amber-200'
                            : 'border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
                        }`}
                      >
                        <Star
                          className={`w-3 h-3 ${
                            item.isDefault ? 'fill-amber-400 text-amber-400' : ''
                          }`}
                        />
                        <span>{item.isDefault ? '已默认' : '设为默认'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => onApplyPreset(item)}
                        className="px-2.5 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer transition"
                      >
                        <Check className="w-3 h-3" />
                        <span>应用</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => onRemoveItem(item)}
                        title="从全局库移除"
                        className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 cursor-pointer transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
