/**
 * Electrical Trade Prompts and NEC Code References
 */

import type { TradeType, CodeReference } from '../providers/types';

export const ELECTRICAL_SYMBOLS = {
  outlets: [
    { symbol: '⊙', name: 'Duplex Receptacle', description: 'Standard 120V duplex outlet' },
    { symbol: '⊙WP', name: 'Weatherproof Receptacle', description: 'Outdoor rated outlet' },
    { symbol: '⊙GFI', name: 'GFCI Receptacle', description: 'Ground fault circuit interrupter' },
    { symbol: '⊙DED', name: 'Dedicated Circuit Outlet', description: 'Single appliance circuit' },
    { symbol: '⊙220', name: '220V Receptacle', description: 'High voltage outlet' },
  ],
  switches: [
    { symbol: 'S', name: 'Single Pole Switch', description: 'Standard on/off switch' },
    { symbol: 'S3', name: '3-Way Switch', description: 'Controls light from two locations' },
    { symbol: 'S4', name: '4-Way Switch', description: 'Controls light from three+ locations' },
    { symbol: 'SD', name: 'Dimmer Switch', description: 'Variable brightness control' },
    { symbol: 'SWP', name: 'Weatherproof Switch', description: 'Outdoor rated switch' },
  ],
  lighting: [
    { symbol: '○', name: 'Surface Mount Light', description: 'Ceiling or wall mount fixture' },
    { symbol: '◎', name: 'Recessed Light', description: 'In-ceiling can light' },
    { symbol: '⊗', name: 'Pendant Light', description: 'Hanging fixture' },
    { symbol: '◐', name: 'Wall Sconce', description: 'Wall mounted fixture' },
    { symbol: '⊕', name: 'Emergency Light', description: 'Battery backup fixture' },
    { symbol: '☼', name: 'Exterior Light', description: 'Outdoor fixture' },
  ],
  panels: [
    { symbol: '▣', name: 'Main Panel', description: 'Main electrical panel/breaker box' },
    { symbol: '▢', name: 'Subpanel', description: 'Secondary distribution panel' },
    { symbol: '⊞', name: 'Disconnect', description: 'Service disconnect switch' },
  ],
  other: [
    { symbol: '△', name: 'Junction Box', description: 'Wire connection point' },
    { symbol: '⊡', name: 'Floor Box', description: 'Floor mounted outlet box' },
    { symbol: '⊠', name: 'Motor Connection', description: 'Motor/equipment connection' },
  ],
};

export const NEC_CODES: CodeReference[] = [
  // Receptacle Requirements
  {
    code: 'NEC',
    section: '210.52(A)',
    description: 'Dwelling unit receptacle outlets - Wall space requirements (no point along wall more than 6 ft from outlet)',
    trade: 'electrical',
    edition: '2023',
  },
  {
    code: 'NEC',
    section: '210.52(B)',
    description: 'Small appliance circuits in kitchen - minimum two 20A circuits',
    trade: 'electrical',
    edition: '2023',
  },
  {
    code: 'NEC',
    section: '210.52(C)',
    description: 'Countertop receptacle spacing - maximum 4 ft apart, within 2 ft of end',
    trade: 'electrical',
    edition: '2023',
  },
  {
    code: 'NEC',
    section: '210.52(D)',
    description: 'Bathroom receptacle - minimum one GFCI outlet within 3 ft of sink',
    trade: 'electrical',
    edition: '2023',
  },
  {
    code: 'NEC',
    section: '210.52(E)',
    description: 'Outdoor receptacles - minimum one front and one back, GFCI protected',
    trade: 'electrical',
    edition: '2023',
  },
  {
    code: 'NEC',
    section: '210.52(G)',
    description: 'Garage receptacles - minimum one receptacle in each vehicle bay',
    trade: 'electrical',
    edition: '2023',
  },
  
  // GFCI Requirements
  {
    code: 'NEC',
    section: '210.8(A)',
    description: 'GFCI protection required: bathrooms, garages, outdoors, kitchens, laundry, basements',
    trade: 'electrical',
    edition: '2023',
  },
  
  // AFCI Requirements
  {
    code: 'NEC',
    section: '210.12(A)',
    description: 'AFCI protection required for bedrooms, living areas, and most habitable spaces',
    trade: 'electrical',
    edition: '2023',
  },
  
  // Circuit Requirements
  {
    code: 'NEC',
    section: '210.11(C)(1)',
    description: 'Bathroom branch circuit - dedicated 20A circuit',
    trade: 'electrical',
    edition: '2023',
  },
  {
    code: 'NEC',
    section: '210.11(C)(2)',
    description: 'Laundry circuit - dedicated 20A circuit',
    trade: 'electrical',
    edition: '2023',
  },
  
  // Conduit Fill
  {
    code: 'NEC',
    section: '310.16',
    description: 'Ampacity of conductors - wire sizing based on load',
    trade: 'electrical',
    edition: '2023',
  },
  {
    code: 'NEC',
    section: 'Chapter 9, Table 1',
    description: 'Conduit fill limits: 1 wire = 53%, 2 wires = 31%, 3+ wires = 40%',
    trade: 'electrical',
    edition: '2023',
  },
  
  // Lighting
  {
    code: 'NEC',
    section: '210.70',
    description: 'Lighting outlet requirements by room type',
    trade: 'electrical',
    edition: '2023',
  },
  {
    code: 'NEC',
    section: '410.16',
    description: 'Recessed luminaire clearances from insulation',
    trade: 'electrical',
    edition: '2023',
  },
];

