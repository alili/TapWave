import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Download,
  Droplets,
  Edit2,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  Gauge,
  History,
  Home,
  Keyboard,
  Library,
  LocateFixed,
  Music,
  PanelLeft,
  PanelRight,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Save,
  Settings2,
  Sliders,
  Sparkles,
  Volume2,
} from 'lucide-react';
import { AuxAudioSlot, PodcastProjectState } from '../types/podcast';
import { AuxBgmConfigMenu } from './AuxBgmConfigMenu';
import { RecentProjectItem, formatRecentTime } from '../engine/recentProjects';

export const PLAYBACK_RATES = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0] as const;

function formatClockTime(timestampMs: number): string {
  const d = new Date(timestampMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface TopStudioBarProps {
  state: PodcastProjectState;
  isDirty: boolean;
  savedDurationSec: number;
  isPlaying: boolean;
  autoSaveEnabled?: boolean;
  autoSaveIntervalSec?: number;
  lastAutoSavedAt?: number | null;
  onToggleAutoSave?: () => void;
  onChangeAutoSaveInterval?: (sec: number) => void;
  onRenameProjectTitle: (newTitle: string) => void;
  onNewEmptyProject: () => void;
  onOpenProjectFile: () => void;
  recentProjects?: RecentProjectItem[];
  onOpenRecentProject?: (filePath: string) => void;
  onClearRecentProjects?: () => void;
  onSaveProjectFile: (saveAs?: boolean) => void;
  onRegisterFileAssociation?: () => void;
  onSetWorkspaceLayout: (mode: 'multitrack' | 'transcript') => void;
  onToggleRecordingMode: () => void;
  onCycleAutoSolo: () => void;
  onToggleLoudness: () => void;
  onCycleDeClick: () => void;
  onToggleStripSilence: () => void;
  onToggleCutPrerollEnabled?: () => void;
  onTogglePauseCutJumpEnabled?: () => void;
  onChangeCutPrerollSec?: (sec: number) => void;
  onTogglePlay: () => void;
  onChangePlaybackRate: (rate: number) => void;
  onOpenImportModal: () => void;
  onQuickExportAudio: () => void;
  onOpenShownotes?: () => void;
  leftPaneCollapsed?: boolean;
  rightPaneCollapsed?: boolean;
  onToggleLeftPane?: () => void;
  onToggleRightPane?: () => void;
  onOpenShortcuts?: () => void;
  onOpenGlobalAuxLibrary?: (slot?: AuxAudioSlot) => void;
  onOpenIntroEditor?: () => void;
  onOpenDepGuide?: () => void;
  onImportBgm?: (slot: AuxAudioSlot) => void;
  onToggleBgmEnabled?: (slot: AuxAudioSlot) => void;
  onRemoveBgm?: (slot: AuxAudioSlot) => void;
  onSaveSlotToGlobalLibrary?: (slot: AuxAudioSlot) => void;
  onUpdateState?: (updater: (prev: PodcastProjectState) => PodcastProjectState) => void;
  onNotify?: (msg: string) => void;
}

export const TopStudioBar: React.FC<TopStudioBarProps> = React.memo(({
  state,
  isDirty,
  savedDurationSec,
  isPlaying,
  autoSaveEnabled = true,
  autoSaveIntervalSec = 60,
  lastAutoSavedAt = null,
  onToggleAutoSave,
  onChangeAutoSaveInterval,
  onRenameProjectTitle,
  onNewEmptyProject,
  onOpenProjectFile,
  recentProjects = [],
  onOpenRecentProject,
  onClearRecentProjects,
  onSaveProjectFile,
  onRegisterFileAssociation,
  onSetWorkspaceLayout,
  onToggleRecordingMode,
  onCycleAutoSolo,
  onToggleLoudness,
  onCycleDeClick,
  onToggleStripSilence,
  onToggleCutPrerollEnabled,
  onTogglePauseCutJumpEnabled,
  onChangeCutPrerollSec,
  onTogglePlay,
  onChangePlaybackRate,
  onOpenImportModal,
  onQuickExportAudio,
  onOpenShownotes,
  leftPaneCollapsed = false,
  rightPaneCollapsed = false,
  onToggleLeftPane,
  onToggleRightPane,
  onOpenShortcuts,
  onOpenGlobalAuxLibrary,
  onOpenIntroEditor,
  onOpenDepGuide,
  onImportBgm,
  onToggleBgmEnabled,
  onRemoveBgm,
  onSaveSlotToGlobalLibrary,
  onUpdateState,
  onNotify,
}) => {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(state.projectTitle);
  const [openMenu, setOpenMenu] = useState<'file' | 'edit' | 'view' | 'settings' | 'aux_bgm' | null>(null);
  const menuBarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu]);

  const hasContent = state.tracks.length > 0;
  const layoutMode = state.workspaceLayout ?? 'multitrack';

  const soloLabel =
    state.autoSoloMode === 'natural_ducking'
      ? `非主讲抑回声降噪 (${state.duckAttenuationDb}dB)`
      : state.autoSoloMode === 'hard_mute'
      ? '非主讲: 强力抑制'
      : '抑回声降噪: 关';

  const commitTitle = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== state.projectTitle) {
      onRenameProjectTitle(trimmed);
    }
    setEditingTitle(false);
  };

  return (
    <header
      data-tauri-drag-region
      className="shrink-0 flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-zinc-900/95 border-b border-zinc-800 select-none"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <img src="/icon.svg" alt="点波 TapWave" className="w-4 h-4 rounded shrink-0 shadow-sm" />

          {/* 桌面应用菜单栏：文件 (File) | 编辑 (Edit) | 视图 (View) */}
          <nav ref={menuBarRef} className="flex items-center gap-0.5 ml-1">
            {/* File 菜单 */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'file' ? null : 'file')}
                onMouseEnter={() => {
                  if (openMenu && openMenu !== 'file') setOpenMenu('file');
                }}
                className={`px-2 py-1 rounded-md text-xs font-medium transition cursor-pointer ${
                  openMenu === 'file'
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-300 hover:text-white hover:bg-zinc-800/60'
                }`}
              >
                文件
              </button>

              {openMenu === 'file' && (
                <div className="absolute left-0 mt-1 w-64 rounded-xl border border-zinc-700/90 bg-zinc-900/98 shadow-2xl p-1.5 z-50 text-xs backdrop-blur-md space-y-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      onNewEmptyProject();
                    }}
                    className="w-full px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 flex items-center justify-between cursor-pointer transition"
                  >
                    <span className="flex items-center gap-2">
                      <FilePlus2 className="w-3.5 h-3.5 text-zinc-400" />
                      <span>新建空白工程</span>
                    </span>
                    <span className="text-[11px] font-mono text-zinc-500">⌘N</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      onOpenProjectFile();
                    }}
                    className="w-full px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 flex items-center justify-between cursor-pointer transition"
                  >
                    <span className="flex items-center gap-2">
                      <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                      <span>打开工程...</span>
                    </span>
                    <span className="text-[11px] font-mono text-zinc-500">⌘O</span>
                  </button>

                  {/* 最近打开的工程 */}
                  <div className="relative group/recents">
                    <button
                      type="button"
                      className="w-full px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 flex items-center justify-between cursor-pointer transition"
                    >
                      <span className="flex items-center gap-2">
                        <History className="w-3.5 h-3.5 text-indigo-400" />
                        <span>最近打开的工程</span>
                      </span>
                      <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                        <span>{recentProjects.length > 0 ? `${recentProjects.length}个` : '空'}</span>
                        <ChevronRight className="w-3 h-3 text-zinc-500" />
                      </span>
                    </button>

                    {/* 二级悬浮面板 */}
                    <div className="hidden group-hover/recents:block absolute left-full top-0 ml-1 w-72 rounded-xl border border-zinc-700/90 bg-zinc-900/98 shadow-2xl p-1.5 z-50 text-xs backdrop-blur-md space-y-1">
                      <div className="px-2 py-1 text-[10px] font-bold text-zinc-400 uppercase tracking-wider border-b border-zinc-800 flex items-center justify-between">
                        <span>近期工程文件</span>
                        {recentProjects.length > 0 && onClearRecentProjects && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onClearRecentProjects();
                            }}
                            className="text-[10px] text-red-400 hover:text-red-300 cursor-pointer font-normal"
                          >
                            清空记录
                          </button>
                        )}
                      </div>

                      <div className="max-h-64 overflow-y-auto space-y-0.5">
                        {recentProjects.length === 0 ? (
                          <div className="py-4 text-center text-zinc-500 text-[11px]">
                            暂无近期打开记录
                          </div>
                        ) : (
                          recentProjects.map((item) => (
                            <button
                              key={item.filePath}
                              type="button"
                              onClick={() => {
                                setOpenMenu(null);
                                onOpenRecentProject?.(item.filePath);
                              }}
                              className="w-full px-2 py-1.5 rounded-lg hover:bg-zinc-800 text-left transition flex items-start justify-between gap-1 group/item cursor-pointer"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="font-semibold text-zinc-200 truncate group-hover/item:text-indigo-300">
                                  {item.title}
                                </div>
                                <div className="text-[10px] text-zinc-500 truncate font-mono">
                                  {item.filePath}
                                </div>
                              </div>
                              <span className="text-[10px] text-zinc-500 shrink-0 mt-0.5 font-mono">
                                {formatRecentTime(item.lastOpenedAt)}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="my-1 border-t border-zinc-800" />

                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      onSaveProjectFile(false);
                    }}
                    className="w-full px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 flex items-center justify-between cursor-pointer transition"
                  >
                    <span className="flex items-center gap-2">
                      <Save className="w-3.5 h-3.5 text-emerald-400" />
                      <span>保存</span>
                    </span>
                    <span className="text-[11px] font-mono text-zinc-500">⌘S</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      onSaveProjectFile(true);
                    }}
                    className="w-full px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 flex items-center justify-between cursor-pointer transition"
                  >
                    <span className="flex items-center gap-2">
                      <Save className="w-3.5 h-3.5 text-zinc-400" />
                      <span>另存为...</span>
                    </span>
                    <span className="text-[11px] font-mono text-zinc-500">⇧⌘S</span>
                  </button>

                  {onRegisterFileAssociation && (
                    <>
                      <div className="my-1 border-t border-zinc-800" />
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          onRegisterFileAssociation();
                        }}
                        className="w-full px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 flex items-center justify-between cursor-pointer transition text-left"
                      >
                        <span className="flex items-center gap-2">
                          <CheckCircle2 className="w-3.5 h-3.5 text-indigo-400" />
                          <span>注册 .podcraft 打开方式</span>
                        </span>
                        <span className="text-[10px] text-zinc-500">双击直达</span>
                      </button>
                    </>
                  )}

                  {onToggleAutoSave && (
                    <>
                      <div className="my-1 border-t border-zinc-800" />
                      <div className="px-2.5 py-2 rounded-lg bg-zinc-950/60 border border-zinc-800/80 text-[11px]">
                        <div className="flex items-center justify-between gap-1">
                          <span className="flex items-center gap-1.5 text-zinc-300">
                            <Clock
                              className={`w-3.5 h-3.5 ${
                                autoSaveEnabled ? 'text-emerald-400' : 'text-zinc-500'
                              }`}
                            />
                            <span>定时自动保存</span>
                          </span>
                          <button
                            type="button"
                            onClick={onToggleAutoSave}
                            className={`px-1.5 py-0.5 rounded border text-[10px] cursor-pointer transition ${
                              autoSaveEnabled
                                ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300'
                                : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                            }`}
                          >
                            {autoSaveEnabled ? '已开启' : '已关闭'}
                          </button>
                        </div>
                        {autoSaveEnabled && onChangeAutoSaveInterval && (
                          <div className="mt-1.5 pt-1.5 border-t border-zinc-800/80 flex items-center justify-between text-[10px]">
                            <span className="text-zinc-500">间隔:</span>
                            <div className="flex items-center gap-1">
                              {[
                                { label: '30s', sec: 30 },
                                { label: '1分', sec: 60 },
                                { label: '2分', sec: 120 },
                                { label: '5分', sec: 300 },
                              ].map((item) => (
                                <button
                                  key={item.sec}
                                  type="button"
                                  onClick={() => onChangeAutoSaveInterval(item.sec)}
                                  className={`px-1.5 py-0.5 rounded cursor-pointer transition ${
                                    autoSaveIntervalSec === item.sec
                                      ? 'bg-emerald-500/25 border border-emerald-500/60 text-emerald-200 font-medium'
                                      : 'bg-zinc-800/80 border border-zinc-700/60 text-zinc-400 hover:text-zinc-200'
                                  }`}
                                >
                                  {item.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Edit 菜单 */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'edit' ? null : 'edit')}
                onMouseEnter={() => {
                  if (openMenu && openMenu !== 'edit') setOpenMenu('edit');
                }}
                className={`px-2 py-1 rounded-md text-xs font-medium transition cursor-pointer ${
                  openMenu === 'edit'
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-300 hover:text-white hover:bg-zinc-800/60'
                }`}
              >
                编辑
              </button>

              {openMenu === 'edit' && (
                <div className="absolute left-0 mt-1 w-64 rounded-xl border border-zinc-700/90 bg-zinc-900/98 shadow-2xl p-1.5 z-50 text-xs backdrop-blur-md space-y-0.5">
                  {onOpenShortcuts && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenu(null);
                        onOpenShortcuts();
                      }}
                      className="w-full px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-200 flex items-center justify-between cursor-pointer transition"
                    >
                      <span className="flex items-center gap-2">
                        <Keyboard className="w-3.5 h-3.5 text-blue-400" />
                        <span>快捷键说明...</span>
                      </span>
                      <span className="text-[11px] font-mono text-zinc-500">?</span>
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* View 菜单 */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'view' ? null : 'view')}
                onMouseEnter={() => {
                  if (openMenu && openMenu !== 'view') setOpenMenu('view');
                }}
                className={`px-2 py-1 rounded-md text-xs font-medium transition cursor-pointer ${
                  openMenu === 'view'
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-300 hover:text-white hover:bg-zinc-800/60'
                }`}
              >
                视图
              </button>

              {openMenu === 'view' && (
                <div className="absolute left-0 mt-1 w-64 rounded-xl border border-zinc-700/90 bg-zinc-900/98 shadow-2xl p-1.5 z-50 text-xs backdrop-blur-md space-y-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      onSetWorkspaceLayout('multitrack');
                    }}
                    className={`w-full px-2.5 py-1.5 rounded-lg text-left flex items-center justify-between cursor-pointer transition ${
                      layoutMode === 'multitrack'
                        ? 'bg-emerald-500/15 text-emerald-300 font-medium'
                        : 'hover:bg-zinc-800 text-zinc-200'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span>🎛️</span>
                      <span>音轨主视图</span>
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-zinc-500">⌥ 1</span>
                      {layoutMode === 'multitrack' && (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      )}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      onSetWorkspaceLayout('transcript');
                    }}
                    className={`w-full px-2.5 py-1.5 rounded-lg text-left flex items-center justify-between cursor-pointer transition ${
                      layoutMode === 'transcript'
                        ? 'bg-blue-500/15 text-blue-300 font-medium'
                        : 'hover:bg-zinc-800 text-zinc-200'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span>📝</span>
                      <span>文稿视图</span>
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-zinc-500">⌥ 2</span>
                      {layoutMode === 'transcript' && (
                        <Check className="w-3.5 h-3.5 text-blue-400" />
                      )}
                    </div>
                  </button>

                  {(onToggleLeftPane || onToggleRightPane) && (
                    <div className="my-1 border-t border-zinc-800" />
                  )}

                  {onToggleLeftPane && (
                    <button
                      type="button"
                      disabled={layoutMode === 'transcript'}
                      onClick={() => {
                        setOpenMenu(null);
                        onToggleLeftPane();
                      }}
                      className={`w-full px-2.5 py-1.5 rounded-lg text-zinc-200 flex items-center justify-between cursor-pointer transition ${
                        layoutMode === 'transcript'
                          ? 'opacity-40 cursor-not-allowed text-zinc-500'
                          : 'hover:bg-zinc-800'
                      }`}
                      title={layoutMode === 'transcript' ? '文稿视图下已全宽替换左右侧边栏' : undefined}
                    >
                      <span className="flex items-center gap-2">
                        <PanelLeft className="w-3.5 h-3.5 text-zinc-400" />
                        <span>左侧音轨栏</span>
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-zinc-500">⌘ [</span>
                        {layoutMode === 'transcript' ? (
                          <span className="text-[10px] text-zinc-500">文稿全宽</span>
                        ) : !leftPaneCollapsed ? (
                          <span className="text-[10px] text-emerald-400 font-medium">显示</span>
                        ) : (
                          <span className="text-[10px] text-zinc-500">隐藏</span>
                        )}
                      </div>
                    </button>
                  )}

                  {onToggleRightPane && (
                    <button
                      type="button"
                      disabled={!hasContent || layoutMode === 'transcript'}
                      onClick={() => {
                        setOpenMenu(null);
                        onToggleRightPane();
                      }}
                      className={`w-full px-2.5 py-1.5 rounded-lg text-zinc-200 flex items-center justify-between cursor-pointer transition ${
                        !hasContent || layoutMode === 'transcript'
                          ? 'opacity-40 cursor-not-allowed text-zinc-500'
                          : 'hover:bg-zinc-800'
                      }`}
                      title={layoutMode === 'transcript' ? '文稿视图下已全宽替换左右侧边栏' : undefined}
                    >
                      <span className="flex items-center gap-2">
                        <PanelRight className="w-3.5 h-3.5 text-zinc-400" />
                        <span>右侧 AI 工作台</span>
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-zinc-500">⌘ ]</span>
                        {layoutMode === 'transcript' ? (
                          <span className="text-[10px] text-zinc-500">文稿全宽</span>
                        ) : hasContent && !rightPaneCollapsed ? (
                          <span className="text-[10px] text-emerald-400 font-medium">显示</span>
                        ) : (
                          <span className="text-[10px] text-zinc-500">隐藏</span>
                        )}
                      </div>
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* 音频与剪辑设置 下拉菜单 */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'settings' ? null : 'settings')}
                onMouseEnter={() => {
                  if (openMenu && openMenu !== 'settings') setOpenMenu('settings');
                }}
                className={`px-2 py-1 rounded-md text-xs font-medium transition cursor-pointer flex items-center gap-1 ${
                  openMenu === 'settings'
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-300 hover:text-white hover:bg-zinc-800/60'
                }`}
              >
                <span>音频与剪辑</span>
              </button>

              {openMenu === 'settings' && (
                <div className="absolute left-0 mt-1 w-80 rounded-xl border border-zinc-700/90 bg-zinc-900/98 shadow-2xl p-2 z-50 text-xs backdrop-blur-md space-y-2 max-h-[85vh] overflow-y-auto">
                  {/* 分组一：录音与多轨校准 */}
                  <div className="space-y-1">
                    <div className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1">
                      <span>🎙️</span>
                      <span>录音与多轨校准</span>
                    </div>

                    <button
                      type="button"
                      onClick={onToggleRecordingMode}
                      title="同屋模式默认各轨等长 0ms 免校准直通；异地模式按合并参考轨执行 GCC-PHAT 互相关偏移校准"
                      className="w-full px-2 py-1.5 rounded-lg hover:bg-zinc-800/90 flex items-center justify-between gap-2 text-xs text-zinc-200 cursor-pointer transition"
                    >
                      <span className="flex items-center gap-2">
                        {state.recordingMode === 'same_room_sync' ? (
                          <Home className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Radio className="w-3.5 h-3.5 text-amber-400" />
                        )}
                        <span>录音校准模式</span>
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-300">
                        {state.recordingMode === 'same_room_sync' ? '同屋 0ms' : '多设备校准'}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={onCycleAutoSolo}
                      title="一人发言时自动抑制其余麦位房间回声、桌振串音与环境底噪"
                      className="w-full px-2 py-1.5 rounded-lg hover:bg-zinc-800/90 flex items-center justify-between gap-2 text-xs text-zinc-200 cursor-pointer transition"
                    >
                      <span className="flex items-center gap-2">
                        <Sliders className="w-3.5 h-3.5 text-emerald-400" />
                        <span>非主讲抑回声</span>
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded border text-[11px] ${
                          state.autoSoloMode !== 'off'
                            ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300'
                            : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        {soloLabel}
                      </span>
                    </button>
                  </div>

                  <div className="border-t border-zinc-800/80 my-1" />

                  {/* 分组二：声学处理与母带 */}
                  <div className="space-y-1">
                    <div className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1">
                      <span>🎚️</span>
                      <span>声学处理与母带</span>
                    </div>

                    <button
                      type="button"
                      onClick={onToggleLoudness}
                      className="w-full px-2 py-1.5 rounded-lg hover:bg-zinc-800/90 flex items-center justify-between gap-2 text-xs text-zinc-200 cursor-pointer transition"
                    >
                      <span className="flex items-center gap-2">
                        <Volume2 className="w-3.5 h-3.5 text-blue-400" />
                        <span>广播级响度标准化</span>
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded border text-[11px] ${
                          state.loudnessAligned
                            ? 'border-blue-500/45 bg-blue-500/15 text-blue-300'
                            : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        {state.loudnessAligned ? '-16 LUFS' : '关'}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={onCycleDeClick}
                      title="实时审听与导出 MP3 自动抑制唇齿口水音、咂嘴瞬态与气口粘连杂音"
                      className="w-full px-2 py-1.5 rounded-lg hover:bg-zinc-800/90 flex items-center justify-between gap-2 text-xs text-zinc-200 cursor-pointer transition"
                    >
                      <span className="flex items-center gap-2">
                        <Droplets className="w-3.5 h-3.5 text-teal-400" />
                        <span>去除口水音滤波</span>
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded border text-[11px] ${
                          state.deClickEnabled
                            ? state.deClickStrength === 'strong'
                              ? 'border-cyan-400/55 bg-cyan-500/20 text-cyan-200'
                              : 'border-teal-500/45 bg-teal-500/15 text-teal-300'
                            : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        {state.deClickEnabled
                          ? state.deClickStrength === 'strong'
                            ? '强力'
                            : '标准'
                          : '关'}
                      </span>
                    </button>
                  </div>

                  <div className="border-t border-zinc-800/80 my-1" />

                  {/* 分组三：智能剪辑与审听 */}
                  <div className="space-y-1">
                    <div className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1">
                      <span>✂️</span>
                      <span>智能剪辑与审听</span>
                    </div>

                    <button
                      type="button"
                      onClick={onToggleStripSilence}
                      disabled={!hasContent}
                      className="w-full px-2 py-1.5 rounded-lg hover:bg-zinc-800/90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-between gap-2 text-xs text-zinc-200 cursor-pointer transition"
                    >
                      <span className="flex items-center gap-2">
                        <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                        <span>智能缩短空白</span>
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded border text-[11px] ${
                          state.stripSilenceEnabled
                            ? 'border-purple-500/45 bg-purple-500/15 text-purple-300'
                            : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        {state.stripSilenceEnabled ? '开' : '关'}
                      </span>
                    </button>

                    {onToggleCutPrerollEnabled && (
                      <div className="w-full px-2 py-1.5 rounded-lg bg-zinc-950/40 border border-zinc-800/80 text-xs text-zinc-200 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={onToggleCutPrerollEnabled}
                            title="删除/切除区间后，游标自动倒退指定秒数并开始播放，方便审听接缝是否平滑"
                            className="flex items-center gap-2 cursor-pointer flex-1 text-left"
                          >
                            <RotateCcw
                              className={`w-3.5 h-3.5 ${
                                (state.cutPrerollEnabled ?? true) ? 'text-amber-400' : 'text-zinc-500'
                              }`}
                            />
                            <span>剪辑自动回溯审听</span>
                          </button>
                          <button
                            type="button"
                            onClick={onToggleCutPrerollEnabled}
                            className={`px-1.5 py-0.5 rounded border text-[10px] cursor-pointer transition ${
                              (state.cutPrerollEnabled ?? true)
                                ? 'border-amber-500/45 bg-amber-500/15 text-amber-300'
                                : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                            }`}
                          >
                            {(state.cutPrerollEnabled ?? true) ? `${state.cutPrerollSec ?? 3}s 开启` : '已关闭'}
                          </button>
                        </div>
                        {(state.cutPrerollEnabled ?? true) && onChangeCutPrerollSec && (
                          <div className="flex items-center justify-between text-[10px] text-zinc-400 pt-1 border-t border-zinc-800/60">
                            <span>回溯时长:</span>
                            <div className="flex items-center gap-1">
                              {[1, 2, 3, 5].map((sec) => (
                                <button
                                  key={sec}
                                  type="button"
                                  onClick={() => onChangeCutPrerollSec(sec)}
                                  className={`px-1.5 py-0.5 rounded cursor-pointer transition ${
                                    Math.abs((state.cutPrerollSec ?? 3) - sec) < 0.1
                                      ? 'bg-amber-500/25 border border-amber-500/60 text-amber-200 font-medium'
                                      : 'bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200'
                                  }`}
                                >
                                  {sec}s
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {onTogglePauseCutJumpEnabled && (
                      <button
                        type="button"
                        onClick={onTogglePauseCutJumpEnabled}
                        title="开启时暂停剪辑删除会往前跳转并自动播放审听接缝；关闭时删除后游标保持原位无多余行为"
                        className="w-full px-2 py-1.5 rounded-lg hover:bg-zinc-800/90 flex items-center justify-between gap-2 text-xs text-zinc-200 cursor-pointer transition"
                      >
                        <span className="flex items-center gap-2">
                          <LocateFixed
                            className={`w-3.5 h-3.5 ${
                              (state.pauseCutJumpEnabled ?? true) ? 'text-cyan-400' : 'text-zinc-500'
                            }`}
                          />
                          <span>暂停剪辑定位接缝</span>
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded border text-[11px] ${
                            (state.pauseCutJumpEnabled ?? true)
                              ? 'border-cyan-500/45 bg-cyan-500/15 text-cyan-300'
                              : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          {(state.pauseCutJumpEnabled ?? true) ? '开启' : '关闭'}
                        </span>
                      </button>
                    )}
                  </div>

                  <div className="border-t border-zinc-800/80 my-1" />

                  {/* 分组四：运行环境与素材库 */}
                  <div className="space-y-1">
                    <div className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1">
                      <span>⚙️</span>
                      <span>运行环境与全局素材库</span>
                    </div>

                    {onOpenGlobalAuxLibrary && (
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          onOpenGlobalAuxLibrary();
                        }}
                        className="w-full px-2 py-1.5 rounded-lg hover:bg-purple-500/15 flex items-center justify-between gap-2 text-xs text-purple-200 cursor-pointer transition"
                      >
                        <span className="flex items-center gap-2">
                          <Library className="w-3.5 h-3.5 text-purple-400" />
                          <span>固定口播 / 片头尾 BGM 库</span>
                        </span>
                        <span className="text-[10px] text-purple-300/80">管理 →</span>
                      </button>
                    )}

                    {onOpenDepGuide && (
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          onOpenDepGuide();
                        }}
                        className="w-full px-2 py-1.5 rounded-lg hover:bg-cyan-500/15 flex items-center justify-between gap-2 text-xs text-cyan-200 cursor-pointer transition"
                      >
                        <span className="flex items-center gap-2">
                          <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                          <span>AI 语音引擎与离线模型环境</span>
                        </span>
                        <span className="text-[10px] text-cyan-400/80">检测/下载 →</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 片头口播与 BGM 下拉菜单 */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'aux_bgm' ? null : 'aux_bgm')}
                onMouseEnter={() => {
                  if (openMenu && openMenu !== 'aux_bgm') setOpenMenu('aux_bgm');
                }}
                className={`px-2 py-1 rounded-md text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                  openMenu === 'aux_bgm'
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-300 hover:text-white hover:bg-zinc-800/60'
                }`}
              >
                <Music className="w-3.5 h-3.5 text-blue-400" />
                <span>片头口播与BGM</span>
                {((state.introVoiceover?.enabled ? 1 : 0) +
                  (state.introBgm?.enabled ? 1 : 0) +
                  (state.outroBgm?.enabled ? 1 : 0)) > 0 && (
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block" />
                )}
              </button>

              {openMenu === 'aux_bgm' && (
                <div className="absolute left-0 mt-1 z-50">
                  <AuxBgmConfigMenu
                    state={state}
                    onImportBgm={onImportBgm || (() => {})}
                    onToggleBgmEnabled={onToggleBgmEnabled || (() => {})}
                    onRemoveBgm={onRemoveBgm || (() => {})}
                    onSaveSlotToGlobalLibrary={onSaveSlotToGlobalLibrary}
                    onOpenGlobalAuxLibrary={onOpenGlobalAuxLibrary}
                    onUpdateState={onUpdateState || (() => {})}
                    onNotify={onNotify || (() => {})}
                    onClose={() => setOpenMenu(null)}
                  />
                </div>
              )}
            </div>

            {onOpenIntroEditor && (
              <button
                type="button"
                onClick={onOpenIntroEditor}
                title="打开独立片头多轨编辑器（移动/缩放金句、拖动口播位置、音轨段落静音、预览BGM避让）"
                className="px-2.5 py-1 rounded-md text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 text-white bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 shadow-sm border border-purple-400/40"
              >
                <Sparkles className="w-3.5 h-3.5 text-purple-100" />
                <span>片头编辑器</span>
                {(state.coldOpenEnabled || state.introVoiceover?.enabled || state.introBgm?.enabled) && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-300 inline-block" />
                )}
              </button>
            )}
          </nav>

          <div className="h-3.5 w-px bg-zinc-800 mx-1 shrink-0" />

          {editingTitle ? (
            <input
              type="text"
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              className="px-2 py-0.5 rounded border border-blue-500 bg-zinc-950 text-xs font-semibold text-zinc-100 w-48 focus:outline-none"
            />
          ) : (
            <button
              onClick={() => {
                setTitleDraft(state.projectTitle);
                setEditingTitle(true);
              }}
              title="点击修改工程名称"
              className="font-semibold text-sm text-zinc-100 hover:text-blue-300 flex items-center gap-1 truncate max-w-[210px] cursor-pointer"
            >
              <span className="truncate">{state.projectTitle}</span>
              <Edit2 className="w-3 h-3 text-zinc-500 shrink-0" />
            </button>
          )}

          {isDirty ? (
            <span
              title={state.projectFilePath ? `工程路径: ${state.projectFilePath}` : '尚未保存工程文件'}
              className="px-2 py-0.5 text-[11px] rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-medium shrink-0 flex items-center gap-1"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
              未保存修改
            </span>
          ) : lastAutoSavedAt ? (
            <span
              title={`自动保存于 ${formatClockTime(lastAutoSavedAt)}`}
              className="px-2 py-0.5 text-[11px] rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-medium shrink-0 flex items-center gap-1"
            >
              <Check className="w-3 h-3 text-emerald-400" />
              <span>自动保存 {formatClockTime(lastAutoSavedAt)}</span>
            </span>
          ) : state.lastSavedAt || state.projectFilePath ? (
            <span
              title={state.projectFilePath ?? '工程已保存'}
              className="px-2 py-0.5 text-[11px] rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700 font-medium shrink-0"
            >
              ✓ 已保存
            </span>
          ) : null}

          {hasContent && savedDurationSec > 0 && (
            <span className="px-2 py-0.5 text-[11px] rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-medium shrink-0">
              已精简 {savedDurationSec.toFixed(1)}s
            </span>
          )}
        </div>

        {/* 顶部展开的视图控制工具组：音轨主视图 / 文稿视图直接切换与侧边栏开关 */}
        <div className="flex items-center gap-1.5 bg-zinc-950/80 p-0.5 rounded-lg border border-zinc-800 shadow-xs">
          <div className="flex items-center p-0.5 rounded-md bg-zinc-900 border border-zinc-700/60 shadow-inner">
            <button
              type="button"
              onClick={() => onSetWorkspaceLayout('multitrack')}
              className={`px-2.5 py-1 rounded text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
                layoutMode === 'multitrack'
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`}
              title="音轨主视图 (快捷键: ⌥1)"
            >
              <span>🎛️</span>
              <span>音轨视图</span>
            </button>
            <button
              type="button"
              onClick={() => onSetWorkspaceLayout('transcript')}
              className={`px-2.5 py-1 rounded text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
                layoutMode === 'transcript'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`}
              title="文稿视图 (快捷键: ⌥2)"
            >
              <span>📝</span>
              <span>文稿视图</span>
            </button>
          </div>

          {(onToggleLeftPane || onToggleRightPane) && (
            <div className="flex items-center gap-1 pl-1 border-l border-zinc-800">
              {onToggleLeftPane && (
                <button
                  type="button"
                  onClick={onToggleLeftPane}
                  className={`p-1.5 rounded text-xs transition cursor-pointer ${
                    leftPaneCollapsed
                      ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
                      : 'text-zinc-200 bg-zinc-800 border border-zinc-700/60 shadow-xs'
                  }`}
                  title={`左侧栏: ${leftPaneCollapsed ? '展开' : '收起'} (⌘[)`}
                >
                  <PanelLeft className="w-3.5 h-3.5" />
                </button>
              )}
              {onToggleRightPane && (
                <button
                  type="button"
                  onClick={onToggleRightPane}
                  className={`p-1.5 rounded text-xs transition cursor-pointer ${
                    rightPaneCollapsed
                      ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
                      : 'text-zinc-200 bg-zinc-800 border border-zinc-700/60 shadow-xs'
                  }`}
                  title={`右侧 AI 工作台: ${rightPaneCollapsed ? '展开' : '收起'} (⌘])`}
                >
                  <PanelRight className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={onOpenImportModal}
          title="导入音频与 AI 识别配置（SenseVoice / 豆包 / DeepSeek / 云端大模型）"
          className="px-2.5 py-1.5 rounded-lg border border-blue-500/45 bg-blue-500/15 hover:bg-blue-500/25 text-xs font-semibold text-blue-300 flex items-center gap-1.5 transition cursor-pointer"
        >
          <FolderPlus className="w-3.5 h-3.5 text-blue-400" />
          <span>导入音频</span>
        </button>

        {/* 倍速播放器（已按用户要求去掉审听按钮） */}
        <div
          title="倍速播放且锁定不变调"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-700/80 bg-zinc-950/90 shadow-sm text-xs text-zinc-200"
        >
          <Gauge className="w-3.5 h-3.5 text-blue-400 shrink-0" />
          <select
            value={state.playbackRate || 1.0}
            disabled={!hasContent}
            onChange={(e) => onChangePlaybackRate(Number(e.target.value))}
            className="bg-transparent font-mono font-semibold text-xs text-zinc-100 focus:outline-none cursor-pointer disabled:opacity-40"
          >
            {PLAYBACK_RATES.map((r) => (
              <option key={r} value={r} className="bg-zinc-900 text-zinc-100">
                {r}x
              </option>
            ))}
          </select>
        </div>

        {onOpenShownotes && (
          <button
            onClick={onOpenShownotes}
            disabled={!hasContent}
            title="剪辑完成后一键生成 Shownotes（含500字简介、嘉宾名片、时间轴、抽奖海报与听友福利）"
            className="px-2.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold flex items-center gap-1 shadow-sm transition cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>生成 Shownotes</span>
          </button>
        )}

        <button
          onClick={onQuickExportAudio}
          disabled={!hasContent}
          title="导出 -16 LUFS 播客标准响度 MP3 成片"
          className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold flex items-center gap-1 shadow-sm transition cursor-pointer"
        >
          <Download className="w-3.5 h-3.5" />
          <span>导出 MP3</span>
        </button>
      </div>
    </header>
  );
});
