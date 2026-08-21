import type { ChatMarkupPointer, PlacementMarkup } from '../providers/types';
import { createPageGeometry } from './coords';
import type { MarkupProposal, PageGeometry } from './types';

/**
 * Convert DocPoint chat pointers into document-space markup proposals.
 */
export function proposalsFromChatPointers(options: {
  pointers: ChatMarkupPointer[];
  page: PageGeometry;
  markupType?: string;
}): MarkupProposal[] {
  const page = createPageGeometry(options.page);
  return options.pointers.map((pointer, index) => {
    const ref = pointer.ref || index + 1;
    const boundingBox = pointer.bounds
      ? { ...pointer.bounds }
      : (() => {
        const center = pointer.point;
        const size = Math.min(page.docWidth, page.docHeight) * 0.04;
        return {
          x: center.x - size / 2,
          y: center.y - size / 2,
          width: size,
          height: size,
        };
      })();

    const confidence = typeof pointer.confidence === 'number'
      ? clamp01(pointer.confidence)
      : 0.55;

    return {
      id: `proposal_ptr_${ref}`,
      pageNumber: page.pageNumber,
      markupType: options.markupType || pointer.type || 'callout',
      boundingBox,
      confidence,
      placementMode: confidence >= 0.75 ? 'exact' : confidence >= 0.45 ? 'estimated' : 'needs_review',
      rationale: pointer.note || pointer.label || `Pointer [${ref}]`,
      sourceSignals: ['chat_pointer', pointer.bounds ? 'bounds' : 'point'],
    };
  });
}

/**
 * Convert pipeline PlacementMarkup points (assumed document points) into proposals.
 */
export function proposalsFromPlacementMarkups(options: {
  markups: PlacementMarkup[];
  page: PageGeometry;
}): MarkupProposal[] {
  const page = createPageGeometry(options.page);
  return options.markups.map((markup, index) => {
    const points = markup.points || [];
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const minX = xs.length ? Math.min(...xs) : 0;
    const minY = ys.length ? Math.min(...ys) : 0;
    const maxX = xs.length ? Math.max(...xs) : minX + 24;
    const maxY = ys.length ? Math.max(...ys) : minY + 24;
    const confidence = typeof markup.confidence === 'number' ? clamp01(markup.confidence) : 0.6;

    return {
      id: markup.id || `proposal_pl_${index}`,
      pageNumber: markup.page || page.pageNumber,
      markupType: markup.type,
      boundingBox: {
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
      },
      confidence,
      placementMode: confidence >= 0.75 ? 'exact' : 'estimated',
      rationale: markup.aiNote || markup.label || markup.type,
      sourceSignals: ['pipeline_placement'],
    };
  });
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
