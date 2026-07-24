import type { z } from 'zod';
import type { ApprovalRequest, EvidenceCitation } from '@/types/assistant';

export type AssistantToolRisk = 'read' | 'navigate' | 'mutate';

export interface AssistantToolContext {
  runId: string;
  messageId: string;
  signal?: AbortSignal;
  getDocumentContext: () => unknown;
  analyzePage: (input: unknown) => Promise<unknown>;
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
}

export interface AssistantToolResult {
  status: 'completed' | 'approval-required';
  summary: string;
  output?: unknown;
  approval?: ApprovalRequest;
}

export interface AssistantToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;
  title: string;
  description: string;
  risk: AssistantToolRisk;
  requiresConfirmation: boolean;
  undoable: boolean;
  schema: TSchema;
  execute: (
    context: AssistantToolContext,
    input: z.infer<TSchema>
  ) => Promise<AssistantToolResult>;
}
