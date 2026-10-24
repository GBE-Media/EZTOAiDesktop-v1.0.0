import { describe, expect, it } from 'vitest';
import { offerAfterCount, offerAfterPlacement } from './nextStepOffer';

const count = (total: number, extra: Record<string, unknown> = {}) => ({
  toolId: 'count_page_items',
  args: { page: 93, query: 'lighting fixtures' },
  result: { status: 'completed', output: { total, ...extra } },
});

describe('next-step offers', () => {
  it('offers to place markers after a count', () => {
    const offer = offerAfterCount([count(149, { unresolvedReturned: 4 })]);
    expect(offer?.question).toBe('Place the 149 counted items on page 93 on the drawing?');
    expect(offer?.options.map(o => o.label)).toEqual(['Place count markers', 'Also mark 4 to review', 'Not now']);
    expect(offer?.options[0].primary).toBe(true);
  });

  it('does not offer again once markers were placed or nothing was counted', () => {
    expect(offerAfterCount([count(149), { toolId: 'place_markups', result: { status: 'needs_approval' } }])).toBeNull();
    expect(offerAfterCount([count(0)])).toBeNull();
    expect(offerAfterCount([])).toBeNull();
  });

  it('offers suggested runs after electrical markers are placed', () => {
    const offer = offerAfterPlacement({ approvalToolId: 'place_markups', placed: 149, page: 93, history: [count(149)] });
    expect(offer?.options[0].label).toBe('Suggest runs');
    expect(offer?.question).toMatch(/page 93/);
    expect(offerAfterPlacement({ approvalToolId: 'place_markups', placed: 0, history: [count(149)] })).toBeNull();
    expect(offerAfterPlacement({ approvalToolId: 'suggest_runs', placed: 3 })).toBeNull();
    expect(offerAfterPlacement({ approvalToolId: 'place_markups', placed: 5, trade: 'plumbing' })).toBeNull();
  });
});
