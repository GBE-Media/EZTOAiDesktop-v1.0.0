import { useState } from 'react';
import { AlertTriangle, Check, Copy, FileText, LayoutGrid } from 'lucide-react';
import { cn } from '@/lib/utils';
import { openAssistantFocus } from '@/lib/openCitation';
import type { Discrepancy, DiscrepancySide } from '@/types/assistant';
import { discrepancyAsRfi, sideLabel } from '@/lib/discrepancyText';

const SEVERITY: Record<Discrepancy['severity'], { label: string; className: string }> = {
  high: { label: 'High', className: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400' },
  medium: { label: 'Medium', className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  low: { label: 'Low', className: 'border-border bg-muted text-muted-foreground' },
};

function SideButton({ icon: Icon, kind, side }: { icon: typeof FileText; kind: string; side: DiscrepancySide }) {
  return (
    <button
      type="button"
      onClick={() => openAssistantFocus({ documentId: side.documentId, page: side.page, bounds: side.bounds, label: kind })}
      className="group w-full rounded-md border border-border bg-background p-2 text-left transition-colors hover:border-foreground/25"
    >
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground group-hover:text-foreground">
        <Icon className="h-3 w-3" />
        {kind}
        <span className="truncate font-normal normal-case tracking-normal">· {sideLabel(side)}</span>
      </div>
      <div className="mt-1 line-clamp-3 text-[11px] text-foreground">“{side.excerpt}”</div>
    </button>
  );
}

export function DiscrepancyCard({ discrepancies }: { discrepancies: Discrepancy[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (d: Discrepancy) => {
    try {
      await navigator.clipboard.writeText(discrepancyAsRfi(d));
      setCopied(d.id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  };
  return (
    <div className="space-y-2" data-testid="discrepancy-card">
      {discrepancies.map(d => (
        <div key={d.id} className="rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1 text-xs font-medium text-foreground">{d.title}</div>
            <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[10px]', SEVERITY[d.severity].className)}>
              {SEVERITY[d.severity].label}
            </span>
          </div>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            <SideButton icon={LayoutGrid} kind="Drawing" side={d.drawing} />
            <SideButton icon={FileText} kind="Spec" side={d.spec} />
          </div>
          {d.recommendation && (
            <div className="mt-2 text-[11px] text-muted-foreground">{d.recommendation}</div>
          )}
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => void copy(d)}
              className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              {copied === d.id ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied === d.id ? 'Copied' : 'Copy as RFI'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
