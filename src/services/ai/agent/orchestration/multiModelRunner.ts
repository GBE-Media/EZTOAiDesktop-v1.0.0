import { useAIChatStore } from '@/store/aiChatStore';
import type { AssistantToolContext } from '../tools/types';
import type { TradeType } from '../providers/types';
import { createJsonToolModelAdapter, type ModelAdapter } from '../modelAdapter';
import { runIntake } from '../phases/intake';
import { finalizeAgentTurn } from '../phases/finalize';
import { runVerificationPhase } from '../phases/verifier';
import { runRouting } from '../routing/routerModel';
import { emitAgentTrace } from '../trace';
import type { AgentTurnResult, ModelUsedEntry, RoutingDecision } from '../types';
import type { AgentSessionState } from '../runnerCore';
import {
  getAgentSession,
  runPrimaryAgentLoop,
  setAgentSession,
} from '../runnerCore';
import {
  registerAssistantRunController,
  releaseAssistantRunController,
} from '../../assistantOrchestrator';
import { registerAllAgentTools } from '../tools/registerAll';
import {
  attachAgentResultSummary,
  emitClarificationQuestion,
  labelForAgentStatus,
} from '../clarification';

// re-export session type for consumers
export type { AgentSessionState };
export interface MultiModelRunOptions {
  messageId: string;
  userMessage: string;
  toolContext: AssistantToolContext;
  /** Prebuilt context text from the UI (markups/catalog/etc). */
  contextText: string;
  trade: TradeType;
  imageBase64?: string;
  runId?: string;
  currentPage?: number;
  documentName?: string | null;
  documentId?: string | null;
  totalPages?: number;
  recentTurns?: Array<{ role: 'user' | 'assistant'; content: string }>;
  markupsSummary?: string;
  catalogSummary?: string;
  materialCountsSummary?: string;
  takeoffSummary?: string;
  maxSteps?: number;
  onStatus?: (status: AgentTurnResult['status'], detail?: string) => void;
}

/**
 * Five-phase orchestrator: intake → routing → primary → verification → final.
 * One router, one primary, one optional verifier — no agent swarm.
 */
