import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compareModels, describeComparison, scoreModel, type ComparisonRun } from './modelComparison';
import { runIntake } from './phases/intake';
import { decideRoutingPolicy } from './routing/policy';

const sendProxyRequest = vi.fn();
vi.mock('../proxyClient', () => ({
  sendProxyRequest: (...args: unknown[]) => sendProxyRequest(...args),
  isProxyAvailable: async () => true,
  ProxyRequestError: class extends Error {},
}));

const check = (checked: number, onSymbol: number, extra = 0) => ({
  checked, onSymbol, snapped: checked - onSymbol, duplicates: extra, added: 0, medianOffsetPt: 4,
});
const run = (a: number, b: number, sym = check(a + b, Math.round((a + b) * 0.8)), seconds = 60): ComparisonRun => ({
  typeCounts: { A: a, B: b }, symbolCheck: sym, seconds, answeredBy: ['m'],
});

describe('vision model comparison scoring', () => {
  it('measures run-to-run variation, placement and clean-up', () => {
    const s = scoreModel('gpt', [run(50, 20), run(52, 20), run(49, 21)]);
    expect(s.runsCompleted).toBe(3);
    expect(s.totals).toEqual([70, 72, 70]);
    // (3 + 1) / (50.33 + 20.33) = 5.7%
    expect(s.variationPct).toBeCloseTo(5.7, 1);
    expect(s.worstType).toMatchObject({ type: 'A', counts: [50, 52, 49] });
    expect(s.onSymbolPct).toBeCloseTo(80, 0);
  });

  it('recommends the candidate only when it is clearly better and never less consistent', () => {
    const gpt = scoreModel('gpt', [run(50, 20), run(53, 20), run(48, 21)]);
    const gemini = scoreModel('gemini', [run(51, 20, check(71, 66)), run(51, 20, check(71, 67)), run(51, 20, check(71, 66))]);
    const v = compareModels(gpt, gemini);
    expect(v.switchRecommended).toBe(true);
    expect(v.recommended).toBe('gemini');
    expect(v.reasons.join(' ')).toMatch(/More consistent/);

    // Better placement but less consistent → keep the current model.
    const sloppy = scoreModel('gemini', [run(45, 20, check(65, 64)), run(55, 20, check(75, 74))]);
    const steady = scoreModel('gpt', [run(50, 20), run(50, 20)]);
    expect(compareModels(steady, sloppy).switchRecommended).toBe(false);
  });

  it('keeps the current model on a tie or when the candidate fails, and lists disagreements', () => {
    const a = scoreModel('gpt', [run(50, 20), run(50, 20)]);
    const tie = compareModels(a, scoreModel('gemini', [run(50, 20), run(50, 20)]));
    expect(tie.switchRecommended).toBe(false);
    expect(tie.disagreements).toEqual([]);
    const failed = compareModels(a, scoreModel('gemini', [{ seconds: 1, error: 'model not available' }]));
    expect(failed.switchRecommended).toBe(false);
    expect(failed.reasons[0]).toMatch(/didn't complete a count \(model not available\)/);
    const differ = compareModels(a, scoreModel('gemini', [run(58, 20), run(58, 20)]));
    expect(differ.disagreements).toEqual([{ type: 'A', current: 50, candidate: 58 }]);
    expect(describeComparison(differ, 93).join('\n')).toMatch(/Counts differ on: A \(50 vs 58\)/);
  });
});

describe('strict model override', () => {
  beforeEach(() => { sendProxyRequest.mockReset(); });
  it('sends vision calls to exactly the trial model with no fallback, then restores the setting', async () => {
    const { AIService } = await import('../aiService');
    const service = new AIService();
    service.initialize();
    sendProxyRequest.mockResolvedValue({ content: '{}', model: 'google/gemini-3.1-pro-preview' });
    const out = await service.withVisionModel({ provider: 'lovable', model: 'google/gemini-3.1-pro-preview' }, async () => {
      await service.vision({ messages: [{ role: 'user', content: 'x' }] });
      return 1;
    });
    expect(sendProxyRequest.mock.calls[0][0].model).toBe('google/gemini-3.1-pro-preview');
    expect(out).toMatchObject({ result: 1, calls: 1, answeredBy: ['google/gemini-3.1-pro-preview'] });
    expect(service.getModelForStage('vision')).toBe('openai/gpt-5.6-sol');
  });

  it('does not fall back to another model when the trial model is refused', async () => {
    const { AIService } = await import('../aiService');
    const service = new AIService();
    service.initialize();
    sendProxyRequest.mockImplementation(async () => { throw new Error('model not permitted'); });
    let message = '';
    try {
      await service.withVisionModel({ provider: 'lovable', model: 'google/gemini-3.1-pro-preview' },
        () => service.vision({ messages: [{ role: 'user', content: 'x' }] }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('model not permitted');
    expect(sendProxyRequest.mock.calls.length).toBe(1);
  });
});

describe('routing', () => {
  it.each(['run a test to see if switching to gemini 3.1 would be better', 'compare the vision models on this page', 'is gemini better than gpt?'])(
    'routes "%s" to the comparison tool',
    message => {
      const decision = decideRoutingPolicy(runIntake({ userMessage: message, userIntent: message, trade: 'electrical' }));
      expect(decision.suggestedTools[0]).toBe('compare_vision_models');
    },
  );
});
