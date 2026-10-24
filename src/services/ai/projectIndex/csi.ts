/** Normalize CSI section tokens: "262726", "26 27 26", "26-27-26" → "26 27 26". */
export function normalizeCsiSection(raw: string): string {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (digits.length < 6) return String(raw || '').trim();
  const core = digits.slice(0, 6);
  const rest = digits.slice(6);
  const base = `${core.slice(0, 2)} ${core.slice(2, 4)} ${core.slice(4, 6)}`;
  if (!rest) return base;
  return `${base}.${rest}`;
}

export function csiFromText(text: string): string | null {
  const spaced = text.match(/\b(\d{2})\s+(\d{2})\s+(\d{2})(?:\.(\d{2,}))?\b/);
  if (spaced) {
    return normalizeCsiSection(spaced[0]);
  }
  const dashed = text.match(/\b(\d{2})-(\d{2})-(\d{2})(?:\.(\d{2,}))?\b/);
  if (dashed) return normalizeCsiSection(dashed[0]);
  const packed = text.match(/\b(\d{6})(?:\.(\d{2,}))?\b/);
  if (packed) return normalizeCsiSection(packed[0]);
  return null;
}

export const SHEET_NUMBER_RE = /^[A-Z]{1,3}[-.]?\d{1,3}(\.\d{1,2})?[A-Z]?$/;

export function disciplineFromSheetPrefix(sheetNumber: string): string | null {
  const prefix = sheetNumber.match(/^([A-Z]{1,3})/)?.[1] || '';
  const known = ['E', 'P', 'M', 'FP', 'FA', 'T', 'A', 'S', 'C', 'L'];
  const match = known.find(code => prefix === code || prefix.startsWith(code));
  return match || prefix || null;
}
