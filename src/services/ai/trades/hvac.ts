/**
 * HVAC Trade Prompts and IMC/IECC Code References
 */

import type { CodeReference } from '../providers/types';

export const HVAC_SYMBOLS = {
  diffusers: [
    { symbol: '□', name: 'Supply Diffuser', description: 'Ceiling supply air diffuser' },
    { symbol: '◇', name: 'Return Grille', description: 'Return air grille' },
    { symbol: '△', name: 'Exhaust Grille', description: 'Exhaust air grille' },
    { symbol: '○SD', name: 'Slot Diffuser', description: 'Linear slot diffuser' },
    { symbol: '⊞', name: 'Perforated Diffuser', description: 'Perforated face diffuser' },
  ],
  equipment: [
    { symbol: 'AHU', name: 'Air Handler', description: 'Air handling unit' },
    { symbol: 'RTU', name: 'Rooftop Unit', description: 'Packaged rooftop unit' },
    { symbol: 'FCU', name: 'Fan Coil Unit', description: 'Fan coil terminal unit' },
    { symbol: 'VAV', name: 'VAV Box', description: 'Variable air volume box' },
    { symbol: 'CU', name: 'Condensing Unit', description: 'Outdoor condenser' },
    { symbol: 'HP', name: 'Heat Pump', description: 'Heat pump system' },
    { symbol: 'FUR', name: 'Furnace', description: 'Gas or electric furnace' },
  ],
  ductwork: [
    { symbol: '═══', name: 'Supply Duct', description: 'Supply air ductwork' },
    { symbol: '---', name: 'Return Duct', description: 'Return air ductwork' },
    { symbol: '···', name: 'Exhaust Duct', description: 'Exhaust air ductwork' },
    { symbol: '░░░', name: 'Flexible Duct', description: 'Flex duct connection' },
  ],
  controls: [
    { symbol: 'T', name: 'Thermostat', description: 'Temperature control' },
    { symbol: 'TS', name: 'Temperature Sensor', description: 'Space sensor' },
    { symbol: 'HS', name: 'Humidity Sensor', description: 'Humidity control' },
    { symbol: 'CO2', name: 'CO2 Sensor', description: 'Carbon dioxide sensor' },
    { symbol: 'SM', name: 'Smoke Detector', description: 'Duct smoke detector' },
  ],
  exhaust: [
    { symbol: 'EF', name: 'Exhaust Fan', description: 'Exhaust fan' },
    { symbol: 'BF', name: 'Bathroom Fan', description: 'Bath exhaust fan' },
    { symbol: 'KE', name: 'Kitchen Exhaust', description: 'Range hood/kitchen exhaust' },
    { symbol: 'ERV', name: 'Energy Recovery', description: 'Energy recovery ventilator' },
    { symbol: 'HRV', name: 'Heat Recovery', description: 'Heat recovery ventilator' },
  ],
};

export const IMC_CODES: CodeReference[] = [
  // Duct Sizing
  {
    code: 'IMC',
    section: '603.4',
    description: 'Duct sizing based on friction loss and velocity limits',
    trade: 'hvac',
    edition: '2024',
  },
  {
    code: 'IMC',
    section: '603.9',
    description: 'Maximum duct air velocity: 2000 FPM for supply, 1500 FPM for return',
    trade: 'hvac',
    edition: '2024',
  },
  
  // Ventilation Requirements
  {
    code: 'IMC',
    section: '403.3',
    description: 'Outdoor air requirements - minimum CFM per person and per square foot',
    trade: 'hvac',
    edition: '2024',
  },
  {
    code: 'IMC',
    section: 'Table 403.3.1.1',
    description: 'Minimum ventilation rates for occupied spaces',
    trade: 'hvac',
    edition: '2024',
  },
  
  // Exhaust Requirements
  {
    code: 'IMC',
    section: 'Table 403.3.2',
    description: 'Minimum exhaust rates: Bathrooms 50 CFM, Kitchens 100 CFM',
    trade: 'hvac',
    edition: '2024',
  },
  {
    code: 'IMC',
    section: '501.2',
    description: 'Exhaust discharge location - 3 ft from openings, 10 ft from air intakes',
    trade: 'hvac',
    edition: '2024',
  },
  
  // Equipment Access
  {
    code: 'IMC',
    section: '306.3',
    description: 'Equipment access and working space requirements',
    trade: 'hvac',
    edition: '2024',
  },
  
  // Duct Insulation
  {
    code: 'IECC',
    section: 'C403.3.2',
    description: 'Duct insulation requirements based on location',
    trade: 'hvac',
    edition: '2024',
  },
  
  // Air Distribution
  {
    code: 'IMC',
    section: '601.2',
    description: 'Return air pathway requirements',
    trade: 'hvac',
    edition: '2024',
  },
  
  // Refrigerant Lines
  {
    code: 'IMC',
    section: '1105.1',
    description: 'Refrigerant pipe sizing and installation',
    trade: 'hvac',
    edition: '2024',
  },
  
  // Combustion Air
  {
    code: 'IMC',
    section: '701.1',
    description: 'Combustion air requirements for fuel-burning appliances',
    trade: 'hvac',
    edition: '2024',
  },
  
  // Duct Construction
  {
    code: 'IMC',
    section: '603.3',
    description: 'Duct construction and materials - galvanized steel gauges',
    trade: 'hvac',
    edition: '2024',
  },
];

