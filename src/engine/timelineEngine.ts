import {
  HighlightClip,
  PodcastProjectState,
  RecordingMode,
  SpeakerTrack,
  TrackMuteRange,
  TranscriptBlock,
  TranscriptToken,
  WaveformSelectionMode,
} from '../types/podcast';

export interface MappedTokenTimeline {
  tokenId: string;
  blockId: string;
  speakerId: string;
  editedStartSec: number;
  editedEndSec: number;
  effectiveSourceStartSec: number;
  spanIndex: number;
  token: TranscriptToken;
}

export interface PlaybackSpan {
  spanIndex: number;
  editedStartSec: number;
  editedEndSec: number;
  sourceStartSec: number;
  sourceEndSec: number;
}

export interface OverlapTimelineRegion {
  id: string;
  blockId: string;
  editedStartSec: number;
  editedEndSec: number;
  sourceStartMs: number;
  sourceEndMs: number;
  primarySpeakerId: string;
  primarySpeakerName: string;
  secondarySpeakerId: string;
  secondarySpeakerName: string;
  text?: string;
  muted: boolean;
  keepFullVolume: boolean;
}

export interface TimelineComputation {
  prefixDurationSec: number;
  coldOpenDurationSec: number;
  introBgmDurationSec: number;
  introVoiceoverDurationSec: number;
  introVoiceoverStartSec: number;
  rawBodyDurationSec: number;
  editedBodyDurationSec: number;
  savedDurationSec: number;
  totalEditedDurationSec: number;
  blockEditedStartsSec: Record<string, number>;
  chapters: Array<{ timeFormatted: string; timeSec: number; title: string; isColdOpen?: boolean }>;
  mappedTokens: MappedTokenTimeline[];
  playbackSpans: PlaybackSpan[];
  overlapRegions: OverlapTimelineRegion[];
}

export type EditedTimeline = TimelineComputation;

export interface EdlKeepSegmentDto {
  sourceStartMs: number;
  sourceEndMs: number;
  crossfadeMs: number;
  pauseAfterMs: number;
}

