/**
 * Location Extractor
 * Extracts project location from blueprints for code jurisdiction mapping
 */

import type { ProjectLocation } from './providers/types';

// State abbreviation to full name mapping
const STATE_NAMES: Record<string, string> = {
  'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas',
  'CA': 'California', 'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware',
  'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii', 'ID': 'Idaho',
  'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas',
  'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland',
  'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi',
  'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada',
  'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York',
  'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma',
  'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina',
  'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah',
  'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia',
  'WI': 'Wisconsin', 'WY': 'Wyoming', 'DC': 'District of Columbia',
};

// Jurisdiction code adoption data (simplified)
interface JurisdictionCodeInfo {
  state: string;
  necEdition: string;
  upcOrIpc: 'UPC' | 'IPC';
  upcIpcEdition: string;
  imcEdition: string;
  ibcEdition: string;
  notes?: string;
}

const JURISDICTION_CODES: Record<string, JurisdictionCodeInfo> = {
  'CA': { state: 'California', necEdition: '2023', upcOrIpc: 'UPC', upcIpcEdition: '2022', imcEdition: '2022', ibcEdition: '2022' },
  'TX': { state: 'Texas', necEdition: '2023', upcOrIpc: 'IPC', upcIpcEdition: '2021', imcEdition: '2021', ibcEdition: '2021' },
  'FL': { state: 'Florida', necEdition: '2023', upcOrIpc: 'IPC', upcIpcEdition: '2023', imcEdition: '2023', ibcEdition: '2023' },
  'NY': { state: 'New York', necEdition: '2020', upcOrIpc: 'IPC', upcIpcEdition: '2020', imcEdition: '2020', ibcEdition: '2020' },
  'PA': { state: 'Pennsylvania', necEdition: '2017', upcOrIpc: 'IPC', upcIpcEdition: '2018', imcEdition: '2018', ibcEdition: '2018' },
  'IL': { state: 'Illinois', necEdition: '2020', upcOrIpc: 'IPC', upcIpcEdition: '2021', imcEdition: '2021', ibcEdition: '2021' },
  'OH': { state: 'Ohio', necEdition: '2023', upcOrIpc: 'IPC', upcIpcEdition: '2021', imcEdition: '2021', ibcEdition: '2021' },
  'GA': { state: 'Georgia', necEdition: '2020', upcOrIpc: 'IPC', upcIpcEdition: '2018', imcEdition: '2018', ibcEdition: '2018' },
  'NC': { state: 'North Carolina', necEdition: '2020', upcOrIpc: 'IPC', upcIpcEdition: '2018', imcEdition: '2018', ibcEdition: '2018' },
  'MI': { state: 'Michigan', necEdition: '2020', upcOrIpc: 'IPC', upcIpcEdition: '2021', imcEdition: '2021', ibcEdition: '2021' },
  'AZ': { state: 'Arizona', necEdition: '2023', upcOrIpc: 'UPC', upcIpcEdition: '2022', imcEdition: '2021', ibcEdition: '2021' },
  'WA': { state: 'Washington', necEdition: '2023', upcOrIpc: 'UPC', upcIpcEdition: '2021', imcEdition: '2021', ibcEdition: '2021' },
  'CO': { state: 'Colorado', necEdition: '2023', upcOrIpc: 'IPC', upcIpcEdition: '2021', imcEdition: '2021', ibcEdition: '2021' },
  'NV': { state: 'Nevada', necEdition: '2023', upcOrIpc: 'UPC', upcIpcEdition: '2022', imcEdition: '2021', ibcEdition: '2021' },
  'OR': { state: 'Oregon', necEdition: '2023', upcOrIpc: 'UPC', upcIpcEdition: '2022', imcEdition: '2022', ibcEdition: '2022' },
};

// Default code info for states not in the list
const DEFAULT_CODES: JurisdictionCodeInfo = {
  state: 'Unknown',
  necEdition: '2023',
  upcOrIpc: 'IPC',
  upcIpcEdition: '2021',
  imcEdition: '2021',
  ibcEdition: '2021',
  notes: 'Using default code editions - verify local requirements',
};

