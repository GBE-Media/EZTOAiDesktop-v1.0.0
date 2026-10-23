import { beforeEach, describe, expect, it } from 'vitest';
import { cacheClearAll, cacheGet, cacheSet, cacheTextPageCount, PAGE_CACHE_LIMIT } from './pageCache';

describe('pageCache LRU', () => {
  beforeEach(() => cacheClearAll());

  it('evicts old text pages but getters still work (miss is empty, then re-extract)', () => {
    for (let page = 1; page <= PAGE_CACHE_LIMIT + 5; page++) {
      cacheSet('text', 'doc-a', page, [{ page }]);
    }
    expect(cacheTextPageCount('doc-a')).toBe(PAGE_CACHE_LIMIT);
    expect(cacheGet('text', 'doc-a', 1)).toBeUndefined();
    cacheSet('text', 'doc-a', 1, [{ page: 1, restored: true }]);
    expect(cacheGet('text', 'doc-a', 1)).toEqual([{ page: 1, restored: true }]);
  });
});
