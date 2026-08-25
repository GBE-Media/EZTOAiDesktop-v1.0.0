import type { CanvasMarkup } from '@/types/markup';
import type { ProductNode } from '@/types/product';
import { useProductStore } from '@/store/productStore';
import { buildMeasurementFromMarkup } from './measurementFromMarkup';

export type LinkPlacedProductResult = {
  markupId: string;
  productId: string;
  status: 'linked' | 'invalid-product' | 'unsupported-markup';
  page?: number;
  reason?: string;
};

function resolveLinkableProduct(productId: string): ProductNode | { error: string } {
  const node = useProductStore.getState().nodes[productId];
  if (!node) return { error: `Catalog productId “${productId}” not found` };
  if (node.type !== 'product') {
    return {
      error: `Catalog node “${node.name}” is type “${node.type}” — only type “product” can be linked`,
    };
  }
  return node;
}

/** Validate a catalog id the AI wants to bind (placement-time or link_catalog). */
export function validateLinkableProductId(productId: string): {
  ok: boolean;
  reason?: string;
  product?: ProductNode;
} {
  const resolved = resolveLinkableProduct(productId);
  if ('error' in resolved) return { ok: false, reason: resolved.error };
  return { ok: true, product: resolved };
}

/**
 * Link productStore measurement for a markup that already has productId set
 * (AI place_markups / manual-style placement). Does not call canvas updateMarkup.
 */
export function linkMeasurementForMarkupWithProduct(
  markup: CanvasMarkup,
  documentId: string,
): LinkPlacedProductResult {
  const productId = (markup as CanvasMarkup & { productId?: string }).productId;
  if (!productId) {
    return {
      markupId: markup.id,
      productId: '',
      status: 'invalid-product',
      reason: 'Markup has no productId',
      page: markup.page,
    };
  }
  const resolved = resolveLinkableProduct(productId);
  if ('error' in resolved) {
    return {
      markupId: markup.id,
      productId,
      status: 'invalid-product',
      reason: resolved.error,
      page: markup.page,
    };
  }
  const measurement = buildMeasurementFromMarkup(markup, documentId);
  if (!measurement) {
    return {
      markupId: markup.id,
      productId,
      status: 'unsupported-markup',
      page: markup.page,
      reason: `Markup type “${markup.type}” cannot be linked to catalog products`,
    };
  }
  const productStore = useProductStore.getState();
  productStore.unlinkMeasurementByMarkupId(markup.id);
  productStore.linkMeasurement(productId, measurement);
  return {
    markupId: markup.id,
    productId,
    status: 'linked',
    page: markup.page,
  };
}

/** After AI placement batch: link any markup that already carries productId. */
export function attachProductsForPlacedMarkups(
  pairs: Array<{ page: number; markup: CanvasMarkup }>,
  documentId: string,
): LinkPlacedProductResult[] {
  const results: LinkPlacedProductResult[] = [];
  for (const { markup } of pairs) {
    const productId = (markup as CanvasMarkup & { productId?: string }).productId;
    if (!productId) continue;
    results.push(linkMeasurementForMarkupWithProduct(markup, documentId));
  }
  return results;
}
