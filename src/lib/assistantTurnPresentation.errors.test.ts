import { describe, it, expect } from 'vitest';
import { humanizeToolError, textLooksLikeRawInternals, toolVerb } from './assistantTurnPresentation';

describe('error presentation', () => {
  it('keeps plain-English errors untouched (not treated as raw internals)', () => {
    const msg = 'No AI provider configured. Add an OpenAI API key in AI Settings.';
    expect(textLooksLikeRawInternals(msg)).toBe(false);
  });

  it('treats JSON / tool ids as raw internals', () => {
    expect(textLooksLikeRawInternals('[{"code":"too_big","maximum":50}]')).toBe(true);
    expect(textLooksLikeRawInternals('count_page_items failed')).toBe(true);
  });

  it('retry message reads naturally with a tool id', () => {
    expect(humanizeToolError('will retry', 'count_page_items')).toBe(
      "Couldn't count fixtures on the first try, retrying...",
    );
    expect(humanizeToolError('retrying', 'place_markups')).toBe(
      "Couldn't place markups on the first try, retrying...",
    );
  });

  it('retry message reads naturally without a tool id', () => {
    expect(humanizeToolError('retrying')).toBe("Couldn't finish that step on the first try, retrying...");
    expect(toolVerb('unknown_tool')).toBe('finish that step');
  });

  it('generic failure without tool id', () => {
    expect(humanizeToolError('boom')).toBe('That step failed.');
  });
});