export function formatMmSs(sec: number): string {
  const clamped = Math.max(0, Math.floor(sec));
  const mm = String(Math.floor(clamped / 60)).padStart(2, '0');
  const ss = String(clamped % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function resolveEffectiveHighlightGapSec(state: PodcastProjectState): number {
  if (state.highlights.length <= 1) {
    return state.highlightGapSec ?? 0.65;
  }
  if (state.autoHighlightGap) {
    const pureVoiceSec = state.highlights.reduce((acc, c) => acc + c.durationSec, 0);
    const targetSec = state.targetTotalHighlightSec || 30;
    const gapsCount = state.highlights.length - 1;
    if (targetSec > pureVoiceSec) {
      const perGap = (targetSec - pureVoiceSec) / gapsCount;
      return Number(Math.max(0.3, Math.min(2.5, perGap)).toFixed(2));
    }
    return 0.65;
  }
  return Number((state.highlightGapSec ?? 0.65).toFixed(2));
}

export interface ColdOpenClipWindow {
  highlight: HighlightClip;
  startSec: number;
  endSec: number;
}

export function resolveColdOpenClipWindows(
  highlights: HighlightClip[],
  gapSec: number
): ColdOpenClipWindow[] {
  const out: ColdOpenClipWindow[] = [];
  let cursor = 2.0;
  for (const hl of highlights) {
    const startSec =
      typeof hl.introStartSec === 'number' && Number.isFinite(hl.introStartSec)
        ? Math.max(0, hl.introStartSec)
        : cursor;
    const endSec = startSec + Math.max(0.05, hl.durationSec);
    out.push({ highlight: hl, startSec, endSec });
    cursor = endSec + gapSec;
  }
  return out;
}

export function computeColdOpenDurationSec(state: PodcastProjectState): number {
  if (!state.coldOpenEnabled || state.highlights.length === 0) {
    return 0;
  }
  const gapSec = resolveEffectiveHighlightGapSec(state);
  const hasCustomPos = state.highlights.some(
    (h) => typeof h.introStartSec === 'number' && Number.isFinite(h.introStartSec)
  );
  if (hasCustomPos) {
    const windows = resolveColdOpenClipWindows(state.highlights, gapSec);
    const maxEnd = windows.reduce((m, w) => Math.max(m, w.endSec), 2.0);
    return Number((maxEnd + 2.0).toFixed(2));
  }
  const clipsSum = state.highlights.reduce((acc, c) => acc + c.durationSec, 0);
  const gaps = Math.max(0, state.highlights.length - 1) * gapSec;
  // 2.0s intro swell + clips + gaps + 2.0s outro tail
  return Number((2.0 + clipsSum + gaps + 2.0).toFixed(2));
}

export function computeIntroBgmDurationSec(state: PodcastProjectState): number {
  if (!state.introBgm?.enabled) {
    return 0;
  }
  // 仅接受上传的音乐（有 filePath 或 audioUrl）
  const hasAudio = Boolean(
    (state.introBgm.filePath && state.introBgm.filePath.trim().length > 0) ||
    (state.introBgm.audioUrl && state.introBgm.audioUrl.trim().length > 0)
  );
  if (!hasAudio) {
    return 0;
  }
  if (typeof state.introBgm.customDurationSec === 'number' && state.introBgm.customDurationSec > 0) {
    return Number(state.introBgm.customDurationSec.toFixed(2));
  }
  if (typeof state.introBgm.durationSec === 'number' && state.introBgm.durationSec > 0) {
    return Number(state.introBgm.durationSec.toFixed(2));
  }
  return 10;
}

export function computeEditedTimeline(state: PodcastProjectState): TimelineComputation {
  const coldOpenDurationSec = computeColdOpenDurationSec(state);
  const introVoiceoverDurationSec = state.introVoiceover?.enabled
    ? Math.max(1, Number((state.introVoiceover.durationSec ?? 5).toFixed(2)))
    : 0;
  // 片头口播指定开始时间（未显式指定时，默认紧随金句之后）
  const introVoiceoverStartSec = state.introVoiceover?.enabled
    ? (typeof state.introVoiceover.startOffsetSec === 'number' && state.introVoiceover.startOffsetSec >= 0
        ? Number(state.introVoiceover.startOffsetSec.toFixed(2))
        : coldOpenDurationSec)
    : coldOpenDurationSec;
  const introBgmDurationSec = computeIntroBgmDurationSec(state);
  const voicePrefixEndSec = state.introVoiceover?.enabled
    ? introVoiceoverStartSec + introVoiceoverDurationSec
    : coldOpenDurationSec;
  const prefixDurationSec = Number(
    Math.max(coldOpenDurationSec, voicePrefixEndSec, introBgmDurationSec).toFixed(2)
  );
  let rawBodyDurationSec = 0;
  let editedBodyDurationSec = 0;

  const blockEditedStartsSec: Record<string, number> = {};
  const mappedTokens: MappedTokenTimeline[] = [];
  const playbackSpans: PlaybackSpan[] = [];

  let currentSpanIndex = 0;
  let activeSpan: PlaybackSpan | null = null;
  let lastKeptSourceEndSec: number | null = null;
  let sawCutSinceLastKept = false;
  let lastKeptWasCompressed = false;

  for (const block of state.blocks) {
    // Include collapsed retake duration in raw savings calculation
    if (block.retakeAttempts && block.retakeAttempts.length > 1) {
      const discardedSum = block.retakeAttempts.reduce((acc, a, idx) => {
        const chosen = block.selectedRetakeIndex ?? block.retakeAttempts!.length - 1;
        return idx === chosen ? acc : acc + a.durationSec;
      }, 0);
      rawBodyDurationSec += discardedSum;
    }

    let recordedBlockStart = false;

    for (const tok of block.tokens) {
      rawBodyDurationSec += tok.origDurationSec;

      if (tok.deleted) {
        sawCutSinceLastKept = true;
        const startSec = prefixDurationSec + editedBodyDurationSec;
        if (!recordedBlockStart) {
          blockEditedStartsSec[block.blockId] = Number(startSec.toFixed(3));
          recordedBlockStart = true;
        }
        mappedTokens.push({
          tokenId: tok.id,
          blockId: block.blockId,
          speakerId: block.speakerId,
          editedStartSec: Number(startSec.toFixed(3)),
          editedEndSec: Number(startSec.toFixed(3)),
          effectiveSourceStartSec: Number((tok.sourceStartMs / 1000).toFixed(3)),
          spanIndex: currentSpanIndex,
          token: tok,
        });
        continue;
      }

      // 手动插入的空白时长（sourceStartMs === sourceEndMs）：断开硬件连续播放跨度，形成纯静音区间
      if (tok.insertedSilence || (tok.type === 'silence' && tok.sourceEndMs <= tok.sourceStartMs && tok.durationSec > 0)) {
        if (activeSpan) {
          activeSpan = null;
          currentSpanIndex++;
        }
        const silStartSec = prefixDurationSec + editedBodyDurationSec;
        const silDur = Math.max(0.05, tok.durationSec);
        editedBodyDurationSec += silDur;
        mappedTokens.push({
          tokenId: tok.id,
          blockId: block.blockId,
          speakerId: block.speakerId,
          editedStartSec: Number(silStartSec.toFixed(3)),
          editedEndSec: Number((silStartSec + silDur).toFixed(3)),
          effectiveSourceStartSec: Number((tok.sourceStartMs / 1000).toFixed(3)),
          spanIndex: -1,
          token: tok,
        });
        lastKeptWasCompressed = true;
        continue;
      }

      const rawTokSrcStartSec = tok.sourceStartMs / 1000;
      const rawSpanSec = Math.max(0, (tok.sourceEndMs - tok.sourceStartMs) / 1000);
      const isCompressed =
        (tok.type === 'silence' || Boolean(tok.subwordTrimmed)) &&
        rawSpanSec - tok.durationSec > (tok.subwordTrimmed ? 0.004 : 0.045);
      const naturalTokDur =
        !isCompressed && tok.type !== 'silence' && !tok.subwordTrimmed && rawSpanSec >= 0.015
          ? rawSpanSec
          : tok.durationSec;

      const explicitGapBeforeSec =
        typeof tok.gapBeforeSec === 'number' && Number.isFinite(tok.gapBeforeSec)
          ? Math.max(0, tok.gapBeforeSec)
          : null;

      let effectiveSrcStartSec = rawTokSrcStartSec;
      let effDur = naturalTokDur;
      let preRollSec = 0;

      // Preserve ALL uncut regions between kept tokens as a SINGLE continuous hardware PlaybackSpan (zero seeks / zero blanks!):
      // 1) Positive uncut inter-token gaps (natural breaths, long pauses, or music segments) stay 1:1 in the same span.
      // 2) Negative uncut multi-speaker turn overlaps advance monotonically from lastKeptSourceEndSec
      //    without backward <audio> seeking or cumulative +15ms drift!
      if (lastKeptSourceEndSec !== null) {
        const srcGapSec = rawTokSrcStartSec - lastKeptSourceEndSec;
        const gapWasExplicitlyEdited =
          explicitGapBeforeSec !== null &&
          (srcGapSec < -0.001 || Math.abs(explicitGapBeforeSec - Math.max(0, srcGapSec)) > 0.002);
        const hasTrueEditBoundary =
          sawCutSinceLastKept || lastKeptWasCompressed || gapWasExplicitlyEdited || srcGapSec < -120.0;

        if (hasTrueEditBoundary) {
          currentSpanIndex++;
          activeSpan = null;
          if (!sawCutSinceLastKept && !lastKeptWasCompressed && srcGapSec > 0.001) {
            rawBodyDurationSec += srcGapSec;
          }
          if (explicitGapBeforeSec !== null && explicitGapBeforeSec > 0.001) {
            preRollSec = Math.min(rawTokSrcStartSec, explicitGapBeforeSec);
            editedBodyDurationSec += explicitGapBeforeSec;
          }
        } else if (srcGapSec > 0.001) {
          // Uncut natural gap between kept tokens -> include 1:1 with zero seek!
          rawBodyDurationSec += srcGapSec;
          editedBodyDurationSec += srcGapSec;
        } else if (srcGapSec < -0.001) {
          // Uncut natural turn overlap -> advance linearly from lastKeptSourceEndSec without re-seeking backward!
          const tokRawEndSec = rawTokSrcStartSec + naturalTokDur;
          effectiveSrcStartSec = lastKeptSourceEndSec;
          effDur = Math.max(0, tokRawEndSec - lastKeptSourceEndSec);
          // Adjust rawBodyDurationSec so overlap isn't double-counted as fake "saved" time
          rawBodyDurationSec = Math.max(0, rawBodyDurationSec - (tok.origDurationSec - effDur));
        }
      } else if (explicitGapBeforeSec !== null && explicitGapBeforeSec > 0.001) {
        preRollSec = Math.min(rawTokSrcStartSec, explicitGapBeforeSec);
        editedBodyDurationSec += explicitGapBeforeSec;
      }

      const startSec = prefixDurationSec + editedBodyDurationSec;
      if (!recordedBlockStart) {
        blockEditedStartsSec[block.blockId] = Number(startSec.toFixed(3));
        recordedBlockStart = true;
      }
      const endSec = startSec + effDur;
      const tokSrcEndSec = effectiveSrcStartSec + effDur;

      if (!activeSpan) {
        activeSpan = {
          spanIndex: currentSpanIndex,
          editedStartSec: startSec - preRollSec,
          editedEndSec: endSec,
          sourceStartSec: effectiveSrcStartSec - preRollSec,
          sourceEndSec: tokSrcEndSec,
        };
        playbackSpans.push(activeSpan);
      } else {
        // Keep editedEndSec and sourceEndSec strictly 1:1 locked within a continuous span
        activeSpan.editedEndSec = endSec;
        activeSpan.sourceEndSec =
          activeSpan.sourceStartSec + (endSec - activeSpan.editedStartSec);
      }

      lastKeptSourceEndSec = tokSrcEndSec;
      sawCutSinceLastKept = false;
      lastKeptWasCompressed = isCompressed;

      mappedTokens.push({
        tokenId: tok.id,
        blockId: block.blockId,
        speakerId: block.speakerId,
        editedStartSec: Number(startSec.toFixed(3)),
        editedEndSec: Number(endSec.toFixed(3)),
        effectiveSourceStartSec: Number(effectiveSrcStartSec.toFixed(3)),
        spanIndex: currentSpanIndex,
        token: tok,
      });

      editedBodyDurationSec += effDur;
    }

    if (!recordedBlockStart) {
      blockEditedStartsSec[block.blockId] = Number(
        (prefixDurationSec + editedBodyDurationSec).toFixed(3)
      );
    }
  }

  // 当尚未进行 ASR 识别或 blocks 为空时，若音轨已存在，正文时长兜底为音轨最大时长，确保纯音频/未识别状态下亦可正常播放审听
  if (editedBodyDurationSec === 0 && state.tracks.length > 0) {
    const maxTrackSec = Math.max(
      0,
      ...state.tracks.map((t) => (t.durationMs && t.durationMs > 0 ? t.durationMs / 1000 : 0))
    );
    if (maxTrackSec > 0.05) {
      rawBodyDurationSec = maxTrackSec;
      editedBodyDurationSec = maxTrackSec;
      if (playbackSpans.length === 0) {
        playbackSpans.push({
          spanIndex: 0,
          editedStartSec: prefixDurationSec,
          editedEndSec: prefixDurationSec + maxTrackSec,
          sourceStartSec: 0,
          sourceEndSec: maxTrackSec,
        });
      }
    }
  }

  const savedDurationSec = Math.max(0, Number((rawBodyDurationSec - editedBodyDurationSec).toFixed(2)));
  const totalEditedDurationSec = Number((prefixDurationSec + editedBodyDurationSec).toFixed(2));

  const chapters: TimelineComputation['chapters'] = [];
  if (coldOpenDurationSec > 0) {
    chapters.push({
      timeFormatted: '00:00',
      timeSec: 0,
      title: `🔥 本期高光抢先听 (${state.highlights.length}段精选 + BGM智能闪避)`,
      isColdOpen: true,
    });
  } else if (introBgmDurationSec > 0) {
    chapters.push({
      timeFormatted: '00:00',
      timeSec: 0,
      title: `🎵 片头音乐 (${introBgmDurationSec.toFixed(1)}s)`,
      isColdOpen: true,
    });
  }
  if (introVoiceoverDurationSec > 0) {
    chapters.push({
      timeFormatted: formatMmSs(coldOpenDurationSec),
      timeSec: coldOpenDurationSec,
      title: `🎙️ 片头固定口播 (${state.introVoiceover?.fileName ?? '片头口播'})`,
      isColdOpen: true,
    });
  }

  for (const block of state.blocks) {
    const hasRemaining = block.tokens.some((t) => !t.deleted);
    if (hasRemaining) {
      const tSec = blockEditedStartsSec[block.blockId] ?? 0;
      chapters.push({
        timeFormatted: formatMmSs(tSec),
        timeSec: tSec,
        title: block.chapterTitle,
      });
    }
  }

  const overlapRegions = computeOverlapTimelineRegions(state, playbackSpans);

  return {
    prefixDurationSec,
    coldOpenDurationSec,
    introBgmDurationSec,
    introVoiceoverDurationSec,
    introVoiceoverStartSec,
    rawBodyDurationSec: Number(rawBodyDurationSec.toFixed(2)),
    editedBodyDurationSec: Number(editedBodyDurationSec.toFixed(2)),
    savedDurationSec,
    totalEditedDurationSec,
    blockEditedStartsSec,
    chapters,
    mappedTokens,
    playbackSpans,
    overlapRegions,
  };
}

function mapSourceMsToEditedRange(
  srcStartMs: number,
  srcEndMs: number,
  playbackSpans: PlaybackSpan[],
  spansMonotonic = true
): [number, number] | null {
  const sSec = srcStartMs / 1000;
  const eSec = srcEndMs / 1000;
  if (eSec - sSec < 0.03 || playbackSpans.length === 0) return null;

  let startIdx = 0;
  if (spansMonotonic) {
    let lo = 0;
    let hi = playbackSpans.length - 1;
    startIdx = playbackSpans.length;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (playbackSpans[mid].sourceEndSec > sSec) {
        startIdx = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
  }

  let minEdit = Number.POSITIVE_INFINITY;
  let maxEdit = Number.NEGATIVE_INFINITY;
  for (let i = startIdx; i < playbackSpans.length; i++) {
    const sp = playbackSpans[i];
    if (spansMonotonic && sp.sourceStartSec >= eSec) break;
    const ov0 = Math.max(sSec, sp.sourceStartSec);
    const ov1 = Math.min(eSec, sp.sourceEndSec);
    if (ov1 - ov0 >= 0.03) {
      const ed0 = sp.editedStartSec + (ov0 - sp.sourceStartSec);
      const ed1 = sp.editedStartSec + (ov1 - sp.sourceStartSec);
      if (ed0 < minEdit) minEdit = ed0;
      if (ed1 > maxEdit) maxEdit = ed1;
    }
  }
  if (!Number.isFinite(minEdit) || maxEdit <= minEdit) return null;
  return [Number(minEdit.toFixed(3)), Number(maxEdit.toFixed(3))];
}

function sampleTrackMaxPeakInRange(
  peaks: number[],
  durationMs: number | undefined,
  offsetMs: number,
  startMs: number,
  endMs: number
): number | null {
  if (!durationMs || durationMs <= 0 || peaks.length < 4) return null;
  const sAdj = Math.max(0, startMs - offsetMs);
  const eAdj = Math.min(durationMs, endMs - offsetMs);
  if (eAdj <= sAdj) return 0;
  const nBins = peaks.length;
  const i0 = Math.max(0, Math.min(nBins - 1, Math.floor((sAdj / durationMs) * nBins)));
  const i1 = Math.max(
    i0,
    Math.min(nBins - 1, Math.floor((Math.max(sAdj, eAdj - 0.001) / durationMs) * nBins))
  );
  let pk = 0;
  for (let i = i0; i <= i1; i++) {
    if (peaks[i] > pk) pk = peaks[i];
  }
  return pk;
}

function computeOverlapTimelineRegions(
  state: PodcastProjectState,
  playbackSpans: PlaybackSpan[]
): OverlapTimelineRegion[] {
  if (state.blocks.length === 0 || playbackSpans.length === 0) return [];

  let spansMonotonic = true;
  for (let i = 1; i < playbackSpans.length; i++) {
    if (
      playbackSpans[i].sourceStartSec < playbackSpans[i - 1].sourceStartSec ||
      playbackSpans[i].sourceEndSec < playbackSpans[i - 1].sourceEndSec
    ) {
      spansMonotonic = false;
      break;
    }
  }

  const trackById = new Map(state.tracks.map((t) => [t.id, t]));
  const activeSpeakerTracks = (
    state.tracks.some((t) => !t.isRef) ? state.tracks.filter((t) => !t.isRef) : state.tracks
  ).filter((t) => !t.muted);

  const vocalTokensByBlock = state.blocks.map((blk) =>
    blk.tokens.filter((t) => !t.deleted && t.type !== 'silence' && !t.trackMuted)
  );

  const sameRoom = state.recordingMode === 'same_room_sync';
  const regions: OverlapTimelineRegion[] = [];

  const pushOrMergeRegion = (cand: OverlapTimelineRegion) => {
    const existing = regions.find(
      (r) =>
        r.blockId === cand.blockId &&
        r.secondarySpeakerId === cand.secondarySpeakerId &&
        cand.sourceStartMs <= r.sourceEndMs + 250 &&
        cand.sourceEndMs >= r.sourceStartMs - 250
    );
    if (existing) {
      existing.editedStartSec = Math.min(existing.editedStartSec, cand.editedStartSec);
      existing.editedEndSec = Math.max(existing.editedEndSec, cand.editedEndSec);
      existing.sourceStartMs = Math.min(existing.sourceStartMs, cand.sourceStartMs);
      existing.sourceEndMs = Math.max(existing.sourceEndMs, cand.sourceEndMs);
      if (!existing.text && cand.text) existing.text = cand.text;
      return;
    }
    regions.push(cand);
  };

  for (let bIdx = 0; bIdx < state.blocks.length; bIdx++) {
    const blk = state.blocks[bIdx];
    const vocalTokens = vocalTokensByBlock[bIdx];
    if (vocalTokens.length === 0) continue;

    const blkStartMs = vocalTokens[0].sourceStartMs;
    const blkEndMs = vocalTokens[vocalTokens.length - 1].sourceEndMs;
    const priTrack = trackById.get(blk.speakerId);
    const priSpeakerName = priTrack?.name || blk.speakerId;
    const priOffsetMs = sameRoom ? 0 : priTrack?.syncOffsetMs || 0;

    // 1. Explicit overlapNote attached to the block
    if (blk.overlapNote) {
      const ov = blk.overlapNote;
      const mapped = mapSourceMsToEditedRange(
        ov.sourceStartMs,
        ov.sourceEndMs,
        playbackSpans,
        spansMonotonic
      );
      if (mapped) {
        const secTr = trackById.get(ov.speakerId);
        pushOrMergeRegion({
          id: ov.id || `ov_${blk.blockId}`,
          blockId: blk.blockId,
          editedStartSec: mapped[0],
          editedEndSec: mapped[1],
          sourceStartMs: ov.sourceStartMs,
          sourceEndMs: ov.sourceEndMs,
          primarySpeakerId: blk.speakerId,
          primarySpeakerName: priSpeakerName,
          secondarySpeakerId: ov.speakerId,
          secondarySpeakerName: secTr?.name || ov.speakerName,
          text: ov.text,
          muted: Boolean(ov.muted),
          keepFullVolume: Boolean(ov.keepFullVolume),
        });
      }
    }

    // 2. Cross-block multi-speaker speech overlap (next speaker starts talking before current speaker's words finish)
    for (let nextIdx = bIdx + 1; nextIdx < state.blocks.length; nextIdx++) {
      const other = state.blocks[nextIdx];
      const otherVocal = vocalTokensByBlock[nextIdx];
      if (otherVocal.length === 0) continue;
      if (otherVocal[0].sourceStartMs >= blkEndMs - 60) break;
      if (other.speakerId === blk.speakerId) continue;

      const overlappedToks = otherVocal.filter(
        (t) => Math.min(blkEndMs, t.sourceEndMs) - Math.max(blkStartMs, t.sourceStartMs) >= 80
      );
      if (overlappedToks.length > 0) {
        const ovStartMs = Math.max(blkStartMs, overlappedToks[0].sourceStartMs);
        const ovEndMs = Math.min(blkEndMs, overlappedToks[overlappedToks.length - 1].sourceEndMs);
        if (ovEndMs - ovStartMs >= 80) {
          const mapped = mapSourceMsToEditedRange(
            ovStartMs,
            ovEndMs,
            playbackSpans,
            spansMonotonic
          );
          if (mapped) {
            const secTr = trackById.get(other.speakerId);
            const matchNote =
              blk.overlapNote && blk.overlapNote.speakerId === other.speakerId
                ? blk.overlapNote
                : undefined;
            pushOrMergeRegion({
              id: matchNote?.id || `ov_xturn_${blk.blockId}_${other.blockId}`,
              blockId: blk.blockId,
              editedStartSec: mapped[0],
              editedEndSec: mapped[1],
              sourceStartMs: ovStartMs,
              sourceEndMs: ovEndMs,
              primarySpeakerId: blk.speakerId,
              primarySpeakerName: priSpeakerName,
              secondarySpeakerId: other.speakerId,
              secondarySpeakerName: secTr?.name || other.speakerId,
              text: overlappedToks.map((t) => t.text).join('').trim(),
              muted: Boolean(matchNote?.muted),
              keepFullVolume: Boolean(matchNote?.keepFullVolume),
            });
          }
        }
      }
    }

    // 3. Acoustic VAD segment overlap on secondary tracks (captures untranscribed simultaneous speech while filtering room bleed)
    if (activeSpeakerTracks.length >= 2) {
      for (const secTr of activeSpeakerTracks) {
        const segs = secTr.detectedSegments;
        if (secTr.id === blk.speakerId || !segs?.length) continue;
        const secOffsetMs = sameRoom ? 0 : secTr.syncOffsetMs || 0;

        let sLo = 0;
        let sHi = segs.length - 1;
        let segStartIdx = segs.length;
        while (sLo <= sHi) {
          const mid = (sLo + sHi) >>> 1;
          if (segs[mid].endMs + secOffsetMs > blkStartMs + 120) {
            segStartIdx = mid;
            sHi = mid - 1;
          } else {
            sLo = mid + 1;
          }
        }

        for (let sIdx = segStartIdx; sIdx < segs.length; sIdx++) {
          const seg = segs[sIdx];
          if (seg.isSilence) continue;
          const segSrcStart = seg.startMs + secOffsetMs;
          const segSrcEnd = seg.endMs + secOffsetMs;
          if (segSrcEnd <= blkStartMs + 120) continue;
          if (segSrcStart >= blkEndMs - 120) break;

          // Verify overlap against actual voiced word tokens (not inside a long pause capsule!)
          for (const vt of vocalTokens) {
            const ovS = Math.max(vt.sourceStartMs, segSrcStart);
            const ovE = Math.min(vt.sourceEndMs, segSrcEnd);
            if (ovE - ovS < 180) continue;

            const priPeak = priTrack
              ? sampleTrackMaxPeakInRange(priTrack.peaks, priTrack.durationMs, priOffsetMs, ovS, ovE)
              : null;
            const secPeak = sampleTrackMaxPeakInRange(
              secTr.peaks,
              secTr.durationMs,
              secOffsetMs,
              ovS,
              ovE
            );
            // Filter out room mic bleed: secondary track peak must be genuinely loud vocal energy
            if (
              secPeak !== null &&
              (secPeak < 0.16 || (priPeak !== null && secPeak < priPeak * 0.52))
            ) {
              continue;
            }

            const mapped = mapSourceMsToEditedRange(ovS, ovE, playbackSpans, spansMonotonic);
            if (mapped) {
              const matchNote =
                blk.overlapNote && blk.overlapNote.speakerId === secTr.id
                  ? blk.overlapNote
                  : undefined;
              pushOrMergeRegion({
                id: matchNote?.id || `ov_vad_${blk.blockId}_${secTr.id}_${ovS}`,
                blockId: blk.blockId,
                editedStartSec: mapped[0],
                editedEndSec: mapped[1],
                sourceStartMs: ovS,
                sourceEndMs: ovE,
                primarySpeakerId: blk.speakerId,
                primarySpeakerName: priSpeakerName,
                secondarySpeakerId: secTr.id,
                secondarySpeakerName: secTr.name,
                text: matchNote?.text,
                muted: Boolean(matchNote?.muted),
                keepFullVolume: Boolean(matchNote?.keepFullVolume),
              });
            }
          }
        }
      }
    }
  }

  regions.sort((a, b) => a.editedStartSec - b.editedStartSec);
  return regions;
}

/**
 * Compiles non-deleted tokens into continuous EDL segments with adaptive equal-power crossfade
 * and smart cross-sentence natural micro-pause insertion.
 */
export function buildEdlKeepSegments(state: PodcastProjectState): EdlKeepSegmentDto[] {
  const segments: EdlKeepSegmentDto[] = [];
  let current: EdlKeepSegmentDto | null = null;
  let prevDeletedWasSentenceBreak = false;
  let sawCutSinceCurrent = false;
  let prevWasCompressed = false;
  let lastKeptText = '';

  for (const block of state.blocks) {
    for (const tok of block.tokens) {
      if (tok.deleted) {
        sawCutSinceCurrent = true;
        if (/[。？！!?]/.test(tok.text) || tok.type === 'silence') {
          prevDeletedWasWasBreak();
        }
        if (current) {
          // If both sides of a large deletion are sentence boundaries, add a 280ms natural breathing micro-pause
          if (/[。？！!?]$/.test(lastKeptText)) {
            current.pauseAfterMs = 280;
            current.crossfadeMs = 48;
          }
          segments.push(current);
          current = null;
        }
        continue;
      }

      if (tok.insertedSilence || (tok.type === 'silence' && tok.sourceEndMs <= tok.sourceStartMs && tok.durationSec > 0)) {
        const extraPauseMs = Math.max(50, Math.round(tok.durationSec * 1000));
        if (current) {
          current.pauseAfterMs += extraPauseMs;
          segments.push(current);
          current = null;
        } else if (segments.length > 0) {
          segments[segments.length - 1].pauseAfterMs += extraPauseMs;
        }
        sawCutSinceCurrent = true;
        continue;
      }

      const rawDurMs = Math.max(0, tok.sourceEndMs - tok.sourceStartMs);
      const isCompressed =
        (tok.type === 'silence' || Boolean(tok.subwordTrimmed)) &&
        rawDurMs - tok.durationSec * 1000 > (tok.subwordTrimmed ? 4 : 45);
      const effEndMs = isCompressed
        ? tok.sourceStartMs + Math.round(tok.durationSec * 1000)
        : tok.sourceEndMs;
      const explicitGapMs =
        typeof tok.gapBeforeSec === 'number' && Number.isFinite(tok.gapBeforeSec)
          ? Math.max(0, Math.round(tok.gapBeforeSec * 1000))
          : null;
      const preRollMs =
        explicitGapMs !== null ? Math.min(tok.sourceStartMs, explicitGapMs) : 0;

      if (!current) {
        if (explicitGapMs !== null && segments.length > 0) {
          segments[segments.length - 1].pauseAfterMs = 0;
        }
        current = {
          sourceStartMs: Math.max(0, tok.sourceStartMs - preRollMs),
          sourceEndMs: effEndMs,
          crossfadeMs: prevDeletedWasSentenceBreak ? 48 : 36,
          pauseAfterMs: 0,
        };
        prevDeletedWasSentenceBreak = false;
      } else {
        const rawGapMs = tok.sourceStartMs - current.sourceEndMs;
        const gapExplicitlyEdited =
          explicitGapMs !== null &&
          (rawGapMs < -1 || Math.abs(explicitGapMs - Math.max(0, rawGapMs)) > 2);
        if (
          !sawCutSinceCurrent &&
          !prevWasCompressed &&
          !gapExplicitlyEdited &&
          rawGapMs >= -120000
        ) {
          // Uncut natural inter-word breath, long music/pause, or turn overlap -> keep as ONE continuous master segment!
          current.sourceEndMs = Math.max(current.sourceEndMs, effEndMs);
        } else {
          segments.push(current);
          current = {
            sourceStartMs: Math.max(0, tok.sourceStartMs - preRollMs),
            sourceEndMs: effEndMs,
            crossfadeMs: 36,
            pauseAfterMs: 0,
          };
        }
      }

      sawCutSinceCurrent = false;
      prevWasCompressed = isCompressed;
      if (tok.type === 'word') {
        lastKeptText = tok.text;
      }
    }
  }

  function prevDeletedWasWasBreak() {
    prevDeletedWasSentenceBreak = true;
  }

  if (current) {
    segments.push(current);
  }
  return segments;
}

/**
 * Coalesces adjacent blocks belonging to the same speaker when an intervening block's tokens were all deleted!
 */
export interface CoalescedTurnGroup {
  groupKey: string;
  speakerId: string;
  blocks: TranscriptBlock[];
  coalescedAcrossCut: boolean;
}

export function coalesceChronologicalBlocks(blocks: TranscriptBlock[]): CoalescedTurnGroup[] {
  const groups: CoalescedTurnGroup[] = [];
  let sawFullyDeletedIntervening = false;

  for (const block of blocks) {
    const isAllDeleted = block.tokens.every((t) => t.deleted);
    if (isAllDeleted) {
      groups.push({
        groupKey: block.blockId,
        speakerId: block.speakerId,
        blocks: [block],
        coalescedAcrossCut: false,
      });
      sawFullyDeletedIntervening = true;
      continue;
    }

    // Find last active group
    let prevActiveIdx = -1;
    for (let i = groups.length - 1; i >= 0; i--) {
      if (!groups[i].blocks.every((b) => b.tokens.every((t) => t.deleted))) {
        prevActiveIdx = i;
        break;
      }
    }

    if (
      sawFullyDeletedIntervening &&
      prevActiveIdx >= 0 &&
      groups[prevActiveIdx].speakerId === block.speakerId
    ) {
      groups[prevActiveIdx].blocks.push(block);
      groups[prevActiveIdx].coalescedAcrossCut = true;
    } else {
      groups.push({
        groupKey: block.blockId,
        speakerId: block.speakerId,
        blocks: [block],
        coalescedAcrossCut: false,
      });
    }
    sawFullyDeletedIntervening = false;
  }

  return groups;
}

/**
 * 计算文本去空白后的视觉字符数（中文/全角计 1，ASCII 计 0.55）。
 */
export function computeDeckVisualCharCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 32) continue; // 忽略空白字符
    count += code <= 0x7f ? 0.55 : 1;
  }
  return count;
}

