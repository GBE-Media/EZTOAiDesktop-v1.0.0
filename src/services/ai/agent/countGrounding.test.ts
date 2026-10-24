import { describe, expect, it } from 'vitest';
import { groundAnswerToCountTool } from './countGrounding';

describe('count grounding', () => {
  const tool = { total: 149, matchingTypeCounts: { A: 87, E: 19 } };

  it('keeps the written answer when it mentions page or sheet numbers', () => {
    const draft = 'On page 93 (E-2.1) I found 149 lighting fixtures: 87 type A and 19 type E.';
    expect(groundAnswerToCountTool(draft, tool)).toEqual({ message: draft, revised: false, issues: [] });
  });

  it('accepts a total summed across several sheets', () => {
    const counts = [{ total: 149 }, { total: 51 }];
    const draft = 'Across both sheets I counted 200 fixtures.';
    expect(groundAnswerToCountTool(draft, counts[1], counts).revised).toBe(false);
  });

  it('fixes a wrong headline number without discarding the answer', () => {
    const result = groundAnswerToCountTool('I counted 160 fixtures on page 93. Want me to place them?', tool);
    expect(result.revised).toBe(true);
    expect(result.message).toBe('I counted 149 fixtures on page 93. Want me to place them?');
  });
});
