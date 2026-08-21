import { z } from 'zod';
import type { ApprovalRequest } from '@/types/assistant';
import type {
  AssistantToolContext,
  AssistantToolDefinition,
  AssistantToolResult,
} from './types';
import { toolRequiresApproval } from './types';
import {
  activateEditorToolSchema,
  approvalPayloadFromDeleteMarkups,
  approvalPayloadFromLinkCatalog,
  approvalPayloadFromPlaceMarkups,
  approvalPayloadFromProposeCallouts,
  approvalPayloadFromUpdateMarkups,
  deleteMarkupsSchema,
  linkCatalogSchema,
  placeMarkupsSchema,
  proposeCalloutsSchema,
  updateMarkupsSchema,
} from './mutationSchemas';
import { analyzePageInputSchema } from './analyzePageSchema';

const boundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
}).optional();

export const createApproval = (
  definition: Pick<AssistantToolDefinition, 'id' | 'title' | 'undoable'>,
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

function createTypedMutationTool<TSchema extends z.ZodTypeAny>(options: {
  id: string;
  title: string;
  description: string;
  undoable: boolean;
  risk: AssistantToolDefinition['risk'];
  verifyWith?: string[];
  schema: TSchema;
  toApprovalPayload: (input: z.infer<TSchema>) => unknown;
  defaultDescription: string;
}): AssistantToolDefinition<TSchema> {
  const definition: AssistantToolDefinition<TSchema> = {
    id: options.id,
    title: options.title,
    description: options.description,
    risk: options.risk,
    requiresConfirmation: true,
    undoable: options.undoable,
    verifyWith: options.verifyWith,
    schema: options.schema,
    execute: async (context, rawInput) => {
      const input = options.schema.parse(rawInput) as z.infer<TSchema>;
      const record = (input && typeof input === 'object')
        ? input as { description?: string; preview?: unknown }
        : {};
      const approval = createApproval(definition, context, {
        payload: options.toApprovalPayload(input),
        description: String(record.description || options.defaultDescription),
        preview: record.preview,
      });
      context.addApproval(approval);
      return {
        status: 'approval-required',
        summary: `Waiting for approval: ${approval.description}`,
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
    description:
      "Run maximum-accuracy analysis on a document page. scope must be exactly one of: 'full', 'viewport', or 'selection' (use 'full' for the entire page — never 'full page').",
    risk: 'read',
    requiresConfirmation: false,
    undoable: false,
    schema: analyzePageInputSchema,
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
  createTypedMutationTool({
    id: 'place_markups',
    title: 'Place document markups',
    description: 'Place verified document markups (DocPoint coordinates) after user approval.',
    undoable: true,
    risk: 'write',
    verifyWith: ['inspect_markups'],
    schema: placeMarkupsSchema,
    defaultDescription: 'Place proposed markups on the document',
    toApprovalPayload: approvalPayloadFromPlaceMarkups,
  }),
  createTypedMutationTool({
    id: 'propose_callouts',
    title: 'Propose green callouts',
    description: 'Propose numbered green callouts (ChatMarkupPointer DocPoints) after user approval.',
    undoable: true,
    risk: 'write',
    verifyWith: ['inspect_markups'],
    schema: proposeCalloutsSchema,
    defaultDescription: 'Propose green callouts on the document',
    toApprovalPayload: approvalPayloadFromProposeCallouts,
  }),
  createTypedMutationTool({
    id: 'update_markups',
    title: 'Update document markups',
    description: 'Update existing markups by id after user approval.',
    undoable: true,
    risk: 'write',
    verifyWith: ['inspect_markups'],
    schema: updateMarkupsSchema,
    defaultDescription: 'Update document markups',
    toApprovalPayload: approvalPayloadFromUpdateMarkups,
  }),
  createTypedMutationTool({
    id: 'delete_markups',
    title: 'Delete document markups',
    description: 'Delete markups by id after user approval.',
    undoable: true,
    risk: 'destructive',
    verifyWith: ['inspect_markups'],
    schema: deleteMarkupsSchema,
    defaultDescription: 'Delete document markups',
    toApprovalPayload: approvalPayloadFromDeleteMarkups,
  }),
  createTypedMutationTool({
    id: 'link_catalog',
    title: 'Link catalog items',
    description: 'Link markups to catalog products after user approval.',
    undoable: true,
    risk: 'write',
    verifyWith: ['inspect_catalog', 'getMaterialCounts'],
    schema: linkCatalogSchema,
    defaultDescription: 'Link catalog items to markups',
    toApprovalPayload: approvalPayloadFromLinkCatalog,
  }),
  createTypedMutationTool({
    id: 'activate_editor_tool',
    title: 'Activate editor tool',
    description: 'Activate a canvas editor tool after user approval.',
    undoable: false,
    risk: 'write',
    schema: activateEditorToolSchema,
    defaultDescription: 'Activate editor tool',
    toApprovalPayload: (input) => input.tool,
  }),
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
    const input = tool.schema.parse(rawInput ?? {});
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
  const input = tool.schema.parse(rawInput ?? {});
  const record = (input && typeof input === 'object')
    ? input as Record<string, unknown>
    : {};

  let payload: unknown = input;
  if (toolId === 'place_markups') {
    payload = approvalPayloadFromPlaceMarkups(input as z.infer<typeof placeMarkupsSchema>);
  } else if (toolId === 'propose_callouts') {
    payload = approvalPayloadFromProposeCallouts(input as z.infer<typeof proposeCalloutsSchema>);
  } else if (toolId === 'update_markups') {
    payload = approvalPayloadFromUpdateMarkups(input as z.infer<typeof updateMarkupsSchema>);
  } else if (toolId === 'delete_markups') {
    payload = approvalPayloadFromDeleteMarkups(input as z.infer<typeof deleteMarkupsSchema>);
  } else if (toolId === 'link_catalog') {
    payload = approvalPayloadFromLinkCatalog(input as z.infer<typeof linkCatalogSchema>);
  } else if (toolId === 'activate_editor_tool') {
    payload = (input as z.infer<typeof activateEditorToolSchema>).tool;
  } else if ('payload' in record) {
    payload = record.payload;
  }

  return createApproval(tool, identity, {
    payload,
    description: String(record.description || tool.title),
    preview: record.preview,
  });
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
