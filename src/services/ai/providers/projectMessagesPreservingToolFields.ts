import type { AIMessage } from './types';

/**
 * Project messages for proxy/vision transport without dropping native tool
 * metadata. Lossy `{ role, content, images }` maps break OpenAI tool_call_id
 * and Anthropic tool_use_id association on the next turn.
 */
export function projectMessagesPreservingToolFields(
  messages: Array<Pick<AIMessage, 'role' | 'content' | 'images' | 'toolCallId' | 'name' | 'toolCalls'>>,
): AIMessage[] {
  return messages.map((msg) => {
    const projected: AIMessage = {
      role: msg.role,
      content: msg.content,
    };
    if (msg.images && msg.images.length > 0) {
      projected.images = msg.images;
    }
    if (msg.toolCallId) {
      projected.toolCallId = msg.toolCallId;
    }
    if (msg.name) {
      projected.name = msg.name;
    }
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      projected.toolCalls = msg.toolCalls;
    }
    return projected;
  });
}
