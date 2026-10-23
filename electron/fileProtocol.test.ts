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

  it('rejects non-allowlisted paths', () => {
    const url = fileUrlForPath(filePath);
    const served = serveAllowedFile(url, null);
    expect(served.status).toBe(403);
  });

  it('serves 206 ranges for allowlisted files', () => {
    allowLocalPath(filePath);
    const url = fileUrlForPath(filePath);
    const served = serveAllowedFile(url, 'bytes=4-8');
    expect(served.status).toBe(206);
    expect(served.headers['Accept-Ranges']).toBe('bytes');
    expect(served.headers['Content-Range']).toBe('bytes 4-8/26');
    expect(served.body.toString()).toBe('efghi');
  });

  it('parses suffix ranges', () => {
    expect(parseByteRangeHeader('bytes=-4', 26)).toEqual({ start: 22, end: 25, size: 26 });
  });
});
