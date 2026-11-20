import {
  DEFAULT_PERSONAL_EDITING_PROFILE,
  PersonalEditingProfile,
} from '../data/editingPreferenceProfile';
import {
  PodcastProjectState,
  SpeakerRole,
  SpeakerTrack,
  TranscriptToken,
} from '../types/podcast';
import { computeSpeakerRadarProfiles, RadarDimensionScore } from './speakerRadarEngine';
import {
  formatMmSs,
  projectSourceRangesMsToEditedRatios,
  TimelineComputation,
} from './timelineEngine';

export type CutCategory =
  | 'silence'
  | 'filler'
  | 'waveform_cut'
  | 'manual_delete'
  | 'pause_tighten'
  | 'track_mute';

export interface CutPointItem {
  id: string;
  category: CutCategory;
  categoryLabel: string;
  speakerId: string;
  speakerName: string;
  speakerRole: SpeakerRole;
  speakerColor: string;
  editedSec: number;
  timeFormatted: string;
  sourceStartMs: number;
  sourceEndMs: number;
  removedDurationSec: number;
  removedSilenceSec: number;
  removedWordCount: number;
  removedText: string;
  summaryText: string;
  reason: string;
  tokenIds: string[];
  muteRangeIds?: string[];
  /** For pause_tighten: original vs kept duration */
  origDurationSec?: number;
  keptDurationSec?: number;
}

export interface CutCategoryStat {
  category: CutCategory;
  label: string;
  count: number;
  savedSec: number;
}

export interface SpeakerExpressionSuggestion {
  speakerId: string;
  speakerName: string;
  role: SpeakerRole;
  roleLabel: string;
  color: string;
  overallScore: number;
  avgCpm: number;
  speakingSec: number;
  cutCount: number;
  cutSec: number;
  cutRatioPct: number;
  fillerCount: number;
  silenceCutSec: number;
  dimensions: RadarDimensionScore[];
  topHabitWords: Array<{ word: string; count: number; perMin: number }>;
  strengths: string[];
  suggestions: string[];
}

export interface CutAnalysisReport {
  generatedAt: string;
  projectTitle: string;
  originalDurationSec: number;
  editedDurationSec: number;
  savedDurationSec: number;
  compressionRatioPct: number;
  totalCutCount: number;
  categoryStats: CutCategoryStat[];
  speakerSuggestions: SpeakerExpressionSuggestion[];
  editingStyleSummary: string[];
}

export interface EditingRationaleItem {
  ruleKey: string;
  ruleName: string;
  parameterSummary: string;
  observedEvidence: string;
  rationale: string;
}

/**
 * 脱敏的剪辑习惯配置文件（不含任何具体对话内容、嘉宾姓名、文件路径等隐私信息）
 * 供客户端加载以学习自动化剪辑风格。
 */
export interface PodcraftEditingHabitConfig {
  schema: 'podcraft-editing-habit-profile';
  version: '1.0';
  exportedAt: string;
  privacyNotice: string;
  profileName: string;
  pacingStyle: 'compact' | 'natural_breath' | 'relaxed';
  automationParams: PersonalEditingProfile & {
    stripSilenceEnabled: boolean;
    stripSilenceThresholdSec: number;
    stripSilenceTargetSec: number;
    coldOpenEnabled: boolean;
  };
  editingRationale: EditingRationaleItem[];
  observedMetricsSummary: {
    totalCutCount: number;
    compressionRatioPct: number;
    categoryDistribution: Array<{
      category: CutCategory;
      label: string;
      count: number;
      sharePct: number;
      avgRemovedSec: number;
    }>;
    anonymizedRoleStats: Array<{
      roleKey: string;
      roleLabel: string;
      avgCpm: number;
      cutRatioPct: number;
      avgSilenceCutSec: number;
    }>;
  };
}

const CATEGORY_LABELS: Record<CutCategory, string> = {
  silence: '空白切除',
  filler: '口癖/卡壳剔除',
  waveform_cut: '波形精剪',
  manual_delete: '文稿切除',
  pause_tighten: '停顿收紧',
  track_mute: '单轨静音',
};

function getRoleLabel(role?: SpeakerRole): string {
  if (role === 'host') return '主持人';
  if (role === 'co_host') return '常驻主播';
  if (role === 'guest') return '嘉宾';
  if (role === 'bgm') return 'BGM';
  return '发言人';
}