/**
 * 根据预览文本视觉长度（及是否存在重合条）计算横向发言块卡片自适应宽度 (px)。
 */
export function computeHorizontalDeckCardWidthPx(
  previewText: string,
  hasOverlaps = false
): number {
  const vChars = computeDeckVisualCharCount(previewText);
  let width: number;
  if (vChars <= 6) {
    width = Math.max(132, Math.round(120 + vChars * 6));
  } else if (vChars <= 22) {
    width = Math.round(156 + (vChars - 6) * 4.0);
  } else if (vChars <= 55) {
    width = Math.round(220 + (vChars - 22) * 2.0);
  } else {
    width = Math.min(320, Math.round(286 + (vChars - 55) * 0.8));
  }
  return hasOverlaps ? Math.max(188, width) : width;
}

function getTurnGroupStats(
  group: CoalescedTurnGroup,
  mappedByTokenId: ReadonlyMap<string, MappedTokenTimeline>
): {
  hasVisibleTokens: boolean;
  startSec: number;
  endSec: number;
  visualChars: number;
} {
  let hasVisibleTokens = false;
  let startSec = Infinity;
  let endSec = -Infinity;
  let textAcc = '';

  for (const b of group.blocks) {
    for (const t of b.tokens) {
      if (t.deleted) continue;
      if (t.type !== 'silence') {
        textAcc += t.bleeped ? '消音' : t.text;
      }
      if (t.type === 'silence' && t.durationSec < 0.55 && !t.mouthClickCleaned) {
        continue;
      }
      const mapped = mappedByTokenId.get(t.id);
      if (!mapped) continue;
      hasVisibleTokens = true;
      if (mapped.editedStartSec < startSec) startSec = mapped.editedStartSec;
      if (mapped.editedEndSec > endSec) endSec = mapped.editedEndSec;
    }
  }

  return {
    hasVisibleTokens,
    startSec: Number.isFinite(startSec) ? startSec : 0,
    endSec: Number.isFinite(endSec) ? endSec : 0,
    visualChars: computeDeckVisualCharCount(textAcc),
  };
}

/**
 * 在横向布局下合并同一发言人连续且间隔较短的碎发言块，减少视觉碎片感与留白浪费。
 */
