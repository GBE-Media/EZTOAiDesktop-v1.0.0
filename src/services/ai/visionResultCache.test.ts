import { describe, expect, it } from 'vitest';
import { clearVisionCache, getCachedVision, setCachedVision, visionCacheKey } from './visionResultCache';

const parts = { image: 'iVBORw0KGgo-tile-1', prompt: 'count fixtures', model: 'openai/gpt-5.6', trade: 'electrical', page: 3 };

describe('vision result cache', () => {
  it('keys on exactly what the model saw', async () => {
    const key = await visionCacheKey(parts);
    expect(await visionCacheKey({ ...parts })).toBe(key);
    expect(await visionCacheKey({ ...parts, image: `${parts.image}x` })).not.toBe(key);
    expect(await visionCacheKey({ ...parts, model: 'google/gemini-3-pro' })).not.toBe(key);
    expect(await visionCacheKey({ ...parts, prompt: 'count fixtures in zone 2' })).not.toBe(key);
  });

  it('returns an independent copy of the stored answer', async () => {
    clearVisionCache();
    const key = await visionCacheKey(parts);
    expect(getCachedVision(key)).toBeNull();
    setCachedVision(key, { page: 3, items: [], dimensions: [], text: [], symbols: [], legendTypeCodes: ['A'] } as never);
    const hit = getCachedVision(key)!;
    hit.legendTypeCodes!.push('mutated');
    expect(getCachedVision(key)?.legendTypeCodes).toEqual(['A']);
  });
});
