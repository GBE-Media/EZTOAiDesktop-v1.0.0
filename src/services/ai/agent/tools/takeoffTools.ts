import { z } from 'zod';
import type { AssistantToolDefinition } from '../../tools/types';
import { createApproval } from '../../tools/registry';

/**
 * Real takeoff / document tools that wrap live app adapters on AssistantToolContext.
 */
export function createTakeoffDomainTools(): AssistantToolDefinition[] {
  return [
    {
      id: 'getProjectContext',
      title: 'Get project context',
      description: 'Read active project, document, page, and path summary.',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({}),
      execute: async context => ({
        status: 'completed',
        summary: 'Read project context.',
        output: context.getProjectContext?.() ?? context.getDocumentContext(),
      }),
    },
    {
      id: 'getTakeoffSummary',
      title: 'Get takeoff summary',
      description: 'Summarize current takeoff markups and counts on the active page/document.',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({}),
      execute: async context => ({
        status: 'completed',
        summary: 'Read takeoff summary.',
        output: context.getTakeoffSummary?.() ?? context.inspectMarkups(),
      }),
    },
    {
      id: 'getMaterialCounts',
      title: 'Get material counts',
      description: 'Read product-linked material/measurement counts from the catalog.',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({}),
      execute: async context => ({
        status: 'completed',
        summary: 'Read material counts.',
        output: context.getMaterialCounts?.() ?? { note: 'No material count adapter wired.' },
      }),
    },
    {
      id: 'getConversationContext',
      title: 'Get conversation context',
      description: 'Read a short slice of recent assistant conversation turns.',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({}),
      execute: async context => ({
        status: 'completed',
        summary: 'Read conversation context.',
        output: context.getConversationContext?.() ?? { turns: [] },
      }),
    },
    {
      id: 'getLayoutSuggestions',
      title: 'Get layout suggestions',
      description: 'Generate layout routing suggestions from current takeoff items (not loaded from a saved store).',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({
        layoutType: z.enum(['conduit', 'homerun', 'duct', 'pipe', 'vent']).optional(),
      }),
      execute: async (context, input) => {
        if (!context.getLayoutSuggestions) {
          return {
            status: 'stub',
            summary: 'Layout suggestion adapter is not wired.',
            stubReason: 'getLayoutSuggestions adapter missing',
            suggestedUserMessage: 'Layout suggestions are unavailable in this session.',
            output: { status: 'stub' },
          };
        }
        const output = await context.getLayoutSuggestions(input);
        return { status: 'completed', summary: 'Generated layout suggestions.', output };
      },
    },
    {
      id: 'getRunSuggestions',
      title: 'Get run suggestions',
      description: 'Generate homerun / run routing suggestions from current takeoff items.',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({
        layoutType: z.enum(['conduit', 'homerun', 'duct', 'pipe', 'vent']).default('homerun'),
      }),
      execute: async (context, input) => {
        if (!context.getRunSuggestions) {
          return {
            status: 'stub',
            summary: 'Run suggestion adapter is not wired.',
            stubReason: 'getRunSuggestions adapter missing',
            suggestedUserMessage: 'Run suggestions are unavailable in this session.',
            output: { status: 'stub' },
          };
        }
        const output = await context.getRunSuggestions(input);
        return { status: 'completed', summary: 'Generated run suggestions.', output };
      },
    },
    {
      id: 'applyMaterialCountAdjustments',
      title: 'Apply material count adjustments',
      description: 'Adjust product-linked measurement counts after user approval.',
      risk: 'write',
      requiresConfirmation: true,
      undoable: true,
      verifyWith: ['getMaterialCounts'],
      schema: z.object({
        payload: z.unknown(),
        description: z.string().min(1),
        preview: z.unknown().optional(),
      }),
      execute: async (context, input) => {
        const definition = {
          id: 'applyMaterialCountAdjustments',
          title: 'Apply material count adjustments',
          undoable: true,
        } as AssistantToolDefinition;
        const approval = createApproval(definition, context, input);
        context.addApproval(approval);
        return {
          status: 'approval-required',
          summary: `Waiting for approval: ${input.description}`,
          approval,
        };
      },
    },
    {
      id: 'saveEstimateDraft',
      title: 'Save project draft',
      description: 'Save the current takeoff project file (mapped as estimate draft in v1). Requires approval.',
      risk: 'external',
      requiresConfirmation: true,
      undoable: false,
      verifyWith: ['confirmEstimateSaved'],
      schema: z.object({
        description: z.string().default('Save the current BidveraAi project draft'),
      }),
      execute: async (context, input) => {
        const definition = {
          id: 'saveEstimateDraft',
          title: 'Save project draft',
          undoable: false,
        } as AssistantToolDefinition;
        const approval = createApproval(definition, context, {
          payload: { action: 'saveProjectDraft' },
          description: input.description,
        });
        context.addApproval(approval);
        return {
          status: 'approval-required',
          summary: `Waiting for approval: ${input.description}`,
          approval,
        };
      },
    },
    {
      id: 'confirmEstimateSaved',
      title: 'Confirm project saved',
      description: 'Verify the last project save status.',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({}),
      execute: async context => ({
        status: 'completed',
        summary: 'Checked save status.',
        output: context.confirmProjectSaved?.() ?? { saved: false, reason: 'No save confirmation adapter.' },
      }),
    },
  ];
}
