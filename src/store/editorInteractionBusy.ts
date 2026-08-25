import { useCanvasStore } from './canvasStore';

/**
 * Tracks select-drag / resize gestures for the AI mid-interaction guard.
 * Listeners are attached to window (or globalThis in tests) so mouseup/pointerup
 * outside the canvas still clears the flag (otherwise activate_editor_tool would
 * stay blocked).
 */

type DetachFn = () => void;

let detachEndListeners: DetachFn | null = null;

function getEventTarget(): EventTarget | null {
  if (typeof window !== 'undefined' && window) return window;
  if (typeof globalThis !== 'undefined' && (globalThis as { addEventListener?: unknown }).addEventListener) {
    return globalThis as unknown as EventTarget;
  }
  return null;
}

function detachIfListening(): void {
  if (!detachEndListeners) return;
  detachEndListeners();
  detachEndListeners = null;
}

function attachEndListeners(): void {
  if (detachEndListeners) return;
  const target = getEventTarget();
  if (!target) return;

  const onEnd = () => {
    endEditorInteraction();
  };

  target.addEventListener('pointerup', onEnd, true);
  target.addEventListener('pointercancel', onEnd, true);
  target.addEventListener('mouseup', onEnd, true);
  target.addEventListener('blur', onEnd);

  detachEndListeners = () => {
    target.removeEventListener('pointerup', onEnd, true);
    target.removeEventListener('pointercancel', onEnd, true);
    target.removeEventListener('mouseup', onEnd, true);
    target.removeEventListener('blur', onEnd);
  };
}

/** Mark interaction start and arm window-level end listeners. */
export function beginEditorInteraction(): void {
  useCanvasStore.getState().setEditorInteractionBusy(true);
  attachEndListeners();
}

/** Clear busy flag and remove window listeners. Safe to call repeatedly. */
export function endEditorInteraction(): void {
  useCanvasStore.getState().setEditorInteractionBusy(false);
  detachIfListening();
}

/** Test helper: force-clear listeners without asserting store state. */
export function resetEditorInteractionListenersForTests(): void {
  detachIfListening();
  useCanvasStore.getState().setEditorInteractionBusy(false);
}
