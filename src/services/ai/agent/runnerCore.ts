/**
 * Primary agent tool-loop core (Phase 3).
 * Kept separate from multi-model orchestration so each phase stays testable.
 */
import { flushAssistantSnapshot, useAIChatStore } from '@/store/aiChatStore';
import type { ApprovalRequest, ClarificationRequest } from '@/types/assistant';
import type { AssistantToolContext, AssistantToolResult } from '../tools/types';
import { executeAssistantTool, getAssistantTool } from '../tools/registry';
import { formatToolResultForPrompt, resolveToolSafety } from './safety';
import { sanitizeAssistantVisibleText } from './assistantVisibleText';
import { createJsonToolModelAdapter, type ModelAdapter } from './modelAdapter';
import { emitAgentTrace } from './trace';
import { runVerificationTools } from './verification';
import { toolHistoryToActivity, type AgentActionTaken, type AgentModelMessage, type AgentToolCallRequest, type AgentToolHistoryEntry, type AgentTurnResult } from './types';
import {
  registerAssistantRunController,
  releaseAssistantRunController,
} from '../assistantOrchestrator';
import { registerAllAgentTools } from './tools/registerAll';
import {
  attachAgentResultSummary,
  emitClarificationQuestion,
  labelForAgentStatus,
} from './clarification';
import {
  deleteExpiredAgentSessions,
  deletePersistedAgentSession,
  readPersistedAgentSession,
  writePersistedAgentSession,
  type PersistedAgentSessionStatus,
} from '@/db/assistantDb';
import type { AgentSessionState } from './types';

export const DEFAULT_MAX_AGENT_STEPS = 12;
const MAX_STEPS = DEFAULT_MAX_AGENT_STEPS;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PERSISTED_IMAGE_CHARS = 1_000_000;

const sessions = new Map<string, AgentSessionState>();

/**
 * Stabilize tool-call ids exactly once per decision so the assistant history
 * entry and every tool-result message share the same id.
 * - Blank/whitespace → deterministic fallback
 * - Duplicate non-blank ids within the same batch (common on JSON/free-form
 *   fallback) → keep the first occurrence; reassign later collisions so both
 *   tools execute and both results survive (dedupeToolResultsKeepLast must not
 *   collapse two different executions into one).
 *
 * Scope is one decision/batch only. Across sequential rounds, the same id on
 * different assistant messages is valid for OpenAI (pairing is to the nearest
 * preceding assistant). Cross-round uniqueness is not required here; history
 * mapping must preserve stored ids as-is.
 */
export function canonicalizeAgentToolCalls(
  toolCalls: AgentToolCallRequest[],
  step: number,
): AgentToolCallRequest[] {
  const used = new Set<string>();
  return toolCalls.map((call, index) => {
    const trimmed = typeof call.id === 'string' ? call.id.trim() : '';
    let id = trimmed || `call_${call.name || 'tool'}_${step}_${index + 1}`;
    if (used.has(id)) {
      // Collision with an earlier call in this batch — mint a unique id.
      let suffix = 2;
      let candidate = `${id}__${suffix}`;
      while (used.has(candidate)) {
        suffix += 1;
        candidate = `${id}__${suffix}`;
      }
      id = candidate;
    }
    used.add(id);
    return { ...call, id };
  });
}

export function getAgentSession(runId: string): AgentSessionState | undefined {
  return sessions.get(runId);
}

export function clearAgentSession(runId: string): void {
  sessions.delete(runId);
  void deleteDurableAgentSession(runId);
}

export function setAgentSession(session: AgentSessionState): void {
  sessions.set(session.runId, session);
}

export async function deleteDurableAgentSession(runId: string): Promise<void> {
  try {
    await deletePersistedAgentSession(runId);
  } catch (error) {
    console.warn('[Agent] Failed to delete durable session:', error);
  }
}

/** Load a parked session from the L1 cache or durable Dexie storage. */
export async function loadAgentSession(runId: string): Promise<AgentSessionState | undefined> {
  const cached = sessions.get(runId);

  try {
    const now = new Date().toISOString();
    await deleteExpiredAgentSessions(now);
    const record = await readPersistedAgentSession(runId);
    if (!record) return cached;
    if (record.expiresAt <= now) {
      await deletePersistedAgentSession(runId);
      sessions.delete(runId);
      return undefined;
    }
    sessions.set(runId, record.session);
    return record.session;
  } catch (error) {
    console.warn('[Agent] Failed to load durable session; using memory cache:', error);
    return sessions.get(runId);
  }
}

