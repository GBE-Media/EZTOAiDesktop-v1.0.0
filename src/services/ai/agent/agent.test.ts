import { describe, expect, it } from 'vitest';
import { buildAgentContext } from './contextBuilder';
import { parseAgentDecision } from './decisionParser';
import { formatToolResultForPrompt, resolveToolSafety, sanitizeToolOutput } from './safety';
import { registerAllAgentTools, resetAgentToolRegistrationForTests } from './tools/registerAll';

describe('agent safety + context + decision parsing', () => {
  it('sanitizes oversized tool output', () => {
    const big = { blob: 'x'.repeat(20_000), base64Image: 'AAAA' };
    const sanitized = sanitizeToolOutput(big) as Record<string, unknown>;
    expect(sanitized.truncated || JSON.stringify(sanitized).length < 20_000).toBeTruthy();
  });

  it('builds a compact context slice', () => {
    const { text, snapshot } = buildAgentContext({
      userIntent: 'Where is the fixture schedule?',
      trade: 'electrical',
      currentPage: 2,
      documentName: 'E-201.pdf',
      documentId: 'doc1',
      markupsSummary: 'Markups on page 2',
      recentTurns: [{ role: 'user', content: 'hello' }],
    });
    expect(text).toContain('fixture schedule');
    expect(text).toContain('E-201.pdf');
    expect(snapshot.document).toMatchObject({ page: 2 });
  });

  it('parses JSON tool protocol decisions', () => {
    expect(parseAgentDecision('{"type":"plan","plan":"1. Inspect\\n2. Callout"}')).toEqual({
      type: 'plan',
      plan: '1. Inspect\n2. Callout',
    });
    const tools = parseAgentDecision(JSON.stringify({
      type: 'tool_calls',
      toolCalls: [{ id: 'c1', name: 'getProjectContext', arguments: {} }],
    }));
    expect(tools.type).toBe('tool_calls');
    if (tools.type === 'tool_calls') {
      expect(tools.toolCalls[0].name).toBe('getProjectContext');
    }
    expect(parseAgentDecision('{"type":"clarify","message":"Which page?","questions":["page"]}').type).toBe('clarify');
    expect(parseAgentDecision('Just a prose answer').type).toBe('final');
  });

  it('resolves read vs approval safety', () => {
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();
    expect(resolveToolSafety('getProjectContext').mode).toBe('auto');
    expect(resolveToolSafety('place_markups').mode).toBe('approval');
    expect(resolveToolSafety('nope').mode).toBe('reject');
    expect(formatToolResultForPrompt({
      status: 'stub',
      summary: 'stubbed',
      stubReason: 'missing',
      output: { a: 1 },
    })).toContain('"stub"');
  });
});
