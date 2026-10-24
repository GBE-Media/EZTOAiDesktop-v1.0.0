import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/external-auth/client', () => ({ externalAuthClient: {} }));
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMessage } from './ChatMessage';

const ANSWER = `I started the lighting takeoff on the E sheets.

### Confirmed from the drawings
▪ Lighting legend and schedule are on **E-2.1, page 92**.
▪ Plan sheets found:
  - E-3 / page 93 – first/second floor
  - E-4 / page 94 – third/fourth floor`;

describe('assistant markdown headings and nested bullets', () => {
  it('renders ### as a section title and nested bullets without raw markers', () => {
    const html = renderToStaticMarkup(
      <ChatMessage message={{ id: 'm1', role: 'assistant', content: ANSWER, timestamp: new Date(), blocks: [] } as never} />,
    );
    expect(html).not.toContain('###');
    expect(html).toContain('font-semibold');
    expect(html).toContain('Confirmed from the drawings');
    expect(html).not.toContain('▪');
    expect(html).not.toMatch(/>\s*- E-3/);
    expect(html).toContain('pl-4');
    expect(html).toContain('<strong>');
  });
});
