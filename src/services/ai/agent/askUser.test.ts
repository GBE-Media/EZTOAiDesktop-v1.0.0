import './testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { assistantDb } from '@/db/assistantDb';
import { useAIChatStore } from '@/store/aiChatStore';
import { registerAssistantTool } from '../tools/registry';
import { createAgentToolContext } from './createToolContext';
import { clearAgentSessionMemoryForTests } from './runner';
import { resumeTaskAfterClarification } from './orchestrator';
import { runPrimaryAgentLoop } from './runnerCore';
import { parseAgentDecision } from './decisionParser';
import type { ModelAdapter } from './modelAdapter';
import {
  applyFieldAnswers,
  fieldsComplete,
  formatFieldAnswersForModel,
  sanitizeClarificationFields,
} from './askUser';

describe('structured question fields', () => {
  it('keeps valid fields and drops malformed ones', () => {
    const fields = sanitizeClarificationFields([
      { id: 'panel', kind: 'point', prompt: 'Where is panel LP?', page: 93, pickLabel: 'Click panel LP' },
      { id: 'method', kind: 'choice', prompt: 'Wiring method?', options: [{ label: 'EMT' }, { label: 'MC cable', value: 'MC' }], recommended: 'MC' },
      { id: 'bad', kind: 'choice', prompt: 'No options' },
      { kind: 'video', prompt: 'nope' },
      { kind: 'text', prompt: 'Voltage?' },
    ]);
    expect(fields.map(f => [f.id, f.kind])).toEqual([['panel', 'point'], ['method', 'choice'], ['field_5', 'text']]);
    expect(fields[1].options?.map(o => o.value)).toEqual(['EMT', 'MC']);
    expect(fields[0]).toMatchObject({ page: 93, pickLabel: 'Click panel LP' });
  });

  it('requires a picked point for point fields', () => {
    const fields = sanitizeClarificationFields([
      { id: 'panel', kind: 'point', prompt: 'Where?' },
      { id: 'note', kind: 'text', prompt: 'Notes?', optional: true },
    ]);
    expect(fieldsComplete(fields, {})).toBe(false);
    expect(fieldsComplete(fields, { panel: { value: 'x' } })).toBe(false);
    expect(fieldsComplete(fields, { panel: { point: { page: 1, xPct: 10, yPct: 20 } } })).toBe(true);
  });

  it('merges answers into tool arguments and tells the model exactly what to call', () => {
    const resume = { toolId: 'suggest_runs', args: { page: 93, circuits: [] }, apply: { loc: 'panel', name: 'panel.label', wm: 'settings.wiringMethod' } };
    const answers = { loc: { point: { page: 93, xPct: 41.26, yPct: 12.04 } }, name: { value: 'LP-1' }, wm: { value: 'MC' } };
    expect(applyFieldAnswers(resume.args, resume.apply, answers)).toEqual({
      page: 93, circuits: [], panel: { x: 41.3, y: 12, label: 'LP-1' }, settings: { wiringMethod: 'MC' },
    });
    const fields = sanitizeClarificationFields([{ id: 'loc', kind: 'point', prompt: 'Where?' }]);
    const lines = formatFieldAnswersForModel({ fields, resume }, answers);
    expect(lines[0]).toMatch(/picked a point on page 93 at x=41.3, y=12/);
    expect(lines.at(-1)).toMatch(/^Now call suggest_runs with exactly these arguments: \{.*"wiringMethod":"MC"/);
  });

  it('parses fields on a model clarify payload', () => {
    const decision = parseAgentDecision(JSON.stringify({
      type: 'clarify',
      questions: ['Where is the electrical room?'],
      fields: [{ id: 'room', kind: 'point', prompt: 'Where is the electrical room?', page: 4 }],
    }));
    expect(decision.type).toBe('clarify');
    expect(decision.type === 'clarify' && decision.fields?.[0].kind).toBe('point');
  });
});

describe('tool-driven question cards pause and resume the run', () => {
  beforeEach(async () => {
    clearAgentSessionMemoryForTests();
    await assistantDb.agentSessions.clear();
    useAIChatStore.setState({ messages: [], runs: {}, approvals: {}, clarifications: {} } as never);
  });

  it('parks on askUser and resumes with the merged arguments', async () => {
    const execute = vi.fn(async (_ctx: unknown, input: { page: number; panel?: { x?: number } }) => (input.panel?.x != null
      ? { status: 'completed' as const, summary: 'Runs ready', output: { ok: true } }
      : {
        status: 'completed' as const,
        summary: 'Need the panel',
        output: { needs: 'input' },
        askUser: {
          question: 'Where is the panel?',
          fields: [{ id: 'loc', kind: 'point' as const, prompt: 'Where is the panel?', page: 4 }],
          resume: { toolId: 'zz_ask_tool', args: { page: 4 }, apply: { loc: 'panel' } },
        },
      }));
    registerAssistantTool({
      id: 'zz_ask_tool',
      title: 'zz ask',
      description: 'test',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({ page: z.number(), panel: z.object({ x: z.number(), y: z.number() }).optional() }),
      execute,
    } as never);
    const ctx = createAgentToolContext({ runId: 'run-ask', messageId: 'msg-ask', trade: 'electrical', placeMarkups: () => ({ placed: 0 }) });
    const complete = vi.fn<ModelAdapter['complete']>()
      .mockResolvedValueOnce({ type: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'zz_ask_tool', arguments: { page: 4 } }] })
      .mockResolvedValueOnce({ type: 'tool_calls', toolCalls: [{ id: 'call_2', name: 'zz_ask_tool', arguments: { page: 4, panel: { x: 40, y: 12 } } }] })
      .mockResolvedValueOnce({ type: 'final', message: 'Laid out the runs.' });

    useAIChatStore.setState({ runs: { 'run-ask': { id: 'run-ask', messageId: 'msg-ask', conversationId: 's', status: 'running', summary: 'runs', steps: [], startedAt: new Date().toISOString() } } } as never);
    const started = await runPrimaryAgentLoop({
      session: { runId: 'run-ask', messageId: 'msg-ask', messages: [{ role: 'user', content: 'suggest runs' }], toolHistory: [], actionsTaken: [], contextText: '' } as never,
      toolContext: ctx,
      model: { complete },
    });
    expect(started.status).toBe('needs_clarification');
    expect(complete).toHaveBeenCalledTimes(1);
    const card = started.clarificationRequest!;
    expect(useAIChatStore.getState().clarifications[card.id]?.fields?.[0].id).toBe('loc');
    expect(card.fields?.[0].kind).toBe('point');
    expect(card.resume?.toolId).toBe('zz_ask_tool');

    const resumed = await resumeTaskAfterClarification({
      clarification: card,
      answer: { selectedValues: [], displayText: 'picked', fields: { loc: { point: { page: 4, xPct: 40, yPct: 12 } } } },
      toolContext: ctx,
      model: { complete },
    });
    expect(resumed.agentResult?.assistantMessage).toBe('Laid out the runs.');
    const resumeMessages = complete.mock.calls[1][0].messages;
    expect(resumeMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Now call zz_ask_tool with exactly these arguments: {"page":4,"panel":{"x":40,"y":12}}') }),
    ]));
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