export function mergeCompactDeckTurnGroups(
  groups: CoalescedTurnGroup[],
  mappedByTokenId: ReadonlyMap<string, MappedTokenTimeline>,
  options?: { maxMergedChars?: number; maxGapSec?: number }
): CoalescedTurnGroup[] {
  const maxMergedChars = options?.maxMergedChars ?? 96;
  const maxGapSec = options?.maxGapSec ?? 4.0;

  const out: CoalescedTurnGroup[] = [];
  let lastActiveOutIdx = -1;
  let lastActiveStats: { endSec: number; visualChars: number } | null = null;
  let sawEmptyBetween = false;

  for (const grp of groups) {
    const stats = getTurnGroupStats(grp, mappedByTokenId);
    if (!stats.hasVisibleTokens) {
      out.push({
        groupKey: grp.groupKey,
        speakerId: grp.speakerId,
        blocks: [...grp.blocks],
        coalescedAcrossCut: grp.coalescedAcrossCut,
      });
      sawEmptyBetween = true;
      continue;
    }

    if (lastActiveOutIdx >= 0 && lastActiveStats !== null) {
      const prev = out[lastActiveOutIdx];
      if (prev.speakerId === grp.speakerId) {
        const gapSec = Math.max(0, stats.startSec - lastActiveStats.endSec);
        const totalChars: number = lastActiveStats.visualChars + stats.visualChars;
        const hasShortPiece = Math.min(lastActiveStats.visualChars, stats.visualChars) <= 10;

        if (
          gapSec <= maxGapSec &&
          (totalChars <= maxMergedChars || (hasShortPiece && totalChars <= 120))
        ) {
          prev.blocks.push(...grp.blocks);
          prev.coalescedAcrossCut =
            prev.coalescedAcrossCut || grp.coalescedAcrossCut || sawEmptyBetween;
          lastActiveStats = {
            endSec: Math.max(lastActiveStats.endSec, stats.endSec),
            visualChars: totalChars,
          };
          sawEmptyBetween = false;
          continue;
        }
      }
    }

    out.push({
      groupKey: grp.groupKey,
      speakerId: grp.speakerId,
      blocks: [...grp.blocks],
      coalescedAcrossCut: grp.coalescedAcrossCut,
    });
    lastActiveOutIdx = out.length - 1;
    lastActiveStats = {
      endSec: stats.endSec,
      visualChars: stats.visualChars,
    };
    sawEmptyBetween = false;
  }

  return out;
}

export interface WaveformCutOutcome {
  nextBlocks: TranscriptBlock[];
  fullDeletedCount: number;
  subwordTrimmedCount: number;
  affectedText: string;
  sourceRangeMs: [number, number] | null;
}

/**
 * Snaps a candidate cut timestamp (in global timeline source milliseconds) within `±searchRadiusMs`
 * toward a local low-amplitude acoustic valley across the target or active tracks, preventing
 * harsh transient steps right on vowel peaks.
 */
export function snapSourceMsToWaveformValley(
  tracks: SpeakerTrack[],
  recordingMode: RecordingMode,
  targetSourceMs: number,
  speakerId?: string,
  searchRadiusMs = 26
): number {
  const safeTarget = Math.max(0, Math.round(targetSourceMs));
  const preferred = speakerId
    ? tracks.filter(
        (t) => t.id === speakerId && !t.muted && (t.durationMs ?? 0) > 0 && t.peaks.length >= 16
      )
    : [];
  const candidates =
    preferred.length > 0
      ? preferred
      : tracks.filter(
          (t) => !t.isRef && !t.muted && (t.durationMs ?? 0) > 0 && t.peaks.length >= 16
        );
  if (candidates.length === 0 || searchRadiusMs <= 0) {
    return safeTarget;
  }

  const sameRoom = recordingMode === 'same_room_sync';
  const stepMs = 2;
  const minMs = Math.max(0, safeTarget - searchRadiusMs);
  const maxMs = safeTarget + searchRadiusMs;

  const sampleCombinedPeak = (ms: number): number => {
    let peak = 0;
    for (const tr of candidates) {
      const durMs = tr.durationMs!;
      const offsetMs = sameRoom ? 0 : tr.syncOffsetMs || 0;
      const localMs = Math.max(0, Math.min(durMs - 1, ms - offsetMs));
      const idx = Math.min(tr.peaks.length - 1, Math.max(0, Math.floor((localMs / durMs) * tr.peaks.length)));
      if (tr.peaks[idx] > peak) peak = tr.peaks[idx];
    }
    return peak;
  };

  let maxLocal = 0;
  const grid: Array<{ ms: number; amp: number }> = [];
  for (let ms = minMs; ms <= maxMs; ms += stepMs) {
    const amp = sampleCombinedPeak(ms);
    if (amp > maxLocal) maxLocal = amp;
    grid.push({ ms, amp });
  }
  if (maxLocal <= 0.005 || grid.length === 0) {
    return safeTarget;
  }

  let bestMs = safeTarget;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const pt of grid) {
    const distNorm = Math.abs(pt.ms - safeTarget) / Math.max(1, searchRadiusMs);
    const score = pt.amp + maxLocal * 0.24 * distNorm;
    if (score < bestScore) {
      bestScore = score;
      bestMs = pt.ms;
    }
  }
  return bestMs;
}

/**
 * Extracts sorted, deduplicated word-gap snap timestamps (in edited timeline seconds)
 * from non-deleted word tokens so "吸附模式" can magnetically snap selections to
 * inter-word gaps and speech/silence boundaries.
 */
export function computeWordGapSnapPointsSec(timeline: TimelineComputation): number[] {
  const totalSec = Math.max(0, timeline.totalEditedDurationSec);
  const words = timeline.mappedTokens.filter(
    (m) => !m.token.deleted && m.token.type === 'word'
  );
  if (words.length === 0) {
    return totalSec > 0 ? [0, Number(totalSec.toFixed(3))] : [0];
  }

  const raw: number[] = [0];
  if (words[0].editedStartSec > 0.01) {
    raw.push(words[0].editedStartSec);
  }

  for (let i = 0; i < words.length - 1; i++) {
    const prev = words[i];
    const curr = words[i + 1];
    const gapStart = prev.editedEndSec;
    const gapEnd = curr.editedStartSec;
    const gap = gapEnd - gapStart;
    if (gap <= 0.005) {
      raw.push((gapStart + gapEnd) * 0.5);
    } else if (gap <= 0.6) {
      raw.push((gapStart + gapEnd) * 0.5);
    } else {
      raw.push(gapStart, (gapStart + gapEnd) * 0.5, gapEnd);
    }
  }

  const last = words[words.length - 1];
  raw.push(last.editedEndSec);
  if (totalSec > last.editedEndSec + 0.01) {
    raw.push(totalSec);
  }

  raw.sort((a, b) => a - b);
  const deduped: number[] = [];
  for (const pt of raw) {
    const rounded = Number(Math.max(0, Math.min(totalSec, pt)).toFixed(3));
    if (deduped.length === 0 || rounded - deduped[deduped.length - 1] > 0.002) {
      deduped.push(rounded);
    }
  }
  return deduped;
}

function findNearestSnapPoint(points: number[], target: number): { idx: number; val: number } {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return { idx: 0, val: points[0] };
  const prevDist = Math.abs(target - points[lo - 1]);
  const currDist = Math.abs(points[lo] - target);
  return prevDist <= currDist
    ? { idx: lo - 1, val: points[lo - 1] }
    : { idx: lo, val: points[lo] };
}

/**
 * Snaps a raw waveform drag range [rawStartSec, rawEndSec] onto the nearest word-gap
 * snap points. If a non-trivial drag collapses onto a single point inside one word,
 * expands to the enclosing [leftGap, rightGap] pair so the word is cleanly selected.
 */
export function snapRangeToWordGaps(
  rawStartSec: number,
  rawEndSec: number,
  snapPoints: number[],
  minSpanSec = 0.02
): [number, number] {
  if (snapPoints.length < 2) {
    return [rawStartSec, rawEndSec];
  }
  const forward = rawEndSec >= rawStartSec;
  const lo = Math.min(rawStartSec, rawEndSec);
  const hi = Math.max(rawStartSec, rawEndSec);

  const leftSnap = findNearestSnapPoint(snapPoints, lo);
  const rightSnap = findNearestSnapPoint(snapPoints, hi);
  let snappedLo = leftSnap.val;
  let snappedHi = rightSnap.val;

  if (hi - lo >= minSpanSec && Math.abs(snappedHi - snappedLo) < 0.004) {
    const mid = (lo + hi) * 0.5;
    let upperIdx = 0;
    while (upperIdx < snapPoints.length && snapPoints[upperIdx] <= mid) {
      upperIdx++;
    }
    const lowerIdx = Math.max(0, upperIdx - 1);
    const clampedUpper = Math.min(snapPoints.length - 1, Math.max(lowerIdx + 1, upperIdx));
    snappedLo = snapPoints[lowerIdx];
    snappedHi = snapPoints[clampedUpper];
  }

  return forward ? [snappedLo, snappedHi] : [snappedHi, snappedLo];
}

/**
 * Applies a waveform drag selection [rangeStartSec, rangeEndSec] (in edited timeline coordinates)
 * bidirectionally onto transcript blocks/tokens.
 * - `mode === 'snap'` (default): Sub-Word Boundary Trim (<55% overlap) + waveform valley snapping.
 * - `mode === 'free'`: Strictly cuts the exact [rangeStartSec, rangeEndSec] selection without
 *   55% whole-token expansion or waveform valley snapping.
 */
