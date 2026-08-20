import { describe, expect, it } from 'vitest';
import { createPageGeometry } from './coords';
import { verifyMarkupProposal } from './verify';
import type { MarkupProposal } from './types';

const page = createPageGeometry({
  pageNumber: 1,
  docWidth: 1000,
  docHeight: 800,
});

function proposal(overrides: Partial<MarkupProposal> = {}): MarkupProposal {
  return {
    id: 'p1',
    pageNumber: 1,
    markupType: 'callout',
    boundingBox: { x: 100, y: 100, width: 40, height: 30 },
    confidence: 0.9,
    placementMode: 'exact',
    rationale: 'test',
    sourceSignals: ['unit'],
    ...overrides,
  };
}

describe('verifyMarkupProposal', () => {
  it('accepts in-bounds high-confidence proposals', () => {
    const result = verifyMarkupProposal(proposal(), { page, enableSnap: false });
    expect(result.ok).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
  });

  it('rejects out-of-bounds proposals', () => {
    const result = verifyMarkupProposal(
      proposal({ boundingBox: { x: 990, y: 10, width: 80, height: 20 } }),
      { page, enableSnap: false },
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some(issue => issue.code === 'out_of_bounds')).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  it('snaps to nearby anchors and marks snap_adjusted', () => {
    const result = verifyMarkupProposal(
      proposal({
        boundingBox: { x: 95, y: 95, width: 20, height: 20 },
        confidence: 0.7,
        placementMode: 'estimated',
      }),
      {
        page,
        enableSnap: true,
        anchors: [{
          id: 'a1',
          type: 'endpoint',
          point: { x: 100, y: 100 },
          confidence: 0.9,
          source: 'pdf_vector',
        }],
      },
    );
    expect(result.proposal.placementMode).toBe('snap_adjusted');
    expect(result.proposal.anchor?.refId).toBe('a1');
  });

  it('adjusts boundingBox toward a nearby anchor when enableSnap is true', () => {
    // Center at (100, 105); snap point at (100, 100) → dy -5, box moves to y=90.
    const raw = proposal({
      boundingBox: { x: 90, y: 95, width: 20, height: 20 },
      confidence: 0.7,
      placementMode: 'estimated',
    });
    const result = verifyMarkupProposal(raw, {
      page,
      enableSnap: true,
      anchors: [{
        id: 'snap-target',
        type: 'endpoint',
        point: { x: 100, y: 100 },
        confidence: 0.9,
        source: 'pdf_vector',
      }],
    });

    expect(result.proposal.boundingBox).toEqual({ x: 90, y: 90, width: 20, height: 20 });
    expect(result.proposal.boundingBox).not.toEqual(raw.boundingBox);
    expect(result.proposal.placementMode).toBe('snap_adjusted');
    expect(result.proposal.sourceSignals.some(signal => signal.startsWith('snap:'))).toBe(true);
  });

  it('does not invent a snap when enableSnap is true but no anchors are provided', () => {
    const raw = proposal({ boundingBox: { x: 90, y: 95, width: 20, height: 20 } });
    const result = verifyMarkupProposal(raw, { page, enableSnap: true, anchors: [] });
    expect(result.proposal.boundingBox).toEqual(raw.boundingBox);
    expect(result.proposal.placementMode).not.toBe('snap_adjusted');
  });

  it('forces needs_review for low confidence', () => {
    const result = verifyMarkupProposal(
      proposal({ confidence: 0.3, placementMode: 'estimated' }),
      { page, enableSnap: false },
    );
    expect(result.proposal.placementMode).toBe('needs_review');
    expect(result.requiresConfirmation).toBe(true);
  });

  it('marks mid-confidence as estimated needing confirmation, not needs_review', () => {
    const result = verifyMarkupProposal(
      proposal({ confidence: 0.6, placementMode: 'exact' }),
      { page, enableSnap: false },
    );
    expect(result.proposal.placementMode).toBe('estimated');
    expect(result.requiresConfirmation).toBe(true);
    expect(result.proposal.placementMode).not.toBe('needs_review');
  });

  it('auto-commits high confidence without requiring confirmation', () => {
    const result = verifyMarkupProposal(
      proposal({ confidence: 0.9, placementMode: 'exact' }),
      { page, enableSnap: false },
    );
    expect(result.requiresConfirmation).toBe(false);
    expect(result.proposal.placementMode).not.toBe('needs_review');
  });
});
