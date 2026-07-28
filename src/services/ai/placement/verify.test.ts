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

  it('forces needs_review for low confidence', () => {
    const result = verifyMarkupProposal(
      proposal({ confidence: 0.3, placementMode: 'estimated' }),
      { page, enableSnap: false },
    );
    expect(result.proposal.placementMode).toBe('needs_review');
    expect(result.requiresConfirmation).toBe(true);
  });
});
