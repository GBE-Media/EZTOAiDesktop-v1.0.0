import type { TradeType } from './providers/types';
import { allIndexedPages } from './projectIndex/store';

const MESSAGE_TRADES: Array<{ trade: TradeType; pattern: RegExp }> = [
  { trade: 'plumbing', pattern: /\b(plumb(?:ing)?|sinks?|toilets?|urinals?|lavator(?:y|ies)|water\s*closet|wc\b|p-trap|domestic\s+water)\b/i },
  { trade: 'hvac', pattern: /\b(hvac|mechanical|duct(?:work)?|vav|ahu|diffusers?|grilles?|thermostats?)\b/i },
  { trade: 'electrical', pattern: /\b(electrical|light(?:ing)?|fixtures?|receptacles?|panels?|conduit|switchgear|luminaire)\b/i },
];

const DISCIPLINE_TRADE: Record<string, TradeType> = {
  E: 'electrical',
  FA: 'electrical',
  T: 'electrical',
  P: 'plumbing',
  FP: 'plumbing',
  M: 'hvac',
};

export function inferTrade(input: {
  message?: string;
  sheetDiscipline?: string | null;
  documentName?: string | null;
  conversationTrade?: TradeType | null;
}): TradeType {
  const message = String(input.message || '').trim();
  for (const row of MESSAGE_TRADES) {
    if (message && row.pattern.test(message)) return row.trade;
  }

  const discipline = (input.sheetDiscipline || disciplineFromName(input.documentName) || '').toUpperCase();
  if (discipline && DISCIPLINE_TRADE[discipline]) return DISCIPLINE_TRADE[discipline];

  if (input.conversationTrade) return input.conversationTrade;
  return 'electrical';
}

export function inferTradeFromOpenSheet(message?: string, conversationTrade?: TradeType | null): TradeType {
  const pages = allIndexedPages();
  const active = pages.find(page => page.sheetNumber) || pages[0];
  return inferTrade({
    message,
    sheetDiscipline: active?.discipline,
    documentName: active?.documentName,
    conversationTrade,
  });
}

function disciplineFromName(name?: string | null): string | null {
  if (!name) return null;
  const match = name.match(/\b([A-Z]{1,3})-\d{1,3}\b/);
  return match?.[1] || null;
}
