export type PdfBytesSource =
  | { source: 'file'; path: string }
  | { source: 'memory'; bytes: ArrayBuffer };

export function isFilePdfSource(value: unknown): value is { source: 'file'; path: string } {
  return !!value && typeof value === 'object' && (value as PdfBytesSource).source === 'file'
    && typeof (value as { path?: unknown }).path === 'string';
}

export async function materializePdfBytes(source: PdfBytesSource | null | undefined): Promise<ArrayBuffer | null> {
  if (!source) return null;
  if (source.source === 'memory') return source.bytes;
  if (window.electronAPI?.readAllowedFile) {
    const result = await window.electronAPI.readAllowedFile(source.path);
    if (result?.buffer) return result.buffer;
  }
  return null;
}
