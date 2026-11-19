import {
  PodcastProjectState,
  TrackMuteRange,
  TranscriptBlock,
  TranscriptToken,
} from '../types/podcast';
import {
  DEFAULT_PERSONAL_EDITING_PROFILE,
  PersonalEditingProfile,
} from '../data/editingPreferenceProfile';

export interface SmartCutActionItem {
  id: string;
  category: 'hesitation' | 'stutter' | 'pause' | 'mute';
  categoryLabel: string;
  speakerId: string;
  speakerName: string;
  timeFormatted: string;
  timeSec: number;
  snippet: string;
  durationSec: number;
  detail: string;
}

export interface PreferenceSmartCutOutcome {
  nextState: PodcastProjectState;
  hesitationsCut: number;
  protectedBackchannels: number;
  stuttersCut: number;
  pausesTightened: number;
  surgicalMutesAdded: number;
  headTailHints: Array<{ range: string; label: string }>;
  savedSec: number;
  actionItems: SmartCutActionItem[];
}

export function formatTimeSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Checks if a token is a protected backchannel (e.g. conversational affirmations: 嗯/对/啊).
 */
export function isProtectedAffirmation(
  text: string,
  blockLen: number,
  profile: PersonalEditingProfile = DEFAULT_PERSONAL_EDITING_PROFILE
): boolean {
  const clean = text.trim();
  if (profile.protectedBackchannels.includes(clean)) {
    return true;
  }
  // Standalone short block of 1-3 tokens that ends in a gentle tone
  if (blockLen <= 3 && /^[嗯啊对好的哈]+[。，！？~]?$/.test(clean)) {
    return true;
  }
  return false;
}

/**
 * Checks if a token represents hesitation (thinking pauses like 呃/呃……).
 */
export function isHesitationToken(
  token: TranscriptToken,
  profile: PersonalEditingProfile = DEFAULT_PERSONAL_EDITING_PROFILE
): boolean {
  if (token.type !== 'word') return false;
  const clean = token.text.trim();
  if (/^呃+[。，、…—]*$/.test(clean)) return true;
  if (profile.hesitationWords.includes(clean) && token.fillerTag === 'pure') return true;
  return false;
}

/**
 * Core smart preference-based cutter based on EP121 坚叔 real-world editing aesthetics.
 */
