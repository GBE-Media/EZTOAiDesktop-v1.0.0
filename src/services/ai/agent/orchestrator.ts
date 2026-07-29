import type { ClarificationRequest } from '@/types/assistant';
import { useAIChatStore } from '@/store/aiChatStore';
import {
  runPipeline,
  type PipelineOptions,
  type PipelineResult,
} from '../pipeline';
import type { AssistantToolContext } from '../tools/types';
import { cancelAssistantRun } from '../assistantOrchestrator';
import type { AgentTurnResult, AgentSessionState, PipelineClarificationStep } from './types';
import type { RunAgentTurnOptions } from './runner';
import {
  clearAgentSession,
  deleteDurableAgentSession,
  loadAgentSession,
  parkAgentSession,
  resumeAgentAfterApproval,
  resumeAgentAfterClarification,
  runAgentTurn,
  type ResumeAgentOptions,
  type ResumeClarificationOptions,
} from './runner';
import { emitClarificationQuestion } from './clarification';

export interface OrchestratedTaskResult {
  runId: string;
  messageId: string;
  status: AgentTurnResult['status'];
  errorCode?: AgentTurnResult['errorCode'];
  agentResult?: AgentTurnResult;
  pipelineResult?: PipelineResult;
  clarificationRequest?: ClarificationRequest;
}

export interface StartPipelineTaskOptions {
  runId: string;
  messageId: string;
  userMessage: string;
  documentId?: string;
  pipeline: PipelineOptions;
}

export interface ResumeTaskAfterClarificationOptions {
  clarification: ClarificationRequest;
  answer: NonNullable<ClarificationRequest['answer']>;
  toolContext: AssistantToolContext;
  pipelineRuntime?: Pick<
    PipelineOptions,
    'pdfDoc' | 'getCachedText' | 'setCachedText' | 'onProgress'
  > & { activeDocumentId?: string };
  onStatus?: RunAgentTurnOptions['onStatus'];
  model?: ResumeClarificationOptions['model'];
}

/** UI-facing start entrypoint for the existing five-phase agent. */
export async function startAgentTask(options: RunAgentTurnOptions): Promise<OrchestratedTaskResult> {
  const result = await runAgentTurn(options);
  return {
    runId: result.runId,
    messageId: result.messageId,
    status: result.status,
    agentResult: result,
    errorCode: result.errorCode,
    clarificationRequest: result.clarificationRequest,
  };
}

/** Run a takeoff task and park its partial vision analysis if clarification is required. */
export async function startPipelineTask(
  options: StartPipelineTaskOptions,
): Promise<OrchestratedTaskResult> {
  const result = await runPipeline(options.pipeline);
  const questions = normalizePipelineQuestions(result);

  if (result.success && result.analysis?.length && questions.length) {
    const session: AgentSessionState = {
      runId: options.runId,
      messageId: options.messageId,
      messages: [
        { role: 'user', content: options.userMessage },
        {
          role: 'assistant',
          content: JSON.stringify({
            type: 'clarify',
            message: questions[0].prompt,
            questions: questions.map(question => question.prompt),
          }),
        },
      ],
      toolHistory: [],
      actionsTaken: [],
      contextText: options.userMessage,
      continuation: {
        kind: 'pipeline',
        originalPrompt: options.userMessage,
        analysis: result.analysis,
        evidence: result.evidence || [],
        questions,
        nextQuestionIndex: 0,
        config: {
          trade: options.pipeline.trade,
          pages: [...options.pipeline.pages],
          pageWidth: options.pipeline.pageWidth,
          pageHeight: options.pipeline.pageHeight,
          highAccuracyMode: options.pipeline.highAccuracyMode ?? false,
          visibleOnly: options.pipeline.visibleOnly ?? false,
          refinePlacements: options.pipeline.refinePlacements ?? true,
          documentId: options.documentId,
        },
      },
    };
    const clarification = emitPipelineQuestion(session, questions[0], 0);
    await parkAgentSession(session, 'waiting-clarification');
    return {
      runId: options.runId,
      messageId: options.messageId,
      status: 'needs_clarification',
      pipelineResult: result,
      clarificationRequest: clarification,
    };
  }

  return {
    runId: options.runId,
    messageId: options.messageId,
    status: result.success ? 'completed' : 'failed',
    pipelineResult: result,
  };
}

