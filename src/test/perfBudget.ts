/**
 * Wall-clock budgets for perf assertions. Targets are the real goals; shared CI
 * runners and loaded dev boxes get headroom so timing noise never blocks a release.
 * Set PERF_STRICT=1 to enforce the raw target (e.g. when benchmarking locally).
 */
export function perfBudget(targetMs: number): number {
  if (process.env.PERF_STRICT === '1') return targetMs;
  const mult = Number(process.env.PERF_BUDGET_MULT || (process.env.CI ? 3 : 2));
  return targetMs * (Number.isFinite(mult) && mult > 0 ? mult : 2);
}
