import type { CanvasMarkup } from '@/types/markup';

/** Only inputs to a layout, not its generated runs. Stable across array reordering. */
export function runInputSnapshot(markups: CanvasMarkup[]): string {
  return JSON.stringify(markups
    .filter(m => m.type === 'count-marker' || m.aiRun?.kind === 'keepout' || (m.aiRun?.kind === 'panel' && m.aiRun.userPlaced))
    .sort((a, b) => a.id.localeCompare(b.id)));
}
