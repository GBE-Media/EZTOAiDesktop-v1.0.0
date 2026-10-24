import { AlertTriangle, CheckCircle2, ListChecks } from 'lucide-react';
import type { AssistantResultSummary } from '@/types/assistant';

export function ResultSummaryCard({ result }: { result: AssistantResultSummary }) {
  return (
    <div className="my-2 rounded-lg border border-border bg-muted/15 p-3" data-testid="result-recap">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        {/* The answer text is already the message body — never repeat it here. */}
        <div className="text-xs font-medium text-foreground">What I did</div>
      </div>

      {result.actionsTaken && result.actionsTaken.length > 0 && (
        <div className="mt-2.5 flex items-start gap-2">
          <ListChecks className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <ul className="space-y-0.5 text-[11px] text-muted-foreground">
            {result.actionsTaken.map((action, index) => (
              <li key={`${index}-${action}`}>{action}</li>
            ))}
          </ul>
        </div>
      )}

      {result.warnings && result.warnings.length > 0 && (
        <div className="mt-2.5 flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          <ul className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-500">
            {result.warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
