import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from './zodToJsonSchema';
import {
  assistantToolsToProxyDefinitions,
  decisionFromCompletion,
  mergeToolCalls,
  stableArgsKey,
} from './toProxyTools';
import { registerAllAgentTools, resetAgentToolRegistrationForTests } from '../agent/tools/registerAll';
import { getAssistantTool } from './registry';
import {
  looksLikeAgentProtocolJson,
  sanitizeAssistantVisibleText,
} from '../agent/assistantVisibleText';

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

describe('stableArgsKey + mergeToolCalls dedup', () => {
  beforeEach(() => {
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();
  });

  it('different nested markups with same description produce different keys and both survive dedup', () => {
    const description = 'Place fixture counts';
    const a = {
      description,
      markups: [{
        type: 'text',
        page: 1,
        points: [{ x: 100, y: 200 }],
        content: 'A: 8',
      }],
    };
    const b = {
      description,
      markups: [{
        type: 'text',
        page: 2,
        points: [{ x: 300, y: 400 }],
        content: 'B: 12',
      }],
    };
    expect(stableArgsKey(a)).not.toBe(stableArgsKey(b));
    // Keys must retain nested page/content (old replacer-array bug produced {"markups":[{}]}).
    expect(stableArgsKey(a)).toContain('"page":1');
    expect(stableArgsKey(a)).toContain('"content":"A: 8"');
    expect(stableArgsKey(b)).toContain('"page":2');
    expect(stableArgsKey(b)).toContain('"content":"B: 12"');

    const merged = mergeToolCalls(
      [{ id: 'n1', name: 'place_markups', arguments: a }],
      [{ id: 'j1', name: 'place_markups', arguments: b }],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map(c => c.id).sort()).toEqual(['j1', 'n1']);
  });

  it('fully identical place_markups arguments collapse to one', () => {
    const args = {
      description: 'Place fixture counts',
      markups: [{
        type: 'text',
        page: 1,
        points: [{ x: 100, y: 200 }],
        content: 'A: 8',
      }],
    };
    expect(stableArgsKey(args)).toBe(stableArgsKey({ ...args }));
    const merged = mergeToolCalls(
      [{ id: 'n1', name: 'place_markups', arguments: args }],
      [{ id: 'j1', name: 'place_markups', arguments: structuredClone(args) }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('n1');
  });

  it('deep nested markups+points are preserved in the key', () => {
    const args = {
      description: 'multi',
      markups: [
        {
          id: 'm1',
          type: 'text',
          page: 1,
          points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
          style: { strokeColor: '#008000', fontSize: 22 },
          content: 'line1',
        },
        {
          id: 'm2',
          type: 'callout',
          page: 3,
          points: [{ x: 50, y: 60 }],
          content: 'line2',
        },
      ],
    };
    const key = stableArgsKey(args);
    expect(key).toContain('"id":"m1"');
    expect(key).toContain('"id":"m2"');
    expect(key).toContain('"x":10');
    expect(key).toContain('"y":40');
    expect(key).toContain('"page":3');
    expect(key).toContain('"fontSize":22');
  });

  it('object key insertion order does not change the key', () => {
    const left = { page: 1, content: 'x', type: 'text' };
    const right = { content: 'x', type: 'text', page: 1 };
    expect(stableArgsKey(left)).toBe(stableArgsKey(right));
    expect(stableArgsKey({ description: 'd', markups: [left] }))
      .toBe(stableArgsKey({ markups: [right], description: 'd' }));
  });
});

describe('looksLikeAgentProtocolJson', () => {
  it('requires a recognized type field, not a loose tool_calls substring', () => {
    expect(looksLikeAgentProtocolJson(JSON.stringify({
      type: 'tool_calls',
      toolCalls: [{ name: 'place_markups', arguments: {} }],
    }))).toBe(true);

    expect(looksLikeAgentProtocolJson(JSON.stringify({
      type: 'final',
      message: 'ok',
    }))).toBe(true);

    // Unrelated JSON that merely mentions tool_calls somewhere must NOT be flagged.
    const unrelated = JSON.stringify({
      note: 'The API field tool_calls is documented here',
      tool_calls: 'this is not our protocol',
      example: { toolCalls: [{ name: 'fake' }] },
    });
    expect(looksLikeAgentProtocolJson(unrelated)).toBe(false);
    expect(sanitizeAssistantVisibleText(unrelated)).toBe(unrelated);
  });
});
