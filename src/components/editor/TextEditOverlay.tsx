import { useState, useRef, useEffect } from 'react';
import { useCanvasStore } from '@/store/canvasStore';
import type { TextMarkup } from '@/types/markup';

interface TextEditOverlayProps {
  markup: TextMarkup;
  page: number;
  onClose: () => void;
  canvasOffset: { x: number; y: number };
  zoom: number;
}

export function TextEditOverlay({ markup, page, onClose, canvasOffset, zoom }: TextEditOverlayProps) {
  const [content, setContent] = useState(markup.content);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { updateMarkup } = useCanvasStore();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleBlur = () => {
    updateMarkup(page, markup.id, { content });
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleBlur();
    }
  };

  const scale = zoom / 100;
  const left = canvasOffset.x + markup.x * scale;
  const top = canvasOffset.y + markup.y * scale;
  const width = Math.max(markup.width * scale, 100);
  const height = Math.max(markup.height * scale, 30);

  return (
    <div
      className="absolute z-50"
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        minHeight: `${height}px`,
      }}
    >
      <textarea
        ref={inputRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className="w-full p-1 bg-white border-2 border-primary rounded shadow-lg focus:outline-none"
        style={{
          fontSize: `${(markup.style.fontSize || 12) * scale}px`,
          fontFamily: markup.style.fontFamily || 'Arial',
          color: markup.style.strokeColor,
          resize: 'none',
          overflow: 'auto',
          wordWrap: 'break-word',
          whiteSpace: 'pre-wrap',
          height: `${height}px`,
          minHeight: `${height}px`,
          maxHeight: `${height}px`,
        }}
      />
    </div>
  );
}
