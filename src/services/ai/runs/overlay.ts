/**
 * Smart run overlay: suggested runs are polyline markups carrying `aiRun` data. When the user
 * drags a point, the run's length, voltage drop, conductor/EGC and raceway sizes are recomputed
 * from the new geometry.
 */
import type { AiRunMeta, CanvasMarkup, PolygonMarkup } from '@/types/markup';
import { formatSize, type RacewayType } from './necTables';
import { describeConductors, formatTradeSize, sizeCircuit, sizeConduit, type CircuitSizing } from './sizing';

export function isRunMarkup(markup: CanvasMarkup | undefined | null): markup is PolygonMarkup & { aiRun: AiRunMeta } {
  return !!markup && (markup.type === 'polyline' || markup.type === 'polygon') && !!(markup as PolygonMarkup).aiRun;
}

export function polylineLength(points: Array<{ x: number; y: number }>): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i += 1) total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  return total;
}

export type RunRecompute = {
  label: string;
  aiNote: string;
  aiRun: AiRunMeta;
};

/** Recompute a run after its geometry changed. Returns null for non-run markups. */
export function recomputeRunMarkup(markup: CanvasMarkup): RunRecompute | null {
  if (!isRunMarkup(markup)) return null;
  const meta = markup.aiRun;
  const lengthFt = Math.round(polylineLength(markup.points) * meta.ftPerPt * 10) / 10;
  if (meta.kind !== 'homerun' || !meta.circuits?.length || !meta.settings) {
    const label = meta.kind === 'keepout' ? markup.label || 'Keep clear' : `Branch ≈${Math.round(lengthFt)} ft`;
    return {
      label,
      aiNote: markup.aiNote || label,
      aiRun: { ...meta, lengthFt, summary: label },
    };
  }
  const settings = meta.settings;
  const isCable = settings.wiringMethod === 'MC';
  const ccc = meta.circuits.reduce((sum, c) => sum + (c.phase === 3 ? 3 : 2), 0);
  const sizing: CircuitSizing[] = meta.circuits.map(circuit => sizeCircuit(
    circuit,
    lengthFt + circuit.branchFt + settings.verticalFt,
    isCable ? (circuit.phase === 3 ? 3 : 2) : ccc,
    { material: settings.material, vdTargetPct: settings.vdTargetPct, necEdition: settings.necEdition },
  ));
  const vdPct = Math.max(...sizing.map(s => s.vdPct));
  let text: string;
  if (isCable) {
    text = sizing.map(s => `MC ${formatSize(s.conductor).replace('#', '')}/${s.ccc}+G`).join(' · ');
  } else {
    const raceway = settings.wiringMethod as RacewayType;
    const rows = new Map<string, { size: CircuitSizing['conductor']; count: number; role: 'phase' | 'neutral' | 'egc' }>();
    meta.circuits.forEach((circuit, i) => {
      const key = `phase:${sizing[i].conductor}`;
      const row = rows.get(key) || { size: sizing[i].conductor, count: 0, role: 'phase' as const };
      row.count += circuit.phase === 3 ? 3 : 2;
      rows.set(key, row);
    });
    const egc = sizing.map(s => s.egc).sort((a, b) => order(b) - order(a))[0];
    rows.set(`egc:${egc}`, { size: egc, count: 1, role: 'egc' });
    const conductors = [...rows.values()];
    const conduit = sizeConduit(conductors, raceway);
    text = `${formatTradeSize(conduit.tradeSize, raceway)} – ${describeConductors(conductors)}`;
  }
  const prefix = (markup.label || '').match(/^(HR\d+):/)?.[1] || meta.runId;
  const summary = `${prefix}: ${text}`;
  const aiNote = [
    summary,
    `≈${Math.round(lengthFt)} ft home run · VD ${vdPct.toFixed(1)}% (target ≤ ${settings.vdTargetPct}%)`,
    ...sizing.flatMap(s => s.notes),
  ].join('\n');
  return { label: summary, aiNote, aiRun: { ...meta, lengthFt, vdPct, summary } };
}

function order(size: string): number {
  return ['14', '12', '10', '8', '6', '4', '3', '2', '1', '1/0', '2/0', '3/0', '4/0', '250', '300', '350', '400', '500', '600', '750'].indexOf(size);
}
