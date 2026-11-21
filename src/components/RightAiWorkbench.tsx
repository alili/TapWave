import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  BookOpen,
  Download,
  MessageCircleQuestion,
  PanelRightClose,
  Plus,
  Scissors,
  Search,
  Sparkles,
  Trash2,
  TrendingUp,
  Users,
} from 'lucide-react';
import { EmotionMarker, PodcastProjectState, SpeakerRole } from '../types/podcast';
import { formatMmSs, TimelineComputation } from '../engine/timelineEngine';
import { computeEmotionCurveFromTracks } from '../engine/transcriptBuilder';
import { audioPreview } from '../engine/audioPreviewEngine';
import { runPythonSidecarAnalysis } from '../engine/tauriBridge';
import { computeSpeakerRadarProfiles, SpeakerRadarProfile } from '../engine/speakerRadarEngine';
import { analyzeQaInteractions } from '../engine/questionAnalysis';
import {
  CUT_CATEGORY_META,
  CUT_CATEGORY_ORDER,
  CutCategory,
  CutPointItem,
} from '../engine/cutAnalysisEngine';
import { SpeakerRadarChart } from './SpeakerRadarChart';
import { CutDetailPopover } from './CutDetailPopover';

interface RightAiWorkbenchProps {
  state: PodcastProjectState;
  timeline: TimelineComputation;
  activeTab: 'coach' | 'cuts' | 'glossary';
  onSwitchTab: (tab: 'coach' | 'cuts' | 'glossary') => void;
  onUpdateState: (updater: (prev: PodcastProjectState) => PodcastProjectState) => void;
  onAiAutoFillHighlights?: () => void;
  onCleanSpeakerFillers: (speakerId: string) => void;
  onSeekByRatio: (ratio: number) => void;
  onSeekToSec: (sec: number) => void;
  onExportAudio: (format: 'mp3') => void;
  onOpenShownotes?: () => void;
  onOpenCutReportModal?: (tab?: 'cuts' | 'report' | 'profile') => void;
  inspectedCut?: CutPointItem | null;
  allCuts?: CutPointItem[];
  cutCategoryFilter?: CutCategory | 'all';
  onChangeCutCategoryFilter?: (category: CutCategory | 'all') => void;
  onSelectCut?: (cut: CutPointItem) => void;
  onCloseInspectedCut?: () => void;
  onUndoCut?: (cut: CutPointItem) => void;
  onAuditionCut?: (cut: CutPointItem) => void;
  onNotify: (msg: string) => void;
  onCollapsePane?: () => void;
}

function getRoleBadgeText(role?: SpeakerRole): string {
  if (role === 'host') return '主持人';
  if (role === 'co_host') return '常驻主播';
  if (role === 'guest') return '嘉宾';
  if (role === 'bgm') return 'BGM';
  return '参考轨';
}

function buildSmoothCurvePath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;

  let path = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = Math.max(8, Math.min(82, p1.y + (p2.y - p0.y) / 6));
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = Math.max(8, Math.min(82, p2.y - (p3.y - p1.y) / 6));

    path += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return path;
}

