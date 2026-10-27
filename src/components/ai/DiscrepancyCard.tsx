import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Copy, FileText, LayoutGrid } from 'lucide-react';
import { cn } from '@/lib/utils';
import { openAssistantFocus } from '@/lib/openCitation';
import type { Discrepancy, DiscrepancySide } from '@/types/assistant';
import { discrepancyAsRfi, discrepancyQuestion, sideLabel } from '@/lib/discrepancyText';

const SEVERITY: Record<Discrepancy['severity'], { label: string; className: string }> = {
  high: { label: 'High impact', className: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400' },
  medium: { label: 'Medium impact', className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  low: { label: 'Low impact', className: 'border-border bg-muted text-muted-foreground' },
};

function SideQuote({ icon: Icon, heading, side }: { icon: typeof FileText; heading: string; side: DiscrepancySide }) {
  const [open, setOpen] = useState(false);
  const long = side.excerpt.length > 160;
  return (
    <div className="rounded-md border border-border bg-background p-2">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" />
        {heading}
      </div>
      <div className={cn('mt-1 text-[11px] leading-snug text-foreground', !open && long && 'line-clamp-3')}>“{side.excerpt}”</div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => openAssistantFocus({ documentId: side.documentId, page: side.page, bounds: side.bounds, label: heading })}
          className="truncate text-[10px] text-sky-600 hover:underline dark:text-sky-400"
          title="Open this on the document"
        >
          Open {sideLabel(side)}
        </button>
        {long && (
          <button type="button" onClick={() => setOpen(v => !v)} className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground">
            {open ? 'Less' : 'More'}
            <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
          </button>
        )}
      </div>
    </div>
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
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">The drawings and specs disagree</div>
              <div className="text-xs font-medium text-foreground">{d.title}</div>
            </div>
            <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[10px]', SEVERITY[d.severity].className)}>
              {SEVERITY[d.severity].label}
            </span>
          </div>
          <div className="mt-2 rounded-md bg-background/60 px-2 py-1.5 text-[11px] text-foreground">
            <span className="font-medium">Question to resolve: </span>
            {discrepancyQuestion(d)}
          </div>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            <SideQuote icon={LayoutGrid} heading="What the drawings say" side={d.drawing} />
            <SideQuote icon={FileText} heading="What the specs say" side={d.spec} />
          </div>
          {d.impact && (
            <div className="mt-2 text-[11px] text-muted-foreground"><span className="font-medium text-foreground">Why it matters: </span>{d.impact}</div>
          )}
          {d.recommendation && (
            <div className="mt-1 text-[11px] text-muted-foreground"><span className="font-medium text-foreground">Until it's answered, I'll assume: </span>{d.recommendation}</div>
          )}
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => void copy(d)}
              className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              title="Copies a ready-to-send RFI: the question, both quotes with sheet/section, and the assumption"
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