/** Persist only resumable parked states; live runtime dependencies never enter this DTO. */
export async function parkAgentSession(
  session: AgentSessionState,
  status: PersistedAgentSessionStatus,
): Promise<void> {
  sessions.set(session.runId, session);
  const now = Date.now();
  const persisted = toPersistedSession(session);
  let durableSessionWritten = false;
  try {
    await writePersistedAgentSession({
      runId: session.runId,
      messageId: session.messageId,
      status,
      session: persisted,
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    });
    durableSessionWritten = true;
    await flushAssistantSnapshot();
  } catch (error) {
    // Keep the L1 session usable even if IndexedDB quota/storage is unavailable.
    console.warn('[Agent] Failed to persist resumable session:', error);
    if (durableSessionWritten) {
      try {
        await deletePersistedAgentSession(session.runId);
      } catch (cleanupError) {
        console.warn('[Agent] Failed to clean up partially persisted session:', cleanupError);
      }
    }
  }
}

/** Test helper: simulate a reload without deleting durable state. */
export function clearAgentSessionMemoryForTests(): void {
  sessions.clear();
}

function toPersistedSession(session: AgentSessionState): AgentSessionState {
  return {
    ...session,
    imageBase64: session.imageBase64 && session.imageBase64.length <= MAX_PERSISTED_IMAGE_CHARS
      ? session.imageBase64
      : undefined,
    messages: session.messages.map(message => ({ ...message })),
    actionsTaken: session.actionsTaken.map(action => ({ ...action })),
    toolHistory: session.toolHistory.map(entry => ({
      ...entry,
      args: clonePersistable(entry.args),
      result: {
        ...entry.result,
        output: clonePersistable(entry.result.output),
        approval: entry.result.approval
          ? {
              ...entry.result.approval,
              payload: clonePersistable(entry.result.approval.payload),
              preview: clonePersistable(entry.result.approval.preview),
            }
          : undefined,
      },
    })),
    continuation: persistContinuation(session.continuation),
  };
}

/**
 * Takeoff analysis feeds the estimator on resume — never run it through the
 * general size/depth truncator used for tool payloads.
 */
function persistContinuation(
  continuation: AgentSessionState['continuation'],
): AgentSessionState['continuation'] {
  if (!continuation) return undefined;
  if (continuation.kind !== 'pipeline') {
    return clonePersistable(continuation) as AgentSessionState['continuation'];
  }

  const { analysis, analysisTruncated: alreadyTruncated, ...rest } = continuation;
  const sanitizedRest = clonePersistable(rest) as Omit<
    typeof continuation,
    'analysis' | 'analysisTruncated'
  >;

  // Honor an existing truncation marker — never silently clear it on re-park.
  if (alreadyTruncated) {
    return {
      ...sanitizedRest,
      kind: 'pipeline',
      analysis: [],
      analysisTruncated: true,
    };
  }

  // Prefer full analysis even when generic clonePersistable would truncate it.
  if (wouldTruncatePersistable(analysis)) {
    console.warn(
      '[Agent] Takeoff analysis exceeds generic persistence guards; storing full analysis intact.',
    );
  }

  try {
    return {
      ...sanitizedRest,
      kind: 'pipeline',
      analysis: cloneAnalysisIntact(analysis),
      analysisTruncated: false,
    };
  } catch (error) {
    console.warn('[Agent] Failed to persist full takeoff analysis:', error);
    return {
      ...sanitizedRest,
      kind: 'pipeline',
      analysis: [],
      analysisTruncated: true,
    };
  }
}

function cloneAnalysisIntact<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/** True when clonePersistable would drop or replace data (size/depth/image-key guards). */
export function wouldTruncatePersistable(value: unknown, depth = 0): boolean {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return false;
  }
  if (depth >= 8) return true;
  if (Array.isArray(value)) {
    if (value.length > 500) return true;
    return value.some(item => wouldTruncatePersistable(item, depth + 1));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 500) return true;
    for (const [key, child] of entries) {
      if (/base64|imageData|dataUrl/i.test(key)) return true;
      if (wouldTruncatePersistable(child, depth + 1)) return true;
    }
  }
  return false;
}

