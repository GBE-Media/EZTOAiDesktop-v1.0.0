import { clampDocRect, isRectInPage, rectCenter, roundTripStable } from './coords';
import { snapProposalToAnchors } from './snap';
import type {
  GeometryAnchor,
  MarkupProposal,
  PageCalibration,
  PageGeometry,
  VerificationIssue,
  VerificationResult,
} from './types';
import { CONFIDENCE_AUTO, CONFIDENCE_REVIEW } from './types';

export interface VerifyContext {
  page: PageGeometry;
  anchors?: GeometryAnchor[];
  calibration?: PageCalibration | null;
  existingRects?: Array<{ x: number; y: number; width: number; height: number }>;
  /** Snap before verifying when anchors provided. */
  enableSnap?: boolean;
  autoThreshold?: number;
  reviewThreshold?: number;
}

/**
 * Verify a markup proposal: bounds, transform stability, optional snap, confidence gates.
 */
export function verifyMarkupProposal(
  proposal: MarkupProposal,
  ctx: VerifyContext,
): VerificationResult {
  const autoThreshold = ctx.autoThreshold ?? CONFIDENCE_AUTO;
  const reviewThreshold = ctx.reviewThreshold ?? CONFIDENCE_REVIEW;
  const issues: VerificationIssue[] = [];

  let working = { ...proposal, boundingBox: { ...proposal.boundingBox } };

  if (ctx.enableSnap !== false && ctx.anchors?.length) {
    const snapped = snapProposalToAnchors(working, ctx.anchors);
    working = snapped.proposal;
  }

  if (!isRectInPage(working.boundingBox, ctx.page, 2)) {
    issues.push({
      code: 'out_of_bounds',
      message: 'Proposal falls outside page bounds',
      severity: 'error',
    });
  }

  working.boundingBox = clampDocRect(working.boundingBox, ctx.page);

  const center = rectCenter(working.boundingBox);
  if (!roundTripStable(center, ctx.page)) {
    issues.push({
      code: 'transform_unstable',
      message: 'Document↔render transform round-trip exceeded epsilon',
      severity: 'error',
    });
  }

  const isMeasurement = /measurement|length|area|scale/i.test(working.markupType);
  if (isMeasurement) {
    const cal = ctx.calibration;
    if (!cal || cal.method === 'none' || !cal.pixelsPerUnit || cal.confidence < 0.5) {
      issues.push({
        code: 'missing_calibration',
        message: 'Measurement placement requires valid page calibration',
        severity: 'warning',
      });
      working = {
        ...working,
        placementMode: 'needs_review',
        confidence: Math.min(working.confidence, reviewThreshold - 0.01),
      };
    }
  }

  if (ctx.existingRects?.length) {
    const duplicate = ctx.existingRects.some(existing => rectsOverlap(working.boundingBox, existing, 0.7));
    if (duplicate) {
      issues.push({
        code: 'duplicate',
        message: 'Proposal overlaps an existing markup substantially',
        severity: 'warning',
      });
      working = {
        ...working,
        confidence: Math.max(0, working.confidence - 0.15),
      };
    }
  }

  // Edge penalty
  const edgeMargin = Math.min(ctx.page.docWidth, ctx.page.docHeight) * 0.02;
  if (
    working.boundingBox.x < edgeMargin
    || working.boundingBox.y < edgeMargin
    || working.boundingBox.x + working.boundingBox.width > ctx.page.docWidth - edgeMargin
    || working.boundingBox.y + working.boundingBox.height > ctx.page.docHeight - edgeMargin
  ) {
    working = { ...working, confidence: Math.max(0, working.confidence - 0.05) };
  }

  if (!working.anchor && working.placementMode === 'estimated') {
    working = { ...working, confidence: Math.max(0, working.confidence - 0.1) };
  }

  if (working.confidence < reviewThreshold) {
    working = { ...working, placementMode: 'needs_review' };
    issues.push({
      code: 'low_confidence',
      message: `Confidence ${working.confidence.toFixed(2)} below review threshold`,
      severity: 'warning',
    });
  } else if (working.confidence < autoThreshold && working.placementMode !== 'needs_review') {
    working = { ...working, placementMode: 'needs_review' };
  }

  const hasError = issues.some(issue => issue.severity === 'error');
  const requiresConfirmation = hasError
    || working.placementMode === 'needs_review'
    || working.confidence < autoThreshold;

  return {
    ok: !hasError,
    proposal: working,
    issues,
    requiresConfirmation,
  };
}

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  iouThreshold: number,
): boolean {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return false;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 && inter / union >= iouThreshold;
}
