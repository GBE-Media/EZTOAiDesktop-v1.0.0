import type { AssistantToolDefinition, AssistantToolResult } from '../tools/types';
import { toolRequiresApproval } from '../tools/types';
import { getAssistantTool } from '../tools/registry';

const MAX_OUTPUT_CHARS = 12_000;
const MAX_STRING_DEPTH = 6;

export interface SafetyDecision {
  allowed: boolean;
  mode: 'auto' | 'approval' | 'reject';
  reason?: string;
  tool?: AssistantToolDefinition;
}

export function resolveToolSafety(toolId: string): SafetyDecision {
  const tool = getAssistantTool(toolId);
  if (!tool) {
    return { allowed: false, mode: 'reject', reason: `Unknown tool: ${toolId}` };
  }
  if (toolRequiresApproval(tool)) {
    return { allowed: true, mode: 'approval', tool, reason: `Tool ${toolId} requires user approval.` };
  }
  return { allowed: true, mode: 'auto', tool };
}

/** Truncate / strip oversized tool outputs before re-inserting into model prompts. */
export function sanitizeToolOutput(output: unknown, maxChars = MAX_OUTPUT_CHARS): unknown {
  try {
    const sanitized = sanitizeValue(output, 0);
    const serialized = JSON.stringify(sanitized);
    if (!serialized) return sanitized;
    if (serialized.length <= maxChars) return sanitized;
    return {
      truncated: true,
      preview: serialized.slice(0, maxChars),
      originalLength: serialized.length,
    };
  } catch {
    return { truncated: true, preview: String(output).slice(0, maxChars) };
  }
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_STRING_DEPTH) return '[MaxDepth]';
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.length > 2_000) return `${value.slice(0, 2_000)}…[truncated]`;
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const limited = value.slice(0, 50).map(item => sanitizeValue(item, depth + 1));
    if (value.length > 50) limited.push(`…[${value.length - 50} more items]`);
    return limited;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 40);
    const result: Record<string, unknown> = {};
    for (const [key, nested] of entries) {
      // Drop obvious binary / huge blobs
      if (/base64|imageData|pdfBytes/i.test(key)) {
        result[key] = '[omitted]';
        continue;
      }
      result[key] = sanitizeValue(nested, depth + 1);
    }
    return result;
  }
  return String(value);
}

export function formatToolResultForPrompt(result: AssistantToolResult): string {
  const payload = {
    status: result.status,
    summary: result.summary,
    stubReason: result.stubReason,
    suggestedUserMessage: result.suggestedUserMessage,
    output: sanitizeToolOutput(result.output),
  };
  return JSON.stringify(payload);
}
