import '../agent/testGlobals';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProductNode } from '@/types/product';
import type { CountMarkerMarkup, MarkupStyle } from '@/types/markup';
import { useCanvasStore } from '@/store/canvasStore';
import { useHistoryStore } from '@/store/historyStore';
import { useProductStore } from '@/store/productStore';
import { searchCatalog, CATALOG_CONFIDENT_SCORE } from './searchCatalog';
import {
  attachProductToMarkup,
  executeLinkCatalog,
} from './attachProductToMarkup';
import { attachProductsForPlacedMarkups } from './linkPlacedProducts';
import { convertPlacementsToMarkups } from '../placement/convertPlacements';
import { createAgentToolContext } from '../agent/createToolContext';
import { executeAssistantTool, executeApprovedAssistantAction } from '../tools/registry';
import { registerAllAgentTools, resetAgentToolRegistrationForTests } from '../agent/tools/registerAll';
import type { PlacementMarkup } from '../providers/types';

const style: MarkupStyle = {
  strokeColor: '#111',
  fillColor: 'transparent',
  strokeWidth: 1,
  opacity: 1,
  fontSize: 12,
  fontFamily: 'Arial',
};

function seedCatalog() {
  const nodes: Record<string, ProductNode> = {
    boxes: {
      id: 'boxes',
      name: 'Boxes',
      type: 'folder',
      parentId: null,
      children: ['jboxes'],
      expanded: true,
    },
    jboxes: {
      id: 'jboxes',
      name: 'Junction Boxes',
      type: 'folder',
      parentId: 'boxes',
      children: ['prod-jb-12'],
      expanded: true,
    },
    'prod-jb-12': {
      id: 'prod-jb-12',
      name: 'Junction Box, 12x12x6 NEMA 1',
      type: 'product',
      parentId: 'jboxes',
      children: [],
      expanded: false,
      unitOfMeasure: 'ea',
      unitPrice: 42,
      sku: 'JB-12126',
      categoryPath: 'Boxes/Junction Boxes',
    },
    lighting: {
      id: 'lighting',
      name: 'Lighting',
      type: 'folder',
      parentId: null,
      children: ['prod-a1', 'prod-bnl'],
      expanded: true,
    },
    'prod-a1': {
      id: 'prod-a1',
      name: 'Type A1 Recessed Fixture',
      type: 'product',
      parentId: 'lighting',
      children: [],
      expanded: false,
      unitOfMeasure: 'ea',
      sku: 'A1',
    },
    'prod-bnl': {
      id: 'prod-bnl',
      name: 'Night Light Fixture B-NL',
      type: 'product',
      parentId: 'lighting',
      children: [],
      expanded: false,
      unitOfMeasure: 'ea',
    },
    'asm-panel': {
      id: 'asm-panel',
      name: '100A Panel Assembly',
      type: 'assembly',
      parentId: null,
      children: [],
      expanded: false,
      unitOfMeasure: 'ea',
    },
  };
  useProductStore.getState().loadFromDatabase(nodes, ['boxes', 'lighting', 'asm-panel']);
}

function countMarker(overrides: Partial<CountMarkerMarkup> & { id: string }): CountMarkerMarkup {
  return {
    type: 'count-marker',
    page: 1,
    style,
    locked: false,
    author: 'test',
    createdAt: new Date().toISOString(),
    x: 100,
    y: 200,
    number: 1,
    groupId: 'g1',
    ...overrides,
  };
}

