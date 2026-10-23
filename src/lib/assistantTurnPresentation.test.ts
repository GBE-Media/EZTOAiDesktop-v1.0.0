import { describe, expect, it } from 'vitest';
import type { AssistantMessageBlock, AssistantRun, ToolActivity } from '@/types/assistant';
import {
  activityDetailText,
  collapsedViewContainsRawInternals,
  friendlyStatusLine,
  friendlyToolLabel,
  groupAssistantBlocks,
  humanizeToolError,
} from './assistantTurnPresentation';

const activity: ToolActivity = {
  id: 'act-1',
  toolId: 'count_page_items',
  title: 'count_page_items',
  status: 'completed',
  output: [{ code: 'too_big', maximum: 50 }],
};

const blocks: AssistantMessageBlock[] = [
  { id: 'a', type: 'activity', runId: 'run-1' },
  { id: 'p', type: 'progress', label: 'Running count_page_items', status: 'completed' },
  { id: 't', type: 'tool-result', activity },
  { id: 'md', type: 'markdown', markdown: 'Found 12 fixtures.' },
  { id: 'ap', type: 'approval', approvalId: 'appr-1' },
];

describe('friendlyToolLabel', () => {
  it('maps known tools', () => {
    expect(friendlyToolLabel('count_page_items')).toBe('Counted fixtures');
    expect(friendlyToolLabel('place_markups')).toBe('Placed markups');
    expect(friendlyToolLabel('analyze_page')).toBe('Read the page');
    expect(friendlyToolLabel('search_catalog')).toBe('Searched products');
    expect(friendlyToolLabel('get_takeoff_summary')).toBe('Checked the takeoff');
  });

  it('falls back to a cleaned-up name for unknown tools', () => {
    expect(friendlyToolLabel('link_catalog_item')).toBe('Link Catalog Item');
  });
});

describe('groupAssistantBlocks', () => {
  it('puts process in one disclosure group and does not duplicate tool results', () => {
    const grouped = groupAssistantBlocks(blocks);
    expect(grouped.hasActivity).toBe(true);
    expect(grouped.processBlocks.map(b => b.type)).toEqual(['activity', 'progress']);
    expect(grouped.processBlocks.some(b => b.type === 'tool-result')).toBe(false);
    expect(grouped.visibleBlocks.map(b => b.type)).toEqual(['markdown', 'approval']);
  });

  it('keeps tool-result inside the process group when there is no activity timeline', () => {
    const grouped = groupAssistantBlocks(blocks.filter(b => b.type !== 'activity'));
    expect(grouped.processBlocks.map(b => b.type)).toEqual(['progress', 'tool-result']);
    expect(grouped.visibleBlocks.map(b => b.type)).not.toContain('tool-result');
  });
});

describe('collapsed vs expanded internals', () => {
  it('collapsed default text has no raw tool ids or JSON', () => {
    const collapsed = 'Worked for 14s · 5 steps';
    expect(collapsedViewContainsRawInternals(collapsed)).toBe(false);
    expect(collapsedViewContainsRawInternals('Running count_page_items')).toBe(true);
    expect(collapsedViewContainsRawInternals('[{"code":"too_big","maximum":50}]')).toBe(true);
  });

  it('expanded activity detail includes tool ids and JSON', () => {
    const expanded = activityDetailText(activity);
    expect(expanded).toContain('count_page_items');
    expect(expanded).toContain('too_big');
    expect(collapsedViewContainsRawInternals(expanded)).toBe(true);
  });
});

describe('friendlyStatusLine and errors', () => {
  it('never keeps a raw tool id in the default status', () => {
    expect(friendlyStatusLine('Running count_page_items')).toBe('Counting fixtures');
    expect(friendlyStatusLine('count_page_items')).toBe('Counting fixtures');
  });

  it('humanizes too_big JSON into one sentence', () => {
    expect(humanizeToolError('[{"code":"too_big","maximum":50}]', 'count_page_items')).toBe(
      'Counting fixtures failed: the request was too large.',
    );
  });
});

describe('approval stays outside the disclosure', () => {
  it('keeps approval blocks in visibleBlocks', () => {
    const grouped = groupAssistantBlocks(blocks);
    expect(grouped.visibleBlocks.some(b => b.type === 'approval' && b.approvalId === 'appr-1')).toBe(true);
    expect(grouped.processBlocks.some(b => b.type === 'approval')).toBe(false);
  });
});

describe('run typing smoke', () => {
  it('accepts an AssistantRun for duration math consumers', () => {
    const run: AssistantRun = {
      id: 'run-1',
      messageId: 'm1',
      conversationId: 'c1',
      status: 'completed',
      steps: [],
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(14000).toISOString(),
    };
    expect(run.id).toBe('run-1');
  });
});