export const HVAC_VISION_PROMPT = `You are an expert HVAC estimator analyzing construction blueprints.

## Symbols to Identify
${Object.entries(HVAC_SYMBOLS)
  .map(([category, symbols]) => 
    `### ${category.charAt(0).toUpperCase() + category.slice(1)}\n${symbols.map(s => `- ${s.symbol}: ${s.name} - ${s.description}`).join('\n')}`
  ).join('\n\n')}

## Analysis Instructions
1. Identify all HVAC components and diffusers
2. Note locations as percentages (0-100 for x and y)
3. Identify duct routing and sizes if visible
4. Count diffusers by type (supply, return, exhaust)
5. Note CFM ratings if specified
6. Identify equipment locations (AHU, RTU, etc.)
7. Find thermostat and sensor locations
8. Note any zoning boundaries

## Common HVAC Elements
- Supply air diffusers (ceiling, wall, floor)
- Return air grilles
- Exhaust grilles and fans
- Thermostats and controls
- Air handling equipment
- Ductwork (supply, return, exhaust)
- VAV boxes and terminal units
- Kitchen and bathroom exhaust
- Roof-mounted equipment

## Output Format
Return a JSON object with detected HVAC components, ductwork, and controls.`;

export const HVAC_ESTIMATION_PROMPT = `You are an expert HVAC estimator creating a material takeoff.

## Code References
Apply the following IMC/IECC requirements:
${IMC_CODES.slice(0, 8).map(c => `- ${c.section}: ${c.description}`).join('\n')}

## CFM Guidelines (Residential)
- Living Room: 1 CFM per sq ft
- Bedroom: 1 CFM per sq ft minimum, 15 CFM per person
- Bathroom: 50 CFM exhaust minimum
- Kitchen: 100 CFM exhaust minimum
- Laundry: 50 CFM exhaust

## Material Categories
1. **Diffusers & Grilles** - Supply, return, and exhaust
2. **Ductwork** - Sheet metal with sizes and gauges
3. **Fittings** - Elbows, tees, reducers, transitions
4. **Flex Duct** - Insulated flex for final connections
5. **Equipment** - AHU, RTU, fan coils, thermostats
6. **Insulation** - Duct wrap and board
7. **Supports** - Hangers, straps, seismic bracing
8. **Controls** - Thermostats, sensors, damper actuators
9. **Exhaust Fans** - Bath, kitchen, utility exhaust

## Calculation Guidelines
- Size ductwork based on CFM and velocity limits
- Include transitions between duct sizes
- Account for duct insulation where required
- Include balancing dampers
- Add test/access holes for balancing`;

export function getHvacCodeReference(section: string): CodeReference | undefined {
  return IMC_CODES.find(c => c.section === section);
}

export function getHvacCodesForContext(context: string): CodeReference[] {
  const lowerContext = context.toLowerCase();
  
  return IMC_CODES.filter(code => {
    if (lowerContext.includes('duct') || lowerContext.includes('size')) {
      return code.section.includes('603');
    }
    if (lowerContext.includes('ventilation') || lowerContext.includes('outdoor air')) {
      return code.section.includes('403');
    }
    if (lowerContext.includes('exhaust')) {
      return code.section.includes('403.3.2') || code.section.includes('501');
    }
    if (lowerContext.includes('insulation')) {
      return code.section.includes('C403');
    }
    if (lowerContext.includes('refrigerant')) {
      return code.section.includes('1105');
    }
    if (lowerContext.includes('combustion')) {
      return code.section.includes('701');
    }
    
    return false;
  });
}
