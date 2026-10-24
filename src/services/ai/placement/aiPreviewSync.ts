import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import type { ApprovalRequest } from '@/types/assistant';
import type { MarkupStyle } from '@/types/markup';
import { resolveApprovalTarget } from './approvalTarget';
import { resolvePlaceMarkups } from './executePlaceMarkupsApproval';
import { setLiveAiPreview } from './aiPreview';

const PREVIEW_TOOLS = new Set(['place_markups', 'propose_callouts']);

export type AiPreviewSyncDeps = {
  getDefaultStyle: () => MarkupStyle;
  getFallbackSize: () => { pageWidth: number; pageHeight: number };
};

/** Build and show the live preview for one pending approval (exactly what Approve would place). */
export async function previewApproval(approval: ApprovalRequest, deps: AiPreviewSyncDeps): Promise<boolean> {
  const target = resolveApprovalTarget(approval, deps.getFallbackSize());
  if ('error' in target) return false;
  const pdf = useCanvasStore.getState().pdfDocuments[target.docId];
  const resolved = await resolvePlaceMarkups({
    approval,
    page: target.page,
    pageWidth: target.pageWidth,
    pageHeight: target.pageHeight,
    defaultStyle: deps.getDefaultStyle(),
    pdfDocument: pdf?.pdfDocument || null,
  });
  if ('failure' in resolved || resolved.markups.length === 0) return false;
  // The approval may have been decided while we were resolving.
  if (useAIChatStore.getState().approvals[approval.id]?.status !== 'pending') return false;
  setLiveAiPreview({ approvalId: approval.id, docId: target.docId, markups: resolved.markups });
  return true;
}

/**
 * Keep the canvas preview in sync with pending markup approvals from ANY path
 * (first turn, clarification resume, follow-up reply, approval continuation).
 */
export function startAiPreviewSync(deps: AiPreviewSyncDeps): () => void {
  let inFlight: string | null = null;
  const sync = (approvals: Record<string, ApprovalRequest>) => {
    const preview = useCanvasStore.getState().aiPreview;
    if (preview && approvals[preview.approvalId]?.status !== 'pending') {
      useCanvasStore.getState().clearAiPreview();
    }
    const pending = Object.values(approvals)
      .filter(approval => approval.status === 'pending' && PREVIEW_TOOLS.has(approval.toolId))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (!pending) return;
    const current = useCanvasStore.getState().aiPreview;
    if (current?.approvalId === pending.id || inFlight === pending.id) return;
    inFlight = pending.id;
    void previewApproval(pending, deps).finally(() => {
      if (inFlight === pending.id) inFlight = null;
    });
  };
  sync(useAIChatStore.getState().approvals);
  return useAIChatStore.subscribe((state, prev) => {
    if (state.approvals !== prev.approvals) sync(state.approvals);
  });
}
