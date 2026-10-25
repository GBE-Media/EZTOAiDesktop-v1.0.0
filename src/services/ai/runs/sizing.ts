import {
  AMPACITY_75,
  AMPACITY_90,
  CIRCULAR_MILS,
  CONDUCTOR_SIZES,
  EGC_AL,
  EGC_CU,
  K_FACTOR,
  RACEWAY_AREA,
  RACEWAY_TRADE_SIZES,
  SMALL_CONDUCTOR_OCPD,
  STANDARD_OCPD,
  THHN_AREA,
  cccAdjustment,
  codeRef,
  formatSize,
  sizeIndex,
  type ConductorSize,
  type Material,
  type RacewayType,
  type TradeSize,
} from './necTables';

export type CircuitInput = {
  id: string;
  label?: string;
  /** Load in amps, or VA (converted with voltage/phase). */
  loadAmps?: number;
  loadVA?: number;
  voltage: number;
  phase: 1 | 3;
  /** Continuous loads (lighting) are sized at 125 % (210.19(A)(1), 210.20(A)). */
  continuous?: boolean;
  /** Breaker rating if known (from the panel schedule). */
  ocpdAmps?: number;
};

export type SizingSettings = {
  material: Material;
  /** Max voltage drop % for this run (default 3 % branch). */
  vdTargetPct: number;
  /** NEC edition for article references. */
  necEdition: number;
  /**
   * Largest conductor voltage-drop upsizing may reach. Lighting / receptacle branch circuits stop at
   * #6 — past that the circuit should be split (or the scale is wrong), not fed with feeder cable.
   */
  maxConductor?: ConductorSize;
};

/** Upsizing cap for small branch circuits (≤ 30 A). */
export function branchUpsizeCap(ocpdAmps: number | undefined): ConductorSize | undefined {
  return !ocpdAmps || ocpdAmps <= 30 ? '6' : undefined;
}

export type CircuitSizing = {
  circuitId: string;
  label: string;
  loadAmps: number;
  ocpdAmps: number;
  conductor: ConductorSize;
  /** Size required by ampacity alone (before voltage-drop upsizing). */
  ampacityConductor: ConductorSize;
  egc: ConductorSize;
  vdPct: number;
  /** Current-carrying conductors this circuit contributes. */
  ccc: number;
  notes: string[];
};

export type ConduitSizing = {
  tradeSize: TradeSize;
  raceway: RacewayType;
  fillPct: number;
  wireAreaIn2: number;
  conductors: Array<{ size: ConductorSize; count: number; role: 'phase' | 'neutral' | 'egc' }>;
  notes: string[];
};

export function nextStandardOcpd(amps: number): number {
  return STANDARD_OCPD.find(rating => rating >= amps - 1e-9) ?? STANDARD_OCPD[STANDARD_OCPD.length - 1];
}

export function circuitAmps(input: CircuitInput): number {
  if (input.loadAmps && input.loadAmps > 0) return input.loadAmps;
  const va = input.loadVA || 0;
  if (va <= 0) return 0;
  return input.phase === 3 ? va / (Math.sqrt(3) * input.voltage) : va / input.voltage;
}

/** Voltage drop percent for a one-way length (ft). */
export function voltageDropPct(options: {
  amps: number; lengthFt: number; size: ConductorSize; material: Material; voltage: number; phase: 1 | 3;
}): number {
  const k = K_FACTOR[options.material];
  const factor = options.phase === 3 ? Math.sqrt(3) : 2;
  const vd = (factor * k * options.amps * options.lengthFt) / CIRCULAR_MILS[options.size];
  return (vd / options.voltage) * 100;
}

function ampacityAt(size: ConductorSize, material: Material, adjustment: number): number {
  const a75 = AMPACITY_75[material][size];
  const a90 = AMPACITY_90[material][size];
  if (!a75 || !a90) return 0;
  // THHN/THWN-2 (90 °C) may be derated from the 90 °C column, but the result may not exceed
  // the 75 °C termination rating (110.14(C)).
  return Math.min(a75, a90 * adjustment);
}

function egcFor(ocpd: number, material: Material): ConductorSize {
  const table = material === 'cu' ? EGC_CU : EGC_AL;
  return (table.find(([rating]) => rating >= ocpd) || table[table.length - 1])[1];
}

