import { describe, expect, it, vi } from 'vitest';
import {
  executeApprovedAssistantAction,
  executeAssistantTool,
  getAssistantTool,
  registerAssistantTools,
} from './registry';
import type { AssistantToolContext } from './types';
import { registerAllAgentTools, resetAgentToolRegistrationForTests } from '../agent/tools/registerAll';
import { z } from 'zod';

function makeContext(): AssistantToolContext {
  return {
    runId: 'run-1',
    messageId: 'message-1',
    getDocumentContext: vi.fn(() => ({ page: 3 })),
    analyzePage: vi.fn(async input => input),
    extractPageText: vi.fn(async input => input),
    searchDocument: vi.fn(async () => []),
    inspectCatalog: vi.fn(() => []),
    inspectMarkups: vi.fn(() => []),
    navigateToPage: vi.fn(),
    activateEditorTool: vi.fn(),
    placeMarkups: vi.fn(payload => payload),
    updateMarkups: vi.fn(payload => payload),
    deleteMarkups: vi.fn(payload => payload),
    linkCatalog: vi.fn(payload => payload),
    addApproval: vi.fn(),
  };
}

describe('assistant tool registry', () => {
  it('validates input and automatically executes read tools', async () => {
    const context = makeContext();
    const result = await executeAssistantTool('analyze_page', { page: 2, scope: 'full' }, context);
    expect(result.status).toBe('completed');
    expect(context.analyzePage).toHaveBeenCalledWith({ page: 2, scope: 'full' });
    const invalid = await executeAssistantTool('analyze_page', { page: 0 }, context);
    expect(invalid.status).toBe('failed');
  });

  it('documents analyze_page scope literals so models are less likely to emit "full page"', () => {
    const tool = getAssistantTool('analyze_page');
    expect(tool?.description).toMatch(/'full'/);
    expect(tool?.description).toMatch(/never 'full page'/i);
  });

  it('requires approval for every document mutation', async () => {
    const context = makeContext();
    const result = await executeAssistantTool('place_markups', {
      description: 'Place one verified callout',
      pointers: [{
        type: 'callout',
        ref: 1,
        point: { x: 100, y: 200 },
        page: 2,
        label: 'Receptacle',
      }],
    }, context);
    expect(result.status).toBe('approval-required');
    expect(result.approval).toMatchObject({
      toolId: 'place_markups',
      status: 'pending',
      undoable: true,
    });
    expect(context.placeMarkups).not.toHaveBeenCalled();
    expect(context.addApproval).toHaveBeenCalledOnce();
  });

  it('forwards navigate_page bounds to the canvas adapter', async () => {
    const context = makeContext();
    const bounds = { x: 10, y: 20, width: 100, height: 40 };
    const result = await executeAssistantTool('navigate_page', { page: 2, bounds }, context);
    expect(result.status).toBe('completed');
    expect(context.navigateToPage).toHaveBeenCalledWith(2, bounds);
  });

  it('executes only an explicitly approved action', async () => {
    const context = makeContext();
    const pointers = [{
      type: 'callout' as const,
      ref: 1,
      point: { x: 100, y: 200 },
      page: 2,
    }];
    const result = await executeAssistantTool('place_markups', {
      description: 'Place one verified callout',
      pointers,
    }, context);
    await executeApprovedAssistantAction(result.approval!, context);
    expect(context.placeMarkups).toHaveBeenCalledWith(pointers);
  });

  it('rejects mismatched mutation payloads per tool schema', async () => {
    const context = makeContext();
    const placeAsDelete = await executeAssistantTool('place_markups', {
      description: 'Should fail',
      markupIds: ['m1'],
    }, context);
    expect(placeAsDelete.status).toBe('failed');

    const deleteAsPlace = await executeAssistantTool('delete_markups', {
      description: 'Should fail',
      pointers: [{ type: 'callout', ref: 1, point: { x: 1, y: 2 } }],
    }, context);
    expect(deleteAsPlace.status).toBe('failed');

    const deleteOk = await executeAssistantTool('delete_markups', {
      description: 'Remove one markup',
      markupIds: ['m1'],
    }, context);
    expect(deleteOk.status).toBe('approval-required');
    expect(deleteOk.approval?.payload).toEqual({ markupIds: ['m1'], page: undefined });
  });

  it('registers BidveraAi domain tools including stubs', () => {
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();
    return executeAssistantTool('getCurrentEstimateContext', {}, makeContext()).then(result => {
      expect(result.status).toBe('stub');
      expect(result.stubReason).toBeTruthy();
    });
  });

  it('allows registering custom tools', async () => {
    registerAssistantTools([{
      id: 'unit_test_echo',
      title: 'Echo',
      description: 'Echo input',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({ value: z.string() }),
      execute: async (_ctx, input) => ({
        status: 'completed',
        summary: 'echoed',
        output: input.value,
      }),
    }]);
    const result = await executeAssistantTool('unit_test_echo', { value: 'hi' }, makeContext());
    expect(result).toMatchObject({ status: 'completed', output: 'hi' });
  });
});
