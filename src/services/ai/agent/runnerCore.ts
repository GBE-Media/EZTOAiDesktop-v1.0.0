/**
 * Primary agent tool-loop core (Phase 3).
 * Kept separate from multi-model orchestration so each phase stays testable.
 */
import { flushAssistantSnapshot, useAIChatStore } from '@/store/aiChatStore';
import type { ApprovalRequest, ClarificationRequest } from '@/types/assistant';
import type { AssistantToolContext, AssistantToolResult } from '../tools/types';
import { executeAssistantTool, getAssistantTool } from '../tools/registry';
import { formatToolResultForPrompt, resolveToolSafety } from './safety';
import { createJsonToolModelAdapter, type ModelAdapter } from './modelAdapter';
import { emitAgentTrace } from './trace';
import { runVerificationTools } from './verification';
import { toolHistoryToActivity, type AgentActionTaken, type AgentModelMessage, type AgentToolHistoryEntry, type AgentTurnResult } from './types';
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

const MAX_STEPS = 8;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PERSISTED_IMAGE_CHARS = 1_000_000;

const sessions = new Map<string, AgentSessionState>();

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
    continuation: session.continuation
      ? clonePersistable(session.continuation) as AgentSessionState['continuation']
      : undefined,
  };
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
    session.messages.push({
      role: 'tool',
      name: options.approval.toolId,
      toolCallId: options.approval.id,
      content: formatToolResultForPrompt({
        status: 'failed',
        summary: 'User rejected the proposed action. Document was not changed.',
        output: { rejected: true, toolId: options.approval.toolId },
      }),
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
    session.messages.push({
      role: 'tool',
      name: options.approval.toolId,
      toolCallId: options.approval.id,
      content: formatToolResultForPrompt(completed),
    });
    session.actionsTaken.push({
      toolId: options.approval.toolId,
      title: options.approval.title,
      summary: completed.summary,
      status: 'completed',
    });

    const verifyResults = await runVerificationTools(options.approval.toolId, toolContext);
    for (const verify of verifyResults) {
      const def = getAssistantTool(options.approval.toolId);
      session.messages.push({
        role: 'tool',
        name: def?.verifyWith?.[0] || 'verify',
        content: formatToolResultForPrompt(verify),
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
    session.messages.push({
      role: 'user',
      content: 'ROUTER_HINT: Prefer tools over guessing for takeoff/estimate facts.',
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
        assistantMessage: decision.message,
        clarifyingQuestions: decision.clarifyingQuestions,
      });
      store().finishRun(session.runId, 'completed');
      clearAgentSession(session.runId);
      return result;
    }

    // tool_calls
    if (decision.assistantText) {
      store().updateMessage(session.messageId, {
        content: decision.assistantText,
        isLoading: true,
      });
    }
    session.messages.push({ role: 'assistant', content: JSON.stringify(decision) });
    onStatus?.('running_tools');
    store().upsertRunStep(session.runId, {
      id: `step_tools_${steps}`,
      label: labelForAgentStatus('running_tools'),
      stage: 'tool',
      status: 'running',
      progress: 50,
      startedAt: new Date().toISOString(),
    });

    for (const call of decision.toolCalls) {
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
        emitAgentTrace(session.runId, 'approval_requested', {
          approvalId: result.approval.id,
          toolId: call.name,
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
          assistantMessage: decision.assistantText
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
    assistantMessage: 'I reached the maximum number of agent steps for this turn. Please refine your request or continue in a follow-up.',
  });
  store().finishRun(session.runId, 'completed');
  clearAgentSession(session.runId);
  return maxResult;
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
