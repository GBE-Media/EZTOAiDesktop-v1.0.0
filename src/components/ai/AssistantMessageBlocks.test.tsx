import '@/services/ai/agent/testGlobals';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantMarkdown } from './AssistantMarkdown';
import { AssistantMessageBlocks } from './AssistantMessageBlocks';

describe('AssistantMarkdown', () => {
  it('renders bold, list, link, and inline code as HTML elements (not raw markdown)', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown
        markdown={'**Bold title**\n\n- item one\n- item two\n\nSee [docs](https://example.com) and `code`.'}
      />,
    );

    expect(html).toContain('<strong>');
    expect(html).toContain('Bold title');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('<code>');
    expect(html).not.toContain('**Bold title**');
    expect(html).not.toContain('`code`');
  });

  it('returns null for empty markdown', () => {
    expect(renderToStaticMarkup(<AssistantMarkdown markdown="   " />)).toBe('');
  });
});

describe('AssistantMessageBlocks grouping', () => {
  it('renders a collapsed process disclosure and keeps approval outside it', () => {
    const html = renderToStaticMarkup(
      <AssistantMessageBlocks
        blocks={[
          { id: 'a', type: 'activity', runId: 'run-1' },
          {
            id: 't',
            type: 'tool-result',
            activity: {
              id: 'act-1',
              toolId: 'count_page_items',
              title: 'count_page_items',
              status: 'completed',
              output: [{ code: 'too_big', maximum: 50 }],
            },
          },
          { id: 'ap', type: 'approval', approvalId: 'appr-1' },
          { id: 'md', type: 'markdown', markdown: 'Ready to place markers.' },
        ]}
      />,
    );
    expect(html).toContain('data-testid="turn-process"');
    expect(html).toContain('data-testid="visible-approval"');
    const processIdx = html.indexOf('data-testid="turn-process"');
    const visibleIdx = html.indexOf('data-testid="turn-visible"');
    expect(processIdx).toBeGreaterThan(-1);
    expect(visibleIdx).toBeGreaterThan(processIdx);
    expect(html).not.toContain('data-testid="turn-process-details"');
    expect(html).not.toContain('count_page_items');
    expect(html).not.toContain('too_big');
  });
});

describe('AssistantMessageBlocks markdown', () => {
  it('routes markdown blocks through the real renderer', () => {
    const html = renderToStaticMarkup(
      <AssistantMessageBlocks
        blocks={[{
          id: 'md1',
          type: 'markdown',
          markdown: 'Use **place_markups** carefully.',
        }]}
      />,
    );
    expect(html).toContain('<strong>');
    expect(html).toContain('place_markups');
    expect(html).not.toContain('**place_markups**');
  });
});
