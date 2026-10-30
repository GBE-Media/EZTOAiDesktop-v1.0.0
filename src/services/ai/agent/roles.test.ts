import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_MODELS } from './roles';
import { ANTHROPIC_MODELS, DEFAULT_ANTHROPIC_MODEL } from '../providers/anthropic';
import { LovableProvider } from '../providers/lovable';
import { modelRejectsCustomTemperature } from '../providers/modelRequestConstraints';

describe('DEFAULT_AGENT_MODELS model IDs', () => {
  it('uses a verifier model id present in the Anthropic provider registry', () => {
    const knownIds = new Set(ANTHROPIC_MODELS.map(model => model.id));
    expect(DEFAULT_AGENT_MODELS.verifier.provider).toBe('anthropic');
    expect(knownIds.has(DEFAULT_AGENT_MODELS.verifier.model)).toBe(true);
    expect(DEFAULT_AGENT_MODELS.verifier.model).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it('does not reference the retired invalid alias claude-opus-4-5', () => {
    const serialized = JSON.stringify(DEFAULT_AGENT_MODELS);
    expect(serialized).not.toContain('claude-opus-4-5');
    expect(ANTHROPIC_MODELS.some(model => model.id === 'claude-opus-4-5')).toBe(false);
  });

  it('uses the current flagship models, with the fallback on a different request path', () => {
    expect(DEFAULT_AGENT_MODELS).toEqual({
      router: { provider: 'lovable', model: 'openai/gpt-6-luna' },
      primary: { provider: 'lovable', model: 'openai/gpt-6.1-sol' },
      verifier: { provider: 'anthropic', model: 'claude-opus-5-5' },
      fallback: { provider: 'lovable', model: 'openai/gpt-5.6-sol' },
    });
    const lovableIds = new Set(new LovableProvider().getModels().map(model => model.id));
    for (const role of ['router', 'primary', 'fallback'] as const) {
      expect(lovableIds.has(DEFAULT_AGENT_MODELS[role].model)).toBe(true);
    }
  });

  it('never sends a custom temperature to GPT-6 models', () => {
    expect(modelRejectsCustomTemperature('openai/gpt-6.1-sol')).toBe(true);
    expect(modelRejectsCustomTemperature('gpt-6-luna')).toBe(true);
    expect(modelRejectsCustomTemperature('google/gemini-4-argon')).toBe(false);
  });
});
