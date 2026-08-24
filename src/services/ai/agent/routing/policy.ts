import type { IntakeResult } from '../phases/intake';
import type { RoutingDecision, RoutingPath, RiskLevel, TaskType } from '../types';
import { isLocateIntent } from '../locateIntent';

/**
 * Deterministic routing policy (always runs).
 * Cost-aware: skip LLM router when the path is clear.
 */
export function decideRoutingPolicy(intake: IntakeResult): RoutingDecision & { needsLlmRouter: boolean } {
  const { preliminaryTaskType: taskType, preliminaryRisk: risk, normalizedMessage } = intake;

  if (!normalizedMessage) {
    return base({
      path: 'ask_clarification',
      taskType: 'ambiguous',
      complexity: 'low',
      risk: 'medium',
      preferTools: false,
      requireVerifier: false,
      suggestedTools: [],
      reason: 'Empty user message',
      clarificationQuestion: 'What would you like help with on this estimate or takeoff?',
      needsLlmRouter: false,
    });
  }

  // Locate / show-me must use tools to focus the canvas — never answer_directly.
  if (isLocateIntent(normalizedMessage)) {
    return base({
      path: 'invoke_primary',
      taskType: taskType === 'simple_qa' ? 'read_context' : taskType,
      complexity: 'medium',
      risk: 'low',
      preferTools: true,
      requireVerifier: false,
      reason: 'Location request needs search + canvas focus',
      suggestedTools: ['search_document', 'navigate_page', 'analyze_page'],
      needsLlmRouter: false,
    });
  }

  // Counting / tally questions: prefer count_page_items over blind re-analysis.
  if (/\b(count\w*|how many|tally|quantit(?:y|ies) of)\b/i.test(normalizedMessage)) {
    return base({
      path: 'invoke_primary',
      taskType: 'read_context',
      complexity: 'medium',
      risk: 'low',
      preferTools: true,
      requireVerifier: false,
      reason: 'Counting request; use count_page_items (and analyze_page only if needed once)',
      suggestedTools: ['count_page_items', 'analyze_page', 'getTakeoffSummary'],
      needsLlmRouter: false,
    });
  }

  if (taskType === 'simple_qa' && risk === 'low') {
    return base({
      path: 'answer_directly',
      taskType,
      complexity: 'low',
      risk: 'low',
      preferTools: false,
      requireVerifier: false,
      suggestedTools: [],
      reason: 'Short low-risk question; answer without a heavy tool loop',
      needsLlmRouter: false,
    });
  }

  if (taskType === 'compliance' || taskType === 'cost_sensitive' || risk === 'high') {
    return base({
      path: 'invoke_primary_plus_verifier',
      taskType,
      complexity: 'high',
      risk: 'high',
      preferTools: true,
      requireVerifier: true,
      reason: 'High-sensitivity estimating topic requires primary tools + verifier',
      suggestedTools: taskType === 'compliance'
        ? ['getCodeComplianceStatus', 'getTakeoffSummary']
        : ['getMaterialCounts', 'getTakeoffSummary'],
      needsLlmRouter: false,
    });
  }

  if (taskType === 'write_action') {
    return base({
      path: 'invoke_primary',
      taskType,
      complexity: 'medium',
      risk: 'medium',
      preferTools: true,
      requireVerifier: false,
      reason: 'Write/action request; primary agent with approval-gated tools',
      suggestedTools: ['getTakeoffSummary', 'place_markups', 'propose_callouts'],
      needsLlmRouter: false,
    });
  }

  if (taskType === 'read_context' || taskType === 'layout') {
    return base({
      path: 'invoke_primary',
      taskType,
      complexity: 'medium',
      risk: 'low',
      preferTools: true,
      requireVerifier: false,
      reason: 'Context or layout request; primary agent with read tools',
      suggestedTools: taskType === 'layout'
        ? ['getLayoutSuggestions', 'getRunSuggestions', 'getTakeoffSummary']
        : ['getProjectContext', 'getTakeoffSummary', 'getMaterialCounts'],
      needsLlmRouter: false,
    });
  }

  // Ambiguous / other → let lightweight router model refine
  return base({
    path: 'invoke_primary',
    taskType,
    complexity: 'medium',
    risk: risk as RiskLevel,
    preferTools: true,
    requireVerifier: false,
    suggestedTools: [],
    reason: 'Unclear classification; escalate to lightweight router model',
    needsLlmRouter: true,
  });
}

function base(
  partial: RoutingDecision & { needsLlmRouter: boolean }
): RoutingDecision & { needsLlmRouter: boolean } {
  return {
    suggestedTools: [],
    ...partial,
  };
}

export function mergeRouterModelDecision(
  policy: RoutingDecision,
  llm: Partial<RoutingDecision>
): RoutingDecision {
  const path = (llm.path && isPath(llm.path) ? llm.path : policy.path) as RoutingPath;
  const requireVerifier = Boolean(llm.requireVerifier ?? policy.requireVerifier)
    || path === 'invoke_primary_plus_verifier';
  return {
    path,
    taskType: (llm.taskType as TaskType) || policy.taskType,
    complexity: llm.complexity || policy.complexity,
    risk: (llm.risk as RiskLevel) || policy.risk,
    preferTools: llm.preferTools ?? policy.preferTools,
    requireVerifier,
    suggestedTools: llm.suggestedTools?.length ? llm.suggestedTools : policy.suggestedTools,
    reason: llm.reason || policy.reason,
    clarificationQuestion: llm.clarificationQuestion || policy.clarificationQuestion,
  };
}

function isPath(value: string): value is RoutingPath {
  return [
    'answer_directly',
    'ask_clarification',
    'invoke_primary',
    'invoke_primary_plus_verifier',
    'invoke_fallback',
  ].includes(value);
}
