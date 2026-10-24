import { groupTextIntoLines } from '@/lib/pdfLoader';
import { CLASSIFIER_VERSION, classifyPage, fillSpecSectionRanges, splitMidPageSection } from './classify';
import { documentFingerprint, dropIndexedDocument, loadCachedPages, markDocumentIndexing, rebindCachedPages, saveIndexedPages } from './store';
import { useIndexProgressStore } from './indexProgress';
import type { IndexedLine, IndexedPageRecord } from './types';
import { buildSearchPassages } from './searchIndex';

type PdfLike = {
  getPage: (n: number) => Promise<{ getViewport?: (opts: { scale: number }) => { width: number; height: number } }>;
  numPages: number;
  fingerprints?: string[];
  getPageLabels?: () => Promise<string[] | null>;
};

export async function indexPdfDocument(options: {
  docId: string;
  documentName: string;
  pdfDoc: PdfLike;
  yieldEveryPage?: boolean;
  signal?: AbortSignal;
  isBusy?: () => boolean;
  extractPage?: (page: number) => Promise<{ lines: IndexedLine[]; width: number; height: number; needsOcr: boolean }>;
}): Promise<IndexedPageRecord[]> {
  const docFp = documentFingerprint(options.pdfDoc);
  markDocumentIndexing(options.docId);
  const cached = await loadCachedPages(docFp, options.pdfDoc.numPages);
  if (cached.length >= options.pdfDoc.numPages) {
    return rebindCachedPages(docFp, options.docId, options.documentName, cached);
  }

  let labels: string[] | null = null;
  try {
    labels = options.pdfDoc.getPageLabels ? await options.pdfDoc.getPageLabels() : null;
  } catch {
    labels = null;
  }

  const pages: IndexedPageRecord[] = [...cached];
  const have = new Set(cached.map(p => p.page));
  let flushed = pages.length;
  let lastYield = performance.now();
  const persistedKey = new Map<number, string>();
  const rowKey = (p: IndexedPageRecord) => `${p.kind}|${p.specSection ?? ''}|${p.sheetNumber ?? ''}`;
  pageLoop: for (let page = 1; page <= options.pdfDoc.numPages; page++) {
    if (options.signal?.aborted) break pageLoop;
    while (options.isBusy?.()) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (options.signal?.aborted) break pageLoop;
    }
    if (have.has(page)) continue;
    if (options.yieldEveryPage && performance.now() - lastYield > 12) {
      await new Promise(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
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
      const pdfPage = await options.pdfDoc.getPage(page) as {
        getViewport?: (opts: { scale: number }) => {
          width: number;
          height: number;
          convertToViewportPoint?: (x: number, y: number) => [number, number] | number[];
        };
        getTextContent?: () => Promise<{
          items: Array<{ str?: string; transform?: number[]; width?: number; height?: number }>;
        }>;
      };
      const vp = pdfPage.getViewport?.({ scale: 1 });
      width = vp?.width || 612;
      height = vp?.height || 792;
      const content = pdfPage.getTextContent ? await pdfPage.getTextContent() : { items: [] };
      const items = [];
      for (const item of content.items) {
        if (!item.str?.trim() || !item.transform) continue;
        const originX = item.transform[4];
        const originY = item.transform[5];
        const pt = vp?.convertToViewportPoint?.(originX, originY);
        const x = pt ? pt[0] : originX;
        const yTop = pt ? pt[1] : (height - originY);
        const fontH = Math.hypot(item.transform[2], item.transform[3]) || item.height || 12;
        const widthPt = item.width || fontH * item.str.length * 0.5;
        items.push({
          str: item.str,
          x,
          y: yTop - fontH,
          width: widthPt,
          height: fontH,
        });
      }
      const grouped = groupTextIntoLines(items, 5);
      lines = grouped.map(line => ({
        text: line.items.map(item => item.str).join(' '),
        bbox: { x: line.x, y: line.y, width: line.width, height: line.height },
        fontHeight: Math.max(...line.items.map(item => item.height), line.height),
      }));
      needsOcr = lines.every(l => !l.text.trim());
    }
    const split = splitMidPageSection(lines);
    const allLines = lines;
    if (split) lines = split.tail;
    const classified = classifyPage(lines, width, height);
    if (split) {
      classified.kind = 'spec';
      classified.specSection = split.section;
    }
    pages.push({
      docId: options.docId,
      docFp,
      documentName: options.documentName,
      page,
      label: labels?.[page - 1],
      lines,
      text: lines.map(line => line.text).join('\n'),
      headText: split ? split.head.map(line => line.text).join('\n') : undefined,
      kind: classified.kind,
      sheetNumber: classified.sheetNumber,
      sheetTitle: classified.sheetTitle,
      discipline: classified.discipline,
      specSection: classified.specSection,
      articles: classified.articles,
      needsOcr,
      classifierVersion: CLASSIFIER_VERSION,
      passages: buildSearchPassages(allLines),
    });
    have.add(page);
    if (page % 25 === 0 || page === options.pdfDoc.numPages) {
      if (options.signal?.aborted) break pageLoop;
      const ranged = fillSpecSectionRanges([...pages]);
      await saveIndexedPages(docFp, ranged, options.docId, pages.slice(flushed));
      if (options.signal?.aborted) {
        dropIndexedDocument(options.docId);
        break pageLoop;
      }
      for (const row of pages.slice(flushed)) persistedKey.set(row.page, rowKey(row));
      flushed = pages.length;
      useIndexProgressStore.getState().setProgress(options.docId, page, options.pdfDoc.numPages);
    }
  }
  if (options.signal?.aborted) {
    dropIndexedDocument(options.docId);
    return [];
  }
  const ranged = fillSpecSectionRanges(pages);
  // Final write: only rows never flushed or whose range/kind changed after their flush.
  await saveIndexedPages(docFp, ranged, options.docId, ranged.filter(row => persistedKey.get(row.page) !== rowKey(row)));
  useIndexProgressStore.getState().setProgress(options.docId, ranged.length, options.pdfDoc.numPages);
  return rebindCachedPages(docFp, options.docId, options.documentName, ranged);
}
