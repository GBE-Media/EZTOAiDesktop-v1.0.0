/**
 * Chat Message Component
 * Renders individual chat messages with support for AI responses and loading states
 */

import { memo } from 'react';
import { Bot, User, Loader2, AlertCircle, Zap, Eye, Calculator, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatMessage as ChatMessageType } from '@/store/aiChatStore';
import type { PipelineStage } from '@/services/ai/providers/types';

interface ChatMessageProps {
  message: ChatMessageType;
}

const StageIcon = ({ stage }: { stage?: PipelineStage }) => {
  switch (stage) {
    case 'vision':
      return <Eye className="w-3 h-3" />;
    case 'estimation':
      return <Calculator className="w-3 h-3" />;
    case 'placement':
      return <MapPin className="w-3 h-3" />;
    default:
      return <Zap className="w-3 h-3" />;
  }
};

export const ChatMessage = memo(function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  
  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <div className="px-3 py-1.5 bg-secondary/50 rounded-full text-xs text-muted-foreground">
          {message.content}
        </div>
      </div>
    );
  }
  
  return (
    <div
      className={cn(
        'flex gap-3 p-4',
        isUser ? 'bg-transparent' : 'bg-secondary/30'
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-gradient-to-br from-violet-500 to-purple-600 text-white'
        )}
      >
        {isUser ? (
          <User className="w-4 h-4" />
        ) : (
          <Bot className="w-4 h-4" />
        )}
      </div>
      
      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium">
            {isUser ? 'You' : 'EZTO AI'}
          </span>
          {message.metadata?.stage && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
              <StageIcon stage={message.metadata.stage} />
              {message.metadata.stage}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {formatTime(message.timestamp)}
          </span>
        </div>
        
        {/* Message content */}
        {message.isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Thinking...</span>
          </div>
        ) : message.error ? (
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="w-4 h-4" />
            <span className="text-sm">{message.error}</span>
          </div>
        ) : (
          <div className="text-sm whitespace-pre-wrap break-words">
            {formatContent(message.content)}
          </div>
        )}
        
        {/* Images if any */}
        {message.images && message.images.length > 0 && (
          <div className="flex gap-2 mt-2 flex-wrap">
            {message.images.map((img, i) => (
              <img
                key={i}
                src={img.startsWith('data:') ? img : `data:image/png;base64,${img}`}
                alt={`Attached image ${i + 1}`}
                className="max-w-[200px] max-h-[150px] rounded border border-border object-cover"
              />
            ))}
          </div>
        )}
        
        {/* Token usage if available */}
        {message.metadata?.tokenUsage && (
          <div className="mt-2 text-xs text-muted-foreground">
            Tokens: {message.metadata.tokenUsage.total.toLocaleString()}
          </div>
        )}
      </div>
    </div>
  );
});

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function formatContent(content: string | undefined): React.ReactNode {
  // Handle undefined/null/empty content
  if (!content) {
    return null;
  }
  
  // Simple markdown-like formatting
  // Bold: **text**
  // Code: `code`
  // Lists: - item
  
  const lines = content.split('\n');
  
  return lines.map((line, i) => {
    // Format inline code
    let formattedLine: React.ReactNode = line;
    
    // Handle code blocks
    if (line.startsWith('```')) {
      return (
        <code key={i} className="block bg-secondary/50 p-2 rounded text-xs font-mono my-1">
          {line.replace(/```/g, '')}
        </code>
      );
    }
    
    // Handle inline code
    if (line.includes('`')) {
      const parts = line.split(/(`[^`]+`)/g);
      formattedLine = parts.map((part, j) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code key={j} className="bg-secondary/50 px-1 py-0.5 rounded text-xs font-mono">
              {part.slice(1, -1)}
            </code>
          );
        }
        return part;
      });
    }
    
    // Handle bold
    if (typeof formattedLine === 'string' && formattedLine.includes('**')) {
      const parts = formattedLine.split(/(\*\*[^*]+\*\*)/g);
      formattedLine = parts.map((part, j) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={j}>{part.slice(2, -2)}</strong>;
        }
        return part;
      });
    }
    
    // Handle list items
    if (line.startsWith('- ') || line.startsWith('• ')) {
      return (
        <div key={i} className="flex gap-2">
          <span className="text-muted-foreground">•</span>
          <span>{typeof formattedLine === 'string' ? formattedLine.slice(2) : formattedLine}</span>
        </div>
      );
    }
    
    // Handle numbered lists
    const numberedMatch = line.match(/^(\d+)\.\s/);
    if (numberedMatch) {
      return (
        <div key={i} className="flex gap-2">
          <span className="text-muted-foreground w-4">{numberedMatch[1]}.</span>
          <span>{line.slice(numberedMatch[0].length)}</span>
        </div>
      );
    }
    
    return (
      <div key={i}>
        {formattedLine}
        {i < lines.length - 1 && line === '' && <br />}
      </div>
    );
  });
}
