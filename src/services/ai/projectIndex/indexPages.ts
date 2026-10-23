import { getTextContentWithBounds, groupTextIntoLines } from '@/lib/pdfLoader';
import { classifyPage, fillSpecSectionRanges } from './classify';
import { documentFingerprint, loadCachedPages, saveIndexedPages } from './store';
import type { IndexedLine, IndexedPageRecord } from './types';

export async function indexPdfDocument(options: {
  docId: string;
  documentName: string;
  pdfDoc: { getPage: (n: number) => Promise<unknown>; numPages: number; fingerprints?: string[]; getPageLabels?: () => Promise<string[] | null> };
  yieldEveryPage?: boolean;
  extractPage?: (page: number) => Promise<{ lines: IndexedLine[]; width: number; height: number; needsOcr: boolean }>;
}): Promise<IndexedPageRecord[]> {
  const docFp = documentFingerprint(options.pdfDoc);
  const cached = await loadCachedPages(docFp);
  if (cached.length >= options.pdfDoc.numPages) return cached;

  let labels: string[] | null = null;
  try {
    labels = options.pdfDoc.getPageLabels ? await options.pdfDoc.getPageLabels() : null;
  } catch {
    labels = null;
  }

  const pages: IndexedPageRecord[] = [...cached];
  const have = new Set(cached.map(p => p.page));
  for (let page = 1; page <= options.pdfDoc.numPages; page++) {
    if (have.has(page)) continue;
    if (options.yieldEveryPage) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    let lines: IndexedLine[] = [];
    let width = 612;
    let height = 792;
    let needsOcr = false;
    if (options.extractPage) {
      const extracted = await options.extractPage(page);
      lines = extracted.lines;
      width = extracted.width;
      height = extracted.height;
      needsOcr = extracted.needsOcr;
    } else {
      const items = await getTextContentWithBounds(options.pdfDoc as never, page, 1.0);
      const grouped = groupTextIntoLines(items, 5);
      lines = grouped.map(line => ({
        text: line.items.map(item => item.str).join(' '),
        bbox: { x: line.x, y: line.y, width: line.width, height: line.height },
      }));
      needsOcr = lines.every(l => !l.text.trim());
    }
    const classified = classifyPage(lines, width, height);
    pages.push({
      docId: options.docId,
      docFp,
      documentName: options.documentName,
      page,
      label: labels?.[page - 1],
      lines,
      kind: classified.kind,
      sheetNumber: classified.sheetNumber,
      sheetTitle: classified.sheetTitle,
      discipline: classified.discipline,
      specSection: classified.specSection,
      articles: classified.articles,
      needsOcr,
    });
  }
  const ranged = fillSpecSectionRanges(pages);
  await saveIndexedPages(docFp, ranged);
  return ranged;
}