/**
 * Extract location from text content (title block, notes, etc.)
 */
export function extractLocationFromText(text: string): ProjectLocation | null {
  if (!text) return null;
  
  // Try to find address patterns
  const addressPatterns = [
    // Street address pattern
    /(\d+[\s\-]?\w*\s+(?:[NSEW]\.?\s+)?(?:\w+\s+)*(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Circle|Cir)\.?)/i,
    // General address with city, state, zip
    /([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/i,
  ];
  
  let address: string | undefined;
  let city: string | undefined;
  let state: string | undefined;
  let zipCode: string | undefined;
  
  // Try city, state, zip pattern
  const cityStateZipMatch = text.match(/([A-Za-z\s]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/);
  if (cityStateZipMatch) {
    city = cityStateZipMatch[1].trim();
    state = cityStateZipMatch[2];
    zipCode = cityStateZipMatch[3];
  }
  
  // Try just state abbreviation
  if (!state) {
    for (const abbrev of Object.keys(STATE_NAMES)) {
      const statePattern = new RegExp(`\\b${abbrev}\\b`, 'i');
      if (statePattern.test(text)) {
        state = abbrev.toUpperCase();
        break;
      }
    }
  }
  
  // Try to find street address
  for (const pattern of addressPatterns) {
    const match = text.match(pattern);
    if (match) {
      address = match[1] || match[0];
      break;
    }
  }
  
  // Try zip code alone
  if (!zipCode) {
    const zipMatch = text.match(/\b(\d{5}(?:-\d{4})?)\b/);
    if (zipMatch) {
      zipCode = zipMatch[1];
    }
  }
  
  if (!address && !city && !state && !zipCode) {
    return null;
  }
  
  return {
    address,
    city,
    state,
    zipCode,
    country: 'USA',
    jurisdiction: state ? STATE_NAMES[state] : undefined,
  };
}

/**
 * Get applicable code editions for a jurisdiction
 */
export function getJurisdictionCodes(location: ProjectLocation): {
  nec: { code: string; edition: string };
  plumbing: { code: string; edition: string };
  mechanical: { code: string; edition: string };
  building: { code: string; edition: string };
  notes?: string;
} {
  const stateAbbrev = location.state?.toUpperCase();
  const codeInfo = stateAbbrev && JURISDICTION_CODES[stateAbbrev]
    ? JURISDICTION_CODES[stateAbbrev]
    : DEFAULT_CODES;
  
  return {
    nec: { code: 'NEC', edition: codeInfo.necEdition },
    plumbing: { code: codeInfo.upcOrIpc, edition: codeInfo.upcIpcEdition },
    mechanical: { code: 'IMC', edition: codeInfo.imcEdition },
    building: { code: 'IBC', edition: codeInfo.ibcEdition },
    notes: codeInfo.notes,
  };
}

/**
 * Format location for display
 */
export function formatLocation(location: ProjectLocation): string {
  const parts: string[] = [];
  
  if (location.address) parts.push(location.address);
  if (location.city) parts.push(location.city);
  if (location.state) parts.push(location.state);
  if (location.zipCode) parts.push(location.zipCode);
  
  return parts.join(', ');
}

/**
 * Get state full name from abbreviation
 */
export function getStateName(abbrev: string): string | undefined {
  return STATE_NAMES[abbrev.toUpperCase()];
}

/**
 * Build code context for AI prompts
 */
export function buildCodeContext(location: ProjectLocation): string {
  const codes = getJurisdictionCodes(location);
  const stateName = location.state ? getStateName(location.state) : 'Unknown';
  
  let context = `Project Location: ${formatLocation(location)}\n`;
  context += `Jurisdiction: ${stateName}\n\n`;
  context += `Applicable Codes:\n`;
  context += `- Electrical: NEC ${codes.nec.edition}\n`;
  context += `- Plumbing: ${codes.plumbing.code} ${codes.plumbing.edition}\n`;
  context += `- Mechanical: IMC ${codes.mechanical.edition}\n`;
  context += `- Building: IBC ${codes.building.edition}\n`;
  
  if (codes.notes) {
    context += `\nNote: ${codes.notes}`;
  }
  
  return context;
}
