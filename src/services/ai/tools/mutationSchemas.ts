import { z } from 'zod';

/**
 * Zod schemas for assistant mutation tools.
 * Shapes draw on PlacementMarkup / ChatMarkupPointer / DocPoint contracts —
 * not a shared opaque `payload: unknown`.
 */

export const docPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const docRectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

/** PlacementMarkup.type union from providers/types.ts */
export const placementMarkupTypeSchema = z.enum([
  'count-marker',
  'rectangle',
  'measurement-length',
  'measurement-area',
  'polyline',
  'polygon',
  'text',
  'callout',
]);

const placementStyleSchema = z.object({
  strokeColor: z.string().min(1),
  fillColor: z.string().min(1),
  strokeWidth: z.number().finite().positive(),
  fontSize: z.number().finite().positive().optional(),
  fontFamily: z.string().optional(),
});

/** Document-space placement row the model proposes for place_markups. */
export const placementMarkupSchema = z.object({
  id: z.string().min(1).optional(),
  type: placementMarkupTypeSchema,
  page: z.number().int().positive(),
  points: z.array(docPointSchema).min(1),
  style: placementStyleSchema.optional(),
  label: z.string().optional(),
  content: z.string().optional(),
  leaderPoints: z.array(docPointSchema).optional(),
  calloutRef: z.number().int().positive().optional(),
  aiNote: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  linkedItemId: z.string().optional(),
  pending: z.boolean().optional(),
});

/**
 * UI approval path: already-built canvas markups as [{ page, markup }].
 * Matches NormalizeAgentMarkupPayload legacy pairs / AiChatDrawer queueMarkupApproval.
 */
export const canvasMarkupPairSchema = z.object({
  page: z.number().int().positive(),
  markup: z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    page: z.number().int().positive().optional(),
  }).passthrough(),
});

/** One place_markups content row: PlacementMarkup or canvas {page, markup} pair. */
export const placeMarkupItemSchema = z.union([
  canvasMarkupPairSchema,
  placementMarkupSchema,
]);

/** ChatMarkupPointer — DocPoint callout/target the model proposes. */
export const chatMarkupPointerSchema = z.object({
  type: z.enum(['callout', 'count-marker', 'text', 'rectangle']).default('callout'),
  ref: z.number().int().positive(),
  point: docPointSchema,
  bounds: docRectSchema.optional(),
  page: z.number().int().positive().optional(),
  label: z.string().optional(),
  note: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const approvalMetaSchema = {
  description: z.string().min(1),
  preview: z.unknown().optional(),
};

function withLegacyPlaceAlias(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    return { markups: raw, description: 'Place proposed markups on the document' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  // Legacy shared shape: { payload: <array>, description }
  if ('payload' in obj && !('markups' in obj) && !('pointers' in obj) && !('callouts' in obj)) {
    const payload = obj.payload;
    if (Array.isArray(payload)) {
      const looksLikePointers = payload.some(
        (item) => item && typeof item === 'object' && 'point' in (item as object) && 'ref' in (item as object),
      );
      return {
        description: String(obj.description || 'Place proposed markups on the document'),
        preview: obj.preview,
        ...(looksLikePointers ? { pointers: payload } : { markups: payload }),
      };
    }
  }
  return raw;
}

export const placeMarkupsSchema = z.preprocess(
  withLegacyPlaceAlias,
  z.object({
    ...approvalMetaSchema,
    markups: z.array(placeMarkupItemSchema).min(1).optional(),
    pointers: z.array(chatMarkupPointerSchema).min(1).optional(),
    callouts: z.array(chatMarkupPointerSchema).min(1).optional(),
  }).refine(
    (value) => Boolean(value.markups?.length || value.pointers?.length || value.callouts?.length),
    { message: 'place_markups requires markups, pointers, or callouts' },
  ).describe('At least one of markups, pointers, or callouts must be provided.'),
);

export const proposeCalloutsSchema = z.preprocess(
  (raw) => {
    if (Array.isArray(raw)) {
      return { pointers: raw, description: 'Propose green callouts on the document' };
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if ('payload' in obj && !('pointers' in obj) && !('callouts' in obj) && Array.isArray(obj.payload)) {
        return {
          description: String(obj.description || 'Propose green callouts on the document'),
          preview: obj.preview,
          pointers: obj.payload,
        };
      }
      if (obj.callouts && !obj.pointers) {
        return { ...obj, pointers: obj.callouts };
      }
    }
    return raw;
  },
  z.object({
    ...approvalMetaSchema,
    pointers: z.array(chatMarkupPointerSchema).min(1),
  }),
);

export const updateMarkupsSchema = z.object({
  ...approvalMetaSchema,
  updates: z.array(z.object({
    id: z.string().min(1),
    page: z.number().int().positive().optional(),
    patch: z.object({
      label: z.string().optional(),
      content: z.string().optional(),
      aiNote: z.string().optional(),
      points: z.array(docPointSchema).optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      width: z.number().finite().positive().optional(),
      height: z.number().finite().positive().optional(),
    }).passthrough(),
  })).min(1),
});

export const deleteMarkupsSchema = z.object({
  ...approvalMetaSchema,
  markupIds: z.array(z.string().min(1)).min(1),
  page: z.number().int().positive().optional(),
});

export const linkCatalogSchema = z.object({
  ...approvalMetaSchema,
  links: z.array(z.object({
    markupId: z.string().min(1),
    productId: z.string().min(1),
    page: z.number().int().positive().optional(),
  })).min(1),
});

export const activateEditorToolSchema = z.object({
  description: z.string().min(1).optional(),
  tool: z.string().min(1),
});

export const applyMaterialCountAdjustmentsSchema = z.object({
  ...approvalMetaSchema,
  adjustments: z.array(z.object({
    productId: z.string().min(1),
    delta: z.number().finite().optional(),
    absoluteCount: z.number().finite().optional(),
    page: z.number().int().positive().optional(),
    note: z.string().optional(),
  }).refine(
    (row) => row.delta != null || row.absoluteCount != null,
    { message: 'Each adjustment needs delta or absoluteCount' },
  )).min(1),
});

/** Extract the approval.payload value forwarded to canvas adapters. */
export function approvalPayloadFromPlaceMarkups(
  input: z.infer<typeof placeMarkupsSchema>,
): unknown {
  return input.markups || input.pointers || input.callouts;
}

export function approvalPayloadFromProposeCallouts(
  input: z.infer<typeof proposeCalloutsSchema>,
): unknown {
  return input.pointers;
}

export function approvalPayloadFromUpdateMarkups(
  input: z.infer<typeof updateMarkupsSchema>,
): unknown {
  return { updates: input.updates };
}

export function approvalPayloadFromDeleteMarkups(
  input: z.infer<typeof deleteMarkupsSchema>,
): unknown {
  return { markupIds: input.markupIds, page: input.page };
}

export function approvalPayloadFromLinkCatalog(
  input: z.infer<typeof linkCatalogSchema>,
): unknown {
  return { links: input.links };
}
