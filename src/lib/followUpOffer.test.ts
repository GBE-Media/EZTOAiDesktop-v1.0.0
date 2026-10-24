import { describe, expect, it } from 'vitest';
import { detectFollowUpOffer } from './followUpOffer';

const ANSWER = `I ran lighting symbol detection on **Sheet E-100 – Lighting Plan**.

| Type | Count |
|---|---:|
| A | 10 |

Would you like me to place **review/count markers** on the sheet so you can verify each detected light and unresolved symbol?`;

describe('detectFollowUpOffer', () => {
  it('turns a trailing marker offer into one-click replies', () => {
    const offer = detectFollowUpOffer(ANSWER);
    expect(offer).not.toBeNull();
    expect(offer!.options[0].label).toBe('Yes, place markers');
    expect(offer!.options[0].reply).toBe(
      'Yes, please place review/count markers on the sheet so I can verify each detected light and unresolved symbol.',
    );
    expect(offer!.options[1]).toMatchObject({ label: 'Not now', reply: null });
  });

  it('handles generic offers', () => {
    const offer = detectFollowUpOffer('Counts are done. Should I check the spec for fixture type C?');
    expect(offer!.options[0].label).toBe('Yes, go ahead');
    expect(offer!.options[0].reply).toBe('Yes, please check the spec for fixture type C.');
  });

  it('ignores answers that do not end with an offer', () => {
    expect(detectFollowUpOffer('There are 10 type A fixtures.')).toBeNull();
    expect(detectFollowUpOffer('Would you like me to place markers? I found 10 fixtures.')).toBeNull();
    expect(detectFollowUpOffer('What ceiling height should I assume?')).toBeNull();
    expect(detectFollowUpOffer('')).toBeNull();
  });
});