describe('AI catalog product binding', () => {
  beforeEach(() => {
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();
    useHistoryStore.getState().clearHistory();
    useProductStore.getState().clearStore();
    useCanvasStore.getState().clearAllDocuments();
    useCanvasStore.getState().setPdfDocument('doc-cat', { _fake: true }, 2, 612, 792);
    seedCatalog();
  });

  it('search_catalog returns real product IDs from the Products panel store (not hardcoded)', async () => {
    const direct = searchCatalog({ query: 'Junction Box', productsOnly: true });
    expect(direct.matches.some((m) => m.productId === 'prod-jb-12')).toBe(true);
    expect(direct.matches.find((m) => m.productId === 'prod-jb-12')?.name).toContain('12x12x6');
    expect(direct.noConfidentMatch).toBe(false);
    expect(direct.confidentMatches[0]?.score).toBeGreaterThanOrEqual(CATALOG_CONFIDENT_SCORE);

    const context = createAgentToolContext({
      runId: 'run-search',
      messageId: 'msg-search',
      trade: 'electrical',
      placeMarkups: async () => ({ placed: 0 }),
    });
    const viaTool = await executeAssistantTool(
      'search_catalog',
      { query: 'A1', productsOnly: true },
      context,
    );
    expect(viaTool.status).toBe('completed');
    const output = viaTool.output as ReturnType<typeof searchCatalog>;
    expect(output.confidentMatches.some((m) => m.productId === 'prod-a1')).toBe(true);
    expect(output.matches.every((m) => useProductStore.getState().nodes[m.productId])).toBe(true);
  });

  it('search_catalog flags noConfidentMatch instead of inventing a product', () => {
    const result = searchCatalog({ query: 'QWERTYZXCVBN999', productsOnly: true });
    expect(result.confidentMatches.length).toBe(0);
    expect(result.noConfidentMatch).toBe(true);
    expect(result.message).toMatch(/Do not invent|Do not silently bind|no matching catalog/i);
  });

  it('link_catalog attaches a real productId through approval and undo/redo restores the link', async () => {
    const markup = countMarker({ id: 'count-link-1', x: 50, y: 60 });
    useCanvasStore.getState().addMarkup(1, markup);
    expect(useProductStore.getState().getMeasurementByMarkupId('count-link-1')).toBeNull();

    const context = createAgentToolContext({
      runId: 'run-link',
      messageId: 'msg-link',
      trade: 'electrical',
      placeMarkups: async () => ({ placed: 0 }),
    });

    const proposal = await executeAssistantTool(
      'link_catalog',
      {
        description: 'Link count to junction box',
        links: [{ markupId: 'count-link-1', productId: 'prod-jb-12', page: 1 }],
      },
      context,
    );
    expect(proposal.status).toBe('approval-required');
    expect(proposal.approval).toBeTruthy();

    const executed = await executeApprovedAssistantAction(proposal.approval!, context);
    expect(executed).toMatchObject({ status: 'completed', linked: 1, failed: 0 });

    const stored = useCanvasStore.getState().pdfDocuments['doc-cat']!.markupsByPage[1]!
      .find((m) => m.id === 'count-link-1') as CountMarkerMarkup;
    expect(stored.productId).toBe('prod-jb-12');
    const link = useProductStore.getState().getMeasurementByMarkupId('count-link-1');
    expect(link?.productId).toBe('prod-jb-12');
    expect(link?.measurement.type).toBe('count');

    useCanvasStore.getState().undo();
    const afterUndo = useCanvasStore.getState().pdfDocuments['doc-cat']!.markupsByPage[1]!
      .find((m) => m.id === 'count-link-1') as CountMarkerMarkup;
    expect(afterUndo.productId).toBeUndefined();
    expect(useProductStore.getState().getMeasurementByMarkupId('count-link-1')).toBeNull();

    useCanvasStore.getState().redo();
    const afterRedo = useCanvasStore.getState().pdfDocuments['doc-cat']!.markupsByPage[1]!
      .find((m) => m.id === 'count-link-1') as CountMarkerMarkup;
    expect(afterRedo.productId).toBe('prod-jb-12');
    expect(useProductStore.getState().getMeasurementByMarkupId('count-link-1')?.productId).toBe('prod-jb-12');
  });

  it('place_markups optional productId uses the same attach path as link_catalog', () => {
    const placement: PlacementMarkup = {
      id: 'place-a1',
      type: 'count-marker',
      page: 1,
      points: [{ x: 120, y: 240 }],
      style: {
        strokeColor: '#111',
        fillColor: 'transparent',
        strokeWidth: 1,
      },
      label: 'A1',
      productId: 'prod-a1',
      pending: false,
    };
    const converted = convertPlacementsToMarkups(
      { markups: [placement], notes: [] },
      style,
      'ai-group',
      1.5,
      1.5,
    );
    expect((converted[0].markup as CountMarkerMarkup).productId).toBe('prod-a1');

    useCanvasStore.getState().addAIMarkupBatch(converted, false);
    const placed = useCanvasStore.getState().pdfDocuments['doc-cat']!.markupsByPage[1]!
      .find((m) => m.id === 'place-a1') as CountMarkerMarkup;
    expect(placed.productId).toBe('prod-a1');
    const viaPlace = useProductStore.getState().getMeasurementByMarkupId('place-a1');
    expect(viaPlace?.productId).toBe('prod-a1');

    // Same underlying linkMeasurement + buildMeasurementFromMarkup as link_catalog
    const other = countMarker({ id: 'count-link-2', x: 10, y: 10 });
    useCanvasStore.getState().addMarkup(1, other);
    const linkResult = attachProductToMarkup({
      markupId: 'count-link-2',
      productId: 'prod-a1',
      page: 1,
    });
    expect(linkResult.status).toBe('linked');
    const viaLink = useProductStore.getState().getMeasurementByMarkupId('count-link-2');
    expect(viaLink?.productId).toBe('prod-a1');
    expect(viaLink?.measurement.type).toBe(viaPlace?.measurement.type);
    expect(viaLink?.measurement.unit).toBe(viaPlace?.measurement.unit);
  });

  it('invalid / non-product catalog ids are flagged and left unbound (no silent guess)', () => {
    const badId: PlacementMarkup = {
      id: 'bad-id',
      type: 'count-marker',
      page: 1,
      points: [{ x: 1, y: 2 }],
      style: { strokeColor: '#111', fillColor: 'transparent', strokeWidth: 1 },
      productId: 'does-not-exist',
      pending: false,
    };
    const assemblyId: PlacementMarkup = {
      id: 'asm-id',
      type: 'count-marker',
      page: 1,
      points: [{ x: 3, y: 4 }],
      style: { strokeColor: '#111', fillColor: 'transparent', strokeWidth: 1 },
      productId: 'asm-panel',
      pending: false,
    };
    const converted = convertPlacementsToMarkups(
      { markups: [badId, assemblyId], notes: [] },
      style,
      'ai-group',
    );
    for (const row of converted) {
      const m = row.markup as CountMarkerMarkup;
      expect(m.productId).toBeUndefined();
      expect(m.aiNote).toMatch(/no matching catalog product found/i);
    }

    const weak = searchCatalog({ query: 'receptacle', productsOnly: true, nodes: {
      lighting: {
        id: 'lighting',
        name: 'Lighting',
        type: 'folder',
        parentId: null,
        children: ['prod-a1'],
        expanded: true,
      },
      'prod-a1': {
        id: 'prod-a1',
        name: 'Type A1 Recessed Fixture',
        type: 'product',
        parentId: 'lighting',
        children: [],
        expanded: false,
      },
    }, rootIds: ['lighting'] });
    // "receptacle" vs lighting fixture — no/low match
    expect(weak.noConfidentMatch || weak.matches.length === 0).toBe(true);
    if (weak.matches.length > 0) {
      expect(weak.message).toMatch(/no confident catalog match|Do not silently bind/i);
    }
  });

  it('executeLinkCatalog rejects assembly product ids', () => {
    const markup = countMarker({ id: 'count-asm', x: 1, y: 1 });
    useCanvasStore.getState().addMarkup(1, markup);
    const result = executeLinkCatalog({
      links: [{ markupId: 'count-asm', productId: 'asm-panel', page: 1 }],
    });
    expect(result.linked).toBe(0);
    expect(result.results[0]?.status).toBe('invalid-product');
  });

  it('attachProductsForPlacedMarkups and attachProductToMarkup share measurement linking', () => {
    const a = countMarker({ id: 'share-a', productId: 'prod-bnl', x: 1, y: 1 });
    const b = countMarker({ id: 'share-b', x: 2, y: 2 });
    useCanvasStore.getState().addMarkup(1, a);
    useCanvasStore.getState().addMarkup(1, b);

    const placed = attachProductsForPlacedMarkups([{ page: 1, markup: a }], 'doc-cat');
    expect(placed[0]?.status).toBe('linked');

    const linked = attachProductToMarkup({ markupId: 'share-b', productId: 'prod-bnl', page: 1 });
    expect(linked.status).toBe('linked');

    const ma = useProductStore.getState().getMeasurementByMarkupId('share-a');
    const mb = useProductStore.getState().getMeasurementByMarkupId('share-b');
    expect(ma?.productId).toBe('prod-bnl');
    expect(mb?.productId).toBe('prod-bnl');
    expect(ma?.measurement.type).toBe(mb?.measurement.type);
    expect(ma?.measurement.unit).toBe(mb?.measurement.unit);
  });
});
