/**
 * Per-document LRU for heavy per-page extracts. Lives outside Zustand so
 * visiting pages does not clone giant maps on every store set.
 */

export const PAGE_CACHE_LIMIT = 50;

type Bucket<T> = Map<number, T>;

const textContent = new Map<string, Bucket<unknown>>();
const textWords = new Map<string, Bucket<unknown>>();
const pageGeometry = new Map<string, Bucket<unknown>>();
const lruOrder = new Map<string, number[]>();

function touch(docId: string, page: number): void {
  const order = lruOrder.get(docId) || [];
  const next = order.filter(p => p !== page);
  next.push(page);
  while (next.length > PAGE_CACHE_LIMIT) {
    const evict = next.shift();
    if (evict == null) break;
    textContent.get(docId)?.delete(evict);
    textWords.get(docId)?.delete(evict);
    // Geometry is tiny; keep it unbounded inside the same map keyed by page.
  }
  lruOrder.set(docId, next);
}

function getBucket<T>(store: Map<string, Bucket<T>>, docId: string): Bucket<T> {
  let bucket = store.get(docId);
  if (!bucket) {
    bucket = new Map();
    store.set(docId, bucket);
  }
  return bucket;
}

export function cacheGet<T>(kind: 'text' | 'words' | 'geometry', docId: string, page: number): T | undefined {
  const store = kind === 'text' ? textContent : kind === 'words' ? textWords : pageGeometry;
  return getBucket(store, docId).get(page) as T | undefined;
}

export function cacheSet<T>(kind: 'text' | 'words' | 'geometry', docId: string, page: number, value: T): void {
  const store = kind === 'text' ? textContent : kind === 'words' ? textWords : pageGeometry;
  getBucket(store, docId).set(page, value);
  if (kind !== 'geometry') touch(docId, page);
}

export function cacheClearDoc(docId: string): void {
  textContent.delete(docId);
  textWords.delete(docId);
  pageGeometry.delete(docId);
  lruOrder.delete(docId);
}

export function cacheClearAll(): void {
  textContent.clear();
  textWords.clear();
  pageGeometry.clear();
  lruOrder.clear();
}

export function cacheTextPageCount(docId: string): number {
  return textContent.get(docId)?.size ?? 0;
}
