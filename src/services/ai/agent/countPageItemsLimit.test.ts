import './testGlobals';
import { describe, expect, it } from 'vitest';
import { getAssistantTool } from '../tools/registry';
import { searchCatalogSchema } from '../tools/mutationSchemas';
import { registerAllAgentTools } from './tools/registerAll';
import { COUNT_ITEM_ARRAY_MAX, countItemsFromAnalysis } from './pageAnalysisCache';
import type { BlueprintAnalysisResult } from '../providers/types';

// Live E-100 run: the model called count_page_items with limit > 50 and the zod
// max(50) rejected the whole call ("Number must be less than or equal to 50").
describe('oversized limit is clamped, not rejected', () => {
  it('count_page_items schema accepts limit above 50', () => {
    registerAllAgentTools();
    const tool = getAssistantTool('count_page_items');
    expect(tool).toBeDefined();
    const parsed = tool!.schema.safeParse({ page: 1, query: 'Type A', limit: 200 });
    expect(parsed.success).toBe(true);
  });

  it('countItemsFromAnalysis caps rows at COUNT_ITEM_ARRAY_MAX when limit is larger', () => {
    const analysis = {
      page: 1,
      items: Array.from({ length: 120 }, (_, i) => ({
        id: `a${i}`,
        type: 'A',
        trade: 'electrical',
        name: 'Type A fixture',
        legendTypeCode: 'A',
        matchConfidence: 'high',
        quantity: 1,
        location: { x: (i % 12) * 8 + 2, y: Math.floor(i / 12) * 9 + 2 },
        confidence: 0.9,
      })),
      dimensions: [],
      text: [],
      symbols: [],
      legendTypeCodes: ['A'],
      legendTypeCounts: { A: 120 },
      typeCounts: { A: 120 },
    } as unknown as BlueprintAnalysisResult;
    const result = countItemsFromAnalysis(analysis, 'Type A', { limit: 200 });
    expect(result.total).toBe(120);
    expect(result.matchingItems.length).toBeLessThanOrEqual(COUNT_ITEM_ARRAY_MAX);
    expect(result.matchingItems.length).toBeGreaterThan(0);
  });

  it('search_catalog schema accepts limit above 50', () => {
    expect(searchCatalogSchema.safeParse({ query: 'led', limit: 200 }).success).toBe(true);
  });
});
