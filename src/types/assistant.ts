import type { PipelineStage, TradeType } from '@/services/ai/providers/types';

export type AssistantStepStatus = 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
export type AssistantRunStatus = AssistantStepStatus | 'waiting-approval' | 'waiting-clarification';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
export type ClarificationStatus = 'pending' | 'answered' | 'cancelled';

export interface EvidenceCitation {
  id: string;
  documentId?: string;
  documentName?: string;
  page: number;
  label: string;
  snippet?: string;
  confidence?: number;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface AssistantArtifact {
  id: string;
  type: 'takeoff' | 'detections' | 'estimate' | 'callouts' | 'product-map' | 'document';
  title: string;
  summary?: string;
  data?: unknown;
}

export interface ToolActivity {
  id: string;
  toolId: string;
  title: string;
  summary?: string;
  status: AssistantStepStatus;
  input?: unknown;
  output?: unknown;
  startedAt?: string;
  completedAt?: string;
}

export interface RunStep {
  id: string;
  label: string;
  summary?: string;
  stage?: PipelineStage | 'planning' | 'tool' | 'approval' | 'complete' | 'clarification' | 'verification';
  status: AssistantStepStatus;
  progress?: number;
  startedAt?: string;
  completedAt?: string;
  toolActivity?: ToolActivity;
  citations?: EvidenceCitation[];
  error?: string;
}

export interface AssistantRun {
  id: string;
  messageId: string;
  conversationId: string;
  status: AssistantRunStatus;
  summary?: string;
  steps: RunStep[];
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  messageId: string;
  toolId: string;
  title: string;
  description: string;
  status: ApprovalStatus;
  payload: unknown;
  preview?: unknown;
  undoable: boolean;
  createdAt: string;
  resolvedAt?: string;
  error?: string;
  /**
   * Provider-facing tool call id from the model that requested this mutation
   * (OpenAI tool_call_id / Anthropic tool_use_id). Distinct from `id`, which is
   * the approval UI/tracking record. Required for native tool-result continuity
   * after approve/reject.
   */
  toolCallId?: string;
}

export interface ClarificationOption {
  id: string;
  label: string;
  value: string;
}

export interface ClarificationRequest {
  id: string;
  runId: string;
  messageId: string;
  stepKey: string;
  question: string;
  description?: string;
  options: ClarificationOption[];
  allowMultiSelect?: boolean;
  allowFreeform?: boolean;
  status: ClarificationStatus;
  createdAt: string;
  resolvedAt?: string;
  answer?: {
    selectedValues: string[];
    freeform?: string;
    displayText: string;
  };
}

export interface AssistantResultSummary {
  summary: string;
  actionsTaken?: string[];
  warnings?: string[];
}

export type AssistantMessageBlock =
  | { id: string; type: 'markdown'; markdown: string }
  | { id: string; type: 'activity'; runId: string }
  | { id: string; type: 'citations'; citations: EvidenceCitation[] }
  | { id: string; type: 'evidence'; title: string; citations: EvidenceCitation[]; summary?: string }
  | { id: string; type: 'artifact'; artifact: AssistantArtifact }
  | { id: string; type: 'approval'; approvalId: string }
  | { id: string; type: 'question'; clarificationId: string }
  | { id: string; type: 'progress'; label: string; status: 'running' | 'completed' | 'failed' }
  | { id: string; type: 'result'; result: AssistantResultSummary }
  | { id: string; type: 'tool-result'; activity: ToolActivity };

export interface AssistantConversation {
  id: string;
  contextId: string;
  title: string;
  trade: TradeType;
  createdAt: string;
  updatedAt: string;
}
