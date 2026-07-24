import { ExternalLink } from 'lucide-react';
import { useCanvasStore } from '@/store/canvasStore';
import type { EvidenceCitation } from '@/types/assistant';

export function EvidenceCard(props: {
  title?: string;
  summary?: string;
  citations: EvidenceCitation[];
}) {
  const canvas = useCanvasStore();
  const open = (citation: EvidenceCitation) => {
    canvas.setCurrentPage(citation.page);
    const documentId = citation.documentId || canvas.activeDocId;
    if (documentId && citation.bounds) {
      canvas.setAiSelectionRect(documentId, citation.page, citation.bounds);
      canvas.setAiSelectionActive(true);
    }
  };
  return (
    <div className="rounded-lg border border-border bg-secondary/20 p-2.5">
      {props.title && <div className="mb-2 text-xs font-medium">{props.title}</div>}
      {props.summary && <div className="mb-2 text-[11px] text-muted-foreground">{props.summary}</div>}
      <div className="flex flex-wrap gap-1.5">
        {props.citations.map(citation => (
          <button
            key={citation.id}
            type="button"
            onClick={() => open(citation)}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-[11px] hover:border-emerald-500/60 hover:bg-emerald-500/5"
            title={citation.snippet}
          >
            <ExternalLink className="h-3 w-3" />
            {citation.documentName ? `${citation.documentName} · ` : ''}p. {citation.page}
            {citation.confidence !== undefined && (
              <span className="text-muted-foreground">{Math.round(citation.confidence * 100)}%</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
