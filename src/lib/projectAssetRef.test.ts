import { describe, expect, it } from 'vitest';
import { parseAssetRelPath, resolveProjectAssetPath } from './projectAssetRef';

describe('project asset refs', () => {
  it('rejects crafted relPath traversal', () => {
    expect(() => parseAssetRelPath('../../secret.pdf')).toThrow(/Invalid asset reference/);
    expect(() => parseAssetRelPath('foo.bidveraai.files/not-a-hash.pdf')).toThrow(/Invalid asset reference/);
  });

  it('resolves a valid sidecar path', () => {
    const rel = 'Job.bidveraai.files/' + 'a'.repeat(64) + '.pdf';
    expect(parseAssetRelPath(rel).sha256).toHaveLength(64);
    expect(resolveProjectAssetPath('C:/proj/Job.bidveraai', rel)).toContain('Job.bidveraai.files');
  });
});
