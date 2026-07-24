import { Bot, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AssistantConversation } from '@/types/assistant';

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
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={props.onClose} title="Collapse chat panel">
          <X className="h-4 w-4" />
        </Button>
      </div>
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
