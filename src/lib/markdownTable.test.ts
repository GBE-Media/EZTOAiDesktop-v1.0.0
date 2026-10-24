import { describe, expect, it } from 'vitest';
import { readMarkdownTable } from './markdownTable';

describe('readMarkdownTable', () => {
  it('parses a GFM pipe table with alignment row', () => {
    const lines = ['Intro', '| Type | Count |', '|---|---:|', '| A | 10 |', '| A/EM | 1 |', '', 'After'];
    const table = readMarkdownTable(lines, 1);
    expect(table).toEqual({ header: ['Type', 'Count'], rows: [['A', '10'], ['A/EM', '1']], endIndex: 4 });
  });

  it('needs a separator row', () => {
    expect(readMarkdownTable(['| a | b |', '| c | d |'], 0)).toBeNull();
    expect(readMarkdownTable(['plain text'], 0)).toBeNull();
  });
});