export function applyWaveformSelectionToBlocks(
  state: PodcastProjectState,
  rangeStartSec: number,
  rangeEndSec: number,
  action: 'ripple_all' | 'mute_lane' | 'bleep_range',
  targetSpeakerId?: string,
  options?: { mode?: WaveformSelectionMode }
): WaveformCutOutcome {
  const isFreeMode = options?.mode === 'free';
  const timeline = computeEditedTimeline(state);
  const start = Math.min(rangeStartSec, rangeEndSec);
  const end = Math.max(rangeStartSec, rangeEndSec);

  const mappedById = new Map(timeline.mappedTokens.map((m) => [m.tokenId, m]));
  const oldPosById = new Map<string, { editedStartSec: number; editedEndSec: number }>();
  for (const m of timeline.mappedTokens) {
    if (!m.token.deleted) {
      oldPosById.set(m.tokenId, {
        editedStartSec: m.editedStartSec,
        editedEndSec: m.editedEndSec,
      });
    }
  }
  const hasHighResPeaks = state.tracks.some((t) => !t.isRef && t.peaks.length >= 32 && (t.durationMs ?? 0) > 0);
  let fullDeletedCount = 0;
  let subwordTrimmedCount = 0;
  const textParts: string[] = [];
  let minSrcMs = Number.MAX_SAFE_INTEGER;
  let maxSrcMs = 0;
  const newlyDeletedIds = new Set<string>();
  const leadingTrimmedIds = new Set<string>();
  let splitSeq = 0;

  const nextBlocks: TranscriptBlock[] = state.blocks.map((b) => ({
    ...b,
    tokens: b.tokens.flatMap((tok): TranscriptToken[] => {
      if (tok.deleted) return [tok];
      const mapped = mappedById.get(tok.id);
      if (!mapped) return [tok];

      const ovStart = Math.max(start, mapped.editedStartSec);
      const ovEnd = Math.min(end, mapped.editedEndSec);
      const ovDur = ovEnd - ovStart;
      if (ovDur <= (isFreeMode ? 0.002 : 0.008)) return [tok];

      minSrcMs = Math.min(minSrcMs, tok.sourceStartMs);
      maxSrcMs = Math.max(maxSrcMs, tok.sourceEndMs);
      if (tok.type === 'word') textParts.push(tok.text);

      const coverage = ovDur / Math.max(0.02, tok.durationSec);
      const trimsLeadingEdge =
        ovStart <= mapped.editedStartSec + 0.015 && ovEnd < mapped.editedEndSec - 0.015;

      if (action === 'ripple_all') {
        if (tok.type === 'silence') {
          const remDur = Number((tok.durationSec - ovDur).toFixed(3));
          const shouldDeleteSilence = isFreeMode
            ? remDur < 0.015
            : coverage >= 0.85 || remDur < 0.06;
          if (shouldDeleteSilence) {
            fullDeletedCount++;
            newlyDeletedIds.add(tok.id);
            return [{ ...tok, deleted: true, cutByWaveform: true }];
          }
          subwordTrimmedCount++;
          if (trimsLeadingEdge) {
            leadingTrimmedIds.add(tok.id);
          }
          const rawStartMs = trimsLeadingEdge
            ? tok.sourceStartMs + Math.round((tok.durationSec - remDur) * 1000)
            : tok.sourceStartMs;
          const effSilEndMs = tok.subwordTrimmed
            ? Math.min(tok.sourceEndMs, tok.sourceStartMs + Math.round(tok.durationSec * 1000))
            : tok.sourceEndMs;
          const snappedStartMs =
            !isFreeMode && hasHighResPeaks && trimsLeadingEdge
              ? Math.max(
                  tok.sourceStartMs,
                  Math.min(
                    Math.max(tok.sourceStartMs, effSilEndMs - 60),
                    snapSourceMsToWaveformValley(
                      state.tracks,
                      state.recordingMode,
                      rawStartMs,
                      b.speakerId,
                      22
                    )
                  )
                )
              : rawStartMs;
          const nextRemDur = trimsLeadingEdge
            ? Math.max(isFreeMode ? 0.015 : 0.06, Number(((effSilEndMs - snappedStartMs) / 1000).toFixed(3)))
            : remDur;
          return [
            {
              ...tok,
              sourceStartMs: snappedStartMs,
              durationSec: nextRemDur,
              subwordTrimmed: true,
            },
          ];
        }

        const marginLeftSec = ovStart - mapped.editedStartSec;
        const marginRightSec = mapped.editedEndSec - ovEnd;
        const minSplitMargin = isFreeMode ? 0.015 : 0.06;
        const minSplitCut = isFreeMode ? 0.005 : 0.02;
        if (marginLeftSec >= minSplitMargin && marginRightSec >= minSplitMargin && ovDur >= minSplitCut) {
          splitSeq++;
          const baseSrcStartMs = Math.round(mapped.effectiveSourceStartSec * 1000);
          const tokSrcEndMs = baseSrcStartMs + Math.round(tok.durationSec * 1000);
          const rawCutStartMs = baseSrcStartMs + Math.round(marginLeftSec * 1000);
          const rawCutEndMs = baseSrcStartMs + Math.round((ovEnd - mapped.editedStartSec) * 1000);
          const cutStartMs =
            !isFreeMode && hasHighResPeaks
              ? Math.max(
                  baseSrcStartMs + 50,
                  Math.min(
                    rawCutEndMs - 20,
                    snapSourceMsToWaveformValley(
                      state.tracks,
                      state.recordingMode,
                      rawCutStartMs,
                      b.speakerId,
                      22
                    )
                  )
                )
              : rawCutStartMs;
          const cutEndMs =
            !isFreeMode && hasHighResPeaks
              ? Math.min(
                  tokSrcEndMs - 50,
                  Math.max(
                    cutStartMs + 20,
                    snapSourceMsToWaveformValley(
                      state.tracks,
                      state.recordingMode,
                      rawCutEndMs,
                      b.speakerId,
                      22
                    )
                  )
                )
              : rawCutEndMs;
          const leftDur = Number(((cutStartMs - baseSrcStartMs) / 1000).toFixed(3));
          const cutDur = Number(((cutEndMs - cutStartMs) / 1000).toFixed(3));
          const rightDur = Number(((tokSrcEndMs - cutEndMs) / 1000).toFixed(3));
          const minKeepPart = isFreeMode ? 0.015 : 0.05;
          const minCutPart = isFreeMode ? 0.004 : 0.015;
          if (leftDur >= minKeepPart && cutDur >= minCutPart && rightDur >= minKeepPart) {
            subwordTrimmedCount++;
            const trimmedText = tok.text.trim();
            let leftText = tok.text;
            let rightText = tok.type === 'word' ? `${tok.text}(续)` : tok.text;
            if (tok.type === 'word' && trimmedText.length >= 2) {
              const totalSplitDur = Math.max(0.05, leftDur + cutDur + rightDur);
              const splitAt = Math.max(
                1,
                Math.min(
                  trimmedText.length - 1,
                  Math.round((trimmedText.length * leftDur) / totalSplitDur)
                )
              );
              leftText = trimmedText.slice(0, splitAt);
              rightText = trimmedText.slice(splitAt);
            }
            const midId = `${tok.id}__cut_${splitSeq}`;
            const rightId = `${tok.id}__tail_${splitSeq}`;
            oldPosById.set(tok.id, {
              editedStartSec: mapped.editedStartSec,
              editedEndSec: ovStart,
            });
            oldPosById.set(midId, {
              editedStartSec: ovStart,
              editedEndSec: ovEnd,
            });
            oldPosById.set(rightId, {
              editedStartSec: ovEnd,
              editedEndSec: mapped.editedEndSec,
            });
            newlyDeletedIds.add(midId);
            const leftTok: TranscriptToken = {
              ...tok,
              text: leftText,
              sourceStartMs: baseSrcStartMs,
              sourceEndMs: cutStartMs,
              durationSec: leftDur,
              origDurationSec: leftDur,
              subwordTrimmed: true,
            };
            const midDeletedTok: TranscriptToken = {
              ...tok,
              id: midId,
              text: '',
              sourceStartMs: cutStartMs,
              sourceEndMs: cutEndMs,
              durationSec: cutDur,
              origDurationSec: cutDur,
              deleted: true,
              cutByWaveform: true,
            };
            const rightTok: TranscriptToken = {
              ...tok,
              id: rightId,
              text: rightText,
              sourceStartMs: cutEndMs,
              sourceEndMs: tokSrcEndMs,
              durationSec: rightDur,
              origDurationSec: rightDur,
              subwordTrimmed: true,
              gapBeforeSec: 0,
            };
            return [leftTok, midDeletedTok, rightTok];
          }
        }

        const shouldDeleteWholeToken = isFreeMode
          ? tok.durationSec - ovDur < 0.015
          : coverage >= 0.55;
        if (shouldDeleteWholeToken) {
          fullDeletedCount++;
          newlyDeletedIds.add(tok.id);
          return [{ ...tok, deleted: true, cutByWaveform: true }];
        } else {
          subwordTrimmedCount++;
          if (trimsLeadingEdge) {
            leadingTrimmedIds.add(tok.id);
          }
          const minTrimmedDur = isFreeMode ? 0.015 : 0.05;
          const trimmedDur = Math.max(minTrimmedDur, Number((tok.durationSec - ovDur).toFixed(3)));
          const actualCutMs = Math.max(0, Math.round((tok.durationSec - trimmedDur) * 1000));
          const rawStartMs = trimsLeadingEdge
            ? tok.sourceStartMs + actualCutMs
            : tok.sourceStartMs;
          const effTokEndMs = tok.subwordTrimmed
            ? Math.min(tok.sourceEndMs, tok.sourceStartMs + Math.round(tok.durationSec * 1000))
            : tok.sourceEndMs;
          let finalStartMs = rawStartMs;
          let finalDur = trimmedDur;
          if (!isFreeMode && hasHighResPeaks) {
            if (trimsLeadingEdge) {
              const snappedStart = snapSourceMsToWaveformValley(
                state.tracks,
                state.recordingMode,
                rawStartMs,
                b.speakerId,
                22
              );
              finalStartMs = Math.max(
                tok.sourceStartMs,
                Math.min(Math.max(tok.sourceStartMs, effTokEndMs - 50), snappedStart)
              );
              finalDur = Math.max(
                0.05,
                Number(((effTokEndMs - finalStartMs) / 1000).toFixed(3))
              );
            } else {
              const rawKeepEndMs = rawStartMs + Math.round(trimmedDur * 1000);
              const snappedEnd = snapSourceMsToWaveformValley(
                state.tracks,
                state.recordingMode,
                rawKeepEndMs,
                b.speakerId,
                22
              );
              const boundedEnd = Math.max(
                rawStartMs + 50,
                Math.min(effTokEndMs, snappedEnd)
              );
              finalDur = Math.max(0.05, Number(((boundedEnd - rawStartMs) / 1000).toFixed(3)));
            }
          }
          return [
            {
              ...tok,
              sourceStartMs: finalStartMs,
              durationSec: finalDur,
              subwordTrimmed: true,
            },
          ];
        }
      } else if (action === 'mute_lane') {
        if ((!targetSpeakerId || b.speakerId === targetSpeakerId) && tok.type !== 'silence') {
          fullDeletedCount++;
          return [{ ...tok, trackMuted: true }];
        }
        return [tok];
      } else {
        if (tok.type !== 'silence') {
          fullDeletedCount++;
          return [{ ...tok, bleeped: true, bleepStyle: 'sine_1khz_bleep' }];
        }
        return [tok];
      }
    }),
  }));

  if (action === 'ripple_all') {
    const rawRemoved: Array<{ s: number; e: number }> = end > start + 0.002 ? [{ s: start, e: end }] : [];
    for (const delId of newlyDeletedIds) {
      const pos = oldPosById.get(delId);
      if (pos && pos.editedEndSec > pos.editedStartSec + 0.001) {
        rawRemoved.push({ s: pos.editedStartSec, e: pos.editedEndSec });
      }
    }
    rawRemoved.sort((a, b) => a.s - b.s);
    const mergedRemoved: Array<{ s: number; e: number }> = [];
    for (const r of rawRemoved) {
      const prev = mergedRemoved[mergedRemoved.length - 1];
      if (!prev || r.s > prev.e + 0.002) {
        mergedRemoved.push({ ...r });
      } else {
        prev.e = Math.max(prev.e, r.e);
      }
    }
    const sumRemovedOverlap = (a: number, b: number): number => {
      if (b <= a + 0.0005) return 0;
      let total = 0;
      for (const r of mergedRemoved) {
        if (r.e <= a) continue;
        if (r.s >= b) break;
        total += Math.min(b, r.e) - Math.max(a, r.s);
      }
      return total;
    };

    let prevKept: TranscriptToken | null = null;
    let sawNewlyDeletedBetween = false;

    for (let bIdx = 0; bIdx < nextBlocks.length; bIdx++) {
      const blk = nextBlocks[bIdx];
      for (let tIdx = 0; tIdx < blk.tokens.length; tIdx++) {
        const tok = blk.tokens[tIdx];
        if (tok.deleted) {
          if (newlyDeletedIds.has(tok.id)) {
            sawNewlyDeletedBetween = true;
          }
          continue;
        }
        if (prevKept) {
          const oldPrev = oldPosById.get(prevKept.id);
          const oldCurr = oldPosById.get(tok.id);
          if (oldPrev && oldCurr) {
            const prevGapDur = Math.max(0, oldCurr.editedStartSec - oldPrev.editedEndSec);
            const cutOverlapDirect = Math.max(
              0,
              Math.min(end, oldCurr.editedStartSec) - Math.max(start, oldPrev.editedEndSec)
            );
            const shouldAssignExplicitGap =
              cutOverlapDirect > 0.002 ||
              sawNewlyDeletedBetween ||
              leadingTrimmedIds.has(tok.id) ||
              typeof tok.gapBeforeSec === 'number';
            if (shouldAssignExplicitGap) {
              const removedBetween = sumRemovedOverlap(oldPrev.editedEndSec, oldCurr.editedStartSec);
              const keptGapSec = Number(Math.max(0, prevGapDur - removedBetween).toFixed(3));
              if (cutOverlapDirect > 0.002 && fullDeletedCount === 0 && subwordTrimmedCount === 0) {
                subwordTrimmedCount++;
                const gapStartSrcMs = Math.max(
                  0,
                  prevKept.sourceEndMs + Math.round(Math.max(0, start - oldPrev.editedEndSec) * 1000)
                );
                const gapEndSrcMs = Math.max(
                  gapStartSrcMs + 10,
                  gapStartSrcMs + Math.round(cutOverlapDirect * 1000)
                );
                if (minSrcMs === Number.MAX_SAFE_INTEGER) {
                  minSrcMs = gapStartSrcMs;
                  maxSrcMs = gapEndSrcMs;
                } else {
                  minSrcMs = Math.min(minSrcMs, gapStartSrcMs);
                  maxSrcMs = Math.max(maxSrcMs, gapEndSrcMs);
                }
              }
              blk.tokens[tIdx] = { ...tok, gapBeforeSec: keptGapSec };
            }
          }
        }
        prevKept = blk.tokens[tIdx];
        sawNewlyDeletedBetween = false;
      }
    }
  }

  return {
    nextBlocks,
    fullDeletedCount,
    subwordTrimmedCount,
    affectedText: textParts.join(''),
    sourceRangeMs: minSrcMs < maxSrcMs ? [minSrcMs, maxSrcMs] : null,
  };
}

export interface WaveformFocusViewportInput {
  blockStartSec: number;
  blockEndSec: number;
  totalSec: number;
  maxZoom: number;
  anchorSec?: number;
  currentZoom?: number;
  currentViewStartRatio?: number;
  preserveHigherZoom?: boolean;
}

export interface WaveformFocusViewportResult {
  zoom: number;
  viewStartRatio: number;
  seekSec: number;
}

/**
 * Computes the target waveform zoom & horizontal scroll offset so clicking a speaker block
 * frames that block's acoustic waveform (keeping `visibleSec <= 24s` for word-level clarity)
 * while respecting higher user zoom when clicking an individual word.
 */
