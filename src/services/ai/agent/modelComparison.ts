/**
 * Vision model A/B comparison: the same page counted several times by each model, scored on
 * what matters for takeoff — run-to-run consistency, how close the model's own points land on
 * the drawn symbols, how much clean-up the symbol check had to do, and speed.
 */
import type { SymbolCheckStats } from '../providers/types';

export const COMPARISON_CANDIDATE_MODEL = 'google/gemini-4-argon';

export interface ComparisonRun {
  typeCounts?: Record<string, number>;
  symbolCheck?: SymbolCheckStats;
  seconds: number;
  answeredBy?: string[];
  error?: string;
}

export interface ModelScore {
  model: string;
  answeredBy: string[];
  runsCompleted: number;
  runsFailed: number;
  errors: string[];
  /** Total plan count per run (after the symbol check). */
  totals: number[];
  /** Per type: count in each completed run. */
  perType: Record<string, number[]>;
  /** Sum over types of (max − min) ÷ sum of means, in %. 0 = identical every run. */
  variationPct: number | null;
  /** Worst single type (with ≥3 on the page). */
  worstType: { type: string; counts: number[]; variationPct: number } | null;
  /** % of the model's points that landed on their drawn symbol (within 9 pt) before snapping. */
  onSymbolPct: number | null;
  medianOffsetPt: number | null;
  /** Duplicates removed + missed symbols added, per run, as % of the count. */
  cleanupPct: number | null;
  avgSeconds: number | null;
}

