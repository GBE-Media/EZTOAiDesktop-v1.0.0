import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from './canvasStore';
import {
  beginEditorInteraction,
  endEditorInteraction,
  resetEditorInteractionListenersForTests,
} from './editorInteractionBusy';

/**
 * Node vitest has no DOM window EventTarget. Provide a minimal one that
 * mirrors how beginEditorInteraction attaches capture listeners.
 */
class TestWindowTarget extends EventEmitter {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, _options?: boolean | AddEventListenerOptions) {
    const fn = typeof listener === 'function' ? listener : listener.handleEvent.bind(listener);
    this.on(type, fn);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, _options?: boolean | EventListenerOptions) {
    const fn = typeof listener === 'function' ? listener : listener.handleEvent.bind(listener);
    this.off(type, fn);
  }

  dispatchEvent(event: Event): boolean {
    this.emit(event.type, event);
    return true;
  }
}

describe('editorInteractionBusy window end listeners', () => {
  let target: TestWindowTarget;

  beforeEach(() => {
    resetEditorInteractionListenersForTests();
    target = new TestWindowTarget();
    Object.defineProperty(globalThis, 'window', {
      value: target,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    resetEditorInteractionListenersForTests();
  });

  it('clears busy when pointerup fires outside the canvas (on window)', () => {
    beginEditorInteraction();
    expect(useCanvasStore.getState().editorInteractionBusy).toBe(true);

    target.dispatchEvent(new Event('pointerup'));
    expect(useCanvasStore.getState().editorInteractionBusy).toBe(false);
  });

  it('clears busy on mouseup and does not leave listeners stuck', () => {
    beginEditorInteraction();
    target.dispatchEvent(new Event('mouseup'));
    expect(useCanvasStore.getState().editorInteractionBusy).toBe(false);

    beginEditorInteraction();
    expect(useCanvasStore.getState().editorInteractionBusy).toBe(true);
    endEditorInteraction();
    expect(useCanvasStore.getState().editorInteractionBusy).toBe(false);
  });

  it('clears busy on window blur', () => {
    beginEditorInteraction();
    target.dispatchEvent(new Event('blur'));
    expect(useCanvasStore.getState().editorInteractionBusy).toBe(false);
  });
});