export function computeWaveformFocusViewport(
  input: WaveformFocusViewportInput
): WaveformFocusViewportResult {
  const safeTotal = Math.max(1, input.totalSec);
  const safeMaxZoom = Math.max(1, input.maxZoom);
  const startSec = Math.max(0, Math.min(safeTotal, input.blockStartSec));
  const endSec = Math.max(startSec + 0.05, Math.min(safeTotal, input.blockEndSec));
  const seekSec =
    typeof input.anchorSec === 'number'
      ? Math.max(0, Math.min(safeTotal, input.anchorSec))
      : startSec;
  const blockDurSec = Math.max(0.05, endSec - startSec);

  // Cap block-focus window at 24s so inline word boundaries & labels appear in the waveform canvas
  const idealWindowSec = Math.min(24.0, Math.max(4.2, blockDurSec * 1.45));
  const desiredZoomRaw = Math.max(1, Math.min(safeMaxZoom, safeTotal / idealWindowSec));

  if (
    input.preserveHigherZoom &&
    typeof input.currentZoom === 'number' &&
    input.currentZoom > desiredZoomRaw * 1.02
  ) {
    const finalZoom = Math.min(
      safeMaxZoom,
      input.currentZoom < 10 ? Number(input.currentZoom.toFixed(2)) : Math.round(input.currentZoom)
    );
    if (finalZoom <= 1.005) {
      return { zoom: 1, viewStartRatio: 0, seekSec };
    }
    const span = 1 / finalZoom;
    const seekRatio = seekSec / safeTotal;
    const maxStart = Math.max(0, 1 - span);
    const curStart = Math.max(0, Math.min(maxStart, input.currentViewStartRatio ?? 0));
    const viewStartRatio =
      seekRatio >= curStart + span * 0.12 && seekRatio <= curStart + span * 0.84
        ? curStart
        : Math.max(0, Math.min(maxStart, seekRatio - span * 0.25));
    return { zoom: finalZoom, viewStartRatio, seekSec };
  }

  if (desiredZoomRaw <= 1.005) {
    return { zoom: 1, viewStartRatio: 0, seekSec };
  }

  const finalZoom =
    desiredZoomRaw < 10 ? Number(desiredZoomRaw.toFixed(2)) : Math.round(desiredZoomRaw);
  const span = 1 / finalZoom;
  const windowSec = safeTotal * span;
  const seekRatio = seekSec / safeTotal;

  let adjustedStart =
    blockDurSec <= windowSec * 0.78
      ? ((startSec + endSec) * 0.5) / safeTotal - span * 0.5
      : seekRatio - span * 0.14;

  if (seekRatio < adjustedStart + span * 0.08) {
    adjustedStart = seekRatio - span * 0.08;
  } else if (seekRatio > adjustedStart + span * 0.88) {
    adjustedStart = seekRatio - span * 0.88;
  }

  const maxStart = Math.max(0, 1 - span);
  const viewStartRatio = Math.max(0, Math.min(maxStart, adjustedStart));

  return { zoom: finalZoom, viewStartRatio, seekSec };
}

export const PLAYHEAD_AUTO_SCROLL_ANCHOR = 1 / 3;
export const PAGE_SCROLL_TRIGGER_RIGHT = 0.90;
export const PAGE_SCROLL_TRIGGER_LEFT = 0.02;
export const PAGE_SCROLL_LANDING_ANCHOR = 0.12;

export interface WaveformAutoScrollInput {
  playheadSec: number;
  totalSec: number;
  zoom: number;
  currentViewStartRatio: number;
  isPlaying: boolean;
  viewportWidthPx?: number;
  anchorFraction?: number;
  mode?: 'page' | 'continuous';
}

/**
 * 计算多轨波形自动滚动时的视窗起点比例：
 * 采用“一段一段跳过（Page/Chunk Jump）”模式，避免随播放每一帧实时滚动导致视觉眼花。
 * 播放过程中，视窗保持静止，仅当游标接近右边缘（>=90%）或跑出左边界（<2%）时，
 * 视窗向前跳过一段，并将游标置于新视窗舒适的前段位置（约 12%）；
 * 暂停状态下当游标落出可视安全区（<4% 或 >94%）时，同样跳跃定位至舒适位置。
 */
export function computeAutoScrollViewStartRatio(input: WaveformAutoScrollInput): number {
  if (!Number.isFinite(input.zoom) || input.zoom <= 1.005 || input.totalSec <= 0) {
    return 0;
  }

  const span = 1 / input.zoom;
  const maxStart = Math.max(0, 1 - span);
  const curStart = Math.max(0, Math.min(maxStart, input.currentViewStartRatio));
  const playRatio = Math.max(0, Math.min(1, input.playheadSec / input.totalSec));
  const landingAnchor = Math.max(0.05, Math.min(0.5, input.anchorFraction ?? PAGE_SCROLL_LANDING_ANCHOR));
  const desiredStart = Math.max(0, Math.min(maxStart, playRatio - span * landingAnchor));

  if (input.mode === 'continuous') {
    const anchor = Math.max(0.05, Math.min(0.9, input.anchorFraction ?? PLAYHEAD_AUTO_SCROLL_ANCHOR));
    const continuousDesired = Math.max(0, Math.min(maxStart, playRatio - span * anchor));
    if (input.isPlaying) {
      if (playRatio >= curStart + span * anchor || playRatio < curStart + span * 0.04) {
        const widthPx = Math.max(320, input.viewportWidthPx ?? 1200);
        const deltaPx = Math.abs(continuousDesired - curStart) * input.zoom * widthPx;
        if (deltaPx < 0.5 && continuousDesired > 0 && continuousDesired < maxStart) {
          return curStart;
        }
        return continuousDesired;
      }
      return curStart;
    }
    if (playRatio < curStart + span * 0.04 || playRatio > curStart + span * 0.94) {
      return continuousDesired;
    }
    return curStart;
  }

  // 默认 'page' 模式：一段一段跳过（波形静止，触边翻页）
  if (input.isPlaying) {
    // 游标在当前视窗 [2%, 90%] 安全范围内时，视窗完全静止不动
    if (playRatio >= curStart + span * PAGE_SCROLL_TRIGGER_RIGHT || playRatio < curStart + span * PAGE_SCROLL_TRIGGER_LEFT) {
      return desiredStart;
    }
    return curStart;
  }

  // 暂停状态：当游标落出当前视窗安全区（<4% 或 >94%）时跳跃定位
  if (playRatio < curStart + span * 0.04 || playRatio > curStart + span * 0.94) {
    return desiredStart;
  }
  return curStart;
}

export const WORD_TIMELINE_MIN_ZOOM = 100;

export function isWordTimelineZoom(zoom: number): boolean {
  return Number.isFinite(zoom) && Math.round(zoom) >= WORD_TIMELINE_MIN_ZOOM;
}

export interface TimelineWordAnnotation {
  id: string;
  tokenId: string;
  speakerId: string;
  text: string;
  editedStartSec: number;
  editedEndSec: number;
  isFiller?: boolean;
  isLaughter?: boolean;
  isSubwordTrimmed?: boolean;
  isSubCharSplit: boolean;
}

export interface BuildWordTimelineOptions {
  viewStartSec: number;
  viewEndSec: number;
  viewportWidthPx: number;
  totalSec: number;
  coldOpenEnabled?: boolean;
  highlights?: HighlightClip[];
  blocks?: TranscriptBlock[];
  charWidthPx?: number;
}

/**
 * Splits a multi-character phrase/token into atomic lexical units (one unit per CJK character,
 * contiguous ASCII/Latin/digit word per unit) with trailing punctuation attached cleanly.
 */
export function splitLexicalUnits(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return [trimmed];
  }

  const units: string[] = [];
  let pendingPrefix = '';
  const tokenRe =
    /([\u3400-\u9fff\uf900-\ufaff]|[A-Za-z0-9_'-]+(?:\.[A-Za-z0-9_'-]+)*|[，。？！、；：,.?!…—”’）》】\s]+|.)/g;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(trimmed)) !== null) {
    const part = match[1];
    if (/^[，。？！、；：,.?!…—”’）》】\s]+$/.test(part)) {
      const cleanPunct = part.replace(/\s+/g, '');
      if (cleanPunct) {
        if (units.length > 0) {
          units[units.length - 1] += cleanPunct;
        } else {
          pendingPrefix += cleanPunct;
        }
      }
    } else if (/^[\u3400-\u9fff\uf900-\ufaff]$|^[A-Za-z0-9_'-]+(?:\.[A-Za-z0-9_'-]+)*$/.test(part)) {
      units.push(pendingPrefix + part);
      pendingPrefix = '';
    } else {
      pendingPrefix += part;
    }
  }

  if (pendingPrefix) {
    if (units.length > 0) {
      units[units.length - 1] += pendingPrefix;
    } else {
      units.push(pendingPrefix);
    }
  }

  return units;
}

/**
 * Builds O(log N + K) visible word/character timeline annotations intersecting `[viewStartSec, viewEndSec]`,
 * keeping exact inter-word silence gaps intact and adaptively subdividing multi-character tokens at deep zoom.
 */
export function buildVisibleWordTimelineAnnotations(
  timeline: TimelineComputation,
  options: BuildWordTimelineOptions
): TimelineWordAnnotation[] {
  const totalSec = options.totalSec;
  if (
    !Number.isFinite(totalSec) ||
    totalSec <= 0 ||
    !Number.isFinite(options.viewStartSec) ||
    !Number.isFinite(options.viewEndSec) ||
    options.viewEndSec <= options.viewStartSec
  ) {
    return [];
  }

  interface RawAnnotationItem {
    tokenId: string;
    speakerId: string;
    text: string;
    editedStartSec: number;
    editedEndSec: number;
    isFiller?: boolean;
    isLaughter?: boolean;
    isSubwordTrimmed?: boolean;
  }

  const rawItems: RawAnnotationItem[] = [];

  // 1. Optional Cold Open highlight lexical mapping into [2.0s .. coldOpenDurationSec]
  if (
    options.coldOpenEnabled &&
    options.highlights &&
    options.highlights.length > 0 &&
    timeline.coldOpenDurationSec > 0 &&
    options.viewStartSec < timeline.coldOpenDurationSec
  ) {
    let cursorSec = 2.0;
    for (const hl of options.highlights) {
      const hlStart = cursorSec;
      const hlEnd = Math.min(timeline.coldOpenDurationSec, cursorSec + hl.durationSec);
      cursorSec += hl.durationSec + 0.65;
      if (hlEnd <= hlStart) continue;
      if (hlEnd < options.viewStartSec || hlStart > options.viewEndSec) continue;

      const hlSourceSpanMs = Math.max(1, hl.sourceEndMs - hl.sourceStartMs);
      const hlEditedSpanSec = hlEnd - hlStart;
      let matchedAny = false;

      if (options.blocks && options.blocks.length > 0) {
        for (const blk of options.blocks) {
          if (blk.speakerId !== hl.speakerId) continue;
          for (const tok of blk.tokens) {
            if (tok.deleted || tok.trackMuted || tok.type === 'silence') continue;
            if (tok.sourceEndMs <= hl.sourceStartMs || tok.sourceStartMs >= hl.sourceEndMs) {
              continue;
            }
            const clippedStartMs = Math.max(hl.sourceStartMs, tok.sourceStartMs);
            const clippedEndMs = Math.min(hl.sourceEndMs, tok.sourceEndMs);
            if (clippedEndMs <= clippedStartMs) continue;
            const es =
              hlStart + ((clippedStartMs - hl.sourceStartMs) / hlSourceSpanMs) * hlEditedSpanSec;
            const ee =
              hlStart + ((clippedEndMs - hl.sourceStartMs) / hlSourceSpanMs) * hlEditedSpanSec;
            const isLaughter = tok.type === 'laughter';
            const txt = isLaughter ? tok.text.trim() || '😂笑声' : tok.text;
            if (!txt.trim()) continue;
            matchedAny = true;
            if (ee < options.viewStartSec || es > options.viewEndSec) continue;
            rawItems.push({
              tokenId: `cold_${hl.id}_${tok.id}`,
              speakerId: hl.speakerId,
              text: txt,
              editedStartSec: es,
              editedEndSec: ee,
              isFiller: tok.fillerTag === 'pure',
              isLaughter,
              isSubwordTrimmed: tok.subwordTrimmed,
            });
          }
        }
      }

      if (!matchedAny && hl.text.trim()) {
        rawItems.push({
          tokenId: `cold_${hl.id}`,
          speakerId: hl.speakerId,
          text: hl.text.trim(),
          editedStartSec: hlStart,
          editedEndSec: hlEnd,
        });
      }
    }
  }

  // 2. Binary search mappedTokens for O(log N + K) body token slice
  const arr = timeline.mappedTokens;
  let lo = 0;
  let hi = arr.length - 1;
  let startIdx = arr.length;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].editedEndSec >= options.viewStartSec) {
      startIdx = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  for (let k = startIdx; k < arr.length; k++) {
    const m = arr[k];
    if (m.editedStartSec > options.viewEndSec) break;
    if (m.token.deleted || m.token.trackMuted || m.token.type === 'silence') continue;
    if (m.editedEndSec <= m.editedStartSec) continue;

    const isLaughter = m.token.type === 'laughter';
    const txt = isLaughter ? m.token.text.trim() || '😂笑声' : m.token.text;
    if (!txt.trim()) continue;

    rawItems.push({
      tokenId: m.tokenId,
      speakerId: m.speakerId,
      text: txt,
      editedStartSec: m.editedStartSec,
      editedEndSec: m.editedEndSec,
      isFiller: m.token.fillerTag === 'pure',
      isLaughter,
      isSubwordTrimmed: m.token.subwordTrimmed,
    });
  }

  rawItems.sort((a, b) => a.editedStartSec - b.editedStartSec || a.editedEndSec - b.editedEndSec);

  // 3. Adaptively preserve word-level units vs. proportionally subdivide characters at deep zoom
  const visibleDur = Math.max(0.05, options.viewEndSec - options.viewStartSec);
  const pxPerSec = Math.max(1, options.viewportWidthPx) / visibleDur;
  const charW = options.charWidthPx ?? 11.5;
  const out: TimelineWordAnnotation[] = [];

  for (const item of rawItems) {
    const units = item.isLaughter ? [item.text] : splitLexicalUnits(item.text);
    const tokenDur = Math.max(0.001, item.editedEndSec - item.editedStartSec);
    const tokenPx = tokenDur * pxPerSec;

    const shouldSubdivide =
      !item.isLaughter &&
      units.length >= 2 &&
      (tokenPx / units.length >= charW + 5.5 ||
        (units.length >= 4 && tokenPx < units.length * charW));

    if (!shouldSubdivide) {
      out.push({
        id: item.tokenId,
        tokenId: item.tokenId,
        speakerId: item.speakerId,
        text: item.text.trim(),
        editedStartSec: item.editedStartSec,
        editedEndSec: item.editedEndSec,
        isFiller: item.isFiller,
        isLaughter: item.isLaughter,
        isSubwordTrimmed: item.isSubwordTrimmed,
        isSubCharSplit: false,
      });
      continue;
    }

    const weights = units.map((u) => {
      const asciiMatch = u.match(/[A-Za-z0-9_'-]+(?:\.[A-Za-z0-9_'-]+)*/);
      if (asciiMatch && !/[\u3400-\u9fff\uf900-\ufaff]/.test(u)) {
        return Math.max(1.2, asciiMatch[0].length * 0.55);
      }
      return 1.0;
    });
    const totalWeight = weights.reduce((s, w) => s + w, 0) || units.length;
    let acc = 0;

    for (let idx = 0; idx < units.length; idx++) {
      const w = weights[idx];
      const subStart = item.editedStartSec + (acc / totalWeight) * tokenDur;
      acc += w;
      const subEnd =
        idx === units.length - 1
          ? item.editedEndSec
          : item.editedStartSec + (acc / totalWeight) * tokenDur;
      if (subEnd < options.viewStartSec || subStart > options.viewEndSec) continue;

      out.push({
        id: `${item.tokenId}__${idx}`,
        tokenId: item.tokenId,
        speakerId: item.speakerId,
        text: units[idx],
        editedStartSec: subStart,
        editedEndSec: subEnd,
        isFiller: item.isFiller,
        isLaughter: false,
        isSubwordTrimmed: idx === units.length - 1 ? item.isSubwordTrimmed : false,
        isSubCharSplit: idx > 0,
      });
    }
  }

  return out;
}

