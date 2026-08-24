import { describe, expect, it } from 'vitest';
import { shouldAttachDocumentEvidence } from './documentEvidence';

describe('shouldAttachDocumentEvidence', () => {
  it('shows evidence when a page-reading tool completed this turn', () => {
    expect(shouldAttachDocumentEvidence({
      toolHistory: [{
        toolId: 'analyze_page',
        result: { status: 'completed' },
      }],
    })).toBe(true);

    expect(shouldAttachDocumentEvidence({
      toolHistory: [{
        toolId: 'getTakeoffSummary',
        result: { status: 'completed' },
      }],
    })).toBe(true);
  });

  it('hides evidence for plain conversational turns with no tools', () => {
    expect(shouldAttachDocumentEvidence({
      toolHistory: [],
    })).toBe(false);

    expect(shouldAttachDocumentEvidence({})).toBe(false);
  });

  it('hides evidence when tools ran but were not document-grounded', () => {
    expect(shouldAttachDocumentEvidence({
      toolHistory: [{
        toolId: 'place_markups',
        result: { status: 'completed' },
      }],
    })).toBe(false);
  });

  it('shows evidence when explicit evidence snippets are present (pipeline)', () => {
    expect(shouldAttachDocumentEvidence({
      toolHistory: [],
      evidenceSnippets: ['Sheet E-100 panel schedule'],
    })).toBe(true);
  });
});
