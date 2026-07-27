import { useAIChatStore } from '@/store/aiChatStore';
import type { ClarificationOption, ClarificationRequest } from '@/types/assistant';
import type { AgentTurnResult } from './types';
import { resolveClarificationOptions, inferClarificationStepKey } from './clarificationTemplates';

const generateClarificationId = () =>
  `clarify_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

export interface EmitClarificationOptions {
  runId: string;
  messageId: string;
  question: string;
  description?: string;
  questions?: string[];
  options?: ClarificationOption[];
  stepKey?: string;
  allowMultiSelect?: boolean;
  allowFreeform?: boolean;
}

/** Persist a clarification record, attach a question block, and park the run. */
export function emitClarificationQuestion(options: EmitClarificationOptions): ClarificationRequest {
  const store = useAIChatStore.getState();
  const primaryQuestion = options.question
    || options.questions?.[0]
    || 'What would you like me to do next?';
  const stepKey = inferClarificationStepKey(primaryQuestion, options.stepKey);
  const resolvedOptions = resolveClarificationOptions(
    primaryQuestion,
    options.options,
    stepKey,
  );

  const clarification: ClarificationRequest = {
    id: generateClarificationId(),
    runId: options.runId,
    messageId: options.messageId,
    stepKey,
    question: primaryQuestion,
    description: options.description
      || (options.questions && options.questions.length > 1
        ? options.questions.slice(1).join(' ')
        : undefined),
    options: resolvedOptions,
    allowMultiSelect: options.allowMultiSelect,
    allowFreeform: options.allowFreeform ?? true,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  store.addClarification(clarification);
  store.upsertRunStep(options.runId, {
    id: `step_clarify_${clarification.id}`,
    label: 'Waiting for your answer',
    summary: primaryQuestion.slice(0, 160),
    stage: 'clarification',
    status: 'completed',
    progress: 100,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });
  store.addMessageBlock(options.messageId, {
    id: `block_${clarification.id}`,
    type: 'question',
    clarificationId: clarification.id,
  });
  store.finishRun(options.runId, 'waiting-clarification');
  return clarification;
}

/** Attach a calm result summary when a turn finishes with actions or warnings. */
export function attachAgentResultSummary(
  messageId: string,
  result: Pick<AgentTurnResult, 'assistantMessage' | 'actionsTaken' | 'verificationSummary' | 'status' | 'finalStatus'>,
): void {
  if (result.status === 'needs_clarification' || result.status === 'needs_approval') return;
  if (result.finalStatus !== 'completed' && result.finalStatus !== 'max_steps') return;

  const actionsTaken = result.actionsTaken
    .filter(action => action.status === 'completed' || action.status === 'stub')
    .map(action => action.summary || action.title)
    .filter(Boolean)
    .slice(0, 8);

  const warnings = [
    ...(result.verificationSummary?.llm?.issues || []),
    ...(result.verificationSummary?.deterministic || [])
      .filter(item => item.status === 'failed' || item.status === 'error')
      .map(item => item.summary),
  ].filter(Boolean).slice(0, 6);

  if (!actionsTaken.length && !warnings.length) return;

  useAIChatStore.getState().addMessageBlock(messageId, {
    id: `block_result_${Date.now()}`,
    type: 'result',
    result: {
      summary: result.assistantMessage.slice(0, 400) || 'Turn complete.',
      actionsTaken: actionsTaken.length ? actionsTaken : undefined,
      warnings: warnings.length ? warnings : undefined,
    },
  });
}

export const AGENT_PROGRESS_LABELS: Record<string, string> = {
  routing: 'Routing request',
  intake: 'Reading request',
  thinking: 'Reviewing estimate context',
  running_tools: 'Running tools',
  running_tool: 'Running tool',
  verifying: 'Verifying results',
  needs_clarification: 'Waiting for clarification',
  needs_approval: 'Waiting for approval',
  completed: 'Complete',
  failed: 'Failed',
};

export function labelForAgentStatus(status: string, detail?: string): string {
  if (status === 'running_tool' && detail) return `Running ${detail}`;
  if (status === 'routing' && detail === 'intake') return AGENT_PROGRESS_LABELS.intake;
  return AGENT_PROGRESS_LABELS[status] || detail || status;
}
