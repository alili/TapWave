import { PodcastProjectState, ShownotesTimelineItem, TranscriptBlock } from '../types/podcast';
import { TimelineComputation } from './timelineEngine';
import { buildTimelineItemsFromProject } from './shownotesGenerator';

export interface OutlineSection {
  id: string;
  title: string;
  summary: string;
  blockIds: string[];
  startSec: number;
  endSec: number;
  durationSec: number;
  speakerIds: string[];
  speakerNames: string[];
  wordCount: number;
}

const TOPIC_SHIFT_RE =
  /^(接下来|说到这|另外|那么|顺便|第二个|第三个|最后|总结一下|回到|再说说|顺着这个|首先|第一|第二|第三|总的来说|其实我觉得)/;

/**
 * 从文本中提取简明扼要的大纲小节标题
 */
export function generateSectionTitle(text: string, index: number): string {
  const clean = text
    .replace(/\[[^\]]+\]/g, '')
    .replace(/[，。！？、\s]+/g, ' ')
    .trim();
  if (!clean) {
    return `大纲小节 ${index + 1}`;
  }

  // 尝试抓取前 12-24 个字符作为核心短语
  const words = clean.split(' ').filter(Boolean);
  let phrase = words.slice(0, 5).join('');
  if (phrase.length > 18) {
    phrase = phrase.slice(0, 18) + '...';
  } else if (phrase.length < 4 && clean.length >= 4) {
    phrase = clean.slice(0, Math.min(16, clean.length));
  }
  return phrase ? `${String(index + 1).padStart(2, '0')} ${phrase}` : `大纲小节 ${index + 1}`;
}

/**
 * 智能分析文稿并按照大纲进行结构化切分
 */
