import React, { useEffect } from 'react';
import { Keyboard, X } from 'lucide-react';

interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

interface ShortcutGroup {
  title: string;
  items: Array<{ keys: string[]; desc: string }>;
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '视图切换与侧边栏',
    items: [
      { keys: ['⌥ 1'], desc: '切换为 音轨主视图（多轨波形舞台）' },
      { keys: ['⌥ 2'], desc: '切换为 文稿（自然成稿长文阅读）' },
      { keys: ['⌥ 5'], desc: '切换为 录制视图（实时转写与 AI 对话助手）' },
      { keys: ['⌘ ['], desc: '折叠 / 展开左侧音轨与素材栏' },
      { keys: ['⌘ ]'], desc: '折叠 / 展开右侧 AI 工作台' },
    ],
  },
  {
    title: '播放与定位',
    items: [
      { keys: ['Space', 'K'], desc: '播放 / 暂停审听' },
      { keys: ['←', 'J'], desc: '快退 5 秒（Shift + ← 快退 1 秒）' },
      { keys: ['→', 'L'], desc: '快进 5 秒（Shift + → 快进 1 秒）' },
      { keys: ['0', 'Home'], desc: '回到片头 00:00' },
      { keys: ['[', ']'], desc: '减速 / 加速倍速播放（不变调）' },
      { keys: ['\\'], desc: '切换当前倍速与 1x 原速' },
      { keys: ['单击波形 / 文字'], desc: '跳转游标到对应时间点' },
    ],
  },
  {
    title: '波形框选与剪辑',
    items: [
      { keys: ['N'], desc: '切换 吸附模式（吸附文字间隙）↔ 自由模式（严格按选区删除）' },
      { keys: ['Delete', 'Backspace'], desc: '静音当前悬停轨框选区间，或删除选中文字（删后自动从 3s 前播放）' },
      { keys: ['⌘ ⇧ Delete'], desc: '全轨切除框选区间并后续吸附（删后自动从 3s 前播放）' },
      { keys: ['B'], desc: '将当前波形选区或选中文字替换为「哔——」消音（字幕同步打码）' },
      { keys: ['⌘ Z'], desc: '撤销上一步编辑' },
      { keys: ['Esc'], desc: '取消当前波形选区或文字选中' },
      { keys: ['右键选区 / 文字'], desc: '打开快捷菜单（加入金句 / 切除 / 静音 / 消音）' },
    ],
  },
  {
    title: '波形缩放与工程',
    items: [
      { keys: ['⌘ + 滚轮'], desc: '放大 / 缩小波形时间轴' },
      { keys: ['+', '-'], desc: '步进放大 / 缩小波形时间轴' },
      { keys: ['⌘ O', '⌘ S'], desc: '打开 / 保存 .podcraft 工程' },
      { keys: ['⇧ ⌘ S'], desc: '工程另存为' },
      { keys: ['?'], desc: '打开 / 关闭本快捷键说明' },
    ],
  },
];

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ open, onClose }) => {
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

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-2xl border border-zinc-700/90 bg-zinc-900 shadow-2xl overflow-hidden"
      >
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/95">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-blue-400" />
            <h2 className="text-sm font-semibold text-zinc-100">快捷键说明</h2>
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

        <div className="p-5 max-h-[75vh] overflow-y-auto space-y-5">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                {group.title}
              </h3>
              <div className="divide-y divide-zinc-800/80 rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
                {group.items.map((item) => (
                  <div
                    key={item.desc}
                    className="px-3.5 py-2 flex items-center justify-between gap-4 text-xs"
                  >
                    <span className="text-zinc-300">{item.desc}</span>
                    <div className="flex items-center gap-1 shrink-0">
                      {item.keys.map((k, idx) => (
                        <React.Fragment key={k}>
                          {idx > 0 && <span className="text-zinc-600 text-[10px]">/</span>}
                          <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 font-mono text-[11px]">
                            {k}
                          </kbd>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
};
