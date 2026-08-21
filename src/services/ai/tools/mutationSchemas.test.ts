import { describe, expect, it } from 'vitest';
import {
  deleteMarkupsSchema,
  linkCatalogSchema,
  placeMarkupsSchema,
  proposeCalloutsSchema,
  updateMarkupsSchema,
  activateEditorToolSchema,
  applyMaterialCountAdjustmentsSchema,
} from './mutationSchemas';
import { zodToJsonSchema } from './zodToJsonSchema';

const samplePointer = {
  type: 'callout' as const,
  ref: 1,
  point: { x: 120.5, y: 340.25 },
  page: 2,
  label: 'Panel A',
  note: 'Main distribution',
  confidence: 0.91,
};

const samplePlacementMarkup = {
  type: 'callout' as const,
  page: 2,
  points: [{ x: 120.5, y: 340.25 }],
  style: {
    strokeColor: '#22c55e',
    fillColor: 'rgba(34,197,94,0.15)',
    strokeWidth: 2,
  },
  calloutRef: 1,
  label: 'Panel A',
  pending: true,
};

const sampleCanvasPair = {
  page: 2,
  markup: {
    id: 'm_green_1',
    type: 'callout',
    page: 2,
    x: 100,
    y: 200,
    width: 40,
    height: 24,
    content: '1',
    style: {
      strokeColor: '#22c55e',
      fillColor: 'rgba(34,197,94,0.15)',
      strokeWidth: 2,
      opacity: 1,
    },
    locked: false,
    author: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
};

describe('mutationSchemas', () => {
  it('place_markups accepts PlacementMarkup rows and rejects delete-shaped input', () => {
    const ok = placeMarkupsSchema.safeParse({
      description: 'Place verified callout',
      markups: [samplePlacementMarkup],
    });
    expect(ok.success).toBe(true);

    const fromPointers = placeMarkupsSchema.safeParse({
      description: 'Place from pointers',
      pointers: [samplePointer],
    });
    expect(fromPointers.success).toBe(true);

    const fromCanvasPairs = placeMarkupsSchema.safeParse({
      description: 'Place canvas pairs',
      markups: [sampleCanvasPair],
    });
    expect(fromCanvasPairs.success).toBe(true);

    const legacyPayload = placeMarkupsSchema.safeParse({
      description: 'Legacy payload alias',
      payload: [samplePointer],
    });
    expect(legacyPayload.success).toBe(true);

    const mismatched = placeMarkupsSchema.safeParse({
      description: 'Wrong shape for place',
      markupIds: ['m1', 'm2'],
    });
    expect(mismatched.success).toBe(false);
  });

  it('propose_callouts requires ChatMarkupPointer rows and rejects place markup geometry', () => {
    const ok = proposeCalloutsSchema.safeParse({
      description: 'Propose green callouts',
      pointers: [samplePointer],
    });
    expect(ok.success).toBe(true);

    const mismatched = proposeCalloutsSchema.safeParse({
      description: 'Wrong shape for callouts',
      markups: [samplePlacementMarkup],
    });
    expect(mismatched.success).toBe(false);
  });

  it('update_markups accepts id+patch rows and rejects delete ids-only', () => {
    const ok = updateMarkupsSchema.safeParse({
      description: 'Relabel callout',
      updates: [{ id: 'm1', page: 2, patch: { label: 'Panel B', content: '2' } }],
    });
    expect(ok.success).toBe(true);

    const mismatched = updateMarkupsSchema.safeParse({
      description: 'Wrong shape for update',
      markupIds: ['m1'],
    });
    expect(mismatched.success).toBe(false);
  });

  it('delete_markups requires markupIds and rejects place-shaped markups', () => {
    const ok = deleteMarkupsSchema.safeParse({
      description: 'Remove two callouts',
      markupIds: ['m1', 'm2'],
      page: 2,
    });
    expect(ok.success).toBe(true);

    const mismatched = deleteMarkupsSchema.safeParse({
      description: 'Wrong shape for delete',
      markups: [samplePlacementMarkup],
    });
    expect(mismatched.success).toBe(false);
  });

  it('link_catalog requires markup/product links', () => {
    const ok = linkCatalogSchema.safeParse({
      description: 'Link receptacle to catalog SKU',
      links: [{ markupId: 'm1', productId: 'prod_duplex', page: 2 }],
    });
    expect(ok.success).toBe(true);

    const mismatched = linkCatalogSchema.safeParse({
      description: 'Wrong shape for link',
      markupIds: ['m1'],
    });
    expect(mismatched.success).toBe(false);
  });

  it('activate_editor_tool and applyMaterialCountAdjustments use typed fields', () => {
    expect(activateEditorToolSchema.safeParse({ tool: 'callout' }).success).toBe(true);
    expect(activateEditorToolSchema.safeParse({ description: 'x' }).success).toBe(false);

    expect(applyMaterialCountAdjustmentsSchema.safeParse({
      description: 'Bump duplex count',
      adjustments: [{ productId: 'prod_duplex', delta: 2, page: 1 }],
    }).success).toBe(true);

    expect(applyMaterialCountAdjustmentsSchema.safeParse({
      description: 'Missing adjustment fields',
      adjustments: [{ productId: 'prod_duplex' }],
    }).success).toBe(false);
  });

  it('exports real JSON Schema properties (not opaque payload: unknown)', () => {
    const placeJson = zodToJsonSchema(placeMarkupsSchema);
    expect(placeJson).toMatchObject({ type: 'object' });
    expect(placeJson.properties).toMatchObject({
      description: { type: 'string' },
      markups: { type: 'array' },
      pointers: { type: 'array' },
    });
    expect(placeJson.properties).not.toHaveProperty('payload');

    const deleteJson = zodToJsonSchema(deleteMarkupsSchema);
    expect(deleteJson.properties).toMatchObject({
      description: { type: 'string' },
      markupIds: { type: 'array' },
    });
    expect(deleteJson.required).toEqual(expect.arrayContaining(['description', 'markupIds']));
  });
});
