/**
 * Decide whether an assistant turn should show a "Document evidence" card.
 * Only when this turn actually used document/page tools (or has explicit evidence
 * snippets) — not merely because a document happens to be open.
 */

const DOCUMENT_GROUNDED_TOOL_IDS = new Set([
  'analyze_page',
  'extract_page_text',
  'search_document',
  'getTakeoffSummary',
  'getMaterialCounts',
  'getProjectContext',
  'get_document_context',
  'inspect_markups',
  'inspectMarkups',
  'getCodeComplianceStatus',
]);

export function shouldAttachDocumentEvidence(options: {
  toolHistory?: Array<{ toolId: string; result?: { status?: string } }>;
  evidenceSnippets?: string[] | null;
}): boolean {
  const snippets = (options.evidenceSnippets || []).filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  if (snippets.length > 0) return true;

  return (options.toolHistory || []).some(entry => {
    if (!DOCUMENT_GROUNDED_TOOL_IDS.has(entry.toolId)) return false;
    const status = entry.result?.status;
    return status === 'completed' || status === 'partial';
  });
}
