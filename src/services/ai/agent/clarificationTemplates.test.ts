import { describe, expect, it } from 'vitest';
import {
  BIDVERA_QUESTION_TEMPLATES,
  inferClarificationStepKey,
  resolveClarificationOptions,
} from './clarificationTemplates';
import { labelForAgentStatus } from './clarification';

describe('clarification templates', () => {
  it('exposes BidveraAi option templates', () => {
    expect(BIDVERA_QUESTION_TEMPLATES.estimate_type.length).toBeGreaterThanOrEqual(2);
    expect(BIDVERA_QUESTION_TEMPLATES.apply_counts.some(option => option.value === 'apply_all')).toBe(true);
  });

  it('infers step keys from question text', () => {
    expect(inferClarificationStepKey('Which page scope should I use?')).toBe('scope');
    expect(inferClarificationStepKey('Should I apply counts now?')).toBe('apply_counts');
    expect(inferClarificationStepKey('Optimize for speed or accuracy?')).toBe('optimize_for');
  });

  it('resolves template options when model only returns a question string', () => {
    const options = resolveClarificationOptions('Do you want a rough estimate or detailed takeoff?');
    expect(options.map(option => option.value)).toEqual(
      expect.arrayContaining(['rough', 'detailed', 'budget']),
    );
  });

  it('keeps explicit options when provided', () => {
    const options = resolveClarificationOptions('Custom?', [
      { id: 'a', label: 'A', value: 'a' },
      { id: 'b', label: 'B', value: 'b' },
    ]);
    expect(options).toHaveLength(2);
    expect(options[0].value).toBe('a');
  });

  it('returns empty options for unmatched freeform-only questions', () => {
    expect(resolveClarificationOptions('What is the job number?')).toEqual([]);
  });

  it('maps agent statuses to human progress labels', () => {
    expect(labelForAgentStatus('thinking')).toBe('Reviewing estimate context');
    expect(labelForAgentStatus('running_tool', 'getProjectContext')).toBe('Running getProjectContext');
    expect(labelForAgentStatus('routing', 'intake')).toBe('Reading request');
  });
});
