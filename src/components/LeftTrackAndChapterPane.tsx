import React, { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  FileAudio,
  FileJson,
  FolderPlus,
  GripVertical,
  Headphones,
  Layers,
  Library,
  Mic,
  Music,
  PanelLeftClose,
  Pause,
  Pencil,
  Play,
  Plus,
  Quote,
  Radio,
  Sliders,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  Wand2,
} from 'lucide-react';
import {
  AuxAudioSlot,
  BgmTrackAsset,
  HighlightClip,
  HighlightMuteInterval,
  PodcastProjectState,
  SpeakerRole,
} from '../types/podcast';
import { formatMmSs, resolveEffectiveHighlightGapSec } from '../engine/timelineEngine';
import { audioPreview } from '../engine/audioPreviewEngine';
import { reorderItems, resolveTrackDisplayFileName } from '../engine/trackOrder';

interface LeftTrackAndChapterPaneProps {
  state: PodcastProjectState;
  onToggleTrackSolo: (trackId: string) => void;
  onToggleTrackMute: (trackId: string) => void;
  onRenameSpeakerTrack: (trackId: string, newName?: string, newRole?: SpeakerRole) => void;
  onSeekToHighlight: (hl: HighlightClip) => void;
  onRemoveHighlight: (highlightId: string) => void;
  onAiAutoFillHighlights: () => void;
  onCopyQuotes: () => void;
  onOpenImportModal: () => void;
  onImportBgm: (slot: AuxAudioSlot) => void;
  onToggleBgmEnabled: (slot: AuxAudioSlot) => void;
  onRemoveBgm: (slot: AuxAudioSlot) => void;
  onOpenGlobalAuxLibrary?: (slot: AuxAudioSlot) => void;
  onSaveSlotToGlobalLibrary?: (slot: AuxAudioSlot) => void;
  onUpdateState: (updater: (prev: PodcastProjectState) => PodcastProjectState) => void;
  onNotify: (msg: string) => void;
  onCollapsePane?: () => void;
  onOpenHighlightEditModal?: (hl: HighlightClip) => void;
  onOpenIntroEditor?: () => void;
}

