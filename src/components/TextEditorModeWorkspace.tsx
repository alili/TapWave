import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  HighlightClip,
  PodcastProjectState,
  TranscriptBlock,
  TranscriptToken,
  SpeakerRole,
  ShownotesTimelineItem,
} from '../types/podcast';
import { TimelineComputation, formatMmSs } from '../engine/timelineEngine';
import { buildTimelineItemsFromProject } from '../engine/shownotesGenerator';
import { useActiveTokenId } from '../engine/playheadStore';
import { HighlightEditModal } from './HighlightEditModal';
import {
  ListTree,
  MessageSquare,
  Sparkles,
  RefreshCw,
  Check,
  X,
  Play,
  Pause,
  Edit3,
  Eye,
  EyeOff,
  Palette,
  Users,
  MessageCircle,
  FileCheck,
  CheckCircle2,
  CornerDownRight,
  BookOpen,
  Volume2,
  Quote,
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  Copy,
} from 'lucide-react';

export interface TextEditorReviewComment {
  id: string;
  authorName: string;
  authorAvatar: string;
  authorColor: string;
  targetQuote: string;
  targetParagraphId: string;
  content: string;
  createdAt: string;
  resolved: boolean;
}

export interface TextEditorSuggestion {
  id: string;
  authorName: string;
  authorColor: string;
  targetParagraphId: string;
  originalText: string;
  suggestedText: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
}

export interface FlatTokenItem {
  tokenId: string;
  blockId: string;
  speakerId: string;
  speakerName: string;
  speakerColor: string;
  text: string;
  startSec: number;
  endSec: number;
  isFiller: boolean;
}

export interface InlineUtteranceSpan {
  id: string;
  tokenId?: string;
  speakerId: string;
  speakerName: string;
  speakerColor: string;
  text: string;
  isFiller: boolean;
  startSec: number;
  endSec: number;
  tokens: FlatTokenItem[];
}

export interface NaturalParagraph {
  id: string;
  sectionId: string;
  startSec: number;
  endSec: number;
  spans: InlineUtteranceSpan[];
  tokens: FlatTokenItem[];
  charCount: number;
  fillerCount: number;
}

export interface DocumentSection {
  id: string;
  title: string;
  summary?: string;
  startSec: number;
  endSec: number;
  paragraphs: NaturalParagraph[];
  wordCount: number;
}

interface TextEditorModeWorkspaceProps {
  state: PodcastProjectState;
  timeline: TimelineComputation;
  hideDeleted: boolean;
  hideFillerWords: boolean;
  activeTokenId?: string | null;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  onSeekAndPlay?: (sec: number) => void;
  onToggleHideFillerWords: () => void;
  onSeekToSec: (sec: number) => void;
  onFocusWaveformBlock?: (
    startSec: number,
    endSec: number,
    speakerId: string,
    anchorSec?: number,
    preserveHigherZoom?: boolean
  ) => void;
  onApplyManualCorrection?: (tokenId: string, newText: string, saveToGlossary: boolean) => void;
  onRenameSpeakerTrack?: (trackId: string, newName?: string, newRole?: SpeakerRole) => void;
  onAddSelectedToHighlight?: (options?: {
    text?: string;
    startSec?: number;
    endSec?: number;
    speakerId?: string;
    isEditedTime?: boolean;
  }) => void;
  onRetranscribe?: () => void;
  onOpenAiTimeline?: () => void;
  onSeekToHighlight?: (hl: HighlightClip) => void;
  onRemoveHighlight?: (id: string) => void;
  onUpdateState?: (updater: (prev: PodcastProjectState) => PodcastProjectState) => void;
  onAiAutoFillHighlights?: () => void;
  onCopyQuotes?: () => void;
  onNotify?: (msg: string) => void;
  onOpenHighlightEditModal?: (hl: HighlightClip) => void;
}

