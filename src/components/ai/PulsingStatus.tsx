import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAIChatStore } from '@/store/aiChatStore';
import { friendlyStatusLine } from '@/lib/assistantTurnPresentation';

const FALLBACK_STATUS_WORDS = [
  'Reading page…',
  'Analyzing…',
  'Preparing answer…',
];

/**
 * Lovable-style live status: prefers the current pipeline message / active
 * run step label, otherwise cycles through short pulsing fallbacks.
 */
export function PulsingStatus({ className }: { className?: string }) {
  const pipelineStatus = useAIChatStore(state => state.pipelineStatus);
  const runs = useAIChatStore(state => state.runs);
  const [fallbackIndex, setFallbackIndex] = useState(0);

  const activeRun = Object.values(runs).find(
    run => run.status === 'running' || run.status === 'waiting-approval'
  );
  const activeStep = activeRun?.steps.find(step => step.status === 'running');

  const liveLabel =
    (pipelineStatus.isRunning && pipelineStatus.message.trim()) ||
    activeStep?.label?.trim() ||
    activeRun?.summary?.trim() ||
    '';

  useEffect(() => {
    if (liveLabel) return;
    const timer = setInterval(() => {
      setFallbackIndex(index => (index + 1) % FALLBACK_STATUS_WORDS.length);
    }, 1800);
    return () => clearInterval(timer);
  }, [liveLabel]);

  const label = friendlyStatusLine(liveLabel || FALLBACK_STATUS_WORDS[fallbackIndex]);

  return (
    <div
      className={cn(
        'relative flex items-center gap-2 overflow-hidden text-muted-foreground',
        className,
      )}
    >
      <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-violet-500" />
      <span className="relative text-sm">
        <span className="motion-safe:animate-pulse">{label}</span>
        <span className="pointer-events-none absolute inset-0 motion-safe:animate-pulse bg-gradient-to-r from-transparent via-foreground/10 to-transparent" />
      </span>
    </div>
  );
}
