/** Multiple of 3 so chunked base64 concatenates without padding seams. */
const CHUNK = Math.floor((1024 * 1024) / 3) * 3;

function toBase64Chunk(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64Chunk(chunk: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(chunk, 'base64'));
  }
  const binary = atob(chunk);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Encode without one giant per-byte string. Output is still one base64 string (legacy v1). */
export function encodeBase64Chunked(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    parts.push(toBase64Chunk(bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK))));
  }
  return parts.join('');
}

/** Decode base64 in binary-sized slices. */
export function decodeBase64Chunked(base64: string): Uint8Array {
  const input = String(base64 || '').replace(/\s+/g, '');
  if (!input) return new Uint8Array(0);
  const b64Chunk = Math.floor(CHUNK / 3) * 4;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let offset = 0; offset < input.length; offset += b64Chunk) {
    const piece = fromBase64Chunk(input.slice(offset, offset + b64Chunk));
    chunks.push(piece);
    total += piece.length;
  }
  const out = new Uint8Array(total);
  let written = 0;
  for (const piece of chunks) {
    out.set(piece, written);
    written += piece.length;
  }
  return out;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('crypto');
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}