/**
 * 将编辑态时间区间（秒）通过 playbackSpans 1:1 映射为指定音轨的源码毫秒区间。
 * 即使该区间横跨静音气口、未分词间隙或他人发言片段，仍能精确投影到原音轨位置。
 */
export function projectEditedRangeToSourceRangesMs(
  stateOrTimeline: PodcastProjectState | TimelineComputation,
  trackId: string,
  editedStartSec: number,
  editedEndSec: number,
  tracksOverride?: SpeakerTrack[]
): Array<{ sourceStartMs: number; sourceEndMs: number }> {
  const timeline =
    'playbackSpans' in stateOrTimeline ? stateOrTimeline : computeEditedTimeline(stateOrTimeline);
  const start = Math.max(0, Math.min(editedStartSec, editedEndSec));
  const end = Math.max(start, Math.max(editedStartSec, editedEndSec));
  if (end - start <= 0.005) return [];

  const tracksList =
    tracksOverride ?? ('tracks' in stateOrTimeline ? stateOrTimeline.tracks : undefined);
  const track = tracksList?.find((t) => t.id === trackId);
  const maxTrackMs =
    track && typeof track.durationMs === 'number' && track.durationMs > 0
      ? Math.round(track.durationMs)
      : Number.MAX_SAFE_INTEGER;

  const rawRanges: Array<{ sourceStartMs: number; sourceEndMs: number }> = [];
  for (const span of timeline.playbackSpans) {
    const ovStart = Math.max(start, span.editedStartSec);
    const ovEnd = Math.min(end, span.editedEndSec);
    if (ovEnd - ovStart <= 0.004) continue;
    const srcStartMs = Math.max(
      0,
      Math.round((span.sourceStartSec + (ovStart - span.editedStartSec)) * 1000)
    );
    const srcEndMs = Math.min(
      maxTrackMs,
      Math.round((span.sourceStartSec + (ovEnd - span.editedStartSec)) * 1000)
    );
    if (srcEndMs - srcStartMs >= 8) {
      rawRanges.push({ sourceStartMs: srcStartMs, sourceEndMs: srcEndMs });
    }
  }

  if (rawRanges.length <= 1) return rawRanges;
  rawRanges.sort((a, b) => a.sourceStartMs - b.sourceStartMs);
  const merged: Array<{ sourceStartMs: number; sourceEndMs: number }> = [];
  for (const r of rawRanges) {
    const prev = merged[merged.length - 1];
    if (!prev || r.sourceStartMs > prev.sourceEndMs + 4) {
      merged.push({ ...r });
    } else {
      prev.sourceEndMs = Math.max(prev.sourceEndMs, r.sourceEndMs);
    }
  }
  return merged;
}

/**
 * 将某条音轨的源码毫秒静音区间投影回当前编辑态全轴百分比 `[startRatio, endRatio]`，
 * 以便后续在全轴波纹剪辑后静音遮罩也能跟随后续音频前移而保持同步。
 */
export function projectSourceRangesMsToEditedRatios(
  stateOrTimeline: PodcastProjectState | TimelineComputation,
  ranges: Array<{ sourceStartMs: number; sourceEndMs: number }>,
  totalSecOverride?: number
): Array<{ startRatio: number; endRatio: number }> {
  if (!ranges || ranges.length === 0) return [];
  const timeline =
    'playbackSpans' in stateOrTimeline ? stateOrTimeline : computeEditedTimeline(stateOrTimeline);
  const totalDur = Math.max(0, totalSecOverride ?? timeline.totalEditedDurationSec);
  if (totalDur <= 0.01) return [];

  const ratios: Array<{ startRatio: number; endRatio: number }> = [];
  for (const r of ranges) {
    const rStartSec = r.sourceStartMs / 1000;
    const rEndSec = r.sourceEndMs / 1000;
    if (rEndSec <= rStartSec) continue;
    for (const span of timeline.playbackSpans) {
      const ovSrcStart = Math.max(rStartSec, span.sourceStartSec);
      const ovSrcEnd = Math.min(rEndSec, span.sourceEndSec);
      if (ovSrcEnd - ovSrcStart <= 0.004) continue;
      const edStart = span.editedStartSec + (ovSrcStart - span.sourceStartSec);
      const edEnd = span.editedStartSec + (ovSrcEnd - span.sourceStartSec);
      const startRatio = Math.max(0, Math.min(1, edStart / totalDur));
      const endRatio = Math.max(startRatio, Math.min(1, edEnd / totalDur));
      if (endRatio - startRatio > 0.0001) {
        ratios.push({ startRatio, endRatio });
      }
    }
  }

  if (ratios.length <= 1) return ratios;
  ratios.sort((a, b) => a.startRatio - b.startRatio);
  const merged: Array<{ startRatio: number; endRatio: number }> = [];
  for (const r of ratios) {
    const prev = merged[merged.length - 1];
    if (!prev || r.startRatio > prev.endRatio + 0.0005) {
      merged.push({ ...r });
    } else {
      prev.endRatio = Math.max(prev.endRatio, r.endRatio);
    }
  }
  return merged;
}

export interface TrackMuteOutcome {
  nextState: PodcastProjectState;
  addedRanges: TrackMuteRange[];
  mutedDurationSec: number;
  affectedTokenCount: number;
  targetTrackId: string;
}

/**
 * 仅对指定单轨（如当前鼠标 hover 的音轨）写入编辑选区对应的源码静音区间，
 * 保持其他音轨完整与总时长不变。
 */
export function applyTrackMuteSelectionToProject(
  state: PodcastProjectState,
  rangeStartSec: number,
  rangeEndSec: number,
  targetTrackId: string
): TrackMuteOutcome {
  const timeline = computeEditedTimeline(state);
  const start = Math.min(rangeStartSec, rangeEndSec);
  const end = Math.max(rangeStartSec, rangeEndSec);
  const mappedRanges = projectEditedRangeToSourceRangesMs(
    timeline,
    targetTrackId,
    start,
    end,
    state.tracks
  );

  if (mappedRanges.length === 0) {
    return {
      nextState: state,
      addedRanges: [],
      mutedDurationSec: 0,
      affectedTokenCount: 0,
      targetTrackId,
    };
  }

  const newEntries: TrackMuteRange[] = mappedRanges.map((r, idx) => ({
    id: `tm_${targetTrackId}_${r.sourceStartMs}_${r.sourceEndMs}_${Date.now().toString(36)}_${idx}`,
    trackId: targetTrackId,
    sourceStartMs: r.sourceStartMs,
    sourceEndMs: r.sourceEndMs,
  }));

  const combined = [...(state.trackMuteRanges ?? []), ...newEntries];
  // 按 trackId 分组排序并合并重叠/相邻区间（<= 15ms 间隙合并）
  const byTrack = new Map<string, TrackMuteRange[]>();
  for (const item of combined) {
    if (item.sourceEndMs <= item.sourceStartMs) continue;
    const arr = byTrack.get(item.trackId) ?? [];
    arr.push(item);
    byTrack.set(item.trackId, arr);
  }
  const mergedAll: TrackMuteRange[] = [];
  for (const [, list] of byTrack) {
    list.sort((a, b) => a.sourceStartMs - b.sourceStartMs);
    for (const item of list) {
      const prev = mergedAll[mergedAll.length - 1];
      if (!prev || prev.trackId !== item.trackId || item.sourceStartMs > prev.sourceEndMs + 15) {
        mergedAll.push({ ...item });
      } else {
        prev.sourceEndMs = Math.max(prev.sourceEndMs, item.sourceEndMs);
      }
    }
  }

  // 仅当同一说话人的非静音词被选区覆盖 >= 85% 时同步标记 tok.trackMuted（部分覆盖绝不整词静音）
  const targetTrack = state.tracks.find((t) => t.id === targetTrackId);
  const targetSpeakerId = targetTrack?.id ?? targetTrackId;
  const mappedById = new Map(timeline.mappedTokens.map((m) => [m.tokenId, m]));
  let affectedTokenCount = 0;
  const nextBlocks = state.blocks.map((b) => {
    if (b.speakerId !== targetSpeakerId) return b;
    let blockChanged = false;
    const nextTokens = b.tokens.map((tok) => {
      if (tok.deleted || tok.type === 'silence' || tok.trackMuted) return tok;
      const mapped = mappedById.get(tok.id);
      if (!mapped) return tok;
      const ovDur =
        Math.min(end, mapped.editedEndSec) - Math.max(start, mapped.editedStartSec);
      const coverage = ovDur / Math.max(0.02, tok.durationSec);
      if (ovDur > 0.008 && coverage >= 0.85) {
        affectedTokenCount++;
        blockChanged = true;
        return { ...tok, trackMuted: true };
      }
      return tok;
    });
    return blockChanged ? { ...b, tokens: nextTokens } : b;
  });

  const mutedDurationSec = Number(
    (mappedRanges.reduce((acc, r) => acc + (r.sourceEndMs - r.sourceStartMs), 0) / 1000).toFixed(
      3
    )
  );

  return {
    nextState: {
      ...state,
      blocks: nextBlocks,
      trackMuteRanges: mergedAll,
    },
    addedRanges: newEntries,
    mutedDurationSec,
    affectedTokenCount,
    targetTrackId,
  };
}

/**
 * Maps `prevPlayheadSec` from `prevTimeline` to `nextTimeline` by anchoring on the
 * underlying original source content (`sourceStartSec`..`sourceEndSec`) rather than
 * raw edited timestamp, so deleting/compressing earlier audio keeps the playhead
 * on the same original content.
 */
