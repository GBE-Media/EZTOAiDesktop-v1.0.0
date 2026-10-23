import { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  Loader2,
  XCircle,
} from 'lucide-react';
import { useAIChatStore } from '@/store/aiChatStore';
import { cn } from '@/lib/utils';
import { useCanvasStore } from '@/store/canvasStore';
import {
  friendlyStatusLine,
  friendlyToolLabel,
  looksLikeToolId,
} from '@/lib/assistantTurnPresentation';

function stepTitle(label: string, toolId?: string): string {
  if (toolId) return friendlyToolLabel(toolId);
  if (looksLikeToolId(label)) return friendlyToolLabel(label);
  return friendlyStatusLine(label);
}

export function RunStepList({ runId }: { runId: string }) {
  const run = useAIChatStore(state => state.runs[runId]);
  const setCurrentPage = useCanvasStore(state => state.setCurrentPage);
  if (!run) return null;

  return (
    <ol className="space-y-1.5">
      {run.steps.map(step => (
        <RunStepRow
          key={step.id}
          label={stepTitle(step.label, step.toolActivity?.toolId)}
          status={step.status}
          summary={step.summary ? friendlyStatusLine(step.summary) : undefined}
          error={step.error}
          toolId={step.toolActivity?.toolId}
          input={step.toolActivity?.input}
          output={step.toolActivity?.output}
          citations={step.citations}
          onCitationPage={setCurrentPage}
        />
      ))}
    </ol>
  );
}

function RunStepRow(props: {
  label: string;
  status: string;
  summary?: string;
  error?: string;
  toolId?: string;
  input?: unknown;
  output?: unknown;
  citations?: Array<{ id: string; page: number }>;
  onCitationPage: (page: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!(props.toolId || props.input != null || props.output != null || props.error);
  return (
    <li className="flex gap-2 text-xs">
      <div className="pt-0.5">
        {props.status === 'running' ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : props.status === 'error' ? (
          <XCircle className="h-3 w-3 text-destructive" />
        ) : props.status === 'completed' ? (
          <CheckCircle2 className="h-3 w-3 text-muted-foreground" />
        ) : (
          <Circle className="h-3 w-3 text-muted-foreground/60" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-muted-foreground">{props.label}</div>
        {props.summary && (
          <div className="text-[11px] text-muted-foreground/80">{props.summary}</div>
        )}
        {props.citations && props.citations.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {props.citations.map(citation => (
              <button
                key={citation.id}
                type="button"
                onClick={() => props.onCitationPage(citation.page)}
                className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-emerald-500/50"
              >
                Page {citation.page}
              </button>
            ))}
          </div>
        )}
        {hasDetail && (
          <button
            type="button"
            className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setOpen(value => !value)}
          >
            Details
            <ChevronDown className={cn('h-3 w-3 motion-safe:transition-transform', open && 'rotate-180')} />
          </button>
        )}
        {open && hasDetail && (
          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-background/80 p-2 text-[10px] text-muted-foreground">
            {props.toolId ? `${props.toolId}\n` : ''}
            {props.error ? `${props.error}\n` : ''}
            {props.input != null ? `input: ${JSON.stringify(props.input, null, 2)}\n` : ''}
            {props.output != null ? `output: ${JSON.stringify(props.output, null, 2)}` : ''}
          </pre>
        )}
      </div>
    </li>
  );
}

/** @deprecated Disclosure now lives in TurnProcessDisclosure; kept for existing imports. */
export function RunTimeline({ runId }: { runId: string }) {
  return <RunStepList runId={runId} />;
}
