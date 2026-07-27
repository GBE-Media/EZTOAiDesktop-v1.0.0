import { Loader2, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ProgressEventRow({
  label,
  status,
}: {
  label: string;
  status: 'running' | 'completed' | 'failed';
}) {
  return (
    <div className="my-1 flex items-center gap-2 px-0.5 text-[11px] text-muted-foreground">
      {status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
      {status === 'completed' && <Check className="h-3 w-3 text-emerald-600" />}
      {status === 'failed' && <X className="h-3 w-3 text-destructive" />}
      <span className={cn(status === 'failed' && 'text-destructive')}>{label}</span>
    </div>
  );
}
