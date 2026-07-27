import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAIChatStore } from '@/store/aiChatStore';

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

  const label = liveLabel || FALLBACK_STATUS_WORDS[fallbackIndex];
  const stage = pipelineStatus.currentStage;

  return (
    <div className={cn('flex items-center gap-2 text-muted-foreground', className)}>
      <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-violet-500" />
      <span className="animate-pulse text-sm">{label}</span>
      {stage && stage !== 'complete' && stage !== 'error' && (
        <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {stage}
        </span>
      )}
    </div>
  );
}