function clonePersistable(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (depth >= 8) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 500).map(item => clonePersistable(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
      if (/base64|imageData|dataUrl/i.test(key)) continue;
      output[key] = clonePersistable(child, depth + 1);
    }
    return output;
  }
  return String(value);
}

export interface RunPrimaryLoopOptions {
  session: AgentSessionState;
  toolContext: AssistantToolContext;
  model: ModelAdapter;
  maxSteps?: number;
  onStatus?: (status: AgentTurnResult['status'], detail?: string) => void;
  preferTools?: boolean;
  /** Soft tool-selection hint from routing policy (not enforced). */
  suggestedTools?: string[];
  answerOnlyHint?: boolean;
}

export interface ResumeAgentOptions {
  runId: string;
  approval: ApprovalRequest;
  decision: 'approved' | 'rejected';
  toolContext: AssistantToolContext;
  executionResult?: unknown;
  model?: ModelAdapter;
  maxSteps?: number;
  onStatus?: (status: AgentTurnResult['status'], detail?: string) => void;
}

export interface ResumeClarificationOptions {
  runId: string;
  clarification: ClarificationRequest;
  answer: {
    selectedValues: string[];
    freeform?: string;
    displayText: string;
  };
  toolContext: AssistantToolContext;
  model?: ModelAdapter;
  maxSteps?: number;
  onStatus?: (status: AgentTurnResult['status'], detail?: string) => void;
}

/** Continue an agent run after the user approves or rejects a write tool. */
export async function resumeAgentAfterApproval(options: ResumeAgentOptions): Promise<AgentTurnResult> {
  ensureDomainToolsRegistered();
  const session = await loadAgentSession(options.runId);
  if (!session) {
    return {
      status: 'failed',
      assistantMessage: 'Agent session expired. Please send your request again.',
      actionsTaken: [],
      toolHistory: [],
      finalStatus: 'failed',
      errorCode: 'SESSION_EXPIRED',
      runId: options.runId,
      messageId: options.approval.messageId,
    };
  }
  const signal = registerAssistantRunController(options.runId);
  const toolContext: AssistantToolContext = {
    ...options.toolContext,
    runId: options.runId,
    messageId: session.messageId,
    signal,
  };

  // Re-open run for continuation
  useAIChatStore.setState(state => {
    const run = state.runs[options.runId];
    if (!run) return state;
    return {
      runs: {
        ...state.runs,
        [options.runId]: { ...run, status: 'running', completedAt: undefined, error: undefined },
      },
    };
  });

  if (options.decision === 'rejected') {
    emitAgentTrace(options.runId, 'approval_denied', { approvalId: options.approval.id });
    appendApprovalOutcomeMessage(session, options.approval, {
      status: 'failed',
      summary: 'User rejected the proposed action. Document was not changed.',
      output: { rejected: true, toolId: options.approval.toolId },
    });
    session.actionsTaken.push({
      toolId: options.approval.toolId,
      title: options.approval.title,
      summary: 'Rejected by user',
      status: 'failed',
    });
  } else {
    emitAgentTrace(options.runId, 'approval_granted', { approvalId: options.approval.id });
    const completed: AssistantToolResult = {
      status: 'completed',
      summary: `Approved and executed: ${options.approval.description}`,
      output: options.executionResult ?? { executed: true },
    };
    appendApprovalOutcomeMessage(session, options.approval, completed);
    session.actionsTaken.push({
      toolId: options.approval.toolId,
      title: options.approval.title,
      summary: completed.summary,
      status: 'completed',
    });

    const verifyResults = await runVerificationTools(options.approval.toolId, toolContext);
    for (const verify of verifyResults) {
      const def = getAssistantTool(options.approval.toolId);
      const verifyName = def?.verifyWith?.[0] || 'verify';
      // Synthetic verification — no matching model-issued tool call, so do not
      // emit an invalid role:'tool' message without toolCallId.
      session.messages.push({
        role: 'user',
        content: `Verification (${verifyName}): ${formatToolResultForPrompt(verify)}`,
      });
    }
  }

  session.pendingApprovalId = undefined;
  session.continuation = undefined;
  sessions.set(options.runId, session);
  await deleteDurableAgentSession(options.runId);

  try {
    const result = await runPrimaryAgentLoop({
      session,
      toolContext,
      model: options.model || createJsonToolModelAdapter(),
      maxSteps: options.maxSteps ?? MAX_STEPS,
      onStatus: options.onStatus,
    });
    if (result.status === 'completed' || result.finalStatus === 'completed' || result.finalStatus === 'max_steps') {
      attachAgentResultSummary(session.messageId, result);
    }
    return result;
  } finally {
    const status = useAIChatStore.getState().runs[options.runId]?.status;
    if (status !== 'waiting-approval' && status !== 'waiting-clarification' && status !== 'running') {
      releaseAssistantRunController(options.runId);
      if (status === 'completed') clearAgentSession(options.runId);
    }
  }
}

