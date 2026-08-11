/**
 * Poisson model for event counts over a window.
 *
 * For a recurring event with expected count λ over the window, the number of
 * occurrences N is modeled as Poisson(λ). Markets ask about a band ("180–199
 * times") or an open threshold ("more than 200"), so we need:
 *   P(low ≤ N ≤ high) = F(high) − F(low−1)      (band; high may be ∞)
 * where F is the Poisson CDF.
 *
 * Computed iteratively (term_i = term_{i−1}·λ/i) to stay numerically stable for
 * large λ — e.g. 40 posts/day × 7 days = λ=280 — where λ^i/i! would overflow.
 * Pure math, no I/O, unit-testable.
 */

/** Poisson CDF F(k; λ) = P(N ≤ k). Returns 0 for k < 0. */
export function poissonCdf(k: number, lambda: number): number {
  if (!(lambda >= 0) || !Number.isFinite(lambda)) return NaN;
  if (k < 0) return 0;
  const kk = Math.floor(k);
  let term = Math.exp(-lambda); // i = 0
  let sum = term;
  for (let i = 1; i <= kk; i++) {
    term *= lambda / i;
    sum += term;
  }
  return Math.min(1, sum);
}

/**
 * P(low ≤ N ≤ high) under Poisson(λ). `high` may be Infinity for open-ended
 * "at least/more than" questions. Returns a value in [0,1], or NaN on bad input.
 */
export function poissonRangeProb(low: number, high: number, lambda: number): number {
  if (!Number.isFinite(lambda) || lambda < 0) return NaN;
  const lo = Math.max(0, Math.ceil(low));
  const belowLo = poissonCdf(lo - 1, lambda); // P(N ≤ low−1)
  const upToHigh = Number.isFinite(high) ? poissonCdf(Math.floor(high), lambda) : 1;
  return clamp01(upToHigh - belowLo);
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return NaN;
  return Math.min(1, Math.max(0, x));
}