import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalCardView, formatApprovalPreview, formatExecutionSummary } from './ApprovalCard';
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

  it('renders error text on failure with a copy control', () => {
    const html = renderToStaticMarkup(
      <ApprovalCardView
        approval={{
          ...baseApproval,
          status: 'failed',
          error: '0 of 26 markers had usable coordinates (row 1: no point/points)',
        }}
      />,
    );
    expect(html).toContain('data-testid="approval-error"');
    expect(html).toContain('0 of 26 markers had usable coordinates');
    expect(html).toContain('Copy');
  });

  it('renders an execution summary on success including dropped rows', () => {
    const html = renderToStaticMarkup(
      <ApprovalCardView
        approval={{
          ...baseApproval,
          status: 'executed',
          executionResult: {
            status: 'partial',
            placed: 25,
            autoCommitted: 25,
            needsConfirmation: 0,
            reviewQueued: 0,
            dropped: [{ index: 0, reason: 'no point/points' }],
          },
        }}
      />,
    );
    expect(html).toContain('data-testid="approval-result"');
    expect(html).toContain('placed 25');
    expect(html).toContain('dropped 1');
    expect(html).toContain('row 1: no point/points');
    expect(html).toContain('data-testid="approval-dropped"');
  });

  it('disables approve while executing and does not repeat the failure reason', () => {
    const html = renderToStaticMarkup(
      <ApprovalCardView
        approval={{
          ...baseApproval,
          executing: true,
        }}
      />,
    );
    expect(html).toMatch(/disabled/);
    expect(html).toContain('Placing');

    const summary = formatExecutionSummary({
      status: 'failed',
      placed: 0,
      error: '0 of 26 markers had usable coordinates (row 1: no point/points)',
      dropped: [
        { index: 0, reason: 'no point/points' },
        { index: 0, reason: 'no point/points' },
        { itemId: 'a1', reason: 'not in cached page analysis' },
      ],
    });
    expect(summary).not.toContain('0 of 26 markers');
    expect(summary).toContain('dropped 3');
  });

  it('omits the preview section when preview is absent', () => {
    const html = renderToStaticMarkup(<ApprovalCardView approval={baseApproval} />);
    expect(html).toContain('Place document markups');
    expect(html).not.toContain('data-testid="approval-preview"');
    expect(html).not.toContain('>Preview<');
  });
});
