/**
 * AI Toolbar Component
 * Quick actions for trade selection, placement mode, and common operations
 */

import { Zap, ZapOff, Settings, Trash2, CheckCircle2, XCircle, Wand2 } from 'lucide-react';
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
import { useAIChatStore, type PlacementMode } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import type { TradeType } from '@/services/ai/providers/types';
import { cn } from '@/lib/utils';

interface AiToolbarProps {
  onOpenSettings?: () => void;
  onClearChat?: () => void;
  onRunTakeoff?: () => void;
}

const TRADE_OPTIONS: { value: TradeType; label: string; color: string }[] = [
  { value: 'electrical', label: 'Electrical', color: 'bg-orange-500' },
  { value: 'plumbing', label: 'Plumbing', color: 'bg-blue-500' },
  { value: 'hvac', label: 'HVAC', color: 'bg-green-500' },
];

export function AiToolbar({ onOpenSettings, onClearChat, onRunTakeoff }: AiToolbarProps) {
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
    <div className="border-b border-border bg-secondary/30">
      <div className="flex items-center gap-2 p-2">
        {/* Trade Selector */}
        <Select
          value={selectedTrade}
          onValueChange={(value: TradeType) => setSelectedTrade(value)}
          disabled={isProcessing}
        >
          <SelectTrigger className="w-[130px] h-8 text-xs">
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
                className="h-8 gap-1.5 text-xs"
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
                className="h-8 gap-1.5 text-xs"
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

        {/* Spacer */}
        <div className="flex-1" />

        {/* Clear Chat */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={onClearChat}
                disabled={isProcessing}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear chat</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Settings */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={onOpenSettings}
              >
                <Settings className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>AI Settings</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {hasPending && (
        <div className="flex items-center gap-2 px-3 pb-2">
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
                    confirmAllAIMarkups();
                    confirmAllPlacements();
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
