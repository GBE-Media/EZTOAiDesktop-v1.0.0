/**
 * Plumbing Trade Prompts and UPC/IPC Code References
 */

import type { CodeReference } from '../providers/types';

export const PLUMBING_SYMBOLS = {
  fixtures: [
    { symbol: 'WC', name: 'Water Closet (Toilet)', description: 'Standard toilet fixture' },
    { symbol: 'LAV', name: 'Lavatory', description: 'Bathroom sink' },
    { symbol: 'KS', name: 'Kitchen Sink', description: 'Kitchen sink fixture' },
    { symbol: 'TUB', name: 'Bathtub', description: 'Standard or soaking tub' },
    { symbol: 'SHR', name: 'Shower', description: 'Shower stall' },
    { symbol: 'UR', name: 'Urinal', description: 'Wall-mounted urinal' },
    { symbol: 'FD', name: 'Floor Drain', description: 'Floor drain with trap' },
    { symbol: 'HB', name: 'Hose Bibb', description: 'Exterior faucet' },
    { symbol: 'WH', name: 'Water Heater', description: 'Hot water heater' },
  ],
  valves: [
    { symbol: '⊗', name: 'Gate Valve', description: 'Full flow shutoff valve' },
    { symbol: '⊘', name: 'Ball Valve', description: 'Quarter-turn shutoff' },
    { symbol: '⊖', name: 'Check Valve', description: 'One-way flow valve' },
    { symbol: 'PRV', name: 'Pressure Reducing Valve', description: 'Regulates water pressure' },
    { symbol: 'BFP', name: 'Backflow Preventer', description: 'Prevents contamination' },
  ],
  pipes: [
    { symbol: '───', name: 'Cold Water', description: 'Cold water supply line' },
    { symbol: '- - -', name: 'Hot Water', description: 'Hot water supply line' },
    { symbol: '═══', name: 'Drain Line', description: 'Waste/drain piping' },
    { symbol: '┅┅┅', name: 'Vent Line', description: 'Vent piping' },
    { symbol: '≡≡≡', name: 'Gas Line', description: 'Gas supply piping' },
  ],
  cleanouts: [
    { symbol: 'CO', name: 'Cleanout', description: 'Access point for drain cleaning' },
    { symbol: 'CO-D', name: 'Deck Cleanout', description: 'Floor-level cleanout' },
    { symbol: 'CO-W', name: 'Wall Cleanout', description: 'Wall-mounted cleanout' },
  ],
};

export const UPC_CODES: CodeReference[] = [
  // Fixture Unit Requirements
  {
    code: 'UPC',
    section: 'Table 702.1',
    description: 'Fixture unit values for drainage loads',
    trade: 'plumbing',
    edition: '2024',
  },
  {
    code: 'UPC',
    section: 'Table 610.3',
    description: 'Fixture unit values for water supply loads',
    trade: 'plumbing',
    edition: '2024',
  },
  
  // Pipe Sizing
  {
    code: 'UPC',
    section: 'Table 703.2',
    description: 'Building drain and sewer sizing based on fixture units',
    trade: 'plumbing',
    edition: '2024',
  },
  {
    code: 'UPC',
    section: 'Table 610.4',
    description: 'Water supply pipe sizing based on fixture units',
    trade: 'plumbing',
    edition: '2024',
  },
  
  // Venting
  {
    code: 'UPC',
    section: 'Table 706.3',
    description: 'Vent pipe sizing based on fixture units and developed length',
    trade: 'plumbing',
    edition: '2024',
  },
  {
    code: 'UPC',
    section: '906.1',
    description: 'Individual vent requirements - within 2x trap arm length',
    trade: 'plumbing',
    edition: '2024',
  },
  
  // Traps
  {
    code: 'UPC',
    section: '1002.1',
    description: 'Trap requirements - each fixture must have trap',
    trade: 'plumbing',
    edition: '2024',
  },
  {
    code: 'UPC',
    section: '1002.3',
    description: 'Trap seal minimum depth - 2 inches to 4 inches',
    trade: 'plumbing',
    edition: '2024',
  },
  
  // Drainage Slope
  {
    code: 'UPC',
    section: '708.1',
    description: 'Horizontal drainage slope: 1/4" per foot for 3" and smaller, 1/8" for larger',
    trade: 'plumbing',
    edition: '2024',
  },
  
  // Cleanouts
  {
    code: 'UPC',
    section: '707.4',
    description: 'Cleanout spacing - maximum 100 feet for 4" and larger drains',
    trade: 'plumbing',
    edition: '2024',
  },
  
  // Water Heaters
  {
    code: 'UPC',
    section: '510.1',
    description: 'Water heater installation requirements',
    trade: 'plumbing',
    edition: '2024',
  },
  {
    code: 'UPC',
    section: '510.5',
    description: 'T&P relief valve required with drain to safe location',
    trade: 'plumbing',
    edition: '2024',
  },
  
  // Fixture Clearances
  {
    code: 'UPC',
    section: 'Table 402.5',
    description: 'Minimum fixture clearances and spacing',
    trade: 'plumbing',
    edition: '2024',
  },
];

