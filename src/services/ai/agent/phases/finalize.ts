import type {
  AgentTurnResult,
  ModelUsedEntry,
  RoutingDecision,
  VerificationSummary,
} from '../types';

export interface FinalizeInput {
  runId: string;
  messageId: string;
  status: AgentTurnResult['status'];
  finalStatus: AgentTurnResult['finalStatus'];
  assistantMessage: string;
  actionsTaken: AgentTurnResult['actionsTaken'];
  toolHistory: AgentTurnResult['toolHistory'];
  approvalRequest?: AgentTurnResult['approvalRequest'];
  clarificationRequest?: AgentTurnResult['clarificationRequest'];
  clarifyingQuestions?: string[];
  plan?: string;
  routingDecision?: RoutingDecision;
  modelsUsed?: ModelUsedEntry[];
  verificationSummary?: VerificationSummary;
  warnings?: string[];
}

/** Phase 5: assemble the UI-facing result. Pure and testable. */
export function finalizeAgentTurn(input: FinalizeInput): AgentTurnResult {
  const warnings = (input.warnings || []).filter(Boolean);
  const assistantMessage = warnings.length
    ? `${input.assistantMessage}\n\n${warnings.map(w => `Note: ${w}`).join('\n')}`
    : input.assistantMessage;

  return {
    status: input.status,
    assistantMessage,
    actionsTaken: input.actionsTaken || [],
    approvalRequest: input.approvalRequest,
    clarificationRequest: input.clarificationRequest,
    toolHistory: input.toolHistory || [],
    finalStatus: input.finalStatus,
    clarifyingQuestions: input.clarifyingQuestions,
    runId: input.runId,
    messageId: input.messageId,
    plan: input.plan,
    routingDecision: input.routingDecision,
    modelsUsed: input.modelsUsed,
    verificationSummary: input.verificationSummary,
  };
}