/** Continue an agent run after the user answers an in-chat clarification. */
export async function resumeAgentAfterClarification(
  options: ResumeClarificationOptions,
): Promise<AgentTurnResult> {
  ensureDomainToolsRegistered();
  const session = await loadAgentSession(options.runId);
  if (!session) {
    return {
      status: 'failed',
      assistantMessage: 'Agent session expired. Please send your request again.',
      actionsTaken: [],
      toolHistory: [],
      finalStatus: 'failed',
      errorCode: 'SESSION_EXPIRED',
      runId: options.runId,
      messageId: options.clarification.messageId,
    };
  }
  const signal = registerAssistantRunController(options.runId);
  const toolContext: AssistantToolContext = {
    ...options.toolContext,
    runId: options.runId,
    messageId: session.messageId,
    signal,
  };

  useAIChatStore.setState(state => {
    const run = state.runs[options.runId];
    if (!run) return state;
    return {
      runs: {
        ...state.runs,
        [options.runId]: { ...run, status: 'running', completedAt: undefined, error: undefined },
      },
    };
  });

  const answerLines = [
    `User answered clarification (${options.clarification.stepKey}):`,
    options.answer.displayText,
  ];
  if (options.answer.selectedValues.length) {
    answerLines.push(`Selected values: ${options.answer.selectedValues.join(', ')}`);
  }
  if (options.answer.freeform?.trim()) {
    answerLines.push(`Freeform: ${options.answer.freeform.trim()}`);
  }

  emitAgentTrace(options.runId, 'request', {
    clarificationId: options.clarification.id,
    answer: options.answer.displayText,
  });
  session.messages.push({
    role: 'user',
    content: answerLines.join('\n'),
  });
  session.continuation = undefined;
  sessions.set(options.runId, session);
  await deleteDurableAgentSession(options.runId);

  try {
    const result = await runPrimaryAgentLoop({
      session,
      toolContext,
      model: options.model || createJsonToolModelAdapter(),
      maxSteps: options.maxSteps ?? MAX_STEPS,
      onStatus: options.onStatus,
    });
    if (result.status === 'completed' || result.finalStatus === 'completed' || result.finalStatus === 'max_steps') {
      attachAgentResultSummary(session.messageId, result);
    }
    return result;
  } finally {
    const status = useAIChatStore.getState().runs[options.runId]?.status;
    if (status !== 'waiting-approval' && status !== 'waiting-clarification' && status !== 'running') {
      releaseAssistantRunController(options.runId);
      if (status === 'completed') clearAgentSession(options.runId);
    }
  }
}

