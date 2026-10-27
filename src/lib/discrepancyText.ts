import type { Discrepancy, DiscrepancySide } from '@/types/assistant';

export function sideLabel(side: DiscrepancySide): string {
  const where = side.sheetNumber || (side.section ? `§${side.section}` : '') || '';
  const doc = side.documentName ? side.documentName.replace(/\.pdf$/i, '') : '';
  return [doc, where, `p.${side.page}`].filter(Boolean).join(' · ');
}

/** "Sheet E-210 (page 93)" / "Spec section 26 05 33 (Project Manual, page 412)". */
function plainWhere(side: DiscrepancySide, kind: 'drawing' | 'spec'): string {
  const doc = side.documentName ? side.documentName.replace(/\.pdf$/i, '') : '';
  if (kind === 'spec') {
    const head = side.section ? `Specification section ${side.section}` : 'The specifications';
    return `${head} (${[doc, `page ${side.page}`].filter(Boolean).join(', ')})`;
  }
  const head = side.sheetNumber ? `Drawing sheet ${side.sheetNumber}` : 'The drawings';
  return `${head} (${[doc, `page ${side.page}`].filter(Boolean).join(', ')})`;
}

const clean = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '');
const sentence = (text: string) => {
  const t = clean(text);
  return t && !/[.?!]$/.test(t) ? `${t}.` : t;
};

/** The question the RFI asks, in plain words. */
export function discrepancyQuestion(d: Discrepancy): string {
  if (d.question) return sentence(d.question);
  return `The drawings and the specifications disagree on this item (${clean(d.title).replace(/\.$/, '')}). Which requirement should we follow?`;
}

/**
 * A ready-to-send RFI: subject, the question first, both quotes with where to find them, why it
 * matters and what we'll assume until answered — written for a person to read and reply to.
 */
export function discrepancyAsRfi(d: Discrepancy): string {
  const lines = [
    `Subject: RFI – ${clean(d.title)}`,
    '',
    'Question:',
    discrepancyQuestion(d),
    '',
    'Background:',
    `• ${plainWhere(d.drawing, 'drawing')} says: "${clean(d.drawing.excerpt)}"`,
    `• ${plainWhere(d.spec, 'spec')} says: "${clean(d.spec.excerpt)}"`,
    'These two requirements conflict, so we cannot price this item with confidence until it is clarified.',
  ];
  if (d.impact) lines.push('', 'Why it matters:', sentence(d.impact));
  if (d.recommendation) lines.push('', 'Until we hear back, we will assume:', sentence(d.recommendation));
  lines.push('', 'Please reply with which requirement governs, or provide revised direction.', '', 'Thank you.');
  return lines.join('\n');
}
