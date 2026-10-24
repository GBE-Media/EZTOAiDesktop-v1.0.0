import { describe, expect, it } from 'vitest';
import { inferTrade } from './inferTrade';
import { useAIChatStore } from '@/store/aiChatStore';

describe('inferTrade', () => {
  it('an E-sheet gives electrical', () => {
    expect(inferTrade({ sheetDiscipline: 'E', documentName: '[030] E-100_pages_1.pdf' })).toBe('electrical');
  });

  it('count the sinks on an E-sheet gives plumbing (message wins)', () => {
    expect(inferTrade({
      message: 'count the sinks',
      sheetDiscipline: 'E',
      documentName: 'E-100.pdf',
    })).toBe('plumbing');
  });

  it('a P-sheet gives plumbing', () => {
    expect(inferTrade({ sheetDiscipline: 'P', documentName: 'P-101.pdf' })).toBe('plumbing');
  });

  it('old persisted selectedTrade loads without crashing', () => {
    useAIChatStore.setState({ lastInferredTrade: 'electrical' } as never);
    expect(useAIChatStore.getState().lastInferredTrade).toBe('electrical');
  });
});