/** Phase 3 primary tool loop. */
export async function runPrimaryAgentLoop(options: RunPrimaryLoopOptions): Promise<AgentTurnResult> {
  const { session, toolContext, model, onStatus } = options;
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  sessions.set(session.runId, session);
  if (options.answerOnlyHint) {
    session.messages.push({
      role: 'user',
      content: 'ROUTER_HINT: Prefer a concise final answer. Use tools only if facts are required.',
    });
  } else if (options.preferTools) {
    const toolHint = options.suggestedTools?.length
      ? ` Prefer these tools when relevant: ${options.suggestedTools.join(', ')}.`
      : '';
    session.messages.push({
      role: 'user',
      content: `ROUTER_HINT: Prefer tools over guessing for takeoff/estimate facts.${toolHint}`,
    });
  }
  const store = () => useAIChatStore.getState();
  let steps = 0;

  while (steps < maxSteps) {
    if (toolContext.signal?.aborted) {
      throw new DOMException('Assistant run cancelled', 'AbortError');
    }
    steps += 1;
    onStatus?.('thinking');

    // Near-limit nudge: soft warning on penultimate step, strong "final now" on last step.
    if (steps === maxSteps) {
      session.messages.push({
        role: 'user',
        content: `ROUTER_HINT: This is your last allowed step (${steps}/${maxSteps}). Respond with type "final" summarizing tool results so far. Do NOT call analyze_page again for a page you already analyzed — use typeCounts, items, or count_page_items.`,
      });
    } else if (steps === maxSteps - 1) {
      session.messages.push({
        role: 'user',
        content: `ROUTER_HINT: Step budget nearly exhausted (${steps}/${maxSteps}). Prefer finalizing with available tool results. For counting use count_page_items or prior typeCounts — do not re-analyze the same page.`,
      });
    }

    store().upsertRunStep(session.runId, {
      id: `step_think_${steps}`,
      label: steps === 1
        ? labelForAgentStatus('thinking')
        : `Continue (step ${steps})`,
      stage: 'planning',
      status: 'running',
      progress: Math.min(90, steps * 12),
      startedAt: new Date().toISOString(),
    });

    const decision = await model.complete({
      runId: session.runId,
      messages: session.messages,
      contextText: session.contextText,
      imageBase64: session.imageBase64,
      signal: toolContext.signal,
    });

    if (decision.type === 'plan') {
      session.plan = decision.plan;
      emitAgentTrace(session.runId, 'plan', { plan: decision.plan });
      session.messages.push({ role: 'assistant', content: JSON.stringify(decision) });
      store().upsertRunStep(session.runId, {
        id: `step_think_${steps}`,
        label: 'Plan ready',
        summary: decision.plan.slice(0, 200),
        stage: 'planning',
        status: 'completed',
        progress: 100,
        completedAt: new Date().toISOString(),
      });
      continue;
    }

    if (decision.type === 'clarify') {
      session.messages.push({ role: 'assistant', content: JSON.stringify(decision) });
      session.continuation = { kind: 'agent', waitingFor: 'clarification' };
      await parkAgentSession(session, 'waiting-clarification');
      onStatus?.('needs_clarification');
      const clarification = emitClarificationQuestion({
        runId: session.runId,
        messageId: session.messageId,
        question: decision.message,
        questions: decision.questions,
        options: decision.options,
      });
      return finishWith(session, {
        status: 'needs_clarification',
        finalStatus: 'needs_clarification',
        assistantMessage: decision.message,
        clarifyingQuestions: decision.questions,
        clarificationRequest: clarification,
      });
    }

    if (decision.type === 'final') {
      const result = finishWith(session, {
        status: 'completed',
        finalStatus: 'completed',
        assistantMessage: sanitizeAssistantVisibleText(decision.message),
        clarifyingQuestions: decision.clarifyingQuestions,
      });
      store().finishRun(session.runId, 'completed');
      clearAgentSession(session.runId);
      return result;
    }

    // tool_calls — canonicalize ids ONCE; reuse the same list for history + execution.
    const visibleAssistantText = sanitizeAssistantVisibleText(decision.assistantText);
    if (visibleAssistantText) {
      store().updateMessage(session.messageId, {
        content: visibleAssistantText,
        isLoading: true,
      });
    }
    const toolCalls = canonicalizeAgentToolCalls(decision.toolCalls, steps);
    session.messages.push({
      role: 'assistant',
      content: visibleAssistantText || '',
      toolCalls,
    });
    onStatus?.('running_tools');
    store().upsertRunStep(session.runId, {
      id: `step_tools_${steps}`,
      label: labelForAgentStatus('running_tools'),
      stage: 'tool',
      status: 'running',
      progress: 50,
      startedAt: new Date().toISOString(),
    });

    for (const call of toolCalls) {
      onStatus?.('running_tool', call.name);
      const safety = resolveToolSafety(call.name);
      emitAgentTrace(session.runId, 'tool_selected', { toolId: call.name, mode: safety.mode });
      emitAgentTrace(session.runId, 'tool_args', { toolId: call.name, args: call.arguments });

      if (!safety.allowed || safety.mode === 'reject' || !safety.tool) {
        const failed: AssistantToolResult = {
          status: 'failed',
          summary: safety.reason || `Rejected tool ${call.name}`,
          output: { error: safety.reason },
        };
        pushToolResult(session, call.name, call.name, call.arguments, failed);
        session.messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: formatToolResultForPrompt(failed),
        });
        continue;
      }

      const startedAt = new Date().toISOString();
      store().upsertRunStep(session.runId, {
        id: `step_tool_${call.id}`,
        label: safety.tool.title,
        stage: 'tool',
        status: 'running',
        progress: 40,
        startedAt,
        toolActivity: {
          id: call.id,
          toolId: call.name,
          title: safety.tool.title,
          status: 'running',
          input: call.arguments,
          startedAt,
        },
      });

      const result = await executeAssistantTool(call.name, call.arguments, toolContext);
      emitAgentTrace(session.runId, 'tool_result', {
        toolId: call.name,
        status: result.status,
        summary: result.summary,
      });

      const entry = pushToolResult(session, call.id, call.name, call.arguments, result, safety.tool.title);
      store().addMessageBlock(session.messageId, {
        id: `block_tool_${entry.id}`,
        type: 'tool-result',
        activity: toolHistoryToActivity(entry),
      });
      store().upsertRunStep(session.runId, {
        id: `step_tool_${call.id}`,
        label: safety.tool.title,
        summary: result.summary,
        stage: result.status === 'approval-required' ? 'approval' : 'tool',
        status: result.status === 'failed' ? 'error' : 'completed',
        progress: 100,
        startedAt,
        completedAt: entry.completedAt,
        toolActivity: toolHistoryToActivity(entry),
      });

      if (result.status === 'approval-required' && result.approval) {
        // Thread the model-issued call id onto the approval record so resume
        // can emit a provider-valid tool result (not approval.id).
        result.approval.toolCallId = call.id;
        emitAgentTrace(session.runId, 'approval_requested', {
          approvalId: result.approval.id,
          toolId: call.name,
          toolCallId: call.id,
        });
        store().addMessageBlock(session.messageId, {
          id: `block_${result.approval.id}`,
          type: 'approval',
          approvalId: result.approval.id,
        });
        session.pendingApprovalId = result.approval.id;
        session.continuation = { kind: 'agent', waitingFor: 'approval' };
        session.messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: formatToolResultForPrompt(result),
        });
        onStatus?.('needs_approval');
        store().finishRun(session.runId, 'waiting-approval');
        await parkAgentSession(session, 'waiting-approval');
        return finishWith(session, {
          status: 'needs_approval',
          finalStatus: 'needs_approval',
          assistantMessage: sanitizeAssistantVisibleText(decision.assistantText)
            || result.summary
            || 'I need your approval before making this change.',
          approvalRequest: result.approval,
        });
      }

      session.messages.push({
        role: 'tool',
        name: call.name,
        toolCallId: call.id,
        content: formatToolResultForPrompt(result),
      });
    }
  }

  const maxResult = finishWith(session, {
    status: 'completed',
    finalStatus: 'max_steps',
    assistantMessage: buildMaxStepsAssistantMessage(session),
  });
  store().finishRun(session.runId, 'completed');
  clearAgentSession(session.runId);
  return maxResult;
}

