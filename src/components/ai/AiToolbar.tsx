/**
 * Quiet AI toolbar — placement confirm/auto and pending-review actions only.
 */

import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import type { CanvasMarkup } from '@/types/markup';
import { PendingPlacementsReviewList } from './PendingPlacementsReviewList';

export function AiToolbar() {
  const {
    pendingPlacements,
    confirmAllPlacements,
    rejectAllPlacements,
    pipelineStatus,
  } = useAIChatStore();
  const { confirmAllAIMarkups, rejectAllAIMarkups } = useCanvasStore();

  const hasPending = pendingPlacements.length > 0;
  const isProcessing = pipelineStatus.isRunning;
  // Placement mode lives in the header settings; this bar only appears when there's work to show.
  if (!hasPending && !isProcessing) return null;

  return (
    <div className="relative border-b border-border bg-secondary/10">
      {hasPending && (
        <div className="space-y-1">
          <div className="flex items-center gap-1 px-3 py-1.5">
            <span className="mr-auto text-xs text-muted-foreground">
              {pendingPlacements.length} pending
            </span>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs font-medium"
                    onClick={() => {
                      const queued = [...pendingPlacements];
                      const canvas = useCanvasStore.getState();
                      const onCanvasIds = new Set(
                        Object.values(canvas.pdfDocuments[canvas.activeDocId || '']?.markupsByPage || {})
                          .flat()
                          .map(markup => markup.id),
                      );
                      confirmAllAIMarkups();
                      confirmAllPlacements();
                      const reviewOnly = queued.filter(row => !onCanvasIds.has(row.id));
                      if (reviewOnly.length > 0) {
                        canvas.addAIMarkupBatch(
                          reviewOnly.map(row => ({
                            page: row.page,
                            markup: {
                              ...(row.data as CanvasMarkup),
                              aiPending: false,
                            },
                          })),
                          false,
                        );
                      }
                    }}
                  >
                    Confirm all
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Confirm all</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    onClick={() => {
                      rejectAllAIMarkups();
                      rejectAllPlacements();
                    }}
                  >
                    Reject all
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Reject all</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <PendingPlacementsReviewList pendingPlacements={pendingPlacements} />
        </div>
      )}

      {isProcessing && (
        <div className="absolute left-0 right-0 bottom-0 h-px bg-border overflow-hidden">
          <div
            className="h-full bg-foreground/60 transition-all duration-300"
            style={{ width: `${pipelineStatus.progress}%` }}
          />
        </div>
      )}
    </div>
  );
}