export async function runMultiModelTurn(options: MultiModelRunOptions): Promise<AgentTurnResult> {
  registerAllAgentTools();

  const store = useAIChatStore.getState();
  const runId = options.runId || store.createRun(options.messageId, options.userMessage.slice(0, 120));
  const signal = registerAssistantRunController(runId);
  const modelsUsed: ModelUsedEntry[] = [];

  const session: AgentSessionState = getAgentSession(runId) || {
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

  const toolContext: AssistantToolContext = {
    ...options.toolContext,
    runId,
    messageId: options.messageId,
    signal,
  };

  try {
    // Phase 1 — Intake
    options.onStatus?.('routing', 'intake');
    const intake = runIntake({
      userMessage: options.userMessage,
      userIntent: options.userMessage,
      trade: options.trade,
      currentPage: options.currentPage,
      documentName: options.documentName,
      documentId: options.documentId,
      totalPages: options.totalPages,
      recentTurns: options.recentTurns,
      markupsSummary: options.markupsSummary,
      catalogSummary: options.catalogSummary,
      materialCountsSummary: options.materialCountsSummary,
      takeoffSummary: options.takeoffSummary,
      hasImage: Boolean(options.imageBase64),
    });
    // Prefer richer UI-supplied context text when provided
    if (options.contextText?.trim()) {
      intake.contextText = `${options.contextText}\n\n${intake.contextText}`;
    }
    session.contextText = intake.contextText;
    emitAgentTrace(runId, 'intake', {
      taskType: intake.preliminaryTaskType,
      risk: intake.preliminaryRisk,
    });
    store.upsertRunStep(runId, {
      id: 'step_intake',
      label: labelForAgentStatus('routing', 'intake'),
      stage: 'planning',
      status: 'completed',
      progress: 100,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    if (!session.messages.some(m => m.role === 'user' && m.content === intake.normalizedMessage)) {
      session.messages.push({ role: 'user', content: intake.normalizedMessage });
    }
    setAgentSession(session);

    // Phase 2 — Routing
    options.onStatus?.('routing');
    const routing = await runRouting({ runId, intake, signal });
    modelsUsed.push(...routing.modelsUsed);
    const decision = applyFallbackPath(routing.decision);
    emitAgentTrace(runId, 'routing', decision);
    store.upsertRunStep(runId, {
      id: 'step_routing',
      label: labelForAgentStatus('routing'),
      summary: decision.reason,
      stage: 'planning',
      status: 'completed',
      progress: 100,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    if (decision.path === 'ask_clarification') {
      const question = decision.clarificationQuestion
        || 'What would you like me to do next for this estimate or takeoff?';
      options.onStatus?.('needs_clarification');
      session.messages.push({
        role: 'assistant',
        content: JSON.stringify({ type: 'clarify', message: question, questions: [question] }),
      });
      setAgentSession(session);
      const clarification = emitClarificationQuestion({
        runId,
        messageId: options.messageId,
        question,
        questions: [question],
        stepKey: decision.taskType === 'ambiguous' ? 'scope' : undefined,
      });
      const result = finalizeAgentTurn({
        runId,
        messageId: options.messageId,
        status: 'needs_clarification',
        finalStatus: 'needs_clarification',
        assistantMessage: question,
        clarifyingQuestions: [question],
        clarificationRequest: clarification,
        actionsTaken: [],
        toolHistory: [],
        routingDecision: decision,
        modelsUsed,
      });
      emitAgentTrace(runId, 'final', result);
      return result;
    }

    if (decision.path === 'answer_directly') {
      options.onStatus?.('thinking');
      const primaryResult = await runPrimaryAgentLoop({
        session,
        toolContext,
        model: createRoleAdapter('primary', modelsUsed),
        maxSteps: Math.min(options.maxSteps ?? 8, 3),
        onStatus: options.onStatus,
        answerOnlyHint: true,
      });
      return await finishWithOptionalVerify({
        primaryResult,
        decision,
        modelsUsed,
        toolContext,
        requireVerifier: false,
        onStatus: options.onStatus,
        signal,
      });
    }

    // Phase 3 — Primary (or fallback model)
    const primaryRole = decision.path === 'invoke_fallback' ? 'fallback' : 'primary';
    options.onStatus?.('thinking');
    const primaryResult = await runPrimaryAgentLoop({
      session,
      toolContext,
      model: createRoleAdapter(primaryRole, modelsUsed),
      maxSteps: options.maxSteps ?? 8,
      onStatus: options.onStatus,
      preferTools: decision.preferTools,
    });

    if (primaryResult.status === 'needs_approval' || primaryResult.status === 'needs_clarification') {
      return finalizeAgentTurn({
        ...primaryResult,
        routingDecision: decision,
        modelsUsed: dedupeModels(modelsUsed.concat(primaryResult.modelsUsed || [])),
      });
    }

    // Phase 4 + 5
    return await finishWithOptionalVerify({
      primaryResult,
      decision,
      modelsUsed: dedupeModels(modelsUsed.concat(primaryResult.modelsUsed || [])),
      toolContext,
      requireVerifier: decision.requireVerifier || decision.path === 'invoke_primary_plus_verifier',
      onStatus: options.onStatus,
      signal,
    });
  } catch (error) {
    const cancelled = signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    emitAgentTrace(runId, 'error', { message, cancelled });
    if (!cancelled) store.finishRun(runId, 'error', message);
    const result = finalizeAgentTurn({
      runId,
      messageId: options.messageId,
      status: 'failed',
      finalStatus: cancelled ? 'cancelled' : 'failed',
      assistantMessage: cancelled ? 'Stopped.' : message,
      actionsTaken: session.actionsTaken,
      toolHistory: session.toolHistory,
      modelsUsed,
    });
    emitAgentTrace(runId, 'final', result);
    return result;
  } finally {
    const status = useAIChatStore.getState().runs[runId]?.status;
    if (status !== 'waiting-approval' && status !== 'waiting-clarification' && status !== 'running') {
      releaseAssistantRunController(runId);
    }
  }
}

async function finishWithOptionalVerify(options: {
  primaryResult: AgentTurnResult;
  decision: RoutingDecision;
  modelsUsed: ModelUsedEntry[];
  toolContext: AssistantToolContext;
  requireVerifier: boolean;
  onStatus?: (status: AgentTurnResult['status'], detail?: string) => void;
  signal?: AbortSignal;
}): Promise<AgentTurnResult> {
  const { primaryResult, decision, toolContext } = options;
  let modelsUsed = [...options.modelsUsed];
  let assistantMessage = primaryResult.assistantMessage;
  let verificationSummary = primaryResult.verificationSummary;
  let status = primaryResult.status;
  let finalStatus = primaryResult.finalStatus;
  let clarifyingQuestions = primaryResult.clarifyingQuestions;

  if (
    options.requireVerifier
    && primaryResult.finalStatus === 'completed'
    && primaryResult.status === 'completed'
  ) {
    options.onStatus?.('verifying');
    const lastWrite = [...primaryResult.actionsTaken]
      .reverse()
      .find(a => a.status === 'completed' || a.status === 'approval-required');
    const verify = await runVerificationPhase({
      runId: primaryResult.runId,
      draftMessage: primaryResult.assistantMessage,
      actionsTaken: primaryResult.actionsTaken,
      toolHistorySummaries: primaryResult.toolHistory.map(t => `${t.toolId}: ${t.result.summary}`),
      requireLlm: true,
      lastWriteToolId: lastWrite?.toolId,
      toolContext,
      signal: options.signal,
    });
    modelsUsed = dedupeModels(modelsUsed.concat(verify.modelsUsed));
    verificationSummary = verify.summary;
    assistantMessage = verify.finalMessage;
    if (verify.blockedClarification) {
      status = 'needs_clarification';
      finalStatus = 'needs_clarification';
      clarifyingQuestions = [verify.blockedClarification];
      options.onStatus?.('needs_clarification');
      let session = getAgentSession(primaryResult.runId);
      if (!session) {
        session = {
          runId: primaryResult.runId,
          messageId: primaryResult.messageId,
          messages: [
            {
              role: 'assistant',
              content: primaryResult.assistantMessage,
            },
          ],
          toolHistory: [...primaryResult.toolHistory],
          actionsTaken: [...primaryResult.actionsTaken],
          contextText: '',
        };
      }
      session.messages.push({
        role: 'assistant',
        content: JSON.stringify({
          type: 'clarify',
          message: verify.blockedClarification,
          questions: [verify.blockedClarification],
        }),
      });
      setAgentSession(session);
      emitClarificationQuestion({
        runId: primaryResult.runId,
        messageId: primaryResult.messageId,
        question: verify.blockedClarification,
        questions: [verify.blockedClarification],
      });
    }
  }

  const result = finalizeAgentTurn({
    runId: primaryResult.runId,
    messageId: primaryResult.messageId,
    status,
    finalStatus,
    assistantMessage,
    actionsTaken: primaryResult.actionsTaken,
    toolHistory: primaryResult.toolHistory,
    approvalRequest: primaryResult.approvalRequest,
    clarificationRequest: primaryResult.clarificationRequest,
    clarifyingQuestions,
    plan: primaryResult.plan,
    routingDecision: decision,
    modelsUsed,
    verificationSummary,
  });
  if (status === 'completed' || finalStatus === 'completed' || finalStatus === 'max_steps') {
    attachAgentResultSummary(primaryResult.messageId, result);
  }
  emitAgentTrace(primaryResult.runId, 'final', {
    status: result.status,
    models: result.modelsUsed?.length,
    path: decision.path,
  });
  return result;
}

function createRoleAdapter(
  role: 'primary' | 'fallback',
  modelsUsed: ModelUsedEntry[]
): ModelAdapter {
  const adapter = createJsonToolModelAdapter(role);
  return {
    complete: async opts => adapter.complete({
      ...opts,
      role,
      onModelUsed: entry => {
        if (!modelsUsed.some(m => m.role === entry.role && m.model === entry.model && m.phase === entry.phase)) {
          modelsUsed.push(entry);
        }
      },
    }),
  };
}

function applyFallbackPath(decision: RoutingDecision): RoutingDecision {
  if (decision.path !== 'invoke_fallback') return decision;
  return { ...decision, reason: `${decision.reason} (using fallback model)` };
}

function dedupeModels(entries: ModelUsedEntry[]): ModelUsedEntry[] {
  const seen = new Set<string>();
  return entries.filter(entry => {
    const key = `${entry.role}:${entry.provider}:${entry.model}:${entry.phase}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
