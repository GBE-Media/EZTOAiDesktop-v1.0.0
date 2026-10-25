/**
 * Chat Input Component
 * Input field for sending messages to the AI with attachment support
 */

import { useState, useRef, useCallback, type KeyboardEvent } from 'react';
import { Send, Image, X, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface ChatInputProps {
  onSend: (message: string, images?: string[]) => void;
  isLoading?: boolean;
  placeholder?: string;
  disabled?: boolean;
  onStop?: () => void;
  contextChips?: string[];
}

export function ChatInput({
  onSend,
  isLoading = false,
  placeholder = 'Ask about your blueprints...',
  disabled = false,
  onStop,
  contextChips = [],
}: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);

  const handleSend = useCallback(() => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && attachedImages.length === 0) return;
    if (isLoading || disabled) return;
    
    onSend(trimmedMessage, attachedImages.length > 0 ? attachedImages : undefined);
    historyRef.current = [trimmedMessage, ...historyRef.current.filter(item => item !== trimmedMessage)].slice(0, 30);
    historyIndexRef.current = -1;
    setMessage('');
    setAttachedImages([]);
    
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [message, attachedImages, onSend, isLoading, disabled]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === 'ArrowUp' && !message && historyRef.current.length) {
      e.preventDefault();
      historyIndexRef.current = Math.min(historyIndexRef.current + 1, historyRef.current.length - 1);
      setMessage(historyRef.current[historyIndexRef.current]);
    } else if (e.key === 'ArrowDown' && historyIndexRef.current >= 0) {
      e.preventDefault();
      historyIndexRef.current -= 1;
      setMessage(historyIndexRef.current >= 0 ? historyRef.current[historyIndexRef.current] : '');
    }
  }, [handleSend, message]);

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
    
    // Auto-resize textarea
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  };

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    
    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) return;
      
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result as string;
        setAttachedImages(prev => [...prev, base64]);
      };
      reader.readAsDataURL(file);
    });
    
    // Reset input
    e.target.value = '';
  }, []);

  const removeImage = useCallback((index: number) => {
    setAttachedImages(prev => prev.filter((_, i) => i !== index));
  }, []);

  const canSend = (message.trim() || attachedImages.length > 0) && !isLoading && !disabled;

  return (
    <div className="border-t border-border bg-background p-3">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1 rounded-2xl border border-border bg-secondary/20 px-3 py-2 shadow-sm focus-within:ring-2 focus-within:ring-ring">
          {contextChips.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {contextChips.map(chip => (
                <span
                  key={chip}
                  className="rounded-full bg-background/80 px-2 py-0.5 text-[10px] text-muted-foreground"
                >
                  {chip}
                </span>
              ))}
            </div>
          )}
          {attachedImages.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachedImages.map((img, i) => (
                <div key={i} className="group relative">
                  <img
                    src={img}
                    alt={`Attachment ${i + 1}`}
                    className="h-14 w-14 rounded-xl border border-border object-cover"
                  />
                  <button
                    onClick={() => removeImage(i)}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-1">
            <Textarea
              ref={textareaRef}
              value={message}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={disabled}
              className={cn(
                'min-h-[40px] max-h-[200px] flex-1 resize-none border-0 bg-transparent p-0 shadow-none',
                'focus-visible:ring-0',
              )}
              rows={1}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              title="Attach image"
            >
              <Image className="h-4 w-4" />
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>
        </div>
        {isLoading && onStop ? (
          <Button
            onClick={onStop}
            size="icon"
            variant="destructive"
            className="h-10 w-10 shrink-0 rounded-xl"
            title="Stop assistant"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </Button>
        ) : (
          <Button
            onClick={handleSend}
            disabled={!canSend}
            size="icon"
            className={cn(
              'h-10 w-10 shrink-0 rounded-xl',
              canSend && 'bg-foreground text-background hover:bg-foreground/90',
            )}
            title="Send"
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