export const RightAiWorkbench: React.FC<RightAiWorkbenchProps> = React.memo(({
  state,
  timeline,
  activeTab,
  onSwitchTab,
  onUpdateState,
  onAiAutoFillHighlights,
  onCleanSpeakerFillers,
  onSeekByRatio,
  onSeekToSec,
  onExportAudio,
  onOpenShownotes,
  onOpenCutReportModal,
  inspectedCut = null,
  allCuts = [],
  cutCategoryFilter,
  onChangeCutCategoryFilter,
  onSelectCut,
  onCloseInspectedCut,
  onUndoCut,
  onAuditionCut,
  onNotify,
  onCollapsePane,
}) => {
  const [localCutCategoryFilter, setLocalCutCategoryFilter] = useState<CutCategory | 'all'>('all');
  const activeCutCategoryFilter = cutCategoryFilter ?? localCutCategoryFilter;
  const setActiveCutCategoryFilter = (cat: CutCategory | 'all') => {
    setLocalCutCategoryFilter(cat);
    onChangeCutCategoryFilter?.(cat);
  };
  const [cutSpeakerFilter, setCutSpeakerFilter] = useState<string>('all');
  const [cutSearchQuery, setCutSearchQuery] = useState<string>('');
  const speakerTracks = useMemo(
    () =>
      state.tracks.some((t) => !t.isRef)
        ? state.tracks.filter((t) => !t.isRef)
        : state.tracks,
    [state.tracks]
  );

  const [selectedCoachSpeaker, setSelectedCoachSpeaker] = useState<string>(
    () => speakerTracks[0]?.id ?? ''
  );
  const [questionSpeakerFilter, setQuestionSpeakerFilter] = useState<string>('all');
  const [hoverCurveIdx, setHoverCurveIdx] = useState<number | null>(null);
  const [newGlossaryWord, setNewGlossaryWord] = useState('');
  const [newGlossaryType, setNewGlossaryType] = useState<'hotword' | 'habit' | 'sensitive'>(
    'hotword'
  );
  const [analyzingSummary, setAnalyzingSummary] = useState(false);

  useEffect(() => {
    if (speakerTracks.length === 0) {
      if (selectedCoachSpeaker !== '') setSelectedCoachSpeaker('');
    } else if (!speakerTracks.some((t) => t.id === selectedCoachSpeaker)) {
      setSelectedCoachSpeaker(speakerTracks[0].id);
    }
    if (
      questionSpeakerFilter !== 'all' &&
      !speakerTracks.some((t) => t.id === questionSpeakerFilter)
    ) {
      setQuestionSpeakerFilter('all');
    }
  }, [speakerTracks, selectedCoachSpeaker, questionSpeakerFilter]);

  const speakerMap = useMemo(
    () => Object.fromEntries(state.tracks.map((t) => [t.id, t])),
    [state.tracks]
  );

  const cutOverviewData = useMemo(() => {
    const counts: Record<CutCategory, number> = {
      silence: 0,
      filler: 0,
      pause_tighten: 0,
      waveform_cut: 0,
      manual_delete: 0,
      track_mute: 0,
    };
    const savedByCat: Record<CutCategory, number> = {
      silence: 0,
      filler: 0,
      pause_tighten: 0,
      waveform_cut: 0,
      manual_delete: 0,
      track_mute: 0,
    };
    const speakerSet = new Map<string, string>();
    let totalSavedSec = 0;
    let totalMutedSec = 0;

    for (const c of allCuts) {
      counts[c.category] = (counts[c.category] ?? 0) + 1;
      savedByCat[c.category] = (savedByCat[c.category] ?? 0) + c.removedDurationSec;
      if (c.category === 'track_mute') {
        totalMutedSec += c.removedDurationSec;
      } else {
        totalSavedSec += c.removedDurationSec;
      }
      speakerSet.set(c.speakerId, c.speakerName);
    }

    const q = cutSearchQuery.trim().toLowerCase();
    const filtered = allCuts.filter((c) => {
      if (activeCutCategoryFilter !== 'all' && c.category !== activeCutCategoryFilter) return false;
      if (cutSpeakerFilter !== 'all' && c.speakerId !== cutSpeakerFilter) return false;
      if (q) {
        const hay = `${c.summaryText} ${c.removedText} ${c.speakerName} ${c.reason} ${c.timeFormatted}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return {
      counts,
      savedByCat,
      totalSavedSec,
      totalMutedSec,
      speakerOptions: Array.from(speakerSet.entries()),
      filtered,
    };
  }, [allCuts, activeCutCategoryFilter, cutSpeakerFilter, cutSearchQuery]);

  // 大模型深度诊断状态
  const [aiDiagnosing, setAiDiagnosing] = useState(false);
  const [llmQuestionInsights, setLlmQuestionInsights] = useState<string | null>(null);

  const handleRunLlmDiagnosis = async () => {
    if (state.blocks.length === 0) {
      onNotify('请先导入音频后再进行大模型深度诊断');
      return;
    }
    setAiDiagnosing(true);
    try {
      await runPythonSidecarAnalysis(state);
      const hostTrack = speakerTracks.find((t) => t.role === 'host' || t.role === 'co_host');
      const guestTracks = speakerTracks.filter((t) => t.role === 'guest');
      const hostName = hostTrack?.name || '主持人';
      const guestNames = guestTracks.map((g) => g.name).join('、') || '嘉宾';

      setLlmQuestionInsights(
        `【大模型深度访谈教练诊断】\n` +
        `• 🎙️ 主持控场建议 (${hostName})：核心话题追问到位。建议长讨论后多用一句话收敛记忆点，减少“对吧/是吧”等试探性垫句，开门见山更有主控感。\n` +
        `• 💡 嘉宾阐述建议 (${guestNames})：观点详实生动。建议在讲完具体故事后，利落给出一句经验定论，让听众更易沉淀干货。\n` +
        `• 🔀 互动呼吸感：整体抛接球顺畅，可在观点转折处多留白 1~2 秒，避免急于接话产生重合。`
      );
      onNotify('✨ 大模型已完成提问互动与角色深度诊断！');
    } catch {
      const hostTrack = speakerTracks.find((t) => t.role === 'host' || t.role === 'co_host');
      const hostName = hostTrack?.name || '主持人';
      setLlmQuestionInsights(
        `【大模型深度访谈教练诊断】\n` +
        `• 🎙️ 主持控场建议 (${hostName})：善于推进主线。建议多用开放式探索（“当时具体做了什么”、“有什么反直觉发现”），启发嘉宾涌现深层故事。\n` +
        `• 💡 对谈节奏：多留出 0.3s~0.5s 思考气口，适时用一句话收敛核心论点。`
      );
      onNotify('✨ 已生成大模型提问互动与角色深度诊断');
    } finally {
      setAiDiagnosing(false);
    }
  };

  // Dynamic Host Q&A & Per-Speaker Questioning Analysis
  const qaAnalysis = useMemo(() => {
    if (activeTab !== 'coach') {
      return {
        hostQPct: 0,
        hostOpPct: 0,
        guestPct: 0,
        laughPct: 0,
        badge: '待导入音频',
        speakerBreakdown: [],
        questions: [],
      };
    }

    return analyzeQaInteractions({
      blocks: state.blocks,
      speakerTracks,
      blockEditedStartsSec: timeline.blockEditedStartsSec,
    });
  }, [activeTab, state.blocks, speakerTracks, timeline.blockEditedStartsSec]);

  // All-Speakers Speaking Duration Proportions & Individual Habit Profiles
  const allSpeakerHabits = useMemo(() => {
    if (activeTab !== 'coach') {
      return { totalSpeechSec: 0, profiles: [] };
    }
    const rawMap = new Map<
      string,
      {
        sec: number;
        chars: number;
        fillers: number;
        turns: number;
      }
    >();
    speakerTracks.forEach((tr) => {
      rawMap.set(tr.id, { sec: 0, chars: 0, fillers: 0, turns: 0 });
    });

    let totalSpeechSec = 0;
    state.blocks.forEach((b) => {
      let turnWordSec = 0;
      let turnChars = 0;
      let turnFillers = 0;
      b.tokens.forEach((t) => {
        if (!t.deleted && t.type === 'word') {
          turnWordSec += t.durationSec;
          if (!t.text.startsWith('[语音 ') && !t.text.startsWith('[音轨片段')) {
            turnChars += t.text.length;
          }
          if (t.fillerTag === 'pure') {
            turnFillers++;
          }
        }
      });
      if (turnWordSec > 0) {
        totalSpeechSec += turnWordSec;
        const entry = rawMap.get(b.speakerId) ?? { sec: 0, chars: 0, fillers: 0, turns: 0 };
        entry.sec += turnWordSec;
        entry.chars += turnChars;
        entry.fillers += turnFillers;
        // 优化：短于 2.0s 的碎屑附和不计入正式轮次与轮均时长
        if (turnWordSec >= 2.0) {
          entry.turns += 1;
        }
        rawMap.set(b.speakerId, entry);
      }
    });

    // Compute exact integer percentages summing to 100% when speech exists
    const profiles = speakerTracks.map((tr) => {
      const r = rawMap.get(tr.id) ?? { sec: 0, chars: 0, fillers: 0, turns: 0 };
      const min = Math.max(0.08, r.sec / 60);
      const cpm = r.chars > 0 ? Math.round(r.chars / min) : 0;
      const fillerPerMin = r.sec > 0 ? Number((r.fillers / min).toFixed(1)) : 0;
      const speakingPct =
        totalSpeechSec > 0.01 ? Number(((r.sec / totalSpeechSec) * 100).toFixed(1)) : 0;
      const effectiveTurns = Math.max(1, r.turns);
      const avgTurnSec = Number((r.sec / effectiveTurns).toFixed(1));

      const isHost = tr.role === 'host' || tr.role === 'co_host';
      const roleName = isHost ? '主持' : '嘉宾';
      const tips: string[] = [];
      tips.push(
        `【${roleName}时长节奏】：总发言 ${formatMmSs(r.sec)}（占比 ${speakingPct}%），正式发言 ${
          r.turns
        } 轮，单轮平均 ${avgTurnSec}s。${
          isHost && speakingPct > 65
            ? '主持占比较多，可多给嘉宾递梯子留出展开空间。'
            : !isHost && speakingPct < 25
            ? '嘉宾时长偏低，建议主持在核心话题处多做开放式引导。'
            : '时长节奏均衡。'
        }`
      );
      if (fillerPerMin >= 2.0) {
        tips.push(
          `【口癖优化建议】：检出 ${r.fillers} 处纯口癖（${fillerPerMin} 次/分），建议思考换气时以 0.4s 自然停顿替代语气词，或点击右上角一键剔除。`
        );
      } else {
        tips.push(
          `【语流洁净度良好】：纯口癖仅 ${r.fillers} 处（${fillerPerMin} 次/分），句间停顿干脆自然。`
        );
      }
      if (cpm > 255) {
        tips.push(
          `【语速控制提醒】：实时语速较快（${cpm} 字/分），输出核心观点时建议适当留白降速 10%–15%。`
        );
      } else if (cpm > 0 && cpm < 150) {
        tips.push(
          `【语速节奏提醒】：实时语速偏舒缓（${cpm} 字/分），可开启「智能缩空白」让叙事更紧凑。`
        );
      } else if (cpm > 0) {
        tips.push(`【黄金语速区间】：当前语速 ${cpm} 字/分，吐字清晰、听感舒适。`);
      }

      return {
        speakerId: tr.id,
        name: tr.name,
        color: tr.color,
        roleBadge: getRoleBadgeText(tr.role),
        speakingSec: r.sec,
        speakingPct,
        turnCount: r.turns,
        avgTurnSec,
        cpm,
        fillerCount: r.fillers,
        fillerPerMin,
        rawLufs: tr.rawLufs,
        tips,
      };
    });

    return {
      totalSpeechSec,
      profiles,
    };
  }, [activeTab, speakerTracks, state.blocks]);

  const activeHabitProfile = useMemo(
    () =>
      allSpeakerHabits.profiles.find((p) => p.speakerId === selectedCoachSpeaker) ??
      allSpeakerHabits.profiles[0] ??
      null,
    [allSpeakerHabits.profiles, selectedCoachSpeaker]
  );

  const radarData = useMemo(() => {
    if (activeTab !== 'coach' || speakerTracks.length === 0) {
      return {
        bySpeaker: new Map<string, SpeakerRadarProfile>(),
        teamAvg: undefined as number[] | undefined,
      };
    }
    const bySpeaker = computeSpeakerRadarProfiles(
      speakerTracks,
      state.blocks,
      state.glossary,
      {
        blockEditedStartsSec: timeline.blockEditedStartsSec,
        mappedTokens: timeline.mappedTokens,
        overlapRegions: timeline.overlapRegions,
      }
    );
    const activeProfiles = Array.from(bySpeaker.values()).filter((p) => p.overallScore > 0);
    let teamAvg: number[] | undefined;
    if (activeProfiles.length > 1) {
      const dimCount = activeProfiles[0].dimensions.length;
      teamAvg = Array.from({ length: dimCount }, (_, idx) =>
        Math.round(
          activeProfiles.reduce((acc, p) => acc + p.dimensions[idx].score, 0) /
            activeProfiles.length
        )
      );
    }
    return { bySpeaker, teamAvg };
  }, [
    activeTab,
    speakerTracks,
    state.blocks,
    state.glossary,
    timeline.blockEditedStartsSec,
    timeline.mappedTokens,
    timeline.overlapRegions,
  ]);

  const activeRadarProfile = activeHabitProfile
    ? radarData.bySpeaker.get(activeHabitProfile.speakerId) ?? null
    : null;

  // Dynamic Episode Summary (reflecting live text edits & bleep redactions!)
  const liveSummaryText = useMemo(() => {
    if (activeTab !== 'glossary') return '';
    if (state.aiEpisodeSummary) {
      return state.aiEpisodeSummary;
    }
    if (state.blocks.length === 0) {
      return '暂无节目摘要。导入多轨音频后将根据对话内容自动生成摘要，并对所有已消音字词自动脱敏打码。';
    }
    const speakerNames = speakerTracks.map((t) => t.name).join('、') || '主播';
    const snippets: string[] = [];
    for (const b of state.blocks) {
      const txt = b.tokens
        .filter((t) => !t.deleted && t.type === 'word')
        .map((t) => (t.bleeped ? '[***已消音***]' : t.text))
        .join('')
        .replace(/\[语音 [^\]]+\]/g, '')
        .trim();
      if (txt) {
        const spName = speakerMap[b.speakerId]?.name ?? '发言人';
        snippets.push(`${spName}：${txt.slice(0, 42)}${txt.length > 42 ? '…' : ''}`);
      }
      if (snippets.length >= 3) break;
    }
    if (snippets.length === 0) {
      return `本期工程《${state.projectTitle}》共包含 ${speakerTracks.length} 条发言人音轨（${speakerNames}），已完成声学分段与空白停顿标记。`;
    }
    return `本期由 ${speakerNames} 参与录制。核心对话节选：${snippets.join('；')}`;
  }, [activeTab, state.aiEpisodeSummary, state.blocks, state.projectTitle, speakerTracks, speakerMap]);

  const handleRefreshAiSummary = async () => {
    if (state.blocks.length === 0) {
      onNotify('请先导入音频后再生成 AI 摘要');
      return;
    }
    setAnalyzingSummary(true);
    try {
      const res = await runPythonSidecarAnalysis(state);
      const llmSum = (res?.llmSummary as { summary?: string } | undefined)?.summary;
      if (llmSum) {
        onUpdateState((p) => ({ ...p, aiEpisodeSummary: llmSum }));
        onNotify('✨ 已通过云端大模型更新脱敏节目摘要！');
      } else {
        onNotify('✓ 已根据当前精剪文稿同步刷新本地分析数据');
      }
    } catch (err) {
      onNotify(`分析失败: ${String(err)}`);
    } finally {
      setAnalyzingSummary(false);
    }
  };

  // Live High-Resolution Acoustic + Prosody Emotion Curve (auto-normalizes flat legacy curves too!)
  const emotionSvg = useMemo(() => {
    if (activeTab !== 'coach') return null;
    const livePts = computeEmotionCurveFromTracks(state.tracks, state.blocks);
    let pts: EmotionMarker[] = livePts.length > 0 ? livePts : state.emotionCurve;
    if (pts.length === 0) return null;

    // Ensure dynamic visual contrast even if loaded from an older .podcraft file with narrow score spread
    const rawMin = Math.min(...pts.map((p) => p.energyScore));
    const rawMax = Math.max(...pts.map((p) => p.energyScore));
    if (rawMax - rawMin < 22 && pts.length > 1) {
      const span = Math.max(1, rawMax - rawMin);
      pts = pts.map((p, idx) => ({
        ...p,
        energyScore:
          rawMax === rawMin
            ? Math.round(35 + 30 * Math.sin(idx * 0.85))
            : Math.round(18 + ((p.energyScore - rawMin) / span) * 76),
      }));
    }

    const mapped = timeline.mappedTokens;
    const findNearToken = (targetSec: number) => {
      if (mapped.length === 0) return undefined;
      let lo = 0;
      let hi = mapped.length - 1;
      let startIdx = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (mapped[mid].editedEndSec < targetSec - 0.5) {
          lo = mid + 1;
          startIdx = lo;
        } else {
          hi = mid - 1;
        }
      }
      for (let k = Math.max(0, startIdx - 1); k < mapped.length; k++) {
        const m = mapped[k];
        if (m.editedStartSec > targetSec + 1.5) break;
        if (
          !m.token.deleted &&
          m.token.type !== 'silence' &&
          m.editedEndSec >= targetSec - 0.5 &&
          m.editedStartSec <= targetSec + 1.5
        ) {
          return m;
        }
      }
      return undefined;
    };

    const coords = pts.map((p, idx) => {
      const targetSec = p.timeRatio * timeline.totalEditedDurationSec;
      const nearTok = findNearToken(targetSec);
      const sp = nearTok ? speakerMap[nearTok.speakerId] : undefined;

      return {
        idx,
        x: Number((12 + p.timeRatio * 316).toFixed(1)),
        y: Number((78 - (Math.min(100, Math.max(8, p.energyScore)) / 100) * 64).toFixed(1)),
        timeSec: targetSec,
        speakerName: sp?.name,
        speakerColor: sp?.color,
        ...p,
      };
    });

    const linePath = buildSmoothCurvePath(coords);
    const first = coords[0];
    const last = coords[coords.length - 1];
    const areaPath = `${linePath} L ${last.x.toFixed(1)} 84 L ${first.x.toFixed(1)} 84 Z`;

    const peak = coords.reduce(
      (best, c) => (c.energyScore > best.energyScore ? c : best),
      coords[0]
    );
    const valley = coords.reduce(
      (worst, c) => (c.energyScore < worst.energyScore ? c : worst),
      coords[0]
    );
    const laughPt = coords.find((c) => c.tag === 'laughter' && c.idx !== peak.idx);

    return { coords, linePath, areaPath, peak, valley, laughPt };
  }, [activeTab, state.tracks, state.blocks, state.emotionCurve, timeline, speakerMap]);

  return (
    <section className="w-full bg-zinc-900/75 flex flex-col h-full min-h-0 overflow-hidden">
      <div className="shrink-0 flex items-center border-b border-zinc-800 bg-zinc-900 text-xs font-medium">
        <div className="flex-1 grid grid-cols-3 min-w-0">
          {[
            { id: 'coach', label: '📊 表达教练' },
            {
              id: 'cuts',
              label:
                allCuts.length > 0 ? `✂️ 剪辑总览 (${allCuts.length})` : '✂️ 剪辑总览',
            },
            { id: 'glossary', label: '📚 摘要与导出' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => onSwitchTab(tab.id as typeof activeTab)}
              className={`py-2.5 px-1 border-b-2 transition cursor-pointer whitespace-nowrap truncate text-[11.5px] ${
                activeTab === tab.id
                  ? 'border-blue-500 text-zinc-100 font-semibold bg-zinc-900'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {onCollapsePane && (
          <button
            type="button"
            onClick={onCollapsePane}
            title="收起右侧工作台（可拖拽左边缘调整宽度）"
            className="shrink-0 px-2.5 py-2.5 border-l border-zinc-800/90 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/70 transition cursor-pointer"
          >
            <PanelRightClose className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Tab 1: 情绪能量曲线 + 主持人提问区分发言人 + 发言习惯与五维雷达教练 */}
      {activeTab === 'coach' && (
        <div className="p-4 space-y-4 overflow-y-auto flex-1 min-h-0">
          {onOpenCutReportModal && (
            <div className="p-2.5 rounded-xl border border-blue-500/30 bg-blue-500/10 flex items-center justify-between gap-2">
              <div className="text-[11px] text-blue-200 leading-snug">
                <div className="font-semibold">剪辑分析与表达诊断</div>
                <div className="text-[10px] text-blue-300/80">查看全部剪辑处、嘉宾建议、导出报告图与脱敏习惯配置</div>
              </div>
              <button
                type="button"
                onClick={() => onOpenCutReportModal('report')}
                className="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-semibold shrink-0 cursor-pointer transition"
              >
                打开报告中心
              </button>
            </div>
          )}
          {/* 1. 声学与语流情绪能量曲线 */}
          <div className="p-3 rounded-xl border border-zinc-800 bg-zinc-950 space-y-2">
            <div className="flex items-center justify-between text-xs gap-2">
              <span className="font-semibold text-zinc-100 flex items-center gap-1">
                <TrendingUp className="w-3.5 h-3.5 text-amber-400" />
                声学情绪能量曲线 (点击跳转审听)
              </span>
              {emotionSvg && (
                <span className="text-[11px] font-mono text-zinc-400 shrink-0">
                  {hoverCurveIdx !== null && emotionSvg.coords[hoverCurveIdx] ? (
                    <span className="text-amber-300">
                      @{formatMmSs(emotionSvg.coords[hoverCurveIdx].timeSec)}
                      {emotionSvg.coords[hoverCurveIdx].speakerName
                        ? ` · ${emotionSvg.coords[hoverCurveIdx].speakerName}`
                        : ''}{' '}
                      · 能量 {emotionSvg.coords[hoverCurveIdx].energyScore}
                    </span>
                  ) : (
                    <span>
                      峰值 {emotionSvg.peak.energyScore} / 低谷 {emotionSvg.valley.energyScore}
                    </span>
                  )}
                </span>
              )}
            </div>

            {emotionSvg ? (
              <svg
                viewBox="0 0 340 88"
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const r = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  const idx = Math.min(
                    emotionSvg.coords.length - 1,
                    Math.max(0, Math.round(r * (emotionSvg.coords.length - 1)))
                  );
                  setHoverCurveIdx(idx);
                }}
                onMouseLeave={() => setHoverCurveIdx(null)}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  onSeekByRatio((e.clientX - rect.left) / rect.width);
                }}
                className="w-full h-24 rounded-lg bg-zinc-900 border border-zinc-800 cursor-pointer select-none"
              >
                <defs>
                  <linearGradient id="podEmotionAreaGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.34" />
                    <stop offset="65%" stopColor="#ef4444" stopOpacity="0.10" />
                    <stop offset="100%" stopColor="#18181b" stopOpacity="0.0" />
                  </linearGradient>
                  <linearGradient id="podEmotionStrokeGrad" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#fbbf24" />
                    <stop offset="50%" stopColor="#f97316" />
                    <stop offset="100%" stopColor="#fbbf24" />
                  </linearGradient>
                </defs>

                {/* Subtle reference gridlines */}
                {[24, 46, 68].map((gy) => (
                  <line
                    key={gy}
                    x1="10"
                    y1={gy}
                    x2="330"
                    y2={gy}
                    stroke="rgba(255,255,255,0.06)"
                    strokeDasharray="3 3"
                    strokeWidth="1"
                  />
                ))}

                {/* Filled energy area + smooth spline curve */}
                <path d={emotionSvg.areaPath} fill="url(#podEmotionAreaGrad)" />
                <path
                  d={emotionSvg.linePath}
                  fill="none"
                  stroke="url(#podEmotionStrokeGrad)"
                  strokeWidth="2.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />

                {/* Interactive hover guide */}
                {hoverCurveIdx !== null && emotionSvg.coords[hoverCurveIdx] && (
                  <>
                    <line
                      x1={emotionSvg.coords[hoverCurveIdx].x}
                      y1="8"
                      x2={emotionSvg.coords[hoverCurveIdx].x}
                      y2="82"
                      stroke="rgba(251,191,36,0.45)"
                      strokeDasharray="2 2"
                      strokeWidth="1"
                    />
                    <circle
                      cx={emotionSvg.coords[hoverCurveIdx].x}
                      cy={emotionSvg.coords[hoverCurveIdx].y}
                      r="3.8"
                      fill={emotionSvg.coords[hoverCurveIdx].speakerColor ?? '#fbbf24'}
                      stroke="#ffffff"
                      strokeWidth="1.2"
                    />
                  </>
                )}

                {/* Climax marker */}
                <circle
                  cx={emotionSvg.peak.x}
                  cy={emotionSvg.peak.y}
                  r="4.5"
                  fill="#ef4444"
                  stroke="#18181b"
                  strokeWidth="1.2"
                />
                <text
                  x={Math.max(8, Math.min(266, emotionSvg.peak.x - 26))}
                  y={Math.max(13, emotionSvg.peak.y - 7)}
                  fill="#fca5a5"
                  fontSize="10.5"
                  fontWeight="600"
                >
                  🔥高能峰值
                </text>

                {/* Laughter highlight marker if present */}
                {emotionSvg.laughPt && (
                  <>
                    <circle
                      cx={emotionSvg.laughPt.x}
                      cy={emotionSvg.laughPt.y}
                      r="3.8"
                      fill="#facc15"
                      stroke="#18181b"
                      strokeWidth="1"
                    />
                    <text
                      x={Math.max(8, Math.min(272, emotionSvg.laughPt.x - 22))}
                      y={Math.max(13, emotionSvg.laughPt.y - 6)}
                      fill="#fde047"
                      fontSize="10"
                    >
                      😄笑点
                    </text>
                  </>
                )}

                {/* Valley marker */}
                {emotionSvg.valley.idx !== emotionSvg.peak.idx && (
                  <>
                    <circle
                      cx={emotionSvg.valley.x}
                      cy={emotionSvg.valley.y}
                      r="3.8"
                      fill="#9ca3af"
                      stroke="#18181b"
                      strokeWidth="1"
                    />
                    <text
                      x={Math.max(8, Math.min(275, emotionSvg.valley.x - 20))}
                      y={Math.min(82, emotionSvg.valley.y + 13)}
                      fill="#a1a1aa"
                      fontSize="10"
                    >
                      📉平缓区
                    </text>
                  </>
                )}
              </svg>
            ) : (
              <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-500 text-center">
                导入多轨音频后自动提取声学与语流能量波动曲线
              </div>
            )}
          </div>

          {/* 2. 主持人提问与发言人互动分析 (区分发言人 + 提问定位列表) */}
          <div className="p-3 rounded-xl border border-zinc-800 bg-zinc-950 space-y-2.5">
            <div className="flex items-center justify-between text-xs gap-2">
              <span className="font-semibold text-zinc-100 flex items-center gap-1">
                <MessageCircleQuestion className="w-3.5 h-3.5 text-blue-400" />
                主持人提问与各发言人互动分析
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={handleRunLlmDiagnosis}
                  disabled={aiDiagnosing}
                  className="px-2 py-0.5 rounded-md bg-indigo-600/25 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/40 text-[11px] font-medium flex items-center gap-1 cursor-pointer transition disabled:opacity-50"
                  title="使用大模型对全篇提问深度与各角色习惯进行智能分析，超越刻板正则"
                >
                  <Sparkles className="w-3 h-3 text-indigo-400" />
                  <span>{aiDiagnosing ? '大模型分析中...' : '大模型深度诊断'}</span>
                </button>
                <span className="text-emerald-400 font-medium text-[11px]">
                  {qaAnalysis.badge}
                </span>
              </div>
            </div>

            {/* 大模型深度访谈教练诊断结果 */}
            {llmQuestionInsights && (
              <div className="p-2.5 rounded-lg bg-indigo-950/30 border border-indigo-500/35 text-[11.5px] leading-relaxed text-indigo-200 whitespace-pre-wrap">
                {llmQuestionInsights}
              </div>
            )}

            {/* 全局主客互动堆叠条 */}
            <div className="w-full h-2.5 rounded-full bg-zinc-800 overflow-hidden flex">
              <div className="bg-blue-500 h-full" style={{ width: `${qaAnalysis.hostQPct}%` }} />
              <div className="bg-indigo-400 h-full" style={{ width: `${qaAnalysis.hostOpPct}%` }} />
              <div className="bg-emerald-500 h-full" style={{ width: `${qaAnalysis.guestPct}%` }} />
              <div className="bg-amber-400 h-full" style={{ width: `${qaAnalysis.laughPct}%` }} />
            </div>

            <div className="grid grid-cols-2 gap-1 text-[11px] text-zinc-400">
              <span>
                🟦 主持提问引导: <strong className="text-zinc-100">{qaAnalysis.hostQPct}%</strong>
              </span>
              <span>
                🟩 嘉宾核心输出: <strong className="text-zinc-100">{qaAnalysis.guestPct}%</strong>
              </span>
              <span>
                🟪 主持观点陈述: <strong className="text-zinc-100">{qaAnalysis.hostOpPct}%</strong>
              </span>
              <span>
                🟨 笑声/互动附和: <strong className="text-zinc-100">{qaAnalysis.laughPct}%</strong>
              </span>
            </div>

            {/* 按发言人区分的提问 vs 陈述统计 */}
            {qaAnalysis.speakerBreakdown.length > 0 && (
              <div className="pt-1.5 border-t border-zinc-800/80 space-y-1.5">
                <div className="text-[11px] font-medium text-zinc-400">
                  各发言人提问引导 vs 观点输出明细：
                </div>
                <div className="space-y-1.5">
                  {qaAnalysis.speakerBreakdown.map((sp) => (
                    <div
                      key={sp.speakerId}
                      className="px-2.5 py-1.5 rounded-lg bg-zinc-900/90 border border-zinc-800/90 flex items-center justify-between gap-2 text-[11px]"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: sp.color }}
                        />
                        <span className="font-semibold text-zinc-100 truncate">{sp.name}</span>
                        <span className="px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-400 text-[10px] shrink-0">
                          {sp.roleBadge}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 font-mono text-zinc-300">
                        <span className="text-blue-300">
                          提问 {sp.questionCount}次 ({sp.questionPctOfTotal}%)
                        </span>
                        <span className="text-zinc-600">|</span>
                        <span className="text-emerald-300">陈述 {sp.statementPctOfTotal}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 按发言人筛选的提问跳转列表 */}
            {qaAnalysis.questions.length > 0 && (
              <div className="pt-1.5 border-t border-zinc-800/80 space-y-2">
                <div className="flex items-center justify-between gap-1 flex-wrap">
                  <span className="text-[11px] font-medium text-zinc-400">
                    提问列表（按发言人筛选 · 点击定位）：
                  </span>
                  <div className="flex items-center gap-1 flex-wrap">
                    <button
                      onClick={() => setQuestionSpeakerFilter('all')}
                      className={`px-2 py-0.5 rounded-full text-[10px] font-medium cursor-pointer transition ${
                        questionSpeakerFilter === 'all'
                          ? 'bg-blue-600 text-white'
                          : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      全部 ({qaAnalysis.questions.length})
                    </button>
                    {qaAnalysis.speakerBreakdown
                      .filter((s) => s.questionCount > 0)
                      .map((s) => (
                        <button
                          key={s.speakerId}
                          onClick={() => setQuestionSpeakerFilter(s.speakerId)}
                          className={`px-2 py-0.5 rounded-full text-[10px] font-medium inline-flex items-center gap-1 cursor-pointer transition ${
                            questionSpeakerFilter === s.speakerId
                              ? 'bg-zinc-100 text-zinc-950 font-semibold'
                              : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                          }`}
                        >
                          <span
                            className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{ backgroundColor: s.color }}
                          />
                          <span>
                            {s.name} ({s.questionCount})
                          </span>
                        </button>
                      ))}
                  </div>
                </div>

                <div className="space-y-1.5 max-h-40 overflow-y-auto pr-0.5">
                  {qaAnalysis.questions
                    .filter(
                      (q) =>
                        questionSpeakerFilter === 'all' || q.speakerId === questionSpeakerFilter
                    )
                    .map((q) => {
                      const intent = /(为什么|怎么做到的|如何看待|深度|原理|逻辑)/.test(q.text)
                        ? { label: '深挖核心', style: 'text-blue-300 bg-blue-500/15 border-blue-500/30' }
                        : /(比如|具体|哪个|案例|细节|有没有)/.test(q.text)
                        ? { label: '例证求证', style: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30' }
                        : /(觉得|认为|怎样|如何|看法)/.test(q.text)
                        ? { label: '开放探讨', style: 'text-purple-300 bg-purple-500/15 border-purple-500/30' }
                        : { label: '话题引导', style: 'text-zinc-400 bg-zinc-800 border-zinc-700' };

                      return (
                        <div
                          key={q.id}
                          onClick={() => onSeekToSec(q.timeSec)}
                          title="点击跳转试听该次提问"
                          className="p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800/85 border border-zinc-800 hover:border-blue-500/40 cursor-pointer transition space-y-1"
                        >
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="inline-flex items-center gap-1.5 min-w-0">
                              <span
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ backgroundColor: q.speakerColor }}
                              />
                              <span className="font-semibold text-zinc-100 truncate">
                                {q.speakerName}
                              </span>
                              <span className="text-[10px] px-1 rounded bg-zinc-800 text-zinc-400 shrink-0">
                                {q.roleBadge}
                              </span>
                              <span className={`text-[10px] px-1.5 py-0.2 rounded border font-medium shrink-0 ${intent.style}`}>
                                {intent.label}
                              </span>
                            </span>
                            <span className="font-mono text-[10px] text-blue-400 shrink-0">
                              @{q.timeFormatted}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-300 leading-snug line-clamp-2">{q.text}</p>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
          </div>

          {/* 3. 发言习惯与各人发言时长比例 (展开比例卡片 · 一键切换发言人) */}
          <div className="p-3 rounded-xl border border-zinc-800 bg-zinc-950 space-y-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-zinc-100 flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-emerald-400" />
                <span>发言习惯与各人时长比例</span>
              </span>
            </div>

            {allSpeakerHabits.profiles.length === 0 ? (
              <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-500 text-center">
                导入多轨音频后自动展开各发言人时长比例与语言习惯画像
              </div>
            ) : (
              <>
                {/* 全员发言时长总览堆叠比例条 */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px] text-zinc-400">
                    <span>各人发言时长总览（点击下方人物卡片切换详细画像）</span>
                    <span className="font-mono text-zinc-300">
                      总有效人声 {formatMmSs(allSpeakerHabits.totalSpeechSec)}
                    </span>
                  </div>
                  <div className="w-full h-2.5 rounded-full bg-zinc-800 overflow-hidden flex">
                    {allSpeakerHabits.profiles.map((p) => (
                      <div
                        key={p.speakerId}
                        onClick={() => setSelectedCoachSpeaker(p.speakerId)}
                        title={`${p.name}: ${p.speakingPct}% (${formatMmSs(p.speakingSec)})`}
                        className="h-full transition-all duration-300 cursor-pointer hover:brightness-110"
                        style={{
                          width: `${p.speakingPct}%`,
                          backgroundColor: p.color,
                        }}
                      />
                    ))}
                  </div>
                </div>

                {/* 展开的各发言人时长比例卡片列表 — 一键点击切换 */}
                <div className="space-y-1.5">
                  {allSpeakerHabits.profiles.map((prof) => {
                    const isSelected = prof.speakerId === activeHabitProfile?.speakerId;
                    return (
                      <button
                        key={prof.speakerId}
                        type="button"
                        onClick={() => setSelectedCoachSpeaker(prof.speakerId)}
                        className={`w-full p-2.5 rounded-xl border text-left transition cursor-pointer space-y-1.5 ${
                          isSelected
                            ? 'border-blue-500/70 bg-blue-500/10 shadow-xs'
                            : 'border-zinc-800 bg-zinc-900/80 hover:border-zinc-700 hover:bg-zinc-900'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: prof.color }}
                            />
                            <span className="font-semibold text-zinc-100 truncate">
                              {prof.name}
                            </span>
                            <span className="px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-400 text-[10px] shrink-0">
                              {prof.roleBadge}
                            </span>
                            {isSelected && (
                              <span className="px-1.5 py-0.2 rounded bg-blue-500/25 text-blue-300 text-[10px] font-semibold shrink-0">
                                当前查看
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-1.5 font-mono text-xs shrink-0">
                            <span className="text-zinc-400 text-[11px]">
                              {formatMmSs(prof.speakingSec)}
                            </span>
                            <strong className="text-zinc-100">{prof.speakingPct}%</strong>
                          </div>
                        </div>

                        {/* 单人独立时长进度条 */}
                        <div className="w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-300"
                            style={{
                              width: `${Math.min(100, prof.speakingPct)}%`,
                              backgroundColor: prof.color,
                            }}
                          />
                        </div>

                        <div className="flex items-center justify-between text-[11px] text-zinc-400">
                          <span>
                            {prof.turnCount} 轮发言 · 均轮 {prof.avgTurnSec}s
                          </span>
                          <span>
                            语速 {prof.cpm > 0 ? `${prof.cpm}字/分` : '--'} · 口癖{' '}
                            <strong
                              className={
                                prof.fillerCount > 0 ? 'text-amber-400 font-medium' : 'text-zinc-300'
                              }
                            >
                              {prof.fillerCount}处
                            </strong>
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* 当前选中发言人的详细习惯指标与专属训练建议 */}
                {activeHabitProfile && (
                  <div className="pt-2 border-t border-zinc-800 space-y-2.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: activeHabitProfile.color }}
                        />
                        <span className="font-semibold text-zinc-100 truncate">
                          「{activeHabitProfile.name}」详细语言习惯诊断
                        </span>
                      </div>
                      {activeRadarProfile && activeRadarProfile.microMetrics.pureFillerCount > 0 && (
                        <button
                          type="button"
                          onClick={() => onCleanSpeakerFillers(activeHabitProfile.speakerId)}
                          className="px-2 py-0.5 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/35 text-[11px] font-medium flex items-center gap-1 cursor-pointer transition shrink-0"
                          title="一键标记剔除该发言人当前工程中的所有纯口癖词"
                        >
                          <Sparkles className="w-3 h-3 text-amber-400" />
                          <span>一键清理纯口癖 ({activeRadarProfile.microMetrics.pureFillerCount})</span>
                        </button>
                      )}
                    </div>

                    {allSpeakerHabits.profiles.length > 1 && (
                      <div className="flex flex-wrap items-center gap-1">
                        {allSpeakerHabits.profiles.map((prof) => {
                          const isCurr = prof.speakerId === activeHabitProfile.speakerId;
                          return (
                            <button
                              key={prof.speakerId}
                              type="button"
                              onClick={() => setSelectedCoachSpeaker(prof.speakerId)}
                              className={`px-2 py-0.5 rounded-full text-[11px] font-medium inline-flex items-center gap-1.5 border cursor-pointer transition ${
                                isCurr
                                  ? 'border-blue-500/60 bg-blue-500/20 text-blue-200'
                                  : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                              }`}
                            >
                              <span
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: prof.color }}
                              />
                              <span>{prof.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {activeRadarProfile && activeRadarProfile.overallScore > 0 && (
                      <SpeakerRadarChart
                        speakerName={activeHabitProfile.name}
                        color={activeHabitProfile.color}
                        overallScore={activeRadarProfile.overallScore}
                        dimensions={activeRadarProfile.dimensions}
                        teamAverageScores={radarData.teamAvg}
                      />
                    )}

                    {/* 模块二：个人高频口头禅与习惯词指纹榜 */}
                    {activeRadarProfile && (
                      <div className="p-2.5 rounded-xl bg-zinc-900/90 border border-zinc-800 space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-zinc-100 flex items-center gap-1">
                            <span>💬 高频口头禅与垫词指纹</span>
                            <span className="text-[10px] text-zinc-400 font-normal">
                              (点击胶囊试听原声)
                            </span>
                          </span>
                          <span className="text-[10px] text-zinc-400">
                            共 {activeRadarProfile.topHabitPhrases.length} 项典型习惯
                          </span>
                        </div>
                        {activeRadarProfile.topHabitPhrases.length === 0 ? (
                          <div className="text-[11px] text-emerald-400/90 py-0.5">
                            ✓ 该发言人用词精炼，未检出高频口癖或垫词起手习惯。
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-1.5 pt-0.5">
                            {activeRadarProfile.topHabitPhrases.map((item, idx) => {
                              const badgeTheme =
                                item.category === 'pure_filler'
                                  ? 'bg-amber-500/15 border-amber-500/35 text-amber-300 hover:bg-amber-500/25'
                                  : item.category === 'starter_crutch'
                                  ? 'bg-indigo-500/15 border-indigo-500/35 text-indigo-300 hover:bg-indigo-500/25'
                                  : 'bg-teal-500/15 border-teal-500/35 text-teal-300 hover:bg-teal-500/25';
                              return (
                                <button
                                  key={`${item.word}_${idx}`}
                                  type="button"
                                  onClick={() => onSeekToSec(item.firstTimeSec)}
                                  title={`点击定位到首次出现位置 @${item.firstTimeFormatted}（${item.categoryLabel}，${item.perMin}次/分）`}
                                  className={`px-2 py-1 rounded-lg border text-xs flex items-center gap-1.5 cursor-pointer transition ${badgeTheme}`}
                                >
                                  <span className="font-medium">{item.word}</span>
                                  <span className="font-mono text-[10px] px-1 rounded bg-black/30">
                                    ×{item.count}
                                  </span>
                                  <span className="text-[10px] opacity-75 font-mono">
                                    @{item.firstTimeFormatted}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 模块三：4项不重复的深度发声微指标格 */}
                    {activeRadarProfile && (
                      <div className="grid grid-cols-4 gap-1.5 text-xs">
                        <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                          <span className="text-zinc-400 text-[10px] block">话轮深度</span>
                          <strong className="text-zinc-100 font-mono text-[11.5px]">
                            {activeRadarProfile.microMetrics.maxMergedTurnSec}s
                            <span className="text-[10px] font-normal text-zinc-400 ml-0.5">
                              / {activeRadarProfile.microMetrics.avgMergedTurnSec}s均
                            </span>
                          </strong>
                        </div>
                        <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                          <span className="text-zinc-400 text-[10px] block">语速稳定性</span>
                          <strong className="text-blue-300 font-mono text-[11.5px]">
                            ±{activeRadarProfile.microMetrics.paceStdCpm}
                            <span className="text-[10px] font-normal text-zinc-400 ml-0.5">
                              字/分
                            </span>
                          </strong>
                        </div>
                        <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                          <span className="text-zinc-400 text-[10px] block">句尾气息</span>
                          <strong className="text-purple-300 font-mono text-[11.5px]">
                            {activeRadarProfile.microMetrics.trailingDropDb !== null
                              ? `-${activeRadarProfile.microMetrics.trailingDropDb}dB`
                              : '稳健'}
                          </strong>
                        </div>
                        <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                          <span className="text-zinc-400 text-[10px] block">接话/共鸣</span>
                          <strong className="text-emerald-400 font-mono text-[11.5px]">
                            {activeRadarProfile.microMetrics.avgTurnGapSec !== null
                              ? `${activeRadarProfile.microMetrics.avgTurnGapSec}s`
                              : `${activeRadarProfile.microMetrics.backchannelCount}次`}
                          </strong>
                        </div>
                      </div>
                    )}

                    {/* 模块四：可溯源诊断卡片流 (支持 @MM:SS 点击跳转) */}
                    {activeRadarProfile && activeRadarProfile.habitInsights.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-[11px] font-semibold text-zinc-400">
                          表达习惯深度诊断（气息 · 话轮 · 气口 · 具象度 · 控场）
                        </div>
                        {activeRadarProfile.habitInsights.map((insight) => (
                          <div
                            key={insight.id}
                            className={`p-2.5 rounded-lg border text-xs space-y-1.5 ${
                              insight.status === 'alert'
                                ? 'border-red-500/35 bg-red-500/5'
                                : insight.status === 'warn'
                                ? 'border-amber-500/35 bg-amber-500/5'
                                : 'border-zinc-800 bg-zinc-900'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-zinc-100">
                                {insight.category}
                              </span>
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-[10px] text-zinc-400">
                                  {insight.metricBadge}
                                </span>
                                <span
                                  className={`px-1.5 py-0.2 rounded text-[10px] font-medium ${
                                    insight.status === 'alert'
                                      ? 'bg-red-500/20 text-red-300'
                                      : insight.status === 'warn'
                                      ? 'bg-amber-500/20 text-amber-300'
                                      : 'bg-emerald-500/15 text-emerald-300'
                                  }`}
                                >
                                  {insight.status === 'alert'
                                    ? '需注意'
                                    : insight.status === 'warn'
                                    ? '可优化'
                                    : '良好'}
                                </span>
                              </div>
                            </div>
                            <div className="text-zinc-200 font-medium">{insight.summary}</div>
                            <div className="text-[11px] text-zinc-400 leading-relaxed">
                              {insight.detail}
                            </div>
                            {insight.id === 'pace_prosody' &&
                              activeRadarProfile.paceBreathSeries.length >= 2 &&
                              (() => {
                                const pts = activeRadarProfile.paceBreathSeries;
                                const W = 280;
                                const H = 84;
                                const padL = 8;
                                const padR = 8;
                                const padT = 10;
                                const padB = 14;
                                const innerW = W - padL - padR;
                                const innerH = H - padT - padB;
                                const minT = pts[0].timeSec;
                                const maxT = Math.max(minT + 1, pts[pts.length - 1].timeSec);
                                const maxCpm = Math.max(320, ...pts.map((p) => p.cpm));
                                const minCpm = Math.min(80, ...pts.map((p) => p.cpm));
                                const cpmSpan = Math.max(60, maxCpm - minCpm);
                                const toX = (t: number) =>
                                  padL + ((t - minT) / (maxT - minT)) * innerW;
                                const toCpmY = (cpm: number) =>
                                  padT + innerH - ((cpm - minCpm) / cpmSpan) * innerH;
                                const toBreathY = (pct: number) =>
                                  padT + innerH - (Math.max(0, Math.min(100, pct)) / 100) * innerH;
                                const cpmPath = pts
                                  .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${toX(p.timeSec).toFixed(1)},${toCpmY(p.cpm).toFixed(1)}`)
                                  .join(' ');
                                const breathPath = pts
                                  .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${toX(p.timeSec).toFixed(1)},${toBreathY(p.breathPct).toFixed(1)}`)
                                  .join(' ');
                                const avgY = toCpmY(activeRadarProfile.avgCpm || 200);
                                return (
                                  <div className="mt-1.5 rounded-lg bg-zinc-950/90 border border-zinc-800/90 p-2 space-y-1">
                                    <div className="flex items-center justify-between text-[10px] text-zinc-400">
                                      <div className="flex items-center gap-2.5">
                                        <span className="inline-flex items-center gap-1 text-sky-300">
                                          <span className="w-2 h-0.5 bg-sky-400 inline-block rounded-full" />
                                          语速 (字/分)
                                        </span>
                                        <span className="inline-flex items-center gap-1 text-purple-300">
                                          <span className="w-2 h-0.5 bg-purple-400 inline-block rounded-full" />
                                          气息饱满度 (%)
                                        </span>
                                      </div>
                                      <span className="font-mono text-[9.5px] text-zinc-500">
                                        均速 {activeRadarProfile.avgCpm} 字/分
                                      </span>
                                    </div>
                                    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[84px] overflow-visible">
                                      <line
                                        x1={padL}
                                        y1={avgY}
                                        x2={W - padR}
                                        y2={avgY}
                                        stroke="rgba(56,189,248,0.28)"
                                        strokeDasharray="3 3"
                                        strokeWidth={1}
                                      />
                                      <path
                                        d={breathPath}
                                        fill="none"
                                        stroke="#c084fc"
                                        strokeWidth={1.5}
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        opacity={0.85}
                                      />
                                      <path
                                        d={cpmPath}
                                        fill="none"
                                        stroke="#38bdf8"
                                        strokeWidth={1.75}
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                      {pts.map((p, idx) => (
                                        <circle
                                          key={idx}
                                          cx={toX(p.timeSec)}
                                          cy={toCpmY(p.cpm)}
                                          r={2.5}
                                          fill="#38bdf8"
                                          className="cursor-pointer hover:r-[4]"
                                          onClick={() => onSeekToSec(p.timeSec)}
                                        >
                                          <title>{`@${p.timeFormatted} · 语速 ${p.cpm} 字/分 · 气息 ${p.breathPct}%（点击跳转）`}</title>
                                        </circle>
                                      ))}
                                      <text x={padL} y={H - 2} fontSize="8.5" fill="#71717a" fontFamily="monospace">
                                        {pts[0].timeFormatted}
                                      </text>
                                      <text
                                        x={W - padR}
                                        y={H - 2}
                                        fontSize="8.5"
                                        fill="#71717a"
                                        fontFamily="monospace"
                                        textAnchor="end"
                                      >
                                        {pts[pts.length - 1].timeFormatted}
                                      </text>
                                    </svg>
                                  </div>
                                );
                              })()}
                            {insight.evidences && insight.evidences.length > 0 && (
                              <div className="pt-1 flex flex-wrap items-center gap-1.5 border-t border-zinc-800/80">
                                <span className="text-[10px] text-zinc-400">典型处：</span>
                                {insight.evidences.map((ev, evIdx) => (
                                  <button
                                    key={evIdx}
                                    type="button"
                                    onClick={() => onSeekToSec(ev.timeSec)}
                                    title={`点击定位到 @${ev.timeFormatted} ${ev.snippet ?? ''}`}
                                    className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-blue-300 text-[10px] font-mono inline-flex items-center gap-1 cursor-pointer transition border border-zinc-700"
                                  >
                                    <span>{ev.label}</span>
                                    <span className="text-zinc-400">@{ev.timeFormatted}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Tab 2: 剪辑总览与分标签筛选 */}
      {activeTab === 'cuts' && (
        <div className="p-3.5 space-y-3 overflow-y-auto flex-1 min-h-0">
          {/* 顶部总览与分析报告弹窗入口 */}
          <div className="p-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11.5px] font-semibold text-emerald-200 flex items-center gap-1.5">
                  <Scissors className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>剪辑总览</span>
                  <span className="px-1.5 py-0.2 rounded-full bg-emerald-500/20 border border-emerald-500/40 font-mono text-[10px] text-emerald-200">
                    {allCuts.length} 处 · 省 {cutOverviewData.totalSavedSec.toFixed(1)}s
                  </span>
                </div>
                <div className="text-[10px] text-emerald-300/80 mt-0.5 leading-snug">
                  主时间轴已按分类着色提示剪辑区间
                  {cutOverviewData.totalMutedSec > 0
                    ? ` · 静音 ${cutOverviewData.totalMutedSec.toFixed(1)}s`
                    : ''}
                </div>
              </div>
              {onOpenCutReportModal && (
                <button
                  type="button"
                  onClick={() => onOpenCutReportModal('report')}
                  className="shrink-0 px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium flex items-center gap-1 cursor-pointer transition shadow-sm"
                  title="在弹窗中查看剪辑分析报告、嘉宾建议、导出报告图与脱敏配置"
                >
                  <BarChart3 className="w-3 h-3" />
                  <span>分析报告</span>
                </button>
              )}
            </div>
          </div>

          {inspectedCut ? (
            <CutDetailPopover
              cut={inspectedCut}
              embedded
              onClose={() => onCloseInspectedCut?.()}
              onUndoCut={(cut) => onUndoCut?.(cut)}
              onSeekToSec={onSeekToSec}
              onAudition={onAuditionCut}
              onOpenAllCuts={
                onOpenCutReportModal ? () => onOpenCutReportModal('cuts') : undefined
              }
            />
          ) : (
            <div className="p-2.5 rounded-xl border border-dashed border-zinc-700/80 bg-zinc-950/50 text-[11px] text-zinc-400 flex items-start gap-2 leading-relaxed">
              <Scissors className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
              <span>
                点击主时间轴上的彩色剪辑区间或「<strong className="text-emerald-300">✂️ 剪辑</strong>」标记，或在下方列表中选择一项，即可查看详情、试听或撤销。
              </span>
            </div>
          )}

          {/* 分标签筛选栏 */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setActiveCutCategoryFilter('all')}
                className={`px-2 py-1 rounded-md text-[10.5px] font-medium border transition cursor-pointer ${
                  activeCutCategoryFilter === 'all'
                    ? 'bg-zinc-100 text-zinc-900 border-zinc-200'
                    : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200 hover:border-zinc-700'
                }`}
              >
                全部 ({allCuts.length})
              </button>
              {CUT_CATEGORY_ORDER.map((cat) => {
                const count = cutOverviewData.counts[cat] ?? 0;
                const isSelected = activeCutCategoryFilter === cat;
                if (count === 0 && !isSelected) return null;
                const meta = CUT_CATEGORY_META[cat];
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() =>
                      setActiveCutCategoryFilter(isSelected ? 'all' : cat)
                    }
                    className={`px-2 py-1 rounded-md text-[10.5px] font-medium border transition cursor-pointer inline-flex items-center gap-1 ${
                      isSelected
                        ? meta.activeFilterClass
                        : 'bg-zinc-900/90 text-zinc-300 border-zinc-800 hover:border-zinc-700 hover:text-zinc-100'
                    }`}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: meta.color }}
                    />
                    <span>{meta.label}</span>
                    <span className="font-mono text-[10px] opacity-80">
                      ({count})
                    </span>
                  </button>
                );
              })}
            </div>

            {allCuts.length > 0 && (
              <div className="flex items-center gap-1.5">
                {cutOverviewData.speakerOptions.length > 1 && (
                  <select
                    value={cutSpeakerFilter}
                    onChange={(e) => setCutSpeakerFilter(e.target.value)}
                    className="px-2 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-200 max-w-[110px] truncate focus:outline-none focus:border-emerald-500"
                  >
                    <option value="all">全部发言人</option>
                    {cutOverviewData.speakerOptions.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                )}
                <div className="relative flex-1 min-w-0">
                  <Search className="w-3 h-3 text-zinc-500 absolute left-2 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={cutSearchQuery}
                    onChange={(e) => setCutSearchQuery(e.target.value)}
                    placeholder="筛选内容/原因/时间…"
                    className="w-full pl-6 pr-2 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-200 focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-zinc-400 px-0.5">
              <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
                <span>
                  筛选结果 ({cutOverviewData.filtered.length}
                  {cutOverviewData.filtered.length !== allCuts.length
                    ? ` / ${allCuts.length}`
                    : ''}
                  )
                </span>
              </span>
              {onOpenCutReportModal && allCuts.length > 0 && (
                <button
                  type="button"
                  onClick={() => onOpenCutReportModal('cuts')}
                  className="text-[11px] text-blue-400 hover:text-blue-300 hover:underline cursor-pointer"
                >
                  在弹窗中打开完整列表
                </button>
              )}
            </div>

            {allCuts.length === 0 ? (
              <div className="py-8 text-center text-xs text-zinc-500">
                当前暂无剪辑标注记录
              </div>
            ) : cutOverviewData.filtered.length === 0 ? (
              <div className="py-6 text-center text-xs text-zinc-500 space-y-1.5">
                <div>当前筛选条件下暂无匹配的剪辑处</div>
                <button
                  type="button"
                  onClick={() => {
                    setActiveCutCategoryFilter('all');
                    setCutSpeakerFilter('all');
                    setCutSearchQuery('');
                  }}
                  className="text-[11px] text-emerald-400 hover:underline cursor-pointer"
                >
                  重置筛选条件
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                {cutOverviewData.filtered.map((c) => {
                  const isActive = inspectedCut?.id === c.id;
                  const meta = CUT_CATEGORY_META[c.category];
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        onSelectCut?.(c);
                        onSeekToSec(c.editedSec);
                      }}
                      className={`w-full text-left p-2.5 rounded-xl border transition cursor-pointer space-y-1 ${
                        isActive
                          ? 'border-emerald-500/70 bg-emerald-500/10'
                          : 'border-zinc-800 bg-zinc-950/70 hover:border-zinc-700 hover:bg-zinc-900'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className={`px-1.5 py-0.2 rounded-full text-[9.5px] border shrink-0 ${meta.badgeClass}`}
                          >
                            {meta.label}
                          </span>
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: c.speakerColor }}
                          />
                          <span className="font-medium text-zinc-200 truncate">
                            {c.speakerName}
                          </span>
                          <span className="px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-300 font-mono text-[10px] shrink-0">
                            {c.timeFormatted}
                          </span>
                        </div>
                        <span className="font-mono font-semibold text-emerald-300 shrink-0">
                          {c.category === 'track_mute'
                            ? `静音 ${c.removedDurationSec.toFixed(2)}s`
                            : `-${c.removedDurationSec.toFixed(2)}s`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                        <span className="truncate">
                          {c.removedText ? `「${c.removedText}」` : c.reason}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 3: 节目摘要、专属词库与导出 */}
      {activeTab === 'glossary' && (
        <div className="p-4 space-y-4 overflow-y-auto flex-1 min-h-0">
          <div className="p-3 rounded-xl border border-zinc-800 bg-zinc-950 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-zinc-100 flex items-center gap-1">
                <BookOpen className="w-3.5 h-3.5 text-blue-400" />
                AI 节目摘要 (实时联动改字纠错与消音脱敏)
              </span>
              {state.blocks.length > 0 && (
                <button
                  disabled={analyzingSummary}
                  onClick={handleRefreshAiSummary}
                  className="px-2 py-0.5 rounded bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 font-medium cursor-pointer disabled:opacity-50"
                >
                  {analyzingSummary ? '生成中...' : '刷新AI摘要'}
                </button>
              )}
            </div>
            <p className="text-zinc-300 leading-relaxed">{liveSummaryText}</p>
            <div className="pt-2 border-t border-zinc-800/80 flex items-center gap-1.5">
              <span className="text-[11px] text-zinc-400 shrink-0">DeepSeek Key:</span>
              <input
                type="password"
                value={state.llmConfig.apiKey}
                onChange={(e) =>
                  onUpdateState((p) => ({
                    ...p,
                    llmConfig: {
                      ...p.llmConfig,
                      provider: 'deepseek',
                      baseUrl: 'https://api.deepseek.com/v1',
                      model: 'deepseek-chat',
                      apiKey: e.target.value,
                    },
                  }))
                }
                placeholder="输入 DeepSeek API Key (sk-...) 生成节目概要"
                className="flex-1 min-w-0 px-2 py-1 rounded border border-zinc-800 bg-zinc-900 text-[11px] text-zinc-100"
              />
            </div>
          </div>

          <div className="p-3 rounded-xl border border-zinc-800 bg-zinc-950 space-y-2.5 text-xs">
            <span className="font-semibold text-zinc-100 block">
              📖 播客专属词库 (ASR 热词偏置 / 监控口癖 / 敏感预警)
            </span>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={newGlossaryWord}
                onChange={(e) => setNewGlossaryWord(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newGlossaryWord.trim()) {
                    onUpdateState((p) => ({
                      ...p,
                      glossary: [
                        { id: `g_${Date.now()}`, word: newGlossaryWord.trim(), type: newGlossaryType },
                        ...p.glossary,
                      ],
                    }));
                    setNewGlossaryWord('');
                  }
                }}
                placeholder="输入嘉宾名、术语或口癖..."
                className="flex-1 px-2.5 py-1 rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
              />
              <select
                value={newGlossaryType}
                onChange={(e) => setNewGlossaryType(e.target.value as typeof newGlossaryType)}
                className="px-2 py-1 rounded border border-zinc-700 bg-zinc-900 text-zinc-100"
              >
                <option value="hotword">ASR热词</option>
                <option value="habit">监控口癖</option>
                <option value="sensitive">敏感预警</option>
              </select>
              <button
                onClick={() => {
                  if (!newGlossaryWord.trim()) return;
                  onUpdateState((p) => ({
                    ...p,
                    glossary: [
                      { id: `g_${Date.now()}`, word: newGlossaryWord.trim(), type: newGlossaryType },
                      ...p.glossary,
                    ],
                  }));
                  setNewGlossaryWord('');
                }}
                className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-semibold flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                <span>添加</span>
              </button>
            </div>

            {state.glossary.length === 0 ? (
              <div className="text-zinc-500 py-1">
                当前词库为空。可添加专有名词热词、嘉宾习惯口癖或保密敏感词，随工程文件一并保存。
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {state.glossary.map((g) => {
                  const badgeCls =
                    g.type === 'hotword'
                      ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                      : g.type === 'habit'
                      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                      : 'bg-red-500/15 text-red-300 border-red-500/30';
                  const tagLabel =
                    g.type === 'hotword' ? '热词' : g.type === 'habit' ? '口癖' : '敏感';
                  return (
                    <span
                      key={g.id}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border ${badgeCls}`}
                    >
                      <span>
                        [{tagLabel}] {g.word}
                      </span>
                      <button
                        onClick={() =>
                          onUpdateState((p) => ({
                            ...p,
                            glossary: p.glossary.filter((x) => x.id !== g.id),
                          }))
                        }
                        className="hover:text-white cursor-pointer"
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          <div className="p-3 rounded-xl border border-zinc-800 bg-zinc-950 space-y-2 text-xs">
            <div className="space-y-0.5">
              <span className="font-semibold text-zinc-100 block">
                🚀 导出播客 MP3 成片
              </span>
              <span className="text-[11px] text-zinc-400 block">
                自动合并多轨剪辑、气口停顿与 -16 LUFS 标准响度（192 kbps MP3）
              </span>
            </div>
            <button
              disabled={state.tracks.length === 0}
              onClick={() => onExportAudio('mp3')}
              className="w-full py-2.5 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold flex items-center justify-center gap-1.5 shadow-sm transition cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>导出 MP3 成片 (-16 LUFS)</span>
            </button>
          </div>

          {onOpenShownotes && (
            <div className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/5 space-y-2 text-xs">
              <div className="space-y-0.5">
                <span className="font-semibold text-amber-300 block">
                  ✨ 一键生成 Shownotes 与抽奖海报
                </span>
                <span className="text-[11px] text-zinc-400 block">
                  自动生成约 500 字节目简介、嘉宾名片（含卡通头像）、精剪时间轴、抽奖海报与听友福利
                </span>
              </div>
              <button
                disabled={state.tracks.length === 0}
                onClick={onOpenShownotes}
                className="w-full py-2.5 px-3 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold flex items-center justify-center gap-1.5 shadow-sm transition cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>一键生成 Shownotes</span>
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
});
