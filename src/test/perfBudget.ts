/**
 * Wall-clock budgets for perf assertions. The numbers passed in are the real targets
 * (met when a test runs alone). Full parallel suites and shared CI runners add heavy CPU
 * contention, so the default budget leaves headroom; it still catches algorithmic
 * regressions (O(n^2) rewrites, unindexed scans), which are 10-100x slower, not 2x.
 * Set PERF_STRICT=1 to enforce the raw target when benchmarking a single file.
 */
export function perfBudget(targetMs: number): number {
  if (process.env.PERF_STRICT === '1') return targetMs;
  const mult = Number(process.env.PERF_BUDGET_MULT || (process.env.CI ? 8 : 5));
  return targetMs * (Number.isFinite(mult) && mult > 0 ? mult : 5);
}
