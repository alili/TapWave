import { describe, expect, it } from 'vitest';
import {
  AI_PROVIDERS_CATALOG,
  GEMINI_RECOMMENDED_MODELS,
  applyPlatformConfigToProjectState,
  buildAsrConfigFromPlatform,
  buildLlmConfigForFeature,
  clearAllAiPlatformSecrets,
  countConfiguredProviders,
  createDefaultAiPlatformConfig,
  hasProviderCredentials,
  isFeatureUsingProvider,
  maskSecretKey,
  normalizeAiPlatformConfig,
  toggleFeatureForProvider,
} from '../engine/aiPlatformConfig';
import {
  createEmptyProjectState,
  parsePodcraftProjectJson,
  serializeProjectToPodcraftJson,
} from '../data/emptyProject';

describe('AI Platform Configuration Engine', () => {
  it('masks API keys safely for hidden display and detects configured providers', () => {
    expect(maskSecretKey('')).toBe('未配置');
    expect(maskSecretKey('short')).toBe('••••••••');
    expect(maskSecretKey('sk-1234567890abcdef')).toBe('sk-1••••••cdef');

    const cfg = createDefaultAiPlatformConfig();
    expect(countConfiguredProviders(cfg)).toBe(0);
    expect(hasProviderCredentials(cfg, 'local_sensevoice')).toBe(true);
    expect(hasProviderCredentials(cfg, 'deepseek')).toBe(false);

    cfg.providers.deepseek.apiKey = 'sk-deepseek-secret';
    cfg.providers.gemini.apiKey = 'AIzaSyTestKey123456';
    cfg.providers.volcengine_doubao.volcApiKey = 'volc-secret-key';

    expect(countConfiguredProviders(cfg)).toBe(3);
    expect(hasProviderCredentials(cfg, 'deepseek')).toBe(true);
    expect(hasProviderCredentials(cfg, 'gemini')).toBe(true);
    expect(hasProviderCredentials(cfg, 'volcengine_doubao')).toBe(true);
    expect(hasProviderCredentials(cfg, 'openai')).toBe(false);
  });

  it('supports switching features per AI provider and reflects active state accurately', () => {
    let cfg = createDefaultAiPlatformConfig();
    expect(isFeatureUsingProvider(cfg, 'asr_transcribe', 'local_sensevoice')).toBe(true);

    // Switch ASR to DeepSeek
    cfg = toggleFeatureForProvider(cfg, 'asr_transcribe', 'deepseek');
    expect(cfg.routing.asrProvider).toBe('deepseek');
    expect(isFeatureUsingProvider(cfg, 'asr_transcribe', 'deepseek')).toBe(true);
    expect(isFeatureUsingProvider(cfg, 'asr_transcribe', 'local_sensevoice')).toBe(false);

    // Toggle off DeepSeek ASR reverts to local_sensevoice
    cfg = toggleFeatureForProvider(cfg, 'asr_transcribe', 'deepseek');
    expect(cfg.routing.asrProvider).toBe('local_sensevoice');

    // Enable Volcengine speaker separation (auto switches ASR to volcengine_doubao)
    cfg = toggleFeatureForProvider(cfg, 'speaker_separation', 'volcengine_doubao');
    expect(cfg.routing.asrProvider).toBe('volcengine_doubao');
    expect(cfg.routing.enableSingleFileSpeakerSep).toBe(true);
    expect(isFeatureUsingProvider(cfg, 'speaker_separation', 'volcengine_doubao')).toBe(true);

    // Switch analysis to Gemini and shownotes to OpenAI independently
    cfg = toggleFeatureForProvider(cfg, 'transcript_analysis', 'gemini');
    cfg = toggleFeatureForProvider(cfg, 'shownotes_generate', 'openai');
    expect(isFeatureUsingProvider(cfg, 'transcript_analysis', 'gemini')).toBe(true);
    expect(isFeatureUsingProvider(cfg, 'shownotes_generate', 'openai')).toBe(true);

    // Toggle Gemini analysis off -> falls back to local_only
    cfg = toggleFeatureForProvider(cfg, 'transcript_analysis', 'gemini');
    expect(cfg.routing.analysisProvider).toBe('local_only');
    expect(isFeatureUsingProvider(cfg, 'transcript_analysis', 'local_sensevoice')).toBe(true);
  });

  it('builds feature-specific ASR and LLM configs including local_only mode', () => {
    const cfg = createDefaultAiPlatformConfig();
    cfg.providers.deepseek.apiKey = 'sk-ds-999';
    cfg.providers.gemini.apiKey = 'AIza-gm-888';
    cfg.providers.openai.apiKey = 'sk-oa-777';
    cfg.providers.volcengine_doubao.volcApiKey = 'volc-666';
    cfg.routing.asrProvider = 'volcengine_doubao';
    cfg.routing.analysisProvider = 'gemini';
    cfg.routing.shownotesProvider = 'local_only';

    const asrCfg = buildAsrConfigFromPlatform(cfg);
    expect(asrCfg.provider).toBe('volcengine_doubao');
    expect(asrCfg.volcApiKey).toBe('volc-666');
    expect(asrCfg.apiKey).toBe('sk-ds-999');

    const analysisLlm = buildLlmConfigForFeature(cfg, 'transcript_analysis');
    expect(analysisLlm.provider).toBe('gemini');
    expect(analysisLlm.apiKey).toBe('AIza-gm-888');
    expect(analysisLlm.forceLocalOnly).toBeUndefined();

    const shownotesLlm = buildLlmConfigForFeature(cfg, 'shownotes_generate');
    expect(shownotesLlm.apiKey).toBe('');
    expect(shownotesLlm.forceLocalOnly).toBe(true);
  });

  it('hydrates project state from local AI config without ever leaking keys into .podcraft JSON', () => {
    const cfg = createDefaultAiPlatformConfig();
    cfg.providers.deepseek.apiKey = 'sk-local-only-secret-key';
    cfg.providers.volcengine_doubao.volcSecretAccessKey = 'volc-sk-never-upload';
    cfg.routing.analysisProvider = 'deepseek';

    const baseProject = createEmptyProjectState();
    const hydrated = applyPlatformConfigToProjectState(baseProject, cfg);
    expect(hydrated.llmConfig.apiKey).toBe('sk-local-only-secret-key');
    expect(hydrated.asrConfig?.volcSecretAccessKey).toBe('volc-sk-never-upload');

    const projectJson = serializeProjectToPodcraftJson(hydrated);
    expect(projectJson).not.toContain('sk-local-only-secret-key');
    expect(projectJson).not.toContain('volc-sk-never-upload');

    const reloaded = parsePodcraftProjectJson(projectJson);
    expect(reloaded.llmConfig.apiKey).toBe('');
    expect(reloaded.asrConfig?.volcSecretAccessKey).toBe('');

    // Re-applying local config restores keys after loading any project
    const rehydrated = applyPlatformConfigToProjectState(reloaded, cfg);
    expect(rehydrated.llmConfig.apiKey).toBe('sk-local-only-secret-key');
  });

  it('normalizes partial/corrupt JSON and clears all secrets cleanly', () => {
    const normalized = normalizeAiPlatformConfig({
      providers: {
        gemini: { apiKey: 'AIza-test' },
      },
      routing: {
        asrProvider: 'invalid_value',
        shownotesProvider: 'gemini',
      },
    });
    expect(normalized.providers.gemini.apiKey).toBe('AIza-test');
    expect(normalized.routing.asrProvider).toBe('local_sensevoice');
    expect(normalized.routing.shownotesProvider).toBe('gemini');

    const cleared = clearAllAiPlatformSecrets(normalized);
    expect(cleared.providers.gemini.apiKey).toBe('');
    expect(countConfiguredProviders(cleared)).toBe(0);
    expect(AI_PROVIDERS_CATALOG.length).toBe(5);
  });

  it('provides recommended mainstream Gemini models and preserves selected model id', () => {
    const ids = GEMINI_RECOMMENDED_MODELS.map((m) => m.id);
    expect(ids).toContain('gemini-4-hydrogen');
    expect(ids).toContain('gemini-3.8-flash');
    expect(ids).toContain('gemini-2.5-flash');

    const normalized = normalizeAiPlatformConfig({
      providers: {
        gemini: { apiKey: 'AIza-test', model: 'gemini-4-hydrogen' },
      },
    });
    expect(normalized.providers.gemini.model).toBe('gemini-4-hydrogen');
  });
});
