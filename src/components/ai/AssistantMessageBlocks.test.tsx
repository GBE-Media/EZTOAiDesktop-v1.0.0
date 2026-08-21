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