export function analyzeTranscriptOutlines(
  state: PodcastProjectState,
  timeline: TimelineComputation
): OutlineSection[] {
  const speakerMap = Object.fromEntries(state.tracks.map((t) => [t.id, t.name]));
  const blocks = state.blocks;
  if (!blocks || blocks.length === 0) return [];

  // 1. 检查是否已经存在预先设定的章节标题 (且不全相同或不仅是默认空标题)
  const existingChapterTitles = Array.from(
    new Set(blocks.map((b) => b.chapterTitle?.trim()).filter(Boolean))
  );

  const sections: OutlineSection[] = [];

  if (existingChapterTitles.length >= 2) {
    // 基于已有的明确章节划分小节
    let currentSection: OutlineSection | null = null;

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const chTitle = b.chapterTitle?.trim() || `第 ${sections.length + 1} 部分`;
      const startSec = timeline.blockEditedStartsSec[b.blockId] ?? 0;
      const bText = b.tokens
        .filter((t) => !t.deleted && t.type === 'word')
        .map((t) => t.text)
        .join('');
      const spName = speakerMap[b.speakerId] || '主播';

      if (!currentSection || currentSection.title !== chTitle) {
        if (currentSection) {
          sections.push(currentSection);
        }
        currentSection = {
          id: `sec_${sections.length + 1}_${b.blockId}`,
          title: chTitle,
          summary: bText.slice(0, 60),
          blockIds: [b.blockId],
          startSec,
          endSec: startSec,
          durationSec: 0,
          speakerIds: [b.speakerId],
          speakerNames: [spName],
          wordCount: bText.length,
        };
      } else {
        currentSection.blockIds.push(b.blockId);
        currentSection.wordCount += bText.length;
        if (!currentSection.speakerIds.includes(b.speakerId)) {
          currentSection.speakerIds.push(b.speakerId);
          currentSection.speakerNames.push(spName);
        }
      }
    }
    if (currentSection) {
      sections.push(currentSection);
    }
  } else {
    // 2. 优先基于 Shownotes 智能语义分析算法与 Skill 提炼章节时间轴
    let shownotesItems: ShownotesTimelineItem[] = [];
    if (state.shownotes?.timeline && state.shownotes.timeline.length >= 2) {
      shownotesItems = state.shownotes.timeline;
    } else {
      try {
        shownotesItems = buildTimelineItemsFromProject(state, timeline);
      } catch (e) {
        console.warn('Shownotes chapter analysis fallback:', e);
      }
    }

    if (shownotesItems && shownotesItems.length >= 2) {
      const sortedItems = [...shownotesItems].sort((a, b) => a.timeSec - b.timeSec);
      const nItems = sortedItems.length;

      // 建立章节大纲小节列表
      const snSections: OutlineSection[] = sortedItems.map((item, idx) => ({
        id: `sec_sn_${idx + 1}_${Math.round(item.timeSec)}`,
        title: item.title,
        summary: item.summary || '',
        blockIds: [],
        startSec: item.timeSec,
        endSec: item.timeSec,
        durationSec: 0,
        speakerIds: [],
        speakerNames: [],
        wordCount: 0,
      }));

      // 将文稿各个 Block 按时间对齐归属到对应的智能章节中
      for (const b of blocks) {
        const bStart = timeline.blockEditedStartsSec[b.blockId] ?? 0;
        let matchedIdx = 0;
        for (let j = nItems - 1; j >= 0; j--) {
          if (bStart >= sortedItems[j].timeSec - 0.5) {
            matchedIdx = j;
            break;
          }
        }
        const targetSec = snSections[matchedIdx];
        targetSec.blockIds.push(b.blockId);
        if (!targetSec.speakerIds.includes(b.speakerId)) {
          targetSec.speakerIds.push(b.speakerId);
          targetSec.speakerNames.push(speakerMap[b.speakerId] || '主播');
        }
        const bWords = b.tokens
          .filter((t) => !t.deleted && t.type === 'word')
          .reduce((sum, t) => sum + t.text.length, 0);
        targetSec.wordCount += bWords;
      }

      // 仅保留包含实际 Blocks 的有效章节
      const validSnSections = snSections.filter((s) => s.blockIds.length > 0);
      if (validSnSections.length > 0) {
        for (const s of validSnSections) {
          sections.push(s);
        }
      }
    }

    // 3. 兜底方案：启发式自然分段
    if (sections.length === 0) {
      let currentBlocks: TranscriptBlock[] = [];
      let currentChars = 0;
      let currentFirstText = '';

      const finalizeSection = (blks: TranscriptBlock[], firstText: string) => {
        if (blks.length === 0) return;
        const firstB = blks[0];
        const startSec = timeline.blockEditedStartsSec[firstB.blockId] ?? 0;
        const secIdx = sections.length;
        const title = firstB.chapterTitle?.trim() || generateSectionTitle(firstText, secIdx);

        const spIds = Array.from(new Set(blks.map((b) => b.speakerId)));
        const spNames = spIds.map((id) => speakerMap[id] || '主播');
        const totalWords = blks.reduce(
          (sum, b) =>
            sum +
            b.tokens
              .filter((t) => !t.deleted && t.type === 'word')
              .reduce((s, tok) => s + tok.text.length, 0),
          0
        );

        sections.push({
          id: `sec_${secIdx + 1}_${firstB.blockId}`,
          title,
          summary: firstText.slice(0, 60),
          blockIds: blks.map((b) => b.blockId),
          startSec,
          endSec: startSec,
          durationSec: 0,
          speakerIds: spIds,
          speakerNames: spNames,
          wordCount: totalWords,
        });
      };

      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const bText = b.tokens
          .filter((t) => !t.deleted && t.type === 'word')
          .map((t) => t.text)
          .join('');
        const hasTopicShift = TOPIC_SHIFT_RE.test(bText);

        const shouldBreak =
          currentBlocks.length > 0 &&
          ((hasTopicShift && currentChars >= 120) || currentChars >= 380);

        if (shouldBreak) {
          finalizeSection(currentBlocks, currentFirstText);
          currentBlocks = [b];
          currentChars = bText.length;
          currentFirstText = bText;
        } else {
          if (currentBlocks.length === 0) {
            currentFirstText = bText;
          }
          currentBlocks.push(b);
          currentChars += bText.length;
        }
      }

      if (currentBlocks.length > 0) {
        finalizeSection(currentBlocks, currentFirstText);
      }
    }
  }

  // 3. 计算每个大纲小节的起始、结束时间和总时长
  for (const sec of sections) {
    if (sec.blockIds.length > 0) {
      const firstId = sec.blockIds[0];
      const lastId = sec.blockIds[sec.blockIds.length - 1];
      const firstStart = timeline.blockEditedStartsSec[firstId] ?? 0;
      const lastStart = timeline.blockEditedStartsSec[lastId] ?? firstStart;

      // 找到最后块的末尾
      const lastBlock = blocks.find((b) => b.blockId === lastId);
      const lastToken = lastBlock?.tokens.slice().reverse().find((t) => !t.deleted);
      const lastMapped = lastToken
        ? timeline.mappedTokens.find((m) => m.tokenId === lastToken.id)
        : null;
      const endSec = lastMapped ? lastMapped.editedEndSec : lastStart + 5;

      sec.startSec = firstStart;
      sec.endSec = Math.max(firstStart, endSec);
      sec.durationSec = Math.max(0.1, Number((sec.endSec - sec.startSec).toFixed(2)));
    }
  }

  return sections;
}

