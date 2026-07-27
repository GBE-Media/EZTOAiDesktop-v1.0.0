import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { assistantDb } from '@/db/assistantDb';
import { useAIChatStore } from './aiChatStore';

const waitForPersistence = () => new Promise(resolve => setTimeout(resolve, 300));

describe('aiChatStore assistant domain', () => {
  beforeEach(async () => {
    await assistantDb.snapshots.clear();
    useAIChatStore.setState({
      messages: [],
      runs: {},
      approvals: {},
      conversation: null,
      conversationContextId: null,
      conversationHydrated: false,
    });
  });

  it('tracks run and step transitions', async () => {
    await useAIChatStore.getState().setConversationContext('project-a');
    const messageId = useAIChatStore.getState().addMessage({ role: 'assistant', content: '' });
    const runId = useAIChatStore.getState().createRun(messageId, 'Analyze page');
    useAIChatStore.getState().upsertRunStep(runId, {
      id: 'vision',
      label: 'Render and inspect page',
      status: 'running',
      progress: 50,
    });
    useAIChatStore.getState().upsertRunStep(runId, {
      id: 'vision',
      label: 'Render and inspect page',
      status: 'completed',
      progress: 100,
    });
    useAIChatStore.getState().finishRun(runId);

    const run = useAIChatStore.getState().runs[runId];
    expect(run.status).toBe('completed');
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0].progress).toBe(100);
    expect(useAIChatStore.getState().messages[0].blocks?.[0]).toMatchObject({
      type: 'activity',
      runId,
    });
  });

  it('settles leftover running steps when finishRun completes', async () => {
    await useAIChatStore.getState().setConversationContext('project-a');
    const messageId = useAIChatStore.getState().addMessage({ role: 'assistant', content: '' });
    const runId = useAIChatStore.getState().createRun(messageId, 'Analyze page');
    useAIChatStore.getState().upsertRunStep(runId, {
      id: 'step_vision',
      label: 'Analyzing page 1 detail 3/9...',
      status: 'running',
      progress: 60,
    });
    useAIChatStore.getState().finishRun(runId, 'waiting-approval');

    const run = useAIChatStore.getState().runs[runId];
    expect(run.status).toBe('waiting-approval');
    expect(run.steps[0]).toMatchObject({
      status: 'completed',
      progress: 100,
    });
  });

  it('persists and isolates conversations by project context', async () => {
    await useAIChatStore.getState().setConversationContext('project-a');
    useAIChatStore.getState().addMessage({ role: 'user', content: 'Project A question' });
    await waitForPersistence();

    await useAIChatStore.getState().setConversationContext('project-b');
    expect(useAIChatStore.getState().messages).toHaveLength(0);
    useAIChatStore.getState().addMessage({ role: 'user', content: 'Project B question' });
    await waitForPersistence();

    await useAIChatStore.getState().setConversationContext('project-a');
    expect(useAIChatStore.getState().messages.map(message => message.content)).toEqual(['Project A question']);
  });

  it('cancels pending run steps', async () => {
    await useAIChatStore.getState().setConversationContext('project-a');
    const messageId = useAIChatStore.getState().addMessage({ role: 'assistant', content: '' });
    const runId = useAIChatStore.getState().createRun(messageId);
    useAIChatStore.getState().upsertRunStep(runId, {
      id: 'ocr',
      label: 'Read plan text',
      status: 'running',
    });
    useAIChatStore.getState().cancelRun(runId);
    expect(useAIChatStore.getState().runs[runId]).toMatchObject({
      status: 'cancelled',
      steps: [{ status: 'cancelled' }],
    });
  });
});
