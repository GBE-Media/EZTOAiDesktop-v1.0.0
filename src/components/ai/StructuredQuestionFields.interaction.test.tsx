// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/integrations/external-auth/client', () => ({ externalAuthClient: {} }));
vi.mock('@/lib/openCitation', () => ({ openAssistantFocus: vi.fn() }));
vi.mock('@/services/ai/placement/cachedCountMarkers', () => ({ ensureCachedPageGeometry: vi.fn(async () => undefined) }));
import { StructuredQuestionFields } from './StructuredQuestionFields';
import { useCanvasStore } from '@/store/canvasStore';
import { useDrawingPickStore } from '@/store/drawingPickStore';
import type { ClarificationRequest } from '@/types/assistant';

const card: ClarificationRequest = {
  id: 'card', runId: 'run', messageId: 'message', stepKey: 'runs', status: 'pending',
  question: 'Place the panels', options: [], createdAt: new Date().toISOString(),
  fields: [
    { id: 'a', kind: 'point', prompt: 'Where is A?', documentId: 'doc', page: 4,
      options: [{ id: 'off', label: 'On another sheet', value: 'flag:offSheet' }] },
    { id: 'b', kind: 'point', prompt: 'Where is B?', documentId: 'doc', page: 4 },
    { id: 'keep', kind: 'area', prompt: 'Keep clear', documentId: 'doc', page: 4, optional: true },
  ],
};
const clickPoint = (key: string, x = 25) => act(() => {
  useDrawingPickStore.getState().start({ key, label: key, documentId: 'doc', page: 4 });
  useDrawingPickStore.getState().complete({ documentId: 'doc', page: 4, xPct: x, yPct: 65 });
});
beforeEach(() => {
  useDrawingPickStore.setState({ request: null, pins: {}, areas: {} });
  useCanvasStore.setState({ activeDocId: 'doc', pdfDocuments: { doc: { currentPage: 4 } } } as never);
});
afterEach(cleanup);

describe('live drawing-card interactions', () => {
  it('redo, cancel and off-sheet selection cannot be overwritten by an old pin', () => {
    const listener = vi.fn();
    window.addEventListener('bidveraai:clarification', listener);
    render(<StructuredQuestionFields clarification={card} />);
    clickPoint('card:a');
    fireEvent.click(screen.getByText('Redo'));
    expect(useDrawingPickStore.getState().pins['card:a']).toBeUndefined();
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('On another sheet'));
    // Picking another field used to re-copy the old A pin over the off-sheet answer.
    clickPoint('card:b', 75);
    fireEvent.click(screen.getByText('Continue'));
    const detail = (listener.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.fields.a).toEqual({ value: 'flag:offSheet', label: 'On another sheet' });
    expect(detail.fields.b.point.xPct).toBe(75);
    expect(detail.fields.keep.areas).toEqual([]);
    expect(useDrawingPickStore.getState().pins).toEqual({});
    window.removeEventListener('bidveraai:clarification', listener);
  });

  it('requires finishing area mode before Continue and cancels it on unmount', () => {
    const { unmount } = render(<StructuredQuestionFields clarification={card} />);
    clickPoint('card:a'); clickPoint('card:b');
    fireEvent.click(screen.getByText('Mark on drawing'));
    expect((screen.getByText('Continue') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Done'));
    expect((screen.getByText('Continue') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('Mark on drawing'));
    unmount();
    expect(useDrawingPickStore.getState().request).toBeNull();
  });

  it('does not redirect a closed document card to the current document', () => {
    useCanvasStore.setState({ activeDocId: 'other', pdfDocuments: { other: {} } } as never);
    render(<StructuredQuestionFields clarification={card} />);
    fireEvent.click(screen.getAllByText('Show me on the drawing')[0]);
    expect(useDrawingPickStore.getState().request).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Reopen the drawing');
  });

  it('ends drawing mode when the card is resolved outside its Continue button', () => {
    const { rerender } = render(<StructuredQuestionFields clarification={card} />);
    fireEvent.click(screen.getByText('Mark on drawing'));
    expect(useDrawingPickStore.getState().request).not.toBeNull();
    rerender(<StructuredQuestionFields clarification={{ ...card, status: 'answered' }} />);
    expect(useDrawingPickStore.getState().request).toBeNull();
  });
});
