/**
 * Position sizing — fractional Kelly, hard-capped.
 *
 * For a binary outcome bought at effective price c (tokens per share, ≈ what you'd
 * actually pay after slippage) with your estimated win probability q, a share pays
 * 1 if it resolves true and 0 otherwise. The Kelly-optimal fraction of bankroll is
 *   f* = (q − c) / (1 − c)
 * (net odds b = (1−c)/c; f* = (bq − (1−q))/b simplifies to the above). We then take
 * a FRACTION of Kelly and scale by estimator confidence, and clamp to [0,1]:
 *   f = clamp( kellyFraction × confidence × f*, 0, 1 )
 * Fractional Kelly (e.g. ¼) is standard practice — full Kelly is famously too
 * volatile and assumes your probabilities are exactly right, which they never are.
 *
 * Everything here is pure and unit-tested. Caps are applied separately by the
 * planner (per-market and total exposure), so no single signal can bet the farm.
 */

export interface KellyInputs {
  /** Your estimated probability the outcome resolves true, in [0,1]. */
  q: number;
  /** Effective price you'd pay per share (post-slippage), in (0,1). */
  cEff: number;
  /** Estimator confidence in [0,1]. */
  confidence: number;
  /** Fraction of Kelly to apply (e.g. 0.25 = quarter Kelly). */
  kellyFraction: number;
}

/** Raw Kelly-optimal fraction f* = (q − c)/(1 − c), clamped to [0,1]. 0 if no edge. */
export function kellyStar(q: number, cEff: number): number {
  if (!(cEff > 0 && cEff < 1) || !(q > 0 && q <= 1)) return 0;
  if (q <= cEff) return 0;
  return clamp01((q - cEff) / (1 - cEff));
}

/** Fraction of bankroll to stake after fractional-Kelly + confidence scaling. */
export function sizedFraction(inp: KellyInputs): number {
  const star = kellyStar(inp.q, inp.cEff);
  const conf = clamp01(inp.confidence);
  const kf = Math.max(0, inp.kellyFraction);
  return clamp01(kf * conf * star);
}

/** Target stake (in TST) before caps. */
export function targetStake(inp: KellyInputs, bankroll: number): number {
  return sizedFraction(inp) * Math.max(0, bankroll);
}

/**
 * Apply hard caps to a desired stake. Returns the allowed stake and, if it was
 * reduced to (near) zero, the binding reason for logging.
 */
export function applyCaps(
  desired: number,
  opts: { perMarketRoom: number; totalRoom: number; maxPositionPerMarket: number; minOrder: number },
): { stake: number; reason?: string } {
  const capped = Math.min(desired, opts.maxPositionPerMarket, opts.perMarketRoom, opts.totalRoom);
  if (capped < opts.minOrder) {
    let reason = "size below min order after caps";
    if (opts.totalRoom < opts.minOrder) reason = "total exposure cap reached";
    else if (opts.perMarketRoom < opts.minOrder) reason = "per-market cap reached";
    return { stake: 0, reason };
  }
  return { stake: capped };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}