export function applyPreferenceSmartCut(
  state: PodcastProjectState,
  customProfile: Partial<PersonalEditingProfile> = {}
): PreferenceSmartCutOutcome {
  const profile: PersonalEditingProfile = {
    ...DEFAULT_PERSONAL_EDITING_PROFILE,
    ...customProfile,
  };

  const speakerMap = new Map<string, string>();
  for (const tr of state.tracks) {
    speakerMap.set(tr.id, tr.name || tr.id);
  }

  let hesitationsCut = 0;
  let protectedBackchannels = 0;
  let stuttersCut = 0;
  let pausesTightened = 0;
  let surgicalMutesAdded = 0;
  let savedSec = 0;
  const headTailHints: Array<{ range: string; label: string }> = [];
  const actionItems: SmartCutActionItem[] = [];

  // 1. Process blocks for Hesitations, Protected Backchannels, and Stutters
  const nextBlocks: TranscriptBlock[] = state.blocks.map((block) => {
    const tokens = [...block.tokens];
    const n = tokens.length;
    let modified = false;
    const spName = speakerMap.get(block.speakerId) || '发言人';

    // A. Detect immediate 1-2 word stutters/repeats: e.g. "我" -> "我", "本人" -> "本人"
    for (let i = 0; i < n - 1; i++) {
      const cur = tokens[i];
      const nxt = tokens[i + 1];
      if (cur.deleted || nxt.deleted) continue;

      // 1-token exact repeat
      if (
        cur.type === 'word' &&
        nxt.type === 'word' &&
        cur.text.trim() === nxt.text.trim() &&
        cur.text.trim().length >= 1
      ) {
        tokens[i] = {
          ...cur,
          deleted: true,
          cutByWaveform: true,
        };
        tokens[i + 1] = {
          ...nxt,
          gapBeforeSec: 0.04,
        };
        stuttersCut++;
        savedSec += cur.origDurationSec;
        modified = true;

        actionItems.push({
          id: `stutter_${cur.id}`,
          category: 'stutter',
          categoryLabel: '连读口吃重说',
          speakerId: block.speakerId,
          speakerName: spName,
          timeSec: cur.sourceStartMs / 1000,
          timeFormatted: formatTimeSec(cur.sourceStartMs / 1000),
          snippet: `[${cur.text}] ${nxt.text}`,
          durationSec: cur.origDurationSec,
          detail: `切除前序重复字「${cur.text}」，与后字无缝缝合 (40ms 紧凑气口)`,
        });
        continue;
      }

      // 2-token exact repeat: [A, B] -> [A, B]
      if (i + 3 < n) {
        const cur2 = tokens[i + 1];
        const nxt1 = tokens[i + 2];
        const nxt2 = tokens[i + 3];
        if (
          !cur2.deleted &&
          !nxt1.deleted &&
          !nxt2.deleted &&
          cur.type === 'word' &&
          cur2.type === 'word' &&
          nxt1.type === 'word' &&
          nxt2.type === 'word' &&
          cur.text.trim() === nxt1.text.trim() &&
          cur2.text.trim() === nxt2.text.trim()
        ) {
          tokens[i] = { ...cur, deleted: true, cutByWaveform: true };
          tokens[i + 1] = { ...cur2, deleted: true, cutByWaveform: true };
          tokens[i + 2] = { ...nxt1, gapBeforeSec: 0.06 };
          stuttersCut += 2;
          const dur = cur.origDurationSec + cur2.origDurationSec;
          savedSec += dur;
          modified = true;

          actionItems.push({
            id: `stutter_pair_${cur.id}`,
            category: 'stutter',
            categoryLabel: '双字词组重说',
            speakerId: block.speakerId,
            speakerName: spName,
            timeSec: cur.sourceStartMs / 1000,
            timeFormatted: formatTimeSec(cur.sourceStartMs / 1000),
            snippet: `[${cur.text}${cur2.text}] ${nxt1.text}${nxt2.text}`,
            durationSec: dur,
            detail: `切除前序重复词组「${cur.text}${cur2.text}」，保留后半句完整表述`,
          });
          i += 1;
          continue;
        }
      }
    }

    // B. Clean Hesitations while protecting conversational backchannels
    for (let i = 0; i < n; i++) {
      const tok = tokens[i];
      if (tok.deleted || tok.type !== 'word') continue;

      if (isProtectedAffirmation(tok.text, n, profile)) {
        protectedBackchannels++;
        continue;
      }

      if (isHesitationToken(tok, profile)) {
        tokens[i] = {
          ...tok,
          deleted: true,
          cutByWaveform: true,
        };
        if (i + 1 < n && !tokens[i + 1].deleted) {
          tokens[i + 1] = {
            ...tokens[i + 1],
            gapBeforeSec: 0.05,
          };
        }
        hesitationsCut++;
        savedSec += tok.origDurationSec;
        modified = true;

        const prevTok = tokens.slice(Math.max(0, i - 2), i).map((t) => t.text).join('');
        const nextTok = tokens.slice(i + 1, Math.min(n, i + 3)).map((t) => t.text).join('');
        actionItems.push({
          id: `hesitation_${tok.id}`,
          category: 'hesitation',
          categoryLabel: '思维卡壳口癖',
          speakerId: block.speakerId,
          speakerName: spName,
          timeSec: tok.sourceStartMs / 1000,
          timeFormatted: formatTimeSec(tok.sourceStartMs / 1000),
          snippet: `${prevTok ? prevTok + ' ' : ''}[${tok.text}]${nextTok ? ' ' + nextTok : ''}`,
          durationSec: tok.origDurationSec,
          detail: `剔除孤立卡壳词「${tok.text}」，自然平滑前后语义`,
        });
      }
    }

    // C. Intra-clause pause tightening
    for (let i = 0; i < n; i++) {
      const tok = tokens[i];
      if (tok.deleted || tok.type !== 'silence') continue;

      const hasWordBefore = tokens.slice(0, i).some((t) => t.type === 'word' && !t.deleted);
      const hasWordAfter = tokens.slice(i + 1).some((t) => t.type === 'word' && !t.deleted);

      if (hasWordBefore && hasWordAfter && tok.durationSec > 0.7) {
        const target = profile.intraClausePauseSec;
        const diff = tok.durationSec - target;
        if (diff > 0.1) {
          tokens[i] = {
            ...tok,
            durationSec: target,
          };
          pausesTightened++;
          savedSec += diff;
          modified = true;

          actionItems.push({
            id: `pause_${tok.id}`,
            category: 'pause',
            categoryLabel: '句内死寂停顿',
            speakerId: block.speakerId,
            speakerName: spName,
            timeSec: tok.sourceStartMs / 1000,
            timeFormatted: formatTimeSec(tok.sourceStartMs / 1000),
            snippet: `停顿空白 ${(tok.durationSec).toFixed(2)}s → ${target}s`,
            durationSec: diff,
            detail: `将句内卡顿由 ${(tok.durationSec).toFixed(2)}s 紧凑收缩至 ${target}s (精简 ${diff.toFixed(2)}s)`,
          });
        }
      }
    }

    return modified ? { ...block, tokens } : block;
  });

  // 2. Identify potential Head Off-Air & Tail Off-Air segments
  if (state.blocks.length > 0) {
    const firstBlock = state.blocks[0];
    const firstWord = firstBlock.tokens.find((t) => t.type === 'word');
    if (firstWord && firstWord.sourceStartMs < 20000) {
      const headText = firstBlock.tokens
        .filter((t) => t.type === 'word')
        .map((t) => t.text)
        .join('');
      if (/声音|可以了|开场|麦克|调试|喂喂/.test(headText)) {
        headTailHints.push({
          range: `0s ~ ${(firstBlock.tokens[firstBlock.tokens.length - 1].sourceEndMs / 1000).toFixed(1)}s`,
          label: '候选片头试麦修剪',
        });
      }
    }

    const lastBlock = state.blocks[state.blocks.length - 1];
    const lastWord = lastBlock.tokens.find((t) => t.type === 'word');
    if (lastWord && lastWord.sourceStartMs > 4000000) {
      const tailText = lastBlock.tokens
        .filter((t) => t.type === 'word')
        .map((t) => t.text)
        .join('');
      if (/录完|客气|漏掉|结束|回去/.test(tailText)) {
        headTailHints.push({
          range: `@${(lastBlock.tokens[0].sourceStartMs / 1000).toFixed(1)}s 起`,
          label: '候选片尾录后闲聊',
        });
      }
    }
  }

  // 3. Multi-track non-primary mute ranges (protecting primary speaker)
  const existingMutes = new Set(
    (state.trackMuteRanges ?? []).map((m) => `${m.trackId}_${m.sourceStartMs}`)
  );
  const newMutes: TrackMuteRange[] = [...(state.trackMuteRanges ?? [])];

  if (state.tracks.length > 1) {
    for (const b of nextBlocks) {
      const activeToks = b.tokens.filter((t) => t.type === 'word' && !t.deleted);
      if (activeToks.length < 4) continue;
      const bStartMs = activeToks[0].sourceStartMs;
      const bEndMs = activeToks[activeToks.length - 1].sourceEndMs;
      const activeSpId = b.speakerId;
      const primarySpName = speakerMap.get(activeSpId) || '主讲人';

      for (const track of state.tracks) {
        if (track.id === activeSpId || track.isRef) continue;
        const key = `${track.id}_${bStartMs}`;
        if (existingMutes.has(key)) continue;

        const seg = track.detectedSegments?.find(
          (s) => !s.isSilence && s.startMs >= bStartMs && s.endMs <= bEndMs && s.endMs - s.startMs <= 2500
        );
        if (seg) {
          const muteDur = (seg.endMs - seg.startMs) / 1000;
          newMutes.push({
            id: `tm_auto_${track.id}_${seg.startMs}_${Date.now()}`,
            trackId: track.id,
            sourceStartMs: seg.startMs,
            sourceEndMs: seg.endMs,
          });
          existingMutes.add(key);
          surgicalMutesAdded++;

          actionItems.push({
            id: `mute_${track.id}_${seg.startMs}`,
            category: 'mute',
            categoryLabel: '非主讲杂音单轨消音',
            speakerId: track.id,
            speakerName: track.name || track.id,
            timeSec: seg.startMs / 1000,
            timeFormatted: formatTimeSec(seg.startMs / 1000),
            snippet: `${track.name || '音轨'} 单轨静音 ${muteDur.toFixed(2)}s`,
            durationSec: muteDur,
            detail: `在「${primarySpName}」主讲期间，局部静音该轨碰撞/清嗓杂音，保持全轨时间轴连续`,
          });
        }
      }
    }
  }

  // Sort action items by time
  actionItems.sort((a, b) => a.timeSec - b.timeSec);

  const nextState: PodcastProjectState = {
    ...state,
    blocks: nextBlocks,
    trackMuteRanges: newMutes,
    waveformSelectionMode: profile.waveformSelectionMode,
    cutPrerollSec: profile.cutPrerollSec,
    bgmDuckDb: profile.bgmDuckDb,
    targetTotalHighlightSec: profile.targetTotalHighlightSec,
  };

  return {
    nextState,
    hesitationsCut,
    protectedBackchannels,
    stuttersCut,
    pausesTightened,
    surgicalMutesAdded,
    headTailHints,
    savedSec,
    actionItems,
  };
}
