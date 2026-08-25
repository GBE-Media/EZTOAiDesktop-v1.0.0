import { describe, expect, it, vi } from 'vitest';
import {
  analyzePageInputSchema,
  normalizeAnalyzePageScope,
} from './analyzePageSchema';
import { executeAssistantTool } from './registry';
import type { AssistantToolContext } from './types';

function makeContext(): AssistantToolContext {
  return {
    runId: 'run-1',
    messageId: 'message-1',
    getDocumentContext: vi.fn(() => ({ page: 3 })),
    analyzePage: vi.fn(async input => input),
    extractPageText: vi.fn(async input => ({})),
    searchDocument: vi.fn(async () => []),
    inspectCatalog: vi.fn(() => []),
    searchCatalog: vi.fn(() => ({ matches: [], noConfidentMatch: true, confidentMatches: [], message: '' })),
    inspectMarkups: vi.fn(() => []),
    navigateToPage: vi.fn(),
    activateEditorTool: vi.fn(),
    placeMarkups: vi.fn(),
    updateMarkups: vi.fn(),
    deleteMarkups: vi.fn(),
    linkCatalog: vi.fn(),
    addApproval: vi.fn(),
  };
}

describe('normalizeAnalyzePageScope', () => {
  it('keeps exact enum values', () => {
    expect(normalizeAnalyzePageScope('full')).toBe('full');
    expect(normalizeAnalyzePageScope('viewport')).toBe('viewport');
    expect(normalizeAnalyzePageScope('selection')).toBe('selection');
  });

  it('coerces the observed runtime failure "full page" and related near-misses to full', () => {
    expect(normalizeAnalyzePageScope('full page')).toBe('full');
    expect(normalizeAnalyzePageScope('Full Page')).toBe('full');
    expect(normalizeAnalyzePageScope('fullpage')).toBe('full');
    expect(normalizeAnalyzePageScope('full-page')).toBe('full');
    expect(normalizeAnalyzePageScope('whole page')).toBe('full');
    expect(normalizeAnalyzePageScope('entire page')).toBe('full');
  });

  it('coerces common viewport/selection phrasings', () => {
    expect(normalizeAnalyzePageScope('current view')).toBe('viewport');
    expect(normalizeAnalyzePageScope('selected')).toBe('selection');
  });

  it('leaves genuinely invalid values alone for the enum to reject', () => {
    expect(normalizeAnalyzePageScope('banana')).toBe('banana');
  });
});

describe('analyzePageInputSchema', () => {
  it('accepts scope "full page" and coerces it to "full" (reproduces UI validation failure)', () => {
    const parsed = analyzePageInputSchema.parse({ page: 2, scope: 'full page' });
    expect(parsed).toEqual({ page: 2, scope: 'full' });
  });

  it('accepts other near-miss variants', () => {
    expect(analyzePageInputSchema.parse({ page: 1, scope: 'whole page' }).scope).toBe('full');
    expect(analyzePageInputSchema.parse({ page: 1, scope: 'entire page' }).scope).toBe('full');
    expect(analyzePageInputSchema.parse({ page: 1, scope: 'fullpage' }).scope).toBe('full');
  });

  it('still rejects genuinely invalid scope values', () => {
    const result = analyzePageInputSchema.safeParse({ page: 1, scope: 'banana' });
    expect(result.success).toBe(false);
  });
});

describe('executeAssistantTool analyze_page scope normalization', () => {
  it('runs analyze_page when the model passes scope "full page"', async () => {
    const context = makeContext();
    const result = await executeAssistantTool(
      'analyze_page',
      { page: 2, scope: 'full page', prompt: 'count receptacles' },
      context,
    );
    expect(result.status).toBe('completed');
    expect(context.analyzePage).toHaveBeenCalledWith({
      page: 2,
      scope: 'full',
      prompt: 'count receptacles',
    });
  });
});
