import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  allowLocalPath,
  clearAllowedPaths,
  fileUrlForPath,
  parseByteRangeHeader,
  serveAllowedFile,
} from './fileProtocol';

async function readBody(served: Awaited<ReturnType<typeof serveAllowedFile>>): Promise<Buffer> {
  if (Buffer.isBuffer(served.body)) return served.body;
  const reader = served.body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)));
}

describe('bidvera-file protocol helpers', () => {
  let tmp: string;
  let filePath: string;

  beforeEach(() => {
    clearAllowedPaths();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bidvera-proto-'));
    filePath = path.join(tmp, 'sheet.pdf');
    fs.writeFileSync(filePath, Buffer.from('abcdefghijklmnopqrstuvwxyz'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    clearAllowedPaths();
  });

  it('rejects non-allowlisted paths', async () => {
    const url = fileUrlForPath(filePath);
    const served = await serveAllowedFile(url, null);
    expect(served.status).toBe(403);
  });

  it('serves 206 ranges for allowlisted files', async () => {
    allowLocalPath(filePath);
    const url = fileUrlForPath(filePath);
    const served = await serveAllowedFile(url, 'bytes=4-8');
    expect(served.status).toBe(206);
    expect(served.headers['Accept-Ranges']).toBe('bytes');
    expect(served.headers['Content-Range']).toBe('bytes 4-8/26');
    expect((await readBody(served)).toString()).toBe('efghi');
  });

  it('parses suffix ranges', () => {
    expect(parseByteRangeHeader('bytes=-4', 26)).toEqual({ start: 22, end: 25, size: 26 });
  });

  it('returns 416 for invalid ranges', async () => {
    const tiny = path.join(tmp, 'tiny.pdf');
    fs.writeFileSync(tiny, Buffer.from('0123456789'));
    allowLocalPath(tiny);
    const url = fileUrlForPath(tiny);
    for (const header of ['bytes=20-30', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,2-3', 'items=0-1']) {
      const served = await serveAllowedFile(url, header);
      expect(served.status, header).toBe(416);
      expect(served.headers['Content-Range']).toBe('bytes */10');
    }
  });

  it('serves 100%.pdf without double-decoding', async () => {
    const weird = path.join(tmp, '100%.pdf');
    fs.writeFileSync(weird, Buffer.from('%PDF-ok'));
    allowLocalPath(weird);
    const served = await serveAllowedFile(fileUrlForPath(weird), 'bytes=0-3');
    expect(served.status).toBe(206);
    expect((await readBody(served)).toString()).toBe('%PDF');
  });

  it('non-Range GET streams without a full Buffer body', async () => {
    allowLocalPath(filePath);
    const served = await serveAllowedFile(fileUrlForPath(filePath), null);
    expect(served.status).toBe(200);
    expect(Buffer.isBuffer(served.body)).toBe(false);
    expect((await readBody(served)).toString()).toBe('abcdefghijklmnopqrstuvwxyz');
  });

  it('rejects symlink escapes', async () => {
    const secret = path.join(tmp, 'secret.txt');
    fs.writeFileSync(secret, 'SECRET');
    const assets = path.join(tmp, 'assets');
    fs.mkdirSync(assets);
    const link = path.join(assets, 'link.pdf');
    try {
      fs.symlinkSync(secret, link);
    } catch {
      return;
    }
    allowLocalPath(assets);
    const served = await serveAllowedFile(fileUrlForPath(link), null);
    expect(served.status).toBe(403);
  });

  it('is case-sensitive on non-win32', async () => {
    if (process.platform === 'win32') return;
    allowLocalPath(filePath);
    const other = path.join(tmp, 'Sheet.PDF');
    fs.writeFileSync(other, 'OTHER');
    const served = await serveAllowedFile(fileUrlForPath(other), null);
    expect(served.status).toBe(403);
  });
});