export const TextEditorModeWorkspace: React.FC<TextEditorModeWorkspaceProps> = React.memo(({
  state,
  timeline,
  hideDeleted,
  hideFillerWords,
  activeTokenId: activeTokenIdProp,
  isPlaying = false,
  onTogglePlay,
  onSeekAndPlay,
  onToggleHideFillerWords,
  onSeekToSec,
  onFocusWaveformBlock,
  onApplyManualCorrection,
  onRenameSpeakerTrack,
  onAddSelectedToHighlight,
  onRetranscribe,
  onOpenAiTimeline,
  onSeekToHighlight,
  onRemoveHighlight,
  onUpdateState,
  onAiAutoFillHighlights,
  onCopyQuotes,
  onNotify,
  onOpenHighlightEditModal,
}) => {
  const storeActiveTokenId = useActiveTokenId();
  const activeTokenId = activeTokenIdProp ?? storeActiveTokenId;
  // 配色模式：彩色发言人字体 vs 沉浸纯黑字体
  const [colorMode, setColorMode] = useState<'colored' | 'monochrome'>('colored');
  // 侧边栏折叠状态：大纲与批注
  const [showOutline, setShowOutline] = useState<boolean>(true);
  const [showComments, setShowComments] = useState<boolean>(true);
  // 侧边栏 Tab 标签：大纲 vs 金句
  const [sidebarTab, setSidebarTab] = useState<'outline' | 'highlights'>('outline');
  // 独立波形弹窗编辑状态（当未从顶层传入 modal 时的本地自闭环支持）
  const [localEditingHighlight, setLocalEditingHighlight] = useState<HighlightClip | null>(null);
  // 右键快捷菜单（支持加入金句）
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    text: string;
    paragraphId: string;
    startSec: number;
    endSec: number;
    speakerId: string;
  } | null>(null);

  useEffect(() => {
    const handleCloseMenu = () => setContextMenu(null);
    window.addEventListener('click', handleCloseMenu);
    return () => window.removeEventListener('click', handleCloseMenu);
  }, []);

  // 统一跳转并播放处理（解决点击播放无反应问题）
  const handleJumpAndPlay = useCallback(
    (targetSec: number) => {
      if (onSeekAndPlay) {
        onSeekAndPlay(targetSec);
      } else {
        onSeekToSec(targetSec);
        if (!isPlaying && onTogglePlay) {
          onTogglePlay();
        }
      }
    },
    [onSeekAndPlay, onSeekToSec, isPlaying, onTogglePlay]
  );
  // 选中的发言人过滤
  const [selectedSpeakerFilter, setSelectedSpeakerFilter] = useState<string>('all');
  // 仅保留主发言（过滤重叠插入短句）
  const [hideOverlapBackchannels, setHideOverlapBackchannels] = useState<boolean>(() => {
    try {
      return localStorage.getItem('podcraft_hide_overlap_backchannels') !== 'false';
    } catch {
      return true;
    }
  });
  // 当前激活/定位的 Section 或段落
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);

  // 审阅批注列表
  const [comments, setComments] = useState<TextEditorReviewComment[]>([]);

  // 划词操作浮层状态（带精确时间段与发言人）
  const [selectionRange, setSelectionRange] = useState<{
    text: string;
    paragraphId: string;
    startSec: number;
    endSec: number;
    speakerId: string;
    x: number;
    y: number;
  } | null>(null);

  // 批注输入框弹窗状态
  const [draftCommentText, setDraftCommentText] = useState('');
  const [showCommentInput, setShowCommentInput] = useState(false);

  // 发言人映射表
  const speakerMap = useMemo(() => {
    const map: Record<string, { name: string; color: string; role: string }> = {};
    for (const tr of state.tracks) {
      map[tr.id] = {
        name: tr.name || '发言人',
        color: tr.color || '#4f46e5',
        role: tr.role === 'host' ? '主讲人' : '嘉宾',
      };
    }
    return map;
  }, [state.tracks]);

  // 基于 Shownotes 算法自动划分 Section，并在 Section 内聚合成自然段
  const documentSections = useMemo<DocumentSection[]>(() => {
    // 1. 获取基于 Shownotes 语义算法提取的章节列表（优先使用已有或AI生成的时间轴）
    let timelineItems: ShownotesTimelineItem[] = [];
    try {
      if (state.shownotes?.timeline && state.shownotes.timeline.length > 0) {
        timelineItems = state.shownotes.timeline;
      } else {
        timelineItems = buildTimelineItemsFromProject(state, timeline);
      }
    } catch (e) {
      console.warn('Shownotes section generation fallback:', e);
    }

    // 若未提取出，或无章节，提供默认开场 Section
    if (!timelineItems || timelineItems.length === 0) {
      timelineItems = [
        {
          id: 'sec_default_1',
          timeSec: 0,
          title: '全文通读与核心对谈',
          summary: '本期主要对话与探讨全览',
        },
      ];
    }

    // 2. 收集所有未删除的 tokens 并按时间排序
    const flatTokens: FlatTokenItem[] = [];
    for (const m of timeline.mappedTokens) {
      if (m.token.deleted && hideDeleted) continue;
      if (m.token.type !== 'word') continue;

      const sp = speakerMap[m.speakerId] || {
        name: '发言人',
        color: '#6366f1',
        role: '嘉宾',
      };

      flatTokens.push({
        tokenId: m.token.id,
        blockId: m.blockId,
        speakerId: m.speakerId,
        speakerName: sp.name,
        speakerColor: sp.color,
        text: m.token.bleeped ? '[***]' : m.token.text,
        startSec: Math.max(0, m.editedStartSec),
        endSec: Math.max(0, m.editedEndSec),
        isFiller: m.token.fillerTag === 'pure',
      });
    }

    if (flatTokens.length === 0) return [];

    // 过滤与主发言重叠的副轨插入短句 (如附和词、时间被主发言包裹的零碎插话)
    const filterOverlapShortUtterances = (tokens: FlatTokenItem[]): FlatTokenItem[] => {
      if (tokens.length <= 1) return tokens;

      interface SpeakerTurn {
        speakerId: string;
        tokens: FlatTokenItem[];
        startSec: number;
        endSec: number;
        text: string;
      }

      const turns: SpeakerTurn[] = [];
      let currentTurn: SpeakerTurn | null = null;

      for (const tok of tokens) {
        if (
          !currentTurn ||
          currentTurn.speakerId !== tok.speakerId ||
          tok.startSec - currentTurn.endSec > 2.0
        ) {
          if (currentTurn) turns.push(currentTurn);
          currentTurn = {
            speakerId: tok.speakerId,
            tokens: [tok],
            startSec: tok.startSec,
            endSec: tok.endSec,
            text: tok.text,
          };
        } else {
          currentTurn.tokens.push(tok);
          currentTurn.endSec = Math.max(currentTurn.endSec, tok.endSec);
          currentTurn.text += tok.text;
        }
      }
      if (currentTurn) turns.push(currentTurn);

      const BACKCHANNEL_SHORT_RE =
        /^(对|对的|对对|对对对|没错|是的|是啊|确实|嗯|嗯嗯|好的|好|哈哈|是这样|对啊|原来如此|赞同|理解|原来是这样|OK|ok|yes|yeah|right)$/i;

      const ignoredTurnIndices = new Set<number>();

      for (let i = 0; i < turns.length; i++) {
        const turnA = turns[i];
        for (let j = 0; j < turns.length; j++) {
          if (i === j) continue;
          const turnB = turns[j];
          if (turnA.speakerId === turnB.speakerId) continue;

          // 检查 A 和 B 是否有时间重叠
          const ovStart = Math.max(turnA.startSec, turnB.startSec);
          const ovEnd = Math.min(turnA.endSec, turnB.endSec);
          if (ovEnd - ovStart >= 0.12) {
            const cleanB = turnB.text.replace(/\[[^\]]+\]/g, '').trim();
            const isBackchannelWord = BACKCHANNEL_SHORT_RE.test(cleanB);
            const isShortB = cleanB.length <= 8 || (turnB.endSec - turnB.startSec) <= 2.5;

            // 当 B 为短句/附和且 A 发言明显更长或为主发言时，忽略插入的短句 B，只保留主发言 A
            if (isShortB && (isBackchannelWord || turnA.tokens.length >= turnB.tokens.length * 2)) {
              ignoredTurnIndices.add(j);
            }
          }
        }
      }

      const result: FlatTokenItem[] = [];
      for (let i = 0; i < turns.length; i++) {
        if (!ignoredTurnIndices.has(i)) {
          result.push(...turns[i].tokens);
        }
      }
      return result;
    };

    const effectiveTokens = hideOverlapBackchannels
      ? filterOverlapShortUtterances(flatTokens)
      : flatTokens;

    // 3. 将 tokens 分配到各个 Section 中
    const sections: DocumentSection[] = [];
    for (let sIdx = 0; sIdx < timelineItems.length; sIdx++) {
      const curItem = timelineItems[sIdx];
      const nextItem = timelineItems[sIdx + 1];
      const secStartSec = curItem.timeSec;
      const secEndSec = nextItem ? nextItem.timeSec : Infinity;

      const secTokens = effectiveTokens.filter(
        (t) => t.startSec >= secStartSec && (nextItem ? t.startSec < secEndSec : true)
      );

      if (secTokens.length === 0 && sIdx > 0) continue;

      // 4. 在该 Section 内部，按照语义与篇章逻辑聚合成自然段（Natural Paragraphs）
      // 关键点：不再每个发言人一块，而是自然流畅成段！段内不同发言人用字体颜色直接区分
      const paragraphs: NaturalParagraph[] = [];
      let currentSpans: InlineUtteranceSpan[] = [];
      let currentTokens: FlatTokenItem[] = [];
      let curParaCharCount = 0;
      let curParaFillerCount = 0;
      let curParaStartSec = secTokens.length > 0 ? secTokens[0].startSec : secStartSec;
      let curParaEndSec = curParaStartSec;

      const flushParagraph = () => {
        if (currentSpans.length === 0) return;
        paragraphs.push({
          id: `p-${sections.length}-${paragraphs.length}`,
          sectionId: curItem.id,
          startSec: curParaStartSec,
          endSec: curParaEndSec,
          spans: currentSpans,
          tokens: currentTokens,
          charCount: curParaCharCount,
          fillerCount: curParaFillerCount,
        });
        currentSpans = [];
        currentTokens = [];
        curParaCharCount = 0;
        curParaFillerCount = 0;
      };

      for (let tIdx = 0; tIdx < secTokens.length; tIdx++) {
        const item = secTokens[tIdx];

        // 口水词过滤判断
        if (hideFillerWords && item.isFiller) {
          curParaFillerCount++;
          continue;
        }

        const prevToken = secTokens[tIdx - 1];
        const isTimeGap = prevToken && item.startSec - prevToken.endSec >= 3.5;
        const prevEndsWithPunct =
          currentSpans.length > 0 &&
          /[。！？!?\n]/.test(currentSpans[currentSpans.length - 1].text.slice(-1));
        const isCharLimitReached = curParaCharCount >= 180 && prevEndsWithPunct;
        const isHardCharLimit = curParaCharCount >= 320;

        // 起新自然段条件：停顿长、或者字数达到自然段并且刚好处在完整句末
        if ((isTimeGap || isCharLimitReached || isHardCharLimit) && currentSpans.length > 0) {
          flushParagraph();
          curParaStartSec = item.startSec;
        }

        curParaEndSec = Math.max(curParaEndSec, item.endSec);
        curParaCharCount += item.text.length;
        currentTokens.push(item);
        if (item.isFiller) curParaFillerCount++;

        // 检查能否合并进上一 span（同一发言人）
        const lastSpan = currentSpans[currentSpans.length - 1];
        if (lastSpan && lastSpan.speakerId === item.speakerId) {
          lastSpan.text += item.text;
          lastSpan.endSec = item.endSec;
          lastSpan.tokens.push(item);
        } else {
          currentSpans.push({
            id: `span-${item.tokenId}`,
            tokenId: item.tokenId,
            speakerId: item.speakerId,
            speakerName: item.speakerName,
            speakerColor: item.speakerColor,
            text: item.text,
            isFiller: item.isFiller,
            startSec: item.startSec,
            endSec: item.endSec,
            tokens: [item],
          });
        }
      }
      flushParagraph();

      const totalSecWords = paragraphs.reduce((sum, p) => sum + p.charCount, 0);

      sections.push({
        id: curItem.id,
        title: curItem.title || `第 ${sections.length + 1} 节`,
        summary: curItem.summary,
        startSec: secStartSec,
        endSec: nextItem ? nextItem.timeSec : timeline.totalEditedDurationSec,
        paragraphs,
        wordCount: totalSecWords,
      });
    }

    return sections;
  }, [state, timeline, hideDeleted, hideFillerWords, speakerMap]);

  // 智能解析用户在段落中划选文本的精准时间段与发言人
  const resolveSelectionTimeInfo = (
    para: NaturalParagraph,
    selectedText: string,
    selection: Selection | null
  ) => {
    const cleanSel = selectedText.trim();
    if (!cleanSel) {
      return {
        text: '',
        startSec: para.startSec,
        endSec: para.endSec,
        speakerId: para.spans[0]?.speakerId || '',
      };
    }

    // 1. 如果有 Selection，尝试从 DOM Range 节点直接查找首尾 token 元素
    if (selection && selection.rangeCount > 0) {
      try {
        const range = selection.getRangeAt(0);
        const startEl = (
          range.startContainer.nodeType === Node.ELEMENT_NODE
            ? (range.startContainer as HTMLElement)
            : range.startContainer.parentElement
        )?.closest<HTMLElement>('[data-token-id]');

        const endEl = (
          range.endContainer.nodeType === Node.ELEMENT_NODE
            ? (range.endContainer as HTMLElement)
            : range.endContainer.parentElement
        )?.closest<HTMLElement>('[data-token-id]');

        if (startEl && endEl) {
          const sSec = Number(startEl.dataset.startSec);
          const eSec = Number(endEl.dataset.endSec);
          const spId = startEl.dataset.speakerId || para.spans[0]?.speakerId || '';
          if (Number.isFinite(sSec) && Number.isFinite(eSec) && eSec >= sSec) {
            return {
              text: cleanSel,
              startSec: sSec,
              endSec: Math.max(sSec + 0.1, eSec),
              speakerId: spId,
            };
          }
        }
      } catch (err) {
        console.debug('DOM range time detection fallback:', err);
      }
    }

    // 2. 基于 para.tokens 字符流精确子串对齐（算法鲁棒，无缝应对跨节点/不规范划选）
    if (para.tokens && para.tokens.length > 0) {
      let fullParaText = '';
      const tokenCharRanges: Array<{ token: FlatTokenItem; charStart: number; charEnd: number }> = [];
      for (const tok of para.tokens) {
        const charStart = fullParaText.length;
        fullParaText += tok.text;
        const charEnd = fullParaText.length;
        tokenCharRanges.push({ token: tok, charStart, charEnd });
      }

      const matchIdx = fullParaText.indexOf(cleanSel);
      if (matchIdx !== -1) {
        const matchEndIdx = matchIdx + cleanSel.length;
        const matched = tokenCharRanges.filter(
          (tr) => tr.charEnd > matchIdx && tr.charStart < matchEndIdx
        );
        if (matched.length > 0) {
          const sSec = matched[0].token.startSec;
          const eSec = matched[matched.length - 1].token.endSec;
          const spId = matched[0].token.speakerId;
          return {
            text: cleanSel,
            startSec: sSec,
            endSec: Math.max(sSec + 0.1, eSec),
            speakerId: spId,
          };
        }
      }
    }

    // 3. 后备方案：以整段的范围为准
    return {
      text: cleanSel || para.spans.map((s) => s.text).join(''),
      startSec: para.startSec,
      endSec: Math.max(para.startSec + 0.1, para.endSec),
      speakerId: para.spans[0]?.speakerId || '',
    };
  };

  // 处理文本选择弹出审阅工具栏
  const handleMouseUp = (paragraphId: string) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      setSelectionRange(null);
      return;
    }

    const selectedText = selection.toString().trim();
    if (selectedText.length === 0) {
      setSelectionRange(null);
      return;
    }

    // 找到对应段落以获取精确时间
    let targetPara: NaturalParagraph | undefined;
    for (const sec of documentSections) {
      targetPara = sec.paragraphs.find((p) => p.id === paragraphId);
      if (targetPara) break;
    }

    if (!targetPara) {
      setSelectionRange(null);
      return;
    }

    const timeInfo = resolveSelectionTimeInfo(targetPara, selectedText, selection);

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    setSelectionRange({
      text: selectedText,
      paragraphId,
      startSec: timeInfo.startSec,
      endSec: timeInfo.endSec,
      speakerId: timeInfo.speakerId,
      x: rect.left + rect.width / 2,
      y: rect.top - 8,
    });
  };

  // 添加批注
  const handleCreateComment = () => {
    if (!selectionRange || !draftCommentText.trim()) return;
    const newCmt: TextEditorReviewComment = {
      id: `cmt-${Date.now()}`,
      authorName: '我 (编辑)',
      authorAvatar: '我',
      authorColor: '#4f46e5',
      targetQuote: selectionRange.text,
      targetParagraphId: selectionRange.paragraphId,
      content: draftCommentText.trim(),
      createdAt: '刚刚',
      resolved: false,
    };
    setComments([newCmt, ...comments]);
    setDraftCommentText('');
    setShowCommentInput(false);
    setSelectionRange(null);
  };

  // 解决批注
  const handleResolveComment = (cmtId: string) => {
    setComments(
      comments.map((c) => (c.id === cmtId ? { ...c, resolved: !c.resolved } : c))
    );
  };

  // 平滑定位到指定章节
  const scrollToSection = (secId: string, startSec: number) => {
    setActiveSectionId(secId);
    onSeekToSec(startSec);
    const el = document.getElementById(secId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const formatSec = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const resolveHighlightEditedSec = (hl: HighlightClip): number => {
    const hlSrcSec = hl.sourceStartMs / 1000;
    const span = timeline.playbackSpans.find(
      (s) => hlSrcSec >= s.sourceStartSec - 0.05 && hlSrcSec <= s.sourceEndSec + 0.05
    );
    return span ? span.editedStartSec + Math.max(0, hlSrcSec - span.sourceStartSec) : hlSrcSec;
  };

  // 点击文字跳转下方播放台对应位置
  const handleWordClick = (
    e: React.MouseEvent,
    startSec: number,
    endSec: number,
    speakerId: string
  ) => {
    // 若用户正在划选文字（鼠标拖拽选区），则不触发单字跳转，保持划词气泡浮层正常操作
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
      return;
    }
    e.stopPropagation();
    onSeekToSec(startSec);
    onFocusWaveformBlock?.(startSec, endSec, speakerId, startSec, true);
  };

  const totalChars = documentSections.reduce((sum, s) => sum + s.wordCount, 0);
  const unresolvedCommentsCount = comments.filter((c) => !c.resolved).length;

  return (
    <div className="flex-1 flex overflow-hidden bg-zinc-950 text-zinc-100 select-text">
      {/* 1. 左侧导航栏（支持 章节大纲 与 金句高光 切换） */}
      {showOutline && (
        <aside className="w-80 border-r border-zinc-800/80 bg-zinc-900/60 flex flex-col shrink-0">
          {/* 顶部 Tab 切换器 */}
          <div className="p-2.5 border-b border-zinc-800 bg-zinc-950/70 space-y-2">
            <div className="flex items-center gap-1 bg-zinc-900 p-1 rounded-lg border border-zinc-800">
              <button
                type="button"
                onClick={() => setSidebarTab('outline')}
                className={`flex-1 py-1 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  sidebarTab === 'outline'
                    ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 shadow-xs'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <ListTree className="w-3.5 h-3.5 text-indigo-400" />
                <span>章节大纲</span>
              </button>
              <button
                type="button"
                onClick={() => setSidebarTab('highlights')}
                className={`flex-1 py-1 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  sidebarTab === 'highlights'
                    ? 'bg-purple-600/30 text-purple-200 border border-purple-500/40 shadow-xs'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Quote className="w-3.5 h-3.5 text-purple-400" />
                <span>金句高光</span>
                {state.highlights.length > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-purple-500/25 text-purple-300 font-mono">
                    {state.highlights.length}
                  </span>
                )}
              </button>
            </div>

            {/* 对应 Tab 的功能按钮 */}
            <div className="flex items-center justify-between px-0.5">
              {sidebarTab === 'outline' ? (
                <>
                  <span className="text-[11px] font-bold text-zinc-300 uppercase tracking-wider">
                    Shownotes 章节 ({documentSections.length})
                  </span>
                  {onOpenAiTimeline ? (
                    <button
                      type="button"
                      onClick={onOpenAiTimeline}
                      className="text-[10px] text-amber-300 hover:text-amber-200 bg-amber-500/15 hover:bg-amber-500/25 px-2 py-0.5 rounded border border-amber-500/30 flex items-center gap-1 cursor-pointer transition font-medium shadow-xs"
                      title="点击打开 AI 时间轴编辑与智能提炼"
                    >
                      <Sparkles className="w-3 h-3 text-amber-400" />
                      <span>AI生成时间轴</span>
                    </button>
                  ) : (
                    <span className="text-[10px] text-indigo-400/90 bg-indigo-500/10 px-1.5 py-0.5 rounded border border-indigo-500/20">
                      AI语义聚合
                    </span>
                  )}
                </>
              ) : (
                <>
                  <span className="text-[11px] font-bold text-zinc-300">
                    本期金句序列 ({state.highlights.length})
                  </span>
                  <div className="flex items-center gap-1">
                    {onCopyQuotes && state.highlights.length > 0 && (
                      <button
                        type="button"
                        onClick={onCopyQuotes}
                        className="text-[10px] text-zinc-400 hover:text-zinc-200 bg-zinc-800/80 hover:bg-zinc-700 px-1.5 py-0.5 rounded border border-zinc-700 flex items-center gap-1 cursor-pointer transition"
                        title="复制全部金句到剪贴板"
                      >
                        <Copy className="w-2.5 h-2.5" />
                        <span>复制</span>
                      </button>
                    )}
                    {onAiAutoFillHighlights && (
                      <button
                        type="button"
                        onClick={onAiAutoFillHighlights}
                        className="text-[10px] text-purple-300 hover:text-purple-200 bg-purple-500/15 hover:bg-purple-500/25 px-2 py-0.5 rounded border border-purple-500/30 flex items-center gap-1 cursor-pointer transition font-medium"
                        title="AI 智能自动提炼抓取本期爆点金句"
                      >
                        <Sparkles className="w-2.5 h-2.5 text-purple-400" />
                        <span>AI提炼</span>
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Tab 1: 章节大纲列表 */}
          {sidebarTab === 'outline' && (
            <>
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {documentSections.map((sec, idx) => {
                  const isSelected = activeSectionId === sec.id;
                  const hasReviewIssue = comments.some(
                    (c) => !c.resolved && c.targetQuote.includes(sec.title)
                  );

                  return (
                    <div
                      key={sec.id}
                      onClick={() => scrollToSection(sec.id, sec.startSec)}
                      className={`px-2.5 py-2 rounded-lg text-xs cursor-pointer transition flex items-start justify-between group border ${
                        isSelected
                          ? 'bg-indigo-950/40 border-indigo-500/50 text-indigo-200'
                          : 'border-transparent hover:border-zinc-700/60 hover:bg-zinc-800/80 text-zinc-300'
                      }`}
                    >
                      <div className="min-w-0 flex-1 pr-1">
                        <div className="font-semibold truncate group-hover:text-indigo-300">
                          {idx + 1}. {sec.title}
                        </div>
                        {sec.summary && (
                          <div className="text-[10px] text-zinc-500 truncate mt-0.5">
                            {sec.summary}
                          </div>
                        )}
                        <div className="flex items-center gap-2 text-[10px] text-zinc-500 mt-1 font-mono">
                          <span>@{formatSec(sec.startSec)}</span>
                          <span>·</span>
                          <span>{sec.wordCount} 字</span>
                          <span>·</span>
                          <span>{sec.paragraphs.length} 段</span>
                        </div>
                      </div>
                      {hasReviewIssue && (
                        <span className="w-2 h-2 rounded-full bg-amber-400 mt-1 shrink-0" title="该节有待处理批注" />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* 发言人色板对照表 */}
              <div className="p-3 border-t border-zinc-800 bg-zinc-950/40 shrink-0">
                <div className="text-[11px] font-bold text-zinc-400 mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1">
                    <Users className="w-3 h-3 text-zinc-500" />
                    <span>发言人字体着色</span>
                  </span>
                  <span className="text-[10px] text-zinc-500">{state.tracks.length} 位角色</span>
                </div>
                <div className="space-y-1.5">
                  {state.tracks.map((tr) => (
                    <div key={tr.id} className="flex items-center justify-between text-xs px-1.5 py-1 rounded bg-zinc-900/40">
                      <div className="flex items-center gap-2 truncate">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0 shadow-xs"
                          style={{ backgroundColor: tr.color || '#6366f1' }}
                        />
                        <span
                          className="font-medium truncate"
                          style={{ color: colorMode === 'colored' ? tr.color || '#6366f1' : '#e4e4e7' }}
                        >
                          {tr.name}
                        </span>
                      </div>
                      <span className="text-[10px] text-zinc-500 shrink-0">
                        {tr.role === 'host' ? '主讲' : '嘉宾'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Tab 2: 金句高光列表 */}
          {sidebarTab === 'highlights' && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {state.highlights.length === 0 ? (
                  <div className="p-4 rounded-xl border border-dashed border-zinc-800 text-xs text-zinc-500 text-center leading-relaxed bg-zinc-950/40 my-2">
                    <Quote className="w-6 h-6 text-zinc-600 mx-auto mb-2 opacity-50" />
                    <p className="font-semibold text-zinc-400 mb-1">当前暂无金句</p>
                    <p className="text-[11px] text-zinc-500">
                      在右侧文稿中划选文字后点击「加入金句」，或点击上方「AI提炼」快速抓取精彩金句！
                    </p>
                  </div>
                ) : (
                  state.highlights.map((hl, idx) => {
                    const sp = speakerMap[hl.speakerId];
                    const spColor = sp?.color || '#a855f7';
                    const spName = sp?.name || hl.speakerName;
                    const startFormatted = formatMmSs(hl.sourceStartMs / 1000);
                    const endFormatted = formatMmSs(hl.sourceEndMs / 1000);

                    return (
                      <div
                        key={hl.id}
                        className="group p-2.5 rounded-lg border border-zinc-800 bg-zinc-900/90 hover:border-purple-500/50 hover:bg-zinc-850 transition space-y-1.5"
                      >
                        {/* 金句头部信息与操作栏 */}
                        <div className="flex items-center justify-between gap-1.5 text-[11px]">
                          <div
                            onClick={() => {
                              handleJumpAndPlay(resolveHighlightEditedSec(hl));
                            }}
                            title="点击定位并试听该条金句"
                            className="flex items-center gap-1.5 min-w-0 cursor-pointer flex-1"
                          >
                            <Quote className="w-3 h-3 text-purple-400 shrink-0" />
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: spColor }}
                            />
                            <span className="font-semibold text-zinc-100 truncate">
                              {spName}
                            </span>
                            <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-purple-500/15 text-purple-300 font-semibold shrink-0">
                              {startFormatted} ~ {endFormatted} ({hl.durationSec.toFixed(1)}s)
                            </span>
                          </div>

                          <div className="flex items-center gap-0.5 shrink-0">
                            {/* 播放/试听按钮 */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleJumpAndPlay(resolveHighlightEditedSec(hl));
                              }}
                              title="立即试听播放该条金句"
                              className="p-1 rounded text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/20 transition cursor-pointer"
                            >
                              <Play className="w-3 h-3 fill-current" />
                            </button>

                            {/* 编辑按钮：点开多轨波形编辑弹窗 */}
                            <button
                              type="button"
                              onClick={() => {
                                if (onOpenHighlightEditModal) {
                                  onOpenHighlightEditModal(hl);
                                } else {
                                  setLocalEditingHighlight(hl);
                                }
                              }}
                              title="点开波形弹窗，拖动各个音轨编辑"
                              className="p-1 rounded text-purple-400 hover:text-purple-200 hover:bg-purple-500/20 transition cursor-pointer"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>

                            {/* 上移排序 */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!onUpdateState || idx === 0) return;
                                onUpdateState((p) => {
                                  const next = [...p.highlights];
                                  [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                                  return { ...p, highlights: next };
                                });
                              }}
                              disabled={idx === 0}
                              title="上移顺序"
                              className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed transition cursor-pointer"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>

                            {/* 下移排序 */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!onUpdateState || idx >= state.highlights.length - 1) return;
                                onUpdateState((p) => {
                                  const next = [...p.highlights];
                                  [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                                  return { ...p, highlights: next };
                                });
                              }}
                              disabled={idx >= state.highlights.length - 1}
                              title="下移顺序"
                              className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed transition cursor-pointer"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>

                            {/* 删除 */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (onRemoveHighlight) {
                                  onRemoveHighlight(hl.id);
                                } else if (onUpdateState) {
                                  onUpdateState((p) => ({
                                    ...p,
                                    highlights: p.highlights.filter((h) => h.id !== hl.id),
                                  }));
                                }
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
                          onClick={() => {
                            if (onSeekToHighlight) {
                              onSeekToHighlight(hl);
                            } else {
                              onSeekToSec(resolveHighlightEditedSec(hl));
                            }
                          }}
                          className="text-xs text-zinc-200 leading-snug line-clamp-2 select-text cursor-pointer hover:text-purple-200"
                        >
                          “{hl.text}”
                        </p>
                      </div>
                    );
                  })
                )}
              </div>

              {/* 金句统计与冷开场说明 */}
              {state.highlights.length > 0 && (
                <div className="p-3 border-t border-zinc-800 bg-zinc-950/60 shrink-0 text-[11px] text-zinc-400 space-y-1">
                  <div className="flex items-center justify-between">
                    <span>纯金句总时长</span>
                    <span className="font-mono text-zinc-200 font-bold">
                      {state.highlights.reduce((acc, h) => acc + h.durationSec, 0).toFixed(1)}s
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-zinc-500">
                    <span>高光片头预估 (含前后奏+间隔)</span>
                    <span className="font-mono text-purple-300 font-semibold">
                      {timeline.coldOpenDurationSec.toFixed(1)}s
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      )}

      {/* 2. 中间出版级沉浸正文画布（按 Section 组织，内容聚合成自然段） */}
      <main className="flex-1 flex flex-col min-w-0 bg-zinc-950 overflow-hidden">
        {/* 顶部轻量工具条 */}
        <div className="h-11 px-4 border-b border-zinc-800/80 bg-zinc-900/50 flex items-center justify-between shrink-0 gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            {/* 折叠/展开左侧大纲 */}
            <button
              onClick={() => setShowOutline((v) => !v)}
              className={`p-1.5 rounded-md text-xs font-medium flex items-center gap-1 cursor-pointer transition ${
                showOutline
                  ? 'bg-zinc-800 text-zinc-200 border border-zinc-700'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
              }`}
              title={showOutline ? '收起左侧章节大纲' : '展开左侧章节大纲'}
            >
              <ListTree className="w-3.5 h-3.5" />
            </button>

            {/* 播放 / 暂停 快捷控制 */}
            {onTogglePlay && (
              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  onTogglePlay();
                }}
                className={`px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer shadow-sm ${
                  isPlaying
                    ? 'bg-amber-500 hover:bg-amber-400 text-zinc-950 font-bold'
                    : 'bg-blue-600 hover:bg-blue-500 text-white'
                }`}
                title="播放 / 暂停 (快捷键: Space 空格)"
              >
                {isPlaying ? (
                  <>
                    <Pause className="w-3.5 h-3.5 fill-current" />
                    <span>暂停</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>播放</span>
                  </>
                )}
              </button>
            )}

            {/* AI 生成时间轴按钮 */}
            {onOpenAiTimeline && (
              <button
                onClick={onOpenAiTimeline}
                className="px-3 py-1 rounded-lg text-xs font-semibold bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-white shadow-sm flex items-center gap-1.5 transition cursor-pointer"
                title="使用 AI 智能提取并生成全期节目精剪时间轴（含章节概括与小宇宙/Apple Podcasts标准格式导出）"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-100" />
                <span>AI 生成时间轴</span>
              </button>
            )}

            <div className="h-4 w-px bg-zinc-800 mx-0.5" />

            {/* 色彩区分发言人切换 */}
            <button
              onClick={() => setColorMode(colorMode === 'colored' ? 'monochrome' : 'colored')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer transition ${
                colorMode === 'colored'
                  ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/40'
                  : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
              }`}
              title="切换按发言人着色字体 / 沉浸纯黑正文字体"
            >
              <Palette className="w-3.5 h-3.5" />
              <span>{colorMode === 'colored' ? '彩色发言人字' : '纯黑正文字'}</span>
            </button>

            {/* 隐藏口水词开关 */}
            <button
              onClick={onToggleHideFillerWords}
              className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer transition ${
                hideFillerWords
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  : 'bg-zinc-800 text-zinc-400 border border-zinc-700 hover:text-zinc-200'
              }`}
              title={hideFillerWords ? '当前已隐藏全部语气词/口水词' : '点击隐藏口水词（嗯、啊、那个等）'}
            >
              {hideFillerWords ? <EyeOff className="w-3.5 h-3.5 text-amber-400" /> : <Eye className="w-3.5 h-3.5" />}
              <span>{hideFillerWords ? '已过滤口水词' : '过滤口水词'}</span>
            </button>

            {/* 仅保留主发言开关 */}
            <button
              onClick={() => {
                setHideOverlapBackchannels((prev) => {
                  const next = !prev;
                  try {
                    localStorage.setItem('podcraft_hide_overlap_backchannels', String(next));
                  } catch {}
                  return next;
                });
              }}
              className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer transition ${
                hideOverlapBackchannels
                  ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/40'
                  : 'bg-zinc-800 text-zinc-400 border border-zinc-700 hover:text-zinc-200'
              }`}
              title={
                hideOverlapBackchannels
                  ? '当前已开启「仅保留主发言」：自动过滤重叠发言中副轨插入的附和短句，保持主发言连贯'
                  : '点击开启「仅保留主发言」，过滤副轨重叠插入的短句'
              }
            >
              <Volume2 className="w-3.5 h-3.5 text-indigo-400" />
              <span>{hideOverlapBackchannels ? '仅保留主发言(已藏短句)' : '显示重叠短句'}</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="text-xs text-zinc-400 font-mono hidden sm:block">
              全篇共 {documentSections.length} 节 · 约 {totalChars} 字
            </div>

            {/* 折叠/展开右侧批注 */}
            <button
              onClick={() => setShowComments((v) => !v)}
              className={`px-2 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer transition ${
                showComments
                  ? 'bg-zinc-800 text-zinc-200 border border-zinc-700'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
              }`}
              title={showComments ? '隐藏右侧批注栏' : '显示右侧批注栏'}
            >
              <MessageCircle className="w-3.5 h-3.5 text-emerald-400" />
              <span>批注 {comments.length > 0 ? `(${comments.length})` : ''}</span>
            </button>

            {onRetranscribe && (
              <button
                type="button"
                onClick={onRetranscribe}
                className="px-2.5 py-1 rounded-md text-xs font-semibold bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 border border-indigo-500/40 flex items-center gap-1.5 cursor-pointer transition shadow-xs"
                title="指定模型重新识别语音并刷新文稿"
              >
                <RefreshCw className="w-3.5 h-3.5 text-indigo-400" />
                <span>重新识别</span>
              </button>
            )}
          </div>
        </div>

        {/* 页面正文滚动区：出版级长文宽幅排版 */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8 flex justify-center">
          <div className="w-full max-w-5xl xl:max-w-6xl bg-zinc-900/40 border border-zinc-800/80 rounded-2xl shadow-2xl p-6 md:p-12 min-h-full transition-all">
            {/* 文章主标题 */}
            <div className="mb-10 pb-6 border-b border-zinc-800">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                  文本模式 · 自然段
                </span>
                <span className="text-xs text-zinc-500">
                  内容按 Shownotes 语义聚合 · 字体颜色区分发言人
                </span>
              </div>
              <h1 className="text-2xl md:text-3xl font-bold text-zinc-100 tracking-tight">
                {state.projectTitle || '未命名节目文稿'}
              </h1>
            </div>

            {/* 按 Section 渲染自然段长文 */}
            <div className="space-y-12">
              {documentSections.map((sec, sIdx) => (
                <section key={sec.id} id={sec.id} className="space-y-5">
                  {/* Section 标题与时间跳转 */}
                  <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs font-bold text-indigo-400 font-mono">
                        {String(sIdx + 1).padStart(2, '0')}.
                      </span>
                      <h2 className="text-lg font-bold text-zinc-100">{sec.title}</h2>
                    </div>

                    <button
                      onClick={() => handleJumpAndPlay(sec.startSec)}
                      className="text-xs font-mono text-zinc-400 hover:text-indigo-300 flex items-center gap-1.5 cursor-pointer transition px-2 py-0.5 rounded bg-zinc-900/60 border border-zinc-800 hover:border-zinc-700"
                      title="点击从本章节开始播放"
                    >
                      <Play className="w-3 h-3 fill-current text-indigo-400" />
                      <span>@{formatSec(sec.startSec)}</span>
                    </button>
                  </div>

                  {sec.summary && (
                    <div className="text-xs text-zinc-400 bg-zinc-950/40 p-2.5 rounded-lg border-l-2 border-indigo-500/60 italic">
                      “{sec.summary}”
                    </div>
                  )}

                  {/* 自然段列表（零字间距紧凑排版，像正常小说/出版物一样连贯阅读） */}
                  <div className="space-y-6 text-[16px] leading-[1.85] text-left font-sans select-text [letter-spacing:0] [word-spacing:0]">
                    {sec.paragraphs.map((para) => (
                      <div
                        key={para.id}
                        id={para.id}
                        onMouseUp={() => handleMouseUp(para.id)}
                        onContextMenu={(e) => {
                          const sel = window.getSelection();
                          const selText = sel && !sel.isCollapsed ? sel.toString().trim() : '';
                          const isTextSelected = selText.length > 0;
                          const timeInfo = resolveSelectionTimeInfo(
                            para,
                            isTextSelected ? selText : para.spans.map((s) => s.text).join(''),
                            isTextSelected ? sel : null
                          );
                          if (timeInfo.text.length > 0) {
                            e.preventDefault();
                            setContextMenu({
                              x: e.clientX,
                              y: e.clientY,
                              text: timeInfo.text,
                              paragraphId: para.id,
                              startSec: timeInfo.startSec,
                              endSec: timeInfo.endSec,
                              speakerId: timeInfo.speakerId,
                            });
                          }
                        }}
                        className="group relative -mx-3 px-3 py-1.5 rounded-lg transition-colors hover:bg-zinc-800/25"
                      >
                        {/* 段落正文：段内不同发言人用字体颜色自然区分，字间距彻底归零 */}
                        <p className="select-text text-left font-sans p-0 m-0 [letter-spacing:0] [word-spacing:0]">
                          {para.spans.map((sp, spanIdx) => {
                            // 当跨发言人或者段首时，展示轻量的行内彩色发言人标签
                            const showSpeakerTag =
                              spanIdx === 0 ||
                              para.spans[spanIdx - 1]?.speakerId !== sp.speakerId;

                            const textColor =
                              colorMode === 'colored' ? sp.speakerColor : '#e4e4e7';

                            return (
                              <React.Fragment key={sp.id}>
                                {showSpeakerTag && (
                                  <span
                                    className="inline-flex items-center text-[12px] font-semibold mr-1 px-1.5 py-0.5 rounded-full select-none"
                                    style={{
                                      color: sp.speakerColor,
                                      backgroundColor: `${sp.speakerColor}18`,
                                    }}
                                    title={`发言人: ${sp.speakerName}`}
                                  >
                                    {sp.speakerName}
                                  </span>
                                )}

                                {/* 纯净成稿文字：携带高精度时间与发言人元数据，无多余字间距 */}
                                <span
                                  data-span-id={sp.id}
                                  data-speaker-id={sp.speakerId}
                                  data-start-sec={sp.startSec}
                                  data-end-sec={sp.endSec}
                                  style={{ color: textColor }}
                                  className="inline p-0 m-0 border-0 [letter-spacing:0] [word-spacing:0]"
                                >
                                  {sp.tokens && sp.tokens.length > 0 ? (
                                    sp.tokens.map((tok, tokIdx) => {
                                      const isPlayingWord =
                                        Boolean(activeTokenId && tok.tokenId === activeTokenId);
                                      const prevTok = tokIdx > 0 ? sp.tokens[tokIdx - 1] : null;
                                      let cleanText = tok.text;
                                      // 中文字符间多余空格剥离，确保汉字自然无缝连接
                                      if (
                                        prevTok &&
                                        /[\u4e00-\u9fa5]$/.test(prevTok.text) &&
                                        cleanText.startsWith(' ')
                                      ) {
                                        cleanText = cleanText.replace(/^ +/, '');
                                      }
                                      return (
                                        <span
                                          key={tok.tokenId}
                                          data-token-id={tok.tokenId}
                                          data-speaker-id={tok.speakerId}
                                          data-start-sec={tok.startSec}
                                          data-end-sec={tok.endSec}
                                          onClick={(e) =>
                                            handleWordClick(
                                              e,
                                              tok.startSec,
                                              tok.endSec,
                                              tok.speakerId
                                            )
                                          }
                                          title={`点击跳转下方播放台 @${formatSec(tok.startSec)}`}
                                          className={`cursor-pointer inline p-0 m-0 border-0 ${
                                            isPlayingWord
                                              ? 'bg-indigo-500/40 text-white font-medium ring-1 ring-indigo-400/60 rounded-xs'
                                              : 'hover:text-white'
                                          }`}
                                        >{cleanText}</span>
                                      );
                                    })
                                  ) : (
                                    <span
                                      onClick={(e) =>
                                        handleWordClick(
                                          e,
                                          sp.startSec,
                                          sp.endSec,
                                          sp.speakerId
                                        )
                                      }
                                      className="cursor-pointer hover:text-white p-0 m-0 inline border-0"
                                      title={`点击跳转下方播放台 @${formatSec(sp.startSec)}`}
                                    >{sp.text}</span>
                                  )}
                                </span>
                              </React.Fragment>
                            );
                          })}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>

        {/* 划选浮层气泡 */}
        {selectionRange && (
          <div
            className="fixed z-50 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl p-1 flex items-center gap-1 transform -translate-x-1/2 -translate-y-full"
            style={{ left: selectionRange.x, top: selectionRange.y }}
          >
            {onAddSelectedToHighlight && (
              <button
                onClick={() => {
                  onAddSelectedToHighlight({
                    text: selectionRange.text,
                    startSec: selectionRange.startSec,
                    endSec: selectionRange.endSec,
                    speakerId: selectionRange.speakerId,
                    isEditedTime: true,
                  });
                  setSelectionRange(null);
                }}
                className="px-2 py-1 rounded text-xs text-purple-200 hover:bg-purple-900/40 flex items-center gap-1 cursor-pointer font-medium"
              >
                <Sparkles className="w-3 h-3 text-purple-400" />
                <span>加入金句</span>
              </button>
            )}
            <button
              onClick={() => setShowCommentInput(true)}
              className="px-2 py-1 rounded text-xs text-zinc-200 hover:bg-zinc-800 flex items-center gap-1 cursor-pointer"
            >
              <MessageSquare className="w-3 h-3 text-indigo-400" />
              <span>批注</span>
            </button>
          </div>
        )}

        {/* 批注快速输入弹窗框 */}
        {showCommentInput && selectionRange && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs">
            <div className="w-96 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-4 space-y-3">
              <div className="flex items-center justify-between text-xs font-bold text-zinc-200">
                <span>添加审阅批注</span>
                <button
                  onClick={() => setShowCommentInput(false)}
                  className="text-zinc-500 hover:text-zinc-300"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-2 rounded bg-zinc-950 text-xs text-zinc-400 italic border-l-2 border-indigo-500">
                “{selectionRange.text}”
              </div>
              <textarea
                value={draftCommentText}
                onChange={(e) => setDraftCommentText(e.target.value)}
                placeholder="输入审阅批注，团队成员可在线查看与回复..."
                rows={3}
                autoFocus
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowCommentInput(false)}
                  className="px-3 py-1 rounded text-xs text-zinc-400 hover:bg-zinc-800"
                >
                  取消
                </button>
                <button
                  onClick={handleCreateComment}
                  className="px-3 py-1 rounded text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-500"
                >
                  发表批注
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* 3. 右侧审阅批注面板（成稿严谨真实，只读不改字） */}
      {showComments && (
        <aside className="w-72 border-l border-zinc-800/80 bg-zinc-900/60 flex flex-col shrink-0">
        <div className="p-3 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-bold text-zinc-200 uppercase tracking-wider">
            <MessageCircle className="w-3.5 h-3.5 text-emerald-400" />
            <span>审阅批注</span>
          </div>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
            {unresolvedCommentsCount} 条待办
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {/* 批注卡片列表 */}
          {comments.map((cmt) => (
            <div
              key={cmt.id}
              className={`p-3 rounded-xl border transition-all ${
                cmt.resolved
                  ? 'border-zinc-800 bg-zinc-950/30 opacity-60'
                  : 'border-zinc-700 bg-zinc-900/90 shadow-xs'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                  <span
                    className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white"
                    style={{ backgroundColor: cmt.authorColor }}
                  >
                    {cmt.authorAvatar}
                  </span>
                  <span>{cmt.authorName}</span>
                </div>
                <span className="text-[10px] text-zinc-500">{cmt.createdAt}</span>
              </div>

              <div className="text-[11px] text-zinc-400 italic border-l-2 border-indigo-500/60 pl-2 mb-2 line-clamp-2">
                “{cmt.targetQuote}”
              </div>

              <div className="text-xs text-zinc-200 leading-relaxed mb-3">
                {cmt.content}
              </div>

              <div className="flex justify-end">
                <button
                  onClick={() => handleResolveComment(cmt.id)}
                  className={`px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 cursor-pointer transition ${
                    cmt.resolved
                      ? 'text-zinc-500 hover:text-zinc-300'
                      : 'text-emerald-400 hover:bg-emerald-500/10 border border-emerald-500/30'
                  }`}
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{cmt.resolved ? '重新开启' : '标记已解决'}</span>
                </button>
              </div>
            </div>
          ))}

          {unresolvedCommentsCount === 0 && (
            <div className="py-12 text-center text-zinc-500 space-y-2">
              <FileCheck className="w-8 h-8 mx-auto text-zinc-600" />
              <div className="text-xs">暂无待处理审阅批注</div>
              <div className="text-[11px] text-zinc-600">在正文划选任意文字即可发起团队审阅批注</div>
            </div>
          )}
        </div>
      </aside>
      )}

      {/* 右键快捷菜单（支持加入金句、批注、跳转） */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-44 rounded-xl border border-zinc-700/90 bg-zinc-900/98 shadow-2xl p-1.5 text-xs backdrop-blur-md space-y-0.5"
          style={{
            left: Math.min(window.innerWidth - 190, contextMenu.x),
            top: Math.min(window.innerHeight - 150, contextMenu.y),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {onAddSelectedToHighlight && (
            <button
              type="button"
              onClick={() => {
                onAddSelectedToHighlight({
                  text: contextMenu.text,
                  startSec: contextMenu.startSec,
                  endSec: contextMenu.endSec,
                  speakerId: contextMenu.speakerId,
                  isEditedTime: true,
                });
                setContextMenu(null);
              }}
              className="w-full px-2.5 py-1.5 rounded-lg text-purple-200 hover:bg-purple-900/40 flex items-center gap-2 cursor-pointer font-medium transition"
            >
              <Sparkles className="w-3.5 h-3.5 text-purple-400" />
              <span>加入金句</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setSelectionRange({
                text: contextMenu.text,
                paragraphId: contextMenu.paragraphId,
                startSec: contextMenu.startSec,
                endSec: contextMenu.endSec,
                speakerId: contextMenu.speakerId,
                x: contextMenu.x,
                y: contextMenu.y,
              });
              setShowCommentInput(true);
              setContextMenu(null);
            }}
            className="w-full px-2.5 py-1.5 rounded-lg text-zinc-200 hover:bg-zinc-800 flex items-center gap-2 cursor-pointer transition"
          >
            <MessageSquare className="w-3.5 h-3.5 text-indigo-400" />
            <span>添加批注...</span>
          </button>

          <button
            type="button"
            onClick={() => {
              handleJumpAndPlay(contextMenu.startSec);
              setContextMenu(null);
            }}
            className="w-full px-2.5 py-1.5 rounded-lg text-zinc-200 hover:bg-zinc-800 flex items-center gap-2 cursor-pointer transition font-medium"
          >
            <Play className="w-3.5 h-3.5 text-emerald-400 fill-current" />
            <span>从此处播放审听</span>
          </button>
        </div>
      )}

      {/* 金句多轨波形编辑弹窗 (本地自闭环支持) */}
      {localEditingHighlight && (
        <HighlightEditModal
          open={Boolean(localEditingHighlight)}
          highlight={localEditingHighlight}
          tracks={state.tracks}
          onClose={() => setLocalEditingHighlight(null)}
          onSave={(updated) => {
            if (onUpdateState) {
              onUpdateState((prev) => ({
                ...prev,
                highlights: prev.highlights.map((h) => (h.id === updated.id ? updated : h)),
              }));
            }
            onNotify?.(`💾 已更新金句片段 @${formatMmSs(updated.sourceStartMs / 1000)} (${updated.durationSec.toFixed(1)}s)`);
            setLocalEditingHighlight(null);
          }}
        />
      )}
    </div>
  );
});
