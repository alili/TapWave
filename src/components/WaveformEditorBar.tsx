import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Check,
  Cloud,
  Columns3,
  FastForward,
  FileText,
  Magnet,
  Minus,
  Music,
  PanelBottom,
  PanelTop,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rewind,
  RotateCcw,
  Rows3,
  Scissors,
  Search,
  ShieldAlert,
  Sparkles,
  Undo2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { AuxAudioSlot, BgmTrackAsset, HighlightClip, PodcastProjectState, WaveformSelectionMode } from '../types/podcast';
import { CutPointItem } from '../engine/cutAnalysisEngine';
import {
  getPlayheadSec,
  setPlayheadSec as setGlobalPlayheadSec,
  subscribePlayhead,
  useActiveBlockId,
  useActiveTokenId,
  usePlayheadSec,
} from '../engine/playheadStore';
import {
  buildVisibleWordTimelineAnnotations,
  coalesceChronologicalBlocks,
  computeAutoScrollViewStartRatio,
  computeHorizontalDeckCardWidthPx,
  computeWaveformFocusViewport,
  computeWordGapSnapPointsSec,
  formatMmSs,
  isWordTimelineZoom,
  MappedTokenTimeline,
  mergeCompactDeckTurnGroups,
  OverlapTimelineRegion,
  PLAYHEAD_AUTO_SCROLL_ANCHOR,
  PlaybackSpan,
  projectSourceRangesMsToEditedRatios,
  resolveColdOpenClipWindows,
  resolveEffectiveHighlightGapSec,
  snapRangeToWordGaps,
  TimelineComputation,
  TimelineWordAnnotation,
} from '../engine/timelineEngine';
import {
  computeLegacyPeaksCalibration,
  computeSharedReferenceCeiling,
  computeTrackLinearGain,
  HiResWaveformEnvelope,
  loadTrackHiResEnvelope,
  sampleCalibratedWaveformPoint,
  SampledBipolarPoint,
  TrackAcousticCalibration,
} from '../engine/waveformEnvelopeLoader';
import { PLAYBACK_RATES } from './TopStudioBar';
import { audioPreview } from '../engine/audioPreviewEngine';
import { computeHoverScrubRate, TimelineScrubSample } from '../engine/timelineScrubSpeed';

interface SpeakerDeckTurn {
  turnKey: string;
  blockIds: string[];
  speakerId: string;
  speakerName: string;
  speakerColor: string;
  chapterTitle: string;
  coalescedAcrossCut: boolean;
  editedStartSec: number;
  editedEndSec: number;
  previewText: string;
  horizontalWidthPx: number;
  tokens: Array<{ mapped: MappedTokenTimeline; flatIndex: number }>;
  allWordTokenIds: string[];
  overlaps: OverlapTimelineRegion[];
}

interface WaveformEditorBarProps {
  state: PodcastProjectState;
  timeline: TimelineComputation;
  playheadSec?: number;
  isPlaying: boolean;
  isMainStage?: boolean;
  selectedTokenIds?: Set<string>;
  activeBlockId?: string | null;
  activeTokenId?: string | null;
  canUndo?: boolean;
  rightPaneCollapsed?: boolean;
  onToggleRightPane?: () => void;
  speakerDeckPosition?: 'top' | 'bottom';
  onChangeSpeakerDeckPosition?: (pos: 'top' | 'bottom') => void;
  onSwitchToTranscriptView?: () => void;
  onTogglePlay: () => void;
  onStepPlayhead: (deltaSec: number) => void;
  onChangePlaybackRate: (rate: number) => void;
  onSeekToSec: (sec: number) => void;
  onHoverScrub?: (sec: number, rate: number) => void;
  onHoverScrubStop?: () => void;
  onToggleProxyEditing?: () => void;
  onWaveformCutAction: (
    startSec: number,
    endSec: number,
    action: 'ripple_all' | 'mute_lane' | 'bleep_range' | 'add_highlight' | 'cancel_ducking',
    targetSpeakerId?: string
  ) => void;
  onToggleTrackSolo?: (trackId: string) => void;
  onToggleTrackMute?: (trackId: string) => void;
  onToggleBgmSolo?: () => void;
  onToggleBgmMute?: () => void;
  onImportBgm?: (slot: AuxAudioSlot) => void;
  onUpdateBgmAsset?: (slot: AuxAudioSlot, patch: Partial<BgmTrackAsset>) => void;
  onOpenIntroEditor?: () => void;
  onInsertSilenceAtPlayhead?: (durationSec: number) => void;
  onNotify?: (message: string) => void;
  onRenameSpeakerTrack?: (trackId: string, newName?: string) => void;
  onSelectToken?: (tokenId: string, flatIndex: number, shiftKey: boolean, metaKey: boolean) => void;
  onSelectRange?: (startFlatIndex: number, endFlatIndex: number, additive: boolean) => void;
  focusRequest?: {
    startSec: number;
    endSec: number;
    speakerId?: string;
    anchorSec?: number;
    preserveHigherZoom?: boolean;
    seq: number;
  } | null;
  onClearSelection?: () => void;
  onRippleDeleteSelected?: () => void;
  onMuteTrackSelected?: () => void;
  onBleepSelected?: () => void;
  onAddSelectedToHighlight?: () => void;
  onCancelDuckingSelected?: () => void;
  onShortenSilence?: (tokenId: string) => void;
  onDeleteTokenIds?: (tokenIds: string[]) => void;
  onMuteTokenIds?: (tokenIds: string[]) => void;
  onCleanFillers?: () => void;
  onApplyPreferenceSmartCut?: () => void;
  onCleanMouthClicks?: () => void;
  onUndo?: () => void;
  onRetranscribe?: () => void;
  onOpenAsrSettings?: () => void;
  onApplyManualCorrection?: (tokenId: string, newText: string, saveToGlossary: boolean) => void;
  onToggleOverlapMute?: (
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
  onSetWaveformSelectionMode?: (mode: WaveformSelectionMode) => void;
  cutPoints?: CutPointItem[];
  onInspectCutPoint?: (cut: CutPointItem, anchorPos?: { x: number; y: number }) => void;
  onOpenCutReportModal?: (tab?: 'cuts' | 'report' | 'profile') => void;
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const num = parseInt(clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lightenHex(hex: string, amount = 42): string {
  const clean = hex.replace('#', '');
  const num = parseInt(clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean, 16);
  const r = Math.min(255, ((num >> 16) & 255) + amount);
  const g = Math.min(255, ((num >> 8) & 255) + amount);
  const b = Math.min(255, (num & 255) + amount);
  return `rgb(${r}, ${g}, ${b})`;
}

function mergeRanges(ranges: Array<[number, number]>, maxGap = 0.015): Array<[number, number]> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr[0] <= prev[1] + maxGap) {
      prev[1] = Math.max(prev[1], curr[1]);
    } else {
      merged.push([curr[0], curr[1]]);
    }
  }
  return merged;
}

function chooseTickSteps(visibleSec: number): {
  major: number;
  minor: number;
  decimals: 0 | 1 | 2;
} {
  if (visibleSec <= 1.2) return { major: 0.2, minor: 0.05, decimals: 2 };
  if (visibleSec <= 2.8) return { major: 0.5, minor: 0.1, decimals: 1 };
  if (visibleSec <= 6.5) return { major: 1, minor: 0.2, decimals: 1 };
  if (visibleSec <= 18) return { major: 2, minor: 0.5, decimals: 1 };
  if (visibleSec <= 38) return { major: 5, minor: 1, decimals: 0 };
  if (visibleSec <= 85) return { major: 10, minor: 2, decimals: 0 };
  if (visibleSec <= 180) return { major: 15, minor: 5, decimals: 0 };
  if (visibleSec <= 420) return { major: 30, minor: 5, decimals: 0 };
  if (visibleSec <= 900) return { major: 60, minor: 15, decimals: 0 };
  return { major: 120, minor: 30, decimals: 0 };
}

function formatPrecisionSec(sec: number, decimals: 0 | 1 | 2): string {
  const safe = Math.max(0, sec);
  if (decimals === 0) return formatMmSs(Math.round(safe));
  const whole = Math.floor(safe + 1e-6);
  const mm = String(Math.floor(whole / 60)).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  if (decimals === 1) {
    const tenths = Math.min(9, Math.floor(((safe - whole) + 1e-6) * 10));
    return `${mm}:${ss}.${tenths}`;
  }
  const hundredths = String(Math.min(99, Math.round((safe - whole) * 100))).padStart(2, '0');
  return `${mm}:${ss}.${hundredths}`;
}

const MIN_VISIBLE_SEC = 0.25;

function zoomToSliderVal(z: number, maxZ: number): number {
  if (maxZ <= 1) return 0;
  const clamped = Math.max(1, Math.min(maxZ, z));
  return Math.round((Math.log(clamped) / Math.log(maxZ)) * 1000);
}

function sliderValToZoom(val: number, maxZ: number): number {
  if (maxZ <= 1) return 1;
  const norm = Math.max(0, Math.min(1, val / 1000));
  const raw = Math.pow(maxZ, norm);
  return raw < 10 ? Number(raw.toFixed(1)) : Math.round(raw);
}

/**
 * Maps an edited timeline timestamp `tSec` back to the exact normalized `[0..1]` position
 * in the source audio file (`srcMs / trackDurationMs`) via O(log N) binary search, so zooming
 * to 100x–2000x renders true source audio transients aligned with every cut & Cold Open!
 */
function resolveEditedSecToSourceRatio(
  tSec: number,
  coldOpenEnabled: boolean,
  coldOpenDurationSec: number,
  introVoiceoverDurationSec: number,
  highlights: HighlightClip[],
  playbackSpans: PlaybackSpan[],
  mappedTokens: MappedTokenTimeline[],
  trackDurationMs: number,
  trackOffsetMs: number,
  gapSec: number = 0.65,
  introVoiceoverStartSec?: number
): number | null {
  if (trackDurationMs <= 0) return null;

  if (coldOpenEnabled && coldOpenDurationSec > 0 && tSec < coldOpenDurationSec) {
    const clipWindows = resolveColdOpenClipWindows(highlights, gapSec);
    for (const { highlight: hl, startSec, endSec } of clipWindows) {
      if (tSec >= startSec && tSec <= endSec) {
        const srcMs = hl.sourceStartMs + (tSec - startSec) * 1000 - trackOffsetMs;
        if (srcMs < 0 || srcMs > trackDurationMs) return null;
        return Math.max(0, Math.min(0.999999, srcMs / trackDurationMs));
      }
    }
    return null;
  }

  const voStart = introVoiceoverStartSec ?? coldOpenDurationSec;
  if (
    introVoiceoverDurationSec > 0 &&
    tSec >= voStart &&
    tSec < voStart + introVoiceoverDurationSec
  ) {
    return null;
  }

  // Primary: O(log N) lookup in continuous PlaybackSpans (covers all kept words AND natural uncut breaths 1:1!)
  if (playbackSpans.length > 0) {
    let lo = 0;
    let hi = playbackSpans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const sp = playbackSpans[mid];
      if (tSec < sp.editedStartSec - 0.001) {
        hi = mid - 1;
      } else if (tSec > sp.editedEndSec + 0.001) {
        lo = mid + 1;
      } else {
        const clampedT = Math.max(sp.editedStartSec, Math.min(sp.editedEndSec, tSec));
        const srcMs = (sp.sourceStartSec + (clampedT - sp.editedStartSec)) * 1000 - trackOffsetMs;
        if (srcMs < 0 || srcMs > trackDurationMs) return null;
        return Math.max(0, Math.min(0.999999, srcMs / trackDurationMs));
      }
    }
  }

  // Fallback: mappedTokens lookup
  let lo = 0;
  let hi = mappedTokens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const item = mappedTokens[mid];
    if (tSec < item.editedStartSec) {
      hi = mid - 1;
    } else if (tSec > item.editedEndSec) {
      lo = mid + 1;
    } else {
      let k = mid;
      while (k > 0 && mappedTokens[k - 1].editedEndSec >= tSec) {
        k--;
      }
      for (; k < mappedTokens.length && mappedTokens[k].editedStartSec <= tSec; k++) {
        const m = mappedTokens[k];
        if (m.token.deleted) continue;
        if (tSec >= m.editedStartSec && tSec <= m.editedEndSec) {
          const srcMs =
            m.effectiveSourceStartSec * 1000 + (tSec - m.editedStartSec) * 1000 - trackOffsetMs;
          if (srcMs < 0 || srcMs > trackDurationMs) return null;
          return Math.max(0, Math.min(0.999999, srcMs / trackDurationMs));
        }
      }
      break;
    }
  }
  return null;
}

interface CutSeamZone {
  ratio: number;
  editedSec: number;
  prevSourceEndSec: number;
  currSourceStartSec: number;
}

const CUT_SEAM_HALF_SEC = 0.022;

/**
 * Samples calibrated bipolar Peak + RMS amplitude around an edited cut seam using symmetric
 * +/-22ms equal-power crossfade weighting between outgoing source tail and incoming source head.
 */
function sampleSeamBlendedWaveform(
  hiRes: HiResWaveformEnvelope | undefined,
  legacyPeaks: number[],
  seam: CutSeamZone,
  editedSec: number,
  trackDurMs: number,
  trackOffsetMs: number,
  halfSourceWindowRatio: number,
  gainLinear: number,
  calibration: TrackAcousticCalibration,
  sharedRefCeiling: number
): SampledBipolarPoint {
  const deltaSec = editedSec - seam.editedSec;
  const outSourceRatio = Math.max(
    0,
    Math.min(1, ((seam.prevSourceEndSec + deltaSec) * 1000 - trackOffsetMs) / trackDurMs)
  );
  const inSourceRatio = Math.max(
    0,
    Math.min(1, ((seam.currSourceStartSec + deltaSec) * 1000 - trackOffsetMs) / trackDurMs)
  );
  const outPt = sampleCalibratedWaveformPoint(
    hiRes,
    legacyPeaks,
    outSourceRatio,
    halfSourceWindowRatio,
    gainLinear,
    calibration,
    sharedRefCeiling
  );
  const inPt = sampleCalibratedWaveformPoint(
    hiRes,
    legacyPeaks,
    inSourceRatio,
    halfSourceWindowRatio,
    gainLinear,
    calibration,
    sharedRefCeiling
  );
  const t = Math.max(0, Math.min(1, (deltaSec + CUT_SEAM_HALF_SEC) / (2 * CUT_SEAM_HALF_SEC)));
  const theta = t * (Math.PI / 2);
  const wOut = Math.cos(theta);
  const wIn = Math.sin(theta);
  const rms = Math.hypot(outPt.rms * wOut, inPt.rms * wIn);
  const posPeak = Math.max(outPt.posPeak * wOut, inPt.posPeak * wIn, rms);
  const negPeak = Math.max(outPt.negPeak * wOut, inPt.negPeak * wIn, rms);
  const rawPeak = Math.max(outPt.rawPeak * wOut, inPt.rawPeak * wIn);
  return { posPeak, negPeak, rms, rawPeak };
}

/**
 * Fallback procedural envelope ONLY for synthetic unit-test fixtures that have no real audio peaks.
 */
function computeFallbackSynthEnvelope(
  normR: number,
  totalSec: number,
  seedIdx: number,
  boostFactor: number
): number {
  const tSec = normR * totalSec;
  const sylA = Math.abs(Math.sin(tSec * 13.8 + seedIdx * 1.9));
  const sylB = Math.abs(Math.cos(tSec * 6.4 + seedIdx * 1.1));
  const phrase = 0.66 + 0.34 * Math.sin(tSec * 1.85 + seedIdx * 2.4);
  const plosive = Math.pow(Math.abs(Math.sin(tSec * 29.5 + seedIdx * 3.3)), 4);
  const microDip = Math.abs(Math.sin(tSec * 3.1 + seedIdx * 0.8)) < 0.11 ? 0.34 : 1.0;
  return Math.min(
    0.95,
    Math.max(0.14, (0.22 + (sylA * 0.46 + sylB * 0.24 + plosive * 0.32) * phrase) * microDip * boostFactor)
  );
}

function computeFloorNoise(normR: number, totalSec: number, seedIdx: number): number {
  const tSec = normR * totalSec;
  return 0.025 + 0.035 * Math.abs(Math.sin(tSec * 17.3 + seedIdx * 2.7) * Math.cos(tSec * 9.1));
}

const DEFAULT_DOCK_HEIGHT = 148;
const DEFAULT_DECK_HEIGHT = 172; // 发言块文本区默认高度，可舒适完整展示 5 行文本
const MIN_DOCK_HEIGHT = 104;
const EMPTY_TOKEN_ID_SET = new Set<string>();

function getMaxDockHeight(): number {
  if (typeof window === 'undefined') return 560;
  return Math.max(200, Math.min(Math.floor(window.innerHeight * 0.68), window.innerHeight - 220));
}

function findTurnIndexAtSec(
  turns: SpeakerDeckTurn[],
  tSec: number,
  padSec: number,
  monotonic: boolean
): number {
  if (turns.length === 0) return -1;
  if (!monotonic) {
    return turns.findIndex(
      (t) => tSec >= t.editedStartSec - padSec && tSec <= t.editedEndSec + padSec
    );
  }
  let lo = 0;
  let hi = turns.length - 1;
  let firstCand = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (turns[mid].editedEndSec >= tSec - padSec) {
      firstCand = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (firstCand < 0) return -1;
  const t = turns[firstCand];
  return tSec >= t.editedStartSec - padSec && tSec <= t.editedEndSec + padSec ? firstCand : -1;
}

function findTurnIndexIntersecting(
  turns: SpeakerDeckTurn[],
  startSec: number,
  endSec: number,
  monotonic: boolean
): number {
  if (turns.length === 0) return -1;
  if (!monotonic) {
    return turns.findIndex((t) => t.editedEndSec > startSec && t.editedStartSec < endSec);
  }
  let lo = 0;
  let hi = turns.length - 1;
  let firstCand = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (turns[mid].editedEndSec > startSec) {
      firstCand = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (firstCand < 0) return -1;
  return turns[firstCand].editedStartSec < endSec ? firstCand : -1;
}

function findNearestTurnIndex(
  turns: SpeakerDeckTurn[],
  tSec: number,
  monotonic: boolean
): number {
  if (turns.length === 0) return -1;
  if (!monotonic) {
    let nearestIdx = 0;
    let nearestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const dist =
        tSec < t.editedStartSec
          ? t.editedStartSec - tSec
          : tSec > t.editedEndSec
          ? tSec - t.editedEndSec
          : 0;
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    }
    return nearestIdx;
  }
  let lo = 0;
  let hi = turns.length - 1;
  let cand = turns.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (turns[mid].editedEndSec >= tSec) {
      cand = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const candidates = cand > 0 ? [cand - 1, cand] : [cand];
  let nearestIdx = candidates[0];
  let nearestDist = Number.POSITIVE_INFINITY;
  for (const i of candidates) {
    const t = turns[i];
    const dist =
      tSec < t.editedStartSec
        ? t.editedStartSec - tSec
        : tSec > t.editedEndSec
        ? tSec - t.editedEndSec
        : 0;
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestIdx = i;
    }
  }
  return nearestIdx;
}

interface DeckOverlapFallback {
  speakerId: string;
  speakerName: string;
  text?: string;
  sourceStartMs: number;
  sourceEndMs: number;
}

interface DeckTurnCallbacks {
  registerTurnRef: (turnKey: string, el: HTMLDivElement | null) => void;
  onHoverTurn: (idx: number | null) => void;
  onSeekTurn: (turn: SpeakerDeckTurn) => void;
  onFocusTurnWaveform: (turn: SpeakerDeckTurn) => void;
  onTokenMouseDown: (
    e: React.MouseEvent<HTMLSpanElement>,
    turn: SpeakerDeckTurn,
    flatIndex: number,
    editedStartSec: number
  ) => void;
  onTokenMouseEnter: (flatIndex: number) => void;
  onTokenClick: (
    e: React.MouseEvent<HTMLSpanElement>,
    turn: SpeakerDeckTurn,
    tokenId: string,
    flatIndex: number,
    editedStartSec: number
  ) => void;
  onTokenBleepClick: (
    e: React.MouseEvent<HTMLSpanElement>,
    turn: SpeakerDeckTurn,
    tokenId: string,
    flatIndex: number,
    editedStartSec: number
  ) => void;
  onStartEditHint: (tokenId: string, text: string) => void;
  onDraftHintChange: (text: string) => void;
  onCommitHint: (tokenId: string) => void;
  onCancelHint: () => void;
  onToggleSaveToGlossary: (checked: boolean) => void;
  onShortenSilence: (tokenId: string) => void;
  onDeleteTurn: (tokenIds: string[]) => void;
  onMuteTurn: (tokenIds: string[]) => void;
  onToggleOverlapMute: (blockId: string, fallbackOv: DeckOverlapFallback) => void;
  onToggleOverlapKeepFull: (blockId: string, fallbackOv: DeckOverlapFallback) => void;
  onSelectOverlapRange: (startSec: number, endSec: number) => void;
  onCutOverlapRange: (startSec: number, endSec: number) => void;
}

const PlayheadTimeText: React.FC<{
  bodyOffsetSec: number;
  className?: string;
}> = React.memo(({ bodyOffsetSec, className }) => {
  const spanRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const update = () => {
      if (!spanRef.current) return;
      const effSec = Math.max(0, getPlayheadSec() - bodyOffsetSec);
      spanRef.current.textContent = `${formatMmSs(effSec)}.${Math.floor((effSec % 1) * 10)}`;
    };
    update();
    return subscribePlayhead(update);
  }, [bodyOffsetSec]);
  const initEff = Math.max(0, getPlayheadSec() - bodyOffsetSec);
  return (
    <span ref={spanRef} className={className}>
      {formatMmSs(initEff)}.{Math.floor((initEff % 1) * 10)}
    </span>
  );
});

const ScrubberProgressFill: React.FC<{
  totalSec: number;
  bodyOffsetSec: number;
}> = React.memo(({ totalSec, bodyOffsetSec }) => {
  const divRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const update = () => {
      if (!divRef.current) return;
      const effSec = Math.max(0, getPlayheadSec() - bodyOffsetSec);
      const pct = totalSec > 0.01 ? Math.max(0, Math.min(100, (effSec / totalSec) * 100)) : 0;
      divRef.current.style.width = `${pct}%`;
    };
    update();
    return subscribePlayhead(update);
  }, [totalSec, bodyOffsetSec]);
  return (
    <div
      ref={divRef}
      style={{ width: '0%' }}
      className="absolute inset-y-0 left-0 bg-gradient-to-r from-blue-600 via-blue-500 to-cyan-400 rounded-full"
    />
  );
});

