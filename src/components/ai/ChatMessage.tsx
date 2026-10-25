/**
 * Chat Message Component
 * Renders individual chat messages with support for AI responses and loading states
 */

import { memo, useEffect, useRef, useState } from 'react';
import { AlertCircle, Copy, Check, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatMessage as ChatMessageType } from '@/store/aiChatStore';
import { AssistantMessageBlocks } from './AssistantMessageBlocks';
import { PulsingStatus } from './PulsingStatus';
import { Button } from '@/components/ui/button';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import { sanitizeAssistantVisibleText } from '@/services/ai/agent/assistantVisibleText';
import { humanizeToolError, textLooksLikeRawInternals } from '@/lib/assistantTurnPresentation';
import { readMarkdownTable } from '@/lib/markdownTable';

interface ChatMessageProps {
  message: ChatMessageType;
}

export const ChatMessage = memo(function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const [copied, setCopied] = useState(false);
  const [highlightedRef, setHighlightedRef] = useState<number | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setCurrentPage = useCanvasStore(state => state.setCurrentPage);
  const selectMarkup = useCanvasStore(state => state.selectMarkup);
  const getMarkupsByPage = useCanvasStore(state => state.getMarkupsByPage);
  const setAiSelectionRect = useCanvasStore(state => state.setAiSelectionRect);
  const activeDocId = useCanvasStore(state => state.activeDocId);

  useEffect(() => {
    const onHighlight = (event: Event) => {
      const detail = (event as CustomEvent<{
        ref?: number;
        messageId?: string;
      }>).detail;
      if (typeof detail?.ref !== 'number') return;
      if (detail.messageId && detail.messageId !== message.id) return;

      const hasRef =
        message.metadata?.callouts?.some(callout => callout.ref === detail.ref) ||
        (message.content || '').includes(`[${detail.ref}]`);
      if (!hasRef) return;

      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      setHighlightedRef(detail.ref);
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-callout-ref="${message.id}-${detail.ref}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      highlightTimerRef.current = setTimeout(() => setHighlightedRef(null), 1500);
    };

    window.addEventListener('bidveraai:highlight-callout-ref', onHighlight);
    return () => {
      window.removeEventListener('bidveraai:highlight-callout-ref', onHighlight);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, [message.content, message.id, message.metadata?.callouts]);

  const focusCallout = (ref: number) => {
    const markupsByPage = getMarkupsByPage();
    for (const [pageKey, pageMarkups] of Object.entries(markupsByPage)) {
      const match = pageMarkups.find(markup => markup.calloutRef === ref);
      if (!match) continue;
      const page = Number(pageKey);
      setCurrentPage(page);
      selectMarkup(match.id, false);
      if (activeDocId && 'x' in match && 'width' in match) {
        setAiSelectionRect(activeDocId, page, {
          x: match.x,
          y: match.y,
          width: match.width,
          height: match.height,
        });
      }
      return;
    }
  };

  const retry = () => {
    const messages = useAIChatStore.getState().messages;
    const index = messages.findIndex(candidate => candidate.id === message.id);
    const source = [...messages.slice(0, index)].reverse().find(candidate => candidate.role === 'user');
    if (source) {
      window.dispatchEvent(new CustomEvent('bidveraai:retry', {
        detail: { content: source.content, images: source.images },
      }));
    }
  };
  const copy = async () => {
    await navigator.clipboard.writeText(message.content || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  
  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <div className="px-3 py-1.5 bg-secondary/50 rounded-full text-xs text-muted-foreground">
          {message.content}
        </div>
      </div>
    );
  }
  
  const recovered = Boolean(message.content && message.error);
  // Plain-English errors (e.g. "No AI provider configured…") are shown as-is;
  // only raw internals (JSON, tool ids, counters) get humanized, with the raw text kept in Details.
  const errorIsRaw = message.error ? textLooksLikeRawInternals(message.error) : false;
  const errorText = message.error
    ? (errorIsRaw ? humanizeToolError(message.error) : message.error)
    : null;

  if (isUser) {
    return (
      <div className="flex justify-end px-4 py-3">
        <div className="max-w-[min(100%,36rem)] rounded-2xl bg-secondary/80 px-3.5 py-2.5 text-sm text-foreground">
          <div className="whitespace-pre-wrap break-words">
            {formatContent(message.content, {
              messageId: message.id,
              highlightedRef,
            })}
          </div>
          {message.images && message.images.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {message.images.map((img, i) => (
                <img
                  key={i}
                  src={img.startsWith('data:') ? img : `data:image/png;base64,${img}`}
                  alt={`Attached image ${i + 1}`}
                  className="max-h-[150px] max-w-[200px] rounded-xl border border-border object-cover"
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="group flex px-4 py-3">
      <div className="min-w-0 max-w-[min(100%,40rem)] flex-1">
        {message.isLoading ? (
          <PulsingStatus />
        ) : (
          <>
            {errorText && !recovered && (
              <div className="mb-2 flex items-start gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div className="min-w-0">
                  <span>{errorText}</span>
                  {errorIsRaw && (
                    <details className="mt-1 text-xs text-muted-foreground">
                      <summary className="cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">Details</summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 text-[10px]">{message.error}</pre>
                    </details>
                  )}
                </div>
              </div>
            )}
            {message.content ? (
              <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                {formatContent(message.content, {
                  messageId: message.id,
                  highlightedRef,
                  onCalloutClick: focusCallout,
                })}
              </div>
            ) : null}
          </>
        )}
        <AssistantMessageBlocks blocks={message.blocks} />
        {!message.isLoading && (
          <div className="-ml-1.5 mt-1 flex h-7 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100" title={formatTime(message.timestamp)}>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={copy} title="Copy answer">
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={retry} title="Retry">
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
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

function renderInlineSegments(
  text: string,
  options?: {
    messageId?: string;
    highlightedRef?: number | null;
    onCalloutClick?: (ref: number) => void;
  }
): React.ReactNode {
  const parts = text.split(/(\[\d+\])/g);
  return parts.map((part, index) => {
    const match = part.match(/^\[(\d+)\]$/);
    if (!match) return <span key={index}>{part}</span>;
    const ref = Number(match[1]);
    const isHighlighted = options?.highlightedRef === ref;
    return (
      <button
        key={index}
        type="button"
        data-callout-ref={options?.messageId ? `${options.messageId}-${ref}` : undefined}
        className={cn(
          'mx-0.5 inline-flex items-center rounded-sm border px-1 py-0 text-[11px] font-semibold transition-colors',
          isHighlighted
            ? 'border-emerald-500 bg-emerald-500/25 text-emerald-700 ring-2 ring-emerald-400'
            : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20'
        )}
        onClick={() => options?.onCalloutClick?.(ref)}
        title={`Focus callout [${ref}] on canvas`}
      >
        [{ref}]
      </button>
    );
  });
}

function formatContent(
  content: string | undefined,
  options?: {
    messageId?: string;
    highlightedRef?: number | null;
    onCalloutClick?: (ref: number) => void;
  }
): React.ReactNode {
  // Handle undefined/null/empty content
  if (!content) {
    return null;
  }

  // Never render internal agent protocol JSON to the end user.
  const safeContent = sanitizeAssistantVisibleText(content);
  if (!safeContent) {
    return null;
  }
  
  // Simple markdown-like formatting
  // Bold: **text**
  // Code: `code`
  // Lists: - item
  
  const lines = safeContent.split('\n');
  const nodes: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const table = readMarkdownTable(lines, i);
    if (table) {
      nodes.push(renderMarkdownTable(table, i, options));
      i = table.endIndex;
      continue;
    }
    nodes.push(formatContentLine(lines, i, options));
  }
  return nodes;
}

type FormatOptions = {
  messageId?: string;
  highlightedRef?: number | null;
  onCalloutClick?: (ref: number) => void;
};

function renderMarkdownTable(
  table: { header: string[]; rows: string[][] },
  key: number,
  options?: FormatOptions,
): React.ReactNode {
  return (
    <div key={`table-${key}`} className="my-2 overflow-x-auto rounded-lg border border-border" data-testid="chat-table">
      <table className="w-full border-collapse text-xs">
        <thead className="bg-muted/40">
          <tr>
            {table.header.map((cell, c) => (
              <th key={c} className="px-2.5 py-1.5 text-left font-medium text-foreground">
                {formatInlineText(cell, options)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r} className="border-t border-border/70">
              {table.header.map((_, c) => (
                <td key={c} className="px-2.5 py-1.5 tabular-nums text-foreground/90">
                  {formatInlineText(row[c] ?? '', options)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatInlineText(text: string, options?: FormatOptions): React.ReactNode {
  if (text.includes('**')) {
    return text.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
      part.startsWith('**') && part.endsWith('**')
        ? <strong key={j}>{renderInlineSegments(part.slice(2, -2), options)}</strong>
        : <span key={j}>{renderInlineSegments(part, options)}</span>,
    );
  }
  return renderInlineSegments(text, options);
}

function formatContentLine(lines: string[], i: number, options?: FormatOptions): React.ReactNode {
  {
    const rawLine = lines[i];
    // Markdown headings (#, ##, ###, ####) render as section titles, not literal hashes.
    const heading = rawLine.match(/^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      return (
        <div
          key={i}
          className={cn(
            'text-foreground',
            level <= 2 ? 'mt-3 mb-1 text-[15px] font-semibold' : 'mt-3 mb-0.5 text-sm font-semibold',
            i === 0 && 'mt-0',
          )}
        >
          {formatInlineText(heading[2].replace(/\*\*/g, ''), options)}
        </div>
      );
    }
    // Bullets: "-", "*", "•", "▪" — indented ones are nested.
    const bullet = rawLine.match(/^(\s*)([-*•▪])\s+(.*)$/);
    const nested = !!bullet && bullet[1].length >= 2;
    const line = bullet ? `- ${bullet[3]}` : rawLine;
    const listPrefix = bullet ? 2 : 0;
    const numberedMatch = line.match(/^(\d+)\.\s/);
    const contentLine = listPrefix
      ? line.slice(2)
      : numberedMatch
        ? line.slice(numberedMatch[0].length)
        : line;

    // Handle code blocks
    if (line.startsWith('```')) {
      return (
        <code key={i} className="block bg-secondary/50 p-2 rounded text-xs font-mono my-1">
          {line.replace(/```/g, '')}
        </code>
      );
    }

    let formattedLine: React.ReactNode = contentLine;

    // Handle inline code
    if (contentLine.includes('`')) {
      const parts = contentLine.split(/(`[^`]+`)/g);
      formattedLine = parts.map((part, j) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code key={j} className="bg-secondary/50 px-1 py-0.5 rounded text-xs font-mono">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={j}>{renderInlineSegments(part, options)}</span>;
      });
    } else if (contentLine.includes('**')) {
      const parts = contentLine.split(/(\*\*[^*]+\*\*)/g);
      formattedLine = parts.map((part, j) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={j}>{renderInlineSegments(part.slice(2, -2), options)}</strong>;
        }
        return <span key={j}>{renderInlineSegments(part, options)}</span>;
      });
    } else {
      formattedLine = renderInlineSegments(contentLine, options);
    }

    if (listPrefix) {
      return (
        <div key={i} className={cn('flex gap-2', nested && 'pl-4')}>
          <span className="text-muted-foreground">•</span>
          <span>{formattedLine}</span>
        </div>
      );
    }

    if (numberedMatch) {
      return (
        <div key={i} className="flex gap-2">
          <span className="text-muted-foreground w-4">{numberedMatch[1]}.</span>
          <span>{formattedLine}</span>
        </div>
      );
    }

    return (
      <div key={i}>
        {formattedLine}
        {i < lines.length - 1 && line === '' && <br />}
      </div>
    );
  }
}
