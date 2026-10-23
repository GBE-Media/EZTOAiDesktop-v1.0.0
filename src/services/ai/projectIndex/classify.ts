import { csiFromText, disciplineFromSheetPrefix, SHEET_NUMBER_RE } from './csi';
import type { IndexedLine, IndexPageKind } from './types';

export function classifyPage(lines: IndexedLine[], pageWidth: number, pageHeight: number): {
  kind: IndexPageKind;
  sheetNumber?: string;
  sheetTitle?: string;
  discipline?: string;
  specSection?: string;
  articles?: Array<{ id: string; text: string }>;
} {
  const bottomRight = lines.filter(line =>
    line.bbox.x > pageWidth * 0.5 && line.bbox.y > pageHeight * 0.75,
  );
  let sheetNumber: string | undefined;
  let sheetTitle: string | undefined;
  for (const line of bottomRight) {
    const token = line.text.trim().toUpperCase().replace(/\s+/g, '');
    const spaced = line.text.trim().toUpperCase();
    const candidate = SHEET_NUMBER_RE.test(spaced) ? spaced : (SHEET_NUMBER_RE.test(token) ? token : '');
    if (candidate) {
      sheetNumber = spaced.match(SHEET_NUMBER_RE)?.[0] || candidate;
      const near = lines
        .filter(other => Math.abs(other.bbox.y - line.bbox.y) < 36 && other !== line)
        .sort((a, b) => b.text.length - a.text.length)[0];
      sheetTitle = near?.text.trim();
      break;
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

  const joined = lines.map(l => l.text).join('\n');
  const sectionHeader = lines.find(line => /section\s+\d{2}/i.test(line.text) && csiFromText(line.text));
  const specSection = sectionHeader ? csiFromText(sectionHeader.text) : csiFromText(joined);
  const hasParts = /\bPART\s+[123]\b/i.test(joined);
  const articles: Array<{ id: string; text: string }> = [];
  for (const line of lines) {
    const article = line.text.trim().match(/^(\d+\.\d+(?:\s+[A-Z]\.)?)\s+(.+)$/);
    if (article) articles.push({ id: article[1].trim(), text: line.text.trim() });
  }

  if (specSection && (sectionHeader || hasParts || /wiring devices|fire alarm/i.test(joined))) {
    return {
      kind: 'spec',
      specSection,
      sheetTitle: sectionHeader?.text.trim(),
      articles,
    };
  }

  return { kind: 'other', articles };
}

/** A CSI section runs from its first page until the next section start on the same document. */
export function fillSpecSectionRanges<T extends {
  docId: string;
  page: number;
  kind: IndexPageKind;
  specSection?: string;
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
    let current: string | undefined;
    for (const page of list) {
      if (page.kind === 'drawing') {
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
    }
  }
  return out;
}
