import { Bot, Eye, Calculator, MapPin, Plus, Settings2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AssistantConversation } from '@/types/assistant';
import { useAISettingsStore } from '@/store/aiSettingsStore';
import { useAIChatStore } from '@/store/aiChatStore';
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
}) {
  const pipelineModels = useAISettingsStore(state => state.pipelineModels);
  const showModelStageChips = useAISettingsStore(state => state.showModelStageChips);
  const showActivityTimeline = useAISettingsStore(state => state.showActivityTimeline);
  const showEvidenceCitations = useAISettingsStore(state => state.showEvidenceCitations);
  const setShowModelStageChips = useAISettingsStore(state => state.setShowModelStageChips);
  const setShowActivityTimeline = useAISettingsStore(state => state.setShowActivityTimeline);
  const setShowEvidenceCitations = useAISettingsStore(state => state.setShowEvidenceCitations);
  const pipelineStatus = useAIChatStore(state => state.pipelineStatus);
  const activeStage =
    pipelineStatus.isRunning && pipelineStatus.currentStage &&
    pipelineStatus.currentStage !== 'complete' &&
    pipelineStatus.currentStage !== 'error'
      ? pipelineStatus.currentStage
      : null;

  return (
    <div className="flex-shrink-0 border-b border-border px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-purple-600">
            <Bot className="h-4 w-4 text-white" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">BidveraAi Assistant</h2>
            <p className="truncate text-xs text-muted-foreground">
              {props.documentName || 'No document'} · Page {props.page} · {props.trade}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" title="Display controls">
                <Settings2 className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Chat display</DropdownMenuLabel>
              <DropdownMenuSeparator />
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
                checked={showModelStageChips}
                onCheckedChange={(checked) => setShowModelStageChips(checked === true)}
              >
                Model stage chips
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={props.onClose} title="Collapse chat panel">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {showModelStageChips && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {STAGE_META.map(({ stage, label, icon: Icon }) => {
            const selection = pipelineModels[stage];
            const isActive = activeStage === stage;
            return (
              <span
                key={stage}
                className={cn(
                  'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]',
                  isActive
                    ? 'border-violet-500/60 bg-violet-500/15 text-foreground animate-pulse'
                    : 'border-border bg-secondary/40 text-muted-foreground'
                )}
                title={`${label}: ${selection.provider} / ${selection.model}`}
              >
                <Icon className="h-3 w-3 flex-shrink-0" />
                <span className="font-medium">{label}</span>
                <span className="truncate opacity-80">{shortModelName(selection.model)}</span>
              </span>
            );
          })}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <Select value={props.conversation?.id} onValueChange={props.onSelectConversation}>
          <SelectTrigger className="h-7 flex-1 text-xs">
            <SelectValue placeholder="Select conversation" />
          </SelectTrigger>
          <SelectContent>
            {props.conversations.map(item => (
              <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon" className="h-7 w-7" onClick={props.onNewConversation} title="New conversation">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
