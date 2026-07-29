import Dexie, { type EntityTable } from 'dexie';
import type {
  ApprovalRequest,
  ClarificationRequest,
  AssistantConversation,
  AssistantRun,
} from '@/types/assistant';
import type { ChatMessage } from '@/store/aiChatStore';
import type { AgentSessionState } from '@/services/ai/agent/types';

export interface AssistantSnapshot {
  id: string;
  contextId: string;
  conversation: AssistantConversation;
  messages: ChatMessage[];
  runs: AssistantRun[];
  approvals: ApprovalRequest[];
  clarifications?: ClarificationRequest[];
  updatedAt: string;
}

export type PersistedAgentSessionStatus = 'waiting-approval' | 'waiting-clarification';

export interface PersistedAgentSession {
  runId: string;
  messageId: string;
  status: PersistedAgentSessionStatus;
  session: AgentSessionState;
  updatedAt: string;
  expiresAt: string;
}

class AssistantDatabase extends Dexie {
  snapshots!: EntityTable<AssistantSnapshot, 'id'>;
  agentSessions!: EntityTable<PersistedAgentSession, 'runId'>;

  constructor() {
    super('bidveraai-assistant');
    this.version(1).stores({
      snapshots: 'id, contextId, updatedAt',
    });
    this.version(2).stores({
      snapshots: 'id, contextId, updatedAt',
      agentSessions: 'runId, messageId, status, updatedAt, expiresAt',
    });
  }
}

export const assistantDb = new AssistantDatabase();

export async function readAssistantSnapshot(contextId: string): Promise<AssistantSnapshot | undefined> {
  return assistantDb.snapshots.where('contextId').equals(contextId).last();
}

export async function listAssistantSnapshots(contextId: string): Promise<AssistantSnapshot[]> {
  return assistantDb.snapshots.where('contextId').equals(contextId).reverse().sortBy('updatedAt');
}

export async function readAssistantSnapshotById(id: string): Promise<AssistantSnapshot | undefined> {
  return assistantDb.snapshots.get(id);
}

export async function writeAssistantSnapshot(snapshot: AssistantSnapshot): Promise<void> {
  await assistantDb.snapshots.put(snapshot);
}

export async function deleteAssistantSnapshot(contextId: string): Promise<void> {
  await assistantDb.snapshots.where('contextId').equals(contextId).delete();
}

export async function readPersistedAgentSession(
  runId: string,
): Promise<PersistedAgentSession | undefined> {
  return assistantDb.agentSessions.get(runId);
}

export async function writePersistedAgentSession(
  record: PersistedAgentSession,
): Promise<void> {
  await assistantDb.agentSessions.put(record);
}

export async function deletePersistedAgentSession(runId: string): Promise<void> {
  await assistantDb.agentSessions.delete(runId);
}

export async function deleteExpiredAgentSessions(nowIso: string): Promise<number> {
  return assistantDb.agentSessions.where('expiresAt').belowOrEqual(nowIso).delete();
}
