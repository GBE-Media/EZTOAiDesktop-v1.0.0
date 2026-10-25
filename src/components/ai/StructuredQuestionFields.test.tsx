import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/external-auth/client', () => ({ externalAuthClient: {} }));
import { renderToStaticMarkup } from 'react-dom/server';
import { StructuredQuestionFields } from './StructuredQuestionFields';
import type { ClarificationRequest } from '@/types/assistant';

const card: ClarificationRequest = {
  id: 'c1',
  runId: 'r1',
  messageId: 'm1',
  stepKey: 'runs',
  question: 'A couple of details before I lay out the runs on page 93',
  options: [],
  status: 'pending',
  createdAt: new Date().toISOString(),
  fields: [
    { id: 'panel_location', kind: 'point', prompt: 'Where is panel LP-1?', page: 93, pickLabel: 'Click panel LP-1 on the drawing' },
    {
      id: 'wiring_method',
      kind: 'choice',
      prompt: 'Which wiring method?',
      options: [{ id: 'a', label: 'EMT conduit', value: 'EMT' }, { id: 'b', label: 'MC cable', value: 'MC' }],
      recommended: 'MC',
    },
  ],
};

describe('StructuredQuestionFields', () => {
  it('renders the drawing pick button, choices with a recommendation, and Continue', () => {
    const html = renderToStaticMarkup(<StructuredQuestionFields clarification={card} />);
    expect(html).toContain('Show me on the drawing');
    expect(html).toContain('Where is panel LP-1?');
    expect(html).toContain('MC cable');
    expect(html).toContain('Recommended');
    expect(html).toContain('Continue');
    expect(html).toContain('Answer each step to continue');
  });

  it('shows the answers once submitted', () => {
    const html = renderToStaticMarkup(<StructuredQuestionFields clarification={{
      ...card,
      status: 'answered',
      answer: {
        selectedValues: ['MC'],
        displayText: 'x',
        fields: {
          panel_location: { point: { page: 93, xPct: 40, yPct: 12 }, label: 'Picked on page 93' },
          wiring_method: { value: 'MC', label: 'MC cable' },
        },
      },
    }} />);
    expect(html).toContain('Picked on page 93');
    expect(html).toContain('MC cable');
    expect(html).not.toContain('Show me on the drawing');
  });
});
