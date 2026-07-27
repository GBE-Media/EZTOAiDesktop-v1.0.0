import type { AssistantToolContext, AssistantToolResult } from '../tools/types';
import { executeAssistantTool, getAssistantTool } from '../tools/registry';
import { emitAgentTrace } from './trace';

export async function runVerificationTools(
  toolId: string,
  context: AssistantToolContext
): Promise<AssistantToolResult[]> {
  const definition = getAssistantTool(toolId);
  const verifyIds = definition?.verifyWith || [];
  if (verifyIds.length === 0) return [];

  const results: AssistantToolResult[] = [];
  for (const verifyId of verifyIds) {
    emitAgentTrace(context.runId, 'tool_selected', { toolId: verifyId, purpose: 'verification' });
    const result = await executeAssistantTool(verifyId, {}, context);
    emitAgentTrace(context.runId, 'tool_result', { toolId: verifyId, status: result.status, summary: result.summary });
    results.push(result);
  }
  return results;
}

/** Built-in verification helpers for BidveraAi naming (may map to other tools). */
export async function recalculateEstimateTotalsStub(context: AssistantToolContext): Promise<AssistantToolResult> {
  return executeAssistantTool('recalculateEstimateTotals', {}, context);
}

export async function confirmEstimateSavedViaContext(context: AssistantToolContext): Promise<AssistantToolResult> {
  if (context.confirmProjectSaved) {
    return {
      status: 'completed',
      summary: 'Checked project save status.',
      output: context.confirmProjectSaved(),
    };
  }
  return executeAssistantTool('confirmEstimateSaved', {}, context);
}
