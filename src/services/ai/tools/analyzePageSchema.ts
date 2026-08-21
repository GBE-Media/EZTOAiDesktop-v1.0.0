import { z } from 'zod';

export const ANALYZE_PAGE_SCOPES = ['full', 'viewport', 'selection'] as const;
export type AnalyzePageScope = (typeof ANALYZE_PAGE_SCOPES)[number];

/**
 * LLMs often emit natural-language near-misses for analyze_page.scope
 * (e.g. "full page", "whole page") even when the JSON Schema enum is correct.
 * Normalize common variants before strict enum validation.
 */
export function normalizeAnalyzePageScope(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!trimmed) return raw;

  if (ANALYZE_PAGE_SCOPES.includes(trimmed as AnalyzePageScope)) {
    return trimmed;
  }

  // "full page" / "fullpage" / "the whole page" / "entire page" → full
  if (
    trimmed === 'fullpage'
    || trimmed === 'full page'
    || trimmed === 'whole page'
    || trimmed === 'entire page'
    || trimmed === 'complete page'
    || trimmed === 'all'
    || trimmed === 'entire'
    || trimmed === 'whole'
    || /(^|\s)(full|whole|entire|complete)(\s+page)?$/.test(trimmed)
  ) {
    return 'full';
  }

  if (trimmed === 'view' || trimmed === 'visible' || trimmed === 'current view' || trimmed.includes('viewport')) {
    return 'viewport';
  }

  if (trimmed === 'selected' || trimmed === 'region' || trimmed.includes('selection')) {
    return 'selection';
  }

  return raw;
}

export const analyzePageScopeSchema = z.preprocess(
  normalizeAnalyzePageScope,
  z.enum(ANALYZE_PAGE_SCOPES).default('full'),
).describe("Analysis region. Exact values only: 'full' | 'viewport' | 'selection' (not 'full page').");

export const analyzePageInputSchema = z.object({
  page: z.number().int().positive(),
  scope: analyzePageScopeSchema,
  prompt: z.string().optional(),
});
