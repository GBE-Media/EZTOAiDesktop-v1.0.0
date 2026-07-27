import { useAIChatStore } from '@/store/aiChatStore';
import type { ApprovalRequest } from '@/types/assistant';
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

const MAX_STEPS = 8;

export interface AgentSessionState {
  runId: string;
  messageId: string;
  messages: AgentModelMessage[];
  toolHistory: AgentToolHistoryEntry[];
  actionsTaken: AgentActionTaken[];
  contextText: string;
  imageBase64?: string;
  plan?: string;
  pendingApprovalId?: string;
}

const sessions = new Map<string, AgentSessionState>();

export function getAgentSession(runId: string): AgentSessionState | undefined {
  return sessions.get(runId);
}

export function clearAgentSession(runId: string): void {
  sessions.delete(runId);
}

export interface RunAgentTurnOptions {
  messageId: string;
  userMessage: string;
  toolContext: AssistantToolContext;
  contextText: string;
  imageBase64?: string;
  /** Existing run id — if omitted, creates one. */
  runId?: string;
  model?: ModelAdapter;
  maxSteps?: number;
  onStatus?: (status: AgentTurnResult['status'], detail?: string) => void;
}

export async function runAgentTurn(options: RunAgentTurnOptions): Promise<AgentTurnResult> {
  ensureDomainToolsRegistered();

  const store = useAIChatStore.getState();
  const runId = options.runId || store.createRun(options.messageId, options.userMessage.slice(0, 120));
  const signal = registerAssistantRunController(runId);
  const model = options.model || createJsonToolModelAdapter();
  const maxSteps = options.maxSteps ?? MAX_STEPS;

  const session: AgentSessionState = sessions.get(runId) || {
    runId,
    messageId: options.messageId,
    messages: [],
    toolHistory: [],
    actionsTaken: [],
    contextText: options.contextText,
    imageBase64: options.imageBase64,
  };
  session.contextText = options.contextText;
  session.imageBase64 = options.imageBase64;
  session.messageId = options.messageId;
  if (!session.messages.some(m => m.role === 'user' && m.content === options.userMessage)) {
    session.messages.push({ role: 'user', content: options.userMessage });
  }
  sessions.set(runId, session);

  const toolContext: AssistantToolContext = {
    ...options.toolContext,
    runId,
    messageId: options.messageId,
    signal,
  };

  emitAgentTrace(runId, 'request', { userMessage: options.userMessage.slice(0, 300) });
  options.onStatus?.('thinking');

  try {
    return await loopAgent({
      session,
      toolContext,
      model,
      maxSteps,
      onStatus: options.onStatus,
    });
  } catch (error) {
    const cancelled = signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    emitAgentTrace(runId, 'error', { message, cancelled });
    if (!cancelled) {
      useAIChatStore.getState().finishRun(runId, 'error', message);
    }
    const result: AgentTurnResult = {
      status: 'failed',
      assistantMessage: cancelled ? 'Stopped.' : message,
      actionsTaken: session.actionsTaken,
      toolHistory: session.toolHistory,
      finalStatus: cancelled ? 'cancelled' : 'failed',
      runId,
      messageId: options.messageId,
      plan: session.plan,
    };
    emitAgentTrace(runId, 'final', result);
    return result;
  } finally {
    const status = useAIChatStore.getState().runs[runId]?.status;
    if (status !== 'waiting-approval' && status !== 'running') {
      releaseAssistantRunController(runId);
    }
  }
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

/** Continue an agent run after the user approves or rejects a write tool. */
export async function resumeAgentAfterApproval(options: ResumeAgentOptions): Promise<AgentTurnResult> {
  ensureDomainToolsRegistered();
  const session = sessions.get(options.runId);
  if (!session) {
    return {
      status: 'failed',
      assistantMessage: 'Agent session expired. Please send your request again.',
      actionsTaken: [],
      toolHistory: [],
      finalStatus: 'failed',
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
  sessions.set(options.runId, session);

  try {
    return await loopAgent({
      session,
      toolContext,
      model: options.model || createJsonToolModelAdapter(),
      maxSteps: options.maxSteps ?? MAX_STEPS,
      onStatus: options.onStatus,
    });
  } finally {
    const status = useAIChatStore.getState().runs[options.runId]?.status;
    if (status !== 'waiting-approval' && status !== 'running') {
      releaseAssistantRunController(options.runId);
      if (status === 'completed' || status === 'error' || status === 'cancelled') {
        // keep session briefly for debugging; clear on completed
        if (status === 'completed') clearAgentSession(options.runId);
      }
    }
  }
}

async function loopAgent(options: {
  session: AgentSessionState;
  toolContext: AssistantToolContext;
  model: ModelAdapter;
  maxSteps: number;
  onStatus?: (status: AgentTurnResult['status'], detail?: string) => void;
}): Promise<AgentTurnResult> {
  const { session, toolContext, model, maxSteps, onStatus } = options;
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
      label: steps === 1 ? 'Plan next action' : `Continue (step ${steps})`,
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
      const result = finishWith(session, {
        status: 'needs_clarification',
        finalStatus: 'needs_clarification',
        assistantMessage: decision.message,
        clarifyingQuestions: decision.questions,
      });
      store().finishRun(session.runId, 'completed');
      return result;
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
        // Keep the tool result in history for resume; don't feed "completed" yet.
        session.messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: formatToolResultForPrompt(result),
        });
        onStatus?.('needs_approval');
        store().finishRun(session.runId, 'waiting-approval');
        const pause = finishWith(session, {
          status: 'needs_approval',
          finalStatus: 'needs_approval',
          assistantMessage: decision.assistantText
            || result.summary
            || 'I need your approval before making this change.',
          approvalRequest: result.approval,
        });
        return pause;
      }

      session.messages.push({
        role: 'tool',
        name: call.name,
        toolCallId: call.id,
        content: formatToolResultForPrompt(result),
      });

      // Auto-run verification for completed writes that somehow auto-ran (shouldn't for write)
      if (result.status === 'completed' && safety.tool.verifyWith?.length) {
        // Only auto-verify for read-side tools that declare verifyWith (rare); writes verify after approval.
      }
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
  }
): AgentTurnResult {
  const result: AgentTurnResult = {
    status: partial.status,
    assistantMessage: partial.assistantMessage,
    actionsTaken: [...session.actionsTaken],
    approvalRequest: partial.approvalRequest,
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
