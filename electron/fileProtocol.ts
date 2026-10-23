import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const allowed = new Set<string>();

export function normalizeFsPath(filePath: string): string {
  return path.resolve(filePath);
}

export function allowLocalPath(filePath: string): string {
  const resolved = normalizeFsPath(filePath);
  allowed.add(resolved.toLowerCase());
  return resolved;
}

export function isAllowedLocalPath(filePath: string): boolean {
  const resolved = normalizeFsPath(filePath);
  if (allowed.has(resolved.toLowerCase())) return true;
  for (const entry of allowed) {
    const prefix = entry.endsWith(path.sep) ? entry : entry + path.sep;
    if (resolved.toLowerCase().startsWith(prefix.toLowerCase())) return true;
  }
  return false;
}

export function clearAllowedPaths(): void {
  allowed.clear();
}

export function projectAssetsDir(projectPath: string): string {
  const parsed = path.parse(projectPath);
  return path.join(parsed.dir, `${parsed.name}.bidveraai.files`);
}

export function assetDestPath(projectPath: string, sha256: string): string {
  return path.join(projectAssetsDir(projectPath), `${sha256}.pdf`);
}

export type ByteRange = { start: number; end: number; size: number };

export function parseByteRangeHeader(header: string | null | undefined, size: number): ByteRange | null {
  if (!header || size <= 0) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;
  const startRaw = match[1];
  const endRaw = match[2];
  let start = startRaw ? Number(startRaw) : NaN;
  let end = endRaw ? Number(endRaw) : NaN;
  if (!Number.isFinite(start) && Number.isFinite(end)) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end)) end = size - 1;
  }
  if (start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1), size };
}

export function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function fileUrlForPath(filePath: string): string {
  const resolved = normalizeFsPath(filePath);
  return `bidvera-file://local/?p=${encodeURIComponent(resolved)}`;
}

export type ServedFile = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

export function serveAllowedFile(requestUrl: string, rangeHeader: string | null): ServedFile {
  const filePath = pathFromFileUrl(requestUrl);
  if (!filePath || !isAllowedLocalPath(filePath)) {
    return { status: 403, headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('Forbidden') };
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('Not Found') };
  }
  const size = fs.statSync(filePath).size;
  const range = parseByteRangeHeader(rangeHeader, size);
  if (range) {
    const length = range.end - range.start + 1;
    const body = Buffer.alloc(length);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, body, 0, length, range.start);
    fs.closeSync(fd);
    return {
      status: 206,
      headers: {
        'Content-Type': 'application/pdf',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': String(length),
      },
      body,
    };
  }
  const body = fs.readFileSync(filePath);
  return {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
    },
    body,
  };
}

export function pathFromFileUrl(requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== 'bidvera-file:') return null;
    const p = url.searchParams.get('p');
    return p ? decodeURIComponent(p) : null;
  } catch {
    return null;
  }
}
