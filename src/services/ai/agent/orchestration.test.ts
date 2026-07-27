import { describe, expect, it } from 'vitest';
import { runIntake } from './phases/intake';
import { finalizeAgentTurn } from './phases/finalize';
import { decideRoutingPolicy, mergeRouterModelDecision } from './routing/policy';
import { parseAgentDecision } from './decisionParser';
import { buildAgentContext } from './contextBuilder';
import { resolveToolSafety } from './safety';
import { registerAllAgentTools, resetAgentToolRegistrationForTests } from './tools/registerAll';

describe('multi-model phases', () => {
  it('Phase 1 intake classifies compliance as high risk', () => {
    const intake = runIntake({
      userMessage: 'Check NEC compliance for this panel schedule',
      userIntent: 'Check NEC compliance for this panel schedule',
      trade: 'electrical',
    });
    expect(intake.normalizedMessage).toContain('NEC');
    expect(intake.preliminaryTaskType).toBe('compliance');
    expect(intake.preliminaryRisk).toBe('high');
  });

  it('Phase 2 policy routes compliance to primary+verifier', () => {
    const intake = runIntake({
      userMessage: 'Is this estimate code compliant?',
      userIntent: 'Is this estimate code compliant?',
      trade: 'electrical',
    });
    const decision = decideRoutingPolicy(intake);
    expect(decision.path).toBe('invoke_primary_plus_verifier');
    expect(decision.requireVerifier).toBe(true);
    expect(decision.needsLlmRouter).toBe(false);
  });

  it('Phase 2 policy answers simple questions directly', () => {
    const intake = runIntake({
      userMessage: 'Hi there',
      userIntent: 'Hi there',
      trade: 'electrical',
    });
    const decision = decideRoutingPolicy(intake);
    expect(decision.path).toBe('answer_directly');
  });

  it('Phase 2 merges router model overrides', () => {
    const base = decideRoutingPolicy(runIntake({
      userMessage: 'help',
      userIntent: 'help',
      trade: 'electrical',
    }));
    const { needsLlmRouter: _, ...policy } = base;
    const merged = mergeRouterModelDecision(policy, {
      path: 'ask_clarification',
      clarificationQuestion: 'Which page?',
      reason: 'router override',
    });
    expect(merged.path).toBe('ask_clarification');
    expect(merged.clarificationQuestion).toBe('Which page?');
  });

  it('Phase 5 finalize assembles contract fields', () => {
    const result = finalizeAgentTurn({
      runId: 'r1',
      messageId: 'm1',
      status: 'completed',
      finalStatus: 'completed',
      assistantMessage: 'Done',
      actionsTaken: [],
      toolHistory: [],
      routingDecision: {
        path: 'invoke_primary',
        taskType: 'read_context',
        complexity: 'low',
        risk: 'low',
        preferTools: true,
        requireVerifier: false,
        suggestedTools: [],
        reason: 'test',
      },
      modelsUsed: [{ role: 'primary', provider: 'lovable', model: 'openai/gpt-5.6-sol', phase: 'primary' }],
    });
    expect(result.routingDecision?.path).toBe('invoke_primary');
    expect(result.modelsUsed?.[0].role).toBe('primary');
  });

  it('keeps decision parser and safety intact', () => {
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();
    expect(parseAgentDecision('{"type":"final","message":"ok"}').type).toBe('final');
    expect(resolveToolSafety('getProjectContext').mode).toBe('auto');
    expect(buildAgentContext({
      userIntent: 'test',
      trade: 'electrical',
    }).text).toContain('test');
  });
});
