import type { AIProviderType } from '../providers/types';

/** Exactly four roles — no agent swarm. */
export type AgentModelRole = 'router' | 'primary' | 'verifier' | 'fallback';

export interface AgentModelSelection {
  provider: AIProviderType;
  model: string;
}

export type AgentModelsConfig = Record<AgentModelRole, AgentModelSelection>;

export const DEFAULT_AGENT_MODELS: AgentModelsConfig = {
  router: { provider: 'lovable', model: 'openai/gpt-5.6-luna' },
  primary: { provider: 'lovable', model: 'openai/gpt-5.6-sol' },
  verifier: { provider: 'anthropic', model: 'claude-opus-4-5' },
  fallback: { provider: 'lovable', model: 'openai/gpt-5.5' },
};
