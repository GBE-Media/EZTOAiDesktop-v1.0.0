import { useEditorStore } from './editorStore';
import { useCanvasStore } from './canvasStore';

/**
 * Single source of truth for "Snap to Objects".
 * Historically editorStore.snapEnabled (UI / project settings) and
 * canvasStore.snapToObjects (actual MarkupCanvas / getSnapPoint gate) drifted —
 * UI showed ON while placement snapping stayed OFF.
 */
export function setSnapToObjectsEnabled(enabled: boolean): void {
  useEditorStore.setState({ snapEnabled: enabled });
  useCanvasStore.setState({ snapToObjects: enabled });
}

export function toggleSnapToObjectsEnabled(): boolean {
  const next = !useEditorStore.getState().snapEnabled;
  setSnapToObjectsEnabled(next);
  return next;
}

/** Keep canvas snap aligned with the editor/project setting (e.g. after load). */
export function syncCanvasSnapFromEditor(): void {
  const enabled = useEditorStore.getState().snapEnabled;
  useCanvasStore.setState({ snapToObjects: enabled });
}
