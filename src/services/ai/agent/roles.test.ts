import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_MODELS } from './roles';
import { ANTHROPIC_MODELS, DEFAULT_ANTHROPIC_MODEL } from '../providers/anthropic';

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
});
