import type { z } from 'zod';
import type { ApprovalRequest, EvidenceCitation } from '@/types/assistant';

/** Risk levels for the agent safety gate. `navigate` auto-runs like read. */
export type AssistantToolRisk = 'read' | 'navigate' | 'write' | 'destructive' | 'external';

/** @deprecated Use `write` — kept for callers that still check mutate. */
export type LegacyAssistantToolRisk = AssistantToolRisk | 'mutate';

export interface AssistantToolContext {
  runId: string;
  messageId: string;
  signal?: AbortSignal;
  getDocumentContext: () => unknown;
  analyzePage: (input: unknown) => Promise<unknown>;
  extractPageText: (input: unknown) => Promise<unknown>;
  /** Count/filter detections from cached (or fresh) page analysis. */
  countPageItems?: (input: unknown) => Promise<unknown>;
  searchDocument: (query: string) => Promise<EvidenceCitation[]>;
  inspectCatalog: () => unknown;
  inspectMarkups: () => unknown;
  navigateToPage: (page: number, bounds?: { x: number; y: number; width: number; height: number }) => void;
  activateEditorTool: (tool: string) => void;
  placeMarkups: (payload: unknown) => Promise<unknown> | unknown;
  updateMarkups: (payload: unknown) => Promise<unknown> | unknown;
  deleteMarkups: (payload: unknown) => Promise<unknown> | unknown;
  linkCatalog: (payload: unknown) => Promise<unknown> | unknown;
  addApproval: (approval: ApprovalRequest) => void;

  // BidveraAi domain adapters (optional — tools no-op / stub when missing)
  getProjectContext?: () => unknown;
  getTakeoffSummary?: () => unknown;
  getMaterialCounts?: () => unknown;
  getConversationContext?: () => unknown;
  getLayoutSuggestions?: (input: unknown) => Promise<unknown> | unknown;
  getRunSuggestions?: (input: unknown) => Promise<unknown> | unknown;
  applyMaterialCountAdjustments?: (payload: unknown) => Promise<unknown> | unknown;
  saveProjectDraft?: () => Promise<{ saved: boolean; path?: string | null; reason?: string }>;
  confirmProjectSaved?: () => unknown;
}

export type AssistantToolResultStatus = 'completed' | 'approval-required' | 'stub' | 'failed';

export interface AssistantToolResult {
  status: AssistantToolResultStatus;
  summary: string;
  output?: unknown;
  approval?: ApprovalRequest;
  /** Present when status is stub — never invent data from this. */
  stubReason?: string;
  suggestedUserMessage?: string;
}

export interface AssistantToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;
  title: string;
  description: string;
  risk: AssistantToolRisk;
  requiresConfirmation: boolean;
  undoable: boolean;
  schema: TSchema;
  /** Optional verification tool ids to run after an approved write. */
  verifyWith?: string[];
  /** Mark tools that have no real backend yet. */
  isStub?: boolean;
  execute: (
    context: AssistantToolContext,
    input: z.infer<TSchema>
  ) => Promise<AssistantToolResult>;
}

export function toolRequiresApproval(definition: Pick<AssistantToolDefinition, 'risk' | 'requiresConfirmation'>): boolean {
  if (definition.requiresConfirmation) return true;
  return definition.risk === 'write' || definition.risk === 'destructive' || definition.risk === 'external';
}

export function toolAutoRuns(definition: Pick<AssistantToolDefinition, 'risk' | 'requiresConfirmation'>): boolean {
  return !toolRequiresApproval(definition);
}
