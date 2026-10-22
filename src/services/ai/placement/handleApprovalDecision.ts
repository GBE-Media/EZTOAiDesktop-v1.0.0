import type { MarkupStyle } from '@/types/markup';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import type { AssistantToolContext } from '../tools/types';
import { executeApprovedAssistantAction } from '../tools/registry';
import { executePlaceMarkupsApproval } from './executePlaceMarkupsApproval';
import { resumeTaskAfterApproval } from '../agent';

const inFlightApprovals = new Set<string>();

export function resetApprovalInFlightForTests(): void {
  inFlightApprovals.clear();
}

export type ApprovalDecisionDeps = {
  pageWidth: number;
  pageHeight: number;
  defaultStyle: MarkupStyle;
  placementMode?: 'auto' | 'confirm';
  setPipelineStatus: (status: { isRunning: boolean; message: string; progress: number }) => void;
  createEditorToolContext: (runId: string, messageId: string) => AssistantToolContext;
  resumeAfterApproval?: typeof resumeTaskAfterApproval;
};

/**
 * Pure-ish approve/reject orchestrator used by AiChatDrawer.
 * Guards double-clicks with an in-flight set plus approval.executing.
 */
export async function handleApprovalDecision(
  approvalId: string,
  decision: 'approved' | 'rejected',
  deps: ApprovalDecisionDeps,
): Promise<'ignored' | 'handled'> {
  if (inFlightApprovals.has(approvalId)) return 'ignored';
  const store = useAIChatStore.getState();
  const approval = store.approvals[approvalId];
  if (!approval || approval.status !== 'pending' || approval.executing) return 'ignored';

  inFlightApprovals.add(approvalId);
  store.setApprovalExecuting(approvalId, true);

  const resume = deps.resumeAfterApproval || resumeTaskAfterApproval;

  const continueAgent = async (resumeDecision: 'approved' | 'rejected', executionResult?: unknown) => {
    const toolContext = deps.createEditorToolContext(approval.runId, approval.messageId);
    try {
      deps.setPipelineStatus({ isRunning: true, message: 'Continuing assistant…', progress: 60 });
      const orchestrated = await resume({
        runId: approval.runId,
        approval,
        decision: resumeDecision,
        toolContext,
        executionResult,
      });
      const result = orchestrated.agentResult;
      if (!result) return;
      const assistantMessage = result.assistantMessage || 'The assistant could not continue this task.';
      const live = useAIChatStore.getState();
      if (orchestrated.errorCode === 'SESSION_EXPIRED') {
        live.finishRun(approval.runId, 'completed');
        const existing = live.messages.find(message => message.id === approval.messageId);
        const placed = (executionResult as { placed?: number } | undefined)?.placed;
        live.updateMessage(approval.messageId, {
          content: `${existing?.content || ''}\n\n${
            resumeDecision === 'rejected'
              ? 'Callout placement was declined. The document was not changed.'
              : `✓ ${typeof placed === 'number'
                ? `Placed ${placed} callout${placed === 1 ? '' : 's'}`
                : 'Approved action executed'
              }. Use Undo to revert this batch.`
          }`,
          isLoading: false,
        });
        return;
      }
      live.updateMessage(approval.messageId, {
        content: assistantMessage,
        isLoading: false,
        error: result.status === 'failed' ? assistantMessage : undefined,
      });
      if (result.status === 'failed') {
        live.finishRun(approval.runId, 'error', assistantMessage);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const live = useAIChatStore.getState();
      live.updateMessage(approval.messageId, {
        isLoading: false,
        error: errorMessage,
      });
      live.finishRun(approval.runId, 'error', errorMessage);
    } finally {
      deps.setPipelineStatus({ isRunning: false, progress: 0, message: '' });
    }
  };

  try {
    if (decision === 'rejected') {
      useAIChatStore.getState().resolveApproval(approval.id, 'rejected');
      await continueAgent('rejected');
      return 'handled';
    }

    let executionResult: unknown;
    if (approval.toolId === 'place_markups' || approval.toolId === 'propose_callouts') {
      const canvas = useCanvasStore.getState();
      const docId = canvas.activeDocId;
      const pdf = docId ? canvas.pdfDocuments[docId] : null;
      executionResult = await executePlaceMarkupsApproval({
        approval,
        page: canvas.getCurrentPage() || 1,
        pageWidth: pdf?.originalPageWidth || deps.pageWidth,
        pageHeight: pdf?.originalPageHeight || deps.pageHeight,
        defaultStyle: deps.defaultStyle,
        pdfDocument: pdf?.pdfDocument || null,
        placementMode: deps.placementMode,
        addAIMarkupBatch: canvas.addAIMarkupBatch,
        setPendingPlacements: useAIChatStore.getState().setPendingPlacements,
        getPendingPlacements: () => useAIChatStore.getState().pendingPlacements,
      });
    } else {
      const toolContext = deps.createEditorToolContext(approval.runId, approval.messageId);
      executionResult = await executeApprovedAssistantAction(approval, toolContext);
    }

    const placedResult = executionResult && typeof executionResult === 'object'
      ? executionResult as { status?: string; error?: string }
      : undefined;
    const live = useAIChatStore.getState();
    if (placedResult?.status === 'failed') {
      live.resolveApproval(
        approval.id,
        'failed',
        placedResult.error || 'Placement failed',
        placedResult,
      );
    } else {
      live.resolveApproval(
        approval.id,
        'executed',
        placedResult?.status === 'partial' ? placedResult.error : undefined,
        placedResult,
      );
    }

    await continueAgent('approved', executionResult);
    return 'handled';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedResult = { status: 'failed' as const, error: message, placed: 0 };
    useAIChatStore.getState().resolveApproval(approval.id, 'failed', message, failedResult);
    await continueAgent('approved', failedResult);
    return 'handled';
  } finally {
    inFlightApprovals.delete(approvalId);
    const latest = useAIChatStore.getState().approvals[approvalId];
    if (latest?.executing) {
      useAIChatStore.getState().setApprovalExecuting(approvalId, false);
    }
  }
}
