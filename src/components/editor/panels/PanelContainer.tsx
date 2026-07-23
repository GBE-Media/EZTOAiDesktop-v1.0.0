import { useState, ReactNode } from 'react';
import { ChevronDown, ChevronRight, GripVertical, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PanelContainerProps {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  defaultCollapsed?: boolean;
  onClose?: () => void;
  className?: string;
}

export function PanelContainer({ 
  title, 
  icon, 
  children, 
  defaultCollapsed = false,
  onClose,
  className,
}: PanelContainerProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <div className={cn('flex flex-col border-b border-panel-border bg-panel', className)}>
      {/* Header */}
      <div 
        className="panel-header flex items-center gap-1 cursor-pointer select-none"
        onClick={() => setCollapsed(!collapsed)}
      >
        <GripVertical className="w-3 h-3 text-muted-foreground/50 cursor-grab" />
        {collapsed ? (
          <ChevronRight className="w-3 h-3" />
        ) : (
          <ChevronDown className="w-3 h-3" />
        )}
        {icon && <span className="text-muted-foreground">{icon}</span>}
        <span className="flex-1">{title}</span>
        {onClose && (
          <button 
            className="p-0.5 hover:bg-secondary rounded"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Content */}
      {!collapsed && (
        <div className="flex-1 min-h-0">
          {children}
        </div>
      )}
    </div>
  );
}