function isFillerOrHesitationToken(tok: TranscriptToken): boolean {
  if (tok.type !== 'word') return false;
  if (tok.fillerTag === 'pure') return true;
  const clean = tok.text.trim();
  if (/^呃+[。，、…—]*$/.test(clean)) return true;
  return DEFAULT_PERSONAL_EDITING_PROFILE.hesitationWords.includes(clean);
}

/**
 * 从工程状态和时间轴中提取全部剪辑处（含空白删减、口癖剔除、波形/文稿删除、停顿收紧、单轨静音）。
 */
export function extractAllCutPoints(
  state: PodcastProjectState,
  timeline: TimelineComputation
): CutPointItem[] {
  const trackMap = new Map<string, SpeakerTrack>();
  for (const tr of state.tracks) {
    trackMap.set(tr.id, tr);
  }

  const mappedByTokenId = new Map<
    string,
    { editedStartSec: number; editedEndSec: number }
  >();
  for (const m of timeline.mappedTokens) {
    mappedByTokenId.set(m.tokenId, {
      editedStartSec: m.editedStartSec,
      editedEndSec: m.editedEndSec,
    });
  }

  const cuts: CutPointItem[] = [];

  for (let bIdx = 0; bIdx < state.blocks.length; bIdx++) {
    const block = state.blocks[bIdx];
    const tr = trackMap.get(block.speakerId);
    const speakerName = tr?.name || '发言人';
    const speakerRole: SpeakerRole = tr?.role || 'guest';
    const speakerColor = tr?.color || '#3b82f6';

    const tokens = block.tokens;
    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];

      if (tok.deleted) {
        const group: TranscriptToken[] = [];
        while (i < tokens.length && tokens[i].deleted) {
          group.push(tokens[i]);
          i++;
        }

        const tokenIds = group.map((t) => t.id);
        const removedDurationSec = group.reduce(
          (s, t) => s + Math.max(0, t.origDurationSec || t.durationSec || 0),
          0
        );
        const silenceToks = group.filter((t) => t.type === 'silence');
        const wordToks = group.filter((t) => t.type !== 'silence');
        const removedSilenceSec = silenceToks.reduce(
          (s, t) => s + Math.max(0, t.origDurationSec || t.durationSec || 0),
          0
        );
        const removedText = wordToks.map((t) => t.text).join('').trim();
        const hasWaveCut = group.some((t) => t.cutByWaveform);
        const allSilence = wordToks.length === 0;
        const allFiller =
          wordToks.length > 0 && wordToks.every((t) => isFillerOrHesitationToken(t));

        let category: CutCategory = 'manual_delete';
        let reason = '文稿划选删除冗余内容，保持表达紧凑';
        if (allSilence) {
          category = 'silence';
          reason = `切除 ${removedSilenceSec.toFixed(2)}s 冗余空白停顿，避免冷场拖沓`;
        } else if (allFiller) {
          category = 'filler';
          reason = '剔除卡壳/纯口癖词，保留前后自然呼吸气口';
        } else if (hasWaveCut) {
          category = 'waveform_cut';
          reason =
            removedSilenceSec > 0 && removedText
              ? '多轨波形精剪同步切除冗余片段与伴随空白'
              : '多轨波形精剪切除局部片段并吸附衔接';
        }

        let summaryText = '';
        if (removedText && removedSilenceSec > 0.05) {
          summaryText = `「${removedText}」+ 空白 ${removedSilenceSec.toFixed(2)}s`;
        } else if (removedText) {
          summaryText = `「${removedText}」`;
        } else {
          summaryText = `空白停顿 ${removedDurationSec.toFixed(2)}s`;
        }

        const firstMapped = mappedByTokenId.get(group[0].id);
        const editedSec = firstMapped
          ? firstMapped.editedStartSec
          : Math.max(0, group[0].sourceStartMs / 1000);

        cuts.push({
          id: `cut_grp_${group[0].id}`,
          category,
          categoryLabel: CATEGORY_LABELS[category],
          speakerId: block.speakerId,
          speakerName,
          speakerRole,
          speakerColor,
          editedSec,
          timeFormatted: formatMmSs(editedSec),
          sourceStartMs: group[0].sourceStartMs,
          sourceEndMs: group[group.length - 1].sourceEndMs,
          removedDurationSec,
          removedSilenceSec,
          removedWordCount: wordToks.length,
          removedText,
          summaryText,
          reason,
          tokenIds,
        });
        continue;
      }

      // Non-deleted silence token that was shortened/tightened
      if (
        tok.type === 'silence' &&
        tok.origDurationSec - tok.durationSec > 0.05
      ) {
        const saved = tok.origDurationSec - tok.durationSec;
        const mapped = mappedByTokenId.get(tok.id);
        const editedSec = mapped
          ? mapped.editedStartSec
          : Math.max(0, tok.sourceStartMs / 1000);

        cuts.push({
          id: `cut_tight_${tok.id}`,
          category: 'pause_tighten',
          categoryLabel: CATEGORY_LABELS.pause_tighten,
          speakerId: block.speakerId,
          speakerName,
          speakerRole,
          speakerColor,
          editedSec,
          timeFormatted: formatMmSs(editedSec),
          sourceStartMs: tok.sourceStartMs,
          sourceEndMs: tok.sourceEndMs,
          removedDurationSec: saved,
          removedSilenceSec: saved,
          removedWordCount: 0,
          removedText: '',
          summaryText: `停顿压缩 ${tok.origDurationSec.toFixed(2)}s → ${tok.durationSec.toFixed(2)}s（省 ${saved.toFixed(2)}s）`,
          reason: `将过长句间/句内停顿收紧至 ${tok.durationSec.toFixed(2)}s，兼顾呼吸感与节奏`,
          tokenIds: [tok.id],
          origDurationSec: tok.origDurationSec,
          keptDurationSec: tok.durationSec,
        });
      }

      i++;
    }
  }

  // Explicit single-track mute ranges
  const muteRanges = state.trackMuteRanges ?? [];
  if (muteRanges.length > 0 && timeline.totalEditedDurationSec > 0) {
    const projected = projectSourceRangesMsToEditedRatios(
      timeline,
      muteRanges.map((r) => ({
        sourceStartMs: r.sourceStartMs,
        sourceEndMs: r.sourceEndMs,
      })),
      timeline.totalEditedDurationSec
    );
    muteRanges.forEach((mr, idx) => {
      if (mr.sourceEndMs <= mr.sourceStartMs) return;
      const tr = trackMap.get(mr.trackId);
      const durSec = (mr.sourceEndMs - mr.sourceStartMs) / 1000;
      const proj = projected[idx];
      const editedSec = proj
        ? proj.startRatio * timeline.totalEditedDurationSec
        : mr.sourceStartMs / 1000;

      cuts.push({
        id: `cut_mute_${mr.id}`,
        category: 'track_mute',
        categoryLabel: CATEGORY_LABELS.track_mute,
        speakerId: mr.trackId,
        speakerName: tr?.name || '音轨',
        speakerRole: tr?.role || 'guest',
        speakerColor: tr?.color || '#71717a',
        editedSec,
        timeFormatted: formatMmSs(editedSec),
        sourceStartMs: mr.sourceStartMs,
        sourceEndMs: mr.sourceEndMs,
        removedDurationSec: durSec,
        removedSilenceSec: durSec,
        removedWordCount: 0,
        removedText: '',
        summaryText: `单轨局部静音 ${durSec.toFixed(2)}s`,
        reason: '单轨静音抑制非主讲人呼吸声、底噪或轻微串音，总时长保持不变',
        tokenIds: [],
        muteRangeIds: [mr.id],
      });
    });
  }

  cuts.sort((a, b) => a.editedSec - b.editedSec);
  return cuts;
}

