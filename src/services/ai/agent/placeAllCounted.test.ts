import './testGlobals';
import { describe, expect, it } from 'vitest';
import { countItemsFromAnalysis } from './pageAnalysisCache';
import { approvalPayloadFromPlaceMarkups, placeMarkupsSchema } from '../tools/mutationSchemas';
import type { BlueprintAnalysisResult } from '../providers/types';

const analysisRef = { docId: 'doc', page: 93, revision: 0, analyzedAt: '2026-10-25T00:00:00Z', analysisId: 'an-93' };

function bigAnalysis(): BlueprintAnalysisResult {
  const confirmed = Array.from({ length: 156 }, (_, i) => ({
    id: `a${i}`, type: 'A', trade: 'electrical', name: 'Type A fixture', legendTypeCode: 'A', matchConfidence: 'high',
    quantity: 1, location: { x: (i % 13) * 7 + 2, y: Math.floor(i / 13) * 7 + 2 }, confidence: 0.9,
  }));
  const unresolved = Array.from({ length: 31 }, (_, i) => ({
    id: `u${i}`, type: 'light', trade: 'electrical', name: 'Unknown', legendTypeCode: 'no_confident_match', matchConfidence: 'low',
    quantity: 1, location: { x: 95, y: i * 3 + 1 }, confidence: 0.4,
  }));
  return {
    page: 93, items: [...confirmed, ...unresolved], dimensions: [], text: [], symbols: [],
    legendTypeCodes: ['A'], legendTypeCounts: { A: 156 }, typeCounts: { A: 156 },
  } as unknown as BlueprintAnalysisResult;
}

describe('placing a count places the confirmed items, not just the review markers', () => {
  it('allCounted expands to every counted item even when the result was trimmed', () => {
    const result = countItemsFromAnalysis(bigAnalysis(), '', { analysisRef, pageWidth: 3024, pageHeight: 2160 });
    expect(result.total).toBe(156);
    const input = placeMarkupsSchema.parse({ description: 'Place counts', page: 93, analysisRef, allCounted: true, includeReviewMarkers: true });
    const payload = approvalPayloadFromPlaceMarkups(input) as { itemIds: string[] };
    expect(payload.itemIds).toHaveLength(156 + 31);
  });

  it('review-marker-only placements from a count also get the confirmed counts', () => {
    countItemsFromAnalysis(bigAnalysis(), '', { analysisRef, pageWidth: 3024, pageHeight: 2160 });
    const reviewIds = Array.from({ length: 31 }, (_, i) => `u${i}`);
    const input = placeMarkupsSchema.parse({ description: 'Place counts', page: 93, analysisRef, itemIds: reviewIds, includeReviewMarkers: true });
    expect((approvalPayloadFromPlaceMarkups(input) as { itemIds: string[] }).itemIds).toHaveLength(187);
    const only = placeMarkupsSchema.parse({ description: 'Place counts', page: 93, analysisRef, itemIds: reviewIds, includeReviewMarkers: true, reviewOnly: true });
    expect((approvalPayloadFromPlaceMarkups(only) as { itemIds: string[] }).itemIds).toHaveLength(31);
  });
});
