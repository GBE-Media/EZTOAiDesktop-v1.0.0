import Dexie, { type EntityTable } from 'dexie';
import type {
  ApprovalRequest,
  AssistantConversation,
  AssistantRun,
} from '@/types/assistant';
import type { ChatMessage } from '@/store/aiChatStore';

export interface AssistantSnapshot {
  id: string;
  contextId: string;
  conversation: AssistantConversation;
  messages: ChatMessage[];
  runs: AssistantRun[];
  approvals: ApprovalRequest[];
  updatedAt: string;
}

class AssistantDatabase extends Dexie {
  snapshots!: EntityTable<AssistantSnapshot, 'id'>;

  constructor() {
    super('bidveraai-assistant');
    this.version(1).stores({
      snapshots: 'id, contextId, updatedAt',
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
