export function documentFingerprint(pdf: { fingerprints?: string[]; numPages?: number } | null | undefined): string {
  const fp = pdf?.fingerprints?.[0] || 'unknown';
  return `${fp}:${pdf?.numPages || 0}`;
}
