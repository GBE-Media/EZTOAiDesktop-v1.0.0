/**
 * One assistant conversation per workspace (not per document): switching tabs keeps the same
 * chat. A saved project gets its own thread; otherwise the user's workspace thread is used.
 */
export function workspaceConversationContextId(
  documents: Array<{ path?: string | null }>,
  userId?: string | null,
): string {
  const projectPath = documents.find(doc => doc.path?.toLowerCase().endsWith('.bidveraai'))?.path;
  if (projectPath) return `project:${projectPath.replace(/\\/g, '/').toLowerCase()}`;
  return userId ? `user:${userId}:workspace` : 'local:workspace';
}

export function workspaceConversationTitle(documents: Array<{ path?: string | null; name?: string }>): string {
  const project = documents.find(doc => doc.path?.toLowerCase().endsWith('.bidveraai'));
  const name = project?.path?.split(/[\\/]/).pop()?.replace(/\.bidveraai$/i, '');
  return name ? `${name} assistant` : 'Workspace assistant';
}
