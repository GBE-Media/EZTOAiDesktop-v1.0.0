import './testGlobals';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assistantDb,
  deleteExpiredAgentSessions,
  readAssistantSnapshot,
  readPersistedAgentSession,
  writePersistedAgentSession,
} from '@/db/assistantDb';
import {
  clearAgentSession,
  clearAgentSessionMemoryForTests,
  getAgentSession,
  loadAgentSession,
  parkAgentSession,
  wouldTruncatePersistable,
} from './runner';
import type { AgentSessionState } from './types';
import { useAIChatStore } from '@/store/aiChatStore';

const makeSession = (runId = 'run-1'): AgentSessionState => ({
  runId,
  messageId: 'message-1',
  messages: [
    { role: 'user', content: 'Count fixtures' },
    { role: 'assistant', content: '{"type":"clarify","message":"Which pages?"}' },
  ],
  toolHistory: [{
    id: 'tool-history-1',
    toolId: 'inspect_markups',
    title: 'Inspect markups',
    args: { page: 1 },
    result: { status: 'completed', summary: 'Inspected', output: { count: 2 } },
    startedAt: '2026-07-28T00:00:00.000Z',
    completedAt: '2026-07-28T00:00:01.000Z',
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
    useAIChatStore.setState({
      conversation: null,
      conversationContextId: null,
      conversationHydrated: false,
      messages: [],
      runs: {},
      approvals: {},
      clarifications: {},
    });
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

  it('persists oversized continuation.analysis intact instead of silently truncating', async () => {
    // Generic clonePersistable caps arrays at 500 entries — 600 items would truncate.
    const oversizedAnalysis = Array.from({ length: 600 }, (_, index) => ({
      page: 1,
      items: [{
        id: `item-${index}`,
        type: 'fixture',
        trade: 'electrical' as const,
        name: `Fixture ${index}`,
        quantity: 1,
        location: { x: index, y: index },
        confidence: 0.9,
      }],
      dimensions: [],
      text: [],
      symbols: [],
      evidence: [`evidence-${index}`],
    }));
    expect(wouldTruncatePersistable(oversizedAnalysis)).toBe(true);

    const session: AgentSessionState = {
      ...makeSession('run-oversized-analysis'),
      continuation: {
        kind: 'pipeline',
        originalPrompt: 'Count fixtures',
        analysis: oversizedAnalysis,
        evidence: ['Sheet E-101'],
        questions: [{
          id: 'scope',
          prompt: 'Which scope?',
          options: [{ id: 'all', label: 'All', value: 'all' }],
        }],
        nextQuestionIndex: 0,
        config: {
          trade: 'electrical',
          pages: [1],
          pageWidth: 612,
          pageHeight: 792,
          highAccuracyMode: true,
          visibleOnly: false,
          refinePlacements: true,
        },
      },
    };

    await parkAgentSession(session, 'waiting-clarification');
    clearAgentSessionMemoryForTests();
    const restored = await loadAgentSession(session.runId);
    expect(restored?.continuation?.kind).toBe('pipeline');
    if (restored?.continuation?.kind !== 'pipeline') return;
    expect(restored.continuation.analysisTruncated).toBe(false);
    expect(restored.continuation.analysis).toHaveLength(600);
    expect(restored.continuation.analysis[599]).toMatchObject({
      items: [{ id: 'item-599', name: 'Fixture 599' }],
      evidence: ['evidence-599'],
    });
  });

  it('flushes the visible clarification snapshot before parking returns', async () => {
    const now = new Date().toISOString();
    const session = makeSession('run-visible');
    useAIChatStore.setState({
      conversation: {
        id: 'conversation-visible',
        contextId: 'project-visible',
        title: 'Visible task',
        trade: 'electrical',
        createdAt: now,
        updatedAt: now,
      },
      conversationContextId: 'project-visible',
      conversationHydrated: true,
      messages: [{
        id: session.messageId,
        role: 'assistant',
        content: 'Which pages?',
        timestamp: new Date(),
        blocks: [{ id: 'question-block', type: 'question', clarificationId: 'clarification-visible' }],
      }],
      runs: {
        [session.runId]: {
          id: session.runId,
          messageId: session.messageId,
          conversationId: 'conversation-visible',
          status: 'waiting-clarification',
          steps: [],
          startedAt: now,
        },
      },
      clarifications: {
        'clarification-visible': {
          id: 'clarification-visible',
          runId: session.runId,
          messageId: session.messageId,
          stepKey: 'scope',
          question: 'Which pages?',
          options: [],
          status: 'pending',
          createdAt: now,
        },
      },
    });

    await parkAgentSession(session, 'waiting-clarification');
    const snapshot = await readAssistantSnapshot('project-visible');
    expect(snapshot?.runs[0]).toMatchObject({
      id: session.runId,
      status: 'waiting-clarification',
    });
    expect(snapshot?.clarifications?.[0]).toMatchObject({
      id: 'clarification-visible',
      status: 'pending',
    });
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

  it('prefers a newer durable session over a stale memory cache', async () => {
    const session = makeSession('run-latest');
    await parkAgentSession(session, 'waiting-clarification');
    getAgentSession(session.runId)!.contextText = 'stale memory context';
    const record = await readPersistedAgentSession(session.runId);
    await writePersistedAgentSession({
      ...record!,
      session: { ...record!.session, contextText: 'latest durable context' },
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    });

    expect((await loadAgentSession(session.runId))?.contextText).toBe('latest durable context');
  });

  it('degrades to an empty memory cache when IndexedDB reads fail', async () => {
    assistantDb.close({ disableAutoOpen: true });
    await expect(loadAgentSession('unavailable')).resolves.toBeUndefined();
    await assistantDb.open();
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