/**
 * 撤销指定的一处剪辑，恢复被删除的文字/空白、还原被收紧的停顿时长或移除单轨静音。
 */
export function undoCutPoint(
  state: PodcastProjectState,
  cut: CutPointItem
): PodcastProjectState {
  const tokenIdSet = new Set(cut.tokenIds);
  const muteIdSet = new Set(cut.muteRangeIds ?? []);

  const nextBlocks =
    tokenIdSet.size > 0
      ? state.blocks.map((block) => {
          let changed = false;
          const nextTokens = block.tokens.map((tok) => {
            if (!tokenIdSet.has(tok.id)) return tok;
            changed = true;
            return {
              ...tok,
              deleted: false,
              trackMuted: false,
              cutByWaveform: false,
              mouthClickCleaned: false,
              durationSec:
                tok.origDurationSec > 0 ? tok.origDurationSec : tok.durationSec,
            };
          });
          return changed ? { ...block, tokens: nextTokens } : block;
        })
      : state.blocks;

  const nextMuteRanges =
    muteIdSet.size > 0
      ? (state.trackMuteRanges ?? []).filter((mr) => !muteIdSet.has(mr.id))
      : state.trackMuteRanges;

  return {
    ...state,
    blocks: nextBlocks,
    trackMuteRanges: nextMuteRanges,
  };
}

