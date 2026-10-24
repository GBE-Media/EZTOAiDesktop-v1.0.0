import * as fs from 'fs';
import { Readable } from 'stream';
import * as path from 'path';
import * as crypto from 'crypto';

const allowed = new Set<string>();

export function normalizeFsPath(p: string): string {
  let r = path.resolve(p);
  try {
    r = fs.realpathSync.native(r);
  } catch {
    /* not created yet */
  }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export function allowLocalPath(filePath: string): string {
  const resolved = normalizeFsPath(filePath);
  allowed.add(resolved);
  return path.resolve(filePath);
}

export function isAllowedLocalPath(filePath: string): boolean {
  const resolved = normalizeFsPath(filePath);
  if (allowed.has(resolved)) return true;
  for (const entry of allowed) {
    const prefix = entry.endsWith(path.sep) ? entry : entry + path.sep;
    if (resolved.startsWith(prefix)) return true;
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

export const MAX_RANGE_BYTES = 16 * 1024 * 1024;

export type ByteRange = { start: number; end: number; size: number };

export function parseByteRangeHeader(header: string | null | undefined, size: number): ByteRange | 'invalid' | null {
  if (!header) return null;
  if (size <= 0) return 'invalid';
  const match = header.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return 'invalid';
  const startRaw = match[1];
  const endRaw = match[2];
  if (!startRaw && !endRaw) {
    return { start: 0, end: size - 1, size };
  }
  if (!startRaw && endRaw === '0') return 'invalid';
  let start = startRaw ? Number(startRaw) : NaN;
  let end = endRaw ? Number(endRaw) : NaN;
  if (!Number.isFinite(start) && Number.isFinite(end)) {
    if (end <= 0) return 'invalid';
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end)) end = size - 1;
  }
  if (start < 0 || end < start || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1), size };
}

export function hashBufferSha256(data: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function pdfCacheDir(userDataPath: string): string {
  return path.join(userDataPath, 'pdf-cache');
}

export function prunePdfCache(
  cacheDir: string,
  options?: { maxAgeMs?: number; maxBytes?: number; keep?: string[] },
): { deleted: string[] } {
  const maxAgeMs = options?.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const maxBytes = options?.maxBytes ?? 5 * 1024 * 1024 * 1024;
  const keep = new Set((options?.keep || []).map(p => normalizeFsPath(p)));
  if (!fs.existsSync(cacheDir)) return { deleted: [] };
  const now = Date.now();
  const entries = fs.readdirSync(cacheDir)
    .map(name => {
      const full = path.join(cacheDir, name);
      const stat = fs.statSync(full);
      return { full, stat };
    })
    .filter(entry => entry.stat.isFile());
  const deleted: string[] = [];
  for (const entry of entries) {
    if (keep.has(normalizeFsPath(entry.full))) continue;
    if (now - entry.stat.mtimeMs > maxAgeMs) {
      fs.unlinkSync(entry.full);
      deleted.push(entry.full);
    }
  }
  const remaining = entries.filter(entry => !deleted.includes(entry.full) && fs.existsSync(entry.full));
  remaining.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  let total = remaining.reduce((sum, entry) => sum + entry.stat.size, 0);
  for (const entry of remaining) {
    if (total <= maxBytes) break;
    if (keep.has(normalizeFsPath(entry.full))) continue;
    fs.unlinkSync(entry.full);
    total -= entry.stat.size;
    deleted.push(entry.full);
  }
  return { deleted };
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
  const resolved = path.resolve(filePath);
  return `bidvera-file://local/?p=${encodeURIComponent(resolved)}`;
}

export type ServedFile = {
  status: number;
  headers: Record<string, string>;
  body: Buffer | ReadableStream<Uint8Array>;
};

function rangeUnsatisfiable(size: number): ServedFile {
  return {
    status: 416,
    headers: {
      'Content-Type': 'text/plain',
      'Content-Range': `bytes */${size}`,
    },
    body: Buffer.from('Range Not Satisfiable'),
  };
}

export async function serveAllowedFile(requestUrl: string, rangeHeader: string | null): Promise<ServedFile> {
  const filePath = pathFromFileUrl(requestUrl);
  if (!filePath || !isAllowedLocalPath(filePath)) {
    return { status: 403, headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('Forbidden') };
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('Not Found') };
  }
  if (!stat.isFile()) {
    return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('Not Found') };
  }
  const size = stat.size;
  const range = parseByteRangeHeader(rangeHeader, size);
  if (range === 'invalid') return rangeUnsatisfiable(size);
  if (range) {
    const length = range.end - range.start + 1;
    if (length > MAX_RANGE_BYTES) return rangeUnsatisfiable(size);
    const nodeStream = fs.createReadStream(filePath, { start: range.start, end: range.end });
    return {
      status: 206,
      headers: {
        'Content-Type': 'application/pdf',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': String(length),
      },
      body: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
    };
  }

  const nodeStream = fs.createReadStream(filePath);
  return {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
    },
    body: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
  };
}

export function pathFromFileUrl(requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== 'bidvera-file:') return null;
    return url.searchParams.get('p');
  } catch {
    return null;
  }
}