export const LeftTrackAndChapterPane: React.FC<LeftTrackAndChapterPaneProps> = React.memo(({
  state,
  onToggleTrackSolo,
  onToggleTrackMute,
  onRenameSpeakerTrack,
  onSeekToHighlight,
  onRemoveHighlight,
  onAiAutoFillHighlights,
  onCopyQuotes,
  onOpenImportModal,
  onImportBgm,
  onToggleBgmEnabled,
  onRemoveBgm,
  onOpenGlobalAuxLibrary,
  onSaveSlotToGlobalLibrary,
  onUpdateState,
  onNotify,
  onCollapsePane,
  onOpenHighlightEditModal,
  onOpenIntroEditor,
}) => {
  const [openSections, setOpenSections] = useState<{
    files: boolean;
    quotes: boolean;
  }>({
    files: true,
    quotes: true,
  });

  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [draftSpeakerName, setDraftSpeakerName] = useState('');
  const [dragTrackIndex, setDragTrackIndex] = useState<number | null>(null);
  const [dragOverTrackIndex, setDragOverTrackIndex] = useState<number | null>(null);
  const [editingHighlightId, setEditingHighlightId] = useState<string | null>(null);
  const [trimStartSec, setTrimStartSec] = useState<number>(0);
  const [trimEndSec, setTrimEndSec] = useState<number>(0);
  const [trimText, setTrimText] = useState<string>('');
  const [trimMutedTrackIds, setTrimMutedTrackIds] = useState<string[]>([]);
  const [trimPartiallyMutedRanges, setTrimPartiallyMutedRanges] = useState<HighlightMuteInterval[]>([]);
  const [newPartialMuteTrackId, setNewPartialMuteTrackId] = useState<string>('');
  const [newPartialMuteOffsetStartSec, setNewPartialMuteOffsetStartSec] = useState<number>(0);
  const [newPartialMuteOffsetEndSec, setNewPartialMuteOffsetEndSec] = useState<number>(1);

  const handleMoveTrack = (fromIndex: number, toIndex: number) => {
    onUpdateState((prev) => {
      const nextTracks = reorderItems(prev.tracks, fromIndex, toIndex);
      if (nextTracks === prev.tracks) return prev;
      return { ...prev, tracks: nextTracks };
    });
  };

  const beginEditSpeakerName = (trackId: string, currentName: string) => {
    setEditingTrackId(trackId);
    setDraftSpeakerName(currentName);
  };

  const commitEditSpeakerName = (trackId: string) => {
    const trimmed = draftSpeakerName.trim();
    if (trimmed) {
      onRenameSpeakerTrack(trackId, trimmed);
    }
    setEditingTrackId(null);
  };

  useEffect(() => {
    return () => {
      audioPreview.stopBgmPreview();
    };
  }, []);

  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const speakerCount = state.tracks.filter((t) => !t.isRef).length;
  const refCount = state.tracks.filter((t) => t.isRef).length;
  const speakerMap = Object.fromEntries(state.tracks.map((t) => [t.id, t]));

  return (
    <aside className="w-full bg-zinc-900/70 p-3 flex flex-col gap-3 overflow-y-auto h-full min-h-0 select-none">
      {/* ==================== 1. 当前导入的文件与音轨 ==================== */}
      <div>
        <div className="flex items-center justify-between gap-1.5 mb-2">
          <button
            onClick={() => toggleSection('files')}
            className="flex items-center gap-1 min-w-0 text-xs font-semibold uppercase tracking-wider text-zinc-300 hover:text-white cursor-pointer"
          >
            {openSections.files ? (
              <ChevronDown className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
            )}
            <span className="truncate">
              导入文件与音轨 ({speakerCount} 独立轨{refCount > 0 ? ` + ${refCount} 参考轨` : ''})
            </span>
          </button>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onOpenImportModal}
              className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[11px] text-blue-300 font-medium flex items-center gap-1 cursor-pointer transition"
            >
              <FolderPlus className="w-3 h-3" />
              <span>导入/管理</span>
            </button>
            {onCollapsePane && (
              <button
                type="button"
                onClick={onCollapsePane}
                title="收起左侧音轨与素材栏（可拖拽右边缘调整宽度）"
                className="p-1 rounded bg-zinc-800/90 hover:bg-zinc-700 border border-zinc-700 text-zinc-400 hover:text-zinc-100 cursor-pointer transition"
              >
                <PanelLeftClose className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {openSections.files && (
          <div className="space-y-2">
            {state.projectFilePath && (
              <div
                title={state.projectFilePath}
                className="px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-between gap-2 text-[11px]"
              >
                <span className="inline-flex items-center gap-1.5 min-w-0 text-amber-200 font-mono truncate">
                  <FileJson className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span className="truncate">
                    {state.projectFilePath.split(/[/\\]/).pop()}
                  </span>
                </span>
                <span className="text-amber-400/90 shrink-0">工程文件</span>
              </div>
            )}

            <div className="flex items-center justify-between px-1 text-[11px] text-zinc-400">
              <span>
                {state.recordingMode === 'same_room_sync'
                  ? '🏠 同屋录制模式'
                  : '🌐 异地多设备校准'}
              </span>
              <span className="text-emerald-400 font-medium">
                {state.recordingMode === 'same_room_sync' ? '✓ 0ms 等长锁定' : '⚡ GCC-PHAT已对齐'}
              </span>
            </div>

            {state.tracks.length === 0 ? (
              <div className="p-3 rounded-lg border border-dashed border-zinc-800 bg-zinc-950/60 text-[11px] text-zinc-500 leading-relaxed text-center">
                暂未导入发言人音轨，点击右上角「导入/管理」选择多轨音频文件
              </div>
            ) : (
              state.tracks.map((tr, trackIdx) => {
                const offsetLabel =
                  state.recordingMode === 'same_room_sync'
                    ? '偏移 0ms'
                    : tr.isRef
                    ? '全局基准时钟'
                    : `校准 ${tr.syncOffsetMs >= 0 ? '+' : ''}${tr.syncOffsetMs}ms`;

                const lufsLabel = tr.isRef
                  ? 'A/B 对照审听轨'
                  : state.loudnessAligned
                  ? `-16.0 LUFS (${tr.autoGainDb >= 0 ? '+' : ''}${tr.autoGainDb.toFixed(1)}dB)`
                  : `${tr.rawLufs.toFixed(1)} LUFS (原始)`;

                const displayFile = resolveTrackDisplayFileName(
                  tr.sourceFilePath || tr.filePath,
                  tr.sourceFileName || tr.name
                );
                const fullPathTooltip = tr.sourceFilePath || tr.filePath || displayFile;
                const canReorder = state.tracks.length > 1 && editingTrackId !== tr.id;
                const isDragOver = dragOverTrackIndex === trackIdx && dragTrackIndex !== trackIdx;

                return (
                  <div
                    key={tr.id}
                    draggable={canReorder}
                    onDragStart={(e) => {
                      if (!canReorder) return;
                      setDragTrackIndex(trackIdx);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', tr.id);
                    }}
                    onDragOver={(e) => {
                      if (dragTrackIndex === null) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (dragOverTrackIndex !== trackIdx) {
                        setDragOverTrackIndex(trackIdx);
                      }
                    }}
                    onDrop={(e) => {
                      if (dragTrackIndex === null) return;
                      e.preventDefault();
                      handleMoveTrack(dragTrackIndex, trackIdx);
                      setDragTrackIndex(null);
                      setDragOverTrackIndex(null);
                    }}
                    onDragEnd={() => {
                      setDragTrackIndex(null);
                      setDragOverTrackIndex(null);
                    }}
                    className={`p-2.5 rounded-lg border transition ${
                      isDragOver
                        ? 'border-blue-400 ring-1 ring-blue-400/50 bg-blue-500/10'
                        : tr.solo
                        ? 'border-amber-500/60 bg-amber-500/10'
                        : tr.muted
                        ? 'border-zinc-800 bg-zinc-900/40 opacity-65'
                        : 'border-zinc-800 bg-zinc-900'
                    } ${dragTrackIndex === trackIdx ? 'opacity-50' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        {state.tracks.length > 1 && (
                          <span
                            title="拖拽调整音轨顺序"
                            className="text-zinc-500 hover:text-zinc-300 cursor-grab active:cursor-grabbing shrink-0"
                          >
                            <GripVertical className="w-3.5 h-3.5" />
                          </span>
                        )}
                        <span
                          className="w-2.5 h-2.5 rounded-full inline-block shrink-0"
                          style={{ backgroundColor: tr.color }}
                        />
                        {editingTrackId === tr.id ? (
                          <div className="flex items-center gap-1 flex-1 min-w-0">
                            <input
                              type="text"
                              value={draftSpeakerName}
                              onChange={(e) => setDraftSpeakerName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  commitEditSpeakerName(tr.id);
                                } else if (e.key === 'Escape') {
                                  e.preventDefault();
                                  setEditingTrackId(null);
                                }
                              }}
                              onBlur={() => commitEditSpeakerName(tr.id)}
                              autoFocus
                              placeholder="主播/嘉宾姓名..."
                              className="w-full min-w-0 px-1.5 py-0.5 rounded border border-blue-500/70 bg-zinc-950 text-xs font-semibold text-zinc-100 focus:outline-none"
                            />
                            <button
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                commitEditSpeakerName(tr.id);
                              }}
                              title="保存嘉宾/主播姓名"
                              className="p-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white shrink-0 cursor-pointer"
                            >
                              <Check className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => beginEditSpeakerName(tr.id, tr.name)}
                              title="点击设置该音轨对应的主播/嘉宾姓名"
                              className="group/name inline-flex items-center gap-1 min-w-0 text-left hover:text-blue-300 cursor-pointer transition"
                            >
                              <span className="text-xs font-semibold text-zinc-100 group-hover/name:text-blue-300 truncate">
                                {tr.name}
                              </span>
                              <Pencil className="w-2.5 h-2.5 text-zinc-500 group-hover/name:text-blue-400 shrink-0" />
                            </button>
                            <select
                              value={tr.role}
                              onChange={(e) =>
                                onRenameSpeakerTrack(
                                  tr.id,
                                  undefined,
                                  e.target.value as SpeakerRole
                                )
                              }
                              title="设置该音轨身份角色（主持人 / 常驻主播 / 飞行嘉宾 / 参考轨）"
                              className="px-1 py-0.5 rounded bg-zinc-950/90 border border-zinc-800 hover:border-zinc-700 text-[10px] text-zinc-300 shrink-0 focus:outline-none cursor-pointer"
                            >
                              <option value="host">主持人</option>
                              <option value="co_host">常驻主播</option>
                              <option value="guest">飞行嘉宾</option>
                              <option value="ref">参考轨</option>
                            </select>
                          </>
                        )}
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {state.tracks.length > 1 && (
                          <>
                            <button
                              type="button"
                              disabled={trackIdx === 0}
                              onClick={() => handleMoveTrack(trackIdx, trackIdx - 1)}
                              title="上移音轨"
                              className="p-0.5 rounded bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              disabled={trackIdx === state.tracks.length - 1}
                              onClick={() => handleMoveTrack(trackIdx, trackIdx + 1)}
                              title="下移音轨"
                              className="p-0.5 rounded bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => onToggleTrackSolo(tr.id)}
                          title="单轨独奏检听 (Solo)"
                          className={`px-1.5 py-0.5 rounded text-xs font-mono font-bold cursor-pointer ${
                            tr.solo
                              ? 'bg-amber-500 text-zinc-950'
                              : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          S
                        </button>
                        <button
                          onClick={() => onToggleTrackMute(tr.id)}
                          title="静音该轨道 (Mute)"
                          className={`px-1.5 py-0.5 rounded text-xs font-mono font-bold cursor-pointer ${
                            tr.muted
                              ? 'bg-red-500/80 text-white'
                              : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          {tr.muted ? <VolumeX className="w-3 h-3 inline" /> : 'M'}
                        </button>
                      </div>
                    </div>

                    {/* 当前导入的源音频文件名与时长 */}
                    <div
                      title={fullPathTooltip}
                      className="mt-1.5 px-2 py-1 rounded bg-zinc-950/80 border border-zinc-800/80 flex items-center justify-between gap-2 text-[11px]"
                    >
                      <span className="inline-flex items-center gap-1.5 min-w-0 text-zinc-300 font-mono truncate">
                        <FileAudio className="w-3 h-3 text-blue-400 shrink-0" />
                        <span className="truncate">{displayFile}</span>
                      </span>
                      {tr.durationMs ? (
                        <span className="font-mono text-zinc-500 shrink-0">
                          {formatMmSs(tr.durationMs / 1000)}
                        </span>
                      ) : null}
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-zinc-400 mt-1.5">
                      <span>{offsetLabel}</span>
                      <span
                        className={
                          state.loudnessAligned && !tr.isRef ? 'text-blue-400 font-medium' : ''
                        }
                      >
                        {tr.isRef ? (
                          <span className="inline-flex items-center gap-1">
                            <Headphones className="w-3 h-3" /> {lufsLabel}
                          </span>
                        ) : (
                          lufsLabel
                        )}
                      </span>
                    </div>
                  </div>
                );
              })
            )}

          </div>
        )}
      </div>


      {/* ==================== 2. 高光片头与金句列表 ==================== */}
      <div className="border-t border-zinc-800 pt-3 flex-1 flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => toggleSection('quotes')}
            className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-zinc-300 hover:text-white cursor-pointer"
          >
            {openSections.quotes ? (
              <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
            )}
            <span>高光片头与金句 ({state.highlights.length})</span>
          </button>

          <div className="flex items-center gap-1.5">
            <button
              onClick={onAiAutoFillHighlights}
              disabled={state.blocks.length === 0}
              title="按声学能量与时长约束自动提炼高光金句"
              className="px-2 py-0.5 rounded bg-purple-500/15 hover:bg-purple-500/25 disabled:opacity-40 border border-purple-500/30 text-[11px] text-purple-300 font-medium flex items-center gap-1 cursor-pointer disabled:cursor-default transition"
            >
              <Sparkles className="w-3 h-3" />
              <span>AI提炼</span>
            </button>
            {state.highlights.length > 0 && (
              <button
                onClick={onCopyQuotes}
                title="复制全部金句文本"
                className="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-0.5 font-medium cursor-pointer"
              >
                <Copy className="w-3 h-3" />
                <span>复制</span>
              </button>
            )}
          </div>
        </div>

        {openSections.quotes && (() => {
          const pureVoiceSec = state.highlights.reduce((acc, c) => acc + c.durationSec, 0);
          const effectiveGapSec = resolveEffectiveHighlightGapSec(state);
          const gapsCount = Math.max(0, state.highlights.length - 1);
          const totalGapsSec = gapsCount * effectiveGapSec;
          const highlightSectionTotalSec = pureVoiceSec + totalGapsSec;
          const targetTotalSec = state.targetTotalHighlightSec || 30;
          const introVoSec = state.introVoiceover?.enabled ? (state.introVoiceover.durationSec || 5) : 0;
          const highlightPct = Math.min(100, (highlightSectionTotalSec / Math.max(1, targetTotalSec)) * 100);

          return (
            <div className="space-y-3">
              {/* 片头结构配置与全局挂载 */}
              <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-950/85 space-y-2.5 text-[11px]">
                <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 pb-2">
                  <div className="flex items-center gap-1.5 font-semibold text-zinc-100">
                    <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                    <span>片头高光与金句编排</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {onOpenIntroEditor && (
                      <button
                        type="button"
                        onClick={onOpenIntroEditor}
                        className="px-2 py-0.5 rounded bg-purple-600/20 hover:bg-purple-600/35 border border-purple-500/40 text-purple-200 text-[10px] font-semibold cursor-pointer"
                      >
                        片头编辑器
                      </button>
                    )}
                    <label className="flex items-center gap-1.5 text-zinc-300 font-medium cursor-pointer hover:text-white transition">
                    <input
                      type="checkbox"
                      checked={state.coldOpenEnabled}
                      onChange={(e) =>
                        onUpdateState((p) => ({ ...p, coldOpenEnabled: e.target.checked }))
                      }
                      className="rounded accent-purple-500"
                    />
                      <span>挂载至片头 (00:00)</span>
                    </label>
                  </div>
                </div>

                {/* 片头时间线结构时序示意 */}
                {(() => {
                  const coldDuration = state.coldOpenEnabled ? (2.0 + highlightSectionTotalSec + 2.0) : 0;
                  const voStart = state.introVoiceover?.enabled
                    ? (typeof state.introVoiceover.startOffsetSec === 'number' ? state.introVoiceover.startOffsetSec : coldDuration)
                    : coldDuration;
                  const totalIntroSec = Math.max(coldDuration, voStart + introVoSec);
                  return (
                    <div className="p-2 rounded bg-zinc-900/90 border border-zinc-800/80 space-y-1.5">
                      <div className="text-[10px] text-zinc-400 font-medium flex items-center justify-between">
                        <span>片头时序结构</span>
                        <span className="font-mono text-purple-300">
                          总片头: {totalIntroSec.toFixed(1)}s
                        </span>
                      </div>
                      <div className="flex items-center gap-1 overflow-x-auto text-[10px] pb-0.5">
                        <span className="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30 whitespace-nowrap shrink-0">
                          ① BGM前导 2.0s
                        </span>
                        <span className="text-zinc-600">→</span>
                        <span className="px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-200 border border-purple-500/35 font-semibold whitespace-nowrap shrink-0">
                          ② 金句整段闪避 {highlightSectionTotalSec.toFixed(1)}s
                        </span>
                        <span className="text-zinc-600">→</span>
                        <span className={`px-1.5 py-0.5 rounded border whitespace-nowrap shrink-0 ${
                          state.introVoiceover?.enabled
                            ? 'bg-amber-500/20 text-amber-300 border-amber-500/35 font-semibold'
                            : 'bg-zinc-800/60 text-zinc-500 border-zinc-700/50'
                        }`}>
                          ③ 固定口播 ({state.introVoiceover?.enabled ? `@${voStart.toFixed(1)}s` : '未开启'})
                        </span>
                        <span className="text-zinc-600">→</span>
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 whitespace-nowrap shrink-0">
                          ④ 正片多轨
                        </span>
                      </div>
                      <div className="text-[10px] text-purple-300/80 bg-purple-950/30 px-1.5 py-0.5 rounded flex items-center gap-1">
                        <Sparkles className="w-2.5 h-2.5 text-purple-400 shrink-0" />
                        <span>金句整段闪避：金句区间全程稳压 BGM，不因句间呼吸或停顿回弹抽吸</span>
                      </div>
                    </div>
                  );
                })()}

                {/* 1. 金句部分总时长设置 */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-zinc-300 font-medium">金句部分总时长 (目标)</span>
                    <span className="font-mono text-zinc-400">
                      人声 <span className="text-purple-300 font-semibold">{pureVoiceSec.toFixed(1)}s</span> + 间隔 <span className="text-blue-300 font-semibold">{totalGapsSec.toFixed(1)}s</span> = <span className="text-zinc-100 font-bold">{highlightSectionTotalSec.toFixed(1)}s</span> / {targetTotalSec}s
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {[15, 30, 45, 60].map((presetSec) => (
                      <button
                        key={presetSec}
                        type="button"
                        onClick={() =>
                          onUpdateState((p) => ({ ...p, targetTotalHighlightSec: presetSec }))
                        }
                        className={`flex-1 py-1 rounded text-[10px] font-mono font-medium border transition cursor-pointer ${
                          targetTotalSec === presetSec
                            ? 'bg-purple-600/30 text-purple-200 border-purple-500/60'
                            : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:border-zinc-700 hover:text-zinc-200'
                        }`}
                      >
                        {presetSec}s
                      </button>
                    ))}
                    <div className="w-20 shrink-0">
                      <input
                        type="number"
                        value={targetTotalSec}
                        min={10}
                        max={180}
                        onChange={(e) =>
                          onUpdateState((p) => ({
                            ...p,
                            targetTotalHighlightSec: Number(e.target.value) || 30,
                          }))
                        }
                        className="w-full px-2 py-0.5 rounded border border-zinc-700 bg-zinc-900 text-zinc-100 font-mono text-[11px] text-center"
                        title="自定义金句部分总时长（秒）"
                      />
                    </div>
                  </div>

                  <div className="w-full h-1.5 rounded-full bg-zinc-800/80 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${
                        highlightSectionTotalSec > targetTotalSec * 1.15
                          ? 'bg-amber-500'
                          : highlightSectionTotalSec >= targetTotalSec * 0.85
                          ? 'bg-emerald-500'
                          : 'bg-blue-500'
                      }`}
                      style={{ width: `${highlightPct}%` }}
                    />
                  </div>
                </div>

                {/* 2. 单句金句时长范围设置 (默认 8s-20s，支持自行设置) */}
                <div className="space-y-1.5 p-2 rounded bg-zinc-900/60 border border-zinc-800/80">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-zinc-300 font-medium">单句金句时长范围</span>
                    <span className="font-mono text-purple-300 font-semibold text-[10px]">
                      {state.minClipSec ?? 8}s ~ {state.maxClipSec ?? 20}s (当前)
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {[
                      { label: '8s~20s (推荐)', min: 8, max: 20 },
                      { label: '5s~15s (短篇)', min: 5, max: 15 },
                      { label: '10s~30s (展开)', min: 10, max: 30 },
                    ].map((preset) => {
                      const isActive =
                        (state.minClipSec ?? 8) === preset.min &&
                        (state.maxClipSec ?? 20) === preset.max;
                      return (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() =>
                            onUpdateState((p) => ({
                              ...p,
                              minClipSec: preset.min,
                              maxClipSec: preset.max,
                            }))
                          }
                          className={`flex-1 py-1 rounded text-[10px] font-medium border transition cursor-pointer ${
                            isActive
                              ? 'bg-purple-600/30 text-purple-200 border-purple-500/60 font-semibold'
                              : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:border-zinc-700 hover:text-zinc-200'
                          }`}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>

                  {/* 自定义数值调整 */}
                  <div className="flex items-center justify-between text-[10px] text-zinc-400 pt-0.5">
                    <span>自定义范围:</span>
                    <div className="flex items-center gap-1.5">
                      <div className="flex items-center gap-1">
                        <span>最少</span>
                        <input
                          type="number"
                          value={state.minClipSec ?? 8}
                          min={2}
                          max={Math.max(3, (state.maxClipSec ?? 20) - 1)}
                          onChange={(e) =>
                            onUpdateState((p) => ({
                              ...p,
                              minClipSec: Math.max(1, Number(e.target.value) || 8),
                            }))
                          }
                          className="w-12 px-1 py-0.5 rounded border border-zinc-700 bg-zinc-900 text-zinc-100 font-mono text-[11px] text-center"
                          title="单句最小时长（秒）"
                        />
                        <span>s</span>
                      </div>
                      <span>~</span>
                      <div className="flex items-center gap-1">
                        <span>最多</span>
                        <input
                          type="number"
                          value={state.maxClipSec ?? 20}
                          min={(state.minClipSec ?? 8) + 1}
                          max={60}
                          onChange={(e) =>
                            onUpdateState((p) => ({
                              ...p,
                              maxClipSec: Math.max((p.minClipSec ?? 8) + 1, Number(e.target.value) || 20),
                            }))
                          }
                          className="w-12 px-1 py-0.5 rounded border border-zinc-700 bg-zinc-900 text-zinc-100 font-mono text-[11px] text-center"
                          title="单句最大时长（秒）"
                        />
                        <span>s</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 3. 自动设置金句间的间隔 */}
                <div className="p-2 rounded bg-zinc-900/60 border border-zinc-800/80 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1.5 text-zinc-200 font-medium cursor-pointer">
                      <input
                        type="checkbox"
                        checked={state.autoHighlightGap !== false}
                        onChange={(e) =>
                          onUpdateState((p) => ({ ...p, autoHighlightGap: e.target.checked }))
                        }
                        className="rounded accent-purple-500"
                      />
                      <span>自动均分金句间间隔</span>
                    </label>
                    <span className="font-mono text-[10px] text-purple-300 bg-purple-500/10 px-1.5 py-0.5 rounded border border-purple-500/25">
                      {state.autoHighlightGap !== false
                        ? `自动均分: ${effectiveGapSec.toFixed(2)}s/处`
                        : `固定间隔: ${(state.highlightGapSec ?? 0.8).toFixed(1)}s`}
                    </span>
                  </div>

                  {state.autoHighlightGap !== false ? (
                    <p className="text-[10px] text-zinc-500 leading-tight">
                      系统已根据目标总长 {targetTotalSec}s 与金句人声实际时长 ({pureVoiceSec.toFixed(1)}s)，自动平衡计算每两句间的呼吸停顿与转场垫音（共 {gapsCount} 处）。
                    </p>
                  ) : (
                    <div className="flex items-center gap-2 pt-1">
                      <input
                        type="range"
                        min={0.3}
                        max={2.5}
                        step={0.1}
                        value={state.highlightGapSec ?? 0.8}
                        onChange={(e) =>
                          onUpdateState((p) => ({
                            ...p,
                            highlightGapSec: Number(e.target.value),
                          }))
                        }
                        className="flex-1 accent-purple-500"
                      />
                      <span className="font-mono text-zinc-300 text-[10px] w-12 text-right">
                        {(state.highlightGapSec ?? 0.8).toFixed(1)}s
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* 金句序列列表（精确记录起止时间段） */}
              {state.highlights.length === 0 ? (
                <div className="p-3.5 rounded-lg border border-dashed border-zinc-800 text-xs text-zinc-500 text-center leading-relaxed bg-zinc-950/40">
                  当前尚无金句。可在文稿选中文字点击「加入金句」、在波形框选高光，或点击上方「AI提炼」提取本期爆点金句！
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] px-1 text-zinc-400">
                    <span>已选金句序列 ({state.highlights.length} 条)</span>
                    <span className="text-[10px]">点击条目试听定位</span>
                  </div>

                  {state.highlights.map((hl, idx) => {
                    const spColor = speakerMap[hl.speakerId]?.color ?? '#a855f7';
                    const spDisplayName = speakerMap[hl.speakerId]?.name ?? hl.speakerName;
                    const isEditing = editingHighlightId === hl.id;
                    const startFormatted = formatMmSs(hl.sourceStartMs / 1000);
                    const endFormatted = formatMmSs(hl.sourceEndMs / 1000);

                    return (
                      <div
                        key={hl.id}
                        className="group p-2.5 rounded-lg border border-zinc-800 bg-zinc-900/90 hover:border-purple-500/50 hover:bg-zinc-850 transition space-y-1.5"
                      >
                        <div className="flex items-center justify-between gap-1.5 text-[11px]">
                          <div
                            onClick={() => onSeekToHighlight(hl)}
                            title="点击定位试听该条金句"
                            className="flex items-center gap-1.5 min-w-0 cursor-pointer"
                          >
                            <Quote className="w-3 h-3 text-purple-400 shrink-0" />
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: spColor }}
                            />
                            <span className="font-semibold text-zinc-100 truncate">
                              {spDisplayName}
                            </span>
                            <span
                              className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-purple-500/15 text-purple-300 font-semibold shrink-0"
                              title="金句起止时间段"
                            >
                              {startFormatted} ~ {endFormatted} ({hl.durationSec.toFixed(1)}s)
                            </span>
                          </div>

                          <div className="flex items-center gap-0.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => {
                                if (onOpenHighlightEditModal) {
                                  onOpenHighlightEditModal(hl);
                                  return;
                                }
                                if (isEditing) {
                                  setEditingHighlightId(null);
                                } else {
                                  setEditingHighlightId(hl.id);
                                  setTrimStartSec(Number((hl.sourceStartMs / 1000).toFixed(2)));
                                  setTrimEndSec(Number((hl.sourceEndMs / 1000).toFixed(2)));
                                  setTrimText(hl.text);
                                  setTrimMutedTrackIds(hl.mutedTrackIds ? [...hl.mutedTrackIds] : []);
                                  setTrimPartiallyMutedRanges(hl.partiallyMutedRanges ? [...hl.partiallyMutedRanges] : []);
                                  setNewPartialMuteTrackId(state.tracks.length > 0 ? state.tracks[0].id : '');
                                  setNewPartialMuteOffsetStartSec(0);
                                  setNewPartialMuteOffsetEndSec(Math.min(1.0, Number(hl.durationSec.toFixed(2))));
                                }
                              }}
                              title="点开波形弹窗，拖动各个音轨编辑"
                              className={`p-1 rounded text-xs transition cursor-pointer ${
                                isEditing
                                  ? 'text-purple-300 bg-purple-600/30'
                                  : 'text-purple-400 hover:text-purple-200 hover:bg-purple-500/20'
                              }`}
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onUpdateState((p) => {
                                  if (idx === 0) return p;
                                  const next = [...p.highlights];
                                  [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                                  return { ...p, highlights: next };
                                });
                              }}
                              title="上移顺序"
                              className="p-1 text-zinc-500 hover:text-zinc-200 transition cursor-pointer"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onUpdateState((p) => {
                                  if (idx >= p.highlights.length - 1) return p;
                                  const next = [...p.highlights];
                                  [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                                  return { ...p, highlights: next };
                                });
                              }}
                              title="下移顺序"
                              className="p-1 text-zinc-500 hover:text-zinc-200 transition cursor-pointer"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onRemoveHighlight(hl.id);
                              }}
                              title="从金句列表移除"
                              className="p-1 text-zinc-500 hover:text-red-400 transition cursor-pointer"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>

                        {/* 金句台词文本 */}
                        <p
                          onClick={() => onSeekToHighlight(hl)}
                          className="text-xs text-zinc-200 leading-snug line-clamp-2 select-text cursor-pointer hover:text-purple-200"
                        >
                          “{hl.text}”
                        </p>

                        {/* 起止时间段微调与音轨部分静音二次编辑展开卡片 */}
                        {isEditing && (
                          <div className="p-2.5 rounded bg-zinc-950 border border-purple-500/40 space-y-2.5 mt-1">
                            <div className="text-[10px] text-zinc-400 flex items-center justify-between border-b border-zinc-800/80 pb-1.5">
                              <span className="font-semibold text-purple-300 flex items-center gap-1">
                                <Sparkles className="w-3 h-3 text-purple-400" />
                                <span>金句二次编辑与起止点微调</span>
                              </span>
                              <span className="font-mono text-zinc-400">
                                当前时长: <strong className="text-zinc-100">{Math.max(0.1, Number((trimEndSec - trimStartSec).toFixed(2)))}s</strong>
                              </span>
                            </div>

                            {/* 台词文本微调 */}
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-400 block font-medium">金句台词 (可编辑修正)</label>
                              <textarea
                                value={trimText}
                                onChange={(e) => setTrimText(e.target.value)}
                                rows={2}
                                className="w-full px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-zinc-100 text-[11px] focus:outline-none focus:border-purple-500 leading-snug resize-none"
                                placeholder="输入或微调金句台词"
                              />
                            </div>

                            {/* 起止时间点精确微调 (带步进按钮) */}
                            <div className="space-y-2">
                              {/* 开始时间 */}
                              <div className="space-y-1">
                                <div className="flex items-center justify-between text-[10px]">
                                  <label className="text-zinc-400 font-medium">开始时间点 (s)</label>
                                  <span className="font-mono text-purple-300 font-semibold">{formatMmSs(trimStartSec)}</span>
                                </div>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => setTrimStartSec((p) => Number(Math.max(0, p - 0.5).toFixed(2)))}
                                    className="px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-400 border border-zinc-800 cursor-pointer"
                                    title="提前 0.5 秒"
                                  >
                                    -0.5s
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setTrimStartSec((p) => Number(Math.max(0, p - 0.1).toFixed(2)))}
                                    className="px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-400 border border-zinc-800 cursor-pointer"
                                    title="提前 0.1 秒"
                                  >
                                    -0.1s
                                  </button>
                                  <input
                                    type="number"
                                    step="0.1"
                                    value={trimStartSec}
                                    onChange={(e) => setTrimStartSec(Number(e.target.value))}
                                    className="flex-1 px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-900 text-zinc-100 font-mono text-[11px] text-center"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => setTrimStartSec((p) => Number((p + 0.1).toFixed(2)))}
                                    className="px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-400 border border-zinc-800 cursor-pointer"
                                    title="延后 0.1 秒"
                                  >
                                    +0.1s
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setTrimStartSec((p) => Number((p + 0.5).toFixed(2)))}
                                    className="px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-400 border border-zinc-800 cursor-pointer"
                                    title="延后 0.5 秒"
                                  >
                                    +0.5s
                                  </button>
                                </div>
                              </div>

                              {/* 结束时间 */}
                              <div className="space-y-1">
                                <div className="flex items-center justify-between text-[10px]">
                                  <label className="text-zinc-400 font-medium">结束时间点 (s)</label>
                                  <span className="font-mono text-purple-300 font-semibold">{formatMmSs(trimEndSec)}</span>
                                </div>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => setTrimEndSec((p) => Number(Math.max(0, p - 0.5).toFixed(2)))}
                                    className="px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-400 border border-zinc-800 cursor-pointer"
                                    title="提前 0.5 秒"
                                  >
                                    -0.5s
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setTrimEndSec((p) => Number(Math.max(0, p - 0.1).toFixed(2)))}
                                    className="px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-400 border border-zinc-800 cursor-pointer"
                                    title="提前 0.1 秒"
                                  >
                                    -0.1s
                                  </button>
                                  <input
                                    type="number"
                                    step="0.1"
                                    value={trimEndSec}
                                    onChange={(e) => setTrimEndSec(Number(e.target.value))}
                                    className="flex-1 px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-900 text-zinc-100 font-mono text-[11px] text-center"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => setTrimEndSec((p) => Number((p + 0.1).toFixed(2)))}
                                    className="px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-400 border border-zinc-800 cursor-pointer"
                                    title="延后 0.1 秒"
                                  >
                                    +0.1s
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setTrimEndSec((p) => Number((p + 0.5).toFixed(2)))}
                                    className="px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-400 border border-zinc-800 cursor-pointer"
                                    title="延后 0.5 秒"
                                  >
                                    +0.5s
                                  </button>
                                </div>
                              </div>
                            </div>

                            {/* 对某音轨做整句消音与部分静音处理 */}
                            <div className="p-2 rounded bg-zinc-900/90 border border-zinc-800 space-y-2">
                              <div className="flex items-center justify-between text-[10px]">
                                <span className="font-semibold text-zinc-200 flex items-center gap-1">
                                  <VolumeX className="w-3 h-3 text-amber-400" />
                                  <span>音轨静音与部分静音处理</span>
                                </span>
                                <span className="text-zinc-500">消除该段抢话/杂音/呼吸</span>
                              </div>

                              {/* 音轨状态列表 */}
                              <div className="space-y-1">
                                {state.tracks.map((tr) => {
                                  const isMuted = trimMutedTrackIds.includes(tr.id);
                                  const partials = trimPartiallyMutedRanges.filter((m) => m.trackId === tr.id);
                                  return (
                                    <div
                                      key={tr.id}
                                      className={`p-1.5 rounded border text-[11px] space-y-1 transition ${
                                        isMuted
                                          ? 'bg-red-950/20 border-red-500/30'
                                          : 'bg-zinc-950 border-zinc-800/80'
                                      }`}
                                    >
                                      <div className="flex items-center justify-between gap-1.5">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                          <span
                                            className="w-2 h-2 rounded-full shrink-0"
                                            style={{ backgroundColor: tr.color }}
                                          />
                                          <span className="font-medium text-zinc-200 truncate">
                                            {tr.name}
                                          </span>
                                        </div>
                                        <label className="flex items-center gap-1 text-[10px] text-zinc-400 hover:text-white cursor-pointer shrink-0">
                                          <input
                                            type="checkbox"
                                            checked={isMuted}
                                            onChange={(e) => {
                                              if (e.target.checked) {
                                                setTrimMutedTrackIds((prev) => [...prev, tr.id]);
                                              } else {
                                                setTrimMutedTrackIds((prev) =>
                                                  prev.filter((id) => id !== tr.id)
                                                );
                                              }
                                            }}
                                            className="rounded accent-red-500"
                                          />
                                          <span className={isMuted ? 'text-red-300 font-semibold' : ''}>
                                            {isMuted ? '整句静音' : '整句静音'}
                                          </span>
                                        </label>
                                      </div>

                                      {/* 展示该轨已有的部分静音片段 */}
                                      {partials.length > 0 && (
                                        <div className="flex flex-wrap gap-1 pt-0.5">
                                          {partials.map((pm) => {
                                            const relStart = Math.max(
                                              0,
                                              Number(((pm.sourceStartMs - hl.sourceStartMs) / 1000).toFixed(1))
                                            );
                                            const relEnd = Math.max(
                                              relStart + 0.1,
                                              Number(((pm.sourceEndMs - hl.sourceStartMs) / 1000).toFixed(1))
                                            );
                                            return (
                                              <span
                                                key={pm.id}
                                                className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-amber-500/15 border border-amber-500/30 text-[9px] text-amber-300 font-mono"
                                              >
                                                <span>+{relStart}s ~ +{relEnd}s 静音</span>
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    setTrimPartiallyMutedRanges((prev) =>
                                                      prev.filter((m) => m.id !== pm.id)
                                                    )
                                                  }
                                                  className="hover:text-red-300 cursor-pointer ml-0.5"
                                                  title="移除该静音片段"
                                                >
                                                  ×
                                                </button>
                                              </span>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>

                              {/* 添加部分静音片段小工具 */}
                              <div className="p-1.5 rounded bg-zinc-950/60 border border-zinc-800/80 space-y-1.5">
                                <div className="text-[10px] text-zinc-400 font-medium flex items-center justify-between">
                                  <span>+ 添加音轨部分时间段静音</span>
                                  <span className="text-[9px] text-zinc-500 font-mono">相对金句开头 (0s)</span>
                                </div>
                                <div className="flex items-center gap-1 text-[10px]">
                                  <select
                                    value={newPartialMuteTrackId || (state.tracks[0]?.id ?? '')}
                                    onChange={(e) => setNewPartialMuteTrackId(e.target.value)}
                                    className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-200 text-[10px] flex-1 min-w-0"
                                  >
                                    {state.tracks.map((t) => (
                                      <option key={t.id} value={t.id}>
                                        {t.name}
                                      </option>
                                    ))}
                                  </select>
                                  <span className="text-zinc-500">+</span>
                                  <input
                                    type="number"
                                    step="0.1"
                                    min={0}
                                    max={Math.max(0.1, Number((trimEndSec - trimStartSec).toFixed(1)))}
                                    value={newPartialMuteOffsetStartSec}
                                    onChange={(e) => setNewPartialMuteOffsetStartSec(Number(e.target.value))}
                                    className="w-12 px-1 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-[10px] text-center"
                                    title="片段相对开始秒数"
                                  />
                                  <span className="text-zinc-500">~</span>
                                  <input
                                    type="number"
                                    step="0.1"
                                    min={0.1}
                                    max={Math.max(0.1, Number((trimEndSec - trimStartSec).toFixed(1)))}
                                    value={newPartialMuteOffsetEndSec}
                                    onChange={(e) => setNewPartialMuteOffsetEndSec(Number(e.target.value))}
                                    className="w-12 px-1 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-[10px] text-center"
                                    title="片段相对结束秒数"
                                  />
                                  <span className="text-zinc-500">s</span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const tid = newPartialMuteTrackId || (state.tracks[0]?.id ?? '');
                                      if (!tid) return;
                                      if (newPartialMuteOffsetEndSec <= newPartialMuteOffsetStartSec) {
                                        onNotify('静音结束时间必须大于开始时间');
                                        return;
                                      }
                                      const startMs = Math.round((trimStartSec + newPartialMuteOffsetStartSec) * 1000);
                                      const endMs = Math.round((trimStartSec + newPartialMuteOffsetEndSec) * 1000);
                                      const newInterval: HighlightMuteInterval = {
                                        id: `pm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                                        trackId: tid,
                                        sourceStartMs: startMs,
                                        sourceEndMs: endMs,
                                      };
                                      setTrimPartiallyMutedRanges((prev) => [...prev, newInterval]);
                                      onNotify(`✓ 已为音轨添加静音区间: +${newPartialMuteOffsetStartSec}s ~ +${newPartialMuteOffsetEndSec}s`);
                                    }}
                                    className="px-2 py-0.5 rounded bg-amber-600/30 hover:bg-amber-600/40 text-amber-200 border border-amber-500/40 text-[10px] font-medium cursor-pointer shrink-0"
                                  >
                                    添加
                                  </button>
                                </div>
                              </div>
                            </div>

                            {/* 底部操作条：试听当前选区、取消、保存调整 */}
                            <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-zinc-800/80">
                              <button
                                type="button"
                                onClick={() => {
                                  const previewHl: HighlightClip = {
                                    ...hl,
                                    text: trimText,
                                    sourceStartMs: Math.round(trimStartSec * 1000),
                                    sourceEndMs: Math.round(trimEndSec * 1000),
                                    durationSec: Number((trimEndSec - trimStartSec).toFixed(2)),
                                    mutedTrackIds: trimMutedTrackIds,
                                    partiallyMutedRanges: trimPartiallyMutedRanges,
                                  };
                                  onSeekToHighlight(previewHl);
                                }}
                                className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-purple-300 text-[10px] flex items-center gap-1 cursor-pointer font-medium"
                              >
                                <Play className="w-3 h-3 text-purple-400" />
                                <span>试听调整片段</span>
                              </button>

                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setEditingHighlightId(null)}
                                  className="px-2 py-1 text-[10px] rounded text-zinc-400 hover:text-zinc-200 cursor-pointer"
                                >
                                  取消
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (trimEndSec <= trimStartSec + 0.1) {
                                      onNotify('结束时间必须大于开始时间');
                                      return;
                                    }
                                    onUpdateState((p) => {
                                      const next = p.highlights.map((item) => {
                                        if (item.id !== hl.id) return item;
                                        return {
                                          ...item,
                                          text: trimText.trim() || item.text,
                                          sourceStartMs: Math.round(trimStartSec * 1000),
                                          sourceEndMs: Math.round(trimEndSec * 1000),
                                          durationSec: Number((trimEndSec - trimStartSec).toFixed(2)),
                                          mutedTrackIds: trimMutedTrackIds,
                                          partiallyMutedRanges: trimPartiallyMutedRanges,
                                        };
                                      });
                                      return { ...p, highlights: next };
                                    });
                                    setEditingHighlightId(null);
                                    onNotify(`✓ 已更新金句起止点及音轨消音设置 (${trimStartSec}s ~ ${trimEndSec}s)`);
                                  }}
                                  className="px-2.5 py-1 text-[10px] rounded bg-purple-600 hover:bg-purple-500 text-white font-medium cursor-pointer"
                                >
                                  保存调整
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </aside>
  );
});
