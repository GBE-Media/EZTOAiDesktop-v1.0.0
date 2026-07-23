import { describe, expect, it } from 'vitest';
import { summarizeCatalogForChat, summarizeMarkupsForChat } from './contextSummary';
import type { CanvasMarkup, CountMarkerMarkup, MeasurementMarkup } from '@/types/markup';
import type { ProductNode } from '@/types/product';

const baseStyle = { strokeColor: '#000', fillColor: '#000', strokeWidth: 1, opacity: 1 };

function countMarker(overrides: Partial<CountMarkerMarkup>): CountMarkerMarkup {
  return {
    id: overrides.id || 'marker-1',
    type: 'count-marker',
    page: 1,
    style: baseStyle,
    locked: false,
    author: 'user',
    createdAt: '2026-01-01T00:00:00Z',
    x: 0,
    y: 0,
    number: 1,
    groupId: 'group-1',
    ...overrides,
  };
}

function measurement(overrides: Partial<MeasurementMarkup>): MeasurementMarkup {
  return {
    id: overrides.id || 'measurement-1',
    type: 'measurement-length',
    page: 1,
    style: baseStyle,
    locked: false,
    author: 'user',
    createdAt: '2026-01-01T00:00:00Z',
    points: [],
    value: 10,
    unit: 'ft',
    scaledValue: 10,
    ...overrides,
  };
}

describe('summarizeMarkupsForChat', () => {
  it('returns an empty string when the page has no markups', () => {
    expect(summarizeMarkupsForChat({}, 1)).toBe('');
    expect(summarizeMarkupsForChat({ 1: [] }, 1)).toBe('');
  });

  it('only looks at the requested page, ignoring markups on other pages', () => {
    const markupsByPage: Record<number, CanvasMarkup[]> = {
      1: [countMarker({ id: 'a' })],
      2: [countMarker({ id: 'b' }), countMarker({ id: 'c' })],
    };

    const summary = summarizeMarkupsForChat(markupsByPage, 1);
    expect(summary).toContain('Markups on page 1 (1 total)');
    expect(summary).toContain('1 marker(s)');
  });

  it('groups count markers by groupId and includes linked product id', () => {
    const markupsByPage: Record<number, CanvasMarkup[]> = {
      1: [
        countMarker({ id: 'a', groupId: 'lights', productId: 'product-1' }),
        countMarker({ id: 'b', groupId: 'lights', productId: 'product-1' }),
        countMarker({ id: 'c', groupId: 'outlets' }),
      ],
    };

    const summary = summarizeMarkupsForChat(markupsByPage, 1);
    expect(summary).toContain('2 marker(s), group "lights" (linked product: product-1)');
    expect(summary).toContain('1 marker(s), group "outlets"');
  });

  it('lists measurement values with units', () => {
    const markupsByPage: Record<number, CanvasMarkup[]> = {
      1: [
        measurement({ id: 'a', scaledValue: 42.5, unit: 'ft' }),
        measurement({ id: 'b', scaledValue: 18, unit: 'ft' }),
      ],
    };

    const summary = summarizeMarkupsForChat(markupsByPage, 1);
    expect(summary).toContain('measurement-length: 2 item(s) - 42.5 ft, 18.0 ft');
  });
});

function productNode(overrides: Partial<ProductNode>): ProductNode {
  return {
    id: overrides.id || 'node-1',
    name: overrides.name || 'Node',
    type: overrides.type || 'product',
    parentId: overrides.parentId ?? null,
    children: overrides.children || [],
    expanded: overrides.expanded ?? true,
    ...overrides,
  };
}

describe('summarizeCatalogForChat', () => {
  it('returns an empty string when there are no products or assemblies', () => {
    expect(summarizeCatalogForChat({}, [], null)).toBe('');
  });

  it('includes category path and price/unit for products, and unit for assemblies', () => {
    const nodes: Record<string, ProductNode> = {
      lighting: productNode({ id: 'lighting', name: 'Lighting', type: 'folder', children: ['fixture-1'] }),
      'fixture-1': productNode({
        id: 'fixture-1',
        name: 'Type A1',
        type: 'product',
        parentId: 'lighting',
        unitPrice: 50,
        unitOfMeasure: 'each',
      }),
      'assembly-1': productNode({
        id: 'assembly-1',
        name: '100A Disconnect Install',
        type: 'assembly',
        unitOfMeasure: 'each',
      }),
    };

    const summary = summarizeCatalogForChat(nodes, ['lighting', 'assembly-1'], 'fixture-1');
    expect(summary).toContain('Catalog (1 products, 1 assemblies)');
    expect(summary).toContain('Lighting: Type A1 (product, $50.00/each)');
    expect(summary).toContain('100A Disconnect Install (assembly, each)');
    expect(summary).toContain('Currently active for takeoff: Type A1');
  });

  it('truncates past the item cap', () => {
    const nodes: Record<string, ProductNode> = {};
    const rootIds: string[] = [];
    for (let i = 0; i < 45; i++) {
      const id = `product-${i}`;
      nodes[id] = productNode({ id, name: `Product ${i}`, unitPrice: 1 });
      rootIds.push(id);
    }

    const summary = summarizeCatalogForChat(nodes, rootIds, null);
    expect(summary).toContain('... and 5 more item(s) not shown');
  });
});
