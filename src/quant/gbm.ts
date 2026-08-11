/**
 * Geometric Brownian Motion / lognormal threshold probability.
 *
 * Standard options-style model: under GBM, ln(S_T) is normally distributed with
 *   mean = ln(S) + (μ − σ²/2)·T,   variance = σ²·T
 * so the probability the price finishes ABOVE a strike K is
 *   P(S_T > K) = Φ(d),   d = [ln(S/K) + (μ − σ²/2)·T] / (σ·√T)
 * and P(S_T < K) = 1 − Φ(d) = Φ(−d).
 *
 * We default drift μ = 0 (no directional view — we're pricing dispersion, not
 * betting on trend). All pure math, no I/O, fully deterministic → unit-testable.
 */

/** Abramowitz & Stegun 7.1.26 error-function approximation (|error| < 1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF Φ(x). */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export type Direction = "gt" | "lt";

export interface GbmInputs {
  spot: number;
  strike: number;
  /** Annualized volatility (e.g. 0.6 = 60%). */
  sigmaAnnual: number;
  /** Time to settlement in years. */
  tYears: number;
  /** Annualized drift. Default 0. */
  drift?: number;
  /** Which side the *proposition* is: "gt" = price above strike, "lt" = below. */
  direction: Direction;
}

/**
 * Probability the proposition is TRUE (price on the `direction` side of strike)
 * at settlement. Returns null when inputs are degenerate (non-positive spot/strike,
 * zero/negative time or vol) — callers treat null as "not applicable".
 */
export function probThreshold(inp: GbmInputs): number | null {
  const { spot, strike, sigmaAnnual, tYears, direction } = inp;
  const drift = inp.drift ?? 0;
  if (!(spot > 0 && strike > 0 && sigmaAnnual > 0 && tYears > 0)) return null;

  const d =
    (Math.log(spot / strike) + (drift - 0.5 * sigmaAnnual * sigmaAnnual) * tYears) /
    (sigmaAnnual * Math.sqrt(tYears));

  const pAbove = normCdf(d);
  return direction === "gt" ? pAbove : 1 - pAbove;
}

/** Annualize a daily volatility. Crypto trades 365 days/yr. */
export function annualizeDailyVol(sigmaDaily: number, tradingDaysPerYear = 365): number {
  return sigmaDaily * Math.sqrt(tradingDaysPerYear);
}

/** Sample standard deviation of an array (n−1 denominator). */
export function sampleStdev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (xs.length - 1);
  return Math.sqrt(variance);
}