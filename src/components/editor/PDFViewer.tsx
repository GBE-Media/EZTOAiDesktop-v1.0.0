import { useEffect, useRef, useState, useCallback } from 'react';
import { useCanvasStore } from '@/store/canvasStore';
import { loadPDF, renderPage, getPageDimensions } from '@/lib/pdfLoader';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

interface PDFViewerProps {
  fileUrl?: string;
  fileData?: ArrayBuffer;
  docId?: string;
}

export function PDFViewer({ fileUrl, fileData, docId }: PDFViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const {
    pdfDocuments,
    activeDocId,
    zoom,
    setPdfDocument,
    setCurrentPage,
    setPageDimensions,
  } = useCanvasStore();

  // Derive values from document data
  const currentDocData = activeDocId ? pdfDocuments[activeDocId] : null;
  const pdfDocument = currentDocData?.pdfDocument || null;
  const currentPage = currentDocData?.currentPage || 1;
  const totalPages = currentDocData?.totalPages || 0;

  // Load PDF
  useEffect(() => {
    const loadDocument = async () => {
      if (!fileUrl && !fileData) return;
      
      setLoading(true);
      setError(null);
      
      try {
        const source = fileData || fileUrl!;
        const { document, numPages } = await loadPDF(source);
        // Get first page dimensions
        const pageDimensions = await getPageDimensions(document, 1);
        // Generate a docId if not provided
        const documentId = docId || `doc-${Date.now()}`;
        setPdfDocument(documentId, document, numPages, pageDimensions.width, pageDimensions.height);
      } catch (err) {
        setError('Failed to load PDF document');
        console.error('PDF loading error:', err);
      } finally {
        setLoading(false);
      }
    };
    
    loadDocument();
  }, [fileUrl, fileData, docId, setPdfDocument]);

  // Render current page
  useEffect(() => {
    const render = async () => {
      if (!pdfDocument || !canvasRef.current) return;
      
      try {
        const scale = zoom / 100 * 1.5;
        const pageInfo = await renderPage(pdfDocument, currentPage, canvasRef.current, scale);
        setPageDimensions(pageInfo.width, pageInfo.height);
      } catch (err) {
        console.error('Page render error:', err);
      }
    };
    
    render();
  }, [pdfDocument, currentPage, zoom, setPageDimensions]);

  const goToPage = useCallback((page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  }, [totalPages, setCurrentPage]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-canvas">
        <div className="text-center text-muted-foreground">
          <Loader2 className="w-8 h-8 mx-auto mb-2 animate-spin" />
          <p className="text-sm">Loading document...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-canvas">
        <div className="text-center text-destructive">
          <p className="text-sm">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 flex flex-col items-center justify-start overflow-auto bg-canvas p-4">
      {pdfDocument && (
        <>
          {/* Page navigation */}
          <div className="flex items-center gap-2 mb-4 bg-panel rounded px-3 py-1.5">
            <button
              className="toolbar-button !w-6 !h-6"
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage <= 1}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono min-w-[80px] text-center">
              Page {currentPage} of {totalPages}
            </span>
            <button
              className="toolbar-button !w-6 !h-6"
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= totalPages}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          
          {/* PDF canvas */}
          <div className="shadow-2xl">
            <canvas ref={canvasRef} className="bg-white" />
          </div>
        </>
      )}
    </div>
  );
}