/** Prefer a useful partial summary over a bare dead-end when the step budget is hit. */
export function buildMaxStepsAssistantMessage(session: AgentSessionState): string {
  const base =
    'I reached the maximum number of agent steps for this turn. Please refine your request or continue in a follow-up.';

  const findings: string[] = [];
  for (const action of session.actionsTaken) {
    if (action.status !== 'completed' || !action.summary) continue;
    findings.push(`- ${action.title}: ${action.summary}`);
    if (findings.length >= 8) break;
  }

  // Surface typeCounts from the last successful analyze_page / count_page_items output when present.
  for (let i = session.toolHistory.length - 1; i >= 0 && findings.length < 10; i -= 1) {
    const entry = session.toolHistory[i];
    if (entry.result.status !== 'completed') continue;
    const output = entry.result.output;
    if (!output || typeof output !== 'object') continue;
    const record = output as Record<string, unknown>;
    if (entry.toolId === 'count_page_items' && typeof record.total === 'number') {
      const query = typeof record.query === 'string' ? record.query : 'items';
      findings.push(`- Partial count for “${query}”: ${record.total}`);
      break;
    }
    const analysis = record.analysis;
    if (analysis && typeof analysis === 'object') {
      const typeCounts = (analysis as { typeCounts?: Record<string, number> }).typeCounts;
      if (typeCounts && Object.keys(typeCounts).length > 0) {
        const parts = Object.entries(typeCounts)
          .slice(0, 8)
          .map(([type, count]) => `${type}: ${count}`)
          .join(', ');
        findings.push(`- Detected type counts so far: ${parts}`);
        break;
      }
    }
  }

  if (findings.length === 0) return base;
  return `${base}\n\nHere is what I gathered so far:\n${findings.join('\n')}`;
}

