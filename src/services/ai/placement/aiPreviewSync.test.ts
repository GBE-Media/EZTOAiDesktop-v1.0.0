import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveMock = vi.fn();
vi.mock('./executePlaceMarkupsApproval', () => ({
  resolvePlaceMarkups: (...args: unknown[]) => resolveMock(...args),
}));

import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import type { ApprovalRequest } from '@/types/assistant';
import type { Document } from '@/types/editor';
import { startAiPreviewSync } from './aiPreviewSync';

function seedDoc(id: string, name: string, width: number, height: number) {
  useCanvasStore.getState().setPdfDocument(id, { id }, 3, width, height);
  const doc: Document = { id, name, path: name, pages: 3, currentPage: 1, zoom: 100, modified: false, markups: [], measurements: [] };
  useEditorStore.getState().addDocument(doc);
}

function approval(id: string, payload: unknown): ApprovalRequest {
  return {
    id,
    runId: 'run-resume',
    messageId: 'm1',
    toolId: 'place_markups',
    title: 'Place markers',
    description: '',
    status: 'pending',
    payload,
    undoable: true,
    createdAt: new Date().toISOString(),
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('AI preview sync', () => {
  let stop: () => void = () => undefined;
  beforeEach(() => {
    useCanvasStore.getState().clearAllDocuments();
    useEditorStore.setState({ documents: [], activeDocument: null });
    useAIChatStore.setState({ approvals: {} });
    resolveMock.mockReset();
    resolveMock.mockResolvedValue({
      ok: true,
      dropped: 0,
      markups: [{ page: 2, markup: { id: 'p1', type: 'count', points: [{ x: 10, y: 10 }] } }],
    });
  });
  afterEach(() => stop());

  it('previews an approval that arrives on the resume path, using the target document size', async () => {
    seedDoc('doc-active', 'A-101.pdf', 612, 792);
    seedDoc('doc-target', 'E-201.pdf', 2592, 1728);
    useCanvasStore.getState().setActiveDocId('doc-active');
    stop = startAiPreviewSync({
      getDefaultStyle: () => ({}) as never,
      getFallbackSize: () => ({ pageWidth: 612, pageHeight: 792 }),
    });
    // Added later (clarification resume / follow-up), not by the drawer's first-turn handler.
    useAIChatStore.getState().addApproval(approval('ap1', { documentId: 'doc-target', page: 2, itemIds: ['a', 'b'] }));
    await flush();
    await flush();
    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(resolveMock.mock.calls[0][0]).toMatchObject({ page: 2, pageWidth: 2592, pageHeight: 1728 });
    expect(useCanvasStore.getState().aiPreview).toMatchObject({ approvalId: 'ap1', docId: 'doc-target' });
  });

  it('clears the preview once the approval is decided', async () => {
    seedDoc('doc-target', 'E-201.pdf', 2592, 1728);
    stop = startAiPreviewSync({
      getDefaultStyle: () => ({}) as never,
      getFallbackSize: () => ({ pageWidth: 612, pageHeight: 792 }),
    });
    useAIChatStore.getState().addApproval(approval('ap2', { documentId: 'doc-target', page: 1, itemIds: ['a'] }));
    await flush();
    await flush();
    expect(useCanvasStore.getState().aiPreview?.approvalId).toBe('ap2');
    useAIChatStore.getState().resolveApproval('ap2', 'rejected');
    expect(useCanvasStore.getState().aiPreview).toBeNull();
  });
});
