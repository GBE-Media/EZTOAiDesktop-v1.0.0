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
const pinnedWords = new Map<string, Set<number>>();

function touch(docId: string, page: number): void {
  const order = lruOrder.get(docId) || [];
  const next = order.filter(p => p !== page);
  next.push(page);
  const pinned = pinnedWords.get(docId) || new Set();
  while (next.length > PAGE_CACHE_LIMIT) {
    const evict = next.find(p => !pinned.has(p)) ?? next.shift();
    if (evict == null) break;
    const idx = next.indexOf(evict);
    if (idx >= 0) next.splice(idx, 1);
    if (pinned.has(evict)) continue;
    textContent.get(docId)?.delete(evict);
    textWords.get(docId)?.delete(evict);
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
  const value = getBucket(store, docId).get(page) as T | undefined;
  if (value !== undefined && kind !== 'geometry') touch(docId, page);
  return value;
}

export function cacheSet<T>(
  kind: 'text' | 'words' | 'geometry',
  docId: string,
  page: number,
  value: T,
  options?: { pin?: boolean },
): void {
  const store = kind === 'text' ? textContent : kind === 'words' ? textWords : pageGeometry;
  getBucket(store, docId).set(page, value);
  if (options?.pin && kind === 'words') {
    const set = pinnedWords.get(docId) || new Set();
    set.add(page);
    pinnedWords.set(docId, set);
  }
  if (kind !== 'geometry') touch(docId, page);
}

export function cacheClearDoc(docId: string): void {
  textContent.delete(docId);
  textWords.delete(docId);
  pageGeometry.delete(docId);
  lruOrder.delete(docId);
  pinnedWords.delete(docId);
}

export function cacheClearAll(): void {
  textContent.clear();
  textWords.clear();
  pageGeometry.clear();
  lruOrder.clear();
  pinnedWords.clear();
}

export function cacheTextPageCount(docId: string): number {
  return textContent.get(docId)?.size ?? 0;
}

export function cacheWordsPageCount(docId: string): number {
  return textWords.get(docId)?.size ?? 0;
}