/** Resume either an agent loop or a parked takeoff task by durable run state. */
export async function resumeTaskAfterClarification(
  options: ResumeTaskAfterClarificationOptions,
): Promise<OrchestratedTaskResult> {
  const session = await loadAgentSession(options.clarification.runId);
  if (!session) {
    return expiredResult(options.clarification.runId, options.clarification.messageId);
  }

  if (session.continuation?.kind === 'pipeline') {
    const continuation = session.continuation;
    if (
      continuation.config.documentId
      && continuation.config.documentId !== options.pipelineRuntime?.activeDocumentId
    ) {
      return failedTaskResult(
        session.runId,
        session.messageId,
        'The source document for this takeoff is no longer active. Reopen it and start the takeoff again.',
        'DOCUMENT_MISMATCH',
      );
    }
    const answeredIndex = continuation.nextQuestionIndex;
    const expectedQuestion = continuation.questions[answeredIndex];
    if (!expectedQuestion) {
      return expiredResult(session.runId, session.messageId);
    }
    const expectedStepKey = continuation.pendingClarificationStepKey
      || pipelineStepKey(answeredIndex, expectedQuestion.id);
    const clarificationMatches =
      options.clarification.stepKey === expectedStepKey
      && (
        !continuation.pendingClarificationId
        || options.clarification.id === continuation.pendingClarificationId
      );
    if (!clarificationMatches) {
      useAIChatStore.getState().resolveClarification(options.clarification.id, 'cancelled');
      const currentClarification = emitPipelineQuestion(
        session,
        expectedQuestion,
        answeredIndex,
      );
      await parkAgentSession(session, 'waiting-clarification');
      return {
        runId: session.runId,
        messageId: session.messageId,
        status: 'needs_clarification',
        clarificationRequest: currentClarification,
      };
    }
  }

  const store = useAIChatStore.getState();
  store.resolveClarification(options.clarification.id, 'answered', options.answer);
  store.addMessage({ role: 'user', content: options.answer.displayText });

  if (session.continuation?.kind !== 'pipeline') {
    const result = await resumeAgentAfterClarification({
      runId: options.clarification.runId,
      clarification: options.clarification,
      answer: options.answer,
      toolContext: options.toolContext,
      onStatus: options.onStatus,
      model: options.model,
    });
    return {
      runId: result.runId,
      messageId: result.messageId,
      status: result.status,
      agentResult: result,
      errorCode: result.errorCode,
      clarificationRequest: result.clarificationRequest,
    };
  }

  const continuation = session.continuation;
  const answeredIndex = continuation.nextQuestionIndex;
  continuation.questions[answeredIndex].answer = options.answer;
  continuation.nextQuestionIndex = answeredIndex + 1;
  session.messages.push({
    role: 'user',
    content: `User answered clarification (${options.clarification.stepKey}):\n${options.answer.displayText}`,
  });

  const next = continuation.questions[continuation.nextQuestionIndex];
  if (next) {
    const clarification = emitPipelineQuestion(session, next, continuation.nextQuestionIndex);
    await parkAgentSession(session, 'waiting-clarification');
    return {
      runId: session.runId,
      messageId: session.messageId,
      status: 'needs_clarification',
      clarificationRequest: clarification,
    };
  }

  store.upsertRunStep(session.runId, {
    id: 'step_pipeline_resume',
    label: 'Continuing takeoff with your answers',
    stage: 'planning',
    status: 'running',
    progress: 20,
    startedAt: new Date().toISOString(),
  });
  await deleteDurableAgentSession(session.runId);
  const clarificationContext = continuation.questions
    .map(question => `${question.prompt}\nAnswer: ${question.answer?.displayText || 'Not answered'}`)
    .join('\n\n');
  const result = await runPipeline({
    trade: continuation.config.trade,
    pages: continuation.config.pages,
    pageWidth: continuation.config.pageWidth,
    pageHeight: continuation.config.pageHeight,
    userPrompt: continuation.originalPrompt,
    highAccuracyMode: continuation.config.highAccuracyMode,
    visibleOnly: continuation.config.visibleOnly,
    refinePlacements: continuation.config.refinePlacements,
    pdfDoc: options.pipelineRuntime?.pdfDoc,
    getCachedText: options.pipelineRuntime?.getCachedText,
    setCachedText: options.pipelineRuntime?.setCachedText,
    onProgress: options.pipelineRuntime?.onProgress,
    resumeFrom: {
      analysis: continuation.analysis,
      clarificationContext,
    },
  });
  clearAgentSession(session.runId);
  return {
    runId: session.runId,
    messageId: session.messageId,
    status: result.success ? 'completed' : 'failed',
    pipelineResult: result,
  };
}

