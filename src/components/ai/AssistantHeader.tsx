import { Bot, Eye, Calculator, MapPin, Plus, Settings2, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AssistantConversation } from '@/types/assistant';
import { useAISettingsStore } from '@/store/aiSettingsStore';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasLayersStore } from '@/store/canvasLayersStore';
import { cn } from '@/lib/utils';
import type { PipelineStage } from '@/services/ai/providers/types';

function shortModelName(model: string): string {
  const parts = model.split('/');
  return parts[parts.length - 1];
}

const STAGE_META: Array<{
  stage: PipelineStage;
  label: string;
  icon: typeof Eye;
}> = [
  { stage: 'vision', label: 'Vision', icon: Eye },
  { stage: 'estimation', label: 'Estimate', icon: Calculator },
  { stage: 'placement', label: 'Place', icon: MapPin },
];

export function AssistantHeader(props: {
  conversation: AssistantConversation | null;
  conversations: AssistantConversation[];
  documentName?: string;
  page: number;
  trade: string;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onClose: () => void;
  onOpenSettings?: () => void;
  onClearChat?: () => void;
}) {
  const pipelineModels = useAISettingsStore(state => state.pipelineModels);
  const showActivityTimeline = useAISettingsStore(state => state.showActivityTimeline);
  const showEvidenceCitations = useAISettingsStore(state => state.showEvidenceCitations);
  const setShowActivityTimeline = useAISettingsStore(state => state.setShowActivityTimeline);
  const setShowEvidenceCitations = useAISettingsStore(state => state.setShowEvidenceCitations);
  const reviewAnalysisMode = useCanvasLayersStore(state => state.reviewAnalysisMode);
  const setReviewAnalysisMode = useCanvasLayersStore(state => state.setReviewAnalysisMode);
  const pipelineStatus = useAIChatStore(state => state.pipelineStatus);
  const activeStage =
    pipelineStatus.isRunning && pipelineStatus.currentStage &&
    pipelineStatus.currentStage !== 'complete' &&
    pipelineStatus.currentStage !== 'error'
      ? pipelineStatus.currentStage
      : null;

  const subtitle = [props.documentName || 'No document', `Page ${props.page}`]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex-shrink-0 border-b border-border px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-purple-600">
            <Bot className="h-3.5 w-3.5 text-white" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight text-foreground">BidveraAi</h2>
            <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={props.onNewConversation}
            title="New chat"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" title="Settings">
                <Settings2 className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Models</DropdownMenuLabel>
              <div className="space-y-1 px-2 pb-2">
                {STAGE_META.map(({ stage, label, icon: Icon }) => {
                  const selection = pipelineModels[stage];
                  const isActive = activeStage === stage;
                  return (
                    <div
                      key={stage}
                      className={cn(
                        'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground',
                        isActive && 'bg-violet-500/10 text-foreground',
                      )}
                      title={`${label}: ${selection.provider} / ${selection.model}`}
                    >
                      <Icon className="h-3 w-3 flex-shrink-0" />
                      <span className="font-medium">{label}</span>
                      <span className="truncate">{shortModelName(selection.model)}</span>
                    </div>
                  );
                })}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Display</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={showActivityTimeline}
                onCheckedChange={(checked) => setShowActivityTimeline(checked === true)}
              >
                Activity timeline
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showEvidenceCitations}
                onCheckedChange={(checked) => setShowEvidenceCitations(checked === true)}
              >
                Evidence / citations
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={reviewAnalysisMode}
                onCheckedChange={(checked) => setReviewAnalysisMode(checked === true)}
              >
                Review AI analysis
              </DropdownMenuCheckboxItem>
              {props.conversations.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Chats</DropdownMenuLabel>
                  {props.conversations.map(item => (
                    <DropdownMenuItem
                      key={item.id}
                      onSelect={() => props.onSelectConversation(item.id)}
                    >
                      {item.title}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {props.onOpenSettings && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => props.onOpenSettings?.()}>
                    AI settings…
                  </DropdownMenuItem>
                </>
              )}
              {props.onClearChat && (
                <DropdownMenuItem onSelect={() => props.onClearChat?.()}>
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  Clear chat
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={props.onClose} title="Collapse chat panel">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