/** Size one circuit: OCPD, conductor (ampacity + voltage drop), EGC (with 250.122(B) upsizing). */
export function sizeCircuit(
  input: CircuitInput,
  lengthFt: number,
  cccInRaceway: number,
  settings: SizingSettings,
): CircuitSizing {
  const notes: string[] = [];
  const material = settings.material;
  const amps = circuitAmps(input);
  const design = input.continuous ? amps * 1.25 : amps;
  const ocpd = input.ocpdAmps && input.ocpdAmps > 0 ? input.ocpdAmps : Math.max(20, nextStandardOcpd(design));
  const adjustment = cccAdjustment(cccInRaceway);
  if (adjustment < 1) notes.push(`${Math.round(adjustment * 100)}% adjustment for ${cccInRaceway} current-carrying conductors (${codeRef(settings.necEdition, 'adjust')})`);

  // #12 minimum for commercial branch circuits (typical spec minimum; #14 is rarely allowed).
  const minIndex = sizeIndex('12');
  let ampacitySize: ConductorSize | null = null;
  for (let i = minIndex; i < CONDUCTOR_SIZES.length; i += 1) {
    const size = CONDUCTOR_SIZES[i];
    const ampacity = ampacityAt(size, material, adjustment);
    const smallLimit = SMALL_CONDUCTOR_OCPD[material][size];
    // Conductor must carry the design load, and be protected by the OCPD (240.4(B) next size up
    // allowed ≤ 800 A, 240.4(D) small-conductor limits).
    if (ampacity < design) continue;
    if (smallLimit !== undefined && ocpd > smallLimit) continue;
    if (smallLimit === undefined && nextStandardOcpd(ampacity) < ocpd) continue;
    ampacitySize = size;
    break;
  }
  if (!ampacitySize) {
    ampacitySize = CONDUCTOR_SIZES[CONDUCTOR_SIZES.length - 1];
    notes.push('Load exceeds single-conductor table range — use parallel sets (310.10(G)).');
  }

  let size = ampacitySize;
  let vd = voltageDropPct({ amps, lengthFt, size, material, voltage: input.voltage, phase: input.phase });
  const cap = settings.maxConductor ?? branchUpsizeCap(ocpd);
  const maxIndex = cap ? Math.max(sizeIndex(cap), sizeIndex(ampacitySize)) : CONDUCTOR_SIZES.length - 1;
  while (vd > settings.vdTargetPct && sizeIndex(size) < maxIndex) {
    size = CONDUCTOR_SIZES[sizeIndex(size) + 1];
    vd = voltageDropPct({ amps, lengthFt, size, material, voltage: input.voltage, phase: input.phase });
  }
  if (vd > settings.vdTargetPct && cap && sizeIndex(size) >= maxIndex) {
    notes.push(`Voltage drop still ${vd.toFixed(1)}% at ${formatSize(size)} — split this circuit or check the drawing scale.`);
  }
  if (size !== ampacitySize) {
    notes.push(`Upsized ${formatSize(ampacitySize)} → ${formatSize(size)} to hold voltage drop ≤ ${settings.vdTargetPct}% (${codeRef(settings.necEdition, 'vdBranch')})`);
  }

  let egc = egcFor(ocpd, material);
  if (size !== ampacitySize) {
    // 250.122(B): increase the EGC in proportion to the ungrounded conductors' circular mils.
    const ratio = CIRCULAR_MILS[size] / CIRCULAR_MILS[ampacitySize];
    const needed = CIRCULAR_MILS[egc] * ratio;
    const upsized = CONDUCTOR_SIZES.find(s => CIRCULAR_MILS[s] >= needed - 1) || size;
    const capped = sizeIndex(upsized) > sizeIndex(size) ? size : upsized;
    if (capped !== egc) {
      notes.push(`EGC increased to ${formatSize(capped)} in proportion (${codeRef(settings.necEdition, 'egcUpsize')})`);
      egc = capped;
    }
  }

  return {
    circuitId: input.id,
    label: input.label || input.id,
    loadAmps: round2(amps),
    ocpdAmps: ocpd,
    conductor: size,
    ampacityConductor: ampacitySize,
    egc,
    vdPct: round2(vd),
    ccc: input.phase === 3 ? 3 : 2,
    notes,
  };
}

/** Smallest trade size within Chapter 9 Table 1 fill (53 % / 31 % / 40 %). */
export function sizeConduit(
  conductors: Array<{ size: ConductorSize; count: number; role: 'phase' | 'neutral' | 'egc' }>,
  raceway: RacewayType,
): ConduitSizing {
  const total = conductors.reduce((sum, row) => sum + row.count, 0);
  const area = conductors.reduce((sum, row) => sum + THHN_AREA[row.size] * row.count, 0);
  const maxFill = total === 1 ? 0.53 : total === 2 ? 0.31 : 0.4;
  const notes: string[] = [];
  let trade: TradeSize = RACEWAY_TRADE_SIZES[RACEWAY_TRADE_SIZES.length - 1];
  for (const size of RACEWAY_TRADE_SIZES) {
    if (raceway === 'EMT' || raceway === 'RMC' || raceway === 'PVC40') {
      if (RACEWAY_AREA[raceway][size] * maxFill >= area) { trade = size; break; }
    }
  }
  // 3/4" minimum is common in specs; 1/2" is code-minimum (358.20(A)).
  const fill = area / RACEWAY_AREA[raceway][trade];
  if (fill > maxFill) notes.push('Exceeds a single 4" raceway — split into parallel raceways.');
  return {
    tradeSize: trade,
    raceway,
    fillPct: round2(fill * 100),
    wireAreaIn2: Math.round(area * 10000) / 10000,
    conductors,
    notes,
  };
}

export function describeConductors(rows: ConduitSizing['conductors']): string {
  return rows
    .filter(row => row.count > 0)
    .map(row => `${row.count}${formatSize(row.size)}${row.role === 'egc' ? 'G' : ''}`)
    .join(', ');
}

export function formatTradeSize(trade: TradeSize, raceway: RacewayType): string {
  return `${trade}" ${raceway === 'PVC40' ? 'PVC' : raceway}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
