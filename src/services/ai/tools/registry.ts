import { z } from 'zod';
import type { ApprovalRequest } from '@/types/assistant';
import type {
  AssistantToolContext,
  AssistantToolDefinition,
  AssistantToolResult,
} from './types';
import { toolRequiresApproval } from './types';

const boundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
}).optional();

const mutationPayloadSchema = z.object({
  payload: z.unknown(),
  description: z.string().min(1),
  preview: z.unknown().optional(),
});
type MutationPayload = {
  payload: unknown;
  description: string;
  preview?: unknown;
};

function coerceMutationInput(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if ('payload' in obj) {
      return {
        payload: obj.payload,
        description: String(obj.description || 'Apply proposed document changes'),
        preview: obj.preview,
      };
    }
    if (obj.markups || obj.callouts || obj.pointers) {
      return {
        payload: obj.markups || obj.callouts || obj.pointers,
        description: String(obj.description || 'Place proposed callouts on the document'),
        preview: obj.preview,
      };
    }
  }
  if (Array.isArray(raw)) {
    return { payload: raw, description: 'Apply proposed document changes' };
  }
  return { payload: raw, description: 'Apply proposed document changes' };
}

export const createApproval = (
  definition: AssistantToolDefinition,
  context: Pick<AssistantToolContext, 'runId' | 'messageId'>,
  input: { payload: unknown; description: string; preview?: unknown }
): ApprovalRequest => ({
  id: `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  runId: context.runId,
  messageId: context.messageId,
  toolId: definition.id,
  title: definition.title,
  description: input.description,
  status: 'pending',
  payload: input.payload,
  preview: input.preview,
  undoable: definition.undoable,
  createdAt: new Date().toISOString(),
});

function createMutationTool(
  id: string,
  title: string,
  undoable: boolean,
  risk: AssistantToolDefinition['risk'] = 'write',
  verifyWith?: string[]
): AssistantToolDefinition {
  const definition: AssistantToolDefinition = {
    id,
    title,
    description: `${title} after user approval.`,
    risk,
    requiresConfirmation: true,
    undoable,
    verifyWith,
    schema: mutationPayloadSchema,
    execute: async (context, rawInput) => {
      const input = mutationPayloadSchema.parse(coerceMutationInput(rawInput)) as MutationPayload;
      const approval = createApproval(definition, context, input);
      context.addApproval(approval);
      return {
        status: 'approval-required',
        summary: `Waiting for approval: ${input.description}`,
        approval,
      };
    },
  };
  return definition;
}

const coreTools: AssistantToolDefinition[] = [
  {
    id: 'get_document_context',
    title: 'Read document context',
    description: 'Read the active document, page, viewport, and selection.',
    risk: 'read',
    requiresConfirmation: false,
    undoable: false,
    schema: z.object({}),
    execute: async context => ({
      status: 'completed',
      summary: 'Read the active document context.',
      output: context.getDocumentContext(),
    }),
  },
  {
    id: 'analyze_page',
    title: 'Analyze page',
    description: 'Run maximum-accuracy analysis on a document page.',
    risk: 'read',
    requiresConfirmation: false,
    undoable: false,
    schema: z.object({
      page: z.number().int().positive(),
      scope: z.enum(['full', 'viewport', 'selection']).default('full'),
      prompt: z.string().optional(),
    }),
    execute: async (context, input) => ({
      status: 'completed',
      summary: `Analyzed page ${input.page}.`,
      output: await context.analyzePage(input),
    }),
  },
  {
    id: 'extract_page_text',
    title: 'Extract page text',
    description: 'Extract native PDF text-layer content, falling back to OCR when the page is scanned.',
    risk: 'read',
    requiresConfirmation: false,
    undoable: false,
    schema: z.object({
      page: z.number().int().positive(),
    }),
    execute: async (context, input) => ({
      status: 'completed',
      summary: `Extracted text from page ${input.page}.`,
      output: await context.extractPageText(input),
    }),
  },
  {
    id: 'search_document',
    title: 'Search document',
    description: 'Search native PDF text and OCR evidence.',
    risk: 'read',
    requiresConfirmation: false,
    undoable: false,
    schema: z.object({ query: z.string().min(1) }),
    execute: async (context, input) => ({
      status: 'completed',
      summary: `Searched the document for “${input.query}”.`,
      output: await context.searchDocument(input.query),
    }),
  },
  {
    id: 'inspect_markups',
    title: 'Inspect markups',
    description: 'Read existing document markups.',
    risk: 'read',
    requiresConfirmation: false,
    undoable: false,
    schema: z.object({}),
    execute: async context => ({
      status: 'completed',
      summary: 'Inspected existing markups.',
      output: context.inspectMarkups(),
    }),
  },
  {
    id: 'inspect_catalog',
    title: 'Inspect catalog',
    description: 'Read products and assemblies available to the user.',
    risk: 'read',
    requiresConfirmation: false,
    undoable: false,
    schema: z.object({}),
    execute: async context => ({
      status: 'completed',
      summary: 'Inspected products and assemblies.',
      output: context.inspectCatalog(),
    }),
  },
  {
    id: 'navigate_page',
    title: 'Open cited page',
    description: 'Navigate the canvas to a cited page and region.',
    risk: 'navigate',
    requiresConfirmation: false,
    undoable: false,
    schema: z.object({ page: z.number().int().positive(), bounds: boundsSchema }),
    execute: async (context, input) => {
      context.navigateToPage(input.page, input.bounds);
      return { status: 'completed', summary: `Opened page ${input.page}.` };
    },
  },
  createMutationTool('place_markups', 'Place document markups', true, 'write', ['inspect_markups']),
  createMutationTool('propose_callouts', 'Propose green callouts', true, 'write', ['inspect_markups']),
  createMutationTool('update_markups', 'Update document markups', true, 'write', ['inspect_markups']),
  createMutationTool('delete_markups', 'Delete document markups', true, 'destructive', ['inspect_markups']),
  createMutationTool('link_catalog', 'Link catalog items', true, 'write', ['inspect_catalog', 'getMaterialCounts']),
  createMutationTool('activate_editor_tool', 'Activate editor tool', false, 'write'),
];

export const assistantToolRegistry = new Map<string, AssistantToolDefinition>(
  coreTools.map(tool => [tool.id, tool])
);

/** Register or replace a tool definition. Prefer calling from agent/tools/registerAll.ts. */
export function registerAssistantTool(definition: AssistantToolDefinition): void {
  assistantToolRegistry.set(definition.id, definition);
}

export function registerAssistantTools(definitions: AssistantToolDefinition[]): void {
  definitions.forEach(registerAssistantTool);
}

export function listAssistantTools(): AssistantToolDefinition[] {
  return Array.from(assistantToolRegistry.values());
}

export function getAssistantTool(toolId: string): AssistantToolDefinition | undefined {
  return assistantToolRegistry.get(toolId);
}

export async function executeAssistantTool(
  toolId: string,
  rawInput: unknown,
  context: AssistantToolContext
): Promise<AssistantToolResult> {
  if (context.signal?.aborted) throw new DOMException('Assistant run cancelled', 'AbortError');
  const tool = assistantToolRegistry.get(toolId);
  if (!tool) {
    return {
      status: 'failed',
      summary: `Unknown assistant tool: ${toolId}`,
      output: { error: 'unknown_tool', toolId },
    };
  }
  try {
    const candidate = tool.requiresConfirmation
      ? coerceMutationInput(rawInput)
      : (rawInput ?? {});
    const input = tool.schema.parse(candidate);
    return await tool.execute(context, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      summary: `Tool ${toolId} failed: ${message}`,
      output: { error: message },
    };
  }
}

export function proposeAssistantMutation(
  toolId: string,
  rawInput: unknown,
  identity: Pick<AssistantToolContext, 'runId' | 'messageId'>
): ApprovalRequest {
  const tool = assistantToolRegistry.get(toolId);
  if (!tool || !toolRequiresApproval(tool)) {
    throw new Error(`Tool ${toolId} is not an approval-gated mutation.`);
  }
  const input = mutationPayloadSchema.parse(coerceMutationInput(rawInput)) as MutationPayload;
  return createApproval(tool, identity, input);
}

export async function executeApprovedAssistantAction(
  approval: ApprovalRequest,
  context: AssistantToolContext
): Promise<unknown> {
  switch (approval.toolId) {
    case 'place_markups':
    case 'propose_callouts':
      return context.placeMarkups(approval.payload);
    case 'update_markups':
      return context.updateMarkups(approval.payload);
    case 'delete_markups':
      return context.deleteMarkups(approval.payload);
    case 'link_catalog':
      return context.linkCatalog(approval.payload);
    case 'activate_editor_tool':
      return context.activateEditorTool(String(approval.payload));
    case 'applyMaterialCountAdjustments':
      if (!context.applyMaterialCountAdjustments) {
        throw new Error('applyMaterialCountAdjustments is not wired.');
      }
      return context.applyMaterialCountAdjustments(approval.payload);
    case 'saveEstimateDraft':
      if (!context.saveProjectDraft) {
        throw new Error('saveEstimateDraft / saveProjectDraft is not wired.');
      }
      return context.saveProjectDraft();
    default:
      throw new Error(`Tool ${approval.toolId} has no approved action executor.`);
  }
}
