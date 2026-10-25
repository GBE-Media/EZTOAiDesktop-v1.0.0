import './testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantDb } from '@/db/assistantDb';
import { useAIChatStore } from '@/store/aiChatStore';
import { useProductStore } from '@/store/productStore';
import { createAgentToolContext } from './createToolContext';
import { clearAgentSessionMemoryForTests } from './runner';
import { runPrimaryAgentLoop } from './runnerCore';
import { applyFieldAnswers } from './askUser';
import { proseQuestionToCard } from './proseQuestion';
import { createAskUserTool } from './tools/askUserTool';
import type { ModelAdapter } from './modelAdapter';
import { buildRunInputQuestion, type RunInputNeeded } from '../runs/suggestRunsTool';
import { registerCatalogPersister } from '../catalog/catalogPersister';
import { ensureTakeoffProduct, fixtureProductSpec, flushTakeoffProductSaves } from '../catalog/takeoffProducts';
import { catalogSnapshotToProductTree } from '@/lib/catalogAdapter';

describe('prose questions become cards', () => {
  it('detects a request for input at the end of the answer', () => {
    const card = proseQuestionToCard(
      "I counted 159 fixtures on E-101. I could not find a VA value in the fixture schedule. Please provide the fixture load to use for provisional circuiting, e.g. 'use 40 VA per fixture,' or point me to the fixture schedule sheet/page.",
      3,
    );
    expect(card).not.toBeNull();
    expect(card!.ask.question).toMatch(/Please provide the fixture load/);
    expect(card!.ask.fields.map(f => f.kind)).toEqual(['text', 'point']);
    expect(card!.ask.fields[0].placeholder).toContain('use 40 VA per fixture');
    expect(card!.remainder).toContain('I counted 159 fixtures');
    expect(card!.remainder).not.toContain('Please provide');
  });

  it('leaves plain answers and next-step offers alone', () => {
    expect(proseQuestionToCard('Counted 42 type A fixtures on page 3.')).toBeNull();
    expect(proseQuestionToCard('Counted 42 fixtures. Want me to place them on the drawing?')).toBeNull();
  });

  beforeEach(async () => {
    clearAgentSessionMemoryForTests();
    await assistantDb.agentSessions.clear();
    useAIChatStore.setState({ messages: [], runs: {}, approvals: {}, clarifications: {} } as never);
  });

  it('parks the run with a card instead of finishing on a prose question', async () => {
    const ctx = createAgentToolContext({ runId: 'run-prose', messageId: 'msg-prose', trade: 'electrical', placeMarkups: () => ({ placed: 0 }) });
    const complete = vi.fn<ModelAdapter['complete']>()
      .mockResolvedValueOnce({ type: 'final', message: 'I need the panel. Which panel do these fixtures feed?' });
    useAIChatStore.setState({ runs: { 'run-prose': { id: 'run-prose', messageId: 'msg-prose', conversationId: 's', status: 'running', summary: 'runs', steps: [], startedAt: new Date().toISOString() } } } as never);
    const result = await runPrimaryAgentLoop({
      session: { runId: 'run-prose', messageId: 'msg-prose', messages: [{ role: 'user', content: 'suggest runs' }], toolHistory: [], actionsTaken: [], contextText: '' } as never,
      toolContext: ctx,
      model: { complete },
    });
    expect(result.status).toBe('needs_clarification');
    expect(result.clarificationRequest?.fields?.[0].kind).toBe('text');
    expect(result.clarificationRequest?.question).toContain('Which panel');
  });

  it('ask_user returns a structured card', async () => {
    const tool = createAskUserTool();
    const input = tool.schema.parse({
      question: 'What load per fixture should I use?',
      fields: [{ id: 'va', kind: 'choice', prompt: 'Load', options: [{ label: '40 VA', value: '40' }, { label: '100 VA', value: '100' }], recommended: '40' }],
      page: 2,
    });
    const result = await tool.execute({} as never, input as never);
    expect(result.askUser?.fields[0].options?.map(o => o.value)).toEqual(['40', '100']);
    expect(result.askUser?.focus?.page).toBe(2);
  });
});

describe('suggest_runs asks for the fixture load on the card', () => {
  it('adds a fixture-load choice and applies it as a number', () => {
    const needed: RunInputNeeded = {
      needs: 'input', message: '', documentId: 'doc', page: 2, missing: ['fixture_load'],
      panels: [], panelArgs: [], candidates: [], panelNames: [],
    };
    const ask = buildRunInputQuestion(needed, { documentId: 'doc', page: 2 });
    const field = ask.fields.find(f => f.id === 'fixture_load')!;
    expect(field.kind).toBe('choice');
    expect(field.options?.length).toBeGreaterThanOrEqual(3);
    const merged = applyFieldAnswers(ask.resume!.args, ask.resume!.apply, { fixture_load: { value: '52 VA' } });
    expect((merged.autoCircuits as { vaPerDevice: number }).vaPerDevice).toBe(52);
  });
});

describe('AI takeoff products survive catalog sync', () => {
  it('saves new products to the catalog and keeps them through a re-sync', async () => {
    const queue = vi.fn(async () => {});
    registerCatalogPersister({ userId: 'user-1', queue });
    const { productId } = ensureTakeoffProduct(fixtureProductSpec('ZP9', 'Persist troffer'));
    await flushTakeoffProductSaves();
    const productCall = (queue.mock.calls as unknown as Array<[string, string, Record<string, unknown>]>).find(call => call[0] === 'product_catalog');
    expect(productCall?.[1]).toBe('insert');
    expect(productCall?.[2].id).toBe(productId);
    expect(String(productCall?.[2].notes)).toContain('bidvera-key:');
    expect((queue.mock.calls as unknown as Array<[string]>).some(call => call[0] === 'product_categories')).toBe(true);

    // The catalog snapshot doesn't have it yet (insert still in flight): the node must stay.
    const tree = catalogSnapshotToProductTree({ products: [], categories: [], assemblies: [], components: [] }, useProductStore.getState().nodes);
    expect(tree.nodes[productId]?.name).toBe(useProductStore.getState().nodes[productId].name);
    const parent = tree.nodes[tree.nodes[productId].parentId!];
    expect(parent?.name).toBeTruthy();
    expect(parent.children).toContain(productId);
    registerCatalogPersister(null);
  });
});