const ScrubberThumb: React.FC<{
  totalSec: number;
  bodyOffsetSec: number;
  scrubbing: boolean;
}> = React.memo(({ totalSec, bodyOffsetSec, scrubbing }) => {
  const divRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const update = () => {
      if (!divRef.current) return;
      const effSec = Math.max(0, getPlayheadSec() - bodyOffsetSec);
      const pct = totalSec > 0.01 ? Math.max(0, Math.min(100, (effSec / totalSec) * 100)) : 0;
      divRef.current.style.left = `${pct}%`;
    };
    update();
    return subscribePlayhead(update);
  }, [totalSec, bodyOffsetSec]);
  return (
    <div
      ref={divRef}
      style={{ left: '0%' }}
      className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full bg-white border-2 border-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.85)] pointer-events-none transition-transform ${
        scrubbing ? 'w-3.5 h-3.5 scale-110' : 'w-3 h-3 group-hover:scale-110'
      }`}
    />
  );
});

const ScrubberPercentText: React.FC<{
  totalSec: number;
  bodyOffsetSec: number;
}> = React.memo(({ totalSec, bodyOffsetSec }) => {
  const spanRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const update = () => {
      if (!spanRef.current) return;
      const effSec = Math.max(0, getPlayheadSec() - bodyOffsetSec);
      const pct = totalSec > 0.01 ? Math.max(0, Math.min(100, (effSec / totalSec) * 100)) : 0;
      spanRef.current.textContent = `${Math.round(pct)}%`;
    };
    update();
    return subscribePlayhead(update);
  }, [totalSec, bodyOffsetSec]);
  return <span ref={spanRef} className="ml-1 text-zinc-500">0%</span>;
});

const TurnCardProgressBar: React.FC<{
  editedStartSec: number;
  editedEndSec: number;
  bodyOffsetSec: number;
}> = React.memo(({ editedStartSec, editedEndSec, bodyOffsetSec }) => {
  const divRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const update = () => {
      if (!divRef.current) return;
      const effSec = Math.max(0, getPlayheadSec() - bodyOffsetSec);
      const span = Math.max(0.05, editedEndSec - editedStartSec);
      const ratio = Math.min(1, Math.max(0, (effSec - editedStartSec) / span));
      divRef.current.style.width = `${(ratio * 100).toFixed(1)}%`;
    };
    update();
    return subscribePlayhead(update);
  }, [editedStartSec, editedEndSec, bodyOffsetSec]);
  return (
    <div
      ref={divRef}
      className="pointer-events-none absolute top-0 left-0 h-[2.5px] bg-gradient-to-r from-emerald-400 via-sky-400 to-blue-400"
      style={{ width: '0%' }}
    />
  );
});

interface DeckTurnCardProps {
  turn: SpeakerDeckTurn;
  idx: number;
  relOffset: number | null;
  actionsAlwaysVisible: boolean;
  isRangeHit: boolean;
  showChapter: boolean;
  deckFlowMode: 'horizontal' | 'vertical';
  bodyOffsetSec: number;
  activeTokenIdInTurn: string | null;
  selectedTokenIdsInTurn: Set<string>;
  waveRangeStartSec: number | null;
  waveRangeEndSec: number | null;
  editingTokenIdInTurn: string | null;
  draftHintTextInTurn: string;
  saveHintToGlossaryInTurn: boolean;
  renderInteractiveTokens: boolean;
  canDelete: boolean;
  canMute: boolean;
  canEditHint: boolean;
  canToggleOverlapMute: boolean;
  canToggleOverlapKeepFull: boolean;
  callbacks: DeckTurnCallbacks;
}

const DeckTurnCard: React.FC<DeckTurnCardProps> = React.memo(
  ({
    turn,
    idx,
    relOffset,
    actionsAlwaysVisible,
    isRangeHit,
    showChapter,
    deckFlowMode,
    bodyOffsetSec,
    activeTokenIdInTurn,
    selectedTokenIdsInTurn,
    waveRangeStartSec,
    waveRangeEndSec,
    editingTokenIdInTurn,
    draftHintTextInTurn,
    saveHintToGlossaryInTurn,
    renderInteractiveTokens,
    canDelete,
    canMute,
    canEditHint,
    canToggleOverlapMute,
    canToggleOverlapKeepFull,
    callbacks,
  }) => {
    const isCurrent = relOffset === 0;
    const isNeighbor = relOffset !== null && relOffset !== 0;
    const isHorizontal = deckFlowMode === 'horizontal';
    const isNarrowHorizontal = isHorizontal && turn.horizontalWidthPx < 210;
    const isCompactActions = isHorizontal && turn.horizontalWidthPx < 190;

    const cardRef = useCallback(
      (el: HTMLDivElement | null) => {
        callbacks.registerTurnRef(turn.turnKey, el);
      },
      [callbacks, turn.turnKey]
    );

    const cardStyle: React.CSSProperties | undefined = isHorizontal
      ? !isCurrent && !isNeighbor
        ? {
            width: `${turn.horizontalWidthPx}px`,
            contentVisibility: 'auto',
            containIntrinsicSize: `${turn.horizontalWidthPx}px 158px`,
          }
        : { width: `${turn.horizontalWidthPx}px` }
      : !isCurrent && !isNeighbor
      ? { contentVisibility: 'auto', containIntrinsicSize: '0 104px' }
      : undefined;

    return (
      <div
        ref={cardRef}
        style={cardStyle}
        onMouseEnter={() => callbacks.onHoverTurn(idx)}
        onMouseLeave={() => callbacks.onHoverTurn(null)}
        onClick={(e) => {
          if (
            (e.target as HTMLElement | null)?.closest(
              'button, input, label, select, a, [data-deck-token="1"]'
            )
          ) {
            return;
          }
          callbacks.onSeekTurn(turn);
        }}
        className={`group/turn rounded-lg border cursor-pointer transition-all relative overflow-hidden ${
          isHorizontal ? 'shrink-0 h-full flex flex-col px-2 py-1.5' : 'px-3 py-2'
        } ${
          isCurrent
            ? 'border-emerald-500/75 bg-emerald-950/30 ring-1 ring-emerald-400/35 shadow-sm'
            : isNeighbor
            ? 'border-zinc-700/85 bg-zinc-900/90 opacity-95'
            : 'border-zinc-800/70 bg-zinc-900/55 opacity-80 hover:opacity-100'
        }`}
      >
        {isCurrent && (
          <TurnCardProgressBar
            editedStartSec={turn.editedStartSec}
            editedEndSec={turn.editedEndSec}
            bodyOffsetSec={bodyOffsetSec}
          />
        )}
        <div
          className={`shrink-0 flex items-center justify-between gap-1 border-b border-zinc-800/60 ${
            isHorizontal ? 'pb-1 mb-1' : 'gap-1.5 pb-1.5 mb-1.5'
          }`}
        >
          <div className="flex items-center gap-1 min-w-0 overflow-hidden whitespace-nowrap">
            <span
              className="w-1.5 h-3.5 rounded-full shrink-0"
              style={{ backgroundColor: turn.speakerColor }}
            />
            <button
              type="button"
              onClick={() => callbacks.onSeekTurn(turn)}
              title="单击将播放游标跳转至此段开头（不改变波形缩放）"
              className={`text-xs font-semibold text-zinc-100 hover:text-blue-300 cursor-pointer truncate ${
                isNarrowHorizontal ? 'max-w-[74px]' : 'max-w-[96px]'
              }`}
            >
              {turn.speakerName}
            </button>
            <button
              type="button"
              onClick={() => callbacks.onSeekTurn(turn)}
              title={`起止 ${formatMmSs(turn.editedStartSec)}–${formatMmSs(turn.editedEndSec)}（单击跳转至此段开头，不缩放波形）`}
              className="text-[11px] font-mono tabular-nums text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0"
            >
              {isNarrowHorizontal
                ? formatMmSs(turn.editedStartSec)
                : `${formatMmSs(turn.editedStartSec)}–${formatMmSs(turn.editedEndSec)}`}
            </button>
            {isCurrent && (
              <span
                className={`px-1 py-0.5 rounded text-[10px] font-semibold border shrink-0 ${
                  isRangeHit
                    ? 'bg-rose-500/20 border-rose-400/60 text-rose-200'
                    : 'bg-emerald-500/20 border-emerald-400/50 text-emerald-200'
                }`}
              >
                {isRangeHit ? '✂️选区' : '🎯当前'}
              </span>
            )}
            {!isNarrowHorizontal && isNeighbor && relOffset !== null && (
              <span className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-300 text-[10px] font-mono shrink-0">
                {isHorizontal
                  ? relOffset < 0
                    ? `◀ -${-relOffset}`
                    : `+${relOffset} ▶`
                  : relOffset < 0
                  ? `上文 -${-relOffset}`
                  : `下文 +${relOffset}`}
              </span>
            )}
            {!isNarrowHorizontal && showChapter && (
              <span className="px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/25 text-blue-300 text-[10px] truncate max-w-[96px]">
                {turn.chapterTitle}
              </span>
            )}
            {turn.coalescedAcrossCut && !isNarrowHorizontal && (
              <span className="px-1 py-0.5 rounded bg-amber-500/10 text-amber-300 text-[10px] shrink-0">
                已缝合
              </span>
            )}
          </div>

          {!isHorizontal && (
            <div
              className={`flex items-center gap-1 shrink-0 transition-opacity ${
                actionsAlwaysVisible ? 'opacity-100' : 'opacity-0 group-hover/turn:opacity-100'
              }`}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  callbacks.onFocusTurnWaveform(turn);
                }}
                title="缩放并居中聚焦此发言段的下方波形"
                className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 text-[10px] inline-flex items-center gap-0.5 cursor-pointer"
              >
                <Search className="w-2.5 h-2.5 text-blue-400" />
                <span>聚焦</span>
              </button>
              {canDelete && (
                <button
                  type="button"
                  onClick={() => callbacks.onDeleteTurn(turn.allWordTokenIds)}
                  title="一键波纹切除整段发言"
                  className="px-1.5 py-0.5 rounded bg-red-500/15 hover:bg-red-500/30 border border-red-500/35 text-red-300 text-[10px] inline-flex items-center gap-0.5 cursor-pointer"
                >
                  <Scissors className="w-2.5 h-2.5" />
                  <span>切段</span>
                </button>
              )}
              {canMute && (
                <button
                  type="button"
                  onClick={() => callbacks.onMuteTurn(turn.allWordTokenIds)}
                  title="仅静音本发言人此段声音（不改变总时长）"
                  className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-[10px] inline-flex items-center gap-0.5 cursor-pointer"
                >
                  <VolumeX className="w-2.5 h-2.5" />
                  <span>静音</span>
                </button>
              )}
            </div>
          )}
        </div>

        {isHorizontal && (
          <div className="absolute top-1 right-1 z-10 flex items-center gap-0.5 px-1 py-0.5 rounded bg-zinc-900/95 backdrop-blur-xs border border-zinc-700/80 shadow-sm opacity-0 pointer-events-none group-hover/turn:opacity-100 group-hover/turn:pointer-events-auto transition-opacity">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                callbacks.onFocusTurnWaveform(turn);
              }}
              title="缩放并居中聚焦此发言段的下方波形"
              className="px-1 py-0.5 rounded hover:bg-zinc-800 text-zinc-200 text-[10px] inline-flex items-center gap-0.5 cursor-pointer"
            >
              <Search className="w-2.5 h-2.5 text-blue-400" />
              {!isCompactActions && <span>聚焦</span>}
            </button>
            {canDelete && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  callbacks.onDeleteTurn(turn.allWordTokenIds);
                }}
                title="一键波纹切除整段发言"
                className="px-1 py-0.5 rounded hover:bg-red-500/25 text-red-300 text-[10px] inline-flex items-center gap-0.5 cursor-pointer"
              >
                <Scissors className="w-2.5 h-2.5" />
                {!isCompactActions && <span>切段</span>}
              </button>
            )}
            {canMute && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  callbacks.onMuteTurn(turn.allWordTokenIds);
                }}
                title="仅静音本发言人此段声音（不改变总时长）"
                className="px-1 py-0.5 rounded hover:bg-zinc-800 text-zinc-300 text-[10px] inline-flex items-center gap-0.5 cursor-pointer"
              >
                <VolumeX className="w-2.5 h-2.5" />
                {!isCompactActions && <span>静音</span>}
              </button>
            )}
          </div>
        )}

        <div
          data-token-stream="1"
          className={`block tracking-[0.01em] break-words whitespace-normal select-none ${
            isHorizontal
              ? 'flex-1 min-h-0 overflow-y-auto pr-0.5 text-[13.5px] leading-[1.48]'
              : 'text-[14.5px] leading-[1.65]'
          }`}
        >
          {!renderInteractiveTokens ? (
            <span className="text-zinc-400/90">{turn.previewText}</span>
          ) : (
            (() => {
              let prevEndedAsciiAlnum = false;
              return turn.tokens.map(({ mapped: m, flatIndex }) => {
                const isActive =
                  activeTokenIdInTurn !== null && activeTokenIdInTurn === m.token.id;
                const isSelected = selectedTokenIdsInTurn.has(m.token.id);
                const isWaveRangeToken =
                  waveRangeStartSec !== null &&
                  waveRangeEndSec !== null &&
                  m.editedEndSec > waveRangeStartSec + 0.01 &&
                  m.editedStartSec < waveRangeEndSec - 0.01;
                const isEditing = editingTokenIdInTurn === m.token.id;

                if (isEditing) {
                  prevEndedAsciiAlnum = false;
                  return (
                    <span
                      key={m.token.id}
                      data-deck-token="1"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 bg-zinc-950 border border-blue-500 rounded px-1 py-0.5 mx-0.5 align-baseline"
                    >
                      <input
                        type="text"
                        value={draftHintTextInTurn}
                        onChange={(e) => callbacks.onDraftHintChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            callbacks.onCommitHint(m.token.id);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            callbacks.onCancelHint();
                          }
                        }}
                        onBlur={() => callbacks.onCommitHint(m.token.id)}
                        autoFocus
                        className="w-28 bg-transparent text-zinc-100 text-[14px] focus:outline-none"
                      />
                      <label className="text-[10px] text-zinc-400 flex items-center gap-0.5">
                        <input
                          type="checkbox"
                          checked={saveHintToGlossaryInTurn}
                          onChange={(e) => callbacks.onToggleSaveToGlossary(e.target.checked)}
                        />
                        词库
                      </label>
                    </span>
                  );
                }

                if (m.token.type === 'silence') {
                  prevEndedAsciiAlnum = false;
                  const isCleanedPause = Boolean(
                    m.token.mouthClickCleaned && m.token.trackMuted
                  );
                  return (
                    <span
                      key={m.token.id}
                      data-deck-token="1"
                      data-active-token={isActive ? '1' : undefined}
                      onMouseDown={(e) =>
                        callbacks.onTokenMouseDown(e, turn, flatIndex, m.editedStartSec)
                      }
                      onMouseEnter={() => callbacks.onTokenMouseEnter(flatIndex)}
                      onClick={(e) =>
                        callbacks.onTokenClick(e, turn, m.token.id, flatIndex, m.editedStartSec)
                      }
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        callbacks.onShortenSilence(m.token.id);
                      }}
                      title="单击跳转游标定位停顿（不缩放） · 双击压缩气口至 0.45s"
                      className={`inline-block py-0 rounded leading-5 align-baseline cursor-pointer transition-colors select-none ${
                        isHorizontal ? 'px-1 mx-0.5 text-[10.5px]' : 'px-1.5 mx-1 text-[11px]'
                      } ${
                        isWaveRangeToken
                          ? 'bg-rose-500/35 text-rose-100'
                          : isSelected
                          ? 'bg-blue-500/45 text-white'
                          : isActive
                          ? 'bg-amber-500/30 text-amber-100'
                          : isCleanedPause
                          ? 'bg-teal-500/15 text-teal-300 hover:bg-teal-500/25'
                          : 'bg-zinc-800/80 text-zinc-400 hover:bg-zinc-700'
                      }`}
                    >
                      {isCleanedPause
                        ? `💧${m.token.durationSec.toFixed(1)}s`
                        : `⏸${m.token.durationSec.toFixed(1)}s`}
                    </span>
                  );
                }

                if (m.token.bleeped) {
                  prevEndedAsciiAlnum = false;
                  return (
                    <span
                      key={m.token.id}
                      data-deck-token="1"
                      data-active-token={isActive ? '1' : undefined}
                      onClick={(e) =>
                        callbacks.onTokenBleepClick(
                          e,
                          turn,
                          m.token.id,
                          flatIndex,
                          m.editedStartSec
                        )
                      }
                      className={`inline-block py-0 rounded leading-5 align-baseline cursor-pointer select-none ${
                        isHorizontal ? 'px-1 mx-0.5 text-[10.5px]' : 'px-1.5 mx-1 text-[11px]'
                      } ${
                        isSelected
                          ? 'bg-blue-500/45 text-white'
                          : isActive
                          ? 'bg-amber-500/35 text-amber-100'
                          : 'bg-amber-500/20 text-amber-300'
                      }`}
                    >
                      🚨消音
                    </span>
                  );
                }

                const needsAsciiSpace =
                  prevEndedAsciiAlnum && /^[A-Za-z0-9]/.test(m.token.text);
                prevEndedAsciiAlnum = /[A-Za-z0-9]$/.test(m.token.text);

                const tokenCls = [
                  'inline p-0 m-0 cursor-pointer transition-colors select-none',
                  isWaveRangeToken
                    ? 'bg-rose-500/40 text-rose-50'
                    : isSelected
                    ? isActive
                      ? 'bg-blue-500/55 text-amber-100'
                      : 'bg-blue-500/45 text-white'
                    : isActive
                    ? 'bg-amber-500/30 text-amber-100'
                    : m.token.fillerTag === 'pure'
                    ? 'token-filler-wavy text-amber-200/95 hover:bg-zinc-800/80'
                    : 'text-zinc-100 hover:bg-zinc-800/75',
                  m.token.trackMuted ? 'opacity-45 line-through' : '',
                ]
                  .filter(Boolean)
                  .join(' ');

                return (
                  <span
                    key={m.token.id}
                    data-deck-token="1"
                    data-token-id={m.token.id}
                    data-token-flat-idx={flatIndex}
                    data-active-token={isActive ? '1' : undefined}
                    onMouseDown={(e) =>
                      callbacks.onTokenMouseDown(e, turn, flatIndex, m.editedStartSec)
                    }
                    onMouseEnter={() => callbacks.onTokenMouseEnter(flatIndex)}
                    onClick={(e) =>
                      callbacks.onTokenClick(e, turn, m.token.id, flatIndex, m.editedStartSec)
                    }
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      if (canEditHint) {
                        callbacks.onStartEditHint(m.token.id, m.token.text);
                      }
                    }}
                    title={`单击将游标跳至 ${formatMmSs(m.editedStartSec)}（不缩放） · 滑动选字剪辑 · 双击无损改字`}
                    className={tokenCls}
                  >
                    {needsAsciiSpace ? ` ${m.token.text}` : m.token.text}
                    {m.token.mouthClickCleaned && (
                      <span className="text-[10px] text-cyan-400 ml-0.5 align-baseline">💧</span>
                    )}
                    {m.token.subwordTrimmed && (
                      <span className="text-[10px] text-emerald-400 ml-0.5 align-baseline">⚡</span>
                    )}
                  </span>
                );
              });
            })()
          )}
        </div>
        {turn.overlaps.length > 0 && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 mt-1.5 pt-1 border-t border-purple-500/20 flex items-center justify-between gap-1.5 text-[10.5px]"
          >
            {turn.overlaps.slice(0, 1).map((ov) => (
              <React.Fragment key={ov.id}>
                <span className="text-purple-200 truncate">
                  🔀 副轨重合：{ov.secondarySpeakerName}
                </span>
                <span className="inline-flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => callbacks.onSelectOverlapRange(ov.editedStartSec, ov.editedEndSec)}
                    title="在多轨波形中框选此重合段进行精剪"
                    className="px-1.5 py-0.2 rounded border bg-purple-900/40 border-purple-500/50 text-purple-200 hover:bg-purple-800/60 cursor-pointer"
                  >
                    剪辑
                  </button>
                  <button
                    type="button"
                    onClick={() => callbacks.onCutOverlapRange(ov.editedStartSec, ov.editedEndSec)}
                    title="一键切除全轨此语音重合区间"
                    className="px-1.5 py-0.2 rounded border bg-red-950/40 border-red-500/50 text-red-300 hover:bg-red-900/60 cursor-pointer"
                  >
                    剪掉
                  </button>
                  {canToggleOverlapMute && (
                    <button
                      type="button"
                      onClick={() =>
                        callbacks.onToggleOverlapMute(ov.blockId, {
                          speakerId: ov.secondarySpeakerId,
                          speakerName: ov.secondarySpeakerName,
                          text: ov.text,
                          sourceStartMs: ov.sourceStartMs,
                          sourceEndMs: ov.sourceEndMs,
                        })
                      }
                      className={`px-1.5 py-0.2 rounded border cursor-pointer ${
                        ov.muted
                          ? 'bg-red-500/30 border-red-400/60 text-red-100'
                          : 'bg-zinc-800 border-zinc-600 text-zinc-200 hover:bg-zinc-700'
                      }`}
                    >
                      {ov.muted ? '已静音' : '静音副轨'}
                    </button>
                  )}
                  {canToggleOverlapKeepFull && (
                    <button
                      type="button"
                      onClick={() =>
                        callbacks.onToggleOverlapKeepFull(ov.blockId, {
                          speakerId: ov.secondarySpeakerId,
                          speakerName: ov.secondarySpeakerName,
                          text: ov.text,
                          sourceStartMs: ov.sourceStartMs,
                          sourceEndMs: ov.sourceEndMs,
                        })
                      }
                      className={`px-1.5 py-0.2 rounded border cursor-pointer ${
                        ov.keepFullVolume
                          ? 'bg-emerald-500/30 border-emerald-400/60 text-emerald-100'
                          : 'bg-zinc-800 border-zinc-600 text-zinc-200 hover:bg-zinc-700'
                      }`}
                    >
                      {ov.keepFullVolume ? '原声中' : '切换原声'}
                    </button>
                  )}
                </span>
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    );
  }
);

export const WaveformEditorBar: React.FC<WaveformEditorBarProps> = React.memo(({
  state,
  timeline: rawTimeline,
  playheadSec: rawPlayheadSec,
  isPlaying,
  isMainStage = false,
  selectedTokenIds,
  activeBlockId: activeBlockIdProp,
  activeTokenId: activeTokenIdProp,
  canUndo = false,
  rightPaneCollapsed = false,
  onToggleRightPane,
  speakerDeckPosition,
  onChangeSpeakerDeckPosition,
  onSwitchToTranscriptView,
  onTogglePlay,
  onStepPlayhead,
  onChangePlaybackRate,
  onSeekToSec: onRawSeekToSec,
  onHoverScrub,
  onHoverScrubStop,
  onToggleProxyEditing,
  onWaveformCutAction: onRawWaveformCutAction,
  onToggleTrackSolo,
  onToggleTrackMute,
  onToggleBgmSolo,
  onToggleBgmMute,
  onImportBgm,
  onRenameSpeakerTrack,
  onSelectToken,
  onSelectRange,
  focusRequest: rawFocusRequest,
  onClearSelection,
  onRippleDeleteSelected,
  onMuteTrackSelected,
  onBleepSelected,
  onAddSelectedToHighlight,
  onShortenSilence,
  onDeleteTokenIds,
  onMuteTokenIds,
  onCleanFillers,
  onApplyPreferenceSmartCut,
  onCleanMouthClicks,
  onUndo,
  onRetranscribe,
  onOpenAsrSettings,
  onApplyManualCorrection,
  onToggleOverlapMute,
  onToggleOverlapKeepFull,
  onCancelDuckingSelected,
  onSetWaveformSelectionMode,
  onUpdateBgmAsset,
  onOpenIntroEditor,
  onInsertSilenceAtPlayhead,
  onNotify,
  cutPoints = [],
  onInspectCutPoint,
  onOpenCutReportModal,
}) => {
  const storeActiveBlockId = useActiveBlockId();
  const storeActiveTokenId = useActiveTokenId();
  const activeBlockId = activeBlockIdProp ?? storeActiveBlockId;
  const activeTokenId = activeTokenIdProp ?? storeActiveTokenId;
  // 主音轨视图严格从正片 00:00 开始（片头高光/口播/片头BGM已分离至独立片头编辑器）
  const bodyOffsetSec = Math.max(0, rawTimeline.prefixDurationSec || 0);
  const timeline = useMemo(() => {
    if (bodyOffsetSec <= 0.001) return rawTimeline;
    const shift = (t: number) => Math.max(0, Number((t - bodyOffsetSec).toFixed(3)));
    const shiftedBlockStarts: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawTimeline.blockEditedStartsSec)) {
      shiftedBlockStarts[k] = shift(v);
    }
    return {
      ...rawTimeline,
      prefixDurationSec: 0,
      coldOpenDurationSec: 0,
      introBgmDurationSec: 0,
      introVoiceoverDurationSec: 0,
      introVoiceoverStartSec: 0,
      totalEditedDurationSec: rawTimeline.editedBodyDurationSec,
      blockEditedStartsSec: shiftedBlockStarts,
      chapters: rawTimeline.chapters
        .filter((c) => !c.isColdOpen)
        .map((c) => {
          const t = shift(c.timeSec);
          return { ...c, timeSec: t, timeFormatted: formatMmSs(t) };
        }),
      mappedTokens: rawTimeline.mappedTokens.map((m) => ({
        ...m,
        editedStartSec: shift(m.editedStartSec),
        editedEndSec: shift(m.editedEndSec),
      })),
      playbackSpans: rawTimeline.playbackSpans.map((s) => ({
        ...s,
        editedStartSec: shift(s.editedStartSec),
        editedEndSec: shift(s.editedEndSec),
      })),
      overlapRegions: rawTimeline.overlapRegions.map((ov) => ({
        ...ov,
        editedStartSec: shift(ov.editedStartSec),
        editedEndSec: shift(ov.editedEndSec),
      })),
    };
  }, [rawTimeline, bodyOffsetSec]);

  const getEffectivePlayheadSec = useCallback(
    () => Math.max(0, (rawPlayheadSec ?? getPlayheadSec()) - bodyOffsetSec),
    [rawPlayheadSec, bodyOffsetSec]
  );
  const onSeekToSec = (bodySec: number) => onRawSeekToSec(bodyOffsetSec + Math.max(0, bodySec));
  const lastDragAudioSeekPerfRef = useRef<number>(0);
  const [hoverScrubEnabled, setHoverScrubEnabled] = useState<boolean>(true);
  const [cmdKeyHeld, setCmdKeyHeld] = useState<boolean>(false);
  const hoverScrubRateRef = useRef<number | null>(null);
  const hoverScrubBtnLabelRef = useRef<HTMLSpanElement | null>(null);
  const hoverScrubSampleRef = useRef<TimelineScrubSample | null>(null);
  const hoverScrubIdleTimerRef = useRef<number | null>(null);

  const syncHoverScrubBtnLabel = useCallback(
    (rate: number | null) => {
      const el = hoverScrubBtnLabelRef.current;
      if (!el) return;
      if (!hoverScrubEnabled) {
        el.textContent = '划听已关';
      } else if (zoomRef.current < 200) {
        el.textContent = '⌘ 划听 (≥200x)';
      } else if (rate !== null) {
        el.textContent = `划听 ${rate.toFixed(1)}x`;
      } else if (cmdKeyHeld) {
        el.textContent = '⌘ 划听就绪';
      } else {
        el.textContent = '按住 ⌘ 划听';
      }
    },
    [hoverScrubEnabled, cmdKeyHeld]
  );

  const stopHoverScrub = useCallback(() => {
    if (hoverScrubIdleTimerRef.current !== null) {
      window.clearTimeout(hoverScrubIdleTimerRef.current);
      hoverScrubIdleTimerRef.current = null;
    }
    if (hoverScrubSampleRef.current !== null || hoverScrubRateRef.current !== null) {
      hoverScrubSampleRef.current = null;
      hoverScrubRateRef.current = null;
      syncHoverScrubBtnLabel(null);
      onHoverScrubStop?.();
    }
  }, [onHoverScrubStop, syncHoverScrubBtnLabel]);

  const HOVER_SCRUB_MIN_ZOOM = 200;
  const zoomRef = useRef<number>(1);

  const triggerHoverScrubAtBodySec = useCallback(
    (bodySec: number): number | null => {
      if (
        !hoverScrubEnabled ||
        !onHoverScrub ||
        zoomRef.current < HOVER_SCRUB_MIN_ZOOM ||
        timeline.totalEditedDurationSec <= 0.01
      ) {
        return null;
      }
      const clampedBody = Math.max(0, Math.min(timeline.totalEditedDurationSec, bodySec));
      const nowPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const { rate, nextSample } = computeHoverScrubRate(
        hoverScrubSampleRef.current,
        clampedBody,
        nowPerf
      );
      hoverScrubSampleRef.current = nextSample;
      hoverScrubRateRef.current = rate;
      syncHoverScrubBtnLabel(rate);
      onHoverScrub(bodyOffsetSec + clampedBody, rate);

      if (hoverScrubIdleTimerRef.current !== null) {
        window.clearTimeout(hoverScrubIdleTimerRef.current);
      }
      hoverScrubIdleTimerRef.current = window.setTimeout(() => {
        stopHoverScrub();
      }, 110);
      return rate;
    },
    [hoverScrubEnabled, onHoverScrub, timeline.totalEditedDurationSec, bodyOffsetSec, stopHoverScrub]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.key === 'Meta') {
        audioPreview.resumeContextForUserGesture();
        setCmdKeyHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || !e.metaKey) {
        setCmdKeyHeld(false);
        stopHoverScrub();
      }
    };
    const onBlur = () => {
      setCmdKeyHeld(false);
      stopHoverScrub();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (hoverScrubIdleTimerRef.current !== null) {
        window.clearTimeout(hoverScrubIdleTimerRef.current);
      }
    };
  }, [stopHoverScrub]);

  const seekDuringDrag = (bodySec: number) => {
    const clampedBody = Math.max(0, Math.min(timeline.totalEditedDurationSec, bodySec));
    setGlobalPlayheadSec(bodyOffsetSec + clampedBody);
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastDragAudioSeekPerfRef.current >= 80) {
      lastDragAudioSeekPerfRef.current = now;
      onRawSeekToSec(bodyOffsetSec + clampedBody);
    }
  };
  const onWaveformCutAction = (
    startBodySec: number,
    endBodySec: number,
    op: 'ripple_all' | 'mute_lane' | 'bleep_range' | 'add_highlight' | 'cancel_ducking',
    trackId?: string
  ) => onRawWaveformCutAction(bodyOffsetSec + startBodySec, bodyOffsetSec + endBodySec, op, trackId);

  const focusRequest = useMemo(() => {
    if (!rawFocusRequest) return rawFocusRequest;
    if (bodyOffsetSec <= 0.001) return rawFocusRequest;
    return {
      ...rawFocusRequest,
      startSec: Math.max(0, rawFocusRequest.startSec - bodyOffsetSec),
      endSec: Math.max(0, rawFocusRequest.endSec - bodyOffsetSec),
      anchorSec:
        typeof rawFocusRequest.anchorSec === 'number'
          ? Math.max(0, rawFocusRequest.anchorSec - bodyOffsetSec)
          : undefined,
    };
  }, [rawFocusRequest, bodyOffsetSec]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseCacheCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const deckScrollRef = useRef<HTMLDivElement | null>(null);
  const turnItemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const manualScrollLockUntilRef = useRef<number>(0);
  const waveformManualPanUntilRef = useRef<number>(0);
  const prevIsPlayingRef = useRef<boolean>(isPlaying);
  const prevFocusedTurnIdxRef = useRef<number>(-1);
  const suppressAutoFollowOnceRef = useRef<boolean>(false);
  const focusPulseTimerRef = useRef<number | null>(null);
  const deckScrollRafRef = useRef<number | null>(null);
  const deckDragSelectRef = useRef<{
    active: boolean;
    moved: boolean;
    anchorIdx: number;
    additive: boolean;
  }>({ active: false, moved: false, anchorIdx: 0, additive: false });
  const deckLastClickedIdxRef = useRef<number | null>(null);

  const [dockHeight, setDockHeight] = useState<number>(DEFAULT_DOCK_HEIGHT);
  const [insertSilenceSec, setInsertSilenceSec] = useState<number>(1.0);
  const [resizingHeight, setResizingHeight] = useState<boolean>(false);
  const [deckCollapsed, setDeckCollapsed] = useState<boolean>(false);
  const [deckFlowMode, setDeckFlowMode] = useState<'horizontal' | 'vertical'>('horizontal');
  const [deckHeight, setDeckHeight] = useState<number>(DEFAULT_DECK_HEIGHT);
  const [resizingDeck, setResizingDeck] = useState<boolean>(false);
  const [deckVisibleRange, setDeckVisibleRange] = useState<{ start: number; end: number }>({
    start: 0,
    end: 24,
  });
  const [hoveredTurnIdx, setHoveredTurnIdx] = useState<number | null>(null);
  const [focusedBlockOverlay, setFocusedBlockOverlay] = useState<{
    startSec: number;
    endSec: number;
    speakerId?: string;
  } | null>(null);
  const [waveformFocusPulse, setWaveformFocusPulse] = useState<boolean>(false);
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [draftTrackName, setDraftTrackName] = useState<string>('');
  const [scrubbing, setScrubbing] = useState<boolean>(false);
  const [playheadDragging, setPlayheadDragging] = useState<boolean>(false);
  const [outroTrimDragging, setOutroTrimDragging] = useState<boolean>(false);
  const [draftOutroDurationSec, setDraftOutroDurationSec] = useState<number | null>(null);
  const outroTrimActiveRef = useRef<boolean>(false);
  type HoverZoneType = 'none' | 'playhead' | 'ruler' | 'outro_trim_handle' | 'cut_badge';
  const hoverZoneRef = useRef<HoverZoneType>('none');
  const syncCanvasCursor = useCallback(
    (zone: HoverZoneType, isPlayheadDrag = false, isOutroDrag = false) => {
      const c = canvasRef.current;
      if (!c) return;
      if (isPlayheadDrag || zone === 'playhead') {
        c.style.cursor = 'ew-resize';
      } else if (isOutroDrag || zone === 'outro_trim_handle') {
        c.style.cursor = 'col-resize';
      } else if (zone === 'ruler' || zone === 'cut_badge') {
        c.style.cursor = 'pointer';
      } else {
        c.style.cursor = 'crosshair';
      }
    },
    []
  );
  const setHoverZoneFast = useCallback(
    (nextZone: HoverZoneType) => {
      if (hoverZoneRef.current === nextZone) return;
      hoverZoneRef.current = nextZone;
      syncCanvasCursor(nextZone, playheadDragging, outroTrimDragging);
      scheduleOverlayDraw();
    },
    [playheadDragging, outroTrimDragging, syncCanvasCursor]
  );
  const cutBadgeHitBoxesRef = useRef<Array<{ x1: number; y1: number; x2: number; y2: number; editedSec: number }>>([]);
  const renderedWordPillsRef = useRef<
    Array<{
      speakerId: string;
      startSec: number;
      endSec: number;
      x: number;
      y: number;
      w: number;
      h: number;
      text: string;
      trackColor: string;
    }>
  >([]);
  const renderedCaptionPillsRef = useRef<
    Array<{
      speakerId: string;
      r1: number;
      r2: number;
      x: number;
      y: number;
      w: number;
      h: number;
      text: string;
      tokens: Array<{
        startSec: number;
        endSec: number;
        charStart: number;
        charEnd: number;
        text: string;
      }>;
      trackColor: string;
    }>
  >([]);
  const scrubHoverTooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverRatioRef = useRef<number | null>(null);
  const overlayDrawRafRef = useRef<number | null>(null);
  const drawOverlayRef = useRef<() => void>(() => {});
  const scheduleOverlayDraw = useCallback(() => {
    if (overlayDrawRafRef.current !== null) return;
    overlayDrawRafRef.current = window.requestAnimationFrame(() => {
      overlayDrawRafRef.current = null;
      drawOverlayRef.current();
    });
  }, []);
  const [editingHintTokenId, setEditingHintTokenId] = useState<string | null>(null);
  const [draftHintText, setDraftHintText] = useState<string>('');
  const [saveHintToGlossary, setSaveHintToGlossary] = useState<boolean>(true);
  const waveformKeyActionsRef = useRef<{
    hasValidRange: boolean;
    rangeStartSec: number;
    rangeEndSec: number;
    isPlaying: boolean;
    canHoverMuteSelectedTokens: boolean;
    cutSelection: () => void;
    muteHoveredSelection: () => void;
    muteHoveredSelectedTokens: () => void;
    bleepSelection: () => void;
    clearSelection: () => void;
  }>({
    hasValidRange: false,
    rangeStartSec: 0,
    rangeEndSec: 0,
    isPlaying: false,
    canHoverMuteSelectedTokens: false,
    cutSelection: () => {},
    muteHoveredSelection: () => {},
    muteHoveredSelectedTokens: () => {},
    bleepSelection: () => {},
    clearSelection: () => {},
  });

  const commitWaveformTrackRename = (trackId: string) => {
    const trimmed = draftTrackName.trim();
    if (trimmed && onRenameSpeakerTrack) {
      onRenameSpeakerTrack(trackId, trimmed);
    }
    setEditingTrackId(null);
  };

  const [canvasMetrics, setCanvasMetrics] = useState<{
    width: number;
    height: number;
    dpr: number;
  }>({ width: 0, height: 0, dpr: 1 });

  const [zoom, setZoom] = useState<number>(1);
  zoomRef.current = zoom;
  const canHoverScrubAtZoom = zoom >= HOVER_SCRUB_MIN_ZOOM;

  useEffect(() => {
    if (!canHoverScrubAtZoom) {
      stopHoverScrub();
    }
  }, [canHoverScrubAtZoom, stopHoverScrub]);
  const [viewStartRatio, setViewStartRatio] = useState<number>(0);
  const [dragging, setDragging] = useState(false);
  const dragRawStartRatioRef = useRef<number | null>(null);
  const [selStartRatio, setSelStartRatio] = useState<number | null>(null);
  const [selEndRatio, setSelEndRatio] = useState<number | null>(null);
  const [selLaneIdx, setSelLaneIdx] = useState<number>(0);
  const [hoverLaneIdx, setHoverLaneIdx] = useState<number | null>(null);
  const [overlapJumpIdx, setOverlapJumpIdx] = useState<number>(0);
  const [showCutMarkers, setShowCutMarkers] = useState<boolean>(() => {
    try {
      return localStorage.getItem('podcraft_show_cut_markers') !== 'false';
    } catch {
      return true;
    }
  });
  const toggleShowCutMarkers = useCallback(() => {
    setShowCutMarkers((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('podcraft_show_cut_markers', String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);
  const [tokenContextMenu, setTokenContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [waveContextMenu, setWaveContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const selectionMode: WaveformSelectionMode = state.waveformSelectionMode ?? 'snap';
  const wordGapSnapPoints = useMemo(() => computeWordGapSnapPointsSec(timeline), [timeline]);
  const prevSelectionModeRef = useRef<WaveformSelectionMode>(selectionMode);

  useEffect(() => {
    if (!tokenContextMenu && !waveContextMenu) return;
    const close = () => {
      setTokenContextMenu(null);
      setWaveContextMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [tokenContextMenu, waveContextMenu]);

  const speakerTracks = useMemo(
    () =>
      state.tracks.some((t) => !t.isRef)
        ? state.tracks.filter((t) => !t.isRef)
        : state.tracks,
    [state.tracks]
  );
  // 片头与片尾均已分离至独立片头/片尾视图，音轨视图仅展示人声轨
  const hasOutroBgm = false;
  const hasIntroBgm = false;
  const hasBgmTrack = false;

  const anySolo = useMemo(
    () =>
      speakerTracks.some((t) => t.solo) ||
      Boolean(state.introBgm?.solo) ||
      Boolean(state.outroBgm?.solo),
    [speakerTracks, state.introBgm?.solo, state.outroBgm?.solo]
  );
  const isIntroDimmed = Boolean(state.introBgm?.muted || (anySolo && !state.introBgm?.solo));
  const isOutroDimmed = Boolean(state.outroBgm?.muted || (anySolo && !state.outroBgm?.solo));
  const isBgmDimmed = hasIntroBgm ? isIntroDimmed : isOutroDimmed;
  const hiResEnvelopesRef = useRef<Map<string, HiResWaveformEnvelope>>(new Map());
  const [hiResEnvelopeRev, setHiResEnvelopeRev] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    speakerTracks.forEach((tr) => {
      if (!tr.filePath && !tr.audioUrl) return;
      void loadTrackHiResEnvelope(tr).then((env) => {
        if (cancelled || !env) return;
        const prev = hiResEnvelopesRef.current.get(tr.id);
        if (prev !== env) {
          hiResEnvelopesRef.current.set(tr.id, env);
          setHiResEnvelopeRev((v) => v + 1);
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, [speakerTracks]);

  const trackCalibrations = useMemo(() => {
    const items = speakerTracks.map((tr) => {
      const hiRes = hiResEnvelopesRef.current.get(tr.id);
      const calibration = hiRes ?? computeLegacyPeaksCalibration(tr.peaks);
      const gainLinear = computeTrackLinearGain(tr.autoGainDb, state.loudnessAligned);
      return { id: tr.id, hiRes, calibration, gainLinear };
    });
    const sharedRefCeiling = computeSharedReferenceCeiling(
      items.map((it) => ({
        p992Peak: it.calibration.p992Peak,
        gainLinear: it.gainLinear,
      }))
    );
    const byId = new Map(items.map((it) => [it.id, it]));
    return { byId, sharedRefCeiling };
  }, [speakerTracks, state.loudnessAligned, hiResEnvelopeRev]);

  const totalSec = Math.max(0.01, timeline.totalEditedDurationSec);

  // BGM 轨紧凑化高度（不用那么高，固定约 34px）
  const BGM_LANE_COMPACT_H = 34;

  // 片头 BGM 固定长度
  const introFixedDurationSec =
    typeof state.introBgm?.customDurationSec === 'number' && state.introBgm.customDurationSec > 0
      ? state.introBgm.customDurationSec
      : (state.coldOpenEnabled && timeline.coldOpenDurationSec > 0
          ? timeline.coldOpenDurationSec + 2.0
          : 15.0);
  const introBgmEndSec = Math.min(totalSec, introFixedDurationSec);

  // 片尾 BGM：优先保留片尾视图设置的起始时间与截取时长，支持提前人声结束
  const outroSliceStart = Math.max(0, state.outroBgm?.sourceStartSec ?? 0);
  const outroSliceEnd = Math.max(
    outroSliceStart + 0.5,
    state.outroBgm?.sourceEndSec ?? state.outroBgm?.durationSec ?? 0
  );
  const defaultOutroDurationSec =
    state.outroBgm?.enabled && (state.outroBgm?.durationSec || state.outroBgm?.sourceEndSec)
      ? Number(((outroSliceEnd - outroSliceStart) * 1.2).toFixed(1))
      : Math.min(25, Math.max(6, totalSec * 0.18));
  const effectiveOutroDurationSec =
    draftOutroDurationSec ??
    (typeof state.outroBgm?.customDurationSec === 'number' && state.outroBgm.customDurationSec > 0
      ? state.outroBgm.customDurationSec
      : defaultOutroDurationSec);
  const outroStartSec =
    typeof state.outroBgm?.startOffsetSec === 'number' && state.outroBgm.startOffsetSec >= 0
      ? Math.min(Math.max(0, totalSec - 0.5), state.outroBgm.startOffsetSec)
      : Math.max(
          hasIntroBgm ? introBgmEndSec + 0.5 : 0,
          totalSec - effectiveOutroDurationSec
        );
  const outroEndSec = Math.min(totalSec, outroStartSec + effectiveOutroDurationSec);

  const maxZoom = useMemo(
    () => Math.max(200, Math.min(2400, Math.ceil(totalSec / MIN_VISIBLE_SEC))),
    [totalSec]
  );
  const visibleWindowSec = totalSec / Math.max(1, zoom);
  const wordTimelineMode = isWordTimelineZoom(zoom);
  const rulerHeightPx = wordTimelineMode ? 38 : 22;

  const visibleWordAnnotations = useMemo<TimelineWordAnnotation[]>(() => {
    if (!wordTimelineMode || canvasMetrics.width <= 0) return [];
    const span = 1 / Math.max(1, zoom);
    const viewStartSec = viewStartRatio * totalSec;
    const viewEndSec = Math.min(totalSec, (viewStartRatio + span) * totalSec);
    return buildVisibleWordTimelineAnnotations(timeline, {
      viewStartSec,
      viewEndSec,
      viewportWidthPx: canvasMetrics.width,
      totalSec,
      coldOpenEnabled: state.coldOpenEnabled,
      highlights: state.highlights,
      blocks: state.blocks,
      tracks: speakerTracks,
      hiResEnvelopes: hiResEnvelopesRef.current,
      recordingMode: state.recordingMode,
    });
  }, [
    wordTimelineMode,
    canvasMetrics.width,
    zoom,
    viewStartRatio,
    totalSec,
    timeline,
    state.coldOpenEnabled,
    state.highlights,
    state.blocks,
    speakerTracks,
    state.recordingMode,
    hiResEnvelopeRev,
  ]);
  const hasLoadedTimeline = timeline.totalEditedDurationSec > 0.01;
  const coldOpenPct = hasLoadedTimeline
    ? Math.max(0, Math.min(100, (timeline.coldOpenDurationSec / timeline.totalEditedDurationSec) * 100))
    : 0;
  const introVoStartPct = hasLoadedTimeline
    ? Math.max(0, Math.min(100, ((timeline.introVoiceoverStartSec ?? timeline.coldOpenDurationSec) / timeline.totalEditedDurationSec) * 100))
    : 0;
  const introVoPct = hasLoadedTimeline
    ? Math.max(
        0,
        Math.min(
          100 - introVoStartPct,
          (timeline.introVoiceoverDurationSec / timeline.totalEditedDurationSec) * 100
        )
      )
    : 0;

  const zoomViewRef = useRef({ zoom, viewStartRatio, maxZoom, totalSec });
  zoomViewRef.current = { zoom, viewStartRatio, maxZoom, totalSec };

  const applyZoomAtAnchor = (targetZoom: number, customAnchorRatio?: number) => {
    const {
      zoom: curZoom,
      viewStartRatio: curStart,
      maxZoom: curMaxZoom,
      totalSec: curTotalSec,
    } = zoomViewRef.current;
    const curPlaySec = getEffectivePlayheadSec();

    const clampedZoom = Math.max(
      1,
      Math.min(curMaxZoom, targetZoom < 10 ? Number(targetZoom.toFixed(2)) : Math.round(targetZoom))
    );
    if (clampedZoom <= 1.005) {
      setZoom(1);
      setViewStartRatio(0);
      return;
    }

    const prevSpan = 1 / curZoom;
    const nextSpan = 1 / clampedZoom;
    const anchor =
      typeof customAnchorRatio === 'number'
        ? Math.max(0, Math.min(1, customAnchorRatio))
        : Math.max(0, Math.min(1, curPlaySec / curTotalSec));

    let nextStart: number;
    if (anchor >= curStart && anchor <= curStart + prevSpan) {
      const fracInView = (anchor - curStart) / prevSpan;
      nextStart = anchor - fracInView * nextSpan;
    } else {
      nextStart = anchor - nextSpan * PLAYHEAD_AUTO_SCROLL_ANCHOR;
    }
    const maxStart = Math.max(0, 1 - nextSpan);
    if (typeof customAnchorRatio === 'number') {
      waveformManualPanUntilRef.current = Date.now() + 900;
    }
    setZoom(clampedZoom);
    setViewStartRatio(Math.max(0, Math.min(maxStart, nextStart)));
  };

  const seekFromScrubberClientX = (clientX: number, throttleAudio = false) => {
    const el = scrubberRef.current;
    if (!el || timeline.totalEditedDurationSec <= 0) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetBodySec = ratio * timeline.totalEditedDurationSec;
    if (throttleAudio) {
      seekDuringDrag(targetBodySec);
    } else {
      onSeekToSec(targetBodySec);
    }
  };

  const seekPlayheadWithoutZoom = (
    targetSec: number,
    overlay?: { startSec: number; endSec: number; speakerId?: string }
  ) => {
    const {
      zoom: curZoom,
      viewStartRatio: curStart,
      totalSec: curTotalSec,
    } = zoomViewRef.current;
    const safeTotal = Math.max(0.01, curTotalSec);
    const clampedSec = Math.max(0, Math.min(safeTotal, targetSec));
    const targetRatio = clampedSec / safeTotal;

    // Preserve current zoom strictly; only pan horizontally if user is already zoomed in and target is outside view
    waveformManualPanUntilRef.current = 0;
    if (curZoom > 1.005) {
      const span = 1 / curZoom;
      if (targetRatio < curStart + span * 0.04 || targetRatio > curStart + span * 0.94) {
        const maxStart = Math.max(0, 1 - span);
        const nextStart = Math.max(
          0,
          Math.min(maxStart, targetRatio - span * PLAYHEAD_AUTO_SCROLL_ANCHOR)
        );
        suppressAutoFollowOnceRef.current = true;
        setViewStartRatio(nextStart);
      }
    }

    if (overlay) {
      setFocusedBlockOverlay(overlay);
    }
    onSeekToSec(clampedSec);
  };

  const focusWaveformBlockRange = (
    startSec: number,
    endSec: number,
    speakerId?: string,
    anchorSec?: number,
    preserveHigherZoom = false,
    shouldSeek = true
  ) => {
    const {
      zoom: curZoom,
      viewStartRatio: curStart,
      maxZoom: curMaxZoom,
      totalSec: curTotalSec,
    } = zoomViewRef.current;

    const { zoom: nextZoom, viewStartRatio: nextStart, seekSec } = computeWaveformFocusViewport({
      blockStartSec: startSec,
      blockEndSec: endSec,
      totalSec: curTotalSec,
      maxZoom: curMaxZoom,
      anchorSec,
      currentZoom: curZoom,
      currentViewStartRatio: curStart,
      preserveHigherZoom,
    });

    suppressAutoFollowOnceRef.current = true;
    setZoom(nextZoom);
    setViewStartRatio(nextStart);
    setFocusedBlockOverlay({ startSec, endSec, speakerId });
    setWaveformFocusPulse(true);
    if (focusPulseTimerRef.current !== null) {
      window.clearTimeout(focusPulseTimerRef.current);
    }
    focusPulseTimerRef.current = window.setTimeout(() => {
      setWaveformFocusPulse(false);
      focusPulseTimerRef.current = null;
    }, 550);

    if (shouldSeek) {
      onSeekToSec(seekSec);
    }
  };

  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (deckDragSelectRef.current.active) {
        deckDragSelectRef.current.active = false;
      }
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp);
      if (focusPulseTimerRef.current !== null) {
        window.clearTimeout(focusPulseTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!focusRequest || focusRequest.seq <= 0) return;
    manualScrollLockUntilRef.current = 0;
    focusWaveformBlockRange(
      focusRequest.startSec,
      focusRequest.endSec,
      focusRequest.speakerId,
      focusRequest.anchorSec,
      Boolean(focusRequest.preserveHigherZoom),
      false
    );
  }, [focusRequest?.seq]);

  // Clamp zoom & viewStartRatio when maxZoom or zoom changes
  useEffect(() => {
    if (zoom > maxZoom) {
      setZoom(maxZoom);
    }
    const maxStart = Math.max(0, 1 - 1 / Math.min(zoom, maxZoom));
    setViewStartRatio((prev) => Math.max(0, Math.min(maxStart, prev)));
  }, [zoom, maxZoom]);

  // Native non-passive wheel listener for smooth cursor-anchored pinch/⌘+wheel zoom & horizontal pan
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let zoomRafId: number | null = null;
    let pendingZoomFactor = 1;
    let pendingZoomAnchor: number | undefined = undefined;
    let panRafId: number | null = null;
    let pendingPanDeltaPx = 0;

    const handleNativeWheel = (e: WheelEvent) => {
      const { zoom: curZ, viewStartRatio: curStart } = zoomViewRef.current;

      // Trackpad two-finger pinch OR Ctrl/⌘ + mouse wheel -> RAF-coalesced cursor-anchored zoom!
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const localX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        const normInView = rect.width > 0 ? localX / rect.width : 0.5;
        pendingZoomAnchor = Math.max(0, Math.min(1, curStart + normInView / curZ));
        pendingZoomFactor *= Math.exp(-e.deltaY * 0.0085);
        waveformManualPanUntilRef.current = Date.now() + 900;
        if (zoomRafId === null) {
          zoomRafId = window.requestAnimationFrame(() => {
            zoomRafId = null;
            const factor = pendingZoomFactor;
            const anchor = pendingZoomAnchor;
            pendingZoomFactor = 1;
            pendingZoomAnchor = undefined;
            applyZoomAtAnchor(zoomViewRef.current.zoom * factor, anchor);
          });
        }
        return;
      }

      // Horizontal pan when zoomed in (RAF-coalesced)
      if (curZ > 1) {
        const rawDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (rawDelta !== 0) {
          e.preventDefault();
          waveformManualPanUntilRef.current = Date.now() + 2500;
          pendingPanDeltaPx += rawDelta;
          if (panRafId === null) {
            panRafId = window.requestAnimationFrame(() => {
              panRafId = null;
              const delta = pendingPanDeltaPx;
              pendingPanDeltaPx = 0;
              const latestZ = zoomViewRef.current.zoom;
              const maxStart = Math.max(0, 1 - 1 / latestZ);
              setViewStartRatio((prev) =>
                Math.max(0, Math.min(maxStart, prev + delta / 750 / latestZ))
              );
            });
          }
        }
      }
    };

    canvas.addEventListener('wheel', handleNativeWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', handleNativeWheel);
      if (zoomRafId !== null) window.cancelAnimationFrame(zoomRafId);
      if (panRafId !== null) window.cancelAnimationFrame(panRafId);
    };
  }, []);

  // Keyboard shortcuts: Cmd/Ctrl+Shift+Delete ripple-deletes all tracks,
  // unmodified Delete mutes hovered track range, '+'/'='/'-'/'\\' zoom
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'SELECT' ||
        tag === 'TEXTAREA' ||
        target?.isContentEditable
      ) {
        return;
      }

      const isDeleteKey = e.key === 'Delete' || e.key === 'Backspace';
      if (isDeleteKey && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
        if (waveformKeyActionsRef.current.hasValidRange) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          waveformKeyActionsRef.current.cutSelection();
        }
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }

      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        applyZoomAtAnchor(zoomViewRef.current.zoom * 1.5);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        applyZoomAtAnchor(zoomViewRef.current.zoom / 1.5);
      } else if (isDeleteKey && !e.shiftKey) {
        if (waveformKeyActionsRef.current.hasValidRange) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          waveformKeyActionsRef.current.muteHoveredSelection();
        } else if (waveformKeyActionsRef.current.canHoverMuteSelectedTokens) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          waveformKeyActionsRef.current.muteHoveredSelectedTokens();
        }
      } else if ((e.key === 'b' || e.key === 'B') && waveformKeyActionsRef.current.hasValidRange) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        waveformKeyActionsRef.current.bleepSelection();
      } else if (e.key === 'Escape' && waveformKeyActionsRef.current.hasValidRange) {
        e.preventDefault();
        e.stopPropagation();
        waveformKeyActionsRef.current.clearSelection();
      } else if (
        (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') &&
        !e.repeat &&
        waveformKeyActionsRef.current.hasValidRange &&
        !waveformKeyActionsRef.current.isPlaying
      ) {
        const { rangeStartSec, rangeEndSec } = waveformKeyActionsRef.current;
        const curPlayhead = getEffectivePlayheadSec();
        if (curPlayhead < rangeStartSec - 0.05 || curPlayhead >= rangeEndSec - 0.05) {
          e.preventDefault();
          e.stopPropagation();
          if (target?.tagName === 'BUTTON') {
            target.blur();
          }
          onSeekToSec(rangeStartSec);
          onTogglePlay();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // Keep playhead anchored at left 1/3 during auto-scrolling (playback / scrubbing / out-of-view jump)
  const lastAutoFollowCommitPerfRef = useRef<number>(0);
  useEffect(() => {
    const checkAutoFollow = () => {
      const wasPlaying = prevIsPlayingRef.current;
      prevIsPlayingRef.current = isPlaying;
      if (!wasPlaying && isPlaying) {
        waveformManualPanUntilRef.current = 0;
      }

      if (suppressAutoFollowOnceRef.current) {
        suppressAutoFollowOnceRef.current = false;
        if (!isPlaying) return;
      }
      if (zoom <= 1.005) {
        if (viewStartRatio !== 0) setViewStartRatio(0);
        return;
      }
      if (dragging || playheadDragging) return;
      if (!scrubbing && Date.now() < waveformManualPanUntilRef.current) return;

      const nowPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (isPlaying && !scrubbing && nowPerf - lastAutoFollowCommitPerfRef.current < 45) {
        return;
      }

      const curPlayhead = getEffectivePlayheadSec();
      const nextStart = computeAutoScrollViewStartRatio({
        playheadSec: curPlayhead,
        totalSec,
        zoom,
        currentViewStartRatio: viewStartRatio,
        isPlaying: isPlaying || scrubbing,
        viewportWidthPx: canvasMetrics.width,
      });
      if (Math.abs(nextStart - viewStartRatio) > 0.0005) {
        lastAutoFollowCommitPerfRef.current = nowPerf;
        setViewStartRatio(nextStart);
      }
    };

    checkAutoFollow();
    return subscribePlayhead(checkAutoFollow);
  }, [
    getEffectivePlayheadSec,
    totalSec,
    zoom,
    isPlaying,
    scrubbing,
    dragging,
    playheadDragging,
    canvasMetrics.width,
    viewStartRatio,
  ]);

  // Observe exact CSS dimensions + Retina devicePixelRatio (including monitor DPI switches)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateSize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = el.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      setCanvasMetrics((prev) =>
        prev.width === w && prev.height === h && prev.dpr === dpr
          ? prev
          : { width: w, height: h, dpr }
      );
      setDockHeight((prev) => Math.min(prev, getMaxDockHeight()));
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    window.addEventListener('resize', updateSize);

    const dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    dprMedia.addEventListener?.('change', updateSize);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateSize);
      dprMedia.removeEventListener?.('change', updateSize);
    };
  }, []);

  // Precompute active speech intervals (including Cold Open highlight clips!), laugh intervals & bleep intervals
  const timelineZones = useMemo(() => {
    const rawBySpeaker: Record<string, Array<[number, number]>> = {};
    const coldClipsBySpeaker: Record<string, Array<[number, number]>> = {};
    const tokenMutedRawBySpeaker: Record<string, Array<[number, number]>> = {};
    const laughRaw: Array<[number, number]> = [];
    const bleepRaw: Array<[number, number]> = [];

    // 片头高光已分离至独立片头编辑器，主音轨仅映射正文语段与停顿

    // 2. Map Body transcript tokens onto their exact speaker tracks
    timeline.mappedTokens.forEach((m) => {
      if (m.token.deleted) return;
      const r1 = m.editedStartSec / totalSec;
      const r2 = m.editedEndSec / totalSec;
      if (r2 <= r1) return;

      if (m.token.type === 'laughter') {
        laughRaw.push([r1, r2]);
      } else if (m.token.type === 'word' && !m.token.trackMuted) {
        if (!rawBySpeaker[m.speakerId]) rawBySpeaker[m.speakerId] = [];
        rawBySpeaker[m.speakerId].push([r1, r2]);
      }
      if (m.token.trackMuted && !m.token.mouthClickCleaned) {
        if (!tokenMutedRawBySpeaker[m.speakerId]) tokenMutedRawBySpeaker[m.speakerId] = [];
        tokenMutedRawBySpeaker[m.speakerId].push([r1, r2]);
      }
      if (m.token.bleeped) {
        bleepRaw.push([r1, r2]);
      }
    });

    const clipsBySpeaker: Record<string, Array<[number, number]>> = {};
    const sortedRawBySpeaker: Record<string, Array<[number, number]>> = {};
    const sortedColdBySpeaker: Record<string, Array<[number, number]>> = {};
    const allSpeakerIds = new Set([
      ...Object.keys(rawBySpeaker),
      ...Object.keys(coldClipsBySpeaker),
    ]);
    allSpeakerIds.forEach((spId) => {
      const sortedRaw = mergeRanges(rawBySpeaker[spId] ?? [], 0.0005);
      const sortedCold = mergeRanges(coldClipsBySpeaker[spId] ?? [], 0.0005);
      sortedRawBySpeaker[spId] = sortedRaw;
      sortedColdBySpeaker[spId] = sortedCold;
      const bodyMerged = mergeRanges(sortedRaw, 0.012);
      clipsBySpeaker[spId] = mergeRanges([...sortedCold, ...bodyMerged], 0);
    });

    const allOverlapZones: Array<{
      r1: number;
      r2: number;
      primarySpeakerId: string;
      primarySpeakerName: string;
      secondarySpeakerId: string;
      secondarySpeakerName: string;
      muted: boolean;
      keepFullVolume: boolean;
      text?: string;
    }> = [];
    const secondaryOverlapsBySpeaker: Record<
      string,
      Array<{
        r1: number;
        r2: number;
        muted: boolean;
        keepFullVolume: boolean;
        primarySpeakerName: string;
        text?: string;
      }>
    > = {};

    (timeline.overlapRegions ?? []).forEach((ov) => {
      const r1 = Math.max(0, Math.min(1, ov.editedStartSec / totalSec));
      const r2 = Math.max(0, Math.min(1, ov.editedEndSec / totalSec));
      if (r2 <= r1) return;
      allOverlapZones.push({
        r1,
        r2,
        primarySpeakerId: ov.primarySpeakerId,
        primarySpeakerName: ov.primarySpeakerName,
        secondarySpeakerId: ov.secondarySpeakerId,
        secondarySpeakerName: ov.secondarySpeakerName,
        muted: ov.muted,
        keepFullVolume: ov.keepFullVolume,
        text: ov.text,
      });
      if (!secondaryOverlapsBySpeaker[ov.secondarySpeakerId]) {
        secondaryOverlapsBySpeaker[ov.secondarySpeakerId] = [];
      }
      secondaryOverlapsBySpeaker[ov.secondarySpeakerId].push({
        r1,
        r2,
        muted: ov.muted,
        keepFullVolume: ov.keepFullVolume,
        primarySpeakerName: ov.primarySpeakerName,
        text: ov.text,
      });
    });

    // 3. Phrase-level clip captions for macro & medium zoom auxiliary text hints
    const clipCaptionsBySpeaker: Record<
      string,
      Array<{
        r1: number;
        r2: number;
        text: string;
        tokens: Array<{
          startSec: number;
          endSec: number;
          charStart: number;
          charEnd: number;
          text: string;
        }>;
      }>
    > = {};
    let openPhrase: {
      speakerId: string;
      startSec: number;
      endSec: number;
      charLen: number;
      parts: string[];
      tokens: Array<{
        startSec: number;
        endSec: number;
        charStart: number;
        charEnd: number;
        text: string;
      }>;
    } | null = null;
    const flushPhrase = () => {
      if (!openPhrase || openPhrase.parts.length === 0) return;
      const r1 = Math.max(0, Math.min(1, openPhrase.startSec / totalSec));
      const r2 = Math.max(0, Math.min(1, openPhrase.endSec / totalSec));
      if (r2 > r1) {
        if (!clipCaptionsBySpeaker[openPhrase.speakerId]) {
          clipCaptionsBySpeaker[openPhrase.speakerId] = [];
        }
        clipCaptionsBySpeaker[openPhrase.speakerId].push({
          r1,
          r2,
          text: openPhrase.parts.join(''),
          tokens: openPhrase.tokens,
        });
      }
      openPhrase = null;
    };
    timeline.mappedTokens.forEach((m) => {
      if (m.token.deleted || m.token.type !== 'word' || m.token.trackMuted) {
        return;
      }
      const cleanTxt = m.token.text.trim();
      if (!cleanTxt) return;
      if (
        openPhrase &&
        openPhrase.speakerId === m.speakerId &&
        m.editedStartSec - openPhrase.endSec <= 0.45 &&
        m.editedEndSec - openPhrase.startSec <= 8.0
      ) {
        const charStart = openPhrase.charLen;
        const charEnd = charStart + cleanTxt.length;
        openPhrase.endSec = m.editedEndSec;
        openPhrase.charLen = charEnd;
        openPhrase.parts.push(cleanTxt);
        openPhrase.tokens.push({
          startSec: m.editedStartSec,
          endSec: m.editedEndSec,
          charStart,
          charEnd,
          text: cleanTxt,
        });
      } else {
        flushPhrase();
        openPhrase = {
          speakerId: m.speakerId,
          startSec: m.editedStartSec,
          endSec: m.editedEndSec,
          charLen: cleanTxt.length,
          parts: [cleanTxt],
          tokens: [
            {
              startSec: m.editedStartSec,
              endSec: m.editedEndSec,
              charStart: 0,
              charEnd: cleanTxt.length,
              text: cleanTxt,
            },
          ],
        };
      }
    });
    flushPhrase();

    // 4. Cut seams where body playback spans jump across removed audio
    const cutSeams: CutSeamZone[] = [];
    for (let i = 1; i < timeline.playbackSpans.length; i++) {
      const prev = timeline.playbackSpans[i - 1];
      const curr = timeline.playbackSpans[i];
      if (
        Math.abs(curr.editedStartSec - prev.editedEndSec) < 0.05 &&
        Math.abs(curr.sourceStartSec - prev.sourceEndSec) > 0.03
      ) {
        cutSeams.push({
          ratio: Math.max(0, Math.min(1, curr.editedStartSec / totalSec)),
          editedSec: curr.editedStartSec,
          prevSourceEndSec: prev.sourceEndSec,
          currSourceStartSec: curr.sourceStartSec,
        });
      }
    }

    cutSeams.sort((a, b) => a.editedSec - b.editedSec);
    Object.values(secondaryOverlapsBySpeaker).forEach((arr) => {
      arr.sort((a, b) => a.r1 - b.r1);
    });

    const explicitMuteByTrack: Record<string, Array<{ sourceStartMs: number; sourceEndMs: number }>> = {};
    for (const tm of state.trackMuteRanges ?? []) {
      if (tm.sourceEndMs <= tm.sourceStartMs) continue;
      if (!explicitMuteByTrack[tm.trackId]) explicitMuteByTrack[tm.trackId] = [];
      explicitMuteByTrack[tm.trackId].push({
        sourceStartMs: tm.sourceStartMs,
        sourceEndMs: tm.sourceEndMs,
      });
    }
    const mutedRangesBySpeaker: Record<string, Array<[number, number]>> = {};
    const allMutedSpIds = new Set([
      ...Object.keys(tokenMutedRawBySpeaker),
      ...Object.keys(explicitMuteByTrack),
    ]);
    allMutedSpIds.forEach((spId) => {
      const projected = projectSourceRangesMsToEditedRatios(
        timeline,
        explicitMuteByTrack[spId] ?? [],
        totalSec
      ).map((r): [number, number] => [r.startRatio, r.endRatio]);
      mutedRangesBySpeaker[spId] = mergeRanges(
        [...(tokenMutedRawBySpeaker[spId] ?? []), ...projected],
        0.0005
      );
    });

    return {
      rawBySpeaker: sortedRawBySpeaker,
      coldClipsBySpeaker: sortedColdBySpeaker,
      clipsBySpeaker,
      clipCaptionsBySpeaker,
      cutSeams,
      laughRanges: mergeRanges(laughRaw, 0.01),
      bleepRanges: mergeRanges(bleepRaw, 0.008),
      allOverlapZones,
      secondaryOverlapsBySpeaker,
      mutedRangesBySpeaker,
    };
  }, [state.coldOpenEnabled, state.highlights, state.trackMuteRanges, timeline, totalSec]);

  // Layer 1: Cache Static HiDPI Multi-Track Waveform Layer onto Offscreen Canvas (0% CPU on playhead ticks!)
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (canvasMetrics.width === 0 || canvasMetrics.height === 0) return;

    const { width: W, height: H, dpr } = canvasMetrics;
    const targetPhysW = Math.round(W * dpr);
    const targetPhysH = Math.round(H * dpr);

    let offCanvas = baseCacheCanvasRef.current;
    if (!offCanvas) {
      offCanvas = document.createElement('canvas');
      baseCacheCanvasRef.current = offCanvas;
    }
    if (offCanvas.width !== targetPhysW || offCanvas.height !== targetPhysH) {
      offCanvas.width = targetPhysW;
      offCanvas.height = targetPhysH;
    }

    const ctx = offCanvas.getContext('2d', { alpha: false }) ?? offCanvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderedWordPillsRef.current = [];
    renderedCaptionPillsRef.current = [];

    const RULER_H = rulerHeightPx;
    const topRulerBandH = wordTimelineMode ? 14 : RULER_H;
    const topBadgeY = wordTimelineMode ? 1.5 : 3;
    const topBadgeH = wordTimelineMode ? 11 : RULER_H - 6;
    const topBadgeCenterY = wordTimelineMode ? 7 : RULER_H / 2 + 0.5;
    const BODY_H = Math.max(1, H - RULER_H);
    // BGM 轨高度紧凑化：不用那么高（固定约 34px），将充足的垂直空间留给人声音轨
    const bgmLaneH = hasBgmTrack ? Math.min(BGM_LANE_COMPACT_H, Math.max(26, Math.round(BODY_H * 0.2))) : 0;
    const speakerLaneH = (BODY_H - bgmLaneH) / Math.max(1, speakerTracks.length);
    const getLaneBounds = (idx: number) => {
      if (hasBgmTrack && idx === speakerTracks.length) {
        return {
          yTop: RULER_H + speakerTracks.length * speakerLaneH,
          laneH: bgmLaneH,
        };
      }
      return {
        yTop: RULER_H + idx * speakerLaneH,
        laneH: speakerLaneH,
      };
    };
    const laneH = speakerLaneH;
    const laneCount = Math.max(1, speakerTracks.length + (hasBgmTrack ? 1 : 0));
    const visibleSpan = 1 / zoom;
    const viewEndRatio = Math.min(1, viewStartRatio + visibleSpan);

    const ratioToX = (r: number) => (r - viewStartRatio) * zoom * W;
    const xToRatio = (x: number) => viewStartRatio + (x / W) / zoom;

    // 1. Studio Canvas Background
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, W, H);

    // 2. Time Ruler Strip & Vertical Gridlines
    ctx.fillStyle = '#111115';
    ctx.fillRect(0, 0, W, topRulerBandH);

    const visibleSec = totalSec * visibleSpan;
    const { major, minor, decimals } = chooseTickSteps(visibleSec);
    const firstTickIdx = Math.max(0, Math.floor((viewStartRatio * totalSec) / minor));
    const lastTickIdx = Math.ceil((viewEndRatio * totalSec) / minor);
    const majorMultiple = Math.max(1, Math.round(major / minor));

    ctx.font = wordTimelineMode
      ? '500 9.5px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
      : '500 10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    ctx.textBaseline = 'middle';

    for (let tickIdx = firstTickIdx; tickIdx <= lastTickIdx; tickIdx++) {
      const t = Number((tickIdx * minor).toFixed(4));
      const r = t / totalSec;
      if (r < viewStartRatio - 0.0005 || r > viewEndRatio + 0.0005) continue;
      const x = Math.round(ratioToX(r)) + 0.5;
      const isMajor = tickIdx % majorMultiple === 0;

      if (isMajor) {
        // Subtle vertical timeline gridline across lanes
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, RULER_H);
        ctx.lineTo(x, H);
        ctx.stroke();

        // Major tick on clock ruler band
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.26)';
        ctx.beginPath();
        ctx.moveTo(x, topRulerBandH - (wordTimelineMode ? 4 : 6));
        ctx.lineTo(x, topRulerBandH);
        ctx.stroke();

        const label = formatPrecisionSec(t, decimals);
        if (x + 44 < W) {
          ctx.fillStyle = 'rgba(161, 161, 170, 0.92)';
          ctx.fillText(label, x + 4, wordTimelineMode ? 7.5 : topRulerBandH / 2 + 0.5);
        }
      } else {
        // Fine sub-division gridline when zoomed deeply for millisecond boundary editing
        if (visibleSec <= 12) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.016)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, RULER_H);
          ctx.lineTo(x, H);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.11)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, topRulerBandH - (wordTimelineMode ? 2.5 : 3.5));
        ctx.lineTo(x, topRulerBandH);
        ctx.stroke();
      }
    }

    // Chapter markers on ruler
    timeline.chapters.forEach((ch) => {
      const cr = ch.timeSec / totalSec;
      if (cr < viewStartRatio || cr > viewEndRatio) return;
      const cx = ratioToX(cr);
      const triH = wordTimelineMode ? 3.5 : 4;
      const triW = wordTimelineMode ? 2.5 : 3;
      ctx.fillStyle = ch.isColdOpen ? '#a855f7' : '#3b82f6';
      ctx.beginPath();
      ctx.moveTo(cx, topRulerBandH - 1);
      ctx.lineTo(cx - triW, topRulerBandH - 1 - triH);
      ctx.lineTo(cx + triW, topRulerBandH - 1 - triH);
      ctx.closePath();
      ctx.fill();
    });

    // 2b. >=100x Word/Character Annotated Timeline Band (y = 14.5 .. RULER_H)
    if (wordTimelineMode) {
      ctx.fillStyle = '#0c0c11';
      ctx.fillRect(0, topRulerBandH, W, RULER_H - topRulerBandH);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, topRulerBandH + 0.5);
      ctx.lineTo(W, topRulerBandH + 0.5);
      ctx.stroke();

      const trackColorBySpeaker = new Map(speakerTracks.map((t) => [t.id, t.color]));
      const bandTop = topRulerBandH + 1;
      const bandBot = RULER_H - 1;
      const barTop = RULER_H - 3;
      const bandMidY = bandTop + (barTop - bandTop) * 0.5;

      let lastRulerLabelRightX = -999;
      let lastRulerGridTickX = -999;
      let prevAnn: { ax1: number; editedEndSec: number } | null = null;

      ctx.save();
      for (let idx = 0; idx < visibleWordAnnotations.length; idx++) {
        const ann = visibleWordAnnotations[idx];
        const ax0 = ratioToX(ann.editedStartSec / totalSec);
        const ax1 = ratioToX(ann.editedEndSec / totalSec);
        const nextAnn =
          idx + 1 < visibleWordAnnotations.length ? visibleWordAnnotations[idx + 1] : null;
        const nextAx0 = nextAnn ? ratioToX(nextAnn.editedStartSec / totalSec) : W + 200;
        const spColor = trackColorBySpeaker.get(ann.speakerId) ?? '#38bdf8';

        // Inter-word / inter-character silence gap readout when gap >= 15ms and >= 36px wide
        if (prevAnn !== null) {
          const gapSec = ann.editedStartSec - prevAnn.editedEndSec;
          const gapPx = ax0 - prevAnn.ax1;
          if (gapSec >= 0.015 && gapPx >= 36) {
            const gLabel =
              gapSec < 1 ? `${Math.round(gapSec * 1000)}ms` : `${gapSec.toFixed(2)}s`;
            ctx.font = '500 9px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.textBaseline = 'middle';
            const gtw = ctx.measureText(gLabel).width;
            const gx = (Math.max(0, prevAnn.ax1) + Math.min(W, ax0)) * 0.5;
            const gxLeft = gx - gtw * 0.5;
            if (
              gtw + 8 <= gapPx &&
              gxLeft >= Math.max(prevAnn.ax1 + 3, lastRulerLabelRightX + 3) &&
              gx + gtw * 0.5 + 3 <= ax0 &&
              gx > 10 &&
              gx < W - 10
            ) {
              ctx.fillStyle = 'rgba(161, 161, 170, 0.78)';
              ctx.fillText(gLabel, gxLeft, bandMidY + 0.5);
              lastRulerLabelRightX = Math.max(lastRulerLabelRightX, gx + gtw * 0.5 + 2);
            }
          }
        }

        const visX0 = Math.max(0, ax0);
        const visX1 = Math.min(W, ax1);
        const visW = visX1 - visX0;

        if (visW >= 0.5) {
          ctx.fillStyle = hexToRgba(spColor, ann.isFiller ? 0.16 : 0.11);
          ctx.fillRect(visX0, bandTop, visW, Math.max(2, barTop - bandTop));

          ctx.fillStyle = hexToRgba(spColor, ann.isFiller ? 0.52 : 0.78);
          ctx.fillRect(visX0, barTop, visW, 2);
        }

        // Left onset tick (solid for token boundary, dashed [2,2] for proportional sub-char split)
        if (ax0 >= 0 && ax0 <= W) {
          const tickX = Math.round(ax0) + 0.5;
          if (!ann.isSubCharSplit && Math.abs(ax0 - lastRulerGridTickX) >= 8) {
            lastRulerGridTickX = ax0;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.032)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(tickX, RULER_H);
            ctx.lineTo(tickX, H);
            ctx.stroke();
          }

          ctx.save();
          if (ann.isSubCharSplit) {
            ctx.setLineDash([2, 2]);
            ctx.strokeStyle = hexToRgba(spColor, 0.45);
          } else {
            ctx.strokeStyle = hexToRgba(spColor, 0.85);
          }
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(tickX, bandTop);
          ctx.lineTo(tickX, bandBot);
          ctx.stroke();
          ctx.restore();
        }

        // Right offset tick before silence gaps >= 12ms
        const nextGapSec = nextAnn ? nextAnn.editedStartSec - ann.editedEndSec : Infinity;
        if (ax1 >= 0 && ax1 <= W && nextGapSec >= 0.012) {
          const endTickX = Math.round(ax1) - 0.5;
          ctx.strokeStyle = hexToRgba(spColor, 0.55);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(endTickX, RULER_H - 9);
          ctx.lineTo(endTickX, bandBot);
          ctx.stroke();
        }

        // Collision-free 字/词 glyph placement
        const labelStartX = Math.max(2, ax0 + 2, lastRulerLabelRightX + 2);
        const spanReachX = Math.max(ax0 + 4, ax1 - 4);
        if (labelStartX < spanReachX && labelStartX < W - 10) {
          const nextGapPx = nextAnn ? nextAx0 - ax1 : Infinity;
          let maxRightX = W - 2;
          if (nextAnn && nextAnn.speakerId !== ann.speakerId) {
            maxRightX = Math.min(maxRightX, nextAx0 - 2);
          } else if (nextAnn && nextGapSec >= 0.015 && nextGapPx >= 18) {
            const gapCap =
              nextGapPx >= 36 ? nextAx0 - nextGapPx * 0.5 - 16 : nextAx0 - 2;
            maxRightX = Math.min(maxRightX, Math.max(ax1 + 4, gapCap));
          }

          const availW = maxRightX - labelStartX;
          if (availW >= 10) {
            const labelTxt = ann.isSubwordTrimmed ? `${ann.text}⚡` : ann.text;
            ctx.font =
              '600 11.5px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
            ctx.textBaseline = 'middle';
            const tWidth = ctx.measureText(labelTxt).width;
            const drawW = Math.min(availW, tWidth + 1);
            ctx.save();
            ctx.beginPath();
            ctx.rect(labelStartX, bandTop, drawW, barTop - bandTop);
            ctx.clip();
            ctx.fillStyle = ann.isFiller ? '#fde68a' : '#fafafa';
            ctx.fillText(labelTxt, labelStartX, bandMidY);
            ctx.restore();
            lastRulerLabelRightX = labelStartX + Math.min(tWidth, availW);
          }
        }

        prevAnn =
          prevAnn && prevAnn.editedEndSec > ann.editedEndSec
            ? prevAnn
            : { ax1, editedEndSec: ann.editedEndSec };
      }
      ctx.restore();
    }

    // Ruler bottom hairline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5);
    ctx.lineTo(W, RULER_H + 0.5);
    ctx.stroke();

    // 3a/3b. 片头高光与固定口播已分离至独立片头编辑器，主音轨保持纯粹正文视图

    // 3d. 重复/重合处无需在波形上特地标注（保留自动降音/静音波形幅度效果）

    // 4. Multi-Track Lanes, DAW Clip Regions & True Audition Bipolar Peak + RMS Envelopes
    const stepPx = 1.0;

    speakerTracks.forEach((tr, idx) => {
      const yTop = RULER_H + idx * laneH;
      const yMid = yTop + laneH / 2;
      const maxHalfAmp = Math.max(5, laneH * 0.43);
      const isMutedOrUnsoloed = tr.muted || (anySolo && !tr.solo);
      const voiceBoost = tr.role === 'guest' && !state.loudnessAligned ? 0.76 : 0.96;

      // Subtle alternating lane background (hover highlight moved to Layer 2 overlay)
      if (idx % 2 === 1) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.012)';
        ctx.fillRect(0, yTop, W, laneH);
      }

      // Lane divider hairline
      if (idx > 0) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(yTop) + 0.5);
        ctx.lineTo(W, Math.round(yTop) + 0.5);
        ctx.stroke();
      }

      // Center 0-crossing horizontal axis
      ctx.strokeStyle = hexToRgba(tr.color, isMutedOrUnsoloed ? 0.1 : 0.24);
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(yMid) + 0.5);
      ctx.lineTo(W, Math.round(yMid) + 0.5);
      ctx.stroke();

      // Exact -6 dBFS (0.50 linear) & -12 dBFS (0.25 linear) reference guides calibrated to maxHalfAmp
      if (laneH >= 58) {
        const subOffset = maxHalfAmp * 0.5;
        ctx.save();
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(yMid - subOffset) + 0.5);
        ctx.lineTo(W, Math.round(yMid - subOffset) + 0.5);
        ctx.moveTo(0, Math.round(yMid + subOffset) + 0.5);
        ctx.lineTo(W, Math.round(yMid + subOffset) + 0.5);
        if (laneH >= 88) {
          const qOffset = maxHalfAmp * 0.25;
          ctx.moveTo(0, Math.round(yMid - qOffset) + 0.5);
          ctx.lineTo(W, Math.round(yMid - qOffset) + 0.5);
          ctx.moveTo(0, Math.round(yMid + qOffset) + 0.5);
          ctx.lineTo(W, Math.round(yMid + qOffset) + 0.5);
        }
        ctx.stroke();
        ctx.restore();

        if (W >= 240) {
          ctx.save();
          ctx.font = '500 8.5px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.fillStyle = 'rgba(161, 161, 170, 0.35)';
          ctx.textBaseline = 'middle';
          ctx.fillText('0dB', W - 22, yTop + 8);
          ctx.fillText('-6', W - 18, Math.round(yMid - subOffset));
          if (laneH >= 88) {
            ctx.fillText('-12', W - 22, Math.round(yMid - maxHalfAmp * 0.25));
          }
          ctx.restore();
        }
      }

      const clips = timelineZones.clipsBySpeaker[tr.id] ?? [];
      const rawWords = timelineZones.rawBySpeaker[tr.id] ?? [];
      const coldClips = timelineZones.coldClipsBySpeaker[tr.id] ?? [];
      const secOverlaps = timelineZones.secondaryOverlapsBySpeaker[tr.id] ?? [];
      const trackMutedZones = timelineZones.mutedRangesBySpeaker[tr.id] ?? [];

      // Draw DAW Speech Clip Region Containers (subtly tinted so dark inter-word gaps remain sharp)
      clips.forEach(([r1, r2]) => {
        if (r2 < viewStartRatio || r1 > viewEndRatio) return;
        const rx0 = Math.max(0, ratioToX(r1));
        const rx1 = Math.min(W, ratioToX(r2));
        const rw = rx1 - rx0;
        if (rw < 2) return;

        const clipPadY = 3;
        const clipH = Math.max(8, laneH - clipPadY * 2);

        ctx.fillStyle = hexToRgba(tr.color, isMutedOrUnsoloed ? 0.012 : 0.032);
        ctx.beginPath();
        ctx.roundRect(rx0, yTop + clipPadY, rw, clipH, 4.5);
        ctx.fill();

        ctx.strokeStyle = hexToRgba(tr.color, isMutedOrUnsoloed ? 0.06 : 0.15);
        ctx.lineWidth = 0.85;
        ctx.stroke();

        // Subtle top clip accent bar
        if (!isMutedOrUnsoloed && rw > 5) {
          ctx.fillStyle = hexToRgba(tr.color, 0.34);
          ctx.beginPath();
          ctx.roundRect(rx0 + 0.5, yTop + clipPadY, rw - 1, 1.5, [4, 4, 0, 0]);
          ctx.fill();
        }
      });

      const coreLineColor = lightenHex(tr.color, 36);
      const rmsCoreColor = lightenHex(tr.color, 68);

      const trCalInfo = trackCalibrations.byId.get(tr.id);
      const hiRes = trCalInfo?.hiRes;
      const calibration = trCalInfo?.calibration ?? computeLegacyPeaksCalibration(tr.peaks);
      const gainLinear =
        trCalInfo?.gainLinear ?? computeTrackLinearGain(tr.autoGainDb, state.loudnessAligned);
      const sharedRefCeiling = trackCalibrations.sharedRefCeiling;

      const rawTrackDurMs = (tr.durationMs ?? 0) > 0 ? tr.durationMs! : hiRes?.durationMs ?? 0;
      const trackDurMs = hiRes && hiRes.numBins > 0 ? hiRes.durationMs : rawTrackDurMs;
      const hasAuthenticSource = Boolean(
        trackDurMs > 0 && ((hiRes && hiRes.numBins >= 16) || tr.peaks.length >= 16)
      );
      const trackOffsetMs =
        state.recordingMode === 'same_room_sync' ? 0 : tr.syncOffsetMs || 0;
      const halfBarSec = ((stepPx * 0.5) / Math.max(1, W)) * visibleSec;
      const halfSourceWindowRatio = trackDurMs > 0 ? (halfBarSec * 1000) / trackDurMs : 0;

      interface WaveSamplePt {
        x: number;
        posAmpPx: number;
        negAmpPx: number;
        rmsAmpPx: number;
        yUpper: number;
        yLower: number;
        yRmsUpper: number;
        yRmsLower: number;
        isVoiced: boolean;
      }

      const waveSamples: WaveSamplePt[] = [];
      const gatePoints: Array<{ x: number; open: number }> = [];
      const laughRanges = timelineZones.laughRanges;
      const cutSeams = timelineZones.cutSeams;
      const playbackSpans = timeline.playbackSpans;
      let clipCur = 0;
      let wordCur = 0;
      let coldCur = 0;
      let laughCur = 0;
      let secOvCur = 0;
      let muteCur = 0;
      let seamCur = 0;
      let spanCur = 0;

      for (let x = 0; x <= W; x += stepPx) {
        const normR = Math.max(0, Math.min(1, xToRatio(x)));
        const editedSec = normR * totalSec;

        while (clipCur < clips.length && clips[clipCur][1] < normR) clipCur++;
        const inClip = clipCur < clips.length && clips[clipCur][0] <= normR;

        while (wordCur < rawWords.length && rawWords[wordCur][1] < normR) wordCur++;
        const inWord = wordCur < rawWords.length && rawWords[wordCur][0] <= normR;

        while (coldCur < coldClips.length && coldClips[coldCur][1] < normR) coldCur++;
        const inColdClip = coldCur < coldClips.length && coldClips[coldCur][0] <= normR;

        while (laughCur < laughRanges.length && laughRanges[laughCur][1] < normR) laughCur++;
        const inLaugh = laughCur < laughRanges.length && laughRanges[laughCur][0] <= normR;

        while (secOvCur < secOverlaps.length && secOverlaps[secOvCur].r2 < normR) secOvCur++;
        const activeSecOv =
          secOvCur < secOverlaps.length && secOverlaps[secOvCur].r1 <= normR
            ? secOverlaps[secOvCur]
            : undefined;

        while (muteCur < trackMutedZones.length && trackMutedZones[muteCur][1] < normR) muteCur++;
        const inManualMuteZone =
          muteCur < trackMutedZones.length && trackMutedZones[muteCur][0] <= normR;

        let posNorm = 0;
        let negNorm = 0;
        let rmsNorm = 0;
        let voicedByAcousticOrWord = false;

        if (hasAuthenticSource) {
          while (
            seamCur < cutSeams.length &&
            cutSeams[seamCur].editedSec < editedSec - CUT_SEAM_HALF_SEC
          ) {
            seamCur++;
          }
          const nearbySeam =
            seamCur < cutSeams.length &&
            Math.abs(editedSec - cutSeams[seamCur].editedSec) <= CUT_SEAM_HALF_SEC
              ? cutSeams[seamCur]
              : undefined;

          if (nearbySeam) {
            const pt = sampleSeamBlendedWaveform(
              hiRes,
              tr.peaks,
              nearbySeam,
              editedSec,
              trackDurMs,
              trackOffsetMs,
              halfSourceWindowRatio,
              gainLinear,
              calibration,
              sharedRefCeiling
            );
            posNorm = pt.posPeak;
            negNorm = pt.negPeak;
            rmsNorm = pt.rms;
          } else {
            let sourceRatio: number | null = null;
            const inColdOpenRegion =
              state.coldOpenEnabled &&
              timeline.coldOpenDurationSec > 0 &&
              editedSec < timeline.coldOpenDurationSec;
            const voStart = timeline.introVoiceoverStartSec ?? timeline.coldOpenDurationSec;
            const inIntroVoRegion =
              timeline.introVoiceoverDurationSec > 0 &&
              editedSec >= voStart &&
              editedSec < voStart + timeline.introVoiceoverDurationSec;
            if (!inColdOpenRegion && !inIntroVoRegion && playbackSpans.length > 0) {
              while (
                spanCur < playbackSpans.length &&
                playbackSpans[spanCur].editedEndSec + 0.001 < editedSec
              ) {
                spanCur++;
              }
              if (
                spanCur < playbackSpans.length &&
                editedSec >= playbackSpans[spanCur].editedStartSec - 0.001
              ) {
                const sp = playbackSpans[spanCur];
                const clampedT = Math.max(sp.editedStartSec, Math.min(sp.editedEndSec, editedSec));
                const srcMs =
                  (sp.sourceStartSec + (clampedT - sp.editedStartSec)) * 1000 - trackOffsetMs;
                sourceRatio =
                  srcMs < 0 || srcMs > trackDurMs
                    ? null
                    : Math.max(0, Math.min(0.999999, srcMs / trackDurMs));
              } else {
                sourceRatio = resolveEditedSecToSourceRatio(
                  editedSec,
                  state.coldOpenEnabled,
                  timeline.coldOpenDurationSec,
                  timeline.introVoiceoverDurationSec,
                  state.highlights,
                  playbackSpans,
                  timeline.mappedTokens,
                  trackDurMs,
                  trackOffsetMs,
                  resolveEffectiveHighlightGapSec(state),
                  timeline.introVoiceoverStartSec
                );
              }
            } else {
              sourceRatio = resolveEditedSecToSourceRatio(
                editedSec,
                state.coldOpenEnabled,
                timeline.coldOpenDurationSec,
                timeline.introVoiceoverDurationSec,
                state.highlights,
                playbackSpans,
                timeline.mappedTokens,
                trackDurMs,
                trackOffsetMs,
                resolveEffectiveHighlightGapSec(state),
                timeline.introVoiceoverStartSec
              );
            }
            if (sourceRatio !== null) {
              const pt = sampleCalibratedWaveformPoint(
                hiRes,
                tr.peaks,
                sourceRatio,
                halfSourceWindowRatio,
                gainLinear,
                calibration,
                sharedRefCeiling
              );
              posNorm = pt.posPeak;
              negNorm = pt.negPeak;
              rmsNorm = pt.rms;
            }
          }

          // Cross-mic bleed visual suppression on idle speaker tracks when another track is active
          if (
            speakerTracks.length > 1 &&
            state.autoSoloMode !== 'off' &&
            !inWord &&
            !inColdClip &&
            !inLaugh &&
            !activeSecOv &&
            posNorm < 0.22 &&
            negNorm < 0.22
          ) {
            posNorm *= 0.25;
            negNorm *= 0.25;
            rmsNorm *= 0.25;
          }

          voicedByAcousticOrWord = Math.max(posNorm, negNorm) >= 0.018;
        } else {
          // Synthetic unit-test fallback when no real audio peaks exist
          const activeSynth = inWord || inColdClip || inLaugh || Boolean(activeSecOv);
          if (activeSynth) {
            const env = computeFallbackSynthEnvelope(
              normR,
              totalSec,
              idx + 1,
              inLaugh ? 1.05 : voiceBoost
            );
            posNorm = env;
            negNorm = env * 0.94;
            rmsNorm = env * 0.56;
          } else {
            const floor = computeFloorNoise(normR, totalSec, idx + 1) * (inClip ? 1.3 : 0.8);
            posNorm = floor * 0.35;
            negNorm = floor * 0.35;
            rmsNorm = floor * 0.18;
          }
          voicedByAcousticOrWord = activeSynth;
        }

        // Visually reflect Non-Primary Speaker Auto-Ducking and Manual Single-Track Mutes
        const secOvDucked =
          Boolean(activeSecOv) &&
          !activeSecOv!.muted &&
          state.autoSoloMode !== 'off' &&
          !activeSecOv!.keepFullVolume;
        const secOvMuted = Boolean(activeSecOv?.muted);

        if (secOvMuted || inManualMuteZone) {
          posNorm *= 0.08;
          negNorm *= 0.08;
          rmsNorm *= 0.08;
        } else if (secOvDucked) {
          const duckScale = state.autoSoloMode === 'hard_mute' ? 0.16 : 0.45;
          posNorm *= duckScale;
          negNorm *= duckScale;
          rmsNorm *= duckScale;
        }

        const isVoiced =
          !isMutedOrUnsoloed && !secOvMuted && !inManualMuteZone && voicedByAcousticOrWord;

        let gateOpen =
          inClip || inLaugh || inColdClip || voicedByAcousticOrWord || activeSecOv ? 1 : 0;
        if (secOvMuted || inManualMuteZone) {
          gateOpen = 0;
        } else if (secOvDucked) {
          gateOpen = state.autoSoloMode === 'hard_mute' ? 0.06 : 0.32;
        }
        gatePoints.push({ x, open: gateOpen });

        const posAmpPx = posNorm * maxHalfAmp;
        const negAmpPx = negNorm * maxHalfAmp;
        const rmsAmpPx = Math.min(rmsNorm * maxHalfAmp, Math.max(posAmpPx, negAmpPx) * 0.92);

        waveSamples.push({
          x,
          posAmpPx,
          negAmpPx,
          rmsAmpPx,
          yUpper: yMid - posAmpPx,
          yLower: yMid + negAmpPx,
          yRmsUpper: yMid - rmsAmpPx,
          yRmsLower: yMid + rmsAmpPx,
          isVoiced,
        });
      }

      if (waveSamples.length >= 2) {
        // Pass 1: Subtle baseline vertical excursions for unvoiced/muted trace (silent gaps stay pure dark)
        ctx.save();
        ctx.strokeStyle = hexToRgba(tr.color, isMutedOrUnsoloed ? 0.18 : 0.24);
        ctx.lineWidth = 0.85;
        ctx.beginPath();
        for (let i = 0; i < waveSamples.length; i++) {
          const p = waveSamples[i];
          if (p.posAmpPx > 0.35 || p.negAmpPx > 0.35) {
            const xAligned = Math.round(p.x) + 0.5;
            ctx.moveTo(xAligned, p.yUpper);
            ctx.lineTo(xAligned, p.yLower);
          }
        }
        ctx.stroke();
        ctx.restore();

        if (!isMutedOrUnsoloed) {
          // Pass 2: Voiced Audition Peak Transient Layer — segmented strictly per voiced syllable (never bridges gaps!)
          ctx.save();
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.strokeStyle = coreLineColor;
          ctx.globalAlpha = 0.78;
          ctx.lineWidth = 0.95;
          ctx.beginPath();
          let inPeakRun = false;
          for (let i = 0; i < waveSamples.length; i++) {
            const p = waveSamples[i];
            if (!p.isVoiced) {
              inPeakRun = false;
              continue;
            }
            const nextX =
              i + 1 < waveSamples.length
                ? (p.x + waveSamples[i + 1].x) * 0.5
                : p.x + stepPx * 0.5;
            const flip = (i & 1) === 0;
            if (!inPeakRun) {
              ctx.moveTo(p.x, flip ? p.yUpper : p.yLower);
              ctx.lineTo(nextX, flip ? p.yLower : p.yUpper);
              inPeakRun = true;
            } else {
              ctx.lineTo(p.x, flip ? p.yUpper : p.yLower);
              ctx.lineTo(nextX, flip ? p.yLower : p.yUpper);
            }
          }
          ctx.stroke();
          ctx.restore();

          // Pass 3: Voiced Audition Bright RMS Loudness Core — segmented per contiguous voiced syllable island
          ctx.save();
          let runStart = -1;
          const drawRmsIsland = (sIdx: number, eIdx: number) => {
            if (eIdx > sIdx) {
              ctx.fillStyle = rmsCoreColor;
              ctx.globalAlpha = 0.52;
              ctx.beginPath();
              for (let j = sIdx; j <= eIdx; j++) {
                const pt = waveSamples[j];
                if (j === sIdx) ctx.moveTo(pt.x, pt.yRmsUpper);
                else ctx.lineTo(pt.x, pt.yRmsUpper);
              }
              for (let j = eIdx; j >= sIdx; j--) {
                const pt = waveSamples[j];
                ctx.lineTo(pt.x, pt.yRmsLower);
              }
              ctx.closePath();
              ctx.fill();
            }

            ctx.strokeStyle = rmsCoreColor;
            ctx.globalAlpha = 0.85;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let j = sIdx; j <= eIdx; j++) {
              const pt = waveSamples[j];
              const rx = Math.round(pt.x) + 0.5;
              ctx.moveTo(rx, pt.yRmsUpper);
              ctx.lineTo(rx, pt.yRmsLower);
            }
            ctx.stroke();
          };

          for (let i = 0; i < waveSamples.length; i++) {
            const p = waveSamples[i];
            const rmsActive = p.isVoiced && p.rmsAmpPx >= 0.6;
            if (rmsActive) {
              if (runStart < 0) runStart = i;
            } else if (runStart >= 0) {
              drawRmsIsland(runStart, i - 1);
              runStart = -1;
            }
          }
          if (runStart >= 0) {
            drawRmsIsland(runStart, waveSamples.length - 1);
          }
          ctx.restore();
        }
      }
      ctx.globalAlpha = 1;

      // Subtle DAW Auto-Solo Gate Automation Envelope (toned down so it never obscures loudness or gaps)
      if (state.autoSoloMode !== 'off' && gatePoints.length > 2 && !isMutedOrUnsoloed && laneH >= 56) {
        const yOpen = yTop + 4.5;
        const yClosed =
          state.autoSoloMode === 'hard_mute' ? yTop + laneH - 3.5 : yTop + laneH - 7.5;

        const radius = 4;
        const nGate = gatePoints.length;
        let winSum = 0;
        let winLeft = 0;
        let winRight = -1;
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.24)';
        ctx.lineWidth = 0.9;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < nGate; i++) {
          const targetLeft = Math.max(0, i - radius);
          const targetRight = Math.min(nGate - 1, i + radius);
          while (winRight < targetRight) {
            winRight++;
            winSum += gatePoints[winRight].open;
          }
          while (winLeft < targetLeft) {
            winSum -= gatePoints[winLeft].open;
            winLeft++;
          }
          const smoothOpen = Math.max(0, Math.min(1, winSum / (winRight - winLeft + 1)));
          const eased = smoothOpen * smoothOpen * (3 - 2 * smoothOpen);
          const gy = yClosed - eased * (yClosed - yOpen);
          if (i === 0) ctx.moveTo(gatePoints[i].x, gy);
          else ctx.lineTo(gatePoints[i].x, gy);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Explicit Manual Single-Track Mute Bands (Delete shortcut mute per track)
      trackMutedZones.forEach(([mr1, mr2]) => {
        if (mr2 < viewStartRatio || mr1 > viewEndRatio) return;
        const mx0 = Math.max(0, ratioToX(mr1));
        const mx1 = Math.min(W, ratioToX(mr2));
        const mw = Math.max(3, mx1 - mx0);
        const padY = 3;
        const mh = Math.max(8, laneH - padY * 2);

        ctx.save();
        ctx.fillStyle = 'rgba(24, 24, 27, 0.58)';
        ctx.beginPath();
        ctx.roundRect(mx0, yTop + padY, mw, mh, 3.5);
        ctx.fill();
        ctx.setLineDash([3, 2]);
        ctx.strokeStyle = 'rgba(161, 161, 170, 0.58)';
        ctx.lineWidth = 1;
        ctx.stroke();

        if (mw >= 44 && laneH >= 28) {
          ctx.setLineDash([]);
          ctx.font = '600 9px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
          ctx.textBaseline = 'middle';
          const badgeTxt = '🔇 静音';
          const btw = Math.min(mw - 6, ctx.measureText(badgeTxt).width + 8);
          ctx.fillStyle = 'rgba(39, 39, 42, 0.92)';
          ctx.beginPath();
          ctx.roundRect(mx0 + 3, yTop + padY + 2, btw, 13, 2.5);
          ctx.fill();
          ctx.fillStyle = '#e4e4e7';
          ctx.fillText(badgeTxt, mx0 + 6, yTop + padY + 8.5);
        }
        ctx.restore();
      });
    });

    // 4a-bgm. Dedicated BGM / Music Track Lane (紧凑伴奏车道：片头固定长度 + 片尾拖动截取与自动适应音量)
    if (hasBgmTrack) {
      const bgmLaneIdx = speakerTracks.length;
      const { yTop, laneH: bgmH } = getLaneBounds(bgmLaneIdx);
      const yMid = yTop + bgmH / 2;
      const maxHalfAmp = Math.max(4, bgmH * 0.40);
      const bgmColor = '#06b6d4'; // Cyan-500
      const outroColor = '#10b981'; // Emerald-500

      // Lane background
      if (bgmLaneIdx % 2 === 1) {
        ctx.fillStyle = 'rgba(6, 182, 212, 0.02)';
        ctx.fillRect(0, yTop, W, bgmH);
      }

      // Lane divider hairline
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(yTop) + 0.5);
      ctx.lineTo(W, Math.round(yTop) + 0.5);
      ctx.stroke();

      // Center 0-crossing axis
      ctx.strokeStyle = hexToRgba(bgmColor, isBgmDimmed ? 0.08 : 0.22);
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(yMid) + 0.5);
      ctx.lineTo(W, Math.round(yMid) + 0.5);
      ctx.stroke();

      const clipPadY = 2;
      const clipH = Math.max(6, bgmH - clipPadY * 2);

      // 快速判断当前时间点是否有人声在讲话（用于人声智能避让 / 自动适应音量）
      const isVoiceActiveAt = (tSec: number): boolean => {
        if (!timeline.playbackSpans || timeline.playbackSpans.length === 0) return false;
        for (let si = 0; si < timeline.playbackSpans.length; si++) {
          const sp = timeline.playbackSpans[si];
          if (tSec >= sp.editedStartSec - 0.05 && tSec <= sp.editedEndSec + 0.05) return true;
          if (sp.editedStartSec > tSec + 0.5) break;
        }
        return false;
      };

      // ----------------------------------------------------
      // A. 片头 BGM（固定长度）
      // ----------------------------------------------------
      if (hasIntroBgm && introBgmEndSec > 0) {
        const introBgmEndRatio = totalSec > 0 ? introBgmEndSec / totalSec : 0;
        const introX0 = Math.max(0, ratioToX(0));
        const introX1 = Math.min(W, ratioToX(introBgmEndRatio));
        const introClipW = introX1 - introX0;

        if (introClipW > 2 && introBgmEndRatio >= viewStartRatio) {
          ctx.save();
          // Clip background
          ctx.fillStyle = hexToRgba(bgmColor, isIntroDimmed ? 0.015 : 0.06);
          ctx.beginPath();
          ctx.roundRect(introX0, yTop + clipPadY, introClipW, clipH, 4);
          ctx.fill();

          ctx.strokeStyle = hexToRgba(bgmColor, isIntroDimmed ? 0.10 : 0.35);
          ctx.lineWidth = 0.85;
          ctx.stroke();

          // Top accent
          if (!isIntroDimmed && introClipW > 6) {
            ctx.fillStyle = hexToRgba(bgmColor, 0.55);
            ctx.beginPath();
            ctx.roundRect(introX0 + 0.5, yTop + clipPadY, introClipW - 1, 1.5, [3, 3, 0, 0]);
            ctx.fill();
          }

          // Badge: 片头固定长度
          if (introClipW >= 80 && bgmH >= 22) {
            ctx.font = '600 9px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
            ctx.fillStyle = isIntroDimmed ? '#a1a1aa' : '#67e8f9';
            ctx.fillText(
              `🎬 片头 BGM · 固定 ${introBgmEndSec.toFixed(1)}s (智能避让)`,
              introX0 + 6,
              yTop + clipPadY + 9
            );
          }

          // Sample & draw intro waveform
          const fadeInSec = (state.introBgm?.fadeInMs ?? 800) / 1000;
          const fadeOutSec = (state.introBgm?.fadeOutMs ?? 800) / 1000;
          const introPeaks = state.introBgm?.peaks ?? [];
          const hasPeaks = introPeaks.length >= 16;

          ctx.strokeStyle = hexToRgba(bgmColor, isIntroDimmed ? 0.16 : 0.40);
          ctx.lineWidth = 0.85;
          ctx.beginPath();
          for (let x = Math.max(0, introX0); x <= Math.min(W, introX1); x += stepPx) {
            const normR = Math.max(0, Math.min(1, xToRatio(x)));
            const tSec = normR * totalSec;
            if (tSec > introBgmEndSec) break;

            let fadeFactor = 1.0;
            if (fadeInSec > 0 && tSec < fadeInSec) {
              fadeFactor = Math.sin((Math.max(0, tSec / fadeInSec) * Math.PI) / 2);
            }
            if (fadeOutSec > 0 && tSec > introBgmEndSec - fadeOutSec) {
              fadeFactor = Math.min(
                fadeFactor,
                Math.sin((Math.max(0, (introBgmEndSec - tSec) / fadeOutSec) * Math.PI) / 2)
              );
            }

            // 片头闪避：金句与口播发声时压低
            let duckFactor = 1.0;
            if (state.coldOpenEnabled && timeline.coldOpenDurationSec > 0 && tSec < timeline.coldOpenDurationSec) {
              duckFactor = tSec >= 2.0 ? 0.20 : 0.85;
            } else if (isVoiceActiveAt(tSec)) {
              duckFactor = 0.22;
            }

            const gain = fadeFactor * duckFactor;
            let ampNorm = 0;
            if (hasPeaks) {
              const pIdx = Math.min(
                introPeaks.length - 1,
                Math.max(0, Math.floor(normR * introPeaks.length))
              );
              ampNorm = introPeaks[pIdx] * gain;
            } else {
              const kick = 0.55 + 0.35 * Math.abs(Math.sin(tSec * 4.5 * Math.PI));
              ampNorm = 0.45 * kick * gain;
            }
            const ampPx = ampNorm * maxHalfAmp;
            if (ampPx > 0.4) {
              const xa = Math.round(x) + 0.5;
              ctx.moveTo(xa, yMid - ampPx);
              ctx.lineTo(xa, yMid + ampPx);
            }
          }
          ctx.stroke();
          ctx.restore();
        }
      }

      // ----------------------------------------------------
      // B. 片尾 BGM（保留片尾视图设置的起止位置，支持提前人声结束或延后收尾）
      // ----------------------------------------------------
      if (hasOutroBgm && outroStartSec < outroEndSec) {
        const outroStartRatio = totalSec > 0 ? outroStartSec / totalSec : 0;
        const outroEndRatio = totalSec > 0 ? Math.min(1.0, outroEndSec / totalSec) : 1.0;
        const outroX0 = Math.max(0, ratioToX(outroStartRatio));
        const outroX1 = Math.min(W, ratioToX(outroEndRatio));
        const outroClipW = outroX1 - outroX0;

        if (outroClipW > 2 && viewEndRatio >= outroStartRatio && viewStartRatio <= outroEndRatio) {
          ctx.save();
          // Clip background with Emerald/Cyan glow
          ctx.fillStyle = hexToRgba(outroColor, isOutroDimmed ? 0.02 : 0.07);
          ctx.beginPath();
          ctx.roundRect(outroX0, yTop + clipPadY, outroClipW, clipH, 4);
          ctx.fill();

          ctx.strokeStyle = hexToRgba(outroColor, isOutroDimmed ? 0.12 : 0.45);
          ctx.lineWidth = 1;
          ctx.stroke();

          // Top emerald accent line
          if (!isOutroDimmed && outroClipW > 6) {
            ctx.fillStyle = hexToRgba(outroColor, 0.65);
            ctx.beginPath();
            ctx.roundRect(outroX0 + 0.5, yTop + clipPadY, outroClipW - 1, 1.5, [3, 3, 0, 0]);
            ctx.fill();
          }

          // Sample & draw outro waveform with Auto-Ducking (自动适应音量)
          const outroFadeInSec = (state.outroBgm?.fadeInMs ?? 1000) / 1000;
          const outroFadeOutSec = (state.outroBgm?.fadeOutMs ?? 2000) / 1000;
          const outroPeaks = state.outroBgm?.peaks ?? [];
          const hasOutroPeaks = outroPeaks.length >= 16;

          ctx.strokeStyle = hexToRgba(outroColor, isOutroDimmed ? 0.18 : 0.48);
          ctx.lineWidth = 0.85;
          ctx.beginPath();
          for (let x = Math.max(0, outroX0); x <= Math.min(W, outroX1); x += stepPx) {
            const normR = Math.max(0, Math.min(1, xToRatio(x)));
            const tSec = normR * totalSec;
            if (tSec < outroStartSec || tSec > outroEndSec) continue;

            // 淡入淡出包络
            let fadeFactor = 1.0;
            if (tSec - outroStartSec < outroFadeInSec) {
              fadeFactor = Math.sin((Math.max(0, (tSec - outroStartSec) / Math.max(0.05, outroFadeInSec)) * Math.PI) / 2);
            }
            if (outroEndSec - outroStartSec > outroFadeOutSec && tSec > outroEndSec - outroFadeOutSec) {
              fadeFactor = Math.min(
                fadeFactor,
                Math.sin((Math.max(0, (outroEndSec - tSec) / Math.max(0.05, outroFadeOutSec)) * Math.PI) / 2)
              );
            }

            // 自动适应音量：有人声说话时避让 (-14dB, 0.20)，人声停止/结语完后自然浮起 (0.95)
            const voiceActive = isVoiceActiveAt(tSec);
            const duckFactor = voiceActive ? 0.20 : 0.95;

            const totalGain = fadeFactor * duckFactor;
            let ampNorm = 0;
            if (hasOutroPeaks) {
              const pIdx = Math.min(
                outroPeaks.length - 1,
                Math.max(
                  0,
                  Math.floor(
                    ((tSec - outroStartSec) / Math.max(0.5, effectiveOutroDurationSec)) *
                      outroPeaks.length
                  )
                )
              );
              ampNorm = outroPeaks[pIdx] * totalGain;
            } else {
              const chord = 0.58 + 0.32 * Math.cos(tSec * 2.2 * Math.PI);
              ampNorm = 0.46 * chord * totalGain;
            }

            const ampPx = ampNorm * maxHalfAmp;
            if (ampPx > 0.3) {
              const xa = Math.round(x) + 0.5;
              ctx.moveTo(xa, yMid - ampPx);
              ctx.lineTo(xa, yMid + ampPx);
            }
          }
          ctx.stroke();

          // Badge: 片尾 BGM 与自动适应音量
          if (outroClipW >= 90 && bgmH >= 22) {
            ctx.font = '600 9px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
            ctx.fillStyle = isOutroDimmed ? '#a1a1aa' : '#34d399';
            ctx.fillText(
              `🎵 片尾 BGM · 截取 ${effectiveOutroDurationSec.toFixed(1)}s`,
              outroX0 + 10,
              yTop + clipPadY + 9
            );

            if (outroClipW >= 220) {
              ctx.fillStyle = '#6ee7b7';
              ctx.fillText('🎚️ 自动适应音量 (人声避让➔结尾浮起)', outroX0 + 130, yTop + clipPadY + 9);
            }
          }

          // ----------------------------------------------------
          // C. 拖拽截取手柄 (Trim Handle on the Left Edge)
          // ----------------------------------------------------
          const isHandleHovered = hoverZoneRef.current === 'outro_trim_handle';
          const handleW = 6;
          const handleX = Math.round(outroX0) - 2;

          ctx.fillStyle = isHandleHovered || outroTrimDragging ? '#34d399' : '#059669';
          ctx.beginPath();
          ctx.roundRect(handleX, yTop + clipPadY, handleW, clipH, 2.5);
          ctx.fill();

          ctx.strokeStyle = '#6ee7b7';
          ctx.lineWidth = 1;
          ctx.stroke();

          // Handle double vertical grab lines
          ctx.fillStyle = '#064e3b';
          ctx.fillRect(handleX + 1.5, yTop + clipPadY + clipH / 2 - 4, 1, 8);
          ctx.fillRect(handleX + 3.5, yTop + clipPadY + clipH / 2 - 4, 1, 8);

          ctx.restore();
        }
      }

      // ----------------------------------------------------
      // D. 正在拖拽截取时的全局参考虚线与时间标签
      // ----------------------------------------------------
      if (outroTrimDragging || (hoverZoneRef.current === 'outro_trim_handle' && !dragging)) {
        const trimX = Math.round(ratioToX(outroStartSec / totalSec)) + 0.5;
        if (trimX >= 0 && trimX <= W) {
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = '#34d399';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(trimX, RULER_H);
          ctx.lineTo(trimX, H);
          ctx.stroke();
          ctx.setLineDash([]);

          // Floating tooltip badge
          const label = `✂️ 截取片尾 BGM: ${effectiveOutroDurationSec.toFixed(1)}s (从 ${formatMmSs(outroStartSec)} 渐入 · 自动适应音量)`;
          ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
          const lw = ctx.measureText(label).width;
          const lx = Math.max(4, Math.min(W - lw - 12, trimX + 6));
          const ly = Math.max(RULER_H + 4, yTop - 18);

          ctx.fillStyle = 'rgba(6, 78, 59, 0.92)';
          ctx.beginPath();
          ctx.roundRect(lx, ly, lw + 12, 16, 3);
          ctx.fill();
          ctx.strokeStyle = '#34d399';
          ctx.lineWidth = 1;
          ctx.stroke();

          ctx.fillStyle = '#ecfdf5';
          ctx.fillText(label, lx + 6, ly + 9);
          ctx.restore();
        }
      }
    }

    // 4b. High-Zoom Precision Word Boundaries, Silence Labels & Ripple-Cut Seam Indicators (visibleSec <= 45s)
    if (visibleSec <= 45 && timeline.mappedTokens.length > 0) {
      const viewStartSec = viewStartRatio * totalSec;
      const viewEndSec = viewEndRatio * totalSec;
      const laneIndexBySpeaker = new Map<string, number>();
      speakerTracks.forEach((tr, idx) => laneIndexBySpeaker.set(tr.id, idx));
      const rightSafeX = laneH >= 58 && W >= 240 ? W - 28 : W - 3;

      // Binary search first mapped token intersecting [viewStartSec, viewEndSec]
      const arr = timeline.mappedTokens;
      let lo = 0;
      let hi = arr.length - 1;
      let startIdx = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid].editedEndSec < viewStartSec) {
          lo = mid + 1;
          startIdx = lo;
        } else {
          hi = mid - 1;
        }
      }

      let lastCutSeamX = -999;
      const lastWordPillRightByLane = new Float64Array(speakerTracks.length).fill(-999);
      ctx.save();

      // 剪辑处标注（贯穿虚线 + 交叉淡化包络 + 顶部「✂️ 剪辑」胶囊，可通过工具栏开关切换显示）
      cutBadgeHitBoxesRef.current = [];
      let lastCutBadgeRightX = -999;
      if (showCutMarkers) {
        timelineZones.cutSeams.forEach((seam) => {
          if (seam.ratio < viewStartRatio || seam.ratio > viewEndRatio) return;
          const sx = ratioToX(seam.ratio);
          const halfSeamPx = Math.max(
            2,
            Math.min(28, ((0.036 / 2) / Math.max(0.05, visibleSec)) * W)
          );
          ctx.save();
          ctx.strokeStyle = 'rgba(52, 211, 153, 0.72)';
          ctx.lineWidth = 1.15;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(sx, RULER_H + 1);
          ctx.lineTo(sx, H - 1);
          ctx.stroke();
          ctx.setLineDash([]);

          if (visibleSec <= 45) {
            ctx.fillStyle = 'rgba(16, 185, 129, 0.10)';
            ctx.fillRect(sx - halfSeamPx, RULER_H + 1, halfSeamPx * 2, BODY_H - 2);
            const envBot = H - 3;
            const envTop = Math.max(RULER_H + 4, H - Math.min(16, BODY_H - 4));
            ctx.strokeStyle = 'rgba(110, 231, 183, 0.78)';
            ctx.lineWidth = 1.1;
            ctx.beginPath();
            ctx.moveTo(sx - halfSeamPx, envTop);
            ctx.quadraticCurveTo(sx, envTop, sx + halfSeamPx, envBot);
            ctx.moveTo(sx - halfSeamPx, envBot);
            ctx.quadraticCurveTo(sx, envTop, sx + halfSeamPx, envTop);
            ctx.stroke();
          }

          if (sx >= 6 && sx <= W - 18 && sx > lastCutBadgeRightX + 6) {
            const cutLabel = visibleSec <= 45 ? '✂️ 剪辑' : '✂️';
            ctx.font = '600 9px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
            const lw = ctx.measureText(cutLabel).width;
            const pillW = lw + 8;
            const pillH = 14;
            const px = Math.min(W - pillW - 4, Math.max(2, sx - pillW / 2));
            const py = RULER_H + 3;
            ctx.fillStyle = 'rgba(6, 78, 59, 0.90)';
            ctx.beginPath();
            ctx.roundRect(px, py, pillW, pillH, 3);
            ctx.fill();
            ctx.strokeStyle = 'rgba(52, 211, 153, 0.75)';
            ctx.lineWidth = 0.75;
            ctx.stroke();
            ctx.fillStyle = '#a7f3d0';
            ctx.textBaseline = 'middle';
            ctx.fillText(cutLabel, px + 4, py + pillH / 2 + 0.5);
            lastCutBadgeRightX = px + pillW;
            cutBadgeHitBoxesRef.current.push({
              x1: px - 2,
              y1: py - 2,
              x2: px + pillW + 2,
              y2: py + pillH + 2,
              editedSec: seam.editedSec,
            });
          }
          ctx.restore();
        });
      }

      for (let k = Math.max(0, startIdx - 1); k < arr.length; k++) {
        const m = arr[k];
        if (m.editedStartSec > viewEndSec) break;
        if (m.editedEndSec < viewStartSec) continue;

        if (m.token.deleted) {
          if (showCutMarkers) {
            const cutX = Math.round(ratioToX(m.editedStartSec / totalSec)) + 0.5;
            if (cutX >= 0 && cutX <= W && Math.abs(cutX - lastCutSeamX) >= 6) {
              lastCutSeamX = cutX;
              ctx.save();
              ctx.setLineDash([2, 3]);
              ctx.strokeStyle = 'rgba(34, 211, 238, 0.55)';
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(cutX, RULER_H);
              ctx.lineTo(cutX, H);
              ctx.stroke();
              if (cutX >= 6 && cutX <= W - 18 && cutX > lastCutBadgeRightX + 6) {
                const cutLabel = '✂️';
                ctx.font = '600 9px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
                const lw = ctx.measureText(cutLabel).width;
                const pillW = lw + 6;
                const pillH = 14;
                const px = Math.min(W - pillW - 4, Math.max(2, cutX - pillW / 2));
                const py = RULER_H + 3;
                ctx.fillStyle = 'rgba(8, 51, 68, 0.88)';
                ctx.beginPath();
                ctx.roundRect(px, py, pillW, pillH, 3);
                ctx.fill();
                ctx.strokeStyle = 'rgba(34, 211, 238, 0.65)';
                ctx.lineWidth = 0.75;
                ctx.stroke();
                ctx.fillStyle = '#a5f3fc';
                ctx.textBaseline = 'middle';
                ctx.fillText(cutLabel, px + 3, py + pillH / 2 + 0.5);
                lastCutBadgeRightX = px + pillW;
                cutBadgeHitBoxesRef.current.push({
                  x1: px - 2,
                  y1: py - 2,
                  x2: px + pillW + 2,
                  y2: py + pillH + 2,
                  editedSec: m.editedStartSec,
                });
              }
              ctx.restore();
            }
          }
          continue;
        }

        const x0 = ratioToX(m.editedStartSec / totalSec);
        const x1 = ratioToX(m.editedEndSec / totalSec);
        const tokW = x1 - x0;
        if (tokW < 4) continue;

        if (m.token.type === 'silence') {
          if ((wordTimelineMode || visibleSec <= 28) && tokW >= 38 && laneH >= 46) {
            const silLaneIdx = laneIndexBySpeaker.get(m.speakerId) ?? 0;
            const ySilTop = RULER_H + silLaneIdx * laneH;
            const silY = ySilTop + laneH - 17;
            const cx = Math.max(20, Math.min(rightSafeX - 18, (Math.max(0, x0) + Math.min(W, x1)) / 2));
            const silLabel =
              m.token.durationSec < 1
                ? `⏸ ${Math.round(m.token.durationSec * 1000)}ms`
                : `⏸ ${m.token.durationSec.toFixed(2)}s`;
            ctx.font = '500 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.textBaseline = 'middle';
            const stw = ctx.measureText(silLabel).width;
            if (stw + 8 <= tokW) {
              ctx.fillStyle = 'rgba(24, 24, 27, 0.84)';
              ctx.beginPath();
              ctx.roundRect(cx - (stw + 8) / 2, silY, stw + 8, 14, 3);
              ctx.fill();
              ctx.fillStyle = 'rgba(161, 161, 170, 0.9)';
              ctx.fillText(silLabel, cx - stw / 2, silY + 7);
            }
          }
          continue;
        }
      }

      // Word/Character ticks & collision-free pills inside track lanes at >=100x, else phrase captions
      if (wordTimelineMode) {
        for (let idx = 0; idx < visibleWordAnnotations.length; idx++) {
          const ann = visibleWordAnnotations[idx];
          const spLaneIdx = laneIndexBySpeaker.get(ann.speakerId);
          if (spLaneIdx === undefined || spLaneIdx < 0 || spLaneIdx >= speakerTracks.length) {
            continue;
          }
          const yLaneTop = RULER_H + spLaneIdx * laneH;
          const x0 = ratioToX(ann.editedStartSec / totalSec);
          const x1 = ratioToX(ann.editedEndSec / totalSec);

          if (x0 >= 0 && x0 <= W) {
            ctx.save();
            if (ann.isSubCharSplit) {
              ctx.setLineDash([2, 2]);
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
            } else {
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
            }
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(x0) + 0.5, yLaneTop + 4);
            ctx.lineTo(Math.round(x0) + 0.5, yLaneTop + laneH - 4);
            ctx.stroke();
            ctx.restore();
          }

          if (laneH >= 40) {
            const clippedLeft = Math.max(2, x0 + 2, lastWordPillRightByLane[spLaneIdx] + 2);
            const spanReachX = Math.max(x0 + 4, x1 - 4);
            const availW = rightSafeX - clippedLeft;
            if (clippedLeft < spanReachX && availW >= 12) {
              const rawTxt = ann.isSubwordTrimmed ? `${ann.text}⚡` : ann.text;
              ctx.save();
              ctx.font = '600 11.5px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
              ctx.textBaseline = 'middle';
              const tWidth = ctx.measureText(rawTxt).width;
              const pillW = Math.min(availW, tWidth + 8);
              ctx.beginPath();
              ctx.rect(clippedLeft - 1, yLaneTop + 2, pillW + 2, 18);
              ctx.clip();
              ctx.fillStyle = 'rgba(9, 9, 11, 0.84)';
              ctx.beginPath();
              ctx.roundRect(clippedLeft, yLaneTop + 3, pillW, 16.5, 3.5);
              ctx.fill();
              ctx.fillStyle = ann.isFiller ? '#fde68a' : '#f4f4f5';
              ctx.fillText(rawTxt, clippedLeft + 4, yLaneTop + 11.5);
              ctx.restore();
              lastWordPillRightByLane[spLaneIdx] = clippedLeft + pillW;
              renderedWordPillsRef.current.push({
                speakerId: ann.speakerId,
                startSec: ann.editedStartSec,
                endSec: ann.editedEndSec,
                x: clippedLeft,
                y: yLaneTop + 3,
                w: pillW,
                h: 16.5,
                text: rawTxt,
                trackColor: speakerTracks[spLaneIdx]?.color ?? '#fbbf24',
              });
            }
          }
        }
      } else if (laneH >= 40) {
        ctx.font = '500 12px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
        ctx.textBaseline = 'middle';
        speakerTracks.forEach((tr, spIdx) => {
          const captions = timelineZones.clipCaptionsBySpeaker[tr.id] ?? [];
          const yLaneTop = RULER_H + spIdx * laneH;
          let lastCapRightX = -999;
          captions.forEach((cap) => {
            if (cap.r2 < viewStartRatio || cap.r1 > viewEndRatio) return;
            const x0 = Math.max(2, ratioToX(cap.r1), lastCapRightX + 4);
            const x1 = Math.min(rightSafeX, ratioToX(cap.r2));
            const availW = x1 - x0;
            if (availW < 44) return;

            ctx.save();
            const measuredW = ctx.measureText(cap.text).width;
            const pillW = Math.min(availW - 2, measuredW + 12);
            ctx.beginPath();
            ctx.rect(x0, yLaneTop + 2, pillW + 2, 18);
            ctx.clip();
            ctx.fillStyle = 'rgba(9, 9, 11, 0.82)';
            ctx.beginPath();
            ctx.roundRect(x0 + 1, yLaneTop + 3, pillW, 16.5, 3.5);
            ctx.fill();
            ctx.strokeStyle = hexToRgba(tr.color, 0.42);
            ctx.lineWidth = 0.75;
            ctx.stroke();
            ctx.fillStyle = '#f4f4f5';
            ctx.fillText(cap.text, x0 + 6, yLaneTop + 11.5);
            ctx.restore();
            lastCapRightX = x0 + 1 + pillW;
            renderedCaptionPillsRef.current.push({
              speakerId: tr.id,
              r1: cap.r1,
              r2: cap.r2,
              x: x0 + 1,
              y: yLaneTop + 3,
              w: pillW,
              h: 16.5,
              text: cap.text,
              tokens: cap.tokens,
              trackColor: tr.color,
            });
          });
        });
      }

      ctx.restore();
    }

    // 5. Bleep Redaction Caution Bands
    timelineZones.bleepRanges.forEach(([r1, r2]) => {
      if (r2 < viewStartRatio || r1 > viewEndRatio) return;
      const bx0 = Math.max(0, ratioToX(r1));
      const bx1 = Math.min(W, ratioToX(r2));
      const bw = Math.max(8, bx1 - bx0);

      ctx.fillStyle = 'rgba(245, 158, 11, 0.22)';
      ctx.fillRect(bx0, RULER_H, bw, BODY_H);
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.65)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx0 + 0.5, RULER_H + 0.5, Math.max(1, bw - 1), BODY_H - 1);

      ctx.fillStyle = 'rgba(180, 83, 9, 0.9)';
      ctx.beginPath();
      ctx.roundRect(bx0, topBadgeY, Math.max(bw, 42), topBadgeH, wordTimelineMode ? 3 : 3.5);
      ctx.fill();
      ctx.fillStyle = '#fef3c7';
      ctx.font = wordTimelineMode
        ? '600 8.5px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
        : '600 9.5px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('🚨消音', bx0 + 4, topBadgeCenterY);
    });

    ctx.restore();
  }, [
    canvasMetrics,
    speakerTracks,
    trackCalibrations,
    anySolo,
    state.loudnessAligned,
    state.autoSoloMode,
    state.duckAttenuationDb,
    state.recordingMode,
    state.coldOpenEnabled,
    state.highlights,
    timeline,
    timelineZones,
    totalSec,
    zoom,
    viewStartRatio,
    wordTimelineMode,
    rulerHeightPx,
    visibleWordAnnotations,
    showCutMarkers,
  ]);

  const minDragRatioSpan = Math.max(0.01 / totalSec, 0.004 / zoom);
  const hasValidRange =
    selStartRatio !== null &&
    selEndRatio !== null &&
    Math.abs(selEndRatio - selStartRatio) > minDragRatioSpan;

  const rangeStartSec = hasValidRange ? Math.min(selStartRatio!, selEndRatio!) * totalSec : 0;
  const rangeEndSec = hasValidRange ? Math.max(selStartRatio!, selEndRatio!) * totalSec : 0;
  const rangeSpanSec = rangeEndSec - rangeStartSec;

  useEffect(() => {
    const prevMode = prevSelectionModeRef.current;
    prevSelectionModeRef.current = selectionMode;
    if (prevMode !== 'snap' && selectionMode === 'snap' && hasValidRange && totalSec > 0) {
      const [snappedStartSec, snappedEndSec] = snapRangeToWordGaps(
        rangeStartSec,
        rangeEndSec,
        wordGapSnapPoints,
        minDragRatioSpan * totalSec
      );
      setSelStartRatio(snappedStartSec / totalSec);
      setSelEndRatio(snappedEndSec / totalSec);
    }
  }, [selectionMode, hasValidRange, totalSec, rangeStartSec, rangeEndSec, wordGapSnapPoints, minDragRatioSpan]);
  const effectiveTargetLaneIdx = hoverLaneIdx ?? selLaneIdx;
  const targetTrack = speakerTracks[effectiveTargetLaneIdx] ?? speakerTracks[selLaneIdx];

  const selectedTokensSpanSec = useMemo<{ startSec: number; endSec: number } | null>(() => {
    if (!selectedTokenIds || selectedTokenIds.size === 0) return null;
    let minS = Number.POSITIVE_INFINITY;
    let maxE = 0;
    for (const m of timeline.mappedTokens) {
      if (!m.token.deleted && selectedTokenIds.has(m.tokenId)) {
        minS = Math.min(minS, m.editedStartSec);
        maxE = Math.max(maxE, m.editedEndSec);
      }
    }
    return Number.isFinite(minS) && maxE > minS + 0.01 ? { startSec: minS, endSec: maxE } : null;
  }, [selectedTokenIds, timeline.mappedTokens]);

  const canHoverMuteSelectedTokens =
    hoverLaneIdx !== null && Boolean(speakerTracks[hoverLaneIdx]) && Boolean(selectedTokensSpanSec);

  const triggerRangeOp = (
    op: 'ripple_all' | 'mute_lane' | 'bleep_range' | 'add_highlight' | 'cancel_ducking',
    trackIdOverride?: string
  ) => {
    if (!hasValidRange) return;
    onWaveformCutAction(rangeStartSec, rangeEndSec, op, trackIdOverride ?? targetTrack?.id);
    setSelStartRatio(null);
    setSelEndRatio(null);
  };

  const isRangeAllFullVolume = useMemo(() => {
    if (!hasValidRange) return false;
    const selStart = Math.min(rangeStartSec, rangeEndSec);
    const selEnd = Math.max(rangeStartSec, rangeEndSec);
    const matchedOverlaps = timeline.overlapRegions.filter(
      (ov) => ov.editedEndSec > selStart + 0.01 && ov.editedStartSec < selEnd - 0.01
    );
    const overlappingTokens = timeline.mappedTokens.filter(
      (m) =>
        !m.token.deleted &&
        m.editedEndSec > selStart + 0.01 &&
        m.editedStartSec < selEnd - 0.01
    );
    const overlappingBlockIds = new Set(
      overlappingTokens.map((m) => m.blockId).filter(Boolean)
    );
    const relevantBlocks = state.blocks.filter(
      (b) =>
        overlappingBlockIds.has(b.blockId) ||
        matchedOverlaps.some((ov) => ov.blockId === b.blockId)
    );
    return (
      relevantBlocks.length > 0 &&
      relevantBlocks.every((b) => Boolean(b.overlapNote?.keepFullVolume))
    );
  }, [hasValidRange, rangeStartSec, rangeEndSec, timeline.overlapRegions, timeline.mappedTokens, state.blocks]);

  const isSelectedTokensAllFullVolume = useMemo(() => {
    if (!selectedTokenIds || selectedTokenIds.size === 0) return false;
    const selTokens = timeline.mappedTokens.filter(
      (m) => !m.token.deleted && selectedTokenIds.has(m.tokenId)
    );
    const blockIds = new Set(selTokens.map((m) => m.blockId).filter(Boolean));
    const relevantBlocks = state.blocks.filter((b) => blockIds.has(b.blockId));
    return (
      relevantBlocks.length > 0 &&
      relevantBlocks.every((b) => Boolean(b.overlapNote?.keepFullVolume))
    );
  }, [selectedTokenIds, timeline.mappedTokens, state.blocks]);

  waveformKeyActionsRef.current = {
    hasValidRange,
    rangeStartSec,
    rangeEndSec,
    isPlaying,
    canHoverMuteSelectedTokens,
    cutSelection: () => triggerRangeOp('ripple_all'),
    muteHoveredSelection: () => triggerRangeOp('mute_lane', targetTrack?.id),
    muteHoveredSelectedTokens: () => {
      if (hoverLaneIdx === null || !selectedTokensSpanSec) return;
      const hoverTrack = speakerTracks[hoverLaneIdx];
      if (!hoverTrack) return;
      onWaveformCutAction(
        selectedTokensSpanSec.startSec,
        selectedTokensSpanSec.endSec,
        'mute_lane',
        hoverTrack.id
      );
    },
    bleepSelection: () => triggerRangeOp('bleep_range'),
    clearSelection: () => {
      setSelStartRatio(null);
      setSelEndRatio(null);
    },
  };

  const trackMetaBySpeakerId = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    state.tracks.forEach((t) => {
      map.set(t.id, { name: t.name, color: t.color });
    });
    return map;
  }, [state.tracks]);

  const {
    speakerDeckTurns,
    startSecByFlatIndex,
    turnIdxByTokenId,
    turnIdxByBlockId,
    turnsAreMonotonic,
  } = useMemo<{
    speakerDeckTurns: SpeakerDeckTurn[];
    startSecByFlatIndex: Map<number, number>;
    turnIdxByTokenId: Map<string, number>;
    turnIdxByBlockId: Map<string, number>;
    turnsAreMonotonic: boolean;
  }>(() => {
    const flatIndexByTokenId = new Map<string, number>();
    let idxCounter = 0;
    state.blocks.forEach((b) => {
      b.tokens.forEach((t) => {
        flatIndexByTokenId.set(t.id, idxCounter++);
      });
    });

    const secMap = new Map<number, number>();
    const mappedByTokenId = new Map<string, MappedTokenTimeline>();
    timeline.mappedTokens.forEach((m) => {
      mappedByTokenId.set(m.token.id, m);
      const fIdx = flatIndexByTokenId.get(m.token.id);
      if (fIdx !== undefined) {
        secMap.set(fIdx, m.editedStartSec);
      }
    });

    const tokIdxMap = new Map<string, number>();
    const blkIdxMap = new Map<string, number>();

    if (!isMainStage) {
      return {
        speakerDeckTurns: [],
        startSecByFlatIndex: secMap,
        turnIdxByTokenId: tokIdxMap,
        turnIdxByBlockId: blkIdxMap,
        turnsAreMonotonic: true,
      };
    }

    const rawCoalesced = coalesceChronologicalBlocks(state.blocks);
    const coalesced =
      deckFlowMode === 'horizontal'
        ? mergeCompactDeckTurnGroups(rawCoalesced, mappedByTokenId)
        : rawCoalesced;
    const turns: SpeakerDeckTurn[] = [];
    const overlapRegions = timeline.overlapRegions ?? [];

    coalesced.forEach((grp) => {
      const tokens: Array<{ mapped: MappedTokenTimeline; flatIndex: number }> = [];
      const allWordTokenIds: string[] = [];
      const blockIdSet = new Set(grp.blocks.map((b) => b.blockId));
      const previewParts: string[] = [];
      let previewPrevAscii = false;

      grp.blocks.forEach((b, blkIdx) => {
        let blockAddedVisible = false;
        b.tokens.forEach((t) => {
          if (t.deleted) return;
          allWordTokenIds.push(t.id);
          if (t.bleeped) {
            previewParts.push(' 🚨消音');
            previewPrevAscii = false;
          } else if (t.type !== 'silence') {
            if (
              !blockAddedVisible &&
              blkIdx > 0 &&
              previewParts.length > 0 &&
              !/[，。？！、；：,.?!;:）》」』\]\)”’…—\s]$/.test(
                previewParts[previewParts.length - 1]
              )
            ) {
              const prevTokMapped = tokens.length > 0 ? tokens[tokens.length - 1].mapped : null;
              const curTokMapped = mappedByTokenId.get(t.id);
              if (
                prevTokMapped &&
                curTokMapped &&
                curTokMapped.editedStartSec - prevTokMapped.editedEndSec >= 0.35
              ) {
                previewParts.push(' ');
              }
            } else if (previewPrevAscii && /^[A-Za-z0-9]/.test(t.text)) {
              previewParts.push(' ');
            }
            previewParts.push(t.text);
            previewPrevAscii = /[A-Za-z0-9]$/.test(t.text);
            blockAddedVisible = true;
          }
          if (t.type === 'silence' && t.durationSec < 0.55 && !t.mouthClickCleaned) return;
          const mapped = mappedByTokenId.get(t.id);
          if (!mapped) return;
          tokens.push({
            mapped,
            flatIndex: flatIndexByTokenId.get(t.id) ?? 0,
          });
        });
      });

      if (tokens.length === 0) return;

      const editedStartSec = tokens[0].mapped.editedStartSec;
      const editedEndSec = tokens[tokens.length - 1].mapped.editedEndSec;
      const spMeta = trackMetaBySpeakerId.get(grp.speakerId);
      const chapterTitle = grp.blocks[0]?.chapterTitle ?? '';
      const previewText = previewParts.join('');

      const overlaps = overlapRegions.filter(
        (ov) =>
          blockIdSet.has(ov.blockId) ||
          (ov.editedEndSec > editedStartSec + 0.02 && ov.editedStartSec < editedEndSec - 0.02)
      );

      const horizontalWidthPx = computeHorizontalDeckCardWidthPx(
        previewText,
        overlaps.length > 0
      );

      const turnIndex = turns.length;
      grp.blocks.forEach((b) => {
        blkIdxMap.set(b.blockId, turnIndex);
        b.tokens.forEach((t) => {
          if (!t.deleted) tokIdxMap.set(t.id, turnIndex);
        });
      });

      turns.push({
        turnKey: grp.groupKey,
        blockIds: grp.blocks.map((b) => b.blockId),
        speakerId: grp.speakerId,
        speakerName: spMeta?.name ?? grp.speakerId,
        speakerColor: spMeta?.color ?? '#3b82f6',
        chapterTitle,
        coalescedAcrossCut: grp.coalescedAcrossCut,
        editedStartSec,
        editedEndSec,
        previewText,
        horizontalWidthPx,
        tokens,
        allWordTokenIds,
        overlaps,
      });
    });

    let monotonic = true;
    for (let i = 1; i < turns.length; i++) {
      if (
        turns[i].editedStartSec < turns[i - 1].editedStartSec ||
        turns[i].editedEndSec < turns[i - 1].editedEndSec
      ) {
        monotonic = false;
        break;
      }
    }

    return {
      speakerDeckTurns: turns,
      startSecByFlatIndex: secMap,
      turnIdxByTokenId: tokIdxMap,
      turnIdxByBlockId: blkIdxMap,
      turnsAreMonotonic: monotonic,
    };
  }, [
    isMainStage,
    deckFlowMode,
    state.blocks,
    timeline.mappedTokens,
    timeline.overlapRegions,
    trackMetaBySpeakerId,
  ]);

  const selectedTokensByTurn = useMemo(() => {
    const map = new Map<number, Set<string>>();
    if (!selectedTokenIds || selectedTokenIds.size === 0 || turnIdxByTokenId.size === 0) {
      return map;
    }
    selectedTokenIds.forEach((id) => {
      const tIdx = turnIdxByTokenId.get(id);
      if (tIdx === undefined) return;
      let bucket = map.get(tIdx);
      if (!bucket) {
        bucket = new Set<string>();
        map.set(tIdx, bucket);
      }
      bucket.add(id);
    });
    return map;
  }, [selectedTokenIds, turnIdxByTokenId]);

  const editingTurnIdx = editingHintTokenId
    ? (turnIdxByTokenId.get(editingHintTokenId) ?? -1)
    : -1;
  const activeTokenTurnIdx = activeTokenId ? (turnIdxByTokenId.get(activeTokenId) ?? -1) : -1;

  const focusAnchorModeRef = useRef<'playhead' | 'range'>('playhead');
  const prevPlayheadForFocusRef = useRef(getEffectivePlayheadSec());
  const prevRangeKeyForFocusRef = useRef('');

  const rangeFocusKey = hasValidRange
    ? `${rangeStartSec.toFixed(3)}:${rangeEndSec.toFixed(3)}`
    : '';

  const computeFocusTurnIdx = useCallback(() => {
    const curPlayhead = getEffectivePlayheadSec();
    const playheadMovedForFocus = Math.abs(curPlayhead - prevPlayheadForFocusRef.current) > 0.002;
    const rangeChangedForFocus = rangeFocusKey !== prevRangeKeyForFocusRef.current;

    if (playheadDragging || scrubbing || isPlaying) {
      focusAnchorModeRef.current = 'playhead';
    } else if (dragging && hasValidRange) {
      focusAnchorModeRef.current = 'range';
    } else if (playheadMovedForFocus) {
      focusAnchorModeRef.current = 'playhead';
    } else if (rangeChangedForFocus && hasValidRange) {
      focusAnchorModeRef.current = 'range';
    } else if (!hasValidRange) {
      focusAnchorModeRef.current = 'playhead';
    }

    prevPlayheadForFocusRef.current = curPlayhead;
    prevRangeKeyForFocusRef.current = rangeFocusKey;
    const focusAnchorMode = focusAnchorModeRef.current;

    if (speakerDeckTurns.length === 0) return -1;

    if (focusAnchorMode === 'range' && hasValidRange) {
      const midSec = (rangeStartSec + rangeEndSec) * 0.5;
      const midIdx = findTurnIndexAtSec(speakerDeckTurns, midSec, 0, turnsAreMonotonic);
      if (midIdx >= 0) return midIdx;
      const intersectIdx = findTurnIndexIntersecting(
        speakerDeckTurns,
        rangeStartSec,
        rangeEndSec,
        turnsAreMonotonic
      );
      if (intersectIdx >= 0) return intersectIdx;
    }

    if (curPlayhead < timeline.prefixDurationSec - 0.02) {
      return -1;
    }

    if (activeTokenTurnIdx >= 0) {
      return activeTokenTurnIdx;
    }

    const activeIdx = findTurnIndexAtSec(speakerDeckTurns, curPlayhead, 0.04, turnsAreMonotonic);
    if (activeIdx >= 0) return activeIdx;

    if (activeBlockId) {
      const blkIdx = turnIdxByBlockId.get(activeBlockId);
      if (blkIdx !== undefined) return blkIdx;
    }

    return findNearestTurnIndex(speakerDeckTurns, curPlayhead, turnsAreMonotonic);
  }, [
    getEffectivePlayheadSec,
    speakerDeckTurns,
    turnsAreMonotonic,
    turnIdxByBlockId,
    rangeFocusKey,
    hasValidRange,
    rangeStartSec,
    rangeEndSec,
    playheadDragging,
    scrubbing,
    isPlaying,
    dragging,
    timeline.prefixDurationSec,
    activeBlockId,
    activeTokenTurnIdx,
  ]);

  const [focusTurnIdx, setFocusTurnIdx] = useState<number>(() => computeFocusTurnIdx());
  useEffect(() => {
    const syncFocusTurn = () => {
      const nextIdx = computeFocusTurnIdx();
      setFocusTurnIdx((prev) => (prev === nextIdx ? prev : nextIdx));
    };
    syncFocusTurn();
    return subscribePlayhead(syncFocusTurn);
  }, [computeFocusTurnIdx]);

  const focusedTurn = focusTurnIdx >= 0 ? speakerDeckTurns[focusTurnIdx] : undefined;
  const activeDeckFocusSpan =
    isMainStage && focusedTurn
      ? {
          startSec: focusedTurn.editedStartSec,
          endSec: focusedTurn.editedEndSec,
          speakerId: focusedTurn.speakerId,
        }
      : focusedBlockOverlay;

  // Layer 2: Ultra-Fast 60fps Playhead, Hover & Selection Overlay (<0.15ms GPU Blit)
  const drawOverlayCanvas = useCallback(() => {
    const playheadSec = getEffectivePlayheadSec();
    const hoverRatio = hoverRatioRef.current;
    const canvas = canvasRef.current;
    const offCanvas = baseCacheCanvasRef.current;
    if (!canvas || !offCanvas || canvasMetrics.width === 0 || canvasMetrics.height === 0) return;

    const { width: W, height: H, dpr } = canvasMetrics;
    const targetPhysW = Math.round(W * dpr);
    const targetPhysH = Math.round(H * dpr);
    if (canvas.width !== targetPhysW || canvas.height !== targetPhysH) {
      canvas.width = targetPhysW;
      canvas.height = targetPhysH;
    }

    const ctx = canvas.getContext('2d', { alpha: false }) ?? canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(offCanvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const RULER_H = rulerHeightPx;
    const topRulerBandH = wordTimelineMode ? 14 : RULER_H;
    const topBadgeY = wordTimelineMode ? 1 : 3;
    const topBadgeH = wordTimelineMode ? 12 : RULER_H - 6;
    const topBadgeCenterY = wordTimelineMode ? 7.2 : RULER_H / 2 + 0.5;
    const BODY_H = Math.max(1, H - RULER_H);
    // BGM 轨高度紧凑化：不用那么高（固定约 34px），将充足的垂直空间留给人声音轨
    const bgmLaneH = hasBgmTrack ? Math.min(BGM_LANE_COMPACT_H, Math.max(26, Math.round(BODY_H * 0.2))) : 0;
    const speakerLaneH = (BODY_H - bgmLaneH) / Math.max(1, speakerTracks.length);
    const getLaneBounds = (idx: number) => {
      if (hasBgmTrack && idx === speakerTracks.length) {
        return {
          yTop: RULER_H + speakerTracks.length * speakerLaneH,
          laneH: bgmLaneH,
        };
      }
      return {
        yTop: RULER_H + idx * speakerLaneH,
        laneH: speakerLaneH,
      };
    };
    const laneH = speakerLaneH;
    const laneCount = Math.max(1, speakerTracks.length + (hasBgmTrack ? 1 : 0));
    const visibleSpan = 1 / zoom;
    const viewEndRatio = Math.min(1, viewStartRatio + visibleSpan);
    const ratioToX = (r: number) => (r - viewStartRatio) * zoom * W;

    if (hoverLaneIdx !== null && hoverLaneIdx >= 0 && hoverLaneIdx < laneCount) {
      const { yTop: hoverYTop, laneH: hoverH } = getLaneBounds(hoverLaneIdx);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.022)';
      ctx.fillRect(0, hoverYTop, W, hoverH);
    }

    // 5b. Active / Focused Speaker-Block Lane Highlight
    if (activeDeckFocusSpan && totalSec > 0) {
      const fr1 = Math.max(0, Math.min(1, activeDeckFocusSpan.startSec / totalSec));
      const fr2 = Math.max(fr1, Math.min(1, activeDeckFocusSpan.endSec / totalSec));
      if (fr2 > fr1 && fr2 >= viewStartRatio && fr1 <= viewEndRatio) {
        const bx0 = Math.max(0, ratioToX(fr1));
        const bx1 = Math.min(W, ratioToX(fr2));
        const bw = Math.max(2, bx1 - bx0);
        const targetLaneIdx = activeDeckFocusSpan.speakerId
          ? speakerTracks.findIndex((t) => t.id === activeDeckFocusSpan.speakerId)
          : -1;
        const trackColor = targetLaneIdx >= 0 ? speakerTracks[targetLaneIdx].color : '#34d399';
        const highlightTop = targetLaneIdx >= 0 ? RULER_H + targetLaneIdx * laneH : RULER_H;
        const highlightH = targetLaneIdx >= 0 ? laneH : BODY_H;

        ctx.save();
        ctx.fillStyle = hexToRgba(trackColor, 0.085);
        ctx.fillRect(bx0, highlightTop, bw, highlightH);

        ctx.strokeStyle = hexToRgba(trackColor, 0.62);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(bx0, highlightTop + 1);
        ctx.lineTo(bx0 + bw, highlightTop + 1);
        ctx.moveTo(bx0, highlightTop + highlightH - 1);
        ctx.lineTo(bx0 + bw, highlightTop + highlightH - 1);
        const bracketH = Math.min(8, Math.max(4, highlightH * 0.22));
        if (fr1 >= viewStartRatio) {
          ctx.moveTo(bx0 + 0.5, highlightTop + 1);
          ctx.lineTo(bx0 + 0.5, highlightTop + 1 + bracketH);
          ctx.moveTo(bx0 + 0.5, highlightTop + highlightH - 1);
          ctx.lineTo(bx0 + 0.5, highlightTop + highlightH - 1 - bracketH);
        }
        if (fr2 <= viewEndRatio) {
          ctx.moveTo(bx0 + bw - 0.5, highlightTop + 1);
          ctx.lineTo(bx0 + bw - 0.5, highlightTop + 1 + bracketH);
          ctx.moveTo(bx0 + bw - 0.5, highlightTop + highlightH - 1);
          ctx.lineTo(bx0 + bw - 0.5, highlightTop + highlightH - 1 - bracketH);
        }
        ctx.stroke();
        ctx.restore();
      }
    }

    // 5c. Live Active Word/Character Highlight on >=100x Word-Annotated Ruler
    if (wordTimelineMode && visibleWordAnnotations.length > 0) {
      let lo = 0;
      let hi = visibleWordAnnotations.length - 1;
      let candidateIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (visibleWordAnnotations[mid].editedStartSec <= playheadSec) {
          candidateIdx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (candidateIdx >= 0) {
        const scanStart = Math.max(0, candidateIdx - 6);
        for (let idx = scanStart; idx <= candidateIdx; idx++) {
          const ann = visibleWordAnnotations[idx];
          if (playheadSec >= ann.editedStartSec && playheadSec <= ann.editedEndSec) {
            const ax0 = Math.max(0, ratioToX(ann.editedStartSec / totalSec));
            const ax1 = Math.min(W, ratioToX(ann.editedEndSec / totalSec));
            const aw = Math.max(3, ax1 - ax0);
            ctx.save();
            ctx.fillStyle = 'rgba(56, 189, 248, 0.16)';
            ctx.fillRect(ax0, topRulerBandH + 1, aw, RULER_H - topRulerBandH - 2);
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 1.25;
            ctx.strokeRect(
              ax0 + 0.5,
              topRulerBandH + 1,
              Math.max(1, aw - 1),
              RULER_H - topRulerBandH - 2
            );
            ctx.restore();
          }
        }
      }
    }

    // 6. Drag Range Selection Overlay (works down to 10ms / 4px at any zoom up to 2400x!)
    const minRatioSpan = Math.max(0.01 / totalSec, 0.004 / zoom);
    const visibleSecOverlay = totalSec * visibleSpan;
    if (selStartRatio !== null && selEndRatio !== null) {
      const r1 = Math.min(selStartRatio, selEndRatio);
      const r2 = Math.max(selStartRatio, selEndRatio);
      if (r2 - r1 > minRatioSpan && r2 >= viewStartRatio && r1 <= viewEndRatio) {
        const sx0 = Math.max(0, ratioToX(r1));
        const sx1 = Math.min(W, ratioToX(r2));
        const sw = Math.max(2, sx1 - sx0);
        const activeLaneIdx = Math.max(0, Math.min(laneCount - 1, hoverLaneIdx ?? selLaneIdx));
        const { yTop: activeLaneTop, laneH: activeLaneH } = getLaneBounds(activeLaneIdx);
        const activeLaneTrack = speakerTracks[activeLaneIdx];

        ctx.fillStyle = 'rgba(59, 130, 246, 0.12)';
        ctx.fillRect(sx0, RULER_H, sw, BODY_H);

        ctx.fillStyle = 'rgba(245, 158, 11, 0.18)';
        ctx.fillRect(sx0, activeLaneTop, sw, activeLaneH);

        ctx.strokeStyle = '#60a5fa';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sx0 + 0.5, RULER_H + 0.5, Math.max(1, sw - 1), BODY_H - 1);

        ctx.save();
        ctx.setLineDash([4, 2]);
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.85)';
        ctx.lineWidth = 1.25;
        ctx.strokeRect(sx0 + 1, activeLaneTop + 1, Math.max(1, sw - 2), Math.max(1, activeLaneH - 2));
        ctx.restore();

        ctx.fillStyle = '#60a5fa';
        ctx.beginPath();
        ctx.roundRect(sx0 - 1.5, RULER_H + BODY_H / 2 - 10, 3, 20, 1.5);
        ctx.roundRect(sx0 + sw - 1.5, RULER_H + BODY_H / 2 - 10, 3, 20, 1.5);
        ctx.fill();

        if (!dragging && activeLaneTrack && laneH >= 28 && sw >= 22) {
          const muteHint = `⌫ 静音 ${activeLaneTrack.name}`;
          ctx.font = '600 9.5px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
          ctx.textBaseline = 'middle';
          const mtw = ctx.measureText(muteHint).width + 10;
          const pillW = Math.min(mtw, Math.max(46, W - 8));
          const pillX = Math.max(4, Math.min(W - pillW - 4, sx0 + sw / 2 - pillW / 2));
          const pillY = activeLaneTop + Math.max(2, Math.min(laneH - 17, laneH - 18));
          ctx.fillStyle = 'rgba(24, 24, 27, 0.92)';
          ctx.beginPath();
          ctx.roundRect(pillX, pillY, pillW, 15, 3.5);
          ctx.fill();
          ctx.strokeStyle = 'rgba(251, 191, 36, 0.72)';
          ctx.lineWidth = 0.85;
          ctx.stroke();
          ctx.save();
          ctx.beginPath();
          ctx.rect(pillX + 2, pillY, Math.max(0, pillW - 4), 15);
          ctx.clip();
          ctx.fillStyle = '#fde68a';
          ctx.fillText(muteHint, pillX + 5, pillY + 7.5);
          ctx.restore();
        }

        const selSec = (r2 - r1) * totalSec;
        const durLabel =
          selSec < 1
            ? `${Math.round(selSec * 1000)}ms`
            : selSec < 10 || visibleSecOverlay <= 25
            ? `${selSec.toFixed(2)}s`
            : `${selSec.toFixed(1)}s`;
        ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textBaseline = 'middle';
        const dtw = ctx.measureText(durLabel).width;
        const badgeX = Math.max(2, Math.min(W - dtw - 12, sx0 + sw / 2 - (dtw + 10) / 2));
        ctx.fillStyle = '#2563eb';
        ctx.beginPath();
        ctx.roundRect(badgeX, topBadgeY, dtw + 10, topBadgeH, wordTimelineMode ? 3 : 4);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillText(durLabel, badgeX + 5, topBadgeCenterY);
      }
    }

    // 7. Hover Scrub / Final Cut Pro Skimmer Line & Timestamp Readout
    if (
      hoverRatio !== null &&
      !dragging &&
      hoverRatio >= viewStartRatio &&
      hoverRatio <= viewEndRatio
    ) {
      const isSkimmingVisual =
        hoverScrubEnabled && canHoverScrubAtZoom && (cmdKeyHeld || hoverScrubRateRef.current !== null);
      const hx = Math.round(ratioToX(hoverRatio)) + 0.5;
      ctx.save();
      if (isSkimmingVisual) {
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.32)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(hx, wordTimelineMode ? topRulerBandH - 0.5 : RULER_H);
        ctx.lineTo(hx, H);
        ctx.stroke();

        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 1.5;
      } else {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(244, 244, 245, 0.28)';
        ctx.lineWidth = 1;
      }
      ctx.beginPath();
      ctx.moveTo(hx, RULER_H);
      ctx.lineTo(hx, H);
      ctx.stroke();
      ctx.restore();

      const hoverSec = hoverRatio * totalSec;
      const baseLabel = formatPrecisionSec(hoverSec, visibleSecOverlay <= 15 ? 2 : 1);
      const activeSkimRate = hoverScrubRateRef.current;
      const hLabel =
        isSkimmingVisual && activeSkimRate !== null
          ? `🎧 ${baseLabel} · ${activeSkimRate.toFixed(1)}x`
          : isSkimmingVisual
            ? `⌘ ${baseLabel}`
            : baseLabel;
      ctx.font = wordTimelineMode
        ? '500 9.5px ui-monospace, SFMono-Regular, Menlo, monospace'
        : '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'middle';
      const htw = ctx.measureText(hLabel).width;
      const pillX = Math.max(2, Math.min(W - htw - 10, hx - (htw + 8) / 2));
      ctx.fillStyle = isSkimmingVisual ? 'rgba(8, 51, 68, 0.96)' : 'rgba(39, 39, 42, 0.94)';
      ctx.beginPath();
      ctx.roundRect(pillX, topBadgeY, htw + 8, topBadgeH, wordTimelineMode ? 3 : 3.5);
      ctx.fill();
      ctx.strokeStyle = isSkimmingVisual ? 'rgba(34, 211, 238, 0.85)' : 'rgba(113, 113, 122, 0.5)';
      ctx.lineWidth = isSkimmingVisual ? 1 : 0.75;
      ctx.stroke();
      ctx.fillStyle = isSkimmingVisual ? '#cffafe' : '#e4e4e7';
      ctx.fillText(hLabel, pillX + 4, topBadgeCenterY);
    }

    // 7b. Real-time Active Spoken Word Highlight Inside Speech Clips (60fps Overlay)
    const playRatioForText = totalSec > 0 ? playheadSec / totalSec : 0;
    if (wordTimelineMode && renderedWordPillsRef.current.length > 0) {
      for (let i = 0; i < renderedWordPillsRef.current.length; i++) {
        const p = renderedWordPillsRef.current[i];
        if (playheadSec < p.startSec - 0.01 || playheadSec > p.endSec + 0.015) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(p.x - 2, p.y - 2, p.w + 4, p.h + 4);
        ctx.clip();

        ctx.shadowColor = 'rgba(250, 204, 21, 0.75)';
        ctx.shadowBlur = 6;
        ctx.fillStyle = '#facc15';
        ctx.beginPath();
        ctx.roundRect(p.x, p.y, p.w, p.h, 3.5);
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#fef08a';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.font = '700 11.5px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#09090b';
        ctx.fillText(p.text, p.x + 4, p.y + p.h / 2);
        ctx.restore();
      }
    } else if (!wordTimelineMode && renderedCaptionPillsRef.current.length > 0) {
      const baseFont = '500 12px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      const boldFont = '700 12px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      for (let i = 0; i < renderedCaptionPillsRef.current.length; i++) {
        const cap = renderedCaptionPillsRef.current[i];
        if (playRatioForText < cap.r1 - 0.0005 || playRatioForText > cap.r2 + 0.0005) continue;
        if (cap.tokens.length === 0) continue;

        let activeTok = cap.tokens.find(
          (t) => playheadSec >= t.startSec - 0.015 && playheadSec <= t.endSec + 0.02
        );
        if (!activeTok) {
          for (let j = cap.tokens.length - 1; j >= 0; j--) {
            if (playheadSec >= cap.tokens[j].startSec - 0.02) {
              activeTok = cap.tokens[j];
              break;
            }
          }
        }
        if (!activeTok) continue;

        ctx.save();
        ctx.font = baseFont;
        ctx.textBaseline = 'middle';

        const prefixStr = cap.text.slice(0, activeTok.charStart);
        const activeStr = cap.text.slice(activeTok.charStart, activeTok.charEnd);
        const suffixStr = cap.text.slice(activeTok.charEnd);

        const prefixW = prefixStr ? ctx.measureText(prefixStr).width : 0;
        ctx.font = boldFont;
        const activeW = ctx.measureText(activeStr).width;
        ctx.font = baseFont;

        // Auto-pan caption text horizontally inside narrow clip pills so active word stays visible
        const shiftX = Math.max(0, prefixW + activeW + 14 - cap.w);
        const textStartX = cap.x + 5 - shiftX;
        const textMidY = cap.y + cap.h / 2;

        ctx.beginPath();
        ctx.roundRect(cap.x - 1, cap.y - 1, cap.w + 2, cap.h + 2, 4);
        ctx.clip();

        ctx.fillStyle = 'rgba(9, 9, 11, 0.95)';
        ctx.beginPath();
        ctx.roundRect(cap.x, cap.y, cap.w, cap.h, 3.5);
        ctx.fill();

        ctx.strokeStyle = hexToRgba(cap.trackColor, 0.95);
        ctx.lineWidth = 1.15;
        ctx.stroke();

        // Active word high-contrast pill background
        ctx.fillStyle = '#facc15';
        ctx.beginPath();
        ctx.roundRect(textStartX + prefixW - 2, cap.y + 1.5, activeW + 4, cap.h - 3, 2.5);
        ctx.fill();

        if (prefixStr) {
          ctx.fillStyle = 'rgba(228, 228, 231, 0.92)';
          ctx.fillText(prefixStr, textStartX, textMidY);
        }

        ctx.font = boldFont;
        ctx.fillStyle = '#09090b';
        ctx.fillText(activeStr, textStartX + prefixW, textMidY);

        if (suffixStr) {
          ctx.font = baseFont;
          ctx.fillStyle = '#a1a1aa';
          ctx.fillText(suffixStr, textStartX + prefixW + activeW, textMidY);
        }

        ctx.restore();
      }
    }

    // 8. DAW Playhead Cursor (Draggable Pentagon Cap + Crisp Vertical Line)
    const playRatio = playheadSec / totalSec;
    if (playRatio >= viewStartRatio - 0.002 && playRatio <= viewEndRatio + 0.002) {
      const px = Math.max(0.5, Math.min(W - 0.5, ratioToX(playRatio)));
      const headHighlighted = playheadDragging || hoverZoneRef.current === 'playhead';
      const lineStartY = wordTimelineMode ? topRulerBandH - 0.5 : RULER_H;

      ctx.strokeStyle = headHighlighted
        ? 'rgba(248, 113, 113, 0.45)'
        : 'rgba(239, 68, 68, 0.28)';
      ctx.lineWidth = headHighlighted ? 6 : 4;
      ctx.beginPath();
      ctx.moveTo(px, lineStartY);
      ctx.lineTo(px, H);
      ctx.stroke();

      ctx.strokeStyle = headHighlighted ? '#fca5a5' : '#ef4444';
      ctx.lineWidth = headHighlighted ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(px, wordTimelineMode ? topRulerBandH - 0.5 : RULER_H - 2);
      ctx.lineTo(px, H);
      ctx.stroke();

      ctx.fillStyle = headHighlighted ? '#f87171' : '#ef4444';
      ctx.beginPath();
      if (wordTimelineMode) {
        const capHalfW = headHighlighted ? 5.5 : 4.5;
        ctx.moveTo(px - capHalfW, 1);
        ctx.lineTo(px + capHalfW, 1);
        ctx.lineTo(px + capHalfW, 8.5);
        ctx.lineTo(px, 13.5);
        ctx.lineTo(px - capHalfW, 8.5);
      } else {
        ctx.moveTo(px - (headHighlighted ? 6.5 : 5.5), 2);
        ctx.lineTo(px + (headHighlighted ? 6.5 : 5.5), 2);
        ctx.lineTo(px + (headHighlighted ? 6.5 : 5.5), 12);
        ctx.lineTo(px, 19);
        ctx.lineTo(px - (headHighlighted ? 6.5 : 5.5), 12);
      }
      ctx.closePath();
      ctx.fill();

      if (headHighlighted) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    ctx.restore();
  }, [
    getEffectivePlayheadSec,
    canvasMetrics,
    speakerTracks,
    anySolo,
    state.loudnessAligned,
    state.autoSoloMode,
    state.duckAttenuationDb,
    timeline,
    timelineZones,
    totalSec,
    zoom,
    viewStartRatio,
    wordTimelineMode,
    rulerHeightPx,
    visibleWordAnnotations,
    selStartRatio,
    selEndRatio,
    selLaneIdx,
    hoverLaneIdx,
    dragging,
    playheadDragging,
    outroTrimDragging,
    draftOutroDurationSec,
    isMainStage,
    focusedTurn,
    focusedBlockOverlay,
  ]);

  drawOverlayRef.current = drawOverlayCanvas;

  useEffect(() => {
    drawOverlayCanvas();
  }, [drawOverlayCanvas]);

  useEffect(() => {
    const unsub = subscribePlayhead(() => {
      drawOverlayRef.current();
    });
    return () => {
      unsub();
      if (overlayDrawRafRef.current !== null) {
        window.cancelAnimationFrame(overlayDrawRafRef.current);
        overlayDrawRafRef.current = null;
      }
    };
  }, []);

  const extractCanvasPos = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return {
        ratio: 0,
        laneIdx: 0,
        hoveredLaneIdx: null as number | null,
        localX: 0,
        localY: 0,
        rectWidth: 0,
        rectHeight: 0,
      };
    }
    const rect = canvas.getBoundingClientRect();
    const RULER_H = rulerHeightPx;
    const localX = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const localY = Math.max(0, Math.min(rect.height, clientY - rect.top));

    const normInView = rect.width > 0 ? localX / rect.width : 0;
    const ratio = Math.max(0, Math.min(1, viewStartRatio + normInView / zoom));

    const bodyH = Math.max(1, rect.height - RULER_H);
    const bgmLaneH = hasBgmTrack ? Math.min(BGM_LANE_COMPACT_H, Math.max(26, Math.round(bodyH * 0.2))) : 0;
    const speakerLaneH = (bodyH - bgmLaneH) / Math.max(1, speakerTracks.length);

    let hoveredLaneIdx: number | null = null;
    if (localY < RULER_H) {
      hoveredLaneIdx = null;
    } else {
      const localYInBody = localY - RULER_H;
      const speakerAreaH = speakerTracks.length * speakerLaneH;
      if (hasBgmTrack && localYInBody >= speakerAreaH - 1) {
        hoveredLaneIdx = speakerTracks.length;
      } else {
        hoveredLaneIdx = Math.max(
          0,
          Math.min(speakerTracks.length - 1, Math.floor(localYInBody / Math.max(1, speakerLaneH)))
        );
      }
    }
    const laneIdx = hoveredLaneIdx ?? 0;

    return { ratio, laneIdx, hoveredLaneIdx, localX, localY, rectWidth: rect.width, rectHeight: rect.height };
  };

  const detectCanvasHoverZone = (
    localX: number,
    localY: number,
    rectWidth: number,
    rectHeight: number
  ): 'none' | 'playhead' | 'ruler' | 'outro_trim_handle' | 'cut_badge' => {
    if (showCutMarkers && cutBadgeHitBoxesRef.current.length > 0) {
      for (const box of cutBadgeHitBoxesRef.current) {
        if (localX >= box.x1 && localX <= box.x2 && localY >= box.y1 && localY <= box.y2) {
          return 'cut_badge';
        }
      }
    }
    if (rectWidth > 0 && totalSec > 0) {
      const viewSpan = 1 / zoom;
      const playRatio = getEffectivePlayheadSec() / totalSec;
      if (playRatio >= viewStartRatio - 0.01 && playRatio <= viewStartRatio + viewSpan + 0.01) {
        const phPx = Math.max(
          0.5,
          Math.min(rectWidth - 0.5, ((playRatio - viewStartRatio) / viewSpan) * rectWidth)
        );
        const hitRadius = localY <= rulerHeightPx + 1 ? 9 : 6;
        if (Math.abs(localX - phPx) <= hitRadius) return 'playhead';
      }

      // 检查片尾 BGM 截取手柄 (Trim Handle)
      if (hasBgmTrack && hasOutroBgm) {
        const bodyH = Math.max(1, rectHeight - rulerHeightPx);
        const bgmLaneH = Math.min(BGM_LANE_COMPACT_H, Math.max(26, Math.round(bodyH * 0.2)));
        const speakerLaneH = (bodyH - bgmLaneH) / Math.max(1, speakerTracks.length);
        const bgmTop = rulerHeightPx + speakerTracks.length * speakerLaneH;
        if (localY >= bgmTop - 2 && localY <= rectHeight + 2) {
          const outroStartRatio = outroStartSec / totalSec;
          const outroHandlePx = ((outroStartRatio - viewStartRatio) / viewSpan) * rectWidth;
          if (Math.abs(localX - outroHandlePx) <= 9) {
            return 'outro_trim_handle';
          }
        }
      }
    }
    return localY <= rulerHeightPx + 1 ? 'ruler' : 'none';
  };

  const resolveDragRatioWithAutoPan = (
    localX: number,
    rectWidth: number,
    fallbackRatio: number
  ): number => {
    if (zoom <= 1.01 || rectWidth <= 0) return fallbackRatio;
    const viewSpan = 1 / zoom;
    const maxStart = Math.max(0, 1 - viewSpan);
    const edgeThreshold = 18;
    if (localX < edgeThreshold && viewStartRatio > 0) {
      const factor = Math.max(0.2, (edgeThreshold - localX) / edgeThreshold);
      const nextStart = Math.max(0, viewStartRatio - Math.min(viewStartRatio, viewSpan * 0.03 * factor));
      setViewStartRatio(nextStart);
      return Math.max(0, Math.min(1, nextStart + (localX / rectWidth) * viewSpan));
    }
    if (localX > rectWidth - edgeThreshold && viewStartRatio < maxStart) {
      const factor = Math.max(0.2, (localX - (rectWidth - edgeThreshold)) / edgeThreshold);
      const nextStart = Math.min(
        maxStart,
        viewStartRatio + Math.min(maxStart - viewStartRatio, viewSpan * 0.03 * factor)
      );
      setViewStartRatio(nextStart);
      return Math.max(0, Math.min(1, nextStart + (localX / rectWidth) * viewSpan));
    }
    return fallbackRatio;
  };

  const centerFocusedTurnInDeck = (behavior: ScrollBehavior = 'smooth') => {
    if (!isMainStage || deckCollapsed || focusTurnIdx < 0) return;
    const focused = speakerDeckTurns[focusTurnIdx];
    const container = deckScrollRef.current;
    if (!focused || !container) return;
    const card = turnItemRefs.current.get(focused.turnKey);
    if (!card) return;

    const turnChanged = prevFocusedTurnIdxRef.current !== focusTurnIdx;
    prevFocusedTurnIdxRef.current = focusTurnIdx;

    // 仅在发言人轮次切换（一段一段跳过）或主动拖拽指针时调整外层卡片位置，播放时不随单字频繁抖动滚动
    if (turnChanged || playheadDragging || scrubbing) {
      if (deckFlowMode === 'horizontal') {
        const targetLeft = Math.max(
          0,
          card.offsetLeft - container.clientWidth * 0.5 + card.offsetWidth * 0.5
        );
        if (typeof container.scrollTo === 'function') {
          container.scrollTo({ left: targetLeft, behavior });
        } else {
          container.scrollLeft = targetLeft;
        }
      } else {
        const targetTop = Math.max(
          0,
          card.offsetTop - container.clientHeight * 0.5 + card.offsetHeight * 0.5
        );
        if (typeof container.scrollTo === 'function') {
          container.scrollTo({ top: targetTop, behavior });
        } else {
          container.scrollTop = targetTop;
        }
      }
    }

    const tokenStream = card.querySelector<HTMLElement>('[data-token-stream="1"]');
    const activeTokenEl = card.querySelector<HTMLElement>('[data-active-token="1"]');
    if (tokenStream && activeTokenEl && tokenStream.scrollHeight > tokenStream.clientHeight + 2) {
      const streamRect = tokenStream.getBoundingClientRect();
      const tokenRect = activeTokenEl.getBoundingClientRect();
      // 一段一段跳过：词在可见舒适区间内（上方留 10px，下方留 24px）保持静止，超出边界时才分段翻页跳过
      const isComfortablyVisible =
        tokenRect.top >= streamRect.top + 8 &&
        tokenRect.bottom <= streamRect.bottom - 20;

      if (!isComfortablyVisible || turnChanged) {
        const tokenOffsetInStream = tokenRect.top - streamRect.top + tokenStream.scrollTop;
        const desiredTop = Math.max(
          0,
          tokenOffsetInStream - tokenStream.clientHeight * 0.25
        );
        if (typeof tokenStream.scrollTo === 'function') {
          tokenStream.scrollTo({ top: desiredTop, behavior });
        } else {
          tokenStream.scrollTop = desiredTop;
        }
      }
    }
  };

  useEffect(() => {
    if (!isMainStage || deckCollapsed || focusTurnIdx < 0) return;
    if (!hasValidRange && !playheadDragging && !scrubbing && Date.now() < manualScrollLockUntilRef.current) {
      return;
    }
    centerFocusedTurnInDeck(playheadDragging || scrubbing ? 'auto' : 'smooth');
  }, [isMainStage, deckCollapsed, deckFlowMode, focusTurnIdx, playheadDragging, scrubbing]);

  const resolveDeckRangeStartSec = (idxA: number, idxB: number, fallbackSec: number): number => {
    const lo = Math.min(idxA, idxB);
    const hi = Math.max(idxA, idxB);
    for (let k = lo; k <= hi; k++) {
      const sec = startSecByFlatIndex.get(k);
      if (typeof sec === 'number') return sec;
    }
    return fallbackSec;
  };

  const speakerDeckTurnsRef = useRef<SpeakerDeckTurn[]>([]);
  speakerDeckTurnsRef.current = speakerDeckTurns;
  const deckFlowModeRef = useRef(deckFlowMode);
  deckFlowModeRef.current = deckFlowMode;
  const editingHintTokenIdRef = useRef<string | null>(editingHintTokenId);
  editingHintTokenIdRef.current = editingHintTokenId;
  const cancelingHintRef = useRef<boolean>(false);
  const draftHintTextRef = useRef<string>(draftHintText);
  draftHintTextRef.current = draftHintText;
  const saveHintToGlossaryRef = useRef<boolean>(saveHintToGlossary);
  saveHintToGlossaryRef.current = saveHintToGlossary;

  const syncDeckVisibleRangeNow = useCallback(() => {
    const container = deckScrollRef.current;
    const turns = speakerDeckTurnsRef.current;
    if (!container || turns.length === 0) return;

    let nextStart = 0;
    let nextEnd = Math.min(turns.length - 1, 24);
    const buffer = 6;

    if (deckFlowModeRef.current === 'horizontal') {
      const left = container.scrollLeft;
      const width = Math.max(136, container.clientWidth > 0 ? container.clientWidth : 400);
      const right = left + width;
      const firstEl = turnItemRefs.current.get(turns[0].turnKey);
      if (firstEl) {
        let lo = 0;
        let hi = turns.length - 1;
        let firstVis = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          const el = turnItemRefs.current.get(turns[mid].turnKey);
          if (!el) break;
          if (el.offsetLeft + el.offsetWidth >= left) {
            firstVis = mid;
            hi = mid - 1;
          } else {
            lo = mid + 1;
          }
        }
        lo = firstVis;
        hi = turns.length - 1;
        let lastVis = Math.min(turns.length - 1, firstVis + 16);
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          const el = turnItemRefs.current.get(turns[mid].turnKey);
          if (!el) break;
          if (el.offsetLeft <= right) {
            lastVis = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        nextStart = Math.max(0, firstVis - 8);
        nextEnd = Math.min(turns.length - 1, lastVis + 8);
      } else {
        nextStart = Math.max(0, Math.floor(left / 260) - 8);
        nextEnd = Math.min(turns.length - 1, Math.ceil(right / 136) + 8);
      }
    } else {
      const top = container.scrollTop;
      const bottom = top + Math.max(120, container.clientHeight);
      const firstEl = turnItemRefs.current.get(turns[0].turnKey);
      if (firstEl) {
        let lo = 0;
        let hi = turns.length - 1;
        let firstVis = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          const el = turnItemRefs.current.get(turns[mid].turnKey);
          if (!el) break;
          if (el.offsetTop + el.offsetHeight >= top) {
            firstVis = mid;
            hi = mid - 1;
          } else {
            lo = mid + 1;
          }
        }
        lo = firstVis;
        hi = turns.length - 1;
        let lastVis = Math.min(turns.length - 1, firstVis + 12);
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          const el = turnItemRefs.current.get(turns[mid].turnKey);
          if (!el) break;
          if (el.offsetTop <= bottom) {
            lastVis = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        nextStart = Math.max(0, firstVis - buffer);
        nextEnd = Math.min(turns.length - 1, lastVis + buffer);
      }
    }

    setDeckVisibleRange((prev) =>
      prev.start === nextStart && prev.end === nextEnd
        ? prev
        : { start: nextStart, end: nextEnd }
    );
  }, []);

  useEffect(() => {
    if (!isMainStage || deckCollapsed || speakerDeckTurns.length === 0) return;
    if (deckScrollRafRef.current !== null) {
      window.cancelAnimationFrame(deckScrollRafRef.current);
    }
    deckScrollRafRef.current = window.requestAnimationFrame(() => {
      deckScrollRafRef.current = null;
      syncDeckVisibleRangeNow();
    });
  }, [
    isMainStage,
    deckCollapsed,
    deckFlowMode,
    focusTurnIdx,
    speakerDeckTurns.length,
    syncDeckVisibleRangeNow,
  ]);

  useEffect(() => {
    return () => {
      if (deckScrollRafRef.current !== null) {
        window.cancelAnimationFrame(deckScrollRafRef.current);
        deckScrollRafRef.current = null;
      }
    };
  }, []);

  const deckActionHandlersRef = useRef({
    seekTurn: (_turn: SpeakerDeckTurn) => {},
    focusTurnWaveform: (_turn: SpeakerDeckTurn) => {},
    seekToken: (_turn: SpeakerDeckTurn, _sec: number) => {},
    resolveRangeStartSec: resolveDeckRangeStartSec,
    onSelectRange,
    onSelectToken,
    onShortenSilence,
    onDeleteTokenIds,
    onMuteTokenIds,
    onApplyManualCorrection,
    onToggleOverlapMute,
    onToggleOverlapKeepFull,
  });

  deckActionHandlersRef.current = {
    seekTurn: (turn) => {
      manualScrollLockUntilRef.current = 0;
      seekPlayheadWithoutZoom(turn.editedStartSec, {
        startSec: turn.editedStartSec,
        endSec: turn.editedEndSec,
        speakerId: turn.speakerId,
      });
    },
    focusTurnWaveform: (turn) => {
      manualScrollLockUntilRef.current = 0;
      focusWaveformBlockRange(
        turn.editedStartSec,
        turn.editedEndSec,
        turn.speakerId,
        turn.editedStartSec,
        false,
        true
      );
    },
    seekToken: (turn, sec) => {
      manualScrollLockUntilRef.current = 0;
      seekPlayheadWithoutZoom(sec, {
        startSec: turn.editedStartSec,
        endSec: turn.editedEndSec,
        speakerId: turn.speakerId,
      });
    },
    resolveRangeStartSec: resolveDeckRangeStartSec,
    onSelectRange,
    onSelectToken,
    onShortenSilence,
    onDeleteTokenIds,
    onMuteTokenIds,
    onApplyManualCorrection,
    onToggleOverlapMute,
    onToggleOverlapKeepFull,
  };

  const deckCallbacks = useMemo<DeckTurnCallbacks>(
    () => ({
      registerTurnRef: (turnKey, el) => {
        if (el) turnItemRefs.current.set(turnKey, el);
        else turnItemRefs.current.delete(turnKey);
      },
      onHoverTurn: (idx) => {
        setHoveredTurnIdx((prev) => (prev === idx ? prev : idx));
      },
      onSeekTurn: (turn) => {
        deckActionHandlersRef.current.seekTurn(turn);
      },
      onFocusTurnWaveform: (turn) => {
        deckActionHandlersRef.current.focusTurnWaveform(turn);
      },
      onTokenMouseDown: (e, turn, flatIndex, editedStartSec) => {
        if (e.button !== 0 || e.shiftKey) return;
        if (e.altKey) {
          e.stopPropagation();
          deckActionHandlersRef.current.seekToken(turn, editedStartSec);
          return;
        }
        deckDragSelectRef.current = {
          active: true,
          moved: false,
          anchorIdx: flatIndex,
          additive: e.metaKey || e.ctrlKey,
        };
      },
      onTokenMouseEnter: (flatIndex) => {
        const rangeCb = deckActionHandlersRef.current.onSelectRange;
        if (deckDragSelectRef.current.active && rangeCb) {
          deckDragSelectRef.current.moved = true;
          rangeCb(
            deckDragSelectRef.current.anchorIdx,
            flatIndex,
            deckDragSelectRef.current.additive
          );
        }
      },
      onTokenClick: (e, turn, tokenId, flatIndex, editedStartSec) => {
        e.stopPropagation();
        if (e.altKey) return;
        manualScrollLockUntilRef.current = 0;
        if (deckDragSelectRef.current.moved) {
          deckDragSelectRef.current.moved = false;
          const startAnchorSec = deckActionHandlersRef.current.resolveRangeStartSec(
            deckDragSelectRef.current.anchorIdx,
            flatIndex,
            editedStartSec
          );
          deckActionHandlersRef.current.seekToken(turn, startAnchorSec);
          deckLastClickedIdxRef.current = flatIndex;
          return;
        }
        const jumpAnchorSec =
          e.shiftKey && deckLastClickedIdxRef.current !== null
            ? deckActionHandlersRef.current.resolveRangeStartSec(
                deckLastClickedIdxRef.current,
                flatIndex,
                editedStartSec
              )
            : editedStartSec;
        if (!e.metaKey && !e.ctrlKey) {
          deckActionHandlersRef.current.seekToken(turn, jumpAnchorSec);
        }
        deckLastClickedIdxRef.current = flatIndex;
        deckActionHandlersRef.current.onSelectToken?.(
          tokenId,
          flatIndex,
          e.shiftKey,
          e.metaKey || e.ctrlKey
        );
      },
      onTokenBleepClick: (e, turn, tokenId, flatIndex, editedStartSec) => {
        e.stopPropagation();
        deckActionHandlersRef.current.seekToken(turn, editedStartSec);
        deckLastClickedIdxRef.current = flatIndex;
        deckActionHandlersRef.current.onSelectToken?.(
          tokenId,
          flatIndex,
          e.shiftKey,
          e.metaKey || e.ctrlKey
        );
      },
      onStartEditHint: (tokenId, text) => {
        cancelingHintRef.current = false;
        editingHintTokenIdRef.current = tokenId;
        setEditingHintTokenId(tokenId);
        setDraftHintText(text);
      },
      onDraftHintChange: (text) => {
        setDraftHintText(text);
      },
      onCommitHint: (tokenId) => {
        if (editingHintTokenIdRef.current !== tokenId) return;
        editingHintTokenIdRef.current = null;
        const canceled = cancelingHintRef.current;
        cancelingHintRef.current = false;
        const trimmed = draftHintTextRef.current.trim();
        if (!canceled && trimmed && deckActionHandlersRef.current.onApplyManualCorrection) {
          deckActionHandlersRef.current.onApplyManualCorrection(
            tokenId,
            trimmed,
            saveHintToGlossaryRef.current
          );
        }
        setEditingHintTokenId(null);
      },
      onCancelHint: () => {
        cancelingHintRef.current = true;
        editingHintTokenIdRef.current = null;
        setEditingHintTokenId(null);
      },
      onToggleSaveToGlossary: (checked) => {
        setSaveHintToGlossary(checked);
      },
      onShortenSilence: (tokenId) => {
        deckActionHandlersRef.current.onShortenSilence?.(tokenId);
      },
      onDeleteTurn: (tokenIds) => {
        deckActionHandlersRef.current.onDeleteTokenIds?.(tokenIds);
      },
      onMuteTurn: (tokenIds) => {
        deckActionHandlersRef.current.onMuteTokenIds?.(tokenIds);
      },
      onToggleOverlapMute: (blockId, fallbackOv) => {
        deckActionHandlersRef.current.onToggleOverlapMute?.(blockId, fallbackOv);
      },
      onToggleOverlapKeepFull: (blockId, fallbackOv) => {
        deckActionHandlersRef.current.onToggleOverlapKeepFull?.(blockId, fallbackOv);
      },
      onSelectOverlapRange: (startSec, endSec) => {
        const r1 = Math.max(0, startSec / totalSec);
        const r2 = Math.min(1, endSec / totalSec);
        setSelStartRatio(r1);
        setSelEndRatio(r2);
        onSeekToSec(startSec);
      },
      onCutOverlapRange: (startSec, endSec) => {
        onWaveformCutAction(startSec, endSec, 'ripple_all');
      },
    }),
    []
  );

  const [localDeckPosition, setLocalDeckPosition] = useState<'top' | 'bottom'>('top');
  const effectiveDeckPosition = speakerDeckPosition ?? localDeckPosition;
  const toggleDeckPosition = () => {
    const nextPos: 'top' | 'bottom' = effectiveDeckPosition === 'top' ? 'bottom' : 'top';
    if (onChangeSpeakerDeckPosition) {
      onChangeSpeakerDeckPosition(nextPos);
    } else {
      setLocalDeckPosition(nextPos);
    }
  };

  const handleStartResizeDeckHeight = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = deckHeight;
    const dir = effectiveDeckPosition === 'bottom' ? -1 : 1;
    setResizingDeck(true);

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    let rafId: number | null = null;
    let pendingHeight: number | null = null;

    const onPointerMove = (ev: PointerEvent) => {
      const deltaY = (ev.clientY - startY) * dir;
      const maxDeckH =
        typeof window === 'undefined' ? 340 : Math.max(188, Math.floor(window.innerHeight * 0.44));
      pendingHeight = Math.round(Math.max(96, Math.min(maxDeckH, startHeight + deltaY)));
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        if (pendingHeight !== null) {
          setDeckHeight(pendingHeight);
        }
      });
    };

    const cleanup = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      setResizingDeck(false);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  };

  const adjustZoomStep = (factor: number) => {
    applyZoomAtAnchor(zoom * factor);
  };

  const handleFocusPrecisionWindow = () => {
    // One-click jump into a >=100x word/character annotated timeline window (further zoomable down to 0.25s)
    const targetSec = visibleWindowSec <= 5 ? Math.max(MIN_VISIBLE_SEC, visibleWindowSec / 2.5) : 4.0;
    const desiredZoom = Math.min(maxZoom, Math.max(100, totalSec / targetSec));
    applyZoomAtAnchor(desiredZoom);
  };

  const handleStartResizeHeight = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = dockHeight;
    setResizingHeight(true);

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    let rafId: number | null = null;
    let pendingHeight: number | null = null;

    const onPointerMove = (ev: PointerEvent) => {
      const deltaY = startY - ev.clientY;
      pendingHeight = Math.round(
        Math.max(MIN_DOCK_HEIGHT, Math.min(getMaxDockHeight(), startHeight + deltaY))
      );
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        if (pendingHeight !== null) {
          setDockHeight(pendingHeight);
        }
      });
    };

    const cleanup = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      setResizingHeight(false);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  };

  const OuterTag = isMainStage ? 'main' : 'footer';
  const outerClassName = isMainStage
    ? 'flex-1 min-w-0 relative flex flex-col h-full min-h-0 overflow-hidden bg-zinc-950 px-3.5 pt-2.5 pb-2.5 select-none'
    : 'relative shrink-0 border-t border-zinc-800/90 bg-zinc-900/95 px-4 pt-2.5 pb-2 select-none';
  const selectedCount = selectedTokenIds?.size ?? 0;

  return (
    <OuterTag className={outerClassName}>
      {/* Top Drag-Resize Splitter Handle (dock mode only) */}
      {!isMainStage && (
        <div
          onPointerDown={handleStartResizeHeight}
          onDoubleClick={() => setDockHeight(DEFAULT_DOCK_HEIGHT)}
          title="上下拖拽调节波形精剪台高度（双击恢复默认高度）"
          className="absolute inset-x-0 -top-1.5 h-3 z-20 cursor-ns-resize group flex items-center justify-center"
        >
          <div
            className={`w-full h-[2px] transition-colors ${
              resizingHeight
                ? 'bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.8)]'
                : 'bg-transparent group-hover:bg-blue-500/55'
            }`}
          />
          <div
            className={`absolute px-2.5 py-0.5 rounded-full border bg-zinc-900/95 flex items-center gap-1 transition ${
              resizingHeight
                ? 'border-blue-400 shadow-[0_0_10px_rgba(59,130,246,0.45)]'
                : 'border-zinc-700/85 group-hover:border-blue-400/70'
            }`}
          >
            <span
              className={`w-6 h-1 rounded-full transition-colors ${
                resizingHeight ? 'bg-blue-400' : 'bg-zinc-500 group-hover:bg-blue-400'
              }`}
            />
          </div>
        </div>
      )}

      {/* Audition Main Stage Scrollable Speaker-Block Focus & Quick-Edit Deck */}
      {isMainStage && (
        <section
          className={`shrink-0 rounded-xl border border-zinc-800/90 bg-zinc-900/85 overflow-hidden flex flex-col ${
            effectiveDeckPosition === 'bottom' ? 'order-3 mt-2' : 'mb-2'
          }`}
        >
          {!deckCollapsed && effectiveDeckPosition === 'bottom' && (
            <div
              onPointerDown={handleStartResizeDeckHeight}
              onDoubleClick={() => setDeckHeight(DEFAULT_DECK_HEIGHT)}
              title="上下拖拽调整发言块提示区高度（双击恢复默认高度）"
              className={`h-1.5 border-b border-zinc-800/80 cursor-ns-resize flex items-center justify-center transition-colors ${
                resizingDeck ? 'bg-blue-500/30' : 'bg-zinc-900/90 hover:bg-zinc-800'
              }`}
            >
              <span
                className={`w-8 h-0.5 rounded-full ${
                  resizingDeck ? 'bg-blue-400' : 'bg-zinc-600'
                }`}
              />
            </div>
          )}
          <div className="px-3 py-1.5 border-b border-zinc-800/80 bg-zinc-900 flex items-center justify-between gap-2 text-xs flex-wrap shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 text-[10px] font-semibold shrink-0">
                💬 发言块滚动聚焦
              </span>
              {focusedTurn && (
                <>
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-zinc-100 shrink-0">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: focusedTurn.speakerColor }}
                    />
                    <span>{focusedTurn.speakerName}</span>
                  </span>
                  <span className="text-[10px] font-mono text-zinc-400 shrink-0">
                    第 {focusTurnIdx + 1}/{speakerDeckTurns.length} 段
                  </span>
                  {focusedTurn.chapterTitle && (
                    <span className="text-[10px] text-zinc-400 truncate max-w-[130px]">
                      · {focusedTurn.chapterTitle}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      manualScrollLockUntilRef.current = 0;
                      centerFocusedTurnInDeck('smooth');
                    }}
                    title="将当前编辑发言块重新居中并显示前后发言人上下文"
                    className="px-1.5 py-0.5 rounded border border-zinc-700/80 bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 text-[10px] cursor-pointer shrink-0 transition"
                  >
                    定位当前段
                  </button>
                </>
              )}
            </div>

            <div className="flex items-center gap-1 flex-wrap shrink-0">
              {selectedCount > 0 && (
                <>
                  {onRippleDeleteSelected && (
                    <button
                      type="button"
                      onClick={onRippleDeleteSelected}
                      className="px-2 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer"
                    >
                      <Scissors className="w-3 h-3" />
                      <span>切掉选中 ({selectedCount})</span>
                    </button>
                  )}
                  {onMuteTrackSelected && (
                    <button
                      type="button"
                      onClick={onMuteTrackSelected}
                      className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-zinc-100 text-[11px] inline-flex items-center gap-1 cursor-pointer"
                    >
                      <VolumeX className="w-3 h-3" />
                      <span>静音选中</span>
                    </button>
                  )}
                  {onBleepSelected && (
                    <button
                      type="button"
                      onClick={onBleepSelected}
                      className="px-2 py-0.5 rounded bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer"
                    >
                      <ShieldAlert className="w-3 h-3" />
                      <span>消音</span>
                    </button>
                  )}
                  {onAddSelectedToHighlight && (
                    <button
                      type="button"
                      onClick={onAddSelectedToHighlight}
                      title="将选中文字加入左侧「金句列表」与右侧「高光片头」"
                      className="px-2 py-0.5 rounded bg-purple-600 hover:bg-purple-500 text-white text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer"
                    >
                      <Sparkles className="w-3 h-3" />
                      <span>加入金句</span>
                    </button>
                  )}
                  {onClearSelection && (
                    <button
                      type="button"
                      onClick={onClearSelection}
                      className="px-1.5 py-0.5 rounded text-zinc-400 hover:text-zinc-100 text-[11px] cursor-pointer"
                    >
                      取消
                    </button>
                  )}
                </>
              )}
              {onApplyPreferenceSmartCut && (
                <button
                  type="button"
                  onClick={onApplyPreferenceSmartCut}
                  title="执行对谈偏好精剪（消解口吃重说、剔除卡壳口癖、保护自然捧场词与紧凑停顿）"
                  className="px-2 py-0.5 rounded border border-purple-500/60 bg-purple-500/15 hover:bg-purple-500/25 text-purple-200 text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer transition shadow-xs"
                >
                  <Sparkles className="w-3 h-3 text-purple-300" />
                  <span>偏好精剪</span>
                </button>
              )}
              {onCleanMouthClicks && (
                <button
                  type="button"
                  onClick={onCleanMouthClicks}
                  title="去除气口咂嘴/口水音瞬态"
                  className="px-2 py-0.5 rounded border border-zinc-700 bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 text-[11px] cursor-pointer"
                >
                  💧 去口水音
                </button>
              )}
              {onOpenAsrSettings && (
                <button
                  type="button"
                  onClick={onOpenAsrSettings}
                  title="切换本地 SenseVoice / 配置 DeepSeek 语音识别 API Key"
                  className={`px-2 py-0.5 rounded border text-[11px] inline-flex items-center gap-1 cursor-pointer transition ${
                    state.asrConfig?.provider === 'deepseek'
                      ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25'
                      : 'border-zinc-700 bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700'
                  }`}
                >
                  <Cloud className="w-3 h-3 text-cyan-400" />
                  <span>
                    {state.asrConfig?.provider === 'deepseek' ? 'DeepSeek识别' : '本地识别'}
                  </span>
                </button>
              )}
              {onRetranscribe && (
                <button
                  type="button"
                  onClick={onRetranscribe}
                  title="使用当前语音识别引擎（本地或 DeepSeek ASR）重新识别全部音轨"
                  className="px-2 py-0.5 rounded border border-cyan-500/40 bg-cyan-600/20 hover:bg-cyan-600/35 text-cyan-100 text-[11px] inline-flex items-center gap-1 cursor-pointer transition"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>重识别</span>
                </button>
              )}
              {onUndo && (
                <button
                  type="button"
                  onClick={onUndo}
                  disabled={!canUndo}
                  title="撤销上一步剪辑 (⌘Z)"
                  className="px-2 py-0.5 rounded border border-zinc-700 bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 text-[11px] inline-flex items-center gap-1 disabled:opacity-40 cursor-pointer disabled:cursor-default"
                >
                  <Undo2 className="w-3 h-3" />
                  <span>撤销</span>
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  setDeckFlowMode((m) => (m === 'horizontal' ? 'vertical' : 'horizontal'))
                }
                title="切换发言块排列方式：横向时间轴卡片 / 纵向多行列表"
                className="px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-950 hover:bg-zinc-800 text-zinc-300 text-[11px] inline-flex items-center gap-1 cursor-pointer"
              >
                {deckFlowMode === 'horizontal' ? (
                  <>
                    <Rows3 className="w-3 h-3 text-emerald-400" />
                    <span>竖排</span>
                  </>
                ) : (
                  <>
                    <Columns3 className="w-3 h-3 text-emerald-400" />
                    <span>横排</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={toggleDeckPosition}
                title={
                  effectiveDeckPosition === 'top'
                    ? '将发言块移动到音轨下方'
                    : '将发言块移动到音轨上方'
                }
                className="px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-950 hover:bg-zinc-800 text-zinc-300 text-[11px] inline-flex items-center gap-1 cursor-pointer"
              >
                {effectiveDeckPosition === 'top' ? (
                  <>
                    <PanelBottom className="w-3 h-3 text-blue-400" />
                    <span>置于下方</span>
                  </>
                ) : (
                  <>
                    <PanelTop className="w-3 h-3 text-blue-400" />
                    <span>置于上方</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => setDeckCollapsed((v) => !v)}
                className="px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-950 hover:bg-zinc-800 text-zinc-300 text-[11px] inline-flex items-center gap-0.5 cursor-pointer"
              >
                {deckCollapsed ? (
                  <>
                    <ArrowDown className="w-3 h-3" />
                    <span>展开发言块</span>
                  </>
                ) : (
                  <>
                    <ArrowUp className="w-3 h-3" />
                    <span>收起</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {!deckCollapsed && (
            <>
              <div
                ref={deckScrollRef}
                onContextMenu={(e) => {
                  const target = e.target as HTMLElement | null;
                  const tokenEl = target?.closest<HTMLElement>('[data-token-id]');
                  const tokenId = tokenEl?.dataset.tokenId;
                  const flatIdxRaw = tokenEl?.dataset.tokenFlatIdx;
                  if (
                    tokenId &&
                    flatIdxRaw !== undefined &&
                    onSelectToken &&
                    (!selectedTokenIds || !selectedTokenIds.has(tokenId))
                  ) {
                    const flatIdx = Number(flatIdxRaw);
                    if (Number.isFinite(flatIdx)) {
                      onSelectToken(tokenId, flatIdx, false, false);
                    }
                    e.preventDefault();
                    setWaveContextMenu(null);
                    setTokenContextMenu({ x: e.clientX, y: e.clientY });
                    return;
                  }
                  if (selectedCount === 0) return;
                  e.preventDefault();
                  setWaveContextMenu(null);
                  setTokenContextMenu({ x: e.clientX, y: e.clientY });
                }}
                onScroll={() => {
                  if (deckScrollRafRef.current !== null) return;
                  deckScrollRafRef.current = window.requestAnimationFrame(() => {
                    deckScrollRafRef.current = null;
                    syncDeckVisibleRangeNow();
                  });
                }}
                onWheel={(e) => {
                  manualScrollLockUntilRef.current = Date.now() + 3500;
                  if (
                    deckFlowMode === 'horizontal' &&
                    Math.abs(e.deltaY) > Math.abs(e.deltaX) &&
                    e.currentTarget.scrollWidth > e.currentTarget.clientWidth
                  ) {
                    const target = e.target as HTMLElement | null;
                    const innerStream = target?.closest<HTMLElement>('[data-token-stream="1"]');
                    if (innerStream && innerStream.scrollHeight > innerStream.clientHeight + 2) {
                      return;
                    }
                    e.currentTarget.scrollLeft += e.deltaY;
                  }
                }}
                style={{ height: `${deckHeight}px` }}
                className={
                  deckFlowMode === 'horizontal'
                    ? 'relative flex flex-row items-stretch gap-1 overflow-x-auto overflow-y-hidden px-1.5 py-1 bg-zinc-950/80'
                    : 'relative overflow-y-auto px-2 py-1.5 space-y-1 bg-zinc-950/75'
                }
              >
                {speakerDeckTurns.length === 0 ? (
                  <div className="h-full w-full flex items-center justify-center text-[11px] text-zinc-500">
                    暂无字幕或语音文字（可直接在下方多轨波形自由精剪，或导入音频/字幕后在此高亮浏览与快捷剪辑前后发言段）
                  </div>
                ) : (
                  speakerDeckTurns.map((turn, idx) => {
                    const dist = focusTurnIdx >= 0 ? Math.abs(idx - focusTurnIdx) : 99;
                    const isCurrent = idx === focusTurnIdx;
                    const isNeighbor = dist > 0 && dist <= 2;
                    const relOffset = isCurrent ? 0 : isNeighbor ? idx - focusTurnIdx : null;
                    const actionsAlwaysVisible = dist <= 1;
                    const isRangeHit =
                      hasValidRange &&
                      turn.editedEndSec > rangeStartSec + 0.01 &&
                      turn.editedStartSec < rangeEndSec - 0.01;
                    const prevChapter =
                      idx > 0 ? speakerDeckTurns[idx - 1].chapterTitle : undefined;
                    const showChapter = Boolean(
                      turn.chapterTitle && turn.chapterTitle !== prevChapter
                    );
                    const turnSelection = selectedTokensByTurn.get(idx) ?? EMPTY_TOKEN_ID_SET;
                    const renderInteractiveTokens =
                      speakerDeckTurns.length <= 36 ||
                      isCurrent ||
                      dist <= 4 ||
                      hoveredTurnIdx === idx ||
                      editingTurnIdx === idx ||
                      turnSelection.size > 0 ||
                      (idx >= deckVisibleRange.start && idx <= deckVisibleRange.end);

                    return (
                      <DeckTurnCard
                        key={turn.turnKey}
                        turn={turn}
                        idx={idx}
                        relOffset={relOffset}
                        actionsAlwaysVisible={actionsAlwaysVisible}
                        isRangeHit={isRangeHit}
                        showChapter={showChapter}
                        deckFlowMode={deckFlowMode}
                        bodyOffsetSec={bodyOffsetSec}
                        activeTokenIdInTurn={
                          idx === activeTokenTurnIdx ? (activeTokenId ?? null) : null
                        }
                        selectedTokenIdsInTurn={turnSelection}
                        waveRangeStartSec={isRangeHit ? rangeStartSec : null}
                        waveRangeEndSec={isRangeHit ? rangeEndSec : null}
                        editingTokenIdInTurn={idx === editingTurnIdx ? editingHintTokenId : null}
                        draftHintTextInTurn={idx === editingTurnIdx ? draftHintText : ''}
                        saveHintToGlossaryInTurn={
                          idx === editingTurnIdx ? saveHintToGlossary : true
                        }
                        renderInteractiveTokens={renderInteractiveTokens}
                        canDelete={Boolean(onDeleteTokenIds)}
                        canMute={Boolean(onMuteTokenIds)}
                        canEditHint={Boolean(onApplyManualCorrection)}
                        canToggleOverlapMute={Boolean(onToggleOverlapMute)}
                        canToggleOverlapKeepFull={Boolean(onToggleOverlapKeepFull)}
                        callbacks={deckCallbacks}
                      />
                    );
                  })
                )}
              </div>
              {effectiveDeckPosition === 'top' && (
                <div
                  onPointerDown={handleStartResizeDeckHeight}
                  onDoubleClick={() => setDeckHeight(DEFAULT_DECK_HEIGHT)}
                  title="上下拖拽调整发言块提示区高度（双击恢复默认高度）"
                  className={`h-1.5 border-t border-zinc-800/80 cursor-ns-resize flex items-center justify-center transition-colors ${
                    resizingDeck ? 'bg-blue-500/30' : 'bg-zinc-900/90 hover:bg-zinc-800'
                  }`}
                >
                  <span
                    className={`w-8 h-0.5 rounded-full ${
                      resizingDeck ? 'bg-blue-400' : 'bg-zinc-600'
                    }`}
                  />
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* Single-line fixed-height top bar — prevents vertical height jumps when selecting ranges */}
      <div className="h-7 mb-1.5 flex items-center justify-between gap-2 text-xs overflow-x-auto shrink-0">
        <div className="flex items-center gap-2.5 shrink-0">
          {onSetWaveformSelectionMode && (
            <div
              className="inline-flex items-center rounded-md border border-zinc-700/90 bg-zinc-950 p-0.5 shrink-0"
              title="切换波形选区模式 (快捷键: N)：吸附模式会自动吸附到文字间隙；自由模式严格按照选区删除内容"
            >
              <button
                type="button"
                onClick={() => {
                  onSetWaveformSelectionMode('snap');
                  if (hasValidRange && totalSec > 0) {
                    const [snappedStartSec, snappedEndSec] = snapRangeToWordGaps(
                      rangeStartSec,
                      rangeEndSec,
                      wordGapSnapPoints,
                      minDragRatioSpan * totalSec
                    );
                    setSelStartRatio(snappedStartSec / totalSec);
                    setSelEndRatio(snappedEndSec / totalSec);
                  }
                }}
                title="吸附模式 (快捷键: N)：框选波形自动吸附到文字间隙，按字词边界智能剪辑"
                className={`px-1.5 py-0.5 rounded text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer transition ${
                  selectionMode === 'snap'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Magnet className="w-3 h-3" />
                <span>吸附</span>
              </button>
              <button
                type="button"
                onClick={() => onSetWaveformSelectionMode('free')}
                title="自由模式 (快捷键: N)：不吸附文字间隙，严格按照精确框选区间删除内容"
                className={`px-1.5 py-0.5 rounded text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer transition ${
                  selectionMode === 'free'
                    ? 'bg-amber-600 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Scissors className="w-3 h-3" />
                <span>自由</span>
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={toggleShowCutMarkers}
            title={showCutMarkers ? '点击隐藏波形上的剪辑处标注（点击波形上的「✂️ 剪辑」胶囊可查看详情或撤销）' : '点击显示波形上的剪辑处标注'}
            className={`px-2 py-0.5 rounded-md border text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer transition ${
              showCutMarkers
                ? 'bg-emerald-500/15 border-emerald-500/45 text-emerald-300 hover:bg-emerald-500/25'
                : 'bg-zinc-900 border-zinc-700/80 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Scissors className="w-3 h-3" />
            <span>剪辑标注{cutPoints.length > 0 ? ` (${cutPoints.length})` : ''}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setHoverScrubEnabled((prev) => {
                const next = !prev;
                if (!next) stopHoverScrub();
                onNotify?.(
                  next
                    ? '🎧 已开启时间轴划听：按住 ⌘ Cmd 并在时间轴或进度条移动鼠标，即可按速度播放对应音频'
                    : '🔇 已关闭时间轴 ⌘ 划听'
                );
                return next;
              });
            }}
            title={
              canHoverScrubAtZoom
                ? '开启后，按住 ⌘ (Cmd) 并在底部进度条或波形时间轴上移动鼠标，将实时跟随鼠标位置与速度播放对应音频（松开 ⌘ 或停下自动暂停）'
                : `需放大至 200x 以上方可使用按住 ⌘ 划听（当前 ${Math.round(zoom)}x）`
            }
            className={`px-2 py-0.5 rounded-md border text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer transition ${
              hoverScrubEnabled && canHoverScrubAtZoom
                ? cmdKeyHeld
                  ? 'bg-cyan-500/25 border-cyan-400 text-cyan-200 shadow-sm'
                  : 'bg-cyan-500/15 border-cyan-500/45 text-cyan-300 hover:bg-cyan-500/25'
                : 'bg-zinc-900 border-zinc-700/80 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Volume2 className="w-3 h-3" />
            <span ref={hoverScrubBtnLabelRef}>
              {!hoverScrubEnabled
                ? '划听已关'
                : !canHoverScrubAtZoom
                  ? '⌘ 划听 (≥200x)'
                  : cmdKeyHeld
                    ? '⌘ 划听就绪'
                    : '按住 ⌘ 划听'}
            </span>
          </button>

          {onToggleProxyEditing && (
            <button
              type="button"
              onClick={onToggleProxyEditing}
              title={
                state.proxyEditingEnabled !== false
                  ? '已开启代理文件剪辑（16kHz 轻量代理音轨，划听与加载提速 6x；最终导出仍使用原音质无损母带）'
                  : '当前为原音质监听模式；点击切换为轻量代理文件剪辑以提升划听与多轨性能'
              }
              className={`px-2 py-0.5 rounded-md border text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer transition ${
                state.proxyEditingEnabled !== false
                  ? 'bg-amber-500/15 border-amber-500/45 text-amber-300 hover:bg-amber-500/25'
                  : 'bg-zinc-900 border-zinc-700/80 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Sparkles className="w-3 h-3" />
              <span>{state.proxyEditingEnabled !== false ? '代理剪辑' : '原音质'}</span>
            </button>
          )}

          {onOpenCutReportModal && (
            <button
              type="button"
              onClick={() => onOpenCutReportModal('cuts')}
              title="统一查看全部剪辑处、生成剪辑分析报告、嘉宾表达建议及导出分析图片/习惯配置"
              className="px-2 py-0.5 rounded-md border border-blue-500/40 bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer transition"
            >
              <BarChart3 className="w-3 h-3" />
              <span>剪辑总览与报告</span>
            </button>
          )}

          {hasValidRange ? (
            <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-blue-500/15 border border-blue-500/40">
              <span className="text-blue-300 font-mono tabular-nums font-semibold">
                {formatPrecisionSec(rangeStartSec, rangeSpanSec < 10 || visibleWindowSec <= 25 ? 2 : 1)}
                –
                {formatPrecisionSec(rangeEndSec, rangeSpanSec < 10 || visibleWindowSec <= 25 ? 2 : 1)}{' '}
                (
                {rangeSpanSec < 1
                  ? `${Math.round(rangeSpanSec * 1000)}ms`
                  : `${rangeSpanSec.toFixed(2)}s`}
                )
              </span>
              <button
                onClick={() => triggerRangeOp('ripple_all')}
                title="删除所有轨道的框选区间并后续吸附"
                className="px-2 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white font-semibold flex items-center gap-1 cursor-pointer transition"
              >
                <Scissors className="w-3 h-3" />
                <span>全轨切除吸附</span>
              </button>
              <button
                onClick={() => triggerRangeOp('mute_lane')}
                title="仅静音当前鼠标悬停或选中的单条轨道区间，总时长保持不变"
                className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-600 flex items-center gap-1 cursor-pointer transition"
              >
                <VolumeX className="w-3 h-3" />
                <span>静音{targetTrack?.name ?? '此'}轨</span>
              </button>
              <button
                onClick={() => triggerRangeOp('bleep_range')}
                title="将框选时间区间的音频替换为 1kHz「哔——」消音并对对应文稿脱敏 (按 B)"
                className="px-2 py-0.5 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold flex items-center gap-1 cursor-pointer transition shadow-xs"
              >
                <ShieldAlert className="w-3 h-3" />
                <span>替换「哔」 (B)</span>
              </button>
              <button
                onClick={() => triggerRangeOp('add_highlight')}
                title="将波形框选片段加入左侧「金句列表」与右侧「高光片头」"
                className="px-2 py-0.5 rounded bg-purple-600 hover:bg-purple-500 text-white font-semibold flex items-center gap-1 cursor-pointer transition"
              >
                <Sparkles className="w-3 h-3" />
                <span>加入金句</span>
              </button>
              <button
                onClick={() => {
                  setSelStartRatio(null);
                  setSelEndRatio(null);
                }}
                className="text-zinc-400 hover:text-white px-1 cursor-pointer"
                title="取消选区"
              >
                ✕
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-zinc-400">
              {resizingHeight && (
                <span className="px-1.5 py-0.5 rounded bg-blue-500/15 border border-blue-500/35 font-mono text-[11px] text-blue-300">
                  高度 {dockHeight}px
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* 快捷播放控制条 */}
          <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg bg-zinc-950/90 border border-zinc-800">
            <button
              onClick={() => onSeekToSec(0)}
              title="回到片头 00:00 (快捷键: 0 / Home)"
              className="p-1 text-zinc-400 hover:text-zinc-100 rounded hover:bg-zinc-800 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
            <button
              onClick={() => onStepPlayhead(-5)}
              title="快退 5 秒 (快捷键: ← 或 J；Shift+← 快退 1s)"
              className="px-1.5 py-0.5 text-zinc-300 hover:text-white rounded hover:bg-zinc-800 flex items-center gap-0.5 font-mono text-[11px] cursor-pointer"
            >
              <Rewind className="w-3 h-3" />
              <span>5s</span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.currentTarget.blur();
                if (
                  !isPlaying &&
                  hasValidRange &&
                  (getEffectivePlayheadSec() < rangeStartSec - 0.05 ||
                    getEffectivePlayheadSec() >= rangeEndSec - 0.05)
                ) {
                  onSeekToSec(rangeStartSec);
                }
                onTogglePlay();
              }}
              title="播放 / 暂停 (快捷键: Space 空格 或 K)"
              className={`px-2 py-0.5 rounded font-semibold flex items-center gap-1 cursor-pointer transition ${
                isPlaying
                  ? 'bg-amber-500 text-zinc-950'
                  : 'bg-blue-600 hover:bg-blue-500 text-white'
              }`}
            >
              {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              <span>{isPlaying ? '暂停' : '播放'}</span>
            </button>
            <button
              onClick={() => onStepPlayhead(5)}
              title="快进 5 秒 (快捷键: → 或 L；Shift+→ 快进 1s)"
              className="px-1.5 py-0.5 text-zinc-300 hover:text-white rounded hover:bg-zinc-800 flex items-center gap-0.5 font-mono text-[11px] cursor-pointer"
            >
              <span>5s</span>
              <FastForward className="w-3 h-3" />
            </button>
          </div>

          {onInsertSilenceAtPlayhead && (
            <div
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-lg bg-zinc-950/90 border border-zinc-800 text-[11px]"
              title="在当前播放游标处插入空白静音时长"
            >
              <select
                value={insertSilenceSec}
                onChange={(e) => setInsertSilenceSec(Number(e.target.value))}
                className="bg-zinc-900 border border-zinc-700/80 rounded px-1 py-0.5 text-zinc-200 font-mono text-[10.5px] focus:outline-none cursor-pointer"
              >
                {[0.5, 1.0, 2.0, 3.0, 5.0].map((sec) => (
                  <option key={sec} value={sec} className="bg-zinc-900 text-zinc-100">
                    {sec.toFixed(1)}s
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!hasLoadedTimeline}
                onClick={() => onInsertSilenceAtPlayhead(insertSilenceSec)}
                className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 font-medium cursor-pointer disabled:cursor-default transition"
              >
                + 插入空白
              </button>
            </div>
          )}

          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-zinc-950/90 border border-zinc-800 text-zinc-400">
            <button
              onClick={() => applyZoomAtAnchor(1)}
              disabled={zoom <= 1.01}
              title="还原全片 1x 总览 (快捷键: \)"
              className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-900 hover:bg-zinc-800 text-zinc-300 disabled:opacity-35 cursor-pointer disabled:cursor-default"
            >
              全览
            </button>
            <button
              onClick={() => adjustZoomStep(1 / 1.5)}
              disabled={zoom <= 1}
              className="p-0.5 hover:text-zinc-100 disabled:opacity-35 cursor-pointer disabled:cursor-default"
              title="缩小波形时间轴 (快捷键: - 或 ⌘+滚轮向下)"
            >
              <Minus className="w-3 h-3" />
            </button>
            <input
              type="range"
              min={0}
              max={1000}
              step={1}
              value={zoomToSliderVal(zoom, maxZoom)}
              onChange={(e) => applyZoomAtAnchor(sliderValToZoom(Number(e.target.value), maxZoom))}
              onKeyDown={(e) => {
                if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                  onTogglePlay();
                }
              }}
              title={`对数无级波形缩放（最高 ${maxZoom}x，最小视窗 ${MIN_VISIBLE_SEC}s）`}
              className="w-24 accent-blue-500 cursor-pointer"
            />
            <button
              onClick={() => adjustZoomStep(1.5)}
              disabled={zoom >= maxZoom}
              className="p-0.5 hover:text-zinc-100 disabled:opacity-35 cursor-pointer disabled:cursor-default"
              title="放大波形时间轴 (快捷键: +/= 或 ⌘+滚轮向上)"
            >
              <Plus className="w-3 h-3" />
            </button>
            <button
              onClick={() => applyZoomAtAnchor(100)}
              disabled={!hasLoadedTimeline}
              title="一键切换至 100x 按字词标注时间轴视图"
              className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold inline-flex items-center gap-0.5 cursor-pointer disabled:opacity-35 disabled:cursor-default transition ${
                wordTimelineMode
                  ? 'bg-sky-500/25 border-sky-400/60 text-sky-200'
                  : 'bg-zinc-900 hover:bg-zinc-800 border-zinc-700 text-zinc-300'
              }`}
            >
              <span>100x字词</span>
            </button>
            <button
              onClick={handleFocusPrecisionWindow}
              disabled={!hasLoadedTimeline || zoom >= maxZoom}
              title="一键放大聚焦到当前播放头附近的逐字/气口毫秒级精剪视窗（最小可达 0.25s）"
              className="px-1.5 py-0.5 rounded bg-blue-600/20 hover:bg-blue-600/35 border border-blue-500/40 text-blue-300 text-[10px] font-semibold inline-flex items-center gap-0.5 cursor-pointer disabled:opacity-35 disabled:cursor-default"
            >
              <Search className="w-2.5 h-2.5" />
              <span>精剪</span>
            </button>
            <span
              title={`当前放大倍数 ${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}x · 当前可见时间窗 ${visibleWindowSec.toFixed(2)}s`}
              className="font-mono tabular-nums text-[11px] text-zinc-200 min-w-[78px] text-right"
            >
              {zoom < 10 ? `${zoom.toFixed(1)}x` : `${Math.round(zoom)}x`}
              <span className="text-zinc-500 ml-1">
                ({visibleWindowSec < 10 ? `${visibleWindowSec.toFixed(1)}s` : visibleWindowSec < 60 ? `${Math.round(visibleWindowSec)}s` : formatMmSs(visibleWindowSec)})
              </span>
            </span>
          </div>

          <div className="px-2.5 py-0.5 rounded-lg bg-zinc-950/90 border border-zinc-800 font-mono tabular-nums text-zinc-400">
            <PlayheadTimeText bodyOffsetSec={bodyOffsetSec} className="text-zinc-100 font-semibold" />
            <span className="mx-1 text-zinc-600">/</span>
            <span className="text-emerald-400 font-semibold">
              {formatMmSs(timeline.totalEditedDurationSec)}.{Math.floor((timeline.totalEditedDurationSec % 1) * 10)}
            </span>
          </div>
        </div>
      </div>

      {/* 全片播放进度条：点击文稿任意字词或直接点击/拖拽此进度条均可精准跳转播放位置 */}
      <div className="mb-1.5 px-2.5 py-1 rounded-lg bg-zinc-950/90 border border-zinc-800/85 flex items-center gap-2.5 select-none shrink-0">
        <PlayheadTimeText
          bodyOffsetSec={bodyOffsetSec}
          className="font-mono tabular-nums text-[11px] text-blue-300 font-semibold w-14 shrink-0"
        />

        <div
          ref={scrubberRef}
          role="slider"
          aria-label="播放进度条"
          aria-valuemin={0}
          aria-valuemax={Number(timeline.totalEditedDurationSec.toFixed(2))}
          title="全片播放进度条：单击或左右拖动可随时跳转，单击上方文字稿任意字词也会同步跳至此位置"
          onPointerDown={(e) => {
            if (!hasLoadedTimeline || e.button !== 0) return;
            stopHoverScrub();
            e.currentTarget.setPointerCapture(e.pointerId);
            manualScrollLockUntilRef.current = 0;
            waveformManualPanUntilRef.current = 0;
            setScrubbing(true);
            seekFromScrubberClientX(e.clientX, false);
          }}
          onPointerMove={(e) => {
            const el = scrubberRef.current;
            const tooltip = scrubHoverTooltipRef.current;
            if (el && hasLoadedTimeline) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0) {
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const hoverTime = ratio * timeline.totalEditedDurationSec;
                let scrubRate: number | null = null;
                if (!scrubbing && hoverScrubEnabled && e.metaKey) {
                  const targetBodySec = Math.max(0, hoverTime - bodyOffsetSec);
                  scrubRate = triggerHoverScrubAtBodySec(targetBodySec);
                } else if (!e.metaKey) {
                  stopHoverScrub();
                }
                if (tooltip) {
                  tooltip.style.display = 'block';
                  tooltip.style.left = `${ratio * 100}%`;
                  const baseTimeText = `${formatMmSs(hoverTime)}.${Math.floor((hoverTime % 1) * 10)}`;
                  tooltip.textContent =
                    scrubRate !== null ? `${baseTimeText} · 🎧 ${scrubRate.toFixed(1)}x` : baseTimeText;
                }
              }
            }
            if (scrubbing) {
              manualScrollLockUntilRef.current = 0;
              waveformManualPanUntilRef.current = 0;
              seekFromScrubberClientX(e.clientX, true);
            }
          }}
          onPointerUp={(e) => {
            if (scrubbing) {
              seekFromScrubberClientX(e.clientX, false);
              setScrubbing(false);
            }
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
          }}
          onPointerCancel={() => {
            setScrubbing(false);
            stopHoverScrub();
          }}
          onMouseLeave={() => {
            stopHoverScrub();
            if (!scrubbing && scrubHoverTooltipRef.current) {
              scrubHoverTooltipRef.current.style.display = 'none';
            }
          }}
          className={`relative flex-1 h-4 flex items-center group ${
            hasLoadedTimeline ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
          }`}
        >
          {/* 背景轨道槽 */}
          <div className="relative w-full h-1.5 group-hover:h-2 transition-all rounded-full bg-zinc-800/95 overflow-hidden">
            {/* Cold Open 高光先导段底色 */}
            {coldOpenPct > 0 && (
              <div
                style={{ left: '0%', width: `${coldOpenPct}%` }}
                className="absolute inset-y-0 bg-purple-500/35"
              />
            )}
            {/* 片头口播段底色 */}
            {introVoPct > 0 && (
              <div
                style={{ left: `${introVoStartPct}%`, width: `${introVoPct}%` }}
                className="absolute inset-y-0 bg-amber-500/35"
              />
            )}
            {/* 已播放进度条填充 */}
            <ScrubberProgressFill totalSec={timeline.totalEditedDurationSec} bodyOffsetSec={bodyOffsetSec} />
          </div>

          {/* 放大状态下在全片进度条上实时标出当前波形视窗范围 (Minimap Viewport Window) */}
          {hasLoadedTimeline && zoom > 1.02 && (
            <div
              style={{
                left: `${viewStartRatio * 100}%`,
                width: `${Math.max(0.6, Math.min(100 - viewStartRatio * 100, (1 / zoom) * 100))}%`,
              }}
              className="absolute top-1/2 -translate-y-1/2 h-3 rounded-sm border border-cyan-300/80 bg-cyan-400/15 shadow-[0_0_6px_rgba(34,211,238,0.35)] pointer-events-none"
            />
          )}

          {/* 章节锚点微标 */}
          {hasLoadedTimeline &&
            timeline.chapters.map((ch, idx) => {
              if (ch.timeSec <= 0 || ch.timeSec >= timeline.totalEditedDurationSec) return null;
              const pct = (ch.timeSec / timeline.totalEditedDurationSec) * 100;
              return (
                <span
                  key={`${ch.title}_${idx}`}
                  style={{ left: `${pct}%` }}
                  title={`章节：${ch.title} (${ch.timeFormatted})`}
                  className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-1 h-2 rounded-full bg-zinc-400/70 pointer-events-none"
                />
              );
            })}

          {/* 语音重合区进度条紫标 */}
          {hasLoadedTimeline &&
            (timeline.overlapRegions ?? []).map((ov) => {
              const leftPct = Math.max(
                0,
                Math.min(100, (ov.editedStartSec / timeline.totalEditedDurationSec) * 100)
              );
              const widthPct = Math.max(
                0.35,
                Math.min(
                  100 - leftPct,
                  ((ov.editedEndSec - ov.editedStartSec) / timeline.totalEditedDurationSec) * 100
                )
              );
              return (
                <span
                  key={ov.id}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  title={`语音重合：主讲 ${ov.primarySpeakerName} + 副轨 ${ov.secondarySpeakerName}`}
                  className="absolute top-1/2 -translate-y-1/2 h-2.5 rounded-sm bg-purple-400/65 pointer-events-none"
                />
              );
            })}

          {/* 悬停时间预览浮标（直接 DOM 更新，零 React 重渲染） */}
          <div
            ref={scrubHoverTooltipRef}
            style={{ display: 'none' }}
            className="absolute -top-6 -translate-x-1/2 px-1.5 py-0.5 rounded bg-zinc-900/95 border border-zinc-700 text-[10px] font-mono tabular-nums text-zinc-100 shadow pointer-events-none whitespace-nowrap z-20"
          />

          {/* 播放滑块圆点 (Thumb) */}
          <ScrubberThumb
            totalSec={timeline.totalEditedDurationSec}
            bodyOffsetSec={bodyOffsetSec}
            scrubbing={scrubbing}
          />
        </div>

        <span className="font-mono tabular-nums text-[11px] text-zinc-400 w-20 text-right shrink-0">
          <span className="text-emerald-400 font-semibold">
            {formatMmSs(timeline.totalEditedDurationSec)}.
            {Math.floor((timeline.totalEditedDurationSec % 1) * 10)}
          </span>
          <ScrubberPercentText totalSec={timeline.totalEditedDurationSec} bodyOffsetSec={bodyOffsetSec} />
        </span>
      </div>

      {/* Studio Timeline Dock: Native Crisp DOM Track Headers + Retina HiDPI Waveform Canvas */}
      <div
        style={isMainStage ? undefined : { height: `${dockHeight}px` }}
        className={`${
          isMainStage ? 'flex-1 min-h-[210px]' : ''
        } flex rounded-xl border bg-zinc-950 overflow-hidden shadow-inner transition-all duration-300 ${
          waveformFocusPulse
            ? 'border-emerald-400/80 shadow-[0_0_16px_rgba(52,211,153,0.28)] ring-1 ring-emerald-400/40'
            : 'border-zinc-800/90'
        }`}
      >
        {/* Left Crisp DOM Track Header Column */}
        <div className="w-[176px] shrink-0 border-r border-zinc-800/90 bg-zinc-900/75 flex flex-col">
          <div
            style={{ height: `${rulerHeightPx}px` }}
            className="shrink-0 border-b border-zinc-800/80 px-2.5 flex flex-col justify-center text-[10px] font-mono tracking-wider text-zinc-500"
          >
            <div className="flex items-center justify-between leading-none">
              <span>TRACKS ({speakerTracks.length + (hasBgmTrack ? 1 : 0)})</span>
              <span>48kHz</span>
            </div>
            {wordTimelineMode && (
              <div className="mt-1 flex items-center justify-between text-[9px] text-sky-300/90 leading-none">
                <span>字词时间轴</span>
                <span>{Math.round(zoom)}x</span>
              </div>
            )}
          </div>

          <div className="flex-1 flex flex-col divide-y divide-zinc-800/60 min-h-0">
            {speakerTracks.map((tr, idx) => {
              const shortRole = tr.roleLabel.split(' ')[0];
              const dbText = state.loudnessAligned
                ? `${tr.autoGainDb >= 0 ? '+' : ''}${tr.autoGainDb.toFixed(1)}dB`
                : `${tr.rawLufs.toFixed(0)}LUFS`;
              const isDimmed = tr.muted || (anySolo && !tr.solo);

              return (
                <div
                  key={tr.id}
                  onMouseEnter={() => setHoverLaneIdx(idx)}
                  onMouseLeave={() => setHoverLaneIdx(null)}
                  className={`flex-1 min-h-0 px-2.5 flex items-center justify-between gap-1.5 transition-colors ${
                    hoverLaneIdx === idx ? 'bg-zinc-800/45' : ''
                  } ${isDimmed ? 'opacity-55' : ''}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-1 h-5 rounded-full shrink-0"
                      style={{
                        backgroundColor: tr.color,
                        boxShadow: isDimmed ? 'none' : `0 0 8px ${hexToRgba(tr.color, 0.55)}`,
                      }}
                    />
                    <div className="min-w-0 leading-tight flex-1">
                      {editingTrackId === tr.id ? (
                        <div className="flex items-center gap-0.5">
                          <input
                            type="text"
                            value={draftTrackName}
                            onChange={(e) => setDraftTrackName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                commitWaveformTrackRename(tr.id);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setEditingTrackId(null);
                              }
                            }}
                            onBlur={() => commitWaveformTrackRename(tr.id)}
                            autoFocus
                            placeholder="嘉宾/主播..."
                            className="w-full min-w-0 px-1 py-0.5 rounded border border-blue-500/70 bg-zinc-950 text-[11px] font-semibold text-zinc-100 focus:outline-none"
                          />
                          <button
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              commitWaveformTrackRename(tr.id);
                            }}
                            className="p-0.5 rounded bg-blue-600 text-white shrink-0 cursor-pointer"
                          >
                            <Check className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            if (!onRenameSpeakerTrack) return;
                            setEditingTrackId(tr.id);
                            setDraftTrackName(tr.name);
                          }}
                          title="点击设置该音轨对应的嘉宾/主播姓名"
                          className="group/wname inline-flex items-center gap-1 max-w-full text-left cursor-pointer"
                        >
                          <span className="text-xs font-semibold text-zinc-100 group-hover/wname:text-blue-300 truncate antialiased">
                            {tr.name}
                          </span>
                          {onRenameSpeakerTrack && (
                            <Pencil className="w-2.5 h-2.5 text-zinc-500 group-hover/wname:text-blue-400 shrink-0 opacity-70 group-hover/wname:opacity-100" />
                          )}
                        </button>
                      )}
                      <div className="text-[10px] text-zinc-400/90 font-mono whitespace-nowrap">
                        {shortRole} · {dbText}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {onToggleTrackSolo && (
                      <button
                        onClick={() => onToggleTrackSolo(tr.id)}
                        title={`独奏 ${tr.name} (Solo)`}
                        className={`w-[18px] h-[18px] rounded text-[10px] font-mono font-bold flex items-center justify-center transition cursor-pointer ${
                          tr.solo
                            ? 'bg-amber-500 text-zinc-950 shadow-xs'
                            : 'bg-zinc-800/90 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700'
                        }`}
                      >
                        S
                      </button>
                    )}
                    {onToggleTrackMute && (
                      <button
                        onClick={() => onToggleTrackMute(tr.id)}
                        title={`静音 ${tr.name} (Mute)`}
                        className={`w-[18px] h-[18px] rounded text-[10px] font-mono font-bold flex items-center justify-center transition cursor-pointer ${
                          tr.muted
                            ? 'bg-red-500/90 text-white shadow-xs'
                            : 'bg-zinc-800/90 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700'
                        }`}
                      >
                        M
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {hasBgmTrack && (
              <div
                style={{
                  height: `${BGM_LANE_COMPACT_H}px`,
                  minHeight: `${BGM_LANE_COMPACT_H}px`,
                  maxHeight: `${BGM_LANE_COMPACT_H}px`,
                }}
                onMouseEnter={() => setHoverLaneIdx(speakerTracks.length)}
                onMouseLeave={() => setHoverLaneIdx(null)}
                className={`px-2 flex items-center justify-between gap-1 transition-colors border-t border-cyan-500/20 ${
                  hoverLaneIdx === speakerTracks.length ? 'bg-cyan-950/30' : 'bg-cyan-950/10'
                } ${isBgmDimmed ? 'opacity-55' : ''}`}
              >
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <span
                    className="w-1 h-3.5 rounded-full shrink-0 bg-cyan-400"
                    style={{
                      boxShadow: isBgmDimmed ? 'none' : '0 0 6px rgba(6, 182, 212, 0.65)',
                    }}
                  />
                  <div className="min-w-0 flex items-center gap-1.5 flex-1">
                    <span className="text-[11px] font-semibold text-cyan-200 truncate">
                      🎵 BGM 垫乐轨
                    </span>
                    <div className="flex items-center gap-1 text-[9px] font-mono text-cyan-400/80 shrink-0">
                      {hasIntroBgm && (
                        <span className="px-1 py-0.2 rounded bg-cyan-950/80 border border-cyan-500/30 text-cyan-300">
                          片头固定 {introBgmEndSec.toFixed(0)}s
                        </span>
                      )}
                      {hasOutroBgm && (
                        <span className="px-1 py-0.2 rounded bg-emerald-950/80 border border-emerald-500/30 text-emerald-300">
                          片尾截取 {effectiveOutroDurationSec.toFixed(1)}s
                        </span>
                      )}
                      <span className="text-zinc-500 hidden xl:inline">· 自动适应音量</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {onToggleBgmSolo && (
                    <button
                      onClick={onToggleBgmSolo}
                      title="独奏 BGM 垫乐 (Solo)"
                      className={`w-[16px] h-[16px] rounded text-[9px] font-mono font-bold flex items-center justify-center transition cursor-pointer ${
                        state.introBgm?.solo || state.outroBgm?.solo
                          ? 'bg-amber-500 text-zinc-950 shadow-xs'
                          : 'bg-zinc-800/90 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700'
                      }`}
                    >
                      S
                    </button>
                  )}
                  {onToggleBgmMute && (
                    <button
                      onClick={onToggleBgmMute}
                      title="静音 BGM 垫乐 (Mute)"
                      className={`w-[16px] h-[16px] rounded text-[9px] font-mono font-bold flex items-center justify-center transition cursor-pointer ${
                        state.introBgm?.muted || state.outroBgm?.muted
                          ? 'bg-red-500/90 text-white shadow-xs'
                          : 'bg-zinc-800/90 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700'
                      }`}
                    >
                      M
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Retina HiDPI Canvas Viewport */}
        <div ref={containerRef} className="relative flex-1 h-full min-w-0">
          <canvas
            ref={canvasRef}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              const { ratio, laneIdx, hoveredLaneIdx, localX, localY, rectWidth, rectHeight } = extractCanvasPos(
                e.clientX,
                e.clientY
              );
              const zone = detectCanvasHoverZone(localX, localY, rectWidth, rectHeight);
              manualScrollLockUntilRef.current = 0;
              waveformManualPanUntilRef.current = 0;
              hoverRatioRef.current = ratio;
              setHoverLaneIdx((prev) => (prev === hoveredLaneIdx ? prev : hoveredLaneIdx));
              setHoverZoneFast(zone);
              scheduleOverlayDraw();
              e.currentTarget.setPointerCapture(e.pointerId);

              if (zone === 'cut_badge') {
                const hitBox = cutBadgeHitBoxesRef.current.find(
                  (b) => localX >= b.x1 && localX <= b.x2 && localY >= b.y1 && localY <= b.y2
                );
                if (hitBox && cutPoints.length > 0 && onInspectCutPoint) {
                  let best = cutPoints[0];
                  let bestDiff = Math.abs((best.editedSec - bodyOffsetSec) - hitBox.editedSec);
                  for (const c of cutPoints) {
                    const diff = Math.abs((c.editedSec - bodyOffsetSec) - hitBox.editedSec);
                    if (diff < bestDiff) {
                      best = c;
                      bestDiff = diff;
                    }
                  }
                  onInspectCutPoint(best, { x: e.clientX, y: e.clientY });
                  return;
                }
              }

              if (zone === 'outro_trim_handle') {
                setOutroTrimDragging(true);
                outroTrimActiveRef.current = true;
                return;
              }

              if (zone === 'playhead' || zone === 'ruler') {
                setPlayheadDragging(true);
                onSeekToSec(ratio * totalSec);
                return;
              }
              setDragging(true);
              dragRawStartRatioRef.current = ratio;
              setSelStartRatio(ratio);
              setSelEndRatio(ratio);
              setSelLaneIdx(laneIdx);
            }}
            onPointerMove={(e) => {
              const { ratio, hoveredLaneIdx, localX, localY, rectWidth, rectHeight } = extractCanvasPos(
                e.clientX,
                e.clientY
              );
              const effectiveRatio =
                playheadDragging || dragging || outroTrimDragging
                  ? resolveDragRatioWithAutoPan(localX, rectWidth, ratio)
                  : ratio;
              hoverRatioRef.current = effectiveRatio;
              setHoverLaneIdx((prev) => (prev === hoveredLaneIdx ? prev : hoveredLaneIdx));
              scheduleOverlayDraw();

              if (outroTrimActiveRef.current) {
                const dragSec = Math.max(0, Math.min(totalSec, effectiveRatio * totalSec));
                const minStart = hasIntroBgm ? introBgmEndSec + 0.5 : 0;
                const clampedDragSec = Math.max(minStart, Math.min(totalSec - 1.5, dragSec));
                const nextDuration = Math.max(1.5, totalSec - clampedDragSec);
                setDraftOutroDurationSec(Number(nextDuration.toFixed(1)));
                setHoverZoneFast('outro_trim_handle');
                return;
              }

              if (playheadDragging) {
                manualScrollLockUntilRef.current = 0;
                setHoverZoneFast('playhead');
                seekDuringDrag(effectiveRatio * totalSec);
                return;
              }
              if (dragging) {
                const rawStart = dragRawStartRatioRef.current ?? ratio;
                if (
                  selectionMode === 'snap' &&
                  totalSec > 0 &&
                  Math.abs(effectiveRatio - rawStart) > minDragRatioSpan
                ) {
                  const [snappedStartSec, snappedEndSec] = snapRangeToWordGaps(
                    rawStart * totalSec,
                    effectiveRatio * totalSec,
                    wordGapSnapPoints,
                    minDragRatioSpan * totalSec
                  );
                  setSelStartRatio(snappedStartSec / totalSec);
                  setSelEndRatio(snappedEndSec / totalSec);
                } else {
                  setSelStartRatio(rawStart);
                  setSelEndRatio(effectiveRatio);
                }
                return;
              }
              const nextZone = detectCanvasHoverZone(localX, localY, rectWidth, rectHeight);
              setHoverZoneFast(nextZone);
              if (e.metaKey && hoverScrubEnabled && totalSec > 0) {
                triggerHoverScrubAtBodySec(effectiveRatio * totalSec);
                scheduleOverlayDraw();
              } else {
                stopHoverScrub();
              }
            }}
            onPointerUp={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
              }
              const { ratio, localX, localY, rectWidth, rectHeight } = extractCanvasPos(e.clientX, e.clientY);

              if (outroTrimActiveRef.current) {
                outroTrimActiveRef.current = false;
                setOutroTrimDragging(false);
                if (draftOutroDurationSec !== null) {
                  onUpdateBgmAsset?.('outro', {
                    customDurationSec: draftOutroDurationSec,
                    enabled: true,
                  });
                  onNotify?.(`✂️ 已截取片尾 BGM 时长为 ${draftOutroDurationSec} 秒（自动适应音量）`);
                }
                setDraftOutroDurationSec(null);
                setHoverZoneFast(detectCanvasHoverZone(localX, localY, rectWidth, rectHeight));
                return;
              }

              if (playheadDragging) {
                const effectiveRatio = resolveDragRatioWithAutoPan(localX, rectWidth, ratio);
                manualScrollLockUntilRef.current = 0;
                onSeekToSec(effectiveRatio * totalSec);
                setPlayheadDragging(false);
                setHoverZoneFast(detectCanvasHoverZone(localX, localY, rectWidth, rectHeight));
                return;
              }
              if (!dragging) return;
              setDragging(false);
              const rawStart = dragRawStartRatioRef.current;
              dragRawStartRatioRef.current = null;
              const effectiveRatio = resolveDragRatioWithAutoPan(localX, rectWidth, ratio);
              const rawSpan =
                rawStart !== null ? Math.abs(effectiveRatio - rawStart) : 0;
              if (
                rawSpan <= minDragRatioSpan &&
                selStartRatio !== null &&
                selEndRatio !== null &&
                Math.abs(selEndRatio - selStartRatio) <= minDragRatioSpan
              ) {
                manualScrollLockUntilRef.current = 0;
                onSeekToSec((rawStart ?? selStartRatio) * totalSec);
                setSelStartRatio(null);
                setSelEndRatio(null);
              }
            }}
            onPointerCancel={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
              }
              if (outroTrimActiveRef.current) {
                outroTrimActiveRef.current = false;
                setOutroTrimDragging(false);
                setDraftOutroDurationSec(null);
              }
              setPlayheadDragging(false);
              setDragging(false);
              dragRawStartRatioRef.current = null;
              setHoverZoneFast('none');
            }}
            onPointerLeave={() => {
              stopHoverScrub();
              if (!playheadDragging && !dragging && !outroTrimActiveRef.current) {
                hoverRatioRef.current = null;
                scheduleOverlayDraw();
                setHoverLaneIdx(null);
                setHoverZoneFast('none');
              }
            }}
            onContextMenu={(e) => {
              const { ratio } = extractCanvasPos(e.clientX, e.clientY);
              const clickedSec = ratio * totalSec;
              const hitOverlap = timeline.overlapRegions?.find(
                (ov) => clickedSec >= ov.editedStartSec - 0.02 && clickedSec <= ov.editedEndSec + 0.02
              );
              if (hitOverlap && (!hasValidRange || Math.abs(rangeStartSec - hitOverlap.editedStartSec) > 0.5)) {
                const r1 = Math.max(0, hitOverlap.editedStartSec / totalSec);
                const r2 = Math.min(1, hitOverlap.editedEndSec / totalSec);
                setSelStartRatio(r1);
                setSelEndRatio(r2);
                e.preventDefault();
                setTokenContextMenu(null);
                setWaveContextMenu({ x: e.clientX, y: e.clientY });
                return;
              }
              if (!hasValidRange) return;
              e.preventDefault();
              setTokenContextMenu(null);
              setWaveContextMenu({ x: e.clientX, y: e.clientY });
            }}
            onDoubleClick={(e) => {
              const { ratio } = extractCanvasPos(e.clientX, e.clientY);
              const clickedSec = ratio * totalSec;
              const hitOverlap = timeline.overlapRegions?.find(
                (ov) => clickedSec >= ov.editedStartSec - 0.02 && clickedSec <= ov.editedEndSec + 0.02
              );
              if (hitOverlap) {
                const r1 = Math.max(0, hitOverlap.editedStartSec / totalSec);
                const r2 = Math.min(1, hitOverlap.editedEndSec / totalSec);
                setSelStartRatio(r1);
                setSelEndRatio(r2);
                onSeekToSec(hitOverlap.editedStartSec);
              }
            }}
            className={`block w-full h-full touch-none ${
              playheadDragging
                ? 'cursor-ew-resize'
                : outroTrimDragging
                ? 'cursor-col-resize'
                : 'cursor-crosshair'
            }`}
          />
        </div>
      </div>

      {tokenContextMenu && selectedCount > 0 && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            left: Math.min(tokenContextMenu.x, Math.max(8, window.innerWidth - 190)),
            top: Math.min(tokenContextMenu.y, Math.max(8, window.innerHeight - 210)),
          }}
          className="fixed z-50 w-44 rounded-lg border border-zinc-700 bg-zinc-900/95 backdrop-blur-md shadow-2xl py-1 text-xs text-zinc-200"
        >
          {onAddSelectedToHighlight && (
            <button
              type="button"
              onClick={() => {
                setTokenContextMenu(null);
                onAddSelectedToHighlight();
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-purple-600/25 text-purple-200 flex items-center gap-2 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-purple-400" />
              <span>加入金句 ({selectedCount})</span>
            </button>
          )}
          {onRippleDeleteSelected && (
            <button
              type="button"
              onClick={() => {
                setTokenContextMenu(null);
                onRippleDeleteSelected();
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-red-600/25 text-red-300 flex items-center gap-2 cursor-pointer"
            >
              <Scissors className="w-3.5 h-3.5 text-red-400" />
              <span>切掉选中</span>
            </button>
          )}
          {onMuteTrackSelected && (
            <button
              type="button"
              onClick={() => {
                setTokenContextMenu(null);
                onMuteTrackSelected();
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-zinc-800 flex items-center gap-2 cursor-pointer"
            >
              <VolumeX className="w-3.5 h-3.5 text-zinc-400" />
              <span>静音选中</span>
            </button>
          )}
          {onBleepSelected && (
            <button
              type="button"
              onClick={() => {
                setTokenContextMenu(null);
                onBleepSelected();
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-amber-600/20 text-amber-300 flex items-center gap-2 cursor-pointer"
            >
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
              <span>哔声消音</span>
            </button>
          )}
          {onCancelDuckingSelected && (
            <button
              type="button"
              onClick={() => {
                setTokenContextMenu(null);
                onCancelDuckingSelected();
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-emerald-600/25 text-emerald-300 flex items-center gap-2 cursor-pointer"
            >
              <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>{isSelectedTokensAllFullVolume ? '恢复主发言避让' : '切换原声 (取消避让)'}</span>
            </button>
          )}
          {onClearSelection && (
            <button
              type="button"
              onClick={() => {
                setTokenContextMenu(null);
                onClearSelection();
              }}
              className="w-full px-3 py-1.5 text-left border-t border-zinc-800 mt-1 pt-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
            >
              取消选中
            </button>
          )}
        </div>
      )}

      {waveContextMenu && hasValidRange && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            left: Math.min(waveContextMenu.x, Math.max(8, window.innerWidth - 196)),
            top: Math.min(waveContextMenu.y, Math.max(8, window.innerHeight - 210)),
          }}
          className="fixed z-50 w-48 rounded-lg border border-zinc-700 bg-zinc-900/95 backdrop-blur-md shadow-2xl py-1 text-xs text-zinc-200"
        >
          <button
            type="button"
            onClick={() => {
              setWaveContextMenu(null);
              onSeekToSec(rangeStartSec);
              if (!isPlaying) onTogglePlay();
            }}
            className="w-full px-3 py-1.5 text-left hover:bg-blue-600/25 text-blue-300 flex items-center gap-2 cursor-pointer font-medium"
          >
            <Play className="w-3.5 h-3.5 text-blue-400" />
            <span>试听选区 ({rangeSpanSec.toFixed(2)}s)</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setWaveContextMenu(null);
              triggerRangeOp('add_highlight');
            }}
            className="w-full px-3 py-1.5 text-left hover:bg-purple-600/25 text-purple-200 flex items-center gap-2 cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5 text-purple-400" />
            <span>加入金句</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setWaveContextMenu(null);
              triggerRangeOp('ripple_all');
            }}
            className="w-full px-3 py-1.5 text-left hover:bg-red-600/25 text-red-300 flex items-center gap-2 cursor-pointer"
          >
            <Scissors className="w-3.5 h-3.5 text-red-400" />
            <span>全轨切除吸附 (剪辑)</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setWaveContextMenu(null);
              triggerRangeOp('mute_lane');
            }}
            className="w-full px-3 py-1.5 text-left hover:bg-zinc-800 flex items-center gap-2 cursor-pointer"
          >
            <VolumeX className="w-3.5 h-3.5 text-zinc-400" />
            <span>静音{targetTrack?.name ?? '此'}轨</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setWaveContextMenu(null);
              triggerRangeOp('bleep_range');
            }}
            className="w-full px-3 py-1.5 text-left hover:bg-amber-600/20 text-amber-300 flex items-center justify-between gap-2 cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
              <span>替换「哔」</span>
            </span>
            <span className="text-[10px] text-zinc-500 font-mono">B</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setWaveContextMenu(null);
              triggerRangeOp('cancel_ducking');
            }}
            className="w-full px-3 py-1.5 text-left hover:bg-emerald-600/25 text-emerald-300 flex items-center gap-2 cursor-pointer"
          >
            <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>{isRangeAllFullVolume ? '恢复主发言避让' : '切换原声 (取消避让)'}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setWaveContextMenu(null);
              setSelStartRatio(null);
              setSelEndRatio(null);
            }}
            className="w-full px-3 py-1.5 text-left border-t border-zinc-800 mt-1 pt-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
          >
            取消选区
          </button>
        </div>
      )}
    </OuterTag>
  );
});