export function remapPlayheadAfterTimelineEdit(
  prevTimeline: TimelineComputation,
  nextTimeline: TimelineComputation,
  prevPlayheadSec: number
): number {
  const nextTotal = Math.max(0, nextTimeline.totalEditedDurationSec);
  if (nextTotal <= 0) return 0;

  const clampedPrev = Math.max(0, prevPlayheadSec);
  const prevPrefixSec = prevTimeline.coldOpenDurationSec + prevTimeline.introVoiceoverDurationSec;
  if (clampedPrev < prevPrefixSec - 0.001) {
    return Math.min(clampedPrev, nextTotal);
  }

  const prevSpans = prevTimeline.playbackSpans;
  const nextSpans = nextTimeline.playbackSpans;
  if (prevSpans.length === 0 || nextSpans.length === 0) {
    return Math.min(clampedPrev, nextTotal);
  }

  // Find the last span in prevSpans with editedStartSec <= clampedPrev
  let lo = 0;
  let hi = prevSpans.length - 1;
  let matchIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (prevSpans[mid].editedStartSec <= clampedPrev + 0.0005) {
      matchIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  let targetSourceSec: number;
  if (matchIdx >= 0) {
    const s = prevSpans[matchIdx];
    if (clampedPrev <= s.editedEndSec + 0.0005) {
      const offset = Math.max(0, Math.min(s.editedEndSec - s.editedStartSec, clampedPrev - s.editedStartSec));
      targetSourceSec = s.sourceStartSec + offset;
    } else {
      targetSourceSec = s.sourceEndSec + (clampedPrev - s.editedEndSec);
    }
  } else {
    targetSourceSec = prevSpans[0].sourceStartSec;
  }

  // Locate targetSourceSec in nextSpans
  for (let i = 0; i < nextSpans.length; i++) {
    const ns = nextSpans[i];
    if (
      targetSourceSec >= ns.sourceStartSec - 0.0005 &&
      targetSourceSec <= ns.sourceEndSec + 0.0005
    ) {
      const offset = Math.max(
        0,
        Math.min(ns.sourceEndSec - ns.sourceStartSec, targetSourceSec - ns.sourceStartSec)
      );
      return Number(Math.max(0, Math.min(nextTotal, ns.editedStartSec + offset)).toFixed(3));
    }
    if (ns.sourceStartSec > targetSourceSec) {
      // targetSourceSec fell inside a deleted region; land on the cut seam right after it
      return Number(Math.max(0, Math.min(nextTotal, ns.editedStartSec)).toFixed(3));
    }
  }

  return Number(nextTotal.toFixed(3));
}

const HIGHLIGHT_PUNCT_RE = /[\s\u3000，。！？、；：“”‘’（）().,!?;:'"《》【】—…·]/g;

function normalizeHighlightMatchText(text: string): string {
  return text.replace(HIGHLIGHT_PUNCT_RE, '');
}

/**
 * 在全片非删除词元中跨段落精确检索指定文本对应的原始音源时间区间 [sourceStartMs, sourceEndMs]。
 * 若文本在多处重复出现，优先返回最接近 `preferSourceMs` 的位置。
 */
export function findSourceRangeByHighlightText(
  blocks: PodcastProjectState['blocks'],
  text: string,
  preferSourceMs?: number
): { sourceStartMs: number; sourceEndMs: number; speakerId: string } | null {
  const target = normalizeHighlightMatchText(text);
  if (!target || target.length < 2) return null;

  const flatTokens: Array<{
    speakerId: string;
    text: string;
    sourceStartMs: number;
    sourceEndMs: number;
  }> = [];
  for (const b of blocks) {
    for (const t of b.tokens) {
      if (!t.deleted && t.type === 'word' && t.text.trim().length > 0) {
        flatTokens.push({
          speakerId: b.speakerId,
          text: t.text,
          sourceStartMs: t.sourceStartMs,
          sourceEndMs: t.sourceEndMs,
        });
      }
    }
  }
  if (flatTokens.length === 0) return null;
  flatTokens.sort((a, b) => a.sourceStartMs - b.sourceStartMs);

  const charToTokenIdx: number[] = [];
  let fullNorm = '';
  for (let ti = 0; ti < flatTokens.length; ti++) {
    const normTok = normalizeHighlightMatchText(flatTokens[ti].text);
    for (let ci = 0; ci < normTok.length; ci++) {
      fullNorm += normTok[ci];
      charToTokenIdx.push(ti);
    }
  }

  let searchFrom = 0;
  let best: { sourceStartMs: number; sourceEndMs: number; speakerId: string; dist: number } | null = null;
  while (searchFrom <= fullNorm.length - target.length) {
    const idx = fullNorm.indexOf(target, searchFrom);
    if (idx === -1) break;
    const firstTok = flatTokens[charToTokenIdx[idx]];
    const lastTok = flatTokens[charToTokenIdx[idx + target.length - 1]];
    const sMs = firstTok.sourceStartMs;
    const eMs = Math.max(sMs + 100, lastTok.sourceEndMs);
    const dist = typeof preferSourceMs === 'number' ? Math.abs(sMs - preferSourceMs) : 0;
    if (!best || dist < best.dist) {
      best = { sourceStartMs: sMs, sourceEndMs: eMs, speakerId: firstTok.speakerId, dist };
    }
    searchFrom = idx + 1;
  }

  return best
    ? { sourceStartMs: best.sourceStartMs, sourceEndMs: best.sourceEndMs, speakerId: best.speakerId }
    : null;
}

/**
 * 将正片剪辑后时间轴秒数（editedSec）通过 playbackSpans 映射回原始音频毫秒（sourceMs）。
 */
export function mapEditedSecToSourceMs(
  timeline: TimelineComputation,
  editedSec: number
): number | null {
  const spans = timeline.playbackSpans;
  if (!spans || spans.length === 0) return null;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (editedSec >= s.editedStartSec - 0.001 && editedSec <= s.editedEndSec + 0.001) {
      const offset = Math.max(0, Math.min(s.editedEndSec - s.editedStartSec, editedSec - s.editedStartSec));
      return Math.round((s.sourceStartSec + offset) * 1000);
    }
    if (s.editedStartSec > editedSec) {
      return Math.round(s.sourceStartSec * 1000);
    }
  }
  const last = spans[spans.length - 1];
  return Math.round(last.sourceEndSec * 1000);
}

/**
 * 自动检测并修复历史工程中「文本正确、但 sourceStartMs/sourceEndMs 因误用了剪辑后时间而错位」的金句。
 */
export function repairMisalignedHighlights(
  highlights: HighlightClip[],
  blocks: PodcastProjectState['blocks']
): HighlightClip[] {
  if (!highlights || highlights.length === 0 || !blocks || blocks.length === 0) {
    return highlights;
  }
  return highlights.map((hl) => {
    const targetNorm = normalizeHighlightMatchText(hl.text || '');
    if (targetNorm.length < 6) return hl;

    let currentRangeText = '';
    for (const b of blocks) {
      for (const t of b.tokens) {
        if (!t.deleted && t.type === 'word' && t.sourceEndMs > hl.sourceStartMs - 100 && t.sourceStartMs < hl.sourceEndMs + 100) {
          currentRangeText += t.text;
        }
      }
    }
    const currentNorm = normalizeHighlightMatchText(currentRangeText);
    const probe = targetNorm.slice(0, Math.min(8, targetNorm.length));
    if (currentNorm.includes(probe)) {
      return hl; // 当前区间文本已匹配，无需修复
    }

    const matched = findSourceRangeByHighlightText(blocks, hl.text, hl.sourceStartMs);
    if (!matched) return hl;

    return {
      ...hl,
      sourceStartMs: matched.sourceStartMs,
      sourceEndMs: matched.sourceEndMs,
      durationSec: Math.max(0.1, Number(((matched.sourceEndMs - matched.sourceStartMs) / 1000).toFixed(2))),
    };
  });
}

export interface IntroBgmVoiceWindow {
  startSec: number;
  endSec: number;
}

/**
 * Computes the intro BGM ducking multiplier (between `duckRatio` and `1.0`) at `tSec`.
 * Ducks BEFORE each voice window begins over `fadeOutSec`, holds at `duckRatio` during the window,
 * and recovers AFTER the window ends over `fadeInSec`.
 */
export function computeIntroBgmDuckMultiplier(
  tSec: number,
  voiceWindows: IntroBgmVoiceWindow[],
  fadeInSec: number,
  fadeOutSec: number,
  duckRatio: number
): number {
  if (voiceWindows.length === 0) return 1.0;
  const safeFadeOut = Math.max(0.05, fadeOutSec);
  const safeFadeIn = Math.max(0.05, fadeInSec);
  const clampedDuck = Math.max(0, Math.min(1, duckRatio));
  let multiplier = 1.0;

  for (const w of voiceWindows) {
    if (w.endSec <= w.startSec) continue;
    let wMult = 1.0;
    if (tSec >= w.startSec && tSec <= w.endSec) {
      wMult = clampedDuck;
    } else if (tSec >= w.startSec - safeFadeOut && tSec < w.startSec) {
      const progress = (tSec - (w.startSec - safeFadeOut)) / safeFadeOut;
      wMult = 1.0 - progress * (1.0 - clampedDuck);
    } else if (tSec > w.endSec && tSec <= w.endSec + safeFadeIn) {
      const progress = (tSec - w.endSec) / safeFadeIn;
      wMult = clampedDuck + progress * (1.0 - clampedDuck);
    }
    if (wMult < multiplier) {
      multiplier = wMult;
    }
  }

  return multiplier;
}

/**
 * Inserts a synthetic silence/blank pause of `durationSec` at `playheadSec` on the edited timeline.
 * If `playheadSec` falls inside a kept word token, splits that token cleanly around the inserted silence.
 */
export function insertSilenceAtPlayhead(
  state: PodcastProjectState,
  playheadSec: number,
  durationSec: number
): PodcastProjectState {
  const safeDur = Number(Math.max(0.1, Math.min(60, durationSec)).toFixed(2));
  if (state.blocks.length === 0) return state;

  const timeline = computeEditedTimeline(state);
  const clampedPlayhead = Math.max(
    timeline.prefixDurationSec,
    Math.min(timeline.totalEditedDurationSec, playheadSec)
  );

  // 1. 查找游标所在的目标位置
  let targetBlockId: string | null = null;
  let targetTokenId: string | null = null;
  let splitInsideToken = false;
  let splitSourceMs = 0;

  for (const mt of timeline.mappedTokens) {
    if (mt.token.deleted) continue;
    if (
      mt.token.type === 'word' &&
      clampedPlayhead > mt.editedStartSec + 0.025 &&
      clampedPlayhead < mt.editedEndSec - 0.025
    ) {
      targetBlockId = mt.blockId;
      targetTokenId = mt.token.id;
      splitInsideToken = true;
      const offsetRatio =
        (clampedPlayhead - mt.editedStartSec) /
        Math.max(0.01, mt.editedEndSec - mt.editedStartSec);
      const tokSpanMs = Math.max(20, mt.token.sourceEndMs - mt.token.sourceStartMs);
      splitSourceMs = Math.round(mt.token.sourceStartMs + offsetRatio * tokSpanMs);
      break;
    }
    if (mt.editedStartSec >= clampedPlayhead - 0.02) {
      targetBlockId = mt.blockId;
      targetTokenId = mt.token.id;
      splitSourceMs = mt.token.sourceStartMs;
      break;
    }
  }

  const silenceTok: TranscriptToken = {
    id: `silence_ins_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'silence',
    text: `[空白 ${safeDur.toFixed(1)}s]`,
    sourceStartMs: splitSourceMs,
    sourceEndMs: splitSourceMs,
    durationSec: safeDur,
    origDurationSec: safeDur,
    insertedSilence: true,
  };

  if (!targetBlockId || !targetTokenId) {
    // 游标在末尾：追加到最后一个 block 的末尾
    const lastIdx = state.blocks.length - 1;
    const lastBlock = state.blocks[lastIdx];
    const lastTok = lastBlock.tokens[lastBlock.tokens.length - 1];
    const tailMs = lastTok ? lastTok.sourceEndMs : 0;
    const tailSilence: TranscriptToken = {
      ...silenceTok,
      sourceStartMs: tailMs,
      sourceEndMs: tailMs,
    };
    const nextBlocks = state.blocks.map((b, idx) =>
      idx === lastIdx ? { ...b, tokens: [...b.tokens, tailSilence] } : b
    );
    return { ...state, blocks: nextBlocks };
  }

  const nextBlocks = state.blocks.map((b) => {
    if (b.blockId !== targetBlockId) return b;
    const nextTokens: TranscriptToken[] = [];
    for (const tok of b.tokens) {
      if (tok.id !== targetTokenId) {
        nextTokens.push(tok);
        continue;
      }
      if (splitInsideToken) {
        const leftDur = Number(Math.max(0.02, (splitSourceMs - tok.sourceStartMs) / 1000).toFixed(3));
        const rightDur = Number(Math.max(0.02, (tok.sourceEndMs - splitSourceMs) / 1000).toFixed(3));
        nextTokens.push({
          ...tok,
          id: `${tok.id}_L`,
          sourceEndMs: splitSourceMs,
          durationSec: leftDur,
          origDurationSec: leftDur,
          subwordTrimmed: true,
        });
        nextTokens.push(silenceTok);
        nextTokens.push({
          ...tok,
          id: `${tok.id}_R`,
          sourceStartMs: splitSourceMs,
          durationSec: rightDur,
          origDurationSec: rightDur,
          subwordTrimmed: true,
        });
      } else {
        nextTokens.push(silenceTok);
        nextTokens.push(tok);
      }
    }
    return { ...b, tokens: nextTokens };
  });

  return { ...state, blocks: nextBlocks };
}
