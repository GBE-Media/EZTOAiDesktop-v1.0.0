import { z } from 'zod';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import type { Discrepancy, DiscrepancySide } from '@/types/assistant';
import type { AssistantToolDefinition } from '../tools/types';
import { allIndexedPages } from '../projectIndex/store';

const boundsSchema = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });

const sideSchema = z.object({
  documentId: z.string().optional(),
  page: z.number().int().positive(),
  sheetNumber: z.string().optional(),
  section: z.string().optional().describe('Spec section / article, e.g. "26 51 19 2.3.A".'),
  bounds: boundsSchema.optional(),
  excerpt: z.string().min(1).max(400).describe('Exact text from the tool result for this side.'),
});

export const flagDiscrepanciesSchema = z.object({
  discrepancies: z.array(z.object({
    title: z.string().min(1).max(160),
    severity: z.enum(['high', 'medium', 'low']),
    drawing: sideSchema.describe('The drawing side (or the first document).'),
    spec: sideSchema.describe('The spec side (or the conflicting document).'),
    recommendation: z.string().max(400).optional(),
  })).min(1).max(12),
});

/** Stable key so the same conflict is not flagged twice in a conversation. */
export function discrepancyKey(d: Pick<Discrepancy, 'title' | 'drawing' | 'spec'>): string {
  const side = (s: DiscrepancySide) => `${s.documentId || ''}:${s.page}`;
  return `${d.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}|${side(d.drawing)}|${side(d.spec)}`;
}

/** All discrepancies flagged in the current (workspace) conversation, newest first. */
export function conversationDiscrepancies(): Discrepancy[] {
  const out: Discrepancy[] = [];
  for (const message of useAIChatStore.getState().messages) {
    for (const block of message.blocks || []) {
      if (block.type === 'discrepancies') out.push(...block.discrepancies);
    }
  }
  return out.reverse();
}

function enrichSide(side: z.infer<typeof sideSchema>): DiscrepancySide | { error: string } {
  const canvas = useCanvasStore.getState();
  const documentId = side.documentId || canvas.activeDocId || undefined;
  if (!documentId || !canvas.pdfDocuments[documentId]) {
    return { error: `Unknown documentId "${side.documentId}". Use a documentId from list_documents / search results.` };
  }
  const indexed = allIndexedPages().find(row => row.docId === documentId && row.page === side.page);
  return {
    documentId,
    documentName: indexed?.documentName,
    page: side.page as number,
    sheetNumber: side.sheetNumber || indexed?.sheetNumber,
    section: side.section,
    bounds: side.bounds as DiscrepancySide['bounds'],
    excerpt: String(side.excerpt || ''),
  };
}

export function createFlagDiscrepanciesTool(): AssistantToolDefinition<typeof flagDiscrepanciesSchema> {
  return {
    id: 'flag_discrepancies',
    title: 'Flag discrepancies',
    description:
      'Call out conflicts between drawings and specs (or between sheets) as discrepancy cards the user can '
      + 'open on both sides and copy as an RFI. Use whenever you find one — device/fixture type, manufacturer, '
      + 'wiring method, conduit/wire size, mounting height, quantity, voltage, schedule vs plan. Both sides need '
      + 'real documentId/page and an exact excerpt from your tool results. Already-flagged items are skipped.',
    risk: 'read',
    requiresConfirmation: false,
    undoable: false,
    schema: flagDiscrepanciesSchema,
    execute: async (context, rawInput) => {
      const input = flagDiscrepanciesSchema.parse(rawInput);
      const known = new Set(conversationDiscrepancies().map(discrepancyKey));
      const added: Discrepancy[] = [];
      const errors: string[] = [];
      for (const row of input.discrepancies) {
        const drawing = enrichSide(row.drawing);
        const spec = enrichSide(row.spec);
        if ('error' in drawing) { errors.push(`${row.title}: ${drawing.error}`); continue; }
        if ('error' in spec) { errors.push(`${row.title}: ${spec.error}`); continue; }
        const item: Discrepancy = {
          id: `disc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          title: row.title,
          severity: row.severity,
          drawing,
          spec,
          recommendation: row.recommendation,
          createdAt: new Date().toISOString(),
        };
        const key = discrepancyKey(item);
        if (known.has(key)) continue;
        known.add(key);
        added.push(item);
      }
      if (added.length) {
        useAIChatStore.getState().addMessageBlock(context.messageId, {
          id: `block_disc_${added[0].id}`,
          type: 'discrepancies',
          discrepancies: added,
        });
      }
      const total = conversationDiscrepancies().length;
      return {
        status: errors.length && !added.length ? 'failed' : 'completed',
        summary: added.length
          ? `Flagged ${added.length} discrepanc${added.length === 1 ? 'y' : 'ies'} (${total} in this project).`
          : errors.length ? 'No discrepancies flagged.' : 'Already flagged.',
        output: { flagged: added.length, totalInProject: total, errors },
      };
    },
  };
}