export const ELECTRICAL_VISION_PROMPT = `You are an expert electrical estimator analyzing construction blueprints.

## Symbols to Identify
${Object.entries(ELECTRICAL_SYMBOLS)
  .map(([category, symbols]) => 
    `### ${category.charAt(0).toUpperCase() + category.slice(1)}\n${symbols.map(s => `- ${s.symbol}: ${s.name} - ${s.description}`).join('\n')}`
  ).join('\n\n')}

## Analysis Instructions
1. Identify all electrical symbols and components on the page
2. Note their approximate locations as percentages (0-100 for both x and y)
3. Count quantities accurately
4. Identify circuit assignments if visible (home runs, circuit numbers)
5. Note conduit paths if shown
6. Extract any electrical notes or specifications

## Common Electrical Elements to Find
- Receptacle outlets (standard, GFCI, dedicated, 220V)
- Switches (single pole, 3-way, 4-way, dimmers)
- Light fixtures (recessed, surface, pendant, wall sconce)
- Panels and subpanels
- Junction boxes
- Smoke/CO detectors
- Fans and exhaust equipment
- Special equipment connections

## Output Format
Return a JSON object with detected items, including confidence scores and any visible specifications.`;

export const ELECTRICAL_ESTIMATION_PROMPT = `You are an expert electrical estimator creating a material takeoff.

## Code References
Apply the following NEC requirements:
${NEC_CODES.slice(0, 10).map(c => `- ${c.section}: ${c.description}`).join('\n')}

## Material Categories
1. **Wiring** - Calculate wire runs based on device locations and panel location
2. **Devices** - Outlets, switches, dimmers with appropriate ratings
3. **Boxes** - Device boxes, junction boxes (size based on wire fill)
4. **Conduit** - EMT, rigid, or flex based on installation requirements
5. **Fittings** - Connectors, couplings, straps, hangers
6. **Fixtures** - Light fixtures, ceiling fans
7. **Panels & Breakers** - Panel capacity and breaker requirements

## Calculation Guidelines
- Add 10% waste factor for wire
- Include home run wiring to panel
- Count all device boxes and covers
- Include required GFCI and AFCI protection
- Account for wire connectors and accessories`;

export function getElectricalCodeReference(section: string): CodeReference | undefined {
  return NEC_CODES.find(c => c.section === section);
}

export function getElectricalCodesForContext(context: string): CodeReference[] {
  const lowerContext = context.toLowerCase();
  
  return NEC_CODES.filter(code => {
    const lowerDesc = code.description.toLowerCase();
    
    if (lowerContext.includes('outlet') || lowerContext.includes('receptacle')) {
      return code.section.startsWith('210.52') || code.section.startsWith('210.8');
    }
    if (lowerContext.includes('kitchen')) {
      return code.section.includes('210.52(B)') || code.section.includes('210.52(C)');
    }
    if (lowerContext.includes('bathroom')) {
      return code.section.includes('210.52(D)') || code.section.includes('210.11(C)(1)');
    }
    if (lowerContext.includes('gfci')) {
      return code.section.includes('210.8');
    }
    if (lowerContext.includes('afci')) {
      return code.section.includes('210.12');
    }
    if (lowerContext.includes('conduit') || lowerContext.includes('wire')) {
      return code.section.includes('310') || code.section.includes('Chapter 9');
    }
    if (lowerContext.includes('light')) {
      return code.section.includes('210.70') || code.section.includes('410');
    }
    
    return false;
  });
}
