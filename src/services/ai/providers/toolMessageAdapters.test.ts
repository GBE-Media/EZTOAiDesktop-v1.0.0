import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AIMessage } from './types';
import { toAnthropicChatMessages, toOpenAIChatMessages } from './toolMessageAdapters';

const conversation: AIMessage[] = [
  { role: 'system', content: 'You are a takeoff agent.' },
  { role: 'user', content: 'Count outlets on page 2.' },
  {
    role: 'assistant',
    content: 'Checking the page.',
    toolCalls: [
      { id: 'call_analyze_1', name: 'analyze_page', input: { page: 2, scope: 'full' } },
    ],
  },
  {
    role: 'tool',
    name: 'analyze_page',
    toolCallId: 'call_analyze_1',
    content: JSON.stringify({ status: 'completed', symbols: 12 }),
  },
];

describe('tool message adapters (OpenAI vs Anthropic)', () => {
  it('maps tool role to OpenAI role=tool + tool_call_id (not a prefixed user message)', () => {
    const openai = toOpenAIChatMessages(conversation);
    expect(openai).toEqual([
      { role: 'system', content: 'You are a takeoff agent.' },
      { role: 'user', content: 'Count outlets on page 2.' },
      {
        role: 'assistant',
        content: 'Checking the page.',
        tool_calls: [
          {
            id: 'call_analyze_1',
            type: 'function',
            function: {
              name: 'analyze_page',
              arguments: JSON.stringify({ page: 2, scope: 'full' }),
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_analyze_1',
        content: JSON.stringify({ status: 'completed', symbols: 12 }),
        name: 'analyze_page',
      },
    ]);
    expect(openai.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('TOOL_RESULT'))).toBe(false);
  });

  it('maps tool role to Anthropic user/tool_result blocks (Anthropic has no tool role)', () => {
    const { system, messages } = toAnthropicChatMessages(conversation);
    expect(system).toBe('You are a takeoff agent.');
    expect(messages).toEqual([
      { role: 'user', content: 'Count outlets on page 2.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking the page.' },
          {
            type: 'tool_use',
            id: 'call_analyze_1',
            name: 'analyze_page',
            input: { page: 2, scope: 'full' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_analyze_1',
            content: JSON.stringify({ status: 'completed', symbols: 12 }),
          },
        ],
      },
    ]);
    expect(messages.every(m => m.role === 'user' || m.role === 'assistant')).toBe(true);
  });

  it('merges consecutive tool results into one Anthropic user message', () => {
    const multi: AIMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'get_document_context', input: {} },
          { id: 'c2', name: 'inspect_markups', input: {} },
        ],
      },
      { role: 'tool', toolCallId: 'c1', name: 'get_document_context', content: '{"page":1}' },
      { role: 'tool', toolCallId: 'c2', name: 'inspect_markups', content: '[]' },
    ];
    const { messages } = toAnthropicChatMessages(multi);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c1', content: '{"page":1}' },
        { type: 'tool_result', tool_use_id: 'c2', content: '[]' },
      ],
    });
  });
});

describe('TOOL_RESULT workaround removal', () => {
  it('TOOL_RESULT string is gone from src/ and supabase/functions/ (not only modelAdapter)', () => {
    const roots = [
      join(process.cwd(), 'src'),
      join(process.cwd(), 'supabase', 'functions'),
    ];
    const hits: string[] = [];
    const walk = (dir: string) => {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) continue;
        // Skip tests themselves — they may mention TOOL_RESULT while asserting absence.
        if (/\.test\.(ts|tsx|js|jsx)$/.test(name)) continue;
        const source = readFileSync(full, 'utf8');
        if (source.includes('TOOL_RESULT')) {
          hits.push(full.replace(process.cwd() + '\\', '').replace(process.cwd() + '/', ''));
        }
      }
    };
    for (const root of roots) walk(root);
    expect(hits).toEqual([]);
  });
});
