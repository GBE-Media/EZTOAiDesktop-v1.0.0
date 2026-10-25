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
  pageLabel?: string;
  sheetNumber?: string;
  specSection?: string;
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
  executing?: boolean;
  error?: string;
  executionResult?: {
    status?: 'ok' | 'partial' | 'failed' | string;
    placed?: number;
    autoCommitted?: number;
    needsConfirmation?: number;
    reviewQueued?: number;
    dropped?: Array<{ index?: number; itemId?: string; reason: string }>;
    error?: string;
    perMarker?: Array<{ index?: number; itemId?: string; reason: string }>;
  };
  /**
   * Provider-facing tool call id from the model that requested this mutation
   * (OpenAI tool_call_id / Anthropic tool_use_id). Distinct from `id`, which is
   * the approval UI/tracking record. Required for native tool-result continuity
   * after approve/reject.
   */
  toolCallId?: string;
}

/** A place in a document the assistant wants the user to look at. */
export interface AssistantFocus {
  documentId?: string;
  page: number;
  /** Document points (PDF page points at scale 1, top-left origin). */
  bounds?: { x: number; y: number; width: number; height: number };
  label?: string;
}

/** One side of a discrepancy (what the drawing / spec says, with its exact location). */
export interface DiscrepancySide {
  documentId?: string;
  documentName?: string;
  page: number;
  sheetNumber?: string;
  section?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  excerpt: string;
}

export interface Discrepancy {
  id: string;
  title: string;
  severity: 'high' | 'medium' | 'low';
  drawing: DiscrepancySide;
  spec: DiscrepancySide;
  recommendation?: string;
  createdAt: string;
}

export interface ClarificationOption {
  id: string;
  label: string;
  value: string;
  focus?: AssistantFocus;
}

/** A point the user picked on a drawing (display percent of the page, as the AI tools use). */
export interface PickedPoint {
  documentId?: string;
  page: number;
  /** 0–100 of the displayed (rotated) page. */
  xPct: number;
  yPct: number;
}

/** One question inside a multi-step question card. */
export interface ClarificationField {
  id: string;
  prompt: string;
  /** choice: buttons · point: "Show me on the drawing" · text: typed answer. */
  kind: 'choice' | 'point' | 'text' | 'area';
  options?: Array<ClarificationOption & { point?: PickedPoint }>;
  /** Value of the option the AI recommends (pre-selected). */
  recommended?: string;
  /** Point fields: where to pick (defaults to the current page). */
  documentId?: string;
  page?: number;
  /** Banner text while picking, e.g. "Click Panel LP-1". */
  pickLabel?: string;
  optional?: boolean;
  placeholder?: string;
}

/** A box dragged on the drawing (0–100 of the displayed page). */
export interface PickedArea {
  documentId?: string;
  page: number;
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

export interface ClarificationFieldAnswer {
  value?: string;
  label?: string;
  point?: PickedPoint;
  areas?: PickedArea[];
}

export interface ClarificationRequest {
  id: string;
  runId: string;
  messageId: string;
  stepKey: string;
  question: string;
  description?: string;
  options: ClarificationOption[];
  /** Structured questions (one card, answered together). */
  fields?: ClarificationField[];
  /** Tool to re-run with the answers merged into its arguments (set by tools that ask). */
  resume?: { toolId: string; args: Record<string, unknown>; apply: Record<string, string> };
  allowMultiSelect?: boolean;
  allowFreeform?: boolean;
  /** What on the drawings/specs the question is about (auto-navigated, "Show on drawing"). */
  focus?: AssistantFocus;
  status: ClarificationStatus;
  createdAt: string;
  resolvedAt?: string;
  answer?: {
    selectedValues: string[];
    freeform?: string;
    displayText: string;
    fields?: Record<string, ClarificationFieldAnswer>;
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
  | { id: string; type: 'tool-result'; activity: ToolActivity }
  | { id: string; type: 'discrepancies'; discrepancies: Discrepancy[] }
  | {
      id: string;
      type: 'follow-up';
      messageId: string;
      question: string;
      options: Array<{ label: string; reply: string | null; primary?: boolean }>;
    };

export interface AssistantConversation {
  id: string;
  contextId: string;
  title: string;
  trade: TradeType;
  createdAt: string;
  updatedAt: string;
}
