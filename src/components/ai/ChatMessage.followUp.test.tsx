import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/external-auth/client', () => ({ externalAuthClient: {} }));
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMessage } from './ChatMessage';
import { useAISettingsStore } from '@/store/aiSettingsStore';
import { detectFollowUpOffer } from '@/lib/followUpOffer';

const ANSWER = `I ran lighting symbol detection on **Sheet E-100 – Lighting Plan**.

**Detected type counts from the analysis:**

| Type | Count |
|---|---:|
| A | 10 |
| B | 5 |

Would you like me to place **review/count markers** on the sheet so you can verify each detected light and unresolved symbol?`;

describe('assistant answer rendering (E-100 screenshot regression)', () => {
  it('renders the table, shows the answer once, and attaches a follow-up card', () => {
    useAISettingsStore.setState({ showActivityTimeline: true, showEvidenceCitations: true } as never);
    const offer = detectFollowUpOffer(ANSWER)!;
    const html = renderToStaticMarkup(
      <ChatMessage
        message={{
          id: 'm1',
          role: 'assistant',
          content: ANSWER,
          timestamp: new Date('2026-10-24T05:12:00Z'),
          blocks: [
            {
              id: 'r1',
              type: 'result',
              result: { summary: ANSWER.slice(0, 400), actionsTaken: ['Counted 5 item(s) on page 1.'] },
            },
            { id: 'f1', type: 'follow-up', messageId: 'm1', question: offer.question, options: offer.options },
          ],
        } as never}
      />,
    );
    expect(html).toContain('data-testid="chat-table"');
    expect(html).not.toContain('|---|');
    // The answer text appears exactly once (no raw duplicate in a Result card).
    expect(html.split('I ran lighting symbol detection').length - 1).toBe(1);
    expect(html).not.toContain('data-testid="result-recap"'); // collapsed inside "Worked for…"
    expect(html).toContain('data-testid="follow-up-card"');
    expect(html).toContain('Yes, place markers');
    expect(html).toContain('Not now');
  });
});
