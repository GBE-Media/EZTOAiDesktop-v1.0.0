/**
 * Adversarial coverage for validateModelClarificationOptions.
 * Adapted from the PR #2 review harness (pr2_adversarial_options.test.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  MODEL_OPTION_ID_MAX,
  MODEL_OPTION_LABEL_MAX,
  MODEL_OPTION_VALUE_MAX,
  resolveClarificationOptions,
  validateModelClarificationOptions,
} from './clarificationTemplates';

const validPair = [
  { id: 'a', label: 'Option A', value: 'a' },
  { id: 'b', label: 'Option B', value: 'b' },
] as const;

describe('pr2 adversarial model clarification options', () => {
  it('rejects non-string label/value/id fields instead of String(...) coercion', () => {
    expect(validateModelClarificationOptions([
      { id: 'a', label: 123 as unknown as string, value: 'a' },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();

    expect(validateModelClarificationOptions([
      { id: 'a', label: 'A', value: true as unknown as string },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();

    expect(validateModelClarificationOptions([
      { id: 1 as unknown as string, label: 'A', value: 'a' },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();

    expect(resolveClarificationOptions(
      'Do you want a rough estimate or detailed takeoff?',
      [
        { id: 'a', label: 123 as unknown as string, value: 'a' },
        { id: 'b', label: 'B', value: 'b' },
      ],
    ).map(option => option.value)).toEqual(
      expect.arrayContaining(['rough', 'detailed', 'budget']),
    );
  });

  it('rejects missing id/value instead of deriving them from other fields', () => {
    expect(validateModelClarificationOptions([
      { label: 'Only label', value: 'only' } as { id: string; label: string; value: string },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();

    expect(validateModelClarificationOptions([
      { id: 'a', label: 'A' } as { id: string; label: string; value: string },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();

    expect(validateModelClarificationOptions([
      { id: 'a', value: 'a' } as { id: string; label: string; value: string },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();
  });

  it('rejects null/undefined/array/primitive entries instead of filtering them', () => {
    expect(validateModelClarificationOptions([
      null,
      { id: 'a', label: 'A', value: 'a' },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();

    expect(validateModelClarificationOptions([
      undefined,
      { id: 'a', label: 'A', value: 'a' },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();

    expect(validateModelClarificationOptions([
      ['nested'] as unknown as { id: string; label: string; value: string },
      { id: 'a', label: 'A', value: 'a' },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();

    expect(validateModelClarificationOptions([
      'string-entry' as unknown as { id: string; label: string; value: string },
      { id: 'a', label: 'A', value: 'a' },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();

    // Length becomes < 2 if nulls were filtered — must still reject the whole set.
    expect(resolveClarificationOptions('What is the job number?', [
      null,
      { id: 'a', label: 'A', value: 'a' },
    ] as unknown[])).toEqual([]);
  });

  it('rejects duplicate ids (QuestionCard React key collision)', () => {
    expect(validateModelClarificationOptions([
      { id: 'same', label: 'First', value: 'first' },
      { id: 'same', label: 'Second', value: 'second' },
    ])).toBeNull();
  });

  it('rejects duplicate values (selection identity collision)', () => {
    expect(validateModelClarificationOptions([
      { id: 'first', label: 'First', value: 'same' },
      { id: 'second', label: 'Second', value: 'same' },
    ])).toBeNull();
  });

  it('rejects arrays outside the 2–6 length window instead of silently capping', () => {
    expect(validateModelClarificationOptions([validPair[0]])).toBeNull();
    expect(validateModelClarificationOptions(
      Array.from({ length: 8 }, (_, index) => ({
        id: `o${index}`,
        label: `Option ${index}`,
        value: `v${index}`,
      })),
    )).toBeNull();
  });

  it('rejects overlong id/label/value strings', () => {
    expect(validateModelClarificationOptions([
      { id: 'a'.repeat(MODEL_OPTION_ID_MAX + 1), label: 'A', value: 'a' },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();

    expect(validateModelClarificationOptions([
      { id: 'a', label: 'L'.repeat(MODEL_OPTION_LABEL_MAX + 1), value: 'a' },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();

    expect(validateModelClarificationOptions([
      { id: 'a', label: 'A', value: 'v'.repeat(MODEL_OPTION_VALUE_MAX + 1) },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();
  });

  it('rejects fields whose raw length exceeds the limit even when trim would fit', () => {
    const paddedId = `${' '.repeat(MODEL_OPTION_ID_MAX)}a`; // raw length = max + 1
    expect(paddedId.length).toBe(MODEL_OPTION_ID_MAX + 1);
    expect(paddedId.trim().length).toBeLessThanOrEqual(MODEL_OPTION_ID_MAX);
    expect(validateModelClarificationOptions([
      { id: paddedId, label: 'A', value: 'a' },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();

    const paddedLabel = ` ${'L'.repeat(MODEL_OPTION_LABEL_MAX)} `; // raw length = max + 2
    expect(paddedLabel.length).toBe(MODEL_OPTION_LABEL_MAX + 2);
    expect(paddedLabel.trim().length).toBeLessThanOrEqual(MODEL_OPTION_LABEL_MAX);
    expect(validateModelClarificationOptions([
      { id: 'a', label: paddedLabel, value: 'a' },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();

    const paddedValue = `${' '.repeat(MODEL_OPTION_VALUE_MAX)}v`; // raw length = max + 1
    expect(paddedValue.length).toBe(MODEL_OPTION_VALUE_MAX + 1);
    expect(paddedValue.trim().length).toBeLessThanOrEqual(MODEL_OPTION_VALUE_MAX);
    expect(validateModelClarificationOptions([
      { id: 'a', label: 'A', value: paddedValue },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();
  });

  it('still trims incidental whitespace when raw length is within limits', () => {
    expect(validateModelClarificationOptions([
      { id: '  a  ', label: '  Option A  ', value: '  a  ' },
      { id: 'b', label: 'Option B', value: 'b' },
    ])).toEqual([
      { id: 'a', label: 'Option A', value: 'a' },
      { id: 'b', label: 'Option B', value: 'b' },
    ]);
  });

  it('still accepts a fully valid 2–6 option set', () => {
    expect(validateModelClarificationOptions([...validPair])).toEqual([
      { id: 'a', label: 'Option A', value: 'a' },
      { id: 'b', label: 'Option B', value: 'b' },
    ]);
  });
});
