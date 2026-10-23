import { csiFromText, disciplineFromSheetPrefix, SHEET_NUMBER_RE } from './csi';
import type { IndexedLine, IndexPageKind } from './types';

export const CLASSIFIER_VERSION = '2';

const TITLE_SKIP = /^(SHEET( NO\.?| NUMBER| TITLE)?|DATE|SCALE|PROJECT|DRAWN|CHECKED|REV|JOB|DRAWING)\b/i;
const SECTION_START = /^SECTION\s+\d{2}\s?\d{2}\s?\d{2}/i;
const FOOTER_CSI = /^\s*(\d{2}\s?\d{2}\s?\d{2}(?:\.\d{2})?)\s*[-–]\s*\d+/;

function fontHeight(line: IndexedLine): number {
  return line.fontHeight || line.bbox.height || 0;
}

function overlapsX(a: IndexedLine, b: IndexedLine, pad = 24): boolean {
  const a0 = a.bbox.x - pad;
  const a1 = a.bbox.x + a.bbox.width + pad;
  const b0 = b.bbox.x;
  const b1 = b.bbox.x + b.bbox.width;
  return a0 <= b1 && b0 <= a1;
}

export function classifyPage(lines: IndexedLine[], pageWidth: number, pageHeight: number): {
  kind: IndexPageKind;
  sheetNumber?: string;
  sheetTitle?: string;
  discipline?: string;
  specSection?: string;
  articles?: Array<{ id: string; text: string }>;
} {
  const titleBlock = lines.filter(line =>
    line.bbox.x > pageWidth * 0.6 && line.bbox.y > pageHeight * 0.6,
  );
  const candidates: Array<{ line: IndexedLine; number: string }> = [];
  for (const line of titleBlock) {
    const spaced = line.text.trim().toUpperCase();
    const token = spaced.replace(/\s+/g, '');
    const number = SHEET_NUMBER_RE.test(spaced)
      ? (spaced.match(SHEET_NUMBER_RE)?.[0] || spaced)
      : (SHEET_NUMBER_RE.test(token) ? token : '');
    if (number) candidates.push({ line, number });
  }

  let sheetNumber: string | undefined;
  let sheetTitle: string | undefined;
  if (candidates.length) {
    const cornerX = pageWidth;
    const cornerY = pageHeight;
    candidates.sort((a, b) => {
      const dh = fontHeight(b.line) - fontHeight(a.line);
      if (Math.abs(dh) > 0.5) return dh;
      const da = Math.hypot(cornerX - (a.line.bbox.x + a.line.bbox.width), cornerY - a.line.bbox.y);
      const db = Math.hypot(cornerX - (b.line.bbox.x + b.line.bbox.width), cornerY - b.line.bbox.y);
      return da - db;
    });
    const best = candidates[0];
    sheetNumber = best.number;
    const above = lines
      .filter(other =>
        other !== best.line
        && overlapsX(best.line, other, 80)
        && other.bbox.y < best.line.bbox.y
        && other.bbox.y > pageHeight * 0.45
        && !TITLE_SKIP.test(other.text.trim()),
      )
      .sort((a, b) => fontHeight(b) - fontHeight(a) || b.bbox.y - a.bbox.y);
    if (above[0]) {
      const first = above[0];
      const second = above.find(line =>
        line !== first
        && Math.abs(line.bbox.y - first.bbox.y) < Math.max(18, fontHeight(first) * 1.4)
        && !TITLE_SKIP.test(line.text.trim()),
      );
      sheetTitle = [first.text.trim(), second?.text.trim()].filter(Boolean).join(' ').trim();
    }
    if (!sheetTitle) {
      const nearby = titleBlock
        .filter(other =>
          other !== best.line
          && !TITLE_SKIP.test(other.text.trim())
          && !SHEET_NUMBER_RE.test(other.text.trim().replace(/\s+/g, '')),
        )
        .sort((a, b) => fontHeight(b) - fontHeight(a));
      sheetTitle = nearby[0]?.text.trim();
    }
  }

  if (sheetNumber) {
    return {
      kind: 'drawing',
      sheetNumber,
      sheetTitle,
      discipline: disciplineFromSheetPrefix(sheetNumber) || undefined,
    };
  }

  const headerFooter = lines.filter(line =>
    line.bbox.y < pageHeight * 0.15 || line.bbox.y > pageHeight * 0.88,
  );
  let specSection: string | undefined;
  let sectionTitle: string | undefined;
  for (const line of headerFooter) {
    const text = line.text.trim();
    if (SECTION_START.test(text)) {
      specSection = csiFromText(text) || undefined;
      sectionTitle = text;
      break;
    }
    const footer = text.match(FOOTER_CSI);
    if (footer) {
      specSection = csiFromText(footer[1]) || undefined;
      if (specSection) break;
    }
  }

  const distinctCsi = new Set(
    lines.map(l => csiFromText(l.text)).filter((v): v is string => !!v),
  );
  if (distinctCsi.size >= 3) {
    return { kind: 'other' };
  }

  const articles: Array<{ id: string; text: string }> = [];
  for (const line of lines) {
    const article = line.text.trim().match(/^(\d+\.\d+(?:\s+[A-Z]\.)?)\s+(.+)$/);
    if (article) articles.push({ id: article[1].trim(), text: line.text.trim() });
  }

  if (specSection) {
    return {
      kind: 'spec',
      specSection,
      sheetTitle: sectionTitle,
      articles,
    };
  }

  return { kind: 'other', articles };
}

/** A CSI section runs from its first page until the next section start or END OF SECTION. */
export function fillSpecSectionRanges<T extends {
  docId: string;
  page: number;
  kind: IndexPageKind;
  specSection?: string;
  sheetNumber?: string;
  lines?: Array<{ text: string }>;
}>(pages: T[]): T[] {
  const byDoc = new Map<string, T[]>();
  for (const page of pages) {
    const list = byDoc.get(page.docId) || [];
    list.push(page);
    byDoc.set(page.docId, list);
  }
  const out: T[] = [];
  for (const list of byDoc.values()) {
    list.sort((a, b) => a.page - b.page);
    const drawingCount = list.filter(p => p.kind === 'drawing' || p.sheetNumber).length;
    const majorityDrawing = drawingCount > list.length / 2;
    let current: string | undefined;
    for (const page of list) {
      const ended = page.lines?.some(l => /END OF SECTION/i.test(l.text));
      if (page.sheetNumber || majorityDrawing) {
        if (page.kind === 'spec') page.kind = page.sheetNumber ? 'drawing' : 'other';
        current = undefined;
        out.push(page);
        continue;
      }
      if (page.kind === 'spec' && page.specSection) current = page.specSection;
      else if (current && !page.specSection) {
        page.specSection = current;
        if (page.kind === 'other') page.kind = 'spec';
      }
      out.push(page);
      if (ended) current = undefined;
    }
  }
  return out;
}
