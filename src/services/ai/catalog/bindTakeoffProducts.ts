/**
 * Before AI markups are committed, give each counted fixture and each suggested run a product in
 * the user's library (existing product when it matches, otherwise created under "AI Takeoff").
 * addAIMarkupBatch then links the measurements, so quantities and footages roll up per product.
 */
import type { CanvasMarkup } from '@/types/markup';
import { takeoffColor } from '@/lib/takeoffColors';
import { runMaterialProducts, runProductFeet } from '../runs/runMaterials';
import { ensureTakeoffProduct, fixtureProductSpec, type TakeoffProductSpec } from './takeoffProducts';

export interface BoundProduct {
  productId: string;
  name: string;
  created: boolean;
  /** Markers / runs linked to it. */
  count: number;
  unit: 'ea' | 'ft';
  /** Total feet for run products. */
  ft?: number;
}

const TYPE_CODE = /^[A-Z]{1,3}\d{0,2}[A-Z]?(?:-\d{1,2})?$/i;

function countSpec(label: string): TakeoffProductSpec | null {
  const text = label.trim();
  if (!text || text === '?') return null;
  if (TYPE_CODE.test(text)) return fixtureProductSpec(text.toUpperCase());
  return {
    key: `count:${text.toLowerCase()}`,
    name: text.slice(0, 80),
    folder: 'Lighting & Devices',
    unit: 'ea',
    aliases: [text],
  };
}

/** Sets productId on markups that don't have one. Returns what was linked (for the chat summary). */
export function bindTakeoffProducts(rows: Array<{ page: number; markup: CanvasMarkup }>): BoundProduct[] {
  const byId = new Map<string, BoundProduct>();
  const specCache = new Map<string, { productId: string; created: boolean }>();
  const ensure = (spec: TakeoffProductSpec) => {
    const hit = specCache.get(spec.key);
    if (hit) return hit;
    const result = ensureTakeoffProduct(spec);
    specCache.set(spec.key, result);
    return result;
  };
  for (const { markup } of rows) {
    const m = markup as CanvasMarkup & { productId?: string };
    // Each fixture type / product gets its own color on the print.
    if (m.type === 'count-marker' && !m.reviewMarker) {
      const key = m.productId ? `product:${m.productId}` : countSpec(m.label || '')?.key;
      if (key) {
        const color = takeoffColor(key);
        m.style = { ...m.style, strokeColor: color, fillColor: color };
      }
    }
    if (m.productId || m.reviewMarker || m.aiPending) continue;
    let spec: TakeoffProductSpec | null = null;
    let ft: number | undefined;
    if (m.type === 'count-marker') {
      spec = countSpec(m.label || '');
    } else if (m.type === 'polyline' && m.aiRun?.assembly && (m.aiRun.kind === 'homerun' || m.aiRun.kind === 'branch')) {
      // Conduit (or cable) is the run's product; the wire inside is its own product(s).
      const products = runMaterialProducts(m.aiRun.assembly);
      if (products.length) {
        spec = products[0].spec;
        ft = runProductFeet(m.aiRun.assembly, m.aiRun.lengthFt || 0);
        const components: Array<{ productId: string; perFt: number }> = [];
        for (const component of products.slice(1)) {
          try {
            const { productId, created } = ensure(component.spec);
            components.push({ productId, perFt: component.perFt / (products[0].perFt || 1) });
            const row = byId.get(productId) || { productId, name: component.spec.name, created, count: 0, unit: 'ft' as const };
            row.count += 1;
            // Same number the product tree shows: the run's footage × conductors.
            row.ft = Math.round(((row.ft || 0) + runProductFeet(m.aiRun.assembly, m.aiRun.lengthFt || 0) * (component.perFt / (products[0].perFt || 1))) * 10) / 10;
            byId.set(productId, row);
          } catch {
            // Library unavailable for this material: the conduit still links.
          }
        }
        m.aiRun = { ...m.aiRun, componentProducts: components.length ? components : undefined };
      }
    }
    if (!spec) continue;
    try {
      const { productId, created } = ensure(spec);
      m.productId = productId;
      const row = byId.get(productId) || { productId, name: spec.name, created, count: 0, unit: spec.unit };
      row.count += 1;
      if (ft != null) row.ft = Math.round(((row.ft || 0) + ft) * 10) / 10;
      byId.set(productId, row);
    } catch {
      // Product library unavailable: place the markup unlinked.
    }
  }
  return [...byId.values()];
}

export function describeBoundProducts(products: BoundProduct[]): string {
  if (!products.length) return '';
  const created = products.filter(p => p.created).length;
  const parts = products.slice(0, 8).map(p => (p.unit === 'ft' ? `${p.name} ${Math.ceil(p.ft || 0)} ft` : `${p.name} ×${p.count}`));
  return `Linked to products: ${parts.join(' · ')}${products.length > 8 ? ' …' : ''}${created ? ` (${created} new under "AI Takeoff")` : ''}`;
}
