import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckSquare,
  ClipboardPaste,
  Clock,
  FileText,
  FolderOpen,
  Sparkles,
  Square,
  Upload,
  X,
} from 'lucide-react';
import { PodcastProjectState } from '../types/podcast';
import {
  isTauriRuntime,
  openSubtitleFileNative,
  readSubtitleBrowserFile,
} from '../engine/tauriBridge';
import {
  applySubtitleCorrectionHunks,
  parseSubtitleDocument,
  previewSubtitleCorrection,
  SubtitleAlignOptions,
} from '../engine/subtitleAligner';
import { formatMmSs } from '../engine/timelineEngine';

interface SubtitleCorrectionModalProps {
  open: boolean;
  state: PodcastProjectState;
  initialSubtitle?: { fileName: string; content: string } | null;
  onClose: () => void;
  onApplyCorrection: (
    updater: (prev: PodcastProjectState) => PodcastProjectState,
    summaryMsg: string
  ) => void;
  onNotify: (msg: string) => void;
}

const KIND_BADGE: Record<
  'typo_replace' | 'punctuation' | 'filler_hide' | 'placeholder_fill',
  { label: string; cls: string }
> = {
  typo_replace: {
    label: '错字矫正',
    cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  },
  punctuation: {
    label: '标点同步',
    cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  },
  filler_hide: {
    label: '隐藏口癖',
    cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  },
  placeholder_fill: {
    label: '填充字幕',
    cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  },
};

