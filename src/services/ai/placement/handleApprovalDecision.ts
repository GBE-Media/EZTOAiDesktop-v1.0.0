import type { CanvasMarkup } from '@/types/markup';
import { offerAfterPlacement } from '@/lib/nextStepOffer';
import type { MarkupStyle } from '@/types/markup';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import type { AssistantToolContext } from '../tools/types';
import { executeApprovedAssistantAction } from '../tools/registry';
import { executePlaceMarkupsApproval } from './executePlaceMarkupsApproval';
import { bindTakeoffProducts, describeBoundProducts, type BoundProduct } from '../catalog/bindTakeoffProducts';
import { resumeTaskAfterApproval } from '../agent';
import { resolveApprovalTarget, suggestedRunMarkups } from './approvalTarget';
import { runInputSnapshot } from '../runs/runInputSnapshot';

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
      } else if (result.status === 'completed' && resumeDecision === 'approved') {
        // Guided next step: placed count markers → offer suggested runs.
        const placed = (executionResult as { placed?: number } | undefined)?.placed;
        const payload = (approval.payload || {}) as { page?: number; analysisRef?: { page?: number } };
        const offer = offerAfterPlacement({
          approvalToolId: approval.toolId,
          placed,
          page: payload.page || payload.analysisRef?.page,
          history: result.toolHistory as Parameters<typeof offerAfterPlacement>[0]['history'],
          trade: useAIChatStore.getState().selectedTrade,
        });
        if (offer) {
          live.addMessageBlock(approval.messageId, {
            id: `block_followup_runs_${approval.id}`,
            type: 'follow-up',
            messageId: approval.messageId,
            question: offer.question,
            options: offer.options,
          });
        }
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
      useCanvasStore.getState().clearAiPreview();
      useAIChatStore.getState().resolveApproval(approval.id, 'rejected');
      await continueAgent('rejected');
      return 'handled';
    }

    let executionResult: unknown;
    if (approval.toolId === 'place_markups' || approval.toolId === 'propose_callouts') {
      const canvas = useCanvasStore.getState();
      const target = resolveApprovalTarget(approval, { pageWidth: deps.pageWidth, pageHeight: deps.pageHeight });
      if ('error' in target) {
        useCanvasStore.getState().clearAiPreview();
        const failedResult = { status: 'failed' as const, error: target.error, placed: 0 };
        useAIChatStore.getState().resolveApproval(approval.id, 'failed', target.error, failedResult);
        await continueAgent('approved', failedResult);
        return 'handled';
      }
      const docId = target.docId;
      if (canvas.pdfDocuments[docId] && docId !== canvas.activeDocId) {
        canvas.setActiveDocId(docId);
        useEditorStore.getState().setActiveDocument(docId);
      }
      const pdf = canvas.pdfDocuments[docId];
      executionResult = await executePlaceMarkupsApproval({
        approval,
        page: target.page,
        pageWidth: target.pageWidth,
        pageHeight: target.pageHeight,
        defaultStyle: deps.defaultStyle,
        pdfDocument: pdf?.pdfDocument || null,
        placementMode: deps.placementMode,
        addAIMarkupBatch: canvas.addAIMarkupBatch,
        setPendingPlacements: useAIChatStore.getState().setPendingPlacements,
        getPendingPlacements: () => useAIChatStore.getState().pendingPlacements,
      });
      useCanvasStore.getState().clearAiPreview();
    } else if (approval.toolId === 'suggest_runs') {
      executionResult = placeSuggestedRuns(approval);
      useCanvasStore.getState().clearAiPreview();
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

/** Commit an approved suggested-run overlay to its document (one undo step). */
export function placeSuggestedRuns(approval: Parameters<typeof suggestedRunMarkups>[0]): { status: 'completed' | 'partial' | 'failed'; placed: number; error?: string; coverage?: import('../runs/runCoverage').RunCoverage; products?: BoundProduct[]; productsSummary?: string } {
  const rows = suggestedRunMarkups(approval);
  if ('error' in rows) return { status: 'failed', placed: 0, error: rows.error };
  const payload = approval.payload as { inputSnapshot?: string; page?: number; legacyUpgradeIds?: string[]; coverage?: import('../runs/runCoverage').RunCoverage } | undefined;
  const snapshot = payload?.inputSnapshot;
  const inputPage = Number(payload?.page);
  const legacyUpgrades = new Set(Array.isArray(payload?.legacyUpgradeIds) ? payload.legacyUpgradeIds : []);
  if (typeof snapshot === 'string' && snapshot !== runInputSnapshot(
    useCanvasStore.getState().pdfDocuments[rows.docId]?.markupsByPage[inputPage] || [],
  )) return { status: 'failed', placed: 0, error: 'The panel locations, keep-clear zones or count markers changed after this preview. Regenerate the suggested runs before placing them; the current layout was left unchanged.' };
  // Each run's footage goes to a product (conduit + wire / cable per foot as components).
  const markups = rows.markups.map(row => ({ page: row.page, markup: { ...row.markup } as CanvasMarkup }));
  const products = bindTakeoffProducts(markups);
  const canvas = useCanvasStore.getState();
  if (rows.docId !== canvas.activeDocId) {
    canvas.setActiveDocId(rows.docId);
    useEditorStore.getState().setActiveDocument(rows.docId);
  }
  // A new layout replaces the previous suggested runs on that page (no stacked duplicates).
  // Keep-clear zones and user-placed panels stay locked where the user put them.
  const pages = [...new Set(markups.map(m => m.page))];
  const replaceIdsByPage: Record<number, string[]> = {};
  for (const page of pages) {
    const state = useCanvasStore.getState();
    const old = (state.getMarkupsByPage(rows.docId)[page] || [])
      // The user's keep-clear zones and the panels they clicked stay exactly where they are.
      .filter(m => m.aiRun && ((m.aiRun.kind !== 'keepout' && !m.aiRun.userPlaced)
        // Saved by an older version in the wrong frame: swapped for the re-saved copy in this batch.
        || (page === inputPage && legacyUpgrades.has(m.id))))
      .map(m => m.id);
    replaceIdsByPage[page] = old;
  }
  const result = useCanvasStore.getState().addAIMarkupBatch(markups, false, { documentId: rows.docId, replaceIdsByPage });
  if (!result.ok) return { status: 'failed', placed: 0, error: result.reason || 'Could not place runs' };
  return {
    status: payload?.coverage && !payload.coverage.complete ? 'partial' : 'completed',
    placed: result.placed,
    ...(payload?.coverage ? {
      coverage: payload.coverage,
      ...(!payload.coverage.complete ? { error: `Partial layout placed: ${payload.coverage.connected}/${payload.coverage.total} counts connected; ${payload.coverage.unresolved} remain unresolved. Do not report this layout as complete.` } : {}),
    } : {}),
    ...(products.length ? { products, productsSummary: describeBoundProducts(products) } : {}),
  };
}
