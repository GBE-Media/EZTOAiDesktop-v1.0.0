import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/store/canvasStore';
import { pageCalibrationFromManualMeasure } from '@/services/ai/placement/pageCalibration';

describe('canvasStore page calibration isolation', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      activeDocId: 'doc-a',
      pdfDocuments: {
        'doc-a': {
          pdfDocument: {},
          totalPages: 10,
          currentPage: 2,
          zoom: 100,
          markupsByPage: {},
          originalPageWidth: 1000,
          originalPageHeight: 800,
          panOffset: { x: 0, y: 0 },
          hasViewState: false,
          originalPdfBytes: null,
          textContentByPage: {},
          textWordsByPage: {},
          ocrStatus: 'none',
          ocrProgress: 0,
        },
      },
      pageCalibrationsByDoc: {},
      scale: 1,
      scaleUnit: 'ft',
      calibration: {
        isCalibrating: false,
        point1: null,
        point2: null,
        knownDistance: 0,
        unit: 'ft',
      },
      documentSnapDataByPage: {},
      aiCalibrationSamples: {},
      aiSymbolMap: {},
    } as never);
  });

  it('calibrating page 2 does not leak scale to uncalibrated page 5', () => {
    const store = useCanvasStore.getState();
    store.setCalibrationPoint({ x: 0, y: 0 }, true);
    store.setCalibrationPoint({ x: 150, y: 0 }, false); // render-space
    // Ensure current page is 2
    useCanvasStore.setState({
      pdfDocuments: {
        ...useCanvasStore.getState().pdfDocuments,
        'doc-a': {
          ...useCanvasStore.getState().pdfDocuments['doc-a'],
          currentPage: 2,
        },
      },
    });
    useCanvasStore.getState().completeCalibration(10, 'ft');

    const page2 = useCanvasStore.getState().getPageCalibration(2);
    expect(page2.method).toBe('manual');
    expect(page2.pixelsPerUnit).toBeGreaterThan(0);
    expect(page2.unit).toBe('ft');

    const page5 = useCanvasStore.getState().getPageCalibration(5);
    expect(page5).toMatchObject({
      pageNumber: 5,
      method: 'none',
      pixelsPerUnit: null,
      unit: null,
    });
    expect(page5.pixelsPerUnit).not.toBe(page2.pixelsPerUnit);

    // Legacy document-wide scale must not be overwritten by page calibration.
    expect(useCanvasStore.getState().scale).toBe(1);
  });

  it('removeDocument clears pageCalibrationsByDoc for that document', () => {
    const cal = pageCalibrationFromManualMeasure({
      pageNumber: 1,
      pointA: { x: 0, y: 0 },
      pointB: { x: 100, y: 0 },
      knownDistance: 10,
      unit: 'ft',
    });
    useCanvasStore.setState({
      pageCalibrationsByDoc: { 'doc-a': { 1: cal } },
      documentSnapDataByPage: { 'doc-a': { 1: { lines: [], endpoints: [], intersections: [] } } },
      aiCalibrationSamples: { 'doc-a': { 1: { outlet: [{ x: 1, y: 2 }] } } },
      aiSymbolMap: { 'doc-a': { 1: { outlet: [{ x: 1, y: 2 }] } } },
    });

    useCanvasStore.getState().removeDocument('doc-a');

    const state = useCanvasStore.getState();
    expect(state.pageCalibrationsByDoc['doc-a']).toBeUndefined();
    expect(state.documentSnapDataByPage['doc-a']).toBeUndefined();
    expect(state.aiCalibrationSamples['doc-a']).toBeUndefined();
    expect(state.aiSymbolMap['doc-a']).toBeUndefined();
    expect(state.pdfDocuments['doc-a']).toBeUndefined();
  });
});
