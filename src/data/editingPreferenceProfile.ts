import { PodcastProjectState } from '../types/podcast';

export interface PersonalEditingProfile {
  name: string;
  waveformSelectionMode: 'free' | 'snap';
  cutPrerollSec: number;
  bgmDuckDb: number;
  targetTotalHighlightSec: number;
  autoHighlightGap: boolean;
  highlightGapSec: number;
  duckAttenuationDb: number;
  deClickStrength: 'medium' | 'strong';
  hesitationWords: string[];
  protectedBackchannels: string[];
  intraClausePauseSec: number;
  interTurnPauseSec: number;
}

export const DEFAULT_PERSONAL_EDITING_PROFILE: PersonalEditingProfile = {
  name: '坚叔自然对谈微创精剪预设',
  waveformSelectionMode: 'free',
  cutPrerollSec: 1.0,
  bgmDuckDb: -21,
  targetTotalHighlightSec: 90,
  autoHighlightGap: true,
  highlightGapSec: 0.8,
  duckAttenuationDb: -16,
  deClickStrength: 'medium',
  hesitationWords: ['呃', '呃，', '呃。', '呃……', '那个', '就是说'],
  protectedBackchannels: ['嗯', '嗯。', '嗯，', '对', '对，', '对对', '啊', '啊。', '啊，', '哈'],
  intraClausePauseSec: 0.18,
  interTurnPauseSec: 0.55,
};

/**
 * Applies the personal editing profile defaults to an existing project state.
 */
export function applyPersonalProfileDefaults(state: PodcastProjectState): PodcastProjectState {
  return {
    ...state,
    waveformSelectionMode: DEFAULT_PERSONAL_EDITING_PROFILE.waveformSelectionMode,
    cutPrerollSec: DEFAULT_PERSONAL_EDITING_PROFILE.cutPrerollSec,
    bgmDuckDb: DEFAULT_PERSONAL_EDITING_PROFILE.bgmDuckDb,
    targetTotalHighlightSec: DEFAULT_PERSONAL_EDITING_PROFILE.targetTotalHighlightSec,
    autoHighlightGap: DEFAULT_PERSONAL_EDITING_PROFILE.autoHighlightGap,
    highlightGapSec: DEFAULT_PERSONAL_EDITING_PROFILE.highlightGapSec,
    duckAttenuationDb: DEFAULT_PERSONAL_EDITING_PROFILE.duckAttenuationDb,
    deClickStrength: DEFAULT_PERSONAL_EDITING_PROFILE.deClickStrength,
  };
}
