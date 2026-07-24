import { useAIChatStore } from '@/store/aiChatStore';
import type { PipelineProgress } from './pipeline';
import type { RunStep } from '@/types/assistant';

const MAX_TOOL_ITERATIONS = 8;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const activeControllers = new Map<string, AbortController>();

const stepIdFromLabel = (label: string) =>
  `step_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;

export interface AssistantOperationContext {
  runId: string;
  signal: AbortSignal;
  report: (step: Omit<RunStep, 'id'> & { id?: string }) => void;
  reportPipelineProgress: (progress: PipelineProgress) => void;
  claimToolIteration: (signature: string) => void;
}

export async function runAssistantOperation<T>(options: {
  messageId: string;
  summary: string;
  timeoutMs?: number;
  operation: (context: AssistantOperationContext) => Promise<T>;
}): Promise<T> {
  const store = useAIChatStore.getState();
  const runId = store.createRun(options.messageId, options.summary);
  const controller = new AbortController();
  activeControllers.set(runId, controller);
  const signatures = new Set<string>();
  let iterations = 0;
  const timeout = setTimeout(() => controller.abort('Assistant operation timed out'), options.timeoutMs || DEFAULT_TIMEOUT_MS);

  const report = (step: Omit<RunStep, 'id'> & { id?: string }) => {
    useAIChatStore.getState().upsertRunStep(runId, {
      ...step,
      id: step.id || stepIdFromLabel(step.label),
    });
  };

  report({
    id: 'step_plan',
    label: 'Plan task',
    summary: options.summary,
    stage: 'planning',
    status: 'completed',
    progress: 100,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });

  try {
    const result = await options.operation({
      runId,
      signal: controller.signal,
      report,
      reportPipelineProgress: progress => {
        const status = progress.stage === 'error'
          ? 'error'
          : progress.stage === 'complete'
            ? 'completed'
            : 'running';
        report({
          id: `step_${progress.stage}`,
          label: progress.message || progress.stage,
          stage: progress.stage === 'error' ? 'tool' : progress.stage,
          status,
          progress: progress.progress,
          startedAt: new Date().toISOString(),
          completedAt: status === 'completed' ? new Date().toISOString() : undefined,
        });
      },
      claimToolIteration: signature => {
        iterations += 1;
        if (iterations > MAX_TOOL_ITERATIONS) {
          throw new Error(`Assistant stopped after ${MAX_TOOL_ITERATIONS} tool steps.`);
        }
        if (signatures.has(signature)) {
          throw new Error(`Assistant prevented a duplicate tool call: ${signature}`);
        }
        signatures.add(signature);
      },
    });
    useAIChatStore.getState().finishRun(runId, 'completed');
    return result;
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    useAIChatStore.getState().finishRun(runId, cancelled ? 'cancelled' : 'error', message);
    throw error;
  } finally {
    clearTimeout(timeout);
    activeControllers.delete(runId);
  }
}

export function cancelAssistantRun(runId: string): void {
  activeControllers.get(runId)?.abort('Cancelled by user');
  useAIChatStore.getState().cancelRun(runId);
}

export function registerAssistantRunController(runId: string): AbortSignal {
  const existing = activeControllers.get(runId);
  if (existing) return existing.signal;
  const controller = new AbortController();
  activeControllers.set(runId, controller);
  return controller.signal;
}

export function releaseAssistantRunController(runId: string): void {
  activeControllers.delete(runId);
}