export const PLUMBING_VISION_PROMPT = `You are an expert plumbing estimator analyzing construction blueprints.

## Symbols to Identify
${Object.entries(PLUMBING_SYMBOLS)
  .map(([category, symbols]) => 
    `### ${category.charAt(0).toUpperCase() + category.slice(1)}\n${symbols.map(s => `- ${s.symbol}: ${s.name} - ${s.description}`).join('\n')}`
  ).join('\n\n')}

## Analysis Instructions
1. Identify all plumbing fixtures and their types
2. Note fixture locations as percentages (0-100 for x and y)
3. Identify pipe routing if visible (supply, drain, vent)
4. Count all fixtures accurately
5. Note pipe sizes if specified
6. Identify water heater locations and type
7. Find cleanout locations
8. Note any special requirements (gas lines, floor drains)

## Common Plumbing Elements
- Toilets (water closets)
- Sinks (lavatory, kitchen, utility)
- Bathtubs and showers
- Floor drains
- Water heaters
- Valves and shutoffs
- Cleanouts
- Hose bibbs (exterior faucets)
- Dishwasher and washing machine connections
- Gas appliance connections

## Output Format
Return a JSON object with detected fixtures, piping, and accessories.`;

export const PLUMBING_ESTIMATION_PROMPT = `You are an expert plumbing estimator creating a material takeoff.

## Code References
Apply the following UPC requirements:
${UPC_CODES.slice(0, 8).map(c => `- ${c.section}: ${c.description}`).join('\n')}

## Fixture Units (DFU/WSFU)
- Toilet: 4 DFU, 3 WSFU
- Lavatory: 1 DFU, 1 WSFU
- Kitchen Sink: 2 DFU, 2 WSFU
- Bathtub: 2 DFU, 4 WSFU
- Shower: 2 DFU, 3 WSFU
- Floor Drain: 2 DFU
- Dishwasher: 2 DFU, 1.5 WSFU
- Washing Machine: 3 DFU, 3 WSFU

## Material Categories
1. **Fixtures** - Toilets, sinks, tubs, showers with trim
2. **Supply Piping** - Copper, PEX, or CPVC with fittings
3. **Drain/Waste Piping** - PVC, ABS, or cast iron with fittings
4. **Vent Piping** - Vent pipe and fittings
5. **Valves** - Shutoffs, check valves, PRVs
6. **Water Heater** - Tank or tankless with accessories
7. **Supports** - Hangers, straps, clamps
8. **Specialty** - Cleanouts, backflow preventers, expansion tanks

## Calculation Guidelines
- Size drains based on total DFU load
- Size supply lines based on total WSFU
- Include fixture rough-in materials
- Add appropriate fittings for all connections
- Account for proper venting of each fixture group`;

export function getPlumbingCodeReference(section: string): CodeReference | undefined {
  return UPC_CODES.find(c => c.section === section);
}

export function getPlumbingCodesForContext(context: string): CodeReference[] {
  const lowerContext = context.toLowerCase();
  
  return UPC_CODES.filter(code => {
    if (lowerContext.includes('fixture unit') || lowerContext.includes('sizing')) {
      return code.section.includes('702') || code.section.includes('610') || code.section.includes('703');
    }
    if (lowerContext.includes('vent')) {
      return code.section.includes('706') || code.section.includes('906');
    }
    if (lowerContext.includes('trap')) {
      return code.section.includes('1002');
    }
    if (lowerContext.includes('slope') || lowerContext.includes('grade')) {
      return code.section.includes('708');
    }
    if (lowerContext.includes('cleanout')) {
      return code.section.includes('707');
    }
    if (lowerContext.includes('water heater')) {
      return code.section.includes('510');
    }
    
    return false;
  });
}