export const SubtitleCorrectionModal: React.FC<SubtitleCorrectionModalProps> = ({
  open,
  state,
  initialSubtitle,
  onClose,
  onApplyCorrection,
  onNotify,
}) => {
  const [sourceMode, setSourceMode] = useState<'file' | 'paste'>('file');
  const [loadedFileName, setLoadedFileName] = useState<string>('');
  const [rawText, setRawText] = useState<string>('');
  const [targetTrackId, setTargetTrackId] = useState<string>('all');
  const [timeOffsetMs, setTimeOffsetMs] = useState<number>(0);
  const [autoHideOmittedFillers, setAutoHideOmittedFillers] = useState<boolean>(false);
  const [syncPunctuation, setSyncPunctuation] = useState<boolean>(true);
  const [extractGlossaryWords, setExtractGlossaryWords] = useState<boolean>(true);
  const [selectedHunkIds, setSelectedHunkIds] = useState<Set<string>>(new Set());

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open && initialSubtitle) {
      setSourceMode('file');
      setLoadedFileName(initialSubtitle.fileName);
      setRawText(initialSubtitle.content);
      setTimeOffsetMs(0);
    }
  }, [open, initialSubtitle]);

  const parsedDoc = useMemo(() => {
    if (!open || !rawText.trim()) return null;
    return parseSubtitleDocument(
      rawText,
      sourceMode === 'file' && loadedFileName ? loadedFileName : '粘贴文稿.txt'
    );
  }, [open, rawText, sourceMode, loadedFileName]);

  const alignOptions: SubtitleAlignOptions = useMemo(
    () => ({
      targetTrackId,
      timeOffsetMs,
      autoHideOmittedFillers,
      syncPunctuation,
      extractGlossaryWords,
    }),
    [targetTrackId, timeOffsetMs, autoHideOmittedFillers, syncPunctuation, extractGlossaryWords]
  );

  const preview = useMemo(() => {
    if (!open || !parsedDoc || parsedDoc.cues.length === 0) return null;
    return previewSubtitleCorrection(state, parsedDoc, alignOptions);
  }, [open, state, parsedDoc, alignOptions]);

  // Select all detected hunks by default whenever preview recomputes
  useEffect(() => {
    if (!preview) {
      setSelectedHunkIds(new Set());
      return;
    }
    setSelectedHunkIds(new Set(preview.hunks.map((h) => h.id)));
  }, [preview]);

  if (!open) return null;

  const editableTracks = state.tracks.filter((t) => !t.isRef);

  const handlePickNativeOrBrowserFile = async () => {
    if (isTauriRuntime()) {
      try {
        const res = await openSubtitleFileNative();
        if (!res) return;
        setSourceMode('file');
        setLoadedFileName(res.fileName);
        setRawText(res.content);
        setTimeOffsetMs(0);
      } catch (err) {
        onNotify(`读取字幕文件失败: ${String(err)}`);
      }
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleBrowserFileSelected = async (file: File) => {
    try {
      const res = await readSubtitleBrowserFile(file);
      setSourceMode('file');
      setLoadedFileName(res.fileName);
      setRawText(res.content);
      setTimeOffsetMs(0);
    } catch (err) {
      onNotify(`读取字幕文件失败: ${String(err)}`);
    }
  };

  const toggleHunk = (id: string) => {
    setSelectedHunkIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirmApply = () => {
    if (!preview || selectedHunkIds.size === 0) return;

    let appliedTotal = 0;
    let glossaryAdded = 0;
    onApplyCorrection((prev) => {
      const outcome = applySubtitleCorrectionHunks(
        prev,
        preview,
        selectedHunkIds,
        extractGlossaryWords
      );
      appliedTotal = outcome.appliedCount;
      glossaryAdded = outcome.addedGlossaryCount;
      return {
        ...prev,
        blocks: outcome.nextBlocks,
        glossary: outcome.nextGlossary,
      };
    }, '');

    const glossarySuffix =
      glossaryAdded > 0 ? `，并沉淀 ${glossaryAdded} 个专有词条至热词库` : '';
    onNotify(
      `✨ 已根据「${parsedDoc?.fileName}」无损矫正 ${appliedTotal} 处文稿内容${glossarySuffix}（按 ⌘Z 可撤销）`
    );
    onClose();
  };

  const typoOnlyCount = preview?.hunks.filter((h) => h.kind !== 'punctuation').length ?? 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
      <input
        ref={fileInputRef}
        type="file"
        accept=".srt,.vtt,.ass,.ssa,.lrc,.txt,.md,.json,.bcc,text/plain,application/json"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            void handleBrowserFileSelected(f);
            e.target.value = '';
          }
        }}
        className="hidden"
      />

      <div className="w-full max-w-3xl rounded-2xl border border-zinc-700/90 bg-zinc-900 p-5 space-y-4 shadow-2xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3 shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center">
              <FileText className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">
                导入第三方字幕 / 校对逐字稿智能矫正文字
              </h2>
              <p className="text-[11px] text-zinc-400">
                支持 SRT / VTT / ASS / LRC / JSON / 飞书听悟导出的时间轴稿或纯文本校对稿，严格锁定原声毫秒切点不伤音频
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-zinc-100 rounded hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Source Mode Switcher */}
        <div className="flex items-center justify-between gap-2 shrink-0">
          <div className="inline-flex rounded-lg bg-zinc-950 p-0.5 border border-zinc-800 text-xs">
            <button
              onClick={() => setSourceMode('file')}
              className={`px-3 py-1.5 rounded-md font-medium flex items-center gap-1.5 cursor-pointer transition ${
                sourceMode === 'file'
                  ? 'bg-zinc-800 text-zinc-100 shadow-xs'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <FolderOpen className="w-3.5 h-3.5 text-emerald-400" />
              <span>导入字幕文件 (.srt/.vtt/.ass/.lrc/.txt/.json)</span>
            </button>
            <button
              onClick={() => setSourceMode('paste')}
              className={`px-3 py-1.5 rounded-md font-medium flex items-center gap-1.5 cursor-pointer transition ${
                sourceMode === 'paste'
                  ? 'bg-zinc-800 text-zinc-100 shadow-xs'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <ClipboardPaste className="w-3.5 h-3.5 text-blue-400" />
              <span>直接粘贴字幕 / 校对文稿</span>
            </button>
          </div>

          {parsedDoc && parsedDoc.cues.length > 0 && (
            <div className="px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-[11px] text-emerald-300 font-medium">
              ✓ {parsedDoc.formatLabel} · {parsedDoc.cues.length} 段 · {parsedDoc.totalCharCount} 字
            </div>
          )}
        </div>

        {/* File Dropzone or Paste Area */}
        <div className="shrink-0">
          {sourceMode === 'file' ? (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const dropped = e.dataTransfer.files?.[0];
                if (dropped) {
                  void handleBrowserFileSelected(dropped);
                }
              }}
              onClick={() => void handlePickNativeOrBrowserFile()}
              className="p-4 rounded-xl border border-dashed border-zinc-700 hover:border-emerald-500/60 bg-zinc-950/75 hover:bg-zinc-950 flex items-center justify-between gap-4 cursor-pointer transition"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-emerald-400 shrink-0">
                  <Upload className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-zinc-100 truncate">
                    {loadedFileName
                      ? `当前已加载：${loadedFileName}`
                      : '点击选择或将第三方字幕文件拖拽至此处'}
                  </div>
                  <div className="text-[11px] text-zinc-400">
                    自动兼容 UTF-8 / UTF-16 / GB18030(GBK) 编码，支持剪映、Whisper、飞书妙记、通义听悟、B站 BCC 等导出格式
                  </div>
                </div>
              </div>
              <span className="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold">
                {loadedFileName ? '更换文件' : '选择字幕文件'}
              </span>
            </div>
          ) : (
            <textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              rows={4}
              placeholder="在此粘贴 SRT/VTT 字幕内容，或直接粘贴人工校对后的纯文本播客逐字稿..."
              className="w-full p-3 rounded-xl border border-zinc-700 bg-zinc-950 text-xs text-zinc-100 font-mono leading-relaxed focus:outline-none focus:border-emerald-500"
            />
          )}
        </div>

        {/* Alignment Controls */}
        <div className="p-3 rounded-xl border border-zinc-800 bg-zinc-950/80 space-y-2.5 text-xs shrink-0">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-zinc-400 shrink-0">作用音轨范围：</span>
              <select
                value={targetTrackId}
                onChange={(e) => setTargetTrackId(e.target.value)}
                className="flex-1 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-100 focus:outline-none"
              >
                <option value="all">🌐 智能全轨匹配（矫正全工程对话）</option>
                {editableTracks.map((tr) => (
                  <option key={tr.id} value={tr.id}>
                    🎙️ 仅矫正：{tr.name} ({tr.roleLabel.split(' ')[0]})
                  </option>
                ))}
              </select>
            </div>

            {parsedDoc?.hasTimestamps && (
              <div className="flex items-center justify-between gap-1.5">
                <span className="text-zinc-400 inline-flex items-center gap-1 shrink-0">
                  <Clock className="w-3.5 h-3.5 text-blue-400" />
                  <span>字幕时间偏移：</span>
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setTimeOffsetMs((v) => v - 500)}
                    className="px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-[11px] font-mono text-zinc-300 cursor-pointer"
                  >
                    -0.5s
                  </button>
                  <input
                    type="number"
                    step={100}
                    value={timeOffsetMs}
                    onChange={(e) => setTimeOffsetMs(Number(e.target.value) || 0)}
                    className="w-20 px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-center font-mono text-zinc-100"
                  />
                  <span className="text-[11px] text-zinc-500 font-mono">ms</span>
                  <button
                    onClick={() => setTimeOffsetMs((v) => v + 500)}
                    className="px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-[11px] font-mono text-zinc-300 cursor-pointer"
                  >
                    +0.5s
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 pt-1.5 border-t border-zinc-800/80 text-zinc-300">
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={syncPunctuation}
                onChange={(e) => setSyncPunctuation(e.target.checked)}
                className="rounded accent-emerald-500"
              />
              <span>同步句读标点符号</span>
            </label>

            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={autoHideOmittedFillers}
                onChange={(e) => setAutoHideOmittedFillers(e.target.checked)}
                className="rounded accent-amber-500"
              />
              <span>同步隐藏字幕稿已删去的纯口癖（呃/啊/那个）</span>
            </label>

            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={extractGlossaryWords}
                onChange={(e) => setExtractGlossaryWords(e.target.checked)}
                className="rounded accent-blue-500"
              />
              <span>自动沉淀专有词至播客热词库</span>
            </label>
          </div>
        </div>

        {/* Diff Preview Area */}
        <div className="flex-1 min-h-[180px] flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
          <div className="px-3.5 py-2 border-b border-zinc-800 bg-zinc-900/70 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
              <span className="font-semibold text-zinc-100">
                逐处对齐差异预览
                {preview ? `（共检测到 ${preview.hunks.length} 处差异，已勾选 ${selectedHunkIds.size} 处）` : ''}
              </span>
              {!autoHideOmittedFillers && preview && preview.hunks.length > 0 && (
                <span className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 text-[11px] text-emerald-300">
                  🔒 原音频总时长偏差 0.00s
                </span>
              )}
            </div>

            {preview && preview.hunks.length > 0 && (
              <div className="flex items-center gap-2 text-[11px]">
                <button
                  onClick={() => setSelectedHunkIds(new Set(preview.hunks.map((h) => h.id)))}
                  className="text-blue-400 hover:text-blue-300 cursor-pointer"
                >
                  全选 ({preview.hunks.length})
                </button>
                <span className="text-zinc-700">|</span>
                <button
                  onClick={() =>
                    setSelectedHunkIds(
                      new Set(
                        preview.hunks
                          .filter((h) => h.kind !== 'punctuation')
                          .map((h) => h.id)
                      )
                    )
                  }
                  className="text-emerald-400 hover:text-emerald-300 cursor-pointer"
                >
                  仅选文字矫正 ({typoOnlyCount})
                </button>
                <span className="text-zinc-700">|</span>
                <button
                  onClick={() => setSelectedHunkIds(new Set())}
                  className="text-zinc-400 hover:text-zinc-200 cursor-pointer"
                >
                  清空
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
            {state.blocks.length === 0 ? (
              <div className="h-36 flex items-center justify-center text-xs text-zinc-500">
                当前工程尚未导入音频轨道，请先导入音频后再用第三方字幕矫正文字稿
              </div>
            ) : !parsedDoc || parsedDoc.cues.length === 0 ? (
              <div className="h-36 flex items-center justify-center text-xs text-zinc-500">
                请选择本地字幕文件（.srt / .vtt / .ass / .lrc / .txt / .json）或粘贴校对文稿以预览对齐差异
              </div>
            ) : preview && preview.hunks.length === 0 ? (
              <div className="h-36 flex flex-col items-center justify-center gap-1 text-xs text-emerald-400">
                <Check className="w-5 h-5" />
                <span>当前工程文字稿与导入的字幕内容完全一致，无需额外矫正！</span>
              </div>
            ) : (
              preview?.hunks.map((hunk) => {
                const checked = selectedHunkIds.has(hunk.id);
                const badge = KIND_BADGE[hunk.kind];
                return (
                  <div
                    key={hunk.id}
                    onClick={() => toggleHunk(hunk.id)}
                    className={`p-2.5 rounded-lg border flex items-center justify-between gap-3 text-xs cursor-pointer transition ${
                      checked
                        ? 'border-zinc-700 bg-zinc-900/90 hover:border-emerald-500/45'
                        : 'border-zinc-800/70 bg-zinc-950/60 opacity-55'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      {checked ? (
                        <CheckSquare className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <Square className="w-4 h-4 text-zinc-600 shrink-0" />
                      )}

                      <span className="font-mono text-[11px] text-zinc-400 shrink-0">
                        @{formatMmSs(hunk.startMs / 1000)}
                      </span>

                      <span
                        className="px-1.5 py-0.5 rounded text-[11px] font-medium text-white shrink-0"
                        style={{ backgroundColor: hunk.speakerColor }}
                      >
                        {hunk.speakerName}
                      </span>

                      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                        <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 line-through font-medium">
                          {hunk.beforeText}
                        </span>
                        <span className="text-zinc-500">→</span>
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-semibold">
                          {hunk.afterText}
                        </span>
                      </div>
                    </div>

                    <span
                      className={`px-2 py-0.5 rounded border text-[10px] font-medium shrink-0 ${badge.cls}`}
                    >
                      {badge.label}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between gap-3 pt-1 shrink-0">
          <span className="text-[11px] text-zinc-500">
            提示：应用矫正后自动计入编辑历史，随时可按 <kbd className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono">⌘Z</kbd> 一键撤回
          </span>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3.5 py-2 rounded-xl border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 cursor-pointer transition"
            >
              取消
            </button>
            <button
              disabled={!preview || selectedHunkIds.size === 0 || state.blocks.length === 0}
              onClick={handleConfirmApply}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-lg transition"
            >
              <Check className="w-3.5 h-3.5" />
              <span>确认应用矫正 ({selectedHunkIds.size} 处)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
