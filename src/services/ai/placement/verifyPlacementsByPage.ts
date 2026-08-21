import type { PlacementMarkup } from '../providers/types';
import { proposalsFromPlacementMarkups } from './proposals';
import type { GeometryAnchor, PageCalibration, PageGeometry, VerificationResult } from './types';
import { verifyMarkupProposal } from './verify';

/**
 * Verify each placement against its own page geometry and anchors.
 * Groups by markup.page so multi-page batches never share a single pageGeom.
 */
export function verifyPlacementMarkupsByPage(options: {
  markups: PlacementMarkup[];
  resolvePageContext: (pageNumber: number) => {
    page: PageGeometry;
    anchors: GeometryAnchor[];
    calibration?: PageCalibration | null;
  };
  enableSnap?: boolean;
}): VerificationResult[] {
  const contextCache = new Map<number, {
    page: PageGeometry;
    anchors: GeometryAnchor[];
    calibration?: PageCalibration | null;
  }>();

  const getContext = (pageNumber: number) => {
    let cached = contextCache.get(pageNumber);
    if (!cached) {
      cached = options.resolvePageContext(pageNumber);
      contextCache.set(pageNumber, cached);
    }
    return cached;
  };

  return options.markups.map((markup, index) => {
    const pageNumber = markup.page || 1;
    const { page, anchors, calibration } = getContext(pageNumber);
    const [proposal] = proposalsFromPlacementMarkups({
      markups: [markup],
      page,
    });
    // Keep stable ids when the source markup omitted one.
    const withId = proposal.id
      ? proposal
      : { ...proposal, id: `proposal_pl_${index}` };
    return verifyMarkupProposal(withId, {
      page,
      anchors,
      calibration: calibration ?? null,
      enableSnap: options.enableSnap !== false,
    });
  });
}
