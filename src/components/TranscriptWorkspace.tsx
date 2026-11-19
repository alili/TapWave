import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Droplets,
  Edit3,
  Eye,
  EyeOff,
  FileText,
  GripVertical,
  ListTree,
  Maximize2,
  Mic,
  Minimize2,
  RotateCcw,
  Scissors,
  ShieldAlert,
  Sparkles,
  Undo2,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { TextEditorModeWorkspace } from './TextEditorModeWorkspace';
import {
  EditInteractionMode,
  HighlightClip,
  PodcastProjectState,
  SpeakerRole,
  TranscriptBlock,
  TranscriptGroupingMode,
  TranscriptToken,
} from '../types/podcast';
import {
  coalesceChronologicalBlocks,
  formatMmSs,
  OverlapTimelineRegion,
  TimelineComputation,
} from '../engine/timelineEngine';
import { audioPreview } from '../engine/audioPreviewEngine';
import {
  analyzeTranscriptOutlines,
  isSecondaryOverlapShortBlock,
  OutlineSection,
  reorderOutlineSections,
  syncOutlineTitlesToBlocks,
} from '../engine/outlineEngine';

interface TranscriptWorkspaceProps {
  state: PodcastProjectState;
  timeline: TimelineComputation;
  selectedIds: Set<string>;
  activeBlockId?: string | null;
  activeTokenId?: string | null;
  canUndo?: boolean;
  onSelectToken: (tokenId: string, flatIndex: number, shiftKey: boolean, metaKey: boolean) => void;
  onSelectRange: (startFlatIndex: number, endFlatIndex: number, additive: boolean) => void;
  onClearSelection: () => void;
  onSeekToSec: (sec: number) => void;
  onFocusWaveformBlock?: (
    startSec: number,
    endSec: number,
    speakerId: string,
    anchorSec?: number,
    preserveHigherZoom?: boolean
  ) => void;
  onSetGroupingMode: (mode: TranscriptGroupingMode) => void;
  onSetSpeakerFilter: (speakerId: string) => void;
  onSetInteractionMode: (mode: EditInteractionMode) => void;
  onToggleHideDeleted: () => void;
  onRippleDeleteSelected: () => void;
  onMuteTrackSelected: () => void;
  onBleepSelected: () => void;
  onAddSelectedToHighlight: () => void;
  onCancelDuckingSelected?: () => void;
  onRestoreTokens: (tokenIds: string[]) => void;
  onShortenSilence: (tokenId: string) => void;
  onAcceptAllAiCorrections: () => void;
  onApplyManualCorrection: (tokenId: string, newText: string, saveToGlossary: boolean) => void;
  onCleanSpeakerFillers: (speakerId: string) => void;
  onCompressSpeakerSilence: (speakerId: string) => void;
  onCleanMouthClicks?: (speakerId?: string) => void;
  onToggleRetakeExpand: (blockId: string) => void;
  onToggleOverlapMute: (
    blockId: string,
    fallbackOv?: {
      speakerId: string;
      speakerName: string;
      text?: string;
      sourceStartMs: number;
      sourceEndMs: number;
    }
  ) => void;
  onToggleOverlapKeepFull?: (
    blockId: string,
    fallbackOv?: {
      speakerId: string;
      speakerName: string;
      text?: string;
      sourceStartMs: number;
      sourceEndMs: number;
    }
  ) => void;
  onWaveformCutAction?: (
    startSec: number,
    endSec: number,
    action: 'ripple_all' | 'mute_lane' | 'bleep_range' | 'add_highlight' | 'cancel_ducking',
    targetSpeakerId?: string
  ) => void;
  onUndo?: () => void;
  onResetAllEdits: () => void;
  onRetranscribe?: () => void;
  onOpenSubtitleCorrection?: () => void;
  onDropSubtitleFile?: (file: File) => void;
  onRenameSpeakerTrack?: (trackId: string, newName?: string, newRole?: SpeakerRole) => void;
  onReorderBlocks?: (newBlocks: TranscriptBlock[]) => void;
  onOpenShownotes?: (tab?: 'summary' | 'guests' | 'timeline' | 'activity' | 'benefits') => void;
  onSeekToHighlight?: (hl: HighlightClip) => void;
  onRemoveHighlight?: (id: string) => void;
  onUpdateState?: (updater: (prev: PodcastProjectState) => PodcastProjectState) => void;
  onAiAutoFillHighlights?: () => void;
  onCopyQuotes?: () => void;
  onNotify?: (msg: string) => void;
  onOpenHighlightEditModal?: (hl: HighlightClip) => void;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  onSeekAndPlay?: (sec: number) => void;
}

const EMPTY_TOKEN_SET = new Set<string>();

interface BlockTokenCallbacks {
  flatIndexById: Record<string, number>;
  dragSelectRef: React.MutableRefObject<{
    active: boolean;
    moved: boolean;
    anchorIdx: number;
    additive: boolean;
  }>;
  lastClickedIdxRef: React.MutableRefObject<number | null>;
  seekToTokenId: (tokenId?: string) => void;
  seekToRangeStart: (idxA: number, idxB: number) => void;
  onSelectToken: (tokenId: string, flatIndex: number, shiftKey: boolean, metaKey: boolean) => void;
  onSelectRange: (startFlatIndex: number, endFlatIndex: number, additive: boolean) => void;
  onRestoreTokens: (tokenIds: string[]) => void;
  onShortenSilence: (tokenId: string) => void;
  openEditorForToken: (tok: TranscriptToken) => void;
}

interface BlockTokenStreamProps {
  tokens: TranscriptToken[];
  speakerId: string;
  hideDeleted: boolean;
  interactionMode: EditInteractionMode;
  blockActiveTokenId: string | null;
  blockSelectionKey: string;
  overlapRangesKey?: string;
  callbacksRef: React.MutableRefObject<BlockTokenCallbacks>;
  isCompact?: boolean;
}

