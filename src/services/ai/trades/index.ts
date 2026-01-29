/**
 * Trade Prompts and Code References Index
 */

export * from './electrical';
export * from './plumbing';
export * from './hvac';

import type { TradeType, CodeReference } from '../providers/types';
import { 
  ELECTRICAL_VISION_PROMPT, 
  ELECTRICAL_ESTIMATION_PROMPT,
  NEC_CODES,
  getElectricalCodesForContext 
} from './electrical';
import { 
  PLUMBING_VISION_PROMPT, 
  PLUMBING_ESTIMATION_PROMPT,
  UPC_CODES,
  getPlumbingCodesForContext 
} from './plumbing';
import { 
  HVAC_VISION_PROMPT, 
  HVAC_ESTIMATION_PROMPT,
  IMC_CODES,
  getHvacCodesForContext 
} from './hvac';

/**
 * Get the vision prompt for a specific trade
 */
export function getVisionPrompt(trade: TradeType): string {
  switch (trade) {
    case 'electrical':
      return ELECTRICAL_VISION_PROMPT;
    case 'plumbing':
      return PLUMBING_VISION_PROMPT;
    case 'hvac':
      return HVAC_VISION_PROMPT;
    default:
      throw new Error(`Unknown trade: ${trade}`);
  }
}

/**
 * Get the estimation prompt for a specific trade
 */
export function getEstimationPrompt(trade: TradeType): string {
  switch (trade) {
    case 'electrical':
      return ELECTRICAL_ESTIMATION_PROMPT;
    case 'plumbing':
      return PLUMBING_ESTIMATION_PROMPT;
    case 'hvac':
      return HVAC_ESTIMATION_PROMPT;
    default:
      throw new Error(`Unknown trade: ${trade}`);
  }
}

/**
 * Get all code references for a specific trade
 */
export function getCodesForTrade(trade: TradeType): CodeReference[] {
  switch (trade) {
    case 'electrical':
      return NEC_CODES;
    case 'plumbing':
      return UPC_CODES;
    case 'hvac':
      return IMC_CODES;
    default:
      return [];
  }
}

/**
 * Get relevant code references based on context
 */
export function getCodesForContext(trade: TradeType, context: string): CodeReference[] {
  switch (trade) {
    case 'electrical':
      return getElectricalCodesForContext(context);
    case 'plumbing':
      return getPlumbingCodesForContext(context);
    case 'hvac':
      return getHvacCodesForContext(context);
    default:
      return [];
  }
}

/**
 * Get trade color for UI consistency
 */
export function getTradeColor(trade: TradeType): { stroke: string; fill: string } {
  switch (trade) {
    case 'electrical':
      return { stroke: '#FF5722', fill: '#FF572233' }; // Deep Orange
    case 'plumbing':
      return { stroke: '#2196F3', fill: '#2196F333' }; // Blue
    case 'hvac':
      return { stroke: '#4CAF50', fill: '#4CAF5033' }; // Green
    default:
      return { stroke: '#9E9E9E', fill: '#9E9E9E33' }; // Grey
  }
}

/**
 * Get trade display name
 */
export function getTradeName(trade: TradeType): string {
  switch (trade) {
    case 'electrical':
      return 'Electrical';
    case 'plumbing':
      return 'Plumbing';
    case 'hvac':
      return 'HVAC';
    default:
      return trade;
  }
}

/**
 * Get primary code name for trade
 */
export function getTradeCodeName(trade: TradeType): string {
  switch (trade) {
    case 'electrical':
      return 'NEC';
    case 'plumbing':
      return 'UPC/IPC';
    case 'hvac':
      return 'IMC/IECC';
    default:
      return '';
  }
}
