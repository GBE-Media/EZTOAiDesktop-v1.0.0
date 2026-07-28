import { rectCenter } from './coords';
import type { DocPoint, DocRect, GeometryAnchor, MarkupProposal } from './types';

export interface SnapResult {
  proposal: MarkupProposal;
  snapped: boolean;
  anchor?: GeometryAnchor;
  distance: number;
}

/**
 * Snap proposal center to nearest geometry anchor within threshold (document points).
 */
export function snapProposalToAnchors(
  proposal: MarkupProposal,
  anchors: GeometryAnchor[],
  threshold = 18,
): SnapResult {
  const center = rectCenter(proposal.boundingBox);
  let best: GeometryAnchor | undefined;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const anchor of anchors) {
    const point = anchor.point || (anchor.bounds ? rectCenter(anchor.bounds) : null);
    if (!point) continue;
    const dist = distance(center, point);
    if (dist < bestDist) {
      bestDist = dist;
      best = anchor;
    }
  }

  if (!best || !best.point || bestDist > threshold) {
    return { proposal, snapped: false, distance: bestDist };
  }

  const dx = best.point.x - center.x;
  const dy = best.point.y - center.y;
  const boundingBox: DocRect = {
    x: proposal.boundingBox.x + dx,
    y: proposal.boundingBox.y + dy,
    width: proposal.boundingBox.width,
    height: proposal.boundingBox.height,
  };

  return {
    snapped: true,
    anchor: best,
    distance: bestDist,
    proposal: {
      ...proposal,
      boundingBox,
      anchor: { type: best.type, refId: best.id },
      placementMode: proposal.placementMode === 'needs_review' ? 'needs_review' : 'snap_adjusted',
      confidence: Math.min(1, proposal.confidence + 0.08),
      sourceSignals: [...new Set([...proposal.sourceSignals, `snap:${best.type}`])],
      rationale: `${proposal.rationale} Snapped to ${best.type} anchor (${bestDist.toFixed(1)}pt).`.trim(),
    },
  };
}

function distance(a: DocPoint, b: DocPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
