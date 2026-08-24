import { describe, expect, it } from 'vitest';
import {
  modelRejectsCustomTemperature,
  resolveRequestTemperature,
} from './modelRequestConstraints';

describe('modelRequestConstraints temperature', () => {
  it('omits temperature for gpt-5 / reasoning models that only allow the default', () => {
    expect(modelRejectsCustomTemperature('gpt-5.5')).toBe(true);
    expect(modelRejectsCustomTemperature('openai/gpt-5.6-sol')).toBe(true);
    expect(modelRejectsCustomTemperature('openai/gpt-5.5')).toBe(true);
    expect(modelRejectsCustomTemperature('o3-mini')).toBe(true);

    expect(resolveRequestTemperature('openai/gpt-5.5', 0.2)).toBeUndefined();
    expect(resolveRequestTemperature('gpt-5.6-sol', 0.2)).toBeUndefined();
  });

  it('preserves custom temperature for models that support it', () => {
    expect(modelRejectsCustomTemperature('gpt-4o')).toBe(false);
    expect(modelRejectsCustomTemperature('claude-opus-4-7')).toBe(false);
    expect(resolveRequestTemperature('gpt-4o', 0.2)).toBe(0.2);
    expect(resolveRequestTemperature('claude-opus-4-7', 0.2)).toBe(0.2);
  });
});
