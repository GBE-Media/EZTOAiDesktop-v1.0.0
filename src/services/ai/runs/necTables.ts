/**
 * NEC reference data used by run sizing. Values are from NFPA 70 (2017–2026 editions;
 * these tables did not change between those editions):
 *  - Table 310.16 (2017: 310.15(B)(16)) allowable ampacities, ≤3 CCC, 30 °C ambient
 *  - Chapter 9 Table 8 conductor circular-mil areas
 *  - Chapter 9 Table 5 THHN/THWN-2 conductor areas
 *  - Chapter 9 Table 4 raceway internal areas
 *  - Table 250.122 equipment grounding conductor sizes
 *  - 240.4(D) small-conductor overcurrent limits, 240.6(A) standard ratings
 *  - Table 310.15(C)(1) (2017: 310.15(B)(3)(a)) more-than-3-CCC adjustment factors
 */

export type ConductorSize =
  | '14' | '12' | '10' | '8' | '6' | '4' | '3' | '2' | '1'
  | '1/0' | '2/0' | '3/0' | '4/0'
  | '250' | '300' | '350' | '400' | '500' | '600' | '750';

export const CONDUCTOR_SIZES: ConductorSize[] = [
  '14', '12', '10', '8', '6', '4', '3', '2', '1',
  '1/0', '2/0', '3/0', '4/0', '250', '300', '350', '400', '500', '600', '750',
];

export type Material = 'cu' | 'al';

/** Table 310.16, 75 °C column. Aluminum starts at 12 AWG. */
export const AMPACITY_75: Record<Material, Partial<Record<ConductorSize, number>>> = {
  cu: {
    '14': 20, '12': 25, '10': 35, '8': 50, '6': 65, '4': 85, '3': 100, '2': 115, '1': 130,
    '1/0': 150, '2/0': 175, '3/0': 200, '4/0': 230, '250': 255, '300': 285, '350': 310,
    '400': 335, '500': 380, '600': 420, '750': 475,
  },
  al: {
    '12': 20, '10': 30, '8': 40, '6': 50, '4': 65, '3': 75, '2': 90, '1': 100,
    '1/0': 120, '2/0': 135, '3/0': 155, '4/0': 180, '250': 205, '300': 230, '350': 250,
    '400': 270, '500': 310, '600': 340, '750': 385,
  },
};

/** Table 310.16, 90 °C column (used as the base for adjustment, 310.15(B)/(C)). */
export const AMPACITY_90: Record<Material, Partial<Record<ConductorSize, number>>> = {
  cu: {
    '14': 25, '12': 30, '10': 40, '8': 55, '6': 75, '4': 95, '3': 115, '2': 130, '1': 145,
    '1/0': 170, '2/0': 195, '3/0': 225, '4/0': 260, '250': 290, '300': 320, '350': 350,
    '400': 380, '500': 430, '600': 475, '750': 535,
  },
  al: {
    '12': 25, '10': 35, '8': 45, '6': 55, '4': 75, '3': 85, '2': 100, '1': 115,
    '1/0': 135, '2/0': 150, '3/0': 175, '4/0': 205, '250': 230, '300': 260, '350': 280,
    '400': 305, '500': 350, '600': 385, '750': 435,
  },
};

/** 240.4(D) maximum OCPD for small conductors. */
export const SMALL_CONDUCTOR_OCPD: Record<Material, Partial<Record<ConductorSize, number>>> = {
  cu: { '14': 15, '12': 20, '10': 30 },
  al: { '12': 15, '10': 25 },
};

/** Chapter 9 Table 8 — circular mils. */
export const CIRCULAR_MILS: Record<ConductorSize, number> = {
  '14': 4110, '12': 6530, '10': 10380, '8': 16510, '6': 26240, '4': 41740, '3': 52620,
  '2': 66360, '1': 83690, '1/0': 105600, '2/0': 133100, '3/0': 167800, '4/0': 211600,
  '250': 250000, '300': 300000, '350': 350000, '400': 400000, '500': 500000,
  '600': 600000, '750': 750000,
};

/** Chapter 9 Table 5 — THHN/THWN-2 approximate area, in². */
export const THHN_AREA: Record<ConductorSize, number> = {
  '14': 0.0097, '12': 0.0133, '10': 0.0211, '8': 0.0366, '6': 0.0507, '4': 0.0824,
  '3': 0.0973, '2': 0.1158, '1': 0.1562, '1/0': 0.1855, '2/0': 0.2223, '3/0': 0.2679,
  '4/0': 0.3237, '250': 0.3970, '300': 0.4608, '350': 0.5242, '400': 0.5863,
  '500': 0.7073, '600': 0.8676, '750': 1.0496,
};

