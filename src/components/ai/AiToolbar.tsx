/**
 * Quiet AI toolbar — placement confirm/auto and pending-review actions only.
 */

import { Zap, ZapOff, CheckCircle2, XCircle } from 'lucide-react';
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
    placementMode,
    setPlacementMode,
    pendingPlacements,
    confirmAllPlacements,
    rejectAllPlacements,
    pipelineStatus,
  } = useAIChatStore();
  const { confirmAllAIMarkups, rejectAllAIMarkups } = useCanvasStore();

  const hasPending = pendingPlacements.length > 0;
  const isProcessing = pipelineStatus.isRunning;

  return (
    <div className="relative border-b border-border bg-secondary/10">
      <div className="flex flex-wrap items-center gap-1 px-3 py-1">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setPlacementMode(placementMode === 'auto' ? 'confirm' : 'auto')}
                disabled={isProcessing}
                aria-label={placementMode === 'auto' ? 'Auto place' : 'Confirm before placing'}
              >
                {placementMode === 'auto' ? <Zap className="w-3.5 h-3.5" /> : <ZapOff className="w-3.5 h-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {placementMode === 'auto' ? 'Auto-place markups' : 'Review markups before placing'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {hasPending && (
        <div className="space-y-1">
          <div className="flex items-center gap-2 px-3 pb-1">
            <span className="text-xs text-muted-foreground">
              {pendingPlacements.length} pending
            </span>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-green-500 hover:text-green-600 hover:bg-green-500/10"
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
                    <CheckCircle2 className="w-4 h-4" />
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
                    size="icon"
                    className="h-7 w-7 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                    onClick={() => {
                      rejectAllAIMarkups();
                      rejectAllPlacements();
                    }}
                  >
                    <XCircle className="w-4 h-4" />
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
        <div className="absolute left-0 right-0 bottom-0 h-1 bg-secondary overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-violet-500 to-purple-600 transition-all duration-300"
            style={{ width: `${pipelineStatus.progress}%` }}
          />
        </div>
      )}
    </div>
  );
}
