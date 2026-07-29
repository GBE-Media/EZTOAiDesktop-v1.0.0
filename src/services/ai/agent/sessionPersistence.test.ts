import './testGlobals';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assistantDb,
  deleteExpiredAgentSessions,
  readPersistedAgentSession,
  writePersistedAgentSession,
} from '@/db/assistantDb';
import {
  clearAgentSession,
  clearAgentSessionMemoryForTests,
  loadAgentSession,
  parkAgentSession,
} from './runner';
import type { AgentSessionState } from './types';

const makeSession = (runId = 'run-1'): AgentSessionState => ({
  runId,
  messageId: 'message-1',
  messages: [
    { role: 'user', content: 'Count fixtures' },
    { role: 'assistant', content: '{"type":"clarify","message":"Which pages?"}' },
  ],
  toolHistory: [{
    callId: 'tool-1',
    toolId: 'inspect_markups',
    args: { page: 1 },
    result: { status: 'success', summary: 'Inspected', output: { count: 2 } },
  }],
  actionsTaken: [],
  contextText: 'document context',
  continuation: {
    kind: 'agent',
    waitingFor: 'clarification',
  },
});

describe('durable agent sessions', () => {
  beforeEach(async () => {
    clearAgentSessionMemoryForTests();
    await assistantDb.open();
    await assistantDb.snapshots.clear();
    await assistantDb.agentSessions.clear();
  });

  it('preserves v1 snapshots when Dexie upgrades to v2', async () => {
    const databaseName = `bidvera-assistant-migration-${Date.now()}`;
    const legacy = new Dexie(databaseName);
    legacy.version(1).stores({ snapshots: 'id, contextId, updatedAt' });
    await legacy.open();
    await legacy.table('snapshots').put({
      id: 'snapshot:project-a',
      contextId: 'project-a',
      messages: [],
      runs: {},
      approvals: {},
      clarifications: {},
      updatedAt: new Date().toISOString(),
    });
    legacy.close();

    const migrated = new Dexie(databaseName);
    migrated.version(1).stores({ snapshots: 'id, contextId, updatedAt' });
    migrated.version(2).stores({
      snapshots: 'id, contextId, updatedAt',
      agentSessions: 'runId, messageId, status, updatedAt, expiresAt',
    });
    await migrated.open();
    expect(await migrated.table('snapshots').get('snapshot:project-a')).toMatchObject({
      contextId: 'project-a',
    });
    expect(migrated.tables.map(table => table.name)).toContain('agentSessions');
    migrated.close();
    await Dexie.delete(databaseName);
  });

  it('round-trips parked messages, tool history, and continuation state', async () => {
    const session = makeSession();
    await parkAgentSession(session, 'waiting-clarification');
    clearAgentSessionMemoryForTests();

    const restored = await loadAgentSession(session.runId);
    expect(restored).toMatchObject({
      runId: session.runId,
      messageId: session.messageId,
      continuation: { kind: 'agent', waitingFor: 'clarification' },
    });
    expect(restored?.messages).toHaveLength(2);
    expect(restored?.toolHistory[0].result.output).toEqual({ count: 2 });
  });

  it('hydrates on cache miss and terminal clear removes durable state', async () => {
    const session = makeSession('run-reload');
    await parkAgentSession(session, 'waiting-approval');
    clearAgentSessionMemoryForTests();
    expect(await loadAgentSession(session.runId)).toBeDefined();

    clearAgentSession(session.runId);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await readPersistedAgentSession(session.runId)).toBeUndefined();
  });

  it('TTL cleanup removes expired sessions without deleting active ones', async () => {
    const now = Date.now();
    await writePersistedAgentSession({
      runId: 'expired',
      messageId: 'message-expired',
      status: 'waiting-clarification',
      session: makeSession('expired'),
      updatedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now - 1).toISOString(),
    });
    await writePersistedAgentSession({
      runId: 'active',
      messageId: 'message-active',
      status: 'waiting-clarification',
      session: makeSession('active'),
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    });

    expect(await deleteExpiredAgentSessions(new Date(now).toISOString())).toBe(1);
    expect(await readPersistedAgentSession('expired')).toBeUndefined();
    expect(await readPersistedAgentSession('active')).toBeDefined();
  });
});