export type RacewayType = 'EMT' | 'PVC40' | 'RMC';

export const RACEWAY_TRADE_SIZES = ['1/2', '3/4', '1', '1-1/4', '1-1/2', '2', '2-1/2', '3', '3-1/2', '4'] as const;
export type TradeSize = typeof RACEWAY_TRADE_SIZES[number];

/** Chapter 9 Table 4 — total internal area (100 %), in². */
export const RACEWAY_AREA: Record<RacewayType, Record<TradeSize, number>> = {
  EMT: {
    '1/2': 0.304, '3/4': 0.533, '1': 0.864, '1-1/4': 1.496, '1-1/2': 2.036, '2': 3.356,
    '2-1/2': 5.858, '3': 8.846, '3-1/2': 11.545, '4': 14.753,
  },
  PVC40: {
    '1/2': 0.285, '3/4': 0.508, '1': 0.832, '1-1/4': 1.453, '1-1/2': 1.986, '2': 3.291,
    '2-1/2': 4.695, '3': 7.268, '3-1/2': 9.737, '4': 12.554,
  },
  RMC: {
    '1/2': 0.314, '3/4': 0.549, '1': 0.887, '1-1/4': 1.526, '1-1/2': 2.071, '2': 3.408,
    '2-1/2': 4.866, '3': 7.499, '3-1/2': 10.010, '4': 12.882,
  },
};

/** Table 250.122 — copper EGC by OCPD rating (A). */
export const EGC_CU: Array<[number, ConductorSize]> = [
  [15, '14'], [20, '12'], [60, '10'], [100, '8'], [200, '6'], [300, '4'], [400, '3'],
  [500, '2'], [600, '1'], [800, '1/0'], [1000, '2/0'], [1200, '3/0'], [1600, '4/0'], [2000, '250'],
];
export const EGC_AL: Array<[number, ConductorSize]> = [
  [15, '12'], [20, '10'], [60, '8'], [100, '6'], [200, '4'], [300, '2'], [400, '1'],
  [500, '1/0'], [600, '2/0'], [800, '3/0'], [1000, '4/0'], [1200, '250'], [1600, '350'], [2000, '400'],
];

/** 240.6(A) standard ampere ratings. */
export const STANDARD_OCPD = [
  15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 225, 250,
  300, 350, 400, 450, 500, 600, 700, 800, 1000, 1200, 1600, 2000,
];

/** Table 310.15(C)(1) adjustment for more than three current-carrying conductors. */
export function cccAdjustment(currentCarrying: number): number {
  if (currentCarrying <= 3) return 1;
  if (currentCarrying <= 6) return 0.8;
  if (currentCarrying <= 9) return 0.7;
  if (currentCarrying <= 20) return 0.5;
  if (currentCarrying <= 30) return 0.45;
  if (currentCarrying <= 40) return 0.4;
  return 0.35;
}

/** Approximate resistivity constant K (Ω·cmil/ft) at 75 °C. */
export const K_FACTOR: Record<Material, number> = { cu: 12.9, al: 21.2 };

export function sizeIndex(size: ConductorSize): number {
  return CONDUCTOR_SIZES.indexOf(size);
}

export function formatSize(size: ConductorSize): string {
  return /^\d+$/.test(size) && Number(size) >= 250 ? `${size} kcmil` : `#${size}`;
}

/** Article references differ slightly by edition. */
export function codeRef(edition: number, key: 'ampacity' | 'adjust' | 'vdBranch' | 'vdFeeder' | 'fill' | 'egc' | 'egcUpsize' | 'bends' | 'small'): string {
  const old = edition <= 2017;
  switch (key) {
    case 'ampacity': return old ? 'Table 310.15(B)(16)' : 'Table 310.16';
    case 'adjust': return old ? '310.15(B)(3)(a)' : '310.15(C)(1)';
    case 'vdBranch': return '210.19(A) Informational Note';
    case 'vdFeeder': return '215.2(A) Informational Note';
    case 'fill': return 'Chapter 9, Table 1';
    case 'egc': return 'Table 250.122';
    case 'egcUpsize': return '250.122(B)';
    case 'bends': return '358.26';
    case 'small': return '240.4(D)';
    default: return '';
  }
}
