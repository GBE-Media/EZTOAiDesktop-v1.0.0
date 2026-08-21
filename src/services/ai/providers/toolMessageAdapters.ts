import type { AIMessage, AIToolCall } from './types';

/**
 * OpenAI / Lovable chat-completions message shape for tool calling.
 * Tool results use role "tool" + tool_call_id.
 */
export type OpenAIChatMessage =
  | {
      role: 'system' | 'user' | 'assistant';
      content: string | Array<Record<string, unknown>>;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | {
      role: 'tool';
      tool_call_id: string;
      content: string;
      name?: string;
    };

/**
 * Anthropic Messages API content: tool results are user-role tool_result blocks
 * (Anthropic has no "tool" role).
 */
export type AnthropicChatMessage = {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
};

function toolCallsToOpenAI(toolCalls: AIToolCall[]) {
  return toolCalls.map(call => ({
    id: call.id,
    type: 'function' as const,
    function: {
      name: call.name,
      arguments: typeof call.input === 'string'
        ? call.input
        : JSON.stringify(call.input ?? {}),
    },
  }));
}

function toolCallsToAnthropic(toolCalls: AIToolCall[]): Array<Record<string, unknown>> {
  return toolCalls.map(call => ({
    type: 'tool_use',
    id: call.id,
    name: call.name,
    input: typeof call.input === 'string'
      ? (() => { try { return JSON.parse(call.input); } catch { return {}; } })()
      : (call.input ?? {}),
  }));
}

/**
 * Convert unified AIMessage[] (including role "tool") into OpenAI chat messages.
 */
export function toOpenAIChatMessages(messages: AIMessage[]): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: msg.toolCallId || msg.name || 'tool_call',
        content: msg.content ?? '',
        ...(msg.name ? { name: msg.name } : {}),
      });
      continue;
    }

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: toolCallsToOpenAI(msg.toolCalls),
      });
      continue;
    }

    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const image of msg.images) {
        content.push({
          type: 'image_url',
          image_url: {
            url: image.startsWith('data:') ? image : `data:image/png;base64,${image}`,
            detail: 'high',
          },
        });
      }
      out.push({ role: 'user', content });
      continue;
    }

    out.push({
      role: msg.role,
      content: msg.content ?? '',
    });
  }

  return out;
}

/**
 * Convert unified AIMessage[] into Anthropic messages + optional system string.
 * - role "tool" → user message with tool_result content block(s)
 * - consecutive tool messages are merged into one user message (Anthropic requirement)
 * - assistant toolCalls → assistant content with tool_use blocks
 */
export function toAnthropicChatMessages(messages: AIMessage[]): {
  system?: string;
  messages: AnthropicChatMessage[];
} {
  const system = messages.find(m => m.role === 'system')?.content;
  const out: AnthropicChatMessage[] = [];

  const flushToolResults = (pending: AIMessage[]) => {
    if (pending.length === 0) return;
    const blocks = pending.map(msg => ({
      type: 'tool_result',
      tool_use_id: msg.toolCallId || msg.name || 'tool_call',
      content: msg.content ?? '',
    }));
    out.push({ role: 'user', content: blocks });
  };

  let pendingTools: AIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'tool') {
      pendingTools.push(msg);
      continue;
    }

    flushToolResults(pendingTools);
    pendingTools = [];

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      if (msg.content?.trim()) {
        blocks.push({ type: 'text', text: msg.content });
      }
      blocks.push(...toolCallsToAnthropic(msg.toolCalls));
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      for (const image of msg.images) {
        let mediaType = 'image/png';
        let base64Data = image;
        if (image.startsWith('data:')) {
          const match = image.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            mediaType = match[1];
            base64Data = match[2];
          }
        }
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64Data,
          },
        });
      }
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      out.push({ role: 'user', content });
      continue;
    }

    out.push({
      role: msg.role as 'user' | 'assistant',
      content: msg.content ?? '',
    });
  }

  flushToolResults(pendingTools);

  return { system, messages: out };
}
