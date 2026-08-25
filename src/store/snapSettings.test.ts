import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore } from './editorStore';
import { useCanvasStore } from './canvasStore';
import {
  setSnapToObjectsEnabled,
  syncCanvasSnapFromEditor,
  toggleSnapToObjectsEnabled,
} from './snapSettings';

describe('snap settings sync (editor UI ↔ canvas placement)', () => {
  beforeEach(() => {
    useEditorStore.setState({ snapEnabled: true });
    useCanvasStore.setState({ snapToObjects: true });
  });

  it('keeps editorStore.snapEnabled and canvasStore.snapToObjects in lockstep on set', () => {
    setSnapToObjectsEnabled(false);
    expect(useEditorStore.getState().snapEnabled).toBe(false);
    expect(useCanvasStore.getState().snapToObjects).toBe(false);

    setSnapToObjectsEnabled(true);
    expect(useEditorStore.getState().snapEnabled).toBe(true);
    expect(useCanvasStore.getState().snapToObjects).toBe(true);
  });

  it('toggle flips both stores together', () => {
    expect(toggleSnapToObjectsEnabled()).toBe(false);
    expect(useEditorStore.getState().snapEnabled).toBe(false);
    expect(useCanvasStore.getState().snapToObjects).toBe(false);

    expect(toggleSnapToObjectsEnabled()).toBe(true);
    expect(useEditorStore.getState().snapEnabled).toBe(true);
    expect(useCanvasStore.getState().snapToObjects).toBe(true);
  });

  it('syncCanvasSnapFromEditor repairs a drifted canvas flag from the editor setting', () => {
    // Simulate the historical bug: UI thinks snap is ON, canvas gate is OFF.
    useEditorStore.setState({ snapEnabled: true });
    useCanvasStore.setState({ snapToObjects: false });

    syncCanvasSnapFromEditor();
    expect(useCanvasStore.getState().snapToObjects).toBe(true);

    useEditorStore.setState({ snapEnabled: false });
    useCanvasStore.setState({ snapToObjects: true });
    syncCanvasSnapFromEditor();
    expect(useCanvasStore.getState().snapToObjects).toBe(false);
  });

  it('getSnapPoint only snaps to markup anchors when snapToObjects is enabled', () => {
    useCanvasStore.getState().clearAllDocuments();
    useCanvasStore.getState().setPdfDocument('doc-snap', { _fake: true }, 1, 612, 792);
    const markups = [{
      id: 'm1',
      type: 'rectangle',
      page: 1,
      x: 100,
      y: 200,
      width: 40,
      height: 20,
      style: {
        strokeColor: '#000',
        fillColor: 'transparent',
        strokeWidth: 1,
        opacity: 1,
        fontSize: 12,
        fontFamily: 'Arial',
      },
      locked: false,
      author: 'test',
      createdAt: new Date().toISOString(),
    } as never];
    useCanvasStore.getState().setMarkupsForPage(1, markups);
    useCanvasStore.getState().updateSnapPoints(markups);

    setSnapToObjectsEnabled(false);
    const unsapped = useCanvasStore.getState().getSnapPoint({ x: 104, y: 203 });
    expect(unsapped.snapPoint).toBeNull();
    expect(unsapped.point).toEqual({ x: 104, y: 203 });

    setSnapToObjectsEnabled(true);
    const snapped = useCanvasStore.getState().getSnapPoint({ x: 104, y: 203 });
    expect(snapped.snapPoint).not.toBeNull();
    expect(snapped.point.x).toBeCloseTo(100, 5);
    expect(snapped.point.y).toBeCloseTo(200, 5);
  });
});
