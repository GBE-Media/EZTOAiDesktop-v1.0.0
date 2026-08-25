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
  searchCatalogSchema,
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
      "Run maximum-accuracy vision analysis on a document page (detections, typeCounts, locations). "
      + "scope must be exactly one of: 'full', 'viewport', or 'selection' (use 'full' for the entire page — never 'full page'). "
      + 'Expensive — do not re-call for the same page/scope if you already have results (cached responses set cached:true). '
      + 'For "how many / count X" questions prefer count_page_items after one analysis.',
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
    description:
      'Extract native PDF text-layer content, falling back to OCR when the page is scanned. '
      + 'Results are cached per page this session; re-calls return cached text (cached:true) — do not re-extract the same page unnecessarily.',
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
    id: 'count_page_items',
    title: 'Count page items',
    description:
      'Count or filter fixtures/symbols already detected on a page (by type/name query such as "light", "Type A", "receptacle"). '
      + 'Uses a cached broad (unprompted) full-page analysis when available; otherwise runs one broad analyze_page then filters client-side. '
      + 'Prefer this over repeatedly calling analyze_page for counting questions.',
    risk: 'read',
    requiresConfirmation: false,
    undoable: false,
    schema: z.object({
      page: z.number().int().positive(),
      query: z.string().min(1).describe('Fixture/symbol type or name to count, e.g. "light" or "Type A"'),
    }),
    execute: async (context, input) => {
      if (!context.countPageItems) {
        return {
          status: 'failed',
          summary: 'count_page_items adapter is not wired.',
          output: { status: 'unavailable', message: 'count_page_items adapter missing' },
        };
      }
      const output = await context.countPageItems(input);
      const adapterStatus = (output && typeof output === 'object' && 'status' in output)
        ? String((output as { status?: unknown }).status)
        : undefined;
      if (adapterStatus === 'unavailable' || adapterStatus === 'failed') {
        const message = (output && typeof output === 'object' && 'message' in output)
          ? String((output as { message?: unknown }).message || '')
          : '';
        return {
          status: 'failed',
          summary: message || `count_page_items could not count items on page ${input.page}.`,
          output,
        };
      }
      const total = (output && typeof output === 'object' && 'total' in output)
        ? Number((output as { total?: number }).total) || 0
        : 0;
      return {
        status: 'completed',
        summary: `Counted ${total} item(s) matching “${input.query}” on page ${input.page}.`,
        output,
      };
    },
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
    description: 'Read a text summary of products and assemblies available to the user.',
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
    id: 'search_catalog',
    title: 'Search product catalog',
    description:
      'Search the real Products panel catalog by keyword, fixture code, SKU, or category. '
      + 'Returns real productId values with names/paths/units. '
      + 'When noConfidentMatch is true, do NOT invent a productId — place label-only markups '
      + 'and clearly flag “no matching catalog product found” for that type, or ask the user to pick.',
    risk: 'read',
    requiresConfirmation: false,
    undoable: false,
    schema: searchCatalogSchema,
    execute: async (context, input) => {
      const output = context.searchCatalog(input);
      const record = output && typeof output === 'object'
        ? output as { message?: string; noConfidentMatch?: boolean }
        : {};
      return {
        status: 'completed',
        summary: record.message || 'Searched product catalog.',
        output,
      };
    },
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
    description:
      'Place verified document markups (DocPoint coordinates) after user approval. '
      + 'Optional productId on count-marker/measurement rows binds the real catalog product '
      + '(from search_catalog confidentMatches) the same way the Products panel count tool does. '
      + 'Omit productId when search_catalog returns noConfidentMatch.',
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
    description:
      'Attach real catalog productIds to existing markups after user approval '
      + '(same productId + measurement link as the Products panel). '
      + 'Prefer search_catalog first; use place_markups.productId at placement time when possible.',
    undoable: true,
    risk: 'write',
    verifyWith: ['inspect_catalog', 'getMaterialCounts'],
    schema: linkCatalogSchema,
    defaultDescription: 'Link catalog items to markups',
    toApprovalPayload: approvalPayloadFromLinkCatalog,
  }),
  /**
   * Tool-mode handoff for the human (select/measure/stamp/…).
   * Does NOT mutate the document — only switches editorStore.activeTool —
   * so this runs immediately (risk: navigate) without an approval card.
   * Document writes still go through place/update/delete approval gates.
   */
  {
    id: 'activate_editor_tool',
    title: 'Activate editor tool',
    description:
      'Switch the canvas to a specific editor tool mode for the user '
      + '(e.g. measure-length, count, stamp). Does not place or edit markups; '
      + 'runs immediately without approval.',
    risk: 'navigate',
    requiresConfirmation: false,
    undoable: false,
    schema: activateEditorToolSchema,
    execute: async (context, input) => {
      const result = context.activateEditorTool(input.tool) as {
        activated?: boolean;
        tool?: string;
        message?: string;
      } | void;
      if (result && typeof result === 'object' && result.activated === false) {
        return {
          status: 'failed',
          summary: result.message || `Could not activate tool ${input.tool}.`,
          output: result,
        };
      }
      const summary = (result && typeof result === 'object' && result.message)
        ? result.message
        : `Switched to ${input.tool} tool — please use the canvas to continue.`;
      return {
        status: 'completed',
        summary,
        output: result ?? { activated: true, tool: input.tool },
      };
    },
  },
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
