/**
 * AI Toolbar Component
 * Quick actions for trade selection, placement mode, and common operations
 */

import { Zap, ZapOff, CheckCircle2, XCircle, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import type { TradeType } from '@/services/ai/providers/types';
import type { CanvasMarkup } from '@/types/markup';
import { cn } from '@/lib/utils';
import { PendingPlacementsReviewList } from './PendingPlacementsReviewList';

interface AiToolbarProps {
  onRunTakeoff?: () => void;
  pageSelection?: string;
  onPageSelectionChange?: (value: string) => void;
  pageSummary?: string;
}

const TRADE_OPTIONS: { value: TradeType; label: string; color: string }[] = [
  { value: 'electrical', label: 'Electrical', color: 'bg-orange-500' },
  { value: 'plumbing', label: 'Plumbing', color: 'bg-blue-500' },
  { value: 'hvac', label: 'HVAC', color: 'bg-green-500' },
];

export function AiToolbar({ onRunTakeoff, pageSelection, onPageSelectionChange, pageSummary }: AiToolbarProps) {
  const {
    selectedTrade,
    setSelectedTrade,
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
    <div className="relative border-b border-border bg-secondary/20">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5">
        {/* Trade Selector */}
        <Select
          value={selectedTrade}
          onValueChange={(value: TradeType) => setSelectedTrade(value)}
          disabled={isProcessing}
        >
          <SelectTrigger className="h-7 w-[120px] text-xs">
            <SelectValue>
              <div className="flex items-center gap-2">
                <div className={cn(
                  'w-2 h-2 rounded-full',
                  TRADE_OPTIONS.find(t => t.value === selectedTrade)?.color
                )} />
                {TRADE_OPTIONS.find(t => t.value === selectedTrade)?.label}
              </div>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {TRADE_OPTIONS.map(trade => (
              <SelectItem key={trade.value} value={trade.value}>
                <div className="flex items-center gap-2">
                  <div className={cn('w-2 h-2 rounded-full', trade.color)} />
                  {trade.label}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Placement Mode Toggle */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={placementMode === 'auto' ? 'default' : 'outline'}
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => setPlacementMode(placementMode === 'auto' ? 'confirm' : 'auto')}
                disabled={isProcessing}
              >
                {placementMode === 'auto' ? (
                  <>
                    <Zap className="w-3.5 h-3.5" />
                    Auto
                  </>
                ) : (
                  <>
                    <ZapOff className="w-3.5 h-3.5" />
                    Confirm
                  </>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {placementMode === 'auto'
                ? 'Auto-place markups on canvas'
                : 'Review and confirm markups before placing'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Run Takeoff */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="default"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={onRunTakeoff}
                disabled={isProcessing || !onRunTakeoff}
              >
                <Wand2 className="w-3.5 h-3.5" />
                Run Takeoff
              </Button>
            </TooltipTrigger>
            <TooltipContent>Analyze selected pages and suggest markups</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {typeof pageSelection === 'string' && onPageSelectionChange && (
          <input
            value={pageSelection}
            onChange={(event) => onPageSelectionChange(event.target.value)}
            placeholder="pages"
            aria-label="Pages to analyze"
            className="h-7 w-24 rounded-md border border-border bg-background px-2 text-[11px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="Pages: current, all, or 1,3-5"
          />
        )}
        {pageSummary && (
          <span className="text-[10px] text-muted-foreground">{pageSummary}</span>
        )}
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
                      // Low-confidence review-queue rows were never painted; commit them now.
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

      {/* Pipeline Progress */}
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
