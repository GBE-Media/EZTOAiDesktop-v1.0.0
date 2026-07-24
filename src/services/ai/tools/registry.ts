import { z } from 'zod';
import type { ApprovalRequest } from '@/types/assistant';
import type {
  AssistantToolContext,
  AssistantToolDefinition,
  AssistantToolResult,
} from './types';

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

const createApproval = (
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

const tools: AssistantToolDefinition[] = [
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
  ...([
    ['place_markups', 'Place document markups', true],
    ['update_markups', 'Update document markups', true],
    ['delete_markups', 'Delete document markups', true],
    ['link_catalog', 'Link catalog items', true],
    ['activate_editor_tool', 'Activate editor tool', false],
  ] as const).map(([id, title, undoable]): AssistantToolDefinition => {
    const definition: AssistantToolDefinition = {
      id,
      title,
      description: `${title} after user approval.`,
      risk: 'mutate',
      requiresConfirmation: true,
      undoable,
      schema: mutationPayloadSchema,
      execute: async (context, rawInput) => {
        const input = mutationPayloadSchema.parse(rawInput);
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
  }),
];

export const assistantToolRegistry = new Map(tools.map(tool => [tool.id, tool]));

export async function executeAssistantTool(
  toolId: string,
  rawInput: unknown,
  context: AssistantToolContext
): Promise<AssistantToolResult> {
  if (context.signal?.aborted) throw new DOMException('Assistant run cancelled', 'AbortError');
  const tool = assistantToolRegistry.get(toolId);
  if (!tool) throw new Error(`Unknown assistant tool: ${toolId}`);
  const input = tool.schema.parse(rawInput);
  return tool.execute(context, input);
}

export function proposeAssistantMutation(
  toolId: string,
  rawInput: unknown,
  identity: Pick<AssistantToolContext, 'runId' | 'messageId'>
): ApprovalRequest {
  const tool = assistantToolRegistry.get(toolId);
  if (!tool || tool.risk !== 'mutate' || !tool.requiresConfirmation) {
    throw new Error(`Tool ${toolId} is not an approval-gated mutation.`);
  }
  const input = mutationPayloadSchema.parse(rawInput);
  return createApproval(tool, identity, input);
}

export async function executeApprovedAssistantAction(
  approval: ApprovalRequest,
  context: AssistantToolContext
): Promise<unknown> {
  switch (approval.toolId) {
    case 'place_markups':
      return context.placeMarkups(approval.payload);
    case 'update_markups':
      return context.updateMarkups(approval.payload);
    case 'delete_markups':
      return context.deleteMarkups(approval.payload);
    case 'link_catalog':
      return context.linkCatalog(approval.payload);
    case 'activate_editor_tool':
      return context.activateEditorTool(String(approval.payload));
    default:
      throw new Error(`Tool ${approval.toolId} has no approved action executor.`);
  }
}
