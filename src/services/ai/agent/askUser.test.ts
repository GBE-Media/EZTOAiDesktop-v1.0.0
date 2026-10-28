import './testGlobals';
vi.mock('./tools/registerAll', () => ({ registerAllAgentTools: vi.fn() }));
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
  takePinnedResume,
  clearPinnedResumes,
} from './askUser';

describe('structured question fields', () => {
  beforeEach(() => { clearPinnedResumes(); });
  it('clears mutually exclusive off-sheet and in-plan coordinates when a choice changes', () => {
    expect(applyFieldAnswers({ panel: { label: 'A', x: 10, y: 20 } }, { loc: 'panel' }, { loc: { value: 'flag:offSheet' } }))
      .toEqual({ panel: { label: 'A', offSheet: true } });
    expect(applyFieldAnswers({ panel: { label: 'A', offSheet: true } }, { loc: 'panel' }, { loc: { point: { page: 1, xPct: 12, yPct: 23 } } }))
      .toEqual({ panel: { label: 'A', x: 12, y: 23 } });
  });

  it('isolates card answers by run and does not consume a mismatched page', () => {
    const fields = sanitizeClarificationFields([{ id: 'load', kind: 'text', prompt: 'Fixture VA?' }]);
    for (const [run, page, value] of [['a', 4, '42'], ['b', 5, '75']] as const) {
      formatFieldAnswersForModel({
        fields, resume: { toolId: 'suggest_runs', args: { page, keepClear: [{ x: 1, y: 1, w: 2, h: 2 }] }, apply: { load: 'autoCircuits.vaPerDevice#num' } },
      }, { load: { value } }, run);
    }
    expect(takePinnedResume('suggest_runs', 'a', args => args.page === 5)).toBeUndefined();
    const a = takePinnedResume('suggest_runs', 'a');
    expect(a).toMatchObject({ page: 4, autoCircuits: { vaPerDevice: 42 }, answeredPaths: ['autoCircuits.vaPerDevice#num'] });
    expect(a?.answeredPaths).not.toContain('keepClear');
    expect(takePinnedResume('suggest_runs', 'b')).toMatchObject({ page: 5, autoCircuits: { vaPerDevice: 75 } });
    expect(takePinnedResume('suggest_runs', 'a')).toBeUndefined();
  });

  it('rejects picks on the wrong document or page and invalid coordinates', () => {
    const fields = sanitizeClarificationFields([{ id: 'loc', kind: 'point', prompt: 'Where?', page: 4, documentId: 'doc' }]);
    for (const point of [
      { page: 5, documentId: 'doc', xPct: 5, yPct: 5 },
      { page: 4, documentId: 'other', xPct: 5, yPct: 5 },
      { page: 4, documentId: 'doc', xPct: NaN, yPct: 5 },
    ]) expect(fieldsComplete(fields, { loc: { point } })).toBe(false);
  });
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
    expect(fieldsComplete(fields, { panel: { label: 'x' } })).toBe(false);
    // "On another sheet" style options answer a point field with a value.
    expect(fieldsComplete(fields, { panel: { value: 'flag:offSheet' } })).toBe(true);
    expect(fieldsComplete(fields, { panel: { point: { page: 1, xPct: 10, yPct: 20 } } })).toBe(true);
  });

  it('merges answers into tool arguments and tells the model exactly what to call', () => {
    const resume = { toolId: 'suggest_runs', args: { page: 93, circuits: [] }, apply: { loc: 'panel', name: 'panel.label', wm: 'settings.wiringMethod' } };
    const answers = { loc: { point: { page: 93, xPct: 41.26, yPct: 12.04 } }, name: { value: 'LP-1' }, wm: { value: 'MC' } };
    expect(applyFieldAnswers(resume.args, resume.apply, answers)).toEqual({
      page: 93, circuits: [], panel: { x: 41.26, y: 12.04, label: 'LP-1' }, settings: { wiringMethod: 'MC' },
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

  it('resumes suggest_runs before consulting the model, with every original argument intact', async () => {
    const execute = vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => input.autoCircuits
      ? { status: 'completed' as const, summary: 'Ready', output: input }
      : {
        status: 'completed' as const, summary: 'Need load',
        askUser: {
          question: 'Fixture VA?',
          fields: [{ id: 'load', kind: 'text' as const, prompt: 'VA per fixture?' }],
          resume: { toolId: 'suggest_runs', args: { page: 4, documentId: 'doc', panel: { label: 'A', x: 10.123, y: 50.456 } }, apply: { load: 'autoCircuits.vaPerDevice#num' } },
        },
      });
    registerAssistantTool({
      id: 'suggest_runs', title: 'Test run planner', description: 'test', risk: 'read', requiresConfirmation: false,
      undoable: false, schema: z.object({}).passthrough(), execute,
    } as never);
    const ctx = createAgentToolContext({ runId: 'direct-run', messageId: 'direct-msg', trade: 'electrical', placeMarkups: () => ({ placed: 0 }) });
    useAIChatStore.setState({ runs: { 'direct-run': { id: 'direct-run', messageId: 'direct-msg', conversationId: 's', status: 'running', summary: 'runs', steps: [], startedAt: new Date().toISOString() } } } as never);
    const first = await runPrimaryAgentLoop({
      session: { runId: 'direct-run', messageId: 'direct-msg', messages: [{ role: 'user', content: 'Suggest runs' }], toolHistory: [], actionsTaken: [], contextText: '' } as never,
      toolContext: ctx,
      model: { complete: async () => ({ type: 'tool_calls', toolCalls: [{ id: 'first', name: 'suggest_runs', arguments: { page: 4 } }] }) },
    });
    expect(first.status).toBe('needs_clarification');
    const complete = vi.fn<ModelAdapter['complete']>(async () => {
      expect(execute).toHaveBeenCalledTimes(2);
      return { type: 'final', message: 'Ready' };
    });
    const resumed = await resumeTaskAfterClarification({
      clarification: first.clarificationRequest!,
      answer: { selectedValues: [], fields: { load: { value: '42' } }, displayText: '42 VA' },
      toolContext: ctx, model: { complete },
    });
    expect(resumed.status).toBe('completed');
    expect(execute.mock.calls[1][1]).toEqual({
      page: 4, documentId: 'doc', panel: { label: 'A', x: 10.123, y: 50.456 }, autoCircuits: { vaPerDevice: 42 },
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(takePinnedResume('suggest_runs', 'direct-run')).toBeUndefined();
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

describe('structured answers: flags and areas', () => {
  it('sets flags and area lists, including inside arrays', () => {
    const args = { panels: [{ label: 'B' }, { label: 'C' }], keepClear: [] };
    const merged = applyFieldAnswers(args, { p0: 'panels.0', p1: 'panels.1', keep: 'keepClear' }, {
      p0: { point: { page: 1, xPct: 10.04, yPct: 20 } },
      p1: { value: 'flag:offSheet', label: 'On another sheet' },
      keep: { areas: [{ page: 1, xPct: 5, yPct: 6, wPct: 7, hPct: 8 }] },
    });
    expect(merged).toEqual({
      panels: [{ label: 'B', x: 10.04, y: 20 }, { label: 'C', offSheet: true }],
      keepClear: [{ x: 5, y: 6, width: 7, height: 8 }],
    });
    const fields = sanitizeClarificationFields([{ id: 'keep', kind: 'area', prompt: 'Keep clear?' }]);
    expect(fields[0].kind).toBe('area');
    expect(fieldsComplete(fields, { keep: { areas: [{ page: 1, xPct: 1, yPct: 1, wPct: 1, hPct: 1 }] } })).toBe(true);
    expect(formatFieldAnswersForModel({ fields }, { keep: { areas: [{ page: 1, xPct: 1, yPct: 2, wPct: 3, hPct: 4 }] } })[0]).toContain('marked 1 area');
  });

  it('runs a batch of read-only tools concurrently and records results in order', async () => {
    let active = 0;
    let peak = 0;
    registerAssistantTool({
      id: 'zz_read_tool',
      title: 'zz read',
      description: 'test',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({ n: z.number() }),
      execute: async (_ctx: unknown, input: { n: number }) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active -= 1;
        return { status: 'completed' as const, summary: `page ${input.n}`, output: { n: input.n } };
      },
    } as never);
    const ctx = createAgentToolContext({ runId: 'run-par', messageId: 'msg-par', trade: 'electrical', placeMarkups: () => ({ placed: 0 }) });
    const complete = vi.fn<ModelAdapter['complete']>()
      .mockResolvedValueOnce({ type: 'tool_calls', toolCalls: [1, 2, 3, 4].map(n => ({ id: `c${n}`, name: 'zz_read_tool', arguments: { n } })) })
      .mockResolvedValueOnce({ type: 'final', message: 'Counted.' });
    useAIChatStore.setState({ runs: { 'run-par': { id: 'run-par', messageId: 'msg-par', conversationId: 's', status: 'running', summary: 'x', steps: [], startedAt: new Date().toISOString() } } } as never);
    const session = { runId: 'run-par', messageId: 'msg-par', messages: [{ role: 'user', content: 'count' }], toolHistory: [], actionsTaken: [], contextText: '' } as never;
    await runPrimaryAgentLoop({ session, toolContext: ctx, model: { complete } });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    const toolMsgs = (session as { messages: Array<{ role: string; toolCallId?: string }> }).messages.filter(m => m.role === 'tool');
    expect(toolMsgs.map(m => m.toolCallId)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });
});
