import type { Discrepancy, DiscrepancySide } from '@/types/assistant';

export function sideLabel(side: DiscrepancySide): string {
  const where = side.sheetNumber || (side.section ? `§${side.section}` : '') || '';
  const doc = side.documentName ? side.documentName.replace(/\.pdf$/i, '') : '';
  return [doc, where, `p.${side.page}`].filter(Boolean).join(' · ');
}

export function discrepancyAsRfi(d: Discrepancy): string {
  return [
    `RFI: ${d.title}`,
    '',
    `Drawings (${sideLabel(d.drawing)}): "${d.drawing.excerpt}"`,
    `Specifications (${sideLabel(d.spec)}): "${d.spec.excerpt}"`,
    '',
    'These documents conflict. Please confirm which requirement governs.',
    d.recommendation ? `Proposed resolution: ${d.recommendation}` : '',
  ].filter((line, i, all) => line || (i > 0 && all[i - 1])).join('\n').trim();
}