/**
 * 生成剪辑分析报告与嘉宾/发言人表达建议。
 */
export function generateCutAnalysisReport(
  state: PodcastProjectState,
  timeline: TimelineComputation,
  cuts?: CutPointItem[]
): CutAnalysisReport {
  const allCuts = cuts ?? extractAllCutPoints(state, timeline);
  const editedDurationSec = Math.max(0, timeline.totalEditedDurationSec);

  // Saved duration from timeline-shortening cuts (exclude track_mute which keeps duration)
  const savedDurationSec = allCuts
    .filter((c) => c.category !== 'track_mute')
    .reduce((s, c) => s + c.removedDurationSec, 0);
  const originalDurationSec = editedDurationSec + savedDurationSec;
  const compressionRatioPct =
    originalDurationSec > 0
      ? Math.round((savedDurationSec / originalDurationSec) * 1000) / 10
      : 0;

  const catOrder: CutCategory[] = [
    'silence',
    'filler',
    'pause_tighten',
    'waveform_cut',
    'manual_delete',
    'track_mute',
  ];
  const categoryStats: CutCategoryStat[] = catOrder
    .map((cat) => {
      const matched = allCuts.filter((c) => c.category === cat);
      return {
        category: cat,
        label: CATEGORY_LABELS[cat],
        count: matched.length,
        savedSec: matched.reduce((s, c) => s + c.removedDurationSec, 0),
      };
    })
    .filter((s) => s.count > 0);

  const speakerTracks = state.tracks.some((t) => !t.isRef)
    ? state.tracks.filter((t) => !t.isRef && t.role !== 'bgm')
    : state.tracks.filter((t) => t.role !== 'bgm');

  const radarMap = computeSpeakerRadarProfiles(
    speakerTracks,
    state.blocks,
    state.glossary,
    {
      blockEditedStartsSec: timeline.blockEditedStartsSec,
      mappedTokens: timeline.mappedTokens,
      overlapRegions: timeline.overlapRegions,
    }
  );

  // Per-speaker speaking time from kept tokens
  const speakingSecBySpeaker = new Map<string, number>();
  for (const b of state.blocks) {
    let sec = speakingSecBySpeaker.get(b.speakerId) ?? 0;
    for (const t of b.tokens) {
      if (!t.deleted && t.type !== 'silence') {
        sec += t.durationSec;
      }
    }
    speakingSecBySpeaker.set(b.speakerId, sec);
  }

  const speakerSuggestions: SpeakerExpressionSuggestion[] = speakerTracks.map(
    (tr) => {
      const spCuts = allCuts.filter((c) => c.speakerId === tr.id);
      const cutSec = spCuts
        .filter((c) => c.category !== 'track_mute')
        .reduce((s, c) => s + c.removedDurationSec, 0);
      const silenceCutSec = spCuts
        .filter(
          (c) => c.category === 'silence' || c.category === 'pause_tighten'
        )
        .reduce((s, c) => s + c.removedDurationSec, 0);
      const fillerCutCount = spCuts
        .filter((c) => c.category === 'filler')
        .reduce((s, c) => s + Math.max(1, c.removedWordCount), 0);

      const speakingSec = speakingSecBySpeaker.get(tr.id) ?? 0;
      const rawSpeakerSec = speakingSec + cutSec;
      const cutRatioPct =
        rawSpeakerSec > 0
          ? Math.round((cutSec / rawSpeakerSec) * 1000) / 10
          : 0;

      const radar = radarMap.get(tr.id);
      const avgCpm = radar?.avgCpm ?? 0;
      const overallScore = radar?.overallScore ?? 75;
      const dimensions = radar?.dimensions ?? [];
      const topHabitWords = (radar?.topHabitPhrases ?? [])
        .slice(0, 4)
        .map((p) => ({
          word: p.word,
          count: p.count,
          perMin: p.perMin,
        }));

      const strengths: string[] = [];
      const suggestions: string[] = [];

      // Derive strengths & suggestions from radar + actual cut data
      const sortedDims = [...dimensions].sort((a, b) => b.score - a.score);
      if (sortedDims[0] && sortedDims[0].score >= 78) {
        strengths.push(
          `${sortedDims[0].label}表现突出（${sortedDims[0].score}分）：${sortedDims[0].detail}`
        );
      }
      if (avgCpm >= 175 && avgCpm <= 255) {
        strengths.push(`平均语速 ${avgCpm} 字/分钟，处于播客黄金可听区间`);
      }

      if (fillerCutCount >= 3 || (radar?.microMetrics.pureFillerCount ?? 0) >= 4) {
        const topWord = topHabitWords[0]?.word;
        suggestions.push(
          `口癖与卡壳偏多（本次已剪除 ${fillerCutCount} 处${topWord ? `，高频词如「${topWord}」` : ''}），建议句首起音前先做 0.2s 腹式停顿再开口。`
        );
      }

      if (silenceCutSec >= 8) {
        suggestions.push(
          `思考型长停顿累计被压缩 ${silenceCutSec.toFixed(1)}s，长论述前可用「核心有两点」等结构化短语衔接，减少无声找词。`
        );
      }

      if (avgCpm > 265) {
        suggestions.push(
          `语速偏快（${avgCpm} 字/分），关键观点与数据转折处建议刻意放慢并留白 0.4s，给听众消化时间。`
        );
      } else if (avgCpm > 0 && avgCpm < 155) {
        suggestions.push(
          `语速偏慢（${avgCpm} 字/分），建议精简铺垫修饰语，让核心论点更早出现。`
        );
      }

      const specDim = dimensions.find((d) => d.key === 'specificity');
      if (specDim && specDim.score < 74) {
        suggestions.push(
          '表达具体度可进一步提升，讲抽象感受时多补充具体数字、时间节点或真实案例对比。'
        );
      }

      const turnDim = dimensions.find((d) => d.key === 'turnTaking');
      if (turnDim && turnDim.score < 74) {
        suggestions.push(
          tr.role === 'host' || tr.role === 'co_host'
            ? '主持追问后可多留 0.5s 接话气口，并在嘉宾长段落结束时用一句话收敛金句。'
            : '单轮发言较长时注意分段收束，每 40~60 秒给主持人留出接话或追问接口。'
        );
      }

      if (suggestions.length === 0) {
        suggestions.push(
          '整体表达流畅自然、逻辑清晰，继续保持当前的语速控制与句间呼吸节奏即可。'
        );
      }
      if (strengths.length === 0) {
        strengths.push('整体对话状态稳定，具备良好的口语交流自然度。');
      }

      return {
        speakerId: tr.id,
        speakerName: tr.name || '发言人',
        role: tr.role,
        roleLabel: getRoleLabel(tr.role),
        color: tr.color,
        overallScore,
        avgCpm,
        speakingSec,
        cutCount: spCuts.length,
        cutSec,
        cutRatioPct,
        fillerCount: fillerCutCount,
        silenceCutSec,
        dimensions,
        topHabitWords,
        strengths,
        suggestions,
      };
    }
  );

  const editingStyleSummary: string[] = [];
  if (allCuts.length === 0) {
    editingStyleSummary.push('当前尚未产生剪辑记录，保留了完整原始对话节奏。');
  } else {
    editingStyleSummary.push(
      `全片共执行 ${allCuts.length} 处剪辑，累计精简 ${savedDurationSec.toFixed(1)}s（压缩率 ${compressionRatioPct}%），成片时长 ${formatMmSs(editedDurationSec)}。`
    );
    const silStat = categoryStats.find((s) => s.category === 'silence');
    const tightStat = categoryStats.find((s) => s.category === 'pause_tighten');
    const fillerStat = categoryStats.find((s) => s.category === 'filler');
    if (silStat || tightStat) {
      const silTotal = (silStat?.savedSec ?? 0) + (tightStat?.savedSec ?? 0);
      editingStyleSummary.push(
        `呼吸感控制：共处理 ${(silStat?.count ?? 0) + (tightStat?.count ?? 0)} 处空白/停顿（共节省 ${silTotal.toFixed(1)}s），保留自然气口而非一刀切死寂。`
      );
    }
    if (fillerStat) {
      editingStyleSummary.push(
        `口癖洁净度：精准剔除 ${fillerStat.count} 处卡壳与纯口癖词（节省 ${fillerStat.savedSec.toFixed(1)}s），保护正常对话附和词。`
      );
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    projectTitle: state.projectTitle || '未命名播客工程',
    originalDurationSec,
    editedDurationSec,
    savedDurationSec,
    compressionRatioPct,
    totalCutCount: allCuts.length,
    categoryStats,
    speakerSuggestions,
    editingStyleSummary,
  };
}

/**
 * 构建脱敏的「剪辑习惯配置文件」（不含任何具体内容隐私，写清楚剪辑依据，供客户端加载学习自动化剪辑风格）。
 */
export function buildEditingHabitProfileConfig(
  state: PodcastProjectState,
  timeline: TimelineComputation,
  cuts?: CutPointItem[],
  customProfile: Partial<PersonalEditingProfile> = {}
): PodcraftEditingHabitConfig {
  const allCuts = cuts ?? extractAllCutPoints(state, timeline);
  const report = generateCutAnalysisReport(state, timeline, allCuts);
  const profile: PersonalEditingProfile = {
    ...DEFAULT_PERSONAL_EDITING_PROFILE,
    ...customProfile,
    waveformSelectionMode:
      state.waveformSelectionMode ??
      customProfile.waveformSelectionMode ??
      DEFAULT_PERSONAL_EDITING_PROFILE.waveformSelectionMode,
    cutPrerollSec:
      state.cutPrerollSec ??
      customProfile.cutPrerollSec ??
      DEFAULT_PERSONAL_EDITING_PROFILE.cutPrerollSec,
    bgmDuckDb:
      state.bgmDuckDb ??
      customProfile.bgmDuckDb ??
      DEFAULT_PERSONAL_EDITING_PROFILE.bgmDuckDb,
    targetTotalHighlightSec:
      state.targetTotalHighlightSec ??
      customProfile.targetTotalHighlightSec ??
      DEFAULT_PERSONAL_EDITING_PROFILE.targetTotalHighlightSec,
    autoHighlightGap:
      state.autoHighlightGap ??
      customProfile.autoHighlightGap ??
      DEFAULT_PERSONAL_EDITING_PROFILE.autoHighlightGap,
    highlightGapSec:
      state.highlightGapSec ??
      customProfile.highlightGapSec ??
      DEFAULT_PERSONAL_EDITING_PROFILE.highlightGapSec,
    duckAttenuationDb:
      state.duckAttenuationDb ??
      customProfile.duckAttenuationDb ??
      DEFAULT_PERSONAL_EDITING_PROFILE.duckAttenuationDb,
    deClickStrength:
      state.deClickStrength ??
      customProfile.deClickStrength ??
      DEFAULT_PERSONAL_EDITING_PROFILE.deClickStrength,
  };

  // Infer pacing style from compression ratio and tightened pause target
  const tightCuts = allCuts.filter((c) => c.category === 'pause_tighten');
  const avgTightTarget =
    tightCuts.length > 0
      ? tightCuts.reduce((s, c) => s + (c.keptDurationSec ?? 0.25), 0) /
        tightCuts.length
      : state.stripSilenceTargetSec;

  const pacingStyle: 'compact' | 'natural_breath' | 'relaxed' =
    report.compressionRatioPct >= 18 || avgTightTarget <= 0.16
      ? 'compact'
      : report.compressionRatioPct <= 5 && avgTightTarget >= 0.45
      ? 'relaxed'
      : 'natural_breath';

  const silenceCuts = allCuts.filter((c) => c.category === 'silence');
  const avgDeletedSilenceSec =
    silenceCuts.length > 0
      ? Math.round(
          (silenceCuts.reduce((s, c) => s + c.removedDurationSec, 0) /
            silenceCuts.length) *
            100
        ) / 100
      : state.stripSilenceThresholdSec;

  const fillerCuts = allCuts.filter((c) => c.category === 'filler');
  const muteCuts = allCuts.filter((c) => c.category === 'track_mute');
  const waveOrManualCuts = allCuts.filter(
    (c) => c.category === 'waveform_cut' || c.category === 'manual_delete'
  );

  const editingRationale: EditingRationaleItem[] = [
    {
      ruleKey: 'silence_compression',
      ruleName: '空白停顿与气口控制依据',
      parameterSummary: `stripSilenceThresholdSec=${state.stripSilenceThresholdSec}s, stripSilenceTargetSec=${state.stripSilenceTargetSec}s, intraClausePauseSec=${profile.intraClausePauseSec}s, interTurnPauseSec=${profile.interTurnPauseSec}s`,
      observedEvidence: `共切除 ${silenceCuts.length} 处冗余空白（平均 ${avgDeletedSilenceSec}s），收紧 ${tightCuts.length} 处长停顿`,
      rationale:
        '避免长死寂导致听众流失，同时保留 0.18s~0.55s 句内与换人自然呼吸气口，防止播客剪辑过度机械紧凑。',
    },
    {
      ruleKey: 'filler_and_backchannel_balance',
      ruleName: '卡壳口癖剔除与倾听附和保护依据',
      parameterSummary: `protectedBackchannels=${profile.protectedBackchannels.length}类通用附和词, hesitationPatternCount=${profile.hesitationWords.length}`,
      observedEvidence: `共剔除 ${fillerCuts.length} 处卡壳/纯口癖片段`,
      rationale:
        '仅对影响流畅度的孤立卡壳词与纯语气拖音执行切除，严格保护“嗯/对/啊/哈”等互动捧场词以保留真实对谈温度。',
    },
    {
      ruleKey: 'waveform_and_acoustic_hygiene',
      ruleName: '波形精剪与声学清洁依据',
      parameterSummary: `waveformSelectionMode=${profile.waveformSelectionMode}, deClickStrength=${profile.deClickStrength}, cutPrerollSec=${profile.cutPrerollSec}s`,
      observedEvidence: `共执行 ${waveOrManualCuts.length} 处波形/文稿精剪，${muteCuts.length} 处单轨局部静音`,
      rationale:
        '在多轨对谈中优先采用自由微创切口与单轨局部静音抑制串音和唇齿音，保证切换处平滑过渡无爆音。',
    },
    {
      ruleKey: 'pacing_and_ducking_style',
      ruleName: '整体压缩率与闪避混音偏好依据',
      parameterSummary: `pacingStyle=${pacingStyle}, duckAttenuationDb=${profile.duckAttenuationDb}dB, bgmDuckDb=${profile.bgmDuckDb}dB`,
      observedEvidence: `整体成片压缩率 ${report.compressionRatioPct}%（共 ${allCuts.length} 处剪辑）`,
      rationale:
        '基于当前成片压缩率与副轨闪避衰减设定，在主讲人清晰度与多轨自然交叠之间取得平衡。',
    },
  ];

  const totalCount = Math.max(1, allCuts.length);
  const categoryDistribution = report.categoryStats.map((st) => ({
    category: st.category,
    label: st.label,
    count: st.count,
    sharePct: Math.round((st.count / totalCount) * 1000) / 10,
    avgRemovedSec: Math.round((st.savedSec / st.count) * 100) / 100,
  }));

  // Anonymize speakers strictly by role index (no real names, no transcript content)
  const roleCounters: Record<string, number> = {};
  const anonymizedRoleStats = report.speakerSuggestions.map((sp) => {
    const baseRole = sp.role || 'guest';
    roleCounters[baseRole] = (roleCounters[baseRole] ?? 0) + 1;
    return {
      roleKey: `${baseRole}_${roleCounters[baseRole]}`,
      roleLabel: sp.roleLabel,
      avgCpm: sp.avgCpm,
      cutRatioPct: sp.cutRatioPct,
      avgSilenceCutSec:
        sp.cutCount > 0
          ? Math.round((sp.silenceCutSec / sp.cutCount) * 100) / 100
          : 0,
    };
  });

  return {
    schema: 'podcraft-editing-habit-profile',
    version: '1.0',
    exportedAt: new Date().toISOString(),
    privacyNotice:
      '本配置文件已严格脱敏，不包含任何播客原文、发言人姓名、敏感词或本地文件路径，仅记录自动化剪辑参数与剪辑依据。',
    profileName:
      pacingStyle === 'compact'
        ? '紧凑高能精剪风格'
        : pacingStyle === 'relaxed'
        ? '舒缓原声对谈风格'
        : '自然呼吸微创精剪风格',
    pacingStyle,
    automationParams: {
      ...profile,
      stripSilenceEnabled: state.stripSilenceEnabled,
      stripSilenceThresholdSec: state.stripSilenceThresholdSec,
      stripSilenceTargetSec: state.stripSilenceTargetSec,
      coldOpenEnabled: state.coldOpenEnabled,
    },
    editingRationale,
    observedMetricsSummary: {
      totalCutCount: allCuts.length,
      compressionRatioPct: report.compressionRatioPct,
      categoryDistribution,
      anonymizedRoleStats,
    },
  };
}

/**
 * 将加载的剪辑习惯配置文件应用到当前工程状态，返回更新后的工程状态与自动化预设。
 */
export function applyEditingHabitProfileConfig(
  state: PodcastProjectState,
  config: PodcraftEditingHabitConfig
): { nextState: PodcastProjectState; appliedProfile: PersonalEditingProfile } {
  if (config.schema !== 'podcraft-editing-habit-profile' || !config.automationParams) {
    throw new Error('无效的剪辑习惯配置文件格式');
  }
  const p = config.automationParams;
  const appliedProfile: PersonalEditingProfile = {
    name: config.profileName || p.name || DEFAULT_PERSONAL_EDITING_PROFILE.name,
    waveformSelectionMode:
      p.waveformSelectionMode ?? DEFAULT_PERSONAL_EDITING_PROFILE.waveformSelectionMode,
    cutPrerollSec:
      typeof p.cutPrerollSec === 'number'
        ? p.cutPrerollSec
        : DEFAULT_PERSONAL_EDITING_PROFILE.cutPrerollSec,
    bgmDuckDb:
      typeof p.bgmDuckDb === 'number'
        ? p.bgmDuckDb
        : DEFAULT_PERSONAL_EDITING_PROFILE.bgmDuckDb,
    targetTotalHighlightSec:
      typeof p.targetTotalHighlightSec === 'number'
        ? p.targetTotalHighlightSec
        : DEFAULT_PERSONAL_EDITING_PROFILE.targetTotalHighlightSec,
    autoHighlightGap:
      typeof p.autoHighlightGap === 'boolean'
        ? p.autoHighlightGap
        : DEFAULT_PERSONAL_EDITING_PROFILE.autoHighlightGap,
    highlightGapSec:
      typeof p.highlightGapSec === 'number'
        ? p.highlightGapSec
        : DEFAULT_PERSONAL_EDITING_PROFILE.highlightGapSec,
    duckAttenuationDb:
      typeof p.duckAttenuationDb === 'number'
        ? p.duckAttenuationDb
        : DEFAULT_PERSONAL_EDITING_PROFILE.duckAttenuationDb,
    deClickStrength:
      p.deClickStrength ?? DEFAULT_PERSONAL_EDITING_PROFILE.deClickStrength,
    hesitationWords: Array.isArray(p.hesitationWords)
      ? p.hesitationWords
      : DEFAULT_PERSONAL_EDITING_PROFILE.hesitationWords,
    protectedBackchannels: Array.isArray(p.protectedBackchannels)
      ? p.protectedBackchannels
      : DEFAULT_PERSONAL_EDITING_PROFILE.protectedBackchannels,
    intraClausePauseSec:
      typeof p.intraClausePauseSec === 'number'
        ? p.intraClausePauseSec
        : DEFAULT_PERSONAL_EDITING_PROFILE.intraClausePauseSec,
    interTurnPauseSec:
      typeof p.interTurnPauseSec === 'number'
        ? p.interTurnPauseSec
        : DEFAULT_PERSONAL_EDITING_PROFILE.interTurnPauseSec,
  };

  const nextState: PodcastProjectState = {
    ...state,
    waveformSelectionMode: appliedProfile.waveformSelectionMode,
    cutPrerollSec: appliedProfile.cutPrerollSec,
    bgmDuckDb: appliedProfile.bgmDuckDb,
    targetTotalHighlightSec: appliedProfile.targetTotalHighlightSec,
    autoHighlightGap: appliedProfile.autoHighlightGap,
    highlightGapSec: appliedProfile.highlightGapSec,
    duckAttenuationDb: appliedProfile.duckAttenuationDb,
    deClickStrength: appliedProfile.deClickStrength,
    stripSilenceEnabled:
      typeof p.stripSilenceEnabled === 'boolean'
        ? p.stripSilenceEnabled
        : state.stripSilenceEnabled,
    stripSilenceThresholdSec:
      typeof p.stripSilenceThresholdSec === 'number'
        ? p.stripSilenceThresholdSec
        : state.stripSilenceThresholdSec,
    stripSilenceTargetSec:
      typeof p.stripSilenceTargetSec === 'number'
        ? p.stripSilenceTargetSec
        : state.stripSilenceTargetSec,
    coldOpenEnabled:
      typeof p.coldOpenEnabled === 'boolean'
        ? p.coldOpenEnabled
        : state.coldOpenEnabled,
  };

  return { nextState, appliedProfile };
}
