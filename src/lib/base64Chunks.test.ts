import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { decodeBase64Chunked, encodeBase64Chunked, sha256Hex } from './base64Chunks';

describe('chunked base64', () => {
  it('round-trips a 50 MB buffer with a matching hash', async () => {
    const bytes = new Uint8Array(50 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 1024) {
      bytes[i] = i % 251;
    }
    const expected = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    const encoded = encodeBase64Chunked(bytes);
    const decoded = decodeBase64Chunked(encoded);
    expect(decoded.length).toBe(bytes.length);
    expect(await sha256Hex(decoded)).toBe(expected);
  });
});