export async function resumeTaskAfterApproval(
  options: ResumeAgentOptions,
): Promise<OrchestratedTaskResult> {
  const result = await resumeAgentAfterApproval(options);
  return {
    runId: result.runId,
    messageId: result.messageId,
    status: result.status,
    agentResult: result,
    errorCode: result.errorCode,
    clarificationRequest: result.clarificationRequest,
  };
}

/** Cancel a live or parked task and remove any durable continuation. */
export function cancelTask(runId: string): void {
  cancelAssistantRun(runId);
  useAIChatStore.getState().cancelRun(runId);
  clearAgentSession(runId);
}

function emitPipelineQuestion(
  session: AgentSessionState,
  question: PipelineClarificationStep,
  index: number,
): ClarificationRequest {
  const clarification = emitClarificationQuestion({
    runId: session.runId,
    messageId: session.messageId,
    question: question.prompt,
    options: question.options,
    stepKey: pipelineStepKey(index, question.id),
    allowMultiSelect: question.allowMultiple,
    allowFreeform: true,
  });
  if (session.continuation?.kind === 'pipeline') {
    session.continuation.pendingClarificationId = clarification.id;
    session.continuation.pendingClarificationStepKey = clarification.stepKey;
  }
  return clarification;
}

function pipelineStepKey(index: number, questionId: string): string {
  return `pipeline_${index}_${questionId}`;
}

function normalizePipelineQuestions(result: PipelineResult): PipelineClarificationStep[] {
  const normalized: PipelineClarificationStep[] = [];
  const seen = new Set<string>();

  for (const question of result.questionOptions || []) {
    const prompt = question.prompt?.trim();
    if (!prompt || seen.has(prompt.toLowerCase())) continue;
    seen.add(prompt.toLowerCase());
    normalized.push({
      id: question.id || `pipeline_q_${normalized.length}`,
      prompt,
      options: (question.options || []).map((label, optionIndex) => ({
        id: `${question.id || `pipeline_q_${normalized.length}`}_${optionIndex}`,
        label,
        value: label,
      })),
      allowMultiple: question.allowMultiple,
    });
  }

  for (const promptValue of result.questions || []) {
    const prompt = promptValue?.trim();
    if (!prompt || seen.has(prompt.toLowerCase())) continue;
    seen.add(prompt.toLowerCase());
    normalized.push({
      id: `pipeline_q_${normalized.length}`,
      prompt,
      options: [],
    });
  }
  return normalized;
}

function expiredResult(runId: string, messageId: string): OrchestratedTaskResult {
  return failedTaskResult(
    runId,
    messageId,
    'Agent session expired. Please send your request again.',
    'SESSION_EXPIRED',
  );
}

function failedTaskResult(
  runId: string,
  messageId: string,
  assistantMessage: string,
  errorCode: NonNullable<AgentTurnResult['errorCode']>,
): OrchestratedTaskResult {
  return {
    runId,
    messageId,
    status: 'failed',
    errorCode,
    agentResult: {
      status: 'failed',
      assistantMessage,
      actionsTaken: [],
      toolHistory: [],
      finalStatus: 'failed',
      errorCode,
      runId,
      messageId,
    },
  };
}