/**
 * Append (or replace) the provider-facing tool result for an approval outcome.
 * Uses the originating model toolCallId — never the approval UI id.
 * When no originating call id exists (UI-queued mutation), emit a user-context
 * message instead of an invalid role:'tool' without toolCallId.
 */
function appendApprovalOutcomeMessage(
  session: AgentSessionState,
  approval: ApprovalRequest,
  result: AssistantToolResult,
): void {
  const content = formatToolResultForPrompt(result);
  const originatingId = typeof approval.toolCallId === 'string' && approval.toolCallId.trim()
    ? approval.toolCallId.trim()
    : undefined;

  if (!originatingId) {
    session.messages.push({
      role: 'user',
      content: `Approval ${result.status === 'failed' ? 'rejected' : 'granted'} (${approval.toolId}): ${content}`,
    });
    return;
  }

  const next: AgentModelMessage = {
    role: 'tool',
    name: approval.toolId,
    toolCallId: originatingId,
    content,
  };

  // Replace the pending approval-required tool result for this call id when present.
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const msg = session.messages[i];
    if (msg.role === 'tool' && msg.toolCallId === originatingId) {
      session.messages[i] = next;
      return;
    }
  }
  session.messages.push(next);
}

function pushToolResult(
  session: AgentSessionState,
  id: string,
  toolId: string,
  args: unknown,
  result: AssistantToolResult,
  title?: string
): AgentToolHistoryEntry {
  const entry: AgentToolHistoryEntry = {
    id: `toolhist_${id}`,
    toolId,
    title: title || getAssistantTool(toolId)?.title || toolId,
    args,
    result,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
  session.toolHistory.push(entry);
  session.actionsTaken.push({
    toolId,
    title: entry.title,
    summary: result.summary,
    status: result.status,
  });
  return entry;
}

function finishWith(
  session: AgentSessionState,
  partial: Pick<AgentTurnResult, 'status' | 'finalStatus' | 'assistantMessage'> & {
    clarifyingQuestions?: string[];
    approvalRequest?: ApprovalRequest;
    clarificationRequest?: ClarificationRequest;
  }
): AgentTurnResult {
  const result: AgentTurnResult = {
    status: partial.status,
    assistantMessage: partial.assistantMessage,
    actionsTaken: [...session.actionsTaken],
    approvalRequest: partial.approvalRequest,
    clarificationRequest: partial.clarificationRequest,
    toolHistory: [...session.toolHistory],
    finalStatus: partial.finalStatus,
    clarifyingQuestions: partial.clarifyingQuestions,
    runId: session.runId,
    messageId: session.messageId,
    plan: session.plan,
  };
  emitAgentTrace(session.runId, 'final', {
    status: result.status,
    finalStatus: result.finalStatus,
    actions: result.actionsTaken.length,
  });
  return result;
}

let domainToolsReady = false;
function ensureDomainToolsRegistered(): void {
  if (domainToolsReady) return;
  registerAllAgentTools();
  domainToolsReady = true;
}
