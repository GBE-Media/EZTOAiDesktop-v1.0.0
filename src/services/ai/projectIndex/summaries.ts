import type { IndexedPageRecord } from './types';

export function sheetIndex(pages: IndexedPageRecord[], discipline?: string) {
  return pages
    .filter(p => p.kind === 'drawing' && p.sheetNumber)
    .filter(p => !discipline || p.discipline === discipline)
    .map(p => ({
      number: p.sheetNumber,
      title: p.sheetTitle,
      documentId: p.docId,
      documentName: p.documentName,
      page: p.page,
      pageLabel: p.label,
      discipline: p.discipline,
    }));
}

export function specIndex(pages: IndexedPageRecord[], division?: string) {
  const bySection = new Map<string, { number: string; title?: string; documentId: string; documentName: string; start: number; end: number }>();
  for (const page of pages.filter(p => p.kind === 'spec' && p.specSection)) {
    if (division && !page.specSection!.startsWith(division)) continue;
    const existing = bySection.get(`${page.docId}:${page.specSection}`);
    if (!existing) {
      bySection.set(`${page.docId}:${page.specSection}`, {
        number: page.specSection!,
        title: page.sheetTitle,
        documentId: page.docId,
        documentName: page.documentName,
        start: page.page,
        end: page.page,
      });
    } else {
      existing.end = Math.max(existing.end, page.page);
      existing.start = Math.min(existing.start, page.page);
    }
  }
  return [...bySection.values()];
}

export function compactProjectDocuments(
  docs: Array<{ id: string; name: string; pages: number }>,
  indexed: IndexedPageRecord[],
) {
  return docs.map(doc => {
    const pages = indexed.filter(p => p.docId === doc.id);
    const kinds = { drawing: 0, spec: 0, other: 0 };
    for (const page of pages) kinds[page.kind] += 1;
    return {
      id: doc.id,
      name: doc.name,
      pages: doc.pages,
      kind: kinds.spec >= kinds.drawing && kinds.spec > 0 ? 'spec' : kinds.drawing > 0 ? 'drawing' : 'other',
      kinds,
      indexed: pages.length,
      needsOcr: pages.filter(p => p.needsOcr).length,
    };
  });
}

export function formatProjectDocumentsSummary(
  docs: ReturnType<typeof compactProjectDocuments>,
  indexed: number,
  total: number,
): string {
  const lines = docs.slice(0, 12).map(doc =>
    `- ${doc.name}: ${doc.pages}p ${doc.kind} (indexed ${doc.indexed}/${doc.pages}${doc.needsOcr ? `, ${doc.needsOcr} scanned` : ''})`,
  );
  const status = total > 0
    ? `Index ${indexed}/${total} pages (${Math.round((indexed / total) * 100)}%).`
    : 'Index empty.';
  return [`${status} Do not inline page text.`, ...lines].join('\n').slice(0, 2400);
}

export function formatCitationLabel(options: {
  documentName?: string;
  sheetNumber?: string;
  specSection?: string;
  page: number;
  pageLabel?: string;
}): string {
  if (options.sheetNumber) {
    return `${options.documentName || 'Drawing'} · ${options.sheetNumber}`;
  }
  if (options.specSection) {
    return `Spec ${options.specSection} · p.${options.page}`;
  }
  return `${options.documentName || 'Document'} · ${options.pageLabel || `p.${options.page}`}`;
}