/**
 * 将调整后的大纲小节标题同步写回各个 Block 的 chapterTitle
 */
export function syncOutlineTitlesToBlocks(
  blocks: TranscriptBlock[],
  sections: OutlineSection[]
): TranscriptBlock[] {
  const blockTitleMap: Record<string, string> = {};
  sections.forEach((sec) => {
    sec.blockIds.forEach((bId) => {
      blockTitleMap[bId] = sec.title;
    });
  });

  return blocks.map((b) => {
    const newTitle = blockTitleMap[b.blockId];
    if (newTitle && newTitle !== b.chapterTitle) {
      return { ...b, chapterTitle: newTitle };
    }
    return b;
  });
}

/**
 * 将大纲小节由 fromIndex 移动至 toIndex，并整体同步重排底层 blocks 的顺序！
 */
export function reorderOutlineSections(
  sections: OutlineSection[],
  fromIndex: number,
  toIndex: number,
  allBlocks: TranscriptBlock[]
): { newSections: OutlineSection[]; newBlocks: TranscriptBlock[] } {
  if (
    fromIndex < 0 ||
    fromIndex >= sections.length ||
    toIndex < 0 ||
    toIndex >= sections.length ||
    fromIndex === toIndex
  ) {
    return { newSections: [...sections], newBlocks: [...allBlocks] };
  }

  const updatedSections = [...sections];
  const [movedSection] = updatedSections.splice(fromIndex, 1);
  updatedSections.splice(toIndex, 0, movedSection);

  // 按照新的 Section 顺序，重新组织 blocks
  const blockMap = new Map(allBlocks.map((b) => [b.blockId, b]));
  const orderedBlocks: TranscriptBlock[] = [];
  const placedBlockIds = new Set<string>();

  for (const sec of updatedSections) {
    for (const bId of sec.blockIds) {
      const blk = blockMap.get(bId);
      if (blk) {
        orderedBlocks.push(blk);
        placedBlockIds.add(bId);
      }
    }
  }

  // 若有未归入任何 section 的孤儿 block，安全追加在尾部保持无损
  for (const b of allBlocks) {
    if (!placedBlockIds.has(b.blockId)) {
      orderedBlocks.push(b);
    }
  }

  return {
    newSections: updatedSections,
    newBlocks: orderedBlocks,
  };
}

/**
 * 判定某个 Block 是否属于与主发言重叠的副轨插入短句（如附和“对”、“是的”、“没错”等插话）
 */
export function isSecondaryOverlapShortBlock(
  block: TranscriptBlock,
  allBlocks: TranscriptBlock[]
): boolean {
  const vocalTokens = block.tokens.filter((t) => !t.deleted && t.type === 'word');
  if (vocalTokens.length === 0) return false;

  const totalChars = vocalTokens.reduce((s, t) => s + t.text.length, 0);
  const bStart = vocalTokens[0].sourceStartMs;
  const bEnd = vocalTokens[vocalTokens.length - 1].sourceEndMs;
  const bDur = (bEnd - bStart) / 1000;

  // 短插话一般字数少于等于 8 个字，且时长短于等于 3 秒
  if (totalChars > 8 || bDur > 3.0) {
    return false;
  }

  // 检查是否与另一个发言人的更长主发言 Block 存在明显时间重叠
  for (const other of allBlocks) {
    if (other.blockId === block.blockId || other.speakerId === block.speakerId) continue;
    const otherVocal = other.tokens.filter((t) => !t.deleted && t.type === 'word');
    if (otherVocal.length === 0) continue;

    const oStart = otherVocal[0].sourceStartMs;
    const oEnd = otherVocal[otherVocal.length - 1].sourceEndMs;
    const oChars = otherVocal.reduce((s, t) => s + t.text.length, 0);

    // 主发言字数应显著多于当前短句（至少 2 倍以上且不少于 10 字）
    if (oChars < Math.max(10, totalChars * 2)) continue;

    // 计算重叠时间跨度
    const overlapStart = Math.max(bStart, oStart);
    const overlapEnd = Math.min(bEnd, oEnd);
    if (overlapEnd > overlapStart) {
      const overlapDur = overlapEnd - overlapStart;
      const bDurationMs = Math.max(1, bEnd - bStart);
      // 若该短句超过 50% 的时间都落在此主发言人的时间段内，则判定为副轨重叠插入短句
      if (overlapDur / bDurationMs >= 0.5) {
        return true;
      }
    }
  }

  return false;
}