const ASCII_ALNUM_END_RE = /[A-Za-z0-9]$/;
const ASCII_ALNUM_START_RE = /^[A-Za-z0-9]/;

const BlockTokenStream: React.FC<BlockTokenStreamProps> = React.memo(
  ({
    tokens,
    speakerId,
    hideDeleted,
    interactionMode,
    blockActiveTokenId,
    blockSelectionKey,
    overlapRangesKey,
    callbacksRef,
    isCompact = true,
  }) => {
    const selectedSet = useMemo(
      () => (blockSelectionKey ? new Set(blockSelectionKey.split(',')) : EMPTY_TOKEN_SET),
      [blockSelectionKey]
    );

    const parsedOverlaps = useMemo(() => {
      if (!overlapRangesKey) return [] as Array<{ startMs: number; endMs: number; secName: string }>;
      return overlapRangesKey.split('|').map((part) => {
        const [s, e, ...nameParts] = part.split(':');
        return {
          startMs: Number(s) || 0,
          endMs: Number(e) || 0,
          secName: nameParts.join(':') || '副轨',
        };
      });
    }, [overlapRangesKey]);

    const elements: React.ReactNode[] = [];
    let i = 0;
    let prevWordEndedAsciiAlnum = false;

    while (i < tokens.length) {
      const tok = tokens[i];

      if (tok.deleted) {
        const deletedGroup: TranscriptToken[] = [];
        while (i < tokens.length && tokens[i].deleted) {
          deletedGroup.push(tokens[i]);
          i++;
        }
        if (hideDeleted) {
          continue;
        }
        prevWordEndedAsciiAlnum = false;

        const groupIds = deletedGroup.map((d) => d.id);
        const groupDur = deletedGroup.reduce((s, d) => s + d.origDurationSec, 0);
        const rawHiddenText = deletedGroup
          .map((d) => (d.type === 'silence' ? `[空白]` : d.text))
          .join('');
        const wasWaveCut = deletedGroup.some((d) => d.cutByWaveform);

        elements.push(
          <span
            key={`del_grp_${deletedGroup[0].id}`}
            data-transcript-token="1"
            className={`inline-flex items-center gap-1 ${
              isCompact ? 'px-1 py-0 mx-0.5 text-[11px] leading-4' : 'px-1.5 py-0 mx-0.5 text-xs leading-5'
            } rounded bg-red-500/15 text-red-400 border border-red-500/30 align-baseline`}
            title={`已隐藏原文字：「${rawHiddenText || '停顿空白'}」(${groupDur.toFixed(2)}s)`}
          >
            <button
              onClick={() => audioPreview.playSpliceAudition(speakerId)}
              className="hover:text-white cursor-pointer"
            >
              ✂ {wasWaveCut ? '波形切口' : `已删${deletedGroup.length}项`} ({groupDur.toFixed(1)}s)🔊
            </button>
            <button
              onClick={() => callbacksRef.current.onRestoreTokens(groupIds)}
              title="恢复此段已删除的文字与音频"
              className="text-zinc-300 hover:text-emerald-400 cursor-pointer pl-0.5 font-semibold"
            >
              ↺恢复
            </button>
          </span>
        );
        continue;
      }

      i++;
      const idx = callbacksRef.current.flatIndexById[tok.id] ?? 0;
      const isSelected = selectedSet.has(tok.id);
      const isActivePlayhead = blockActiveTokenId === tok.id;

      if (tok.bleeped) {
        prevWordEndedAsciiAlnum = false;
        elements.push(
          <span
            key={tok.id}
            data-transcript-token="1"
            onClick={(e) => {
              audioPreview.playBleepTone();
              callbacksRef.current.seekToTokenId(tok.id);
              callbacksRef.current.lastClickedIdxRef.current = idx;
              callbacksRef.current.onSelectToken(tok.id, idx, e.shiftKey, e.metaKey || e.ctrlKey);
            }}
            title="全轨已叠加 1kHz 哔声遮盖防串音泄密，节目摘要已同步打码（单击跳转播放进度条）"
            className={`inline-flex items-center ${
              isCompact ? 'px-1 py-0 mx-0.5 text-[11px] leading-4' : 'px-1.5 py-0 mx-0.5 text-xs leading-5'
            } rounded border align-baseline font-semibold cursor-pointer ${
              isSelected
                ? 'bg-blue-500/45 border-blue-400/70 text-white'
                : isActivePlayhead
                ? 'bg-amber-500/30 border-amber-400/70 text-amber-100'
                : 'bg-amber-500/20 border-amber-500/50 text-amber-300'
            }`}
          >
            🚨 [哔——已消音]
          </span>
        );
        continue;
      }

      if (tok.trackMuted && tok.type !== 'silence') {
        prevWordEndedAsciiAlnum = false;
        if (hideDeleted) {
          elements.push(
            <span
              key={tok.id}
              data-transcript-token="1"
              onClick={() => callbacksRef.current.onRestoreTokens([tok.id])}
              title={`单轨已静音（原文字「${tok.text}」已隐藏，点击恢复）`}
              className={`inline-flex items-center ${
                isCompact ? 'px-1 py-0 mx-0.5 text-[11px] leading-4' : 'px-1.5 py-0 mx-0.5 text-xs leading-5'
              } rounded border border-dashed border-zinc-700 text-zinc-500 align-baseline cursor-pointer hover:border-zinc-500`}
            >
              🔇 单轨静音 ↺
            </span>
          );
        } else {
          elements.push(
            <span
              key={tok.id}
              data-transcript-token="1"
              onClick={() => callbacksRef.current.onRestoreTokens([tok.id])}
              title="单轨已静音填充环境底噪，全局多轨总时长不变（点击恢复）"
              className={`inline-flex items-center ${
                isCompact ? 'px-1 py-0 mx-0.5 text-[11px] leading-4' : 'px-1.5 py-0 mx-0.5 text-xs leading-5'
              } rounded border border-dashed border-zinc-700 text-zinc-500 line-through align-baseline cursor-pointer hover:border-zinc-500`}
            >
              🔇 {tok.text}
            </span>
          );
        }
        continue;
      }

      if (tok.type === 'silence') {
        prevWordEndedAsciiAlnum = false;
        const isCleanedPause = Boolean(tok.mouthClickCleaned && tok.trackMuted);
        elements.push(
          <span
            key={tok.id}
            data-transcript-token="1"
            onMouseDown={(e) => {
              if (e.button !== 0 || interactionMode === 'text_proofread') return;
              if (e.altKey) {
                callbacksRef.current.seekToTokenId(tok.id);
                return;
              }
              if (e.shiftKey) return;
              callbacksRef.current.dragSelectRef.current = {
                active: true,
                moved: false,
                anchorIdx: idx,
                additive: e.metaKey || e.ctrlKey,
              };
            }}
            onMouseEnter={() => {
              if (callbacksRef.current.dragSelectRef.current.active) {
                callbacksRef.current.dragSelectRef.current.moved = true;
                callbacksRef.current.onSelectRange(
                  callbacksRef.current.dragSelectRef.current.anchorIdx,
                  idx,
                  callbacksRef.current.dragSelectRef.current.additive
                );
              }
            }}
            onClick={(e) => {
              if (e.altKey) return;
              const cb = callbacksRef.current;
              if (cb.dragSelectRef.current.moved) {
                cb.dragSelectRef.current.moved = false;
                cb.seekToRangeStart(cb.dragSelectRef.current.anchorIdx, idx);
                cb.lastClickedIdxRef.current = idx;
                return;
              }
              if (e.shiftKey && cb.lastClickedIdxRef.current !== null) {
                cb.seekToRangeStart(cb.lastClickedIdxRef.current, idx);
              } else if (!e.metaKey && !e.ctrlKey) {
                cb.seekToTokenId(tok.id);
              }
              cb.lastClickedIdxRef.current = idx;
              cb.onSelectToken(tok.id, idx, e.shiftKey, e.metaKey || e.ctrlKey);
            }}
            onDoubleClick={() => callbacksRef.current.onShortenSilence(tok.id)}
            title={
              isCleanedPause
                ? '已净音气口胶囊：该停顿内的口水音/咂嘴杂音已自动静音消除（双击缩短至 0.45s）'
                : '空白停顿胶囊：单击跳转进度条并选中（按 Delete 删除），双击直接缩短至 0.45s 自然气口'
            }
            className={`inline-flex items-center gap-0.5 ${
              isCompact ? 'px-1 py-0 mx-0.5 text-[10px] leading-4' : 'px-1.5 py-0 mx-0.5 text-[11px] leading-5'
            } rounded-full border cursor-pointer transition-colors select-none align-baseline ${
              isSelected
                ? 'bg-blue-500/45 border-blue-400/70 text-white'
                : isActivePlayhead
                ? 'bg-amber-500/25 border-amber-400/70 text-amber-100'
                : isCleanedPause
                ? 'bg-teal-500/15 border-teal-500/40 text-teal-300 hover:border-teal-400'
                : 'bg-zinc-800/85 border-zinc-700/85 text-zinc-400 hover:border-zinc-500'
            }`}
          >
            {isCleanedPause
              ? `💧 ${tok.durationSec.toFixed(2)}s`
              : `⏸ ${tok.durationSec.toFixed(2)}s`}
          </span>
        );
        continue;
      }

      if (tok.type === 'laughter') {
        prevWordEndedAsciiAlnum = false;
        elements.push(
          <span
            key={tok.id}
            data-transcript-token="1"
            onClick={(e) => {
              const cb = callbacksRef.current;
              if (e.shiftKey && cb.lastClickedIdxRef.current !== null) {
                cb.seekToRangeStart(cb.lastClickedIdxRef.current, idx);
              } else if (!e.metaKey && !e.ctrlKey) {
                cb.seekToTokenId(tok.id);
              }
              cb.lastClickedIdxRef.current = idx;
              cb.onSelectToken(tok.id, idx, e.shiftKey, e.metaKey || e.ctrlKey);
            }}
            className={`inline-flex items-center ${
              isCompact ? 'px-1 py-0 mx-0.5 text-[11px] leading-4' : 'px-1.5 py-0 mx-0.5 text-xs leading-5'
            } rounded border cursor-pointer transition-colors select-none align-baseline ${
              isSelected
                ? 'bg-blue-500/45 border-blue-400/70 text-white'
                : isActivePlayhead
                ? 'bg-amber-500/25 border-amber-400/70 text-amber-100'
                : 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300'
            }`}
          >
            {tok.text}
          </span>
        );
        continue;
      }

      // Natural continuous prose spacing: zero gap between CJK tokens, single space only between two ASCII words
      const needsAsciiSpace =
        prevWordEndedAsciiAlnum && ASCII_ALNUM_START_RE.test(tok.text);
      prevWordEndedAsciiAlnum = ASCII_ALNUM_END_RE.test(tok.text);

      const matchedOverlap =
        parsedOverlaps.length > 0
          ? parsedOverlaps.find(
              (ov) =>
                Math.min(tok.sourceEndMs, ov.endMs) - Math.max(tok.sourceStartMs, ov.startMs) >= 40
            )
          : undefined;

      const hasPendingTypo = Boolean(tok.aiSuggestedText && tok.text !== tok.aiSuggestedText);
      // Pure background-color highlight on selection & playhead — zero ring, zero border box, zero width jitter!
      const cls = [
        isCompact
          ? 'inline p-0 text-[13.5px] leading-[1.5] cursor-pointer transition-colors select-none'
          : 'inline p-0 text-[15.5px] leading-[1.72] cursor-pointer transition-colors select-none',
        tok.fillerTag === 'pure' ? 'token-filler-wavy text-amber-200/95' : 'text-zinc-100',
        hasPendingTypo ? 'token-typo-dotted' : '',
        tok.correctedStatus ? 'token-corrected-solid' : '',
        tok.sensitiveHint
          ? 'border-b border-dashed border-amber-400'
          : matchedOverlap && !isSelected
          ? 'border-b border-violet-400/65'
          : '',
        isSelected
          ? isActivePlayhead
            ? 'bg-blue-500/55 text-amber-100'
            : 'bg-blue-500/45 text-white'
          : isActivePlayhead
          ? 'bg-amber-500/28 text-amber-100'
          : matchedOverlap
          ? 'bg-violet-500/10 hover:bg-zinc-800/85'
          : 'hover:bg-zinc-800/75',
      ]
        .filter(Boolean)
        .join(' ');

      const overlapTip = matchedOverlap
        ? ` · 🔀 与副轨「${matchedOverlap.secName}」语音重合（默认已降低副轨音量）`
        : '';
      const tooltip = hasPendingTypo
        ? `疑似同音错别字（AI建议改为「${tok.aiSuggestedText}」），单击跳转进度条，双击无损改字不伤音频${overlapTip}`
        : tok.fillerTag === 'pure'
        ? `AI识别：纯语流口癖（单击跳转进度条，可一键安全清理并隐藏）${overlapTip}`
        : tok.fillerTag === 'semantic_keep'
        ? `AI识别：语义实词（单击跳转进度条，自动锁定保护）${overlapTip}`
        : `${tok.durationSec.toFixed(2)}s · 单击直接跳转播放进度条 · 滑选修改背景色后按 Delete 删除 · 双击改错字${overlapTip}`;

      elements.push(
        <span
          key={tok.id}
          data-transcript-token="1"
          data-token-id={tok.id}
          data-token-flat-idx={idx}
          title={tooltip}
          onMouseDown={(e) => {
            if (e.button !== 0 || interactionMode === 'text_proofread') return;
            if (e.altKey) {
              callbacksRef.current.seekToTokenId(tok.id);
              return;
            }
            if (e.shiftKey) return;
            callbacksRef.current.dragSelectRef.current = {
              active: true,
              moved: false,
              anchorIdx: idx,
              additive: e.metaKey || e.ctrlKey,
            };
          }}
          onMouseEnter={() => {
            if (callbacksRef.current.dragSelectRef.current.active) {
              callbacksRef.current.dragSelectRef.current.moved = true;
              callbacksRef.current.onSelectRange(
                callbacksRef.current.dragSelectRef.current.anchorIdx,
                idx,
                callbacksRef.current.dragSelectRef.current.additive
              );
            }
          }}
          onClick={(e) => {
            if (e.altKey) return;
            const cb = callbacksRef.current;
            if (interactionMode === 'text_proofread') {
              cb.seekToTokenId(tok.id);
              cb.openEditorForToken(tok);
              return;
            }
            if (cb.dragSelectRef.current.moved) {
              cb.dragSelectRef.current.moved = false;
              cb.seekToRangeStart(cb.dragSelectRef.current.anchorIdx, idx);
              cb.lastClickedIdxRef.current = idx;
              return;
            }
            if (e.shiftKey && cb.lastClickedIdxRef.current !== null) {
              cb.seekToRangeStart(cb.lastClickedIdxRef.current, idx);
            } else if (!e.metaKey && !e.ctrlKey) {
              cb.seekToTokenId(tok.id);
            }
            cb.lastClickedIdxRef.current = idx;
            cb.onSelectToken(tok.id, idx, e.shiftKey, e.metaKey || e.ctrlKey);
          }}
          onDoubleClick={() => callbacksRef.current.openEditorForToken(tok)}
          className={cls}
        >
          {needsAsciiSpace ? ` ${tok.text}` : tok.text}
          {tok.subwordTrimmed && (
            <span className="text-blue-400 font-mono text-[11px] ml-0.5 align-baseline" title="波形亚字级边界修剪">
              ⚡
            </span>
          )}
        </span>
      );
    }

    return <>{elements}</>;
  }
);

