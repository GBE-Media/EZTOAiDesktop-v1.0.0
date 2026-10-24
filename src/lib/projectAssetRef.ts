export const ASSET_REL_PATH_RE = /^([^\\/]+)\.bidveraai\.files\/([a-f0-9]{64})\.pdf$/i;

export function parseAssetRelPath(relPath: string): { projectStem: string; sha256: string } {
  const m = ASSET_REL_PATH_RE.exec(relPath);
  if (!m) throw new Error('Invalid asset reference');
  return { projectStem: m[1], sha256: m[2].toLowerCase() };
}

export function resolveProjectAssetPath(projectPath: string, relPath: string): string {
  parseAssetRelPath(relPath);
  const dir = projectPath.replace(/[\\/][^\\/]+$/, '');
  const sep = projectPath.includes('\\') ? '\\' : '/';
  return `${dir}${sep}${relPath.replace(/\\/g, sep === '\\' ? '\\' : '/')}`;
}
