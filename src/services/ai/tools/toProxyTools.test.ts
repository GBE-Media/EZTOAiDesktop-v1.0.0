import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from './zodToJsonSchema';
import {
  assistantToolsToProxyDefinitions,
  decisionFromCompletion,
} from './toProxyTools';
import { registerAllAgentTools, resetAgentToolRegistrationForTests } from '../agent/tools/registerAll';
import { getAssistantTool } from './registry';

describe('zodToJsonSchema', () => {
  it('converts objects, enums, optionals, and defaults used by registry tools', () => {
    const schema = z.object({
      page: z.number().int().positive(),
      scope: z.enum(['full', 'viewport', 'selection']).default('full'),
      prompt: z.string().optional(),
    });
    const json = zodToJsonSchema(schema);
    expect(json).toMatchObject({
      type: 'object',
      properties: {
        page: { type: 'integer' },
        scope: { type: 'string', enum: ['full', 'viewport', 'selection'], default: 'full' },
        prompt: { type: 'string' },
      },
      required: ['page'],
    });
  });

  it('converts empty object schemas to object with no required props', () => {
    expect(zodToJsonSchema(z.object({}))).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });
});

describe('assistantToolsToProxyDefinitions', () => {
  beforeEach(() => {
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();
  });

  it('exports every registered tool as a proxy AIToolDefinition with inputSchema', () => {
    const tools = assistantToolsToProxyDefinitions();
    expect(tools.length).toBeGreaterThan(5);

    const analyze = tools.find(t => t.name === 'analyze_page');
    expect(analyze).toBeDefined();
    expect(analyze!.description).toContain('analysis');
    expect(analyze!.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        page: { type: 'integer' },
      },
      required: expect.arrayContaining(['page']),
    });

    const place = tools.find(t => t.name === 'place_markups');
    expect(place).toBeDefined();
    expect(place!.description).toMatch(/approval/i);
    expect(place!.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        description: { type: 'string' },
        markups: { type: 'array' },
        pointers: { type: 'array' },
      },
    });
    expect(place!.inputSchema.properties).not.toHaveProperty('payload');

    const del = tools.find(t => t.name === 'delete_markups');
    expect(del!.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        description: { type: 'string' },
        markupIds: { type: 'array' },
      },
    });

    // Registry tool ids must match proxy tool names 1:1.
    for (const tool of tools) {
      expect(getAssistantTool(tool.name)).toBeDefined();
    }
  });
});

describe('decisionFromCompletion', () => {
  beforeEach(() => {
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();
  });

  it('merges native tools with JSON-protocol tool_calls and never leaks raw JSON as assistantText', () => {
    const hybrid = {
      type: 'tool_calls',
      assistantText: "I'll place a non-destructive text count summary on sheet E-100.",
      toolCalls: [{
        id: 'call_1',
        name: 'place_markups',
        arguments: {
          description: 'Place preliminary lighting fixture count summary on E-100',
          markups: [{ type: 'text', page: 1, content: 'A: 8' }],
        },
      }],
      final: {
        message: 'Please approve the markup placement.',
        clarifyingQuestions: [],
      },
    };

    const decision = decisionFromCompletion({
      content: JSON.stringify(hybrid),
      toolCalls: [
        { id: 'call_native_1', name: 'get_document_context', input: {} },
      ],
    });

    expect(decision.type).toBe('tool_calls');
    if (decision.type !== 'tool_calls') return;
    expect(decision.toolCalls.map(c => c.name)).toEqual(
      expect.arrayContaining(['place_markups', 'get_document_context']),
    );
    // Approval-required mutation is ordered ahead of the read tool.
    expect(decision.toolCalls[0].name).toBe('place_markups');
    expect(decision.assistantText).toBe(
      "I'll place a non-destructive text count summary on sheet E-100.",
    );
    expect(decision.assistantText).not.toContain('"type":"tool_calls"');
    expect(decision.assistantText).not.toContain('place_markups');
  });

  it('uses nested final.message as visible text when assistantText is missing', () => {
    const decision = decisionFromCompletion({
      content: JSON.stringify({
        type: 'tool_calls',
        toolCalls: [{ id: 'c1', name: 'place_markups', arguments: { description: 'x', markups: [] } }],
        final: { message: 'Please approve this placement.', clarifyingQuestions: [] },
      }),
      toolCalls: [{ id: 'n1', name: 'get_document_context', input: {} }],
    });
    expect(decision.type).toBe('tool_calls');
    if (decision.type === 'tool_calls') {
      expect(decision.assistantText).toBe('Please approve this placement.');
    }
  });

  it('does not dump a JSON final envelope into assistantText when native tools are present', () => {
    const decision = decisionFromCompletion({
      content: JSON.stringify({
        type: 'final',
        message: 'should be shown as human text',
      }),
      toolCalls: [
        { id: 'call_native_1', name: 'get_document_context', input: {} },
        { id: 'call_native_2', name: 'analyze_page', input: { page: 2, scope: 'full' } },
      ],
    });
    expect(decision).toEqual({
      type: 'tool_calls',
      toolCalls: [
        { id: 'call_native_1', name: 'get_document_context', arguments: {} },
        { id: 'call_native_2', name: 'analyze_page', arguments: { page: 2, scope: 'full' } },
      ],
      assistantText: 'should be shown as human text',
    });
  });

  it('falls back to JSON free-form parseAgentDecision when toolCalls are absent', () => {
    const decision = decisionFromCompletion({
      content: JSON.stringify({
        type: 'clarify',
        message: 'Which page?',
        questions: ['page'],
      }),
      toolCalls: [],
    });
    expect(decision.type).toBe('clarify');
    if (decision.type === 'clarify') {
      expect(decision.message).toBe('Which page?');
    }
  });

  it('parses stringified tool input objects from providers', () => {
    const decision = decisionFromCompletion({
      content: '',
      toolCalls: [
        { id: 'c1', name: 'search_document', input: '{"query":"panel"}' },
      ],
    });
    expect(decision.type).toBe('tool_calls');
    if (decision.type === 'tool_calls') {
      expect(decision.toolCalls[0].arguments).toEqual({ query: 'panel' });
    }
  });
});
