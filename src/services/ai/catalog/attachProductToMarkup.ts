import type { CanvasMarkup } from '@/types/markup';
import { useCanvasStore } from '@/store/canvasStore';
import { useProductStore } from '@/store/productStore';
import { buildMeasurementFromMarkup } from './measurementFromMarkup';
import { validateLinkableProductId } from './linkPlacedProducts';

export type AttachProductResult = {
  markupId: string;
  productId: string;
  status: 'linked' | 'not-found' | 'invalid-product' | 'unsupported-markup' | 'no-document';
  page?: number;
  reason?: string;
};

export { buildMeasurementFromMarkup } from './measurementFromMarkup';
export {
  attachProductsForPlacedMarkups,
  linkMeasurementForMarkupWithProduct,
  validateLinkableProductId,
} from './linkPlacedProducts';

function findMarkupById(
  markupId: string,
  preferredPage?: number,
): { page: number; markup: CanvasMarkup } | null {
  const canvas = useCanvasStore.getState();
  if (!canvas.activeDocId) return null;
  const docData = canvas.pdfDocuments[canvas.activeDocId];
  if (!docData) return null;
  const byPage = docData.markupsByPage;

  if (preferredPage != null) {
    const onPreferred = (byPage[preferredPage] || []).find(m => m.id === markupId);
    if (onPreferred) return { page: preferredPage, markup: onPreferred };
  }

  for (const [pageKey, markups] of Object.entries(byPage)) {
    const found = markups.find(m => m.id === markupId);
    if (found) return { page: Number(pageKey), markup: found };
  }
  return null;
}

/**
 * Single shared implementation for catalog binding used by link_catalog:
 * set markup.productId + productStore.linkMeasurement (after unlinking any prior link).
 * Mirrors MarkupCanvas manual count/measure active-product flow.
 *
 * Placement-time binding reuses the same productStore.linkMeasurement +
 * buildMeasurementFromMarkup path via linkMeasurementForMarkupWithProduct
 * (markup already has productId; no updateMarkup needed).
 */
export function attachProductToMarkup(options: {
  markupId: string;
  productId: string;
  page?: number;
}): AttachProductResult {
  const { markupId, productId, page: preferredPage } = options;
  const validated = validateLinkableProductId(productId);
  if (!validated.ok) {
    return {
      markupId,
      productId,
      status: 'invalid-product',
      reason: validated.reason,
    };
  }

  const found = findMarkupById(markupId, preferredPage);
  if (!found) {
    return {
      markupId,
      productId,
      status: 'not-found',
      reason: 'Markup id not found on active document',
    };
  }

  const canvas = useCanvasStore.getState();
  const docId = canvas.activeDocId;
  if (!docId) {
    return {
      markupId,
      productId,
      status: 'no-document',
      reason: 'No active document',
      page: found.page,
    };
  }

  const withProduct = { ...found.markup, productId } as CanvasMarkup;
  const measurement = buildMeasurementFromMarkup(withProduct, docId);
  if (!measurement) {
    return {
      markupId,
      productId,
      status: 'unsupported-markup',
      page: found.page,
      reason: `Markup type “${found.markup.type}” cannot be linked to catalog products (use count-marker or measurement-*)`,
    };
  }

  canvas.updateMarkup(found.page, markupId, { productId } as Partial<CanvasMarkup>);

  const productStore = useProductStore.getState();
  productStore.unlinkMeasurementByMarkupId(markupId);
  productStore.linkMeasurement(productId, measurement);

  return {
    markupId,
    productId,
    status: 'linked',
    page: found.page,
  };
}

export function executeLinkCatalog(payload: unknown): {
  status: 'completed';
  linked: number;
  failed: number;
  results: AttachProductResult[];
  message: string;
} {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const links = Array.isArray(record.links) ? record.links : [];
  const results: AttachProductResult[] = [];

  for (const row of links) {
    if (!row || typeof row !== 'object') {
      results.push({
        markupId: '',
        productId: '',
        status: 'not-found',
        reason: 'Invalid link row',
      });
      continue;
    }
    const link = row as { markupId?: unknown; productId?: unknown; page?: unknown };
    if (typeof link.markupId !== 'string' || typeof link.productId !== 'string') {
      results.push({
        markupId: String(link.markupId || ''),
        productId: String(link.productId || ''),
        status: 'not-found',
        reason: 'Each link needs string markupId and productId',
      });
      continue;
    }
    results.push(attachProductToMarkup({
      markupId: link.markupId,
      productId: link.productId,
      page: typeof link.page === 'number' ? link.page : undefined,
    }));
  }

  const linked = results.filter((r) => r.status === 'linked').length;
  const failed = results.length - linked;
  return {
    status: 'completed',
    linked,
    failed,
    results,
    message: `Linked ${linked} markup(s) to catalog; ${failed} failed.`,
  };
}
