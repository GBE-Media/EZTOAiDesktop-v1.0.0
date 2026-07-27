import type { ApprovalRequest, ToolActivity } from '@/types/assistant';
import type { AssistantToolResult } from '../tools/types';

/** UI-facing agent turn status (maps onto AssistantRun + message blocks). */
export type AgentUiStatus =
  | 'thinking'
  | 'needs_clarification'
  | 'needs_approval'
  | 'running_tool'
  | 'completed'
  | 'failed';

export type AgentFinalStatus =
  | 'completed'
  | 'needs_clarification'
  | 'needs_approval'
  | 'failed'
  | 'cancelled'
  | 'max_steps';

export interface AgentActionTaken {
  toolId: string;
  title: string;
  summary: string;
  status: AssistantToolResult['status'];
}

export interface AgentToolHistoryEntry {
  id: string;
  toolId: string;
  title: string;
  args: unknown;
  result: AssistantToolResult;
  startedAt: string;
  completedAt: string;
}

export interface AgentTurnResult {
  status: AgentUiStatus;
  assistantMessage: string;
  actionsTaken: AgentActionTaken[];
  approvalRequest?: ApprovalRequest;
  toolHistory: AgentToolHistoryEntry[];
  finalStatus: AgentFinalStatus;
  clarifyingQuestions?: string[];
  runId: string;
  messageId: string;
  /** Internal plan text the model produced (for tracing / UI). */
  plan?: string;
}

export interface AgentModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface AgentToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AgentModelDecision =
  | { type: 'plan'; plan: string }
  | { type: 'tool_calls'; toolCalls: AgentToolCallRequest[]; assistantText?: string }
  | { type: 'final'; message: string; clarifyingQuestions?: string[] }
  | { type: 'clarify'; message: string; questions: string[] };

export interface AgentTraceEvent {
  runId: string;
  type:
    | 'request'
    | 'plan'
    | 'tool_selected'
    | 'tool_args'
    | 'tool_result'
    | 'approval_requested'
    | 'approval_granted'
    | 'approval_denied'
    | 'retry'
    | 'error'
    | 'final';
  timestamp: string;
  data?: unknown;
}

export function toolHistoryToActivity(entry: AgentToolHistoryEntry): ToolActivity {
  return {
    id: entry.id,
    toolId: entry.toolId,
    title: entry.title,
    summary: entry.result.summary,
    status: entry.result.status === 'failed' ? 'error' : 'completed',
    input: entry.args,
    output: entry.result.output,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
  };
}
