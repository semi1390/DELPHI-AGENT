/**
 * Negative-binomial model for over-dispersed event counts.
 *
 * Posting behavior is bursty — quiet days then 100+ in a day — so the variance of
 * the count far exceeds its mean. Poisson assumes variance = mean and therefore
 * UNDERSTATES the tails (extreme bands look less likely than they are). The
 * negative binomial adds a dispersion parameter r:
 *   mean = μ,   variance = μ + μ²/r
 * As r → ∞ it collapses to Poisson; smaller r = fatter tails. We estimate r by
 * method of moments from the observed daily counts (var > mean ⇒ finite r), and
 * fall back to Poisson when the data isn't over-dispersed.
 *
 * Parameterization: p = r/(r+μ); pmf(0) = p^r; pmf(k) = pmf(k−1)·(r+k−1)/k·(1−p).
 * Computed iteratively so it's stable and works for non-integer r. Pure math.
 */

import { poissonCdf, poissonRangeProb } from "./poisson.js";

/** Method-of-moments dispersion r from mean & variance. Infinity ⇒ use Poisson. */
export function dispersionFromMoments(mean: number, variance: number): number {
  if (!(mean > 0) || !Number.isFinite(variance)) return Infinity;
  if (variance <= mean * (1 + 1e-9)) return Infinity; // not over-dispersed → Poisson
  return (mean * mean) / (variance - mean);
}

/** Negative-binomial CDF F(k; μ, r) = P(N ≤ k). */
export function negBinomCdf(k: number, mean: number, r: number): number {
  if (!Number.isFinite(r)) return poissonCdf(k, mean);
  if (!(mean > 0) || !(r > 0)) return NaN;
  if (k < 0) return 0;
  const kk = Math.floor(k);
  const p = r / (r + mean);
  const oneMinusP = mean / (r + mean);
  let term = Math.exp(r * Math.log(p)); // pmf(0) = p^r
  let sum = term;
  for (let i = 1; i <= kk; i++) {
    term *= ((r + i - 1) / i) * oneMinusP;
    sum += term;
  }
  return Math.min(1, sum);
}

/**
 * P(low ≤ N ≤ high) under NB(μ, r). `high` may be Infinity. Falls back to Poisson
 * when r is Infinity (not over-dispersed). Returns [0,1] or NaN on bad input.
 */
export function negBinomRangeProb(low: number, high: number, mean: number, r: number): number {
  if (!Number.isFinite(r)) return poissonRangeProb(low, high, mean);
  if (!(mean > 0) || !(r > 0)) return NaN;
  const lo = Math.max(0, Math.ceil(low));
  const belowLo = negBinomCdf(lo - 1, mean, r);
  const upToHigh = Number.isFinite(high) ? negBinomCdf(Math.floor(high), mean, r) : 1;
  return clamp01(upToHigh - belowLo);
}

/** Sample mean and (n−1) variance of an array. */
export function meanVar(xs: number[]): { mean: number; variance: number } {
  const n = xs.length;
  if (n === 0) return { mean: NaN, variance: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, variance: NaN };
  const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  return { mean, variance };
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return NaN;
  return Math.min(1, Math.max(0, x));
}