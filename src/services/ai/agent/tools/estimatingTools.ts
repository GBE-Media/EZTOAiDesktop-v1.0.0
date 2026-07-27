import { z } from 'zod';
import type { AssistantToolDefinition } from '../../tools/types';

function stubTool(
  id: string,
  title: string,
  description: string,
  risk: AssistantToolDefinition['risk'] = 'read',
  requiresConfirmation = false
): AssistantToolDefinition {
  return {
    id,
    title,
    description: `${description} [STUB — not available in BidveraAi desktop v1]`,
    risk,
    requiresConfirmation,
    undoable: false,
    isStub: true,
    schema: z.object({}).passthrough(),
    execute: async () => ({
      status: 'stub',
      summary: `${title} is not implemented yet.`,
      stubReason: `No backing store/API for ${id} in this app version.`,
      suggestedUserMessage: `${title} is not available yet. I can help with takeoff markups, material counts, catalog inspection, layout suggestions, or project save instead.`,
      output: {
        status: 'stub',
        reason: `No backing store/API for ${id}`,
        suggestedUserMessage: `${title} is not available yet.`,
      },
    }),
  };
}

/**
 * BidveraAi estimating-domain tools that lack a store today.
 * Handlers return status "stub" — never invent success or estimate data.
 */
export function createEstimatingStubTools(): AssistantToolDefinition[] {
  return [
    stubTool('getCurrentEstimateContext', 'Get current estimate context', 'Read a formal estimate entity (line items, totals, versions).'),
    stubTool('getCodeComplianceStatus', 'Get code compliance status', 'Read persisted code compliance status for the estimate.'),
    stubTool('searchPastEstimates', 'Search past estimates', 'Search historical estimates across projects.'),
    stubTool('getCustomerRequirements', 'Get customer requirements', 'Read customer requirements for the bid.'),
    stubTool('updateEstimateLineItems', 'Update estimate line items', 'Mutate estimate line items.', 'write', true),
    stubTool('saveLayoutSuggestion', 'Save layout suggestion', 'Persist a layout suggestion.', 'write', true),
    stubTool('saveRunSuggestion', 'Save run suggestion', 'Persist a run suggestion.', 'write', true),
    stubTool('updateCodeComplianceNotes', 'Update code compliance notes', 'Persist compliance notes.', 'write', true),
    stubTool('createFollowUpQuestions', 'Create follow-up questions', 'Persist clarifying questions for the estimate.', 'write', true),
    stubTool('createBidSummary', 'Create bid summary', 'Create a formal bid summary artifact.', 'write', true),
    stubTool('assignReviewTask', 'Assign review task', 'Assign a human review workflow task.', 'external', true),
    stubTool('generateClientFacingScopeNotes', 'Generate scope notes', 'Generate client-facing scope notes.', 'write', true),
    stubTool('recalculateEstimateTotals', 'Recalculate estimate totals', 'Run a pricing/totals engine for the estimate.'),
    stubTool('validateEstimateConsistency', 'Validate estimate consistency', 'Validate estimate line items for consistency.'),
    stubTool('verifyCodeCompliance', 'Verify code compliance', 'Run a compliance verification engine.'),
  ];
}
