import type { ApprovalRequest, ClarificationRequest, ToolActivity } from '@/types/assistant';
import type { AssistantToolResult } from '../tools/types';
import type { AgentModelRole } from './roles';
import type { BlueprintAnalysisResult, TradeType } from '../providers/types';

/** UI-facing agent turn status (maps onto AssistantRun + message blocks). */
export type AgentUiStatus =
  | 'routing'
  | 'thinking'
  | 'needs_clarification'
  | 'needs_approval'
  | 'running_tool'
  | 'running_tools'
  | 'verifying'
  | 'completed'
  | 'failed';

export type AgentFinalStatus =
  | 'completed'
  | 'needs_clarification'
  | 'needs_approval'
  | 'failed'
  | 'cancelled'
  | 'max_steps';

export type AgentErrorCode = 'SESSION_EXPIRED' | 'DOCUMENT_MISMATCH' | 'ANALYSIS_TRUNCATED';

export type RoutingPath =
  | 'answer_directly'
  | 'ask_clarification'
  | 'invoke_primary'
  | 'invoke_primary_plus_verifier'
  | 'invoke_fallback';

export type TaskType =
  | 'simple_qa'
  | 'read_context'
  | 'write_action'
  | 'compliance'
  | 'cost_sensitive'
  | 'layout'
  | 'ambiguous'
  | 'other';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RoutingDecision {
  path: RoutingPath;
  taskType: TaskType;
  complexity: 'low' | 'medium' | 'high';
  risk: RiskLevel;
  preferTools: boolean;
  requireVerifier: boolean;
  suggestedTools: string[];
  reason: string;
  clarificationQuestion?: string;
}

export interface ModelUsedEntry {
  role: AgentModelRole;
  provider: string;
  model: string;
  phase: 'routing' | 'primary' | 'verification' | 'fallback';
}

export interface VerificationSummary {
  deterministic: Array<{ toolId: string; summary: string; status: string }>;
  llm?: {
    verdict: 'approve' | 'revise' | 'escalate' | 'ask_clarification';
    issues: string[];
    summary: string;
  };
}

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

export interface PipelineClarificationStep {
  id: string;
  prompt: string;
  options: Array<{ id: string; label: string; value: string }>;
  allowMultiple?: boolean;
  answer?: {
    selectedValues: string[];
    freeform?: string;
    displayText: string;
  };
}

export interface PipelineContinuationState {
  kind: 'pipeline';
  originalPrompt: string;
  analysis: BlueprintAnalysisResult[];
  /**
   * Set when takeoff analysis could not be stored intact for resume.
   * Resume must refuse estimation rather than silently using partial data.
   */
  analysisTruncated?: boolean;
  evidence: string[];
  questions: PipelineClarificationStep[];
  nextQuestionIndex: number;
  pendingClarificationId?: string;
  pendingClarificationStepKey?: string;
  config: {
    trade: TradeType;
    pages: number[];
    pageWidth: number;
    pageHeight: number;
    highAccuracyMode: boolean;
    visibleOnly: boolean;
    refinePlacements: boolean;
    documentId?: string;
  };
}

export interface AgentContinuationState {
  kind: 'agent';
  waitingFor: 'clarification' | 'approval';
}

/** Serializable agent/task state. Runtime contexts and abort signals are rebuilt on resume. */
export interface AgentSessionState {
  runId: string;
  messageId: string;
  messages: AgentModelMessage[];
  toolHistory: AgentToolHistoryEntry[];
  actionsTaken: AgentActionTaken[];
  contextText: string;
  imageBase64?: string;
  plan?: string;
  pendingApprovalId?: string;
  continuation?: AgentContinuationState | PipelineContinuationState;
}

export interface AgentTurnResult {
  status: AgentUiStatus;
  assistantMessage: string;
  actionsTaken: AgentActionTaken[];
  approvalRequest?: ApprovalRequest;
  clarificationRequest?: ClarificationRequest;
  toolHistory: AgentToolHistoryEntry[];
  finalStatus: AgentFinalStatus;
  errorCode?: AgentErrorCode;
  clarifyingQuestions?: string[];
  runId: string;
  messageId: string;
  plan?: string;
  routingDecision?: RoutingDecision;
  modelsUsed?: ModelUsedEntry[];
  verificationSummary?: VerificationSummary;
}

export interface AgentModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
  /** Assistant tool requests to replay as provider-native tool_calls / tool_use. */
  toolCalls?: AgentToolCallRequest[];
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
  | {
      type: 'clarify';
      message: string;
      questions: string[];
      /** Clickable choices for the primary question (message / questions[0]). */
      options?: Array<{ id: string; label: string; value: string }>;
    };

export interface AgentTraceEvent {
  runId: string;
  type:
    | 'request'
    | 'intake'
    | 'routing'
    | 'plan'
    | 'tool_selected'
    | 'tool_args'
    | 'tool_result'
    | 'approval_requested'
    | 'approval_granted'
    | 'approval_denied'
    | 'deterministic_check'
    | 'verifier_outcome'
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
