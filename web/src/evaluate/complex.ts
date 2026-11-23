/**
 * Closed-form complex-domain evaluators for schema 0.6 `morph` layers.
 *
 * All arithmetic runs in float64 with identical formulas to `src/pytycho/_complex.py`.
 */

export interface Cpx {
  re: number;
  im: number;
}

export const cpx = (re: number, im = 0): Cpx => ({ re, im });
export const cAdd = (a: Cpx, b: Cpx): Cpx => ({ re: a.re + b.re, im: a.im + b.im });
export const cSub = (a: Cpx, b: Cpx): Cpx => ({ re: a.re - b.re, im: a.im - b.im });
export const cMul = (a: Cpx, b: Cpx): Cpx => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
export const cScale = (a: Cpx, k: number): Cpx => ({ re: a.re * k, im: a.im * k });
export const cAbs = (a: Cpx): number => Math.hypot(a.re, a.im);

export function cDiv(a: Cpx, b: Cpx): Cpx {
  // Smith's overflow-safe complex division
  if (Math.abs(b.re) >= Math.abs(b.im)) {
    const r = b.im / b.re;
    const d = b.re + r * b.im;
    return { re: (a.re + a.im * r) / d, im: (a.im - a.re * r) / d };
  }
  const r = b.re / b.im;
  const d = b.im + r * b.re;
  return { re: (a.re * r + a.im) / d, im: (a.im * r - a.re) / d };
}

export function cExp(a: Cpx): Cpx {
  const ea = Math.exp(a.re);
  return { re: ea * Math.cos(a.im), im: ea * Math.sin(a.im) };
}

/** Scale-preserving conformal rolling-ribbon homotopy h_alpha(u + j v) for alpha in [0, 1] and T > 0. */
export function conformalExp(u: number, v: number, alpha: number, period: number): [number, number] {
  const denomA = (1.0 - alpha) * period + alpha;
  const wRe = alpha * u * period;
  const wIm = alpha * v * period;
  const wAbs = Math.hypot(wRe, wIm);
  if (alpha < 1e-5 || wAbs < 1e-4) {
    const w = cpx(wRe, wIm);
    const sScaled = cpx((u * period) / denomA, (v * period) / denomA);
    const t2 = cAdd(cpx(1.0 / 6.0, 0), cScale(w, 1.0 / 24.0));
    const t1 = cAdd(cpx(0.5, 0), cMul(w, t2));
    const series = cAdd(cpx(1.0, 0), cMul(w, t1));
    const res = cMul(sScaled, series);
    return [alpha + res.re, res.im];
  }
  const cAlpha = alpha * denomA;
  const ez = cExp(cpx(wRe, wIm));
  return [alpha + (ez.re - 1.0) / cAlpha, ez.im / cAlpha];
}
