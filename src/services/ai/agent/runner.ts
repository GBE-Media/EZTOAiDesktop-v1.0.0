/**
 * Agent turn entrypoint — delegates to the five-phase multi-model orchestrator.
 */
import type { TradeType } from '../providers/types';
import type { AssistantToolContext } from '../tools/types';
import { runMultiModelTurn } from './orchestration/multiModelRunner';
import type { AgentTurnResult } from './types';
import type { ModelAdapter } from './modelAdapter';

export {
  clearAgentSession,
  clearAgentSessionMemoryForTests,
  deleteDurableAgentSession,
  getAgentSession,
  loadAgentSession,
  parkAgentSession,
  resumeAgentAfterApproval,
  resumeAgentAfterClarification,
  runPrimaryAgentLoop,
  setAgentSession,
  wouldTruncatePersistable,
  type ResumeAgentOptions,
  type ResumeClarificationOptions,
} from './runnerCore';
export type { AgentSessionState } from './types';

export interface RunAgentTurnOptions {
  messageId: string;
  userMessage: string;
  toolContext: AssistantToolContext;
  contextText: string;
  imageBase64?: string;
  runId?: string;
  model?: ModelAdapter;
  maxSteps?: number;
  onStatus?: (status: AgentTurnResult['status'], detail?: string) => void;
  /** Required for multi-model routing; defaults to electrical. */
  trade?: TradeType;
  currentPage?: number;
  documentName?: string | null;
  documentId?: string | null;
  totalPages?: number;
  recentTurns?: Array<{ role: 'user' | 'assistant'; content: string }>;
  markupsSummary?: string;
  catalogSummary?: string;
  materialCountsSummary?: string;
  takeoffSummary?: string;
  pageAnalysisSummary?: string;
}

export async function runAgentTurn(options: RunAgentTurnOptions): Promise<AgentTurnResult> {
  return runMultiModelTurn({
    messageId: options.messageId,
    userMessage: options.userMessage,
    toolContext: options.toolContext,
    contextText: options.contextText,
    imageBase64: options.imageBase64,
    runId: options.runId,
    maxSteps: options.maxSteps,
    onStatus: options.onStatus,
    trade: options.trade || 'electrical',
    currentPage: options.currentPage,
    documentName: options.documentName,
    documentId: options.documentId,
    totalPages: options.totalPages,
    recentTurns: options.recentTurns,
    markupsSummary: options.markupsSummary,
    catalogSummary: options.catalogSummary,
    materialCountsSummary: options.materialCountsSummary,
    takeoffSummary: options.takeoffSummary,
    pageAnalysisSummary: options.pageAnalysisSummary,
  });
}