export interface ComparisonVerdict {
  current: ModelScore;
  candidate: ModelScore;
  /** Which model to use for counting on these drawings. */
  recommended: string;
  switchRecommended: boolean;
  reasons: string[];
  /** Types where the two models' typical counts differ — check these on the drawing. */
  disagreements: Array<{ type: string; current: number; candidate: number }>;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const median = (list: number[]) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export function scoreModel(model: string, runs: ComparisonRun[]): ModelScore {
  const ok = runs.filter(run => !run.error && run.typeCounts);
  const types = [...new Set(ok.flatMap(run => Object.keys(run.typeCounts || {})))].sort();
  const perType: Record<string, number[]> = {};
  for (const type of types) perType[type] = ok.map(run => run.typeCounts?.[type] ?? 0);
  const totals = ok.map(run => Object.values(run.typeCounts || {}).reduce((a, b) => a + b, 0));

  let spread = 0;
  let mass = 0;
  let worstType: ModelScore['worstType'] = null;
  if (ok.length >= 2) {
    for (const [type, counts] of Object.entries(perType)) {
      const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
      const range = Math.max(...counts) - Math.min(...counts);
      spread += range;
      mass += mean;
      if (mean >= 3) {
        const pct = (range / mean) * 100;
        if (!worstType || pct > worstType.variationPct) worstType = { type, counts, variationPct: round1(pct) };
      }
    }
  }
  const checks = ok.map(run => run.symbolCheck).filter((c): c is SymbolCheckStats => !!c && c.checked > 0);
  const checked = checks.reduce((a, c) => a + c.checked, 0);
  const onSymbol = checks.reduce((a, c) => a + c.onSymbol, 0);
  const cleanup = checks.reduce((a, c) => a + c.duplicates + c.added, 0);
  return {
    model,
    answeredBy: [...new Set(ok.flatMap(run => run.answeredBy || []))],
    runsCompleted: ok.length,
    runsFailed: runs.length - ok.length,
    errors: [...new Set(runs.map(run => run.error).filter((e): e is string => !!e))],
    totals,
    perType,
    variationPct: ok.length >= 2 ? (mass > 0 ? round1((spread / mass) * 100) : 0) : null,
    worstType,
    onSymbolPct: checked ? round1((onSymbol / checked) * 100) : null,
    medianOffsetPt: checks.length ? round1(median(checks.map(c => c.medianOffsetPt))) : null,
    cleanupPct: checked ? round1((cleanup / checked) * 100) : null,
    avgSeconds: ok.length ? round1(ok.reduce((a, run) => a + run.seconds, 0) / ok.length) : null,
  };
}

/**
 * Consistency comes first (the 1–2% target), then placement, then clean-up. A switch needs a
 * clear win on one without losing on consistency — otherwise keep the current model.
 */
export function compareModels(current: ModelScore, candidate: ModelScore): ComparisonVerdict {
  const reasons: string[] = [];
  const disagreements: ComparisonVerdict['disagreements'] = [];
  const typical = (score: ModelScore, type: string) => median(score.perType[type] || [0]);
  for (const type of [...new Set([...Object.keys(current.perType), ...Object.keys(candidate.perType)])].sort()) {
    const a = typical(current, type);
    const b = typical(candidate, type);
    if (Math.abs(a - b) > Math.max(1, 0.02 * Math.max(a, b))) disagreements.push({ type, current: a, candidate: b });
  }

  const verdict = (switchRecommended: boolean): ComparisonVerdict => ({
    current, candidate, recommended: switchRecommended ? candidate.model : current.model, switchRecommended, reasons, disagreements,
  });
  if (!candidate.runsCompleted) {
    reasons.push(`${candidate.model} didn't complete a count${candidate.errors[0] ? ` (${candidate.errors[0]})` : ''}.`);
    return verdict(false);
  }
  if (!current.runsCompleted) {
    reasons.push(`${current.model} didn't complete a count${current.errors[0] ? ` (${current.errors[0]})` : ''}.`);
    return verdict(true);
  }

  let wins = 0;
  let losses = 0;
  const cv = current.variationPct;
  const kv = candidate.variationPct;
  if (cv != null && kv != null) {
    if (kv + 1 <= cv) { wins += 2; reasons.push(`More consistent: counts varied ${kv}% run to run vs ${cv}%.`); }
    else if (kv >= cv + 1) { losses += 2; reasons.push(`Less consistent: counts varied ${kv}% run to run vs ${cv}%.`); }
    else reasons.push(`Same consistency (${kv}% vs ${cv}% run-to-run variation).`);
  }
  const cp = current.onSymbolPct;
  const kp = candidate.onSymbolPct;
  if (cp != null && kp != null) {
    if (kp >= cp + 5) { wins += 1; reasons.push(`Places markers more precisely: ${kp}% landed on the drawn symbol vs ${cp}%.`); }
    else if (kp + 5 <= cp) { losses += 1; reasons.push(`Places markers less precisely: ${kp}% landed on the drawn symbol vs ${cp}%.`); }
    else reasons.push(`Similar placement (${kp}% vs ${cp}% of markers on the drawn symbol).`);
  }
  const cc = current.cleanupPct;
  const kc = candidate.cleanupPct;
  if (cc != null && kc != null) {
    if (kc + 3 <= cc) { wins += 1; reasons.push(`Fewer duplicates/misses to fix: ${kc}% vs ${cc}% of the count.`); }
    else if (kc >= cc + 3) { losses += 1; reasons.push(`More duplicates/misses to fix: ${kc}% vs ${cc}% of the count.`); }
  }
  if (candidate.runsFailed > current.runsFailed) { losses += 1; reasons.push(`${candidate.runsFailed} of its runs failed.`); }
  if (current.avgSeconds != null && candidate.avgSeconds != null) {
    reasons.push(`Speed: ${candidate.avgSeconds}s vs ${current.avgSeconds}s per page.`);
  }
  // Never trade consistency for anything else.
  const lostConsistency = cv != null && kv != null && kv >= cv + 1;
  return verdict(wins > losses && !lostConsistency);
}

/** Plain-language lines for the assistant's reply. */
export function describeComparison(v: ComparisonVerdict, page: number): string[] {
  const line = (s: ModelScore) => {
    const parts = [
      `${s.model}: ${s.runsCompleted} run(s), totals ${s.totals.join(' / ') || '—'}`,
      s.variationPct != null ? `variation ${s.variationPct}%` : null,
      s.onSymbolPct != null ? `${s.onSymbolPct}% on symbol (median ${s.medianOffsetPt} pt off)` : null,
      s.cleanupPct != null ? `clean-up ${s.cleanupPct}%` : null,
      s.avgSeconds != null ? `${s.avgSeconds}s/run` : null,
      s.runsFailed ? `${s.runsFailed} failed` : null,
    ].filter(Boolean);
    return parts.join(', ');
  };
  return [
    `Page ${page} counted ${v.current.runsCompleted + v.current.runsFailed}× per model, same symbol check for both.`,
    line(v.current),
    line(v.candidate),
    ...v.reasons,
    v.disagreements.length
      ? `Counts differ on: ${v.disagreements.map(d => `${d.type} (${d.current} vs ${d.candidate})`).join(', ')} — check these on the drawing.`
      : 'Both models agree on every type.',
    v.switchRecommended ? `Recommendation: switch counting to ${v.candidate.model}.` : `Recommendation: keep ${v.current.model}.`,
  ];
}