export const TranscriptWorkspace: React.FC<TranscriptWorkspaceProps> = React.memo(
  ({
    state,
    timeline,
    selectedIds,
    activeBlockId,
    activeTokenId,
    canUndo,
    onSelectToken,
    onSelectRange,
    onClearSelection,
    onSeekToSec,
    onFocusWaveformBlock,
    onSetGroupingMode,
    onSetSpeakerFilter,
    onSetInteractionMode,
    onToggleHideDeleted,
    onRippleDeleteSelected,
    onMuteTrackSelected,
    onBleepSelected,
    onAddSelectedToHighlight,
    onRestoreTokens,
    onShortenSilence,
    onAcceptAllAiCorrections,
    onApplyManualCorrection,
    onCleanSpeakerFillers,
    onCompressSpeakerSilence,
    onCleanMouthClicks,
    onToggleRetakeExpand,
    onToggleOverlapMute,
    onToggleOverlapKeepFull,
    onCancelDuckingSelected,
    onWaveformCutAction,
    onUndo,
    onResetAllEdits,
    onRetranscribe,
    onOpenSubtitleCorrection,
    onDropSubtitleFile,
    onRenameSpeakerTrack,
    onReorderBlocks,
    onOpenShownotes,
    onSeekToHighlight,
    onRemoveHighlight,
    onUpdateState,
    onAiAutoFillHighlights,
    onCopyQuotes,
    onNotify,
    onOpenHighlightEditModal,
    isPlaying = false,
    onTogglePlay,
    onSeekAndPlay,
  }) => {
    const [isCompact, setIsCompact] = useState<boolean>(() => {
      try {
        return localStorage.getItem('podcraft_compact_transcript') !== 'false';
      } catch {
        return true;
      }
    });

    const toggleCompact = () => {
      setIsCompact((prev) => {
        const next = !prev;
        try {
          localStorage.setItem('podcraft_compact_transcript', String(next));
        } catch {}
        return next;
      });
    };

    // Outline management state
    const [outlineSections, setOutlineSections] = useState<OutlineSection[]>([]);
    const [expandedSectionIds, setExpandedSectionIds] = useState<Set<string>>(new Set());
    const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
    const [draftSectionTitle, setDraftSectionTitle] = useState('');
    const [dragSectionIdx, setDragSectionIdx] = useState<number | null>(null);
    const [dragOverSectionIdx, setDragOverSectionIdx] = useState<number | null>(null);

    // 仅保留主发言，隐藏重叠插入短句状态（默认开启）
    const [hideOverlapBackchannels, setHideOverlapBackchannels] = useState<boolean>(() => {
      try {
        return localStorage.getItem('podcraft_hide_overlap_backchannels') !== 'false';
      } catch {
        return true;
      }
    });

    const toggleHideOverlapBackchannels = () => {
      setHideOverlapBackchannels((prev) => {
        const next = !prev;
        try {
          localStorage.setItem('podcraft_hide_overlap_backchannels', String(next));
        } catch {}
        return next;
      });
    };

    // 口水词过滤开关状态
    const [hideFillerWords, setHideFillerWords] = useState<boolean>(false);

    // 统计项目中全部口水词数量
    const totalFillerCount = useMemo(() => {
      let count = 0;
      for (const b of state.blocks) {
        for (const t of b.tokens) {
          if (t.fillerTag === 'pure' && !t.deleted) count++;
        }
      }
      return count;
    }, [state.blocks]);

    // Sync or initial generate outlines
    useEffect(() => {
      if (state.blocks.length === 0) {
        setOutlineSections([]);
        return;
      }
      const fresh = analyzeTranscriptOutlines(state, timeline);
      setOutlineSections(fresh);
      setExpandedSectionIds((prev) => {
        if (prev.size === 0) {
          return new Set(fresh.map((s) => s.id));
        }
        return prev;
      });
    }, [state.blocks, timeline]);

    const handleAnalyzeOutlines = () => {
      const fresh = analyzeTranscriptOutlines(state, timeline);
      setOutlineSections(fresh);
      setExpandedSectionIds(new Set(fresh.map((s) => s.id)));
      if (onReorderBlocks) {
        const updated = syncOutlineTitlesToBlocks(state.blocks, fresh);
        onReorderBlocks(updated);
      }
    };

    const handleMoveSection = (fromIdx: number, toIdx: number) => {
      if (!onReorderBlocks) return;
      const { newSections, newBlocks } = reorderOutlineSections(
        outlineSections,
        fromIdx,
        toIdx,
        state.blocks
      );
      setOutlineSections(newSections);
      onReorderBlocks(newBlocks);
    };

    const toggleSectionExpand = (secId: string) => {
      setExpandedSectionIds((prev) => {
        const next = new Set(prev);
        if (next.has(secId)) next.delete(secId);
        else next.add(secId);
        return next;
      });
    };

    const toggleAllSectionsExpand = () => {
      if (expandedSectionIds.size === outlineSections.length) {
        setExpandedSectionIds(new Set());
      } else {
        setExpandedSectionIds(new Set(outlineSections.map((s) => s.id)));
      }
    };

    const startEditSectionTitle = (secId: string, currentTitle: string) => {
      setEditingSectionId(secId);
      setDraftSectionTitle(currentTitle);
    };

    const commitSectionTitle = (secId: string) => {
      const trimmed = draftSectionTitle.trim();
      if (trimmed) {
        const updatedSections = outlineSections.map((s) =>
          s.id === secId ? { ...s, title: trimmed } : s
        );
        setOutlineSections(updatedSections);
        if (onReorderBlocks) {
          const updatedBlocks = syncOutlineTitlesToBlocks(state.blocks, updatedSections);
          onReorderBlocks(updatedBlocks);
        }
      }
      setEditingSectionId(null);
    };

    const [editingToken, setEditingToken] = useState<TranscriptToken | null>(null);
    const [draftText, setDraftText] = useState('');
    const [saveToGlossary, setSaveToGlossary] = useState(true);
    const [renamingSpeakerKey, setRenamingSpeakerKey] = useState<string | null>(null);
    const [draftSpeakerName, setDraftSpeakerName] = useState('');

    const commitInlineSpeakerRename = (trackId: string) => {
      const trimmed = draftSpeakerName.trim();
      if (trimmed && onRenameSpeakerTrack) {
        onRenameSpeakerTrack(trackId, trimmed);
      }
      setRenamingSpeakerKey(null);
    };

    // Drag-to-select state across character/word tokens
    const dragSelectRef = useRef<{
      active: boolean;
      moved: boolean;
      anchorIdx: number;
      additive: boolean;
    }>({ active: false, moved: false, anchorIdx: 0, additive: false });

    const transcriptScrollRef = useRef<HTMLDivElement>(null);
    const transcriptManualScrollUntilRef = useRef(0);
    const [tokenContextMenu, setTokenContextMenu] = useState<{
      x: number;
      y: number;
    } | null>(null);

    const isSelectedTokensAllFullVolume = useMemo(() => {
      if (selectedIds.size === 0) return false;
      const selTokens = timeline.mappedTokens.filter(
        (m) => !m.token.deleted && selectedIds.has(m.tokenId)
      );
      const blockIds = new Set(selTokens.map((m) => m.blockId).filter(Boolean));
      const relevantBlocks = state.blocks.filter((b) => blockIds.has(b.blockId));
      return (
        relevantBlocks.length > 0 &&
        relevantBlocks.every((b) => Boolean(b.overlapNote?.keepFullVolume))
      );
    }, [selectedIds, timeline.mappedTokens, state.blocks]);

    const isSelectedTokensAllBleeped = useMemo(() => {
      if (selectedIds.size === 0) return false;
      const selTokens = timeline.mappedTokens.filter(
        (m) => !m.token.deleted && selectedIds.has(m.tokenId) && m.token.type !== 'silence'
      );
      return selTokens.length > 0 && selTokens.every((m) => Boolean(m.token.bleeped));
    }, [selectedIds, timeline.mappedTokens]);

    useEffect(() => {
      if (!tokenContextMenu) return;
      const close = () => setTokenContextMenu(null);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') close();
      };
      window.addEventListener('pointerdown', close);
      window.addEventListener('keydown', onKey);
      return () => {
        window.removeEventListener('pointerdown', close);
        window.removeEventListener('keydown', onKey);
      };
    }, [tokenContextMenu]);

    useEffect(() => {
      if (!activeBlockId) return;
      if (Date.now() < transcriptManualScrollUntilRef.current) return;
      const container = transcriptScrollRef.current;
      if (!container) return;
      const activeEl = container.querySelector<HTMLElement>('[data-active-transcript-block="1"]');
      if (!activeEl) return;
      const containerRect = container.getBoundingClientRect();
      const elRect = activeEl.getBoundingClientRect();
      const relativeTop = elRect.top - containerRect.top;
      const targetTop = Math.max(
        0,
        container.scrollTop + relativeTop - container.clientHeight * 0.35
      );
      if (Math.abs(container.scrollTop - targetTop) < 16) return;
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({ top: targetTop, behavior: 'smooth' });
      } else {
        container.scrollTop = targetTop;
      }
    }, [activeBlockId, state.groupingMode, state.speakerFilter]);

    useEffect(() => {
      const handleGlobalMouseUp = () => {
        if (dragSelectRef.current.active) {
          dragSelectRef.current.active = false;
        }
      };
      window.addEventListener('mouseup', handleGlobalMouseUp);
      return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
    }, []);

    const hideDeleted = state.hideDeletedTokens !== false;

    const speakerMap = useMemo(
      () => Object.fromEntries(state.tracks.map((t) => [t.id, t])),
      [state.tracks]
    );

    const blockMap = useMemo(
      () => Object.fromEntries(state.blocks.map((b) => [b.blockId, b])),
      [state.blocks]
    );

    const editableSpeakerTracks = useMemo(
      () =>
        state.tracks.some((t) => !t.isRef)
          ? state.tracks.filter((t) => !t.isRef)
          : state.tracks,
      [state.tracks]
    );

    // Precompute flat index map and token -> block map so hiding deleted tokens never breaks Shift/drag indices
    // and token selection diffs remain O(selectedIds.size) instead of touching 30,000 tokens
    const { flatIndexById, flatTokenIds, tokenToBlockId } = useMemo(() => {
      const map: Record<string, number> = {};
      const ids: string[] = [];
      const blkByTok: Record<string, string> = {};
      state.blocks.forEach((b) =>
        b.tokens.forEach((t) => {
          map[t.id] = ids.length;
          ids.push(t.id);
          blkByTok[t.id] = b.blockId;
        })
      );
      return { flatIndexById: map, flatTokenIds: ids, tokenToBlockId: blkByTok };
    }, [state.blocks]);

    const selectionKeyByBlock = useMemo(() => {
      const byBlk: Record<string, string> = {};
      selectedIds.forEach((id) => {
        const bid = tokenToBlockId[id];
        if (bid) {
          byBlk[bid] = byBlk[bid] ? `${byBlk[bid]},${id}` : id;
        }
      });
      return byBlk;
    }, [selectedIds, tokenToBlockId]);

    const chronologicalGroups = useMemo(
      () => coalesceChronologicalBlocks(state.blocks),
      [state.blocks]
    );

    const { overlapsByBlock, overlapKeyByBlock } = useMemo(() => {
      const byBlk: Record<string, OverlapTimelineRegion[]> = {};
      const keyByBlk: Record<string, string> = {};
      for (const ov of timeline.overlapRegions) {
        if (!byBlk[ov.blockId]) byBlk[ov.blockId] = [];
        byBlk[ov.blockId].push(ov);
      }
      for (const [bid, arr] of Object.entries(byBlk)) {
        keyByBlk[bid] = arr
          .map((o) => `${o.sourceStartMs}:${o.sourceEndMs}:${o.secondarySpeakerName}`)
          .join('|');
      }
      return { overlapsByBlock: byBlk, overlapKeyByBlock: keyByBlk };
    }, [timeline.overlapRegions]);

    const overlapJumpIdxRef = useRef(0);
    const jumpToNextOverlap = () => {
      if (timeline.overlapRegions.length === 0) return;
      const target =
        timeline.overlapRegions[overlapJumpIdxRef.current % timeline.overlapRegions.length];
      overlapJumpIdxRef.current =
        (overlapJumpIdxRef.current + 1) % timeline.overlapRegions.length;
      onSeekToSec(target.editedStartSec);
    };

    const renderOverlapTrackBars = (ovList: OverlapTimelineRegion[]) => {
      if (hideOverlapBackchannels || ovList.length === 0) return null;
      return (
        <div className="mt-1.5 space-y-1">
          {ovList.map((ov) => {
            const secSp = speakerMap[ov.secondarySpeakerId];
            const secColor = secSp?.color || '#a855f7';
            const ovDurSec = Math.max(0.1, ov.editedEndSec - ov.editedStartSec);
            const fallbackSpec = {
              speakerId: ov.secondarySpeakerId,
              speakerName: ov.secondarySpeakerName,
              text: ov.text,
              sourceStartMs: ov.sourceStartMs,
              sourceEndMs: ov.sourceEndMs,
            };
            const isAutoDucked =
              !ov.muted && !ov.keepFullVolume && state.autoSoloMode !== 'off';

            return (
              <div
                key={ov.id}
                className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-zinc-950/95 border border-violet-500/30 text-xs"
              >
                <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: secColor }}
                  />
                  <span className="font-semibold text-violet-200">
                    🔀 语音重合轨 · {secSp?.name || ov.secondarySpeakerName}
                  </span>
                  <button
                    type="button"
                    onClick={() => onSeekToSec(ov.editedStartSec)}
                    title="点击定位试听此段多轨语音重合位置"
                    className="font-mono text-[11px] text-blue-400 hover:text-blue-300 cursor-pointer"
                  >
                    @{formatMmSs(ov.editedStartSec)} ({ovDurSec.toFixed(1)}s)
                  </button>
                  {ov.text && (
                    <span
                      className={
                        ov.muted ? 'line-through text-zinc-500 truncate' : 'text-zinc-300 truncate'
                      }
                    >
                      “{ov.text}”
                    </span>
                  )}
                  {ov.muted ? (
                    <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 text-[11px]">
                      副轨已静音
                    </span>
                  ) : isAutoDucked ? (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[11px]">
                      非主讲已自动降音
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[11px]">
                      副轨原声保留
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {onFocusWaveformBlock && (
                    <button
                      type="button"
                      onClick={() => onFocusWaveformBlock(ov.editedStartSec, ov.editedEndSec, ov.primarySpeakerId)}
                      title="在多轨波形中框选此重合段进行精剪"
                      className="text-purple-300 hover:text-purple-200 hover:underline font-medium cursor-pointer"
                    >
                      剪辑选区
                    </button>
                  )}
                  {onWaveformCutAction && (
                    <button
                      type="button"
                      onClick={() => onWaveformCutAction(ov.editedStartSec, ov.editedEndSec, 'ripple_all')}
                      title="一键切除全轨此语音重合区间"
                      className="text-red-400 hover:text-red-300 hover:underline font-medium cursor-pointer"
                    >
                      剪掉重合
                    </button>
                  )}
                  {onToggleOverlapKeepFull && !ov.muted && (
                    <button
                      type="button"
                      onClick={() => onToggleOverlapKeepFull(ov.blockId, fallbackSpec)}
                      className="text-violet-300 hover:text-violet-200 hover:underline font-medium cursor-pointer"
                    >
                      {ov.keepFullVolume ? '恢复自动降音' : '切换原声'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onToggleOverlapMute(ov.blockId, fallbackSpec)}
                    className="text-blue-400 hover:text-blue-300 hover:underline font-medium cursor-pointer"
                  >
                    {ov.muted ? '取消静音' : '彻底静音副轨'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      );
    };

    const bySpeakerStats = useMemo(() => {
      const map: Record<
        string,
        {
          spBlocks: typeof state.blocks;
          keptSec: number;
          deletedSec: number;
          fillerCount: number;
        }
      > = {};
      for (const sp of editableSpeakerTracks) {
        map[sp.id] = { spBlocks: [], keptSec: 0, deletedSec: 0, fillerCount: 0 };
      }
      for (const b of state.blocks) {
        const entry = map[b.speakerId];
        if (!entry) continue;
        let hasVisible = !hideDeleted;
        for (const tok of b.tokens) {
          if (tok.deleted) entry.deletedSec += tok.origDurationSec;
          else {
            entry.keptSec += tok.durationSec;
            if (tok.type !== 'silence') hasVisible = true;
          }
          if (tok.fillerTag === 'pure' && !tok.deleted) entry.fillerCount++;
        }
        if (hasVisible) entry.spBlocks.push(b);
      }
      return map;
    }, [state.blocks, editableSpeakerTracks, hideDeleted]);

    // Map tokenId -> editedStartSec and blockId -> [startSec, endSec] for direct click-to-jump & waveform focus
    const { tokenEditedStartMap, blockEditedRangeMap } = useMemo(() => {
      const map: Record<string, number> = {};
      const blkRanges: Record<
        string,
        { startSec: number; endSec: number; speakerId: string }
      > = {};
      timeline.mappedTokens.forEach((m) => {
        map[m.token.id] = m.editedStartSec;
        if (m.token.deleted) return;
        const existing = blkRanges[m.blockId];
        if (!existing) {
          blkRanges[m.blockId] = {
            startSec: m.editedStartSec,
            endSec: m.editedEndSec,
            speakerId: m.speakerId,
          };
        } else {
          existing.startSec = Math.min(existing.startSec, m.editedStartSec);
          existing.endSec = Math.max(existing.endSec, m.editedEndSec);
        }
      });
      return { tokenEditedStartMap: map, blockEditedRangeMap: blkRanges };
    }, [timeline.mappedTokens]);

    const lastClickedIdxRef = useRef<number | null>(null);

    const seekToTokenId = (tokenId?: string) => {
      if (!tokenId) return;
      const jumpSec = tokenEditedStartMap[tokenId];
      if (typeof jumpSec === 'number') {
        onSeekToSec(jumpSec);
        onFocusWaveformBlock?.(jumpSec, jumpSec + 1.0, '', jumpSec, true);
      }
    };

    const seekToRangeStart = (idxA: number, idxB: number) => {
      const lo = Math.max(0, Math.min(idxA, idxB));
      const hi = Math.min(flatTokenIds.length - 1, Math.max(idxA, idxB));
      for (let k = lo; k <= hi; k++) {
        const id = flatTokenIds[k];
        const jumpSec = id ? tokenEditedStartMap[id] : undefined;
        if (typeof jumpSec === 'number') {
          onSeekToSec(jumpSec);
          onFocusWaveformBlock?.(jumpSec, jumpSec + 1.0, '', jumpSec, true);
          return;
        }
      }
    };

    const {
      pendingTypos,
      deletedCount,
      deletedSecTotal,
      hasAcousticPlaceholders,
      keptTokenById,
    } = useMemo(() => {
      const typos: TranscriptToken[] = [];
      let delCount = 0;
      let delSec = 0;
      let placeholders = false;
      const byId = new Map<string, TranscriptToken>();

      state.blocks.forEach((b) =>
        b.tokens.forEach((t) => {
          if (t.deleted) {
            delCount++;
            delSec += t.origDurationSec;
          } else {
            byId.set(t.id, t);
            if (t.aiSuggestedText && t.text !== t.aiSuggestedText) {
              typos.push(t);
            }
            if (t.text.startsWith('[语音 ') || t.text.startsWith('[音轨片段')) {
              placeholders = true;
            }
          }
        })
      );

      return {
        pendingTypos: typos,
        deletedCount: delCount,
        deletedSecTotal: delSec,
        hasAcousticPlaceholders: placeholders,
        keptTokenById: byId,
      };
    }, [state.blocks]);

    const { selectedDuration, selectedPreviewText } = useMemo(() => {
      if (selectedIds.size === 0) {
        return { selectedDuration: 0, selectedPreviewText: '' };
      }
      let selDur = 0;
      let previewText = '';
      let previewTruncated = false;

      selectedIds.forEach((id) => {
        const t = keptTokenById.get(id);
        if (!t) return;
        selDur += t.durationSec;
        if (!previewTruncated) {
          previewText += t.type === 'silence' ? `[空白${t.durationSec.toFixed(1)}s]` : t.text;
          if (previewText.length > 26) {
            previewText = `${previewText.slice(0, 26)}…`;
            previewTruncated = true;
          }
        }
      });

      return {
        selectedDuration: selDur,
        selectedPreviewText: previewText,
      };
    }, [selectedIds, keptTokenById]);

    const openEditorForToken = (tok: TranscriptToken) => {
      if (tok.type !== 'word') return;
      setEditingToken(tok);
      setDraftText(
        tok.aiSuggestedText && tok.text !== tok.aiSuggestedText ? tok.aiSuggestedText : tok.text
      );
    };

    const triggerManualEditButton = () => {
      if (selectedIds.size > 0) {
        const firstId = selectedIds.values().next().value;
        const found = firstId ? keptTokenById.get(firstId) : undefined;
        if (found && found.type === 'word') {
          openEditorForToken(found);
          return;
        }
      }
      if (pendingTypos.length > 0) {
        openEditorForToken(pendingTypos[0]);
      }
    };

    const submitManualEdit = () => {
      if (!editingToken || !draftText.trim()) return;
      onApplyManualCorrection(editingToken.id, draftText.trim(), saveToGlossary);
      setEditingToken(null);
    };

    const blockCallbacksRef = useRef<BlockTokenCallbacks>({
      flatIndexById,
      dragSelectRef,
      lastClickedIdxRef,
      seekToTokenId,
      seekToRangeStart,
      onSelectToken,
      onSelectRange,
      onRestoreTokens,
      onShortenSilence,
      openEditorForToken,
    });
    blockCallbacksRef.current = {
      flatIndexById,
      dragSelectRef,
      lastClickedIdxRef,
      seekToTokenId,
      seekToRangeStart,
      onSelectToken,
      onSelectRange,
      onRestoreTokens,
      onShortenSilence,
      openEditorForToken,
    };

    return (
      <main
        onDragOver={(e) => {
          if (onDropSubtitleFile) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!onDropSubtitleFile) return;
          const f = e.dataTransfer.files?.[0];
          if (!f) return;
          const lower = f.name.toLowerCase();
          if (
            /\.(srt|vtt|ass|ssa|lrc|txt|md|bcc|json)$/i.test(lower) &&
            !lower.endsWith('.podcraft')
          ) {
            e.preventDefault();
            onDropSubtitleFile(f);
          }
        }}
        className="flex-1 min-w-0 bg-zinc-950 flex flex-col h-full min-h-0 overflow-hidden"
      >
        {/* 文档视图：只保留自然段成稿，不能改字 */}
        <TextEditorModeWorkspace
          state={state}
          timeline={timeline}
          hideDeleted={hideDeleted}
          hideFillerWords={hideFillerWords}
          activeTokenId={activeTokenId}
          onToggleHideFillerWords={() => setHideFillerWords((v) => !v)}
          onSeekToSec={onSeekToSec}
          onFocusWaveformBlock={onFocusWaveformBlock}
          onApplyManualCorrection={onApplyManualCorrection}
          onRenameSpeakerTrack={onRenameSpeakerTrack}
          onAddSelectedToHighlight={onAddSelectedToHighlight}
          onRetranscribe={onRetranscribe}
          onOpenAiTimeline={() => onOpenShownotes?.('timeline')}
          onSeekToHighlight={onSeekToHighlight}
          onRemoveHighlight={onRemoveHighlight}
          onUpdateState={onUpdateState}
          onAiAutoFillHighlights={onAiAutoFillHighlights}
          onCopyQuotes={onCopyQuotes}
          onNotify={onNotify}
          onOpenHighlightEditModal={onOpenHighlightEditModal}
          isPlaying={isPlaying}
          onTogglePlay={onTogglePlay}
          onSeekAndPlay={onSeekAndPlay}
        />
      </main>
    );
  }
);
