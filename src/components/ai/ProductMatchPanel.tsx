/**
 * Two-pane matcher used inside the "Map AI Types to Products" dialog.
 * Detected items are listed on the left, catalog products on the right;
 * the active pair is highlighted and connected with a green curve so the
 * match is visually unambiguous, similar to document-matching review UIs.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { ProductNode } from '@/types/product';

interface ProductMatchPanelProps {
  mapKeys: string[];
  counts: Record<string, number>;
  values: Record<string, string>;
  onSelect: (key: string, productId: string) => void;
  productOptions: ProductNode[];
}

interface ConnectorGeometry {
  path: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const CONNECTOR_COLOR = '#22c55e'; // emerald-500

export function ProductMatchPanel({ mapKeys, counts, values, onSelect, productOptions }: ProductMatchPanelProps) {
  const [activeKey, setActiveKey] = useState<string | null>(mapKeys[0] || null);
  const [search, setSearch] = useState('');
  const [connector, setConnector] = useState<ConnectorGeometry | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const leftRowRefs = useRef(new Map<string, HTMLDivElement>());
  const rightRowRefs = useRef(new Map<string, HTMLDivElement>());

  // Keep an active row selected whenever there are detected items to match.
  useEffect(() => {
    if ((!activeKey || !mapKeys.includes(activeKey)) && mapKeys.length > 0) {
      setActiveKey(mapKeys[0]);
    }
  }, [activeKey, mapKeys]);

  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return productOptions;
    return productOptions.filter((product) => {
      const haystack = `${product.name} ${product.categoryPath || ''}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [productOptions, search]);

  const recomputeConnector = useCallback(() => {
    const container = containerRef.current;
    const key = activeKey;
    const productId = key ? values[key] : undefined;
    if (!container || !key || !productId) {
      setConnector(null);
      return;
    }
    const fromEl = leftRowRefs.current.get(key);
    const toEl = rightRowRefs.current.get(productId);
    if (!fromEl || !toEl) {
      setConnector(null);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();
    const x1 = fromRect.right - containerRect.left;
    const y1 = fromRect.top + fromRect.height / 2 - containerRect.top;
    const x2 = toRect.left - containerRect.left;
    const y2 = toRect.top + toRect.height / 2 - containerRect.top;
    const midX = (x1 + x2) / 2;
    setConnector({
      path: `M ${x1},${y1} C ${midX},${y1} ${midX},${y2} ${x2},${y2}`,
      x1,
      y1,
      x2,
      y2,
    });
  }, [activeKey, values]);

  // Recompute whenever the active pair, the visible product list, or the
  // detected-item list changes size (e.g. search filtering, initial mount).
  useLayoutEffect(() => {
    recomputeConnector();
  }, [recomputeConnector, filteredProducts, mapKeys]);

  // Recompute on scroll/resize since the connector must track real DOM
  // positions, not fixed offsets.
  useEffect(() => {
    const handle = () => recomputeConnector();
    window.addEventListener('resize', handle);
    const container = containerRef.current;
    let observer: ResizeObserver | null = null;
    if (container && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(handle);
      observer.observe(container);
    }
    return () => {
      window.removeEventListener('resize', handle);
      observer?.disconnect();
    };
  }, [recomputeConnector]);

  // Switching the active item clears the search (so its match isn't hidden)
  // and scrolls its current match into view if it has one.
  useEffect(() => {
    setSearch('');
    if (activeKey && values[activeKey]) {
      rightRowRefs.current.get(values[activeKey])?.scrollIntoView({ block: 'nearest' });
    }
    // Only react to the active key changing, not to every value/search edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  return (
    <div ref={containerRef} className="relative grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-6">
      <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible">
        {connector && (
          <>
            <path d={connector.path} fill="none" stroke={CONNECTOR_COLOR} strokeWidth={2} strokeLinecap="round" />
            <circle cx={connector.x1} cy={connector.y1} r={4} fill={CONNECTOR_COLOR} />
            <circle cx={connector.x2} cy={connector.y2} r={4} fill={CONNECTOR_COLOR} />
          </>
        )}
      </svg>

      {/* Detected items */}
      <div className="flex flex-col gap-2 min-w-0">
        <div className="text-xs font-medium text-muted-foreground">Detected Items</div>
        <div onScroll={recomputeConnector} className="flex flex-col gap-1.5 max-h-72 overflow-y-auto pr-1">
          {mapKeys.map((key) => {
            const isActive = key === activeKey;
            const isMapped = Boolean(values[key]);
            return (
              <div
                key={key}
                ref={(el) => {
                  if (el) leftRowRefs.current.set(key, el);
                  else leftRowRefs.current.delete(key);
                }}
                onClick={() => setActiveKey(key)}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs cursor-pointer transition-colors',
                  isActive
                    ? 'border-emerald-500 ring-2 ring-emerald-500 bg-emerald-500/5'
                    : 'border-border hover:border-emerald-500/50',
                )}
              >
                <span className="font-medium">
                  {key}
                  {counts[key] ? <span className="text-muted-foreground"> ({counts[key]})</span> : null}
                </span>
                {isMapped && <Check className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />}
              </div>
            );
          })}
        </div>
      </div>

      {/* Catalog products */}
      <div className="flex flex-col gap-2 min-w-0">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search products..."
            className="h-8 pl-7 text-xs"
          />
        </div>
        <div onScroll={recomputeConnector} className="flex flex-col gap-1.5 max-h-72 overflow-y-auto pr-1">
          {filteredProducts.length === 0 && (
            <div className="px-1 py-2 text-xs text-muted-foreground">No matching products.</div>
          )}
          {filteredProducts.map((product) => {
            const isMappedToActive = Boolean(activeKey && values[activeKey] === product.id);
            return (
              <div
                key={product.id}
                ref={(el) => {
                  if (el) rightRowRefs.current.set(product.id, el);
                  else rightRowRefs.current.delete(product.id);
                }}
                onClick={() => activeKey && onSelect(activeKey, product.id)}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs transition-colors',
                  activeKey ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
                  isMappedToActive
                    ? 'border-emerald-500 ring-2 ring-emerald-500 bg-emerald-500/5'
                    : 'border-border hover:border-emerald-500/50',
                )}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{product.name}</div>
                  {product.categoryPath && (
                    <div className="truncate text-[10px] text-muted-foreground">{product.categoryPath}</div>
                  )}
                </div>
                <div className="flex-shrink-0 text-[10px] text-muted-foreground">
                  {typeof product.unitPrice === 'number'
                    ? `$${product.unitPrice.toFixed(2)}/${product.unitOfMeasure || 'ea'}`
                    : product.unitOfMeasure || ''}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
