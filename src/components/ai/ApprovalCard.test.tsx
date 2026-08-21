import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalCardView, formatApprovalPreview } from './ApprovalCard';
import type { ApprovalRequest } from '@/types/assistant';

const baseApproval: ApprovalRequest = {
  id: 'approval-preview-1',
  runId: 'run-1',
  messageId: 'msg-1',
  toolId: 'place_markups',
  title: 'Place document markups',
  description: 'Place two verified green callouts',
  status: 'pending',
  payload: [],
  undoable: true,
  createdAt: new Date().toISOString(),
};

describe('formatApprovalPreview', () => {
  it('formats the common count/pages preview shape', () => {
    expect(formatApprovalPreview({ count: 2, pages: [2, 3] })).toBe('2 markups on pages 2, 3');
  });

  it('returns null for empty/absent preview', () => {
    expect(formatApprovalPreview(undefined)).toBeNull();
    expect(formatApprovalPreview(null)).toBeNull();
    expect(formatApprovalPreview({})).toBeNull();
    expect(formatApprovalPreview([])).toBeNull();
  });
});

describe('ApprovalCard preview', () => {
  it('renders populated approval.preview content', () => {
    const html = renderToStaticMarkup(
      <ApprovalCardView
        approval={{
          ...baseApproval,
          preview: { count: 2, pages: [2] },
        }}
      />,
    );
    expect(html).toContain('data-testid="approval-preview"');
    expect(html).toContain('2 markups on page 2');
    expect(html).toContain('Preview');
  });

  it('omits the preview section when preview is absent', () => {
    const html = renderToStaticMarkup(<ApprovalCardView approval={baseApproval} />);
    expect(html).toContain('Place document markups');
    expect(html).not.toContain('data-testid="approval-preview"');
    expect(html).not.toContain('>Preview<');
  });
});
