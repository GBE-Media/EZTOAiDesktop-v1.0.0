import { describe, expect, it } from 'vitest';
import {
  BIDVERA_QUESTION_TEMPLATES,
  inferClarificationStepKey,
  resolveClarificationOptions,
  validateModelClarificationOptions,
} from './clarificationTemplates';
import { emitClarificationQuestion, labelForAgentStatus } from './clarification';
import { parseAgentDecision } from './decisionParser';
import { buildAgentSystemPrompt } from './prompts/system';
import { useAIChatStore } from '@/store/aiChatStore';

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

  it('keeps validated model-supplied options when provided', () => {
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

  it('rejects malformed model options and falls back to templates or freeform', () => {
    expect(validateModelClarificationOptions([
      { id: 'a', label: '', value: 'a' },
      { id: 'b', label: 'B', value: 'b' },
    ])).toBeNull();

    expect(validateModelClarificationOptions([
      { id: 'only', label: 'Only one', value: 'only' },
    ])).toBeNull();

    const capped = validateModelClarificationOptions(
      Array.from({ length: 8 }, (_, index) => ({
        id: `o${index}`,
        label: `Option ${index}`,
        value: `v${index}`,
      })),
    );
    expect(capped).toHaveLength(6);

    // Empty labels → fall through to estimate_type template.
    expect(resolveClarificationOptions(
      'Do you want a rough estimate or detailed takeoff?',
      [{ id: 'x', label: '', value: 'x' }, { id: 'y', label: ' ', value: 'y' }],
    ).map(option => option.value)).toEqual(
      expect.arrayContaining(['rough', 'detailed', 'budget']),
    );

    // Malformed custom question with no template → freeform [].
    expect(resolveClarificationOptions(
      'What is the job number?',
      [{ id: 'x', label: '', value: 'x' }],
    )).toEqual([]);
  });

  it('maps agent statuses to human progress labels', () => {
    expect(labelForAgentStatus('thinking')).toBe('Reviewing estimate context');
    expect(labelForAgentStatus('running_tool', 'getProjectContext')).toBe('Running getProjectContext');
    expect(labelForAgentStatus('routing', 'intake')).toBe('Reading request');
  });
});

describe('model-supplied clarifications', () => {
  it('parses clarify decisions that include options', () => {
    const decision = parseAgentDecision(JSON.stringify({
      type: 'clarify',
      message: 'Which finish level?',
      questions: ['Which finish level?'],
      options: [
        { id: 'basic', label: 'Basic', value: 'basic' },
        { id: 'premium', label: 'Premium', value: 'premium' },
      ],
    }));
    expect(decision.type).toBe('clarify');
    if (decision.type !== 'clarify') return;
    expect(decision.options).toHaveLength(2);
    expect(decision.options?.[0]).toMatchObject({ label: 'Basic', value: 'basic' });
  });

  it('emits store clarifications with model options for QuestionCard rendering', () => {
    useAIChatStore.setState({
      messages: [{
        id: 'message-clarify',
        role: 'assistant',
        content: '',
        timestamp: new Date(),
        blocks: [],
      }],
      runs: {
        'run-clarify': {
          id: 'run-clarify',
          messageId: 'message-clarify',
          conversationId: 'session',
          status: 'running',
          steps: [],
          startedAt: new Date().toISOString(),
        },
      },
      clarifications: {},
    });

    const clarification = emitClarificationQuestion({
      runId: 'run-clarify',
      messageId: 'message-clarify',
      question: 'Which finish level?',
      options: [
        { id: 'basic', label: 'Basic', value: 'basic' },
        { id: 'premium', label: 'Premium', value: 'premium' },
      ],
    });

    expect(clarification.options).toEqual([
      { id: 'basic', label: 'Basic', value: 'basic' },
      { id: 'premium', label: 'Premium', value: 'premium' },
    ]);
    expect(useAIChatStore.getState().clarifications[clarification.id].options).toHaveLength(2);
    expect(useAIChatStore.getState().messages[0].blocks?.some(block => (
      block.type === 'question' && block.clarificationId === clarification.id
    ))).toBe(true);
  });

  it('keeps templated clarifications unchanged when no model options are supplied', () => {
    useAIChatStore.setState({
      messages: [{
        id: 'message-template',
        role: 'assistant',
        content: '',
        timestamp: new Date(),
        blocks: [],
      }],
      runs: {
        'run-template': {
          id: 'run-template',
          messageId: 'message-template',
          conversationId: 'session',
          status: 'running',
          steps: [],
          startedAt: new Date().toISOString(),
        },
      },
      clarifications: {},
    });

    const clarification = emitClarificationQuestion({
      runId: 'run-template',
      messageId: 'message-template',
      question: 'Which page scope should I use?',
    });

    expect(clarification.stepKey).toBe('scope');
    expect(clarification.options.map(option => option.value)).toEqual(
      expect.arrayContaining(['current_page', 'selected_pages', 'full_document']),
    );
  });

  it('documents model-supplied options in the system prompt', () => {
    const prompt = buildAgentSystemPrompt({ toolCatalogOverride: '- search_document' });
    expect(prompt).toContain('"options"');
    expect(prompt).toContain('2–6');
  });
});
