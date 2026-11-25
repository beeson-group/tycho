/**
 * Closed-form complex-domain evaluators for schema 0.6 `morph` and `surface` layers.
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

const PADE6 = [1.0, 0.5, 5.0 / 44.0, 1.0 / 66.0, 1.0 / 792.0, 1.0 / 15840.0, 1.0 / 665280.0];

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

/** Monic polynomial prod_k (s - roots[k]) in ascending power order s^0 ... s^n. */
export function polyFromRoots(roots: readonly Cpx[]): Cpx[] {
  let coeffs: Cpx[] = [cpx(1, 0)];
  for (const r of roots) {
    const nxt: Cpx[] = Array.from({ length: coeffs.length + 1 }, () => cpx(0, 0));
    for (let i = 0; i < coeffs.length; i++) {
      nxt[i + 1] = cAdd(nxt[i + 1]!, coeffs[i]!);
      nxt[i] = cSub(nxt[i]!, cMul(r, coeffs[i]!));
    }
    coeffs = nxt;
  }
  return coeffs;
}

function matEye(n: number): Cpx[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => cpx(i === j ? 1 : 0, 0)));
}

function matMul(a: Cpx[][], b: Cpx[][]): Cpx[][] {
  const n = a.length;
  const out = Array.from({ length: n }, () => Array.from({ length: n }, () => cpx(0, 0)));
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const aik = a[i]![k]!;
      if (aik.re === 0 && aik.im === 0) continue;
      for (let j = 0; j < n; j++) {
        out[i]![j] = cAdd(out[i]![j]!, cMul(aik, b[k]![j]!));
      }
    }
  }
  return out;
}

function matAddScaled(terms: readonly { w: number; m: Cpx[][] }[]): Cpx[][] {
  const n = terms[0]!.m.length;
  const out = Array.from({ length: n }, () => Array.from({ length: n }, () => cpx(0, 0)));
  for (const { w, m } of terms) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        out[i]![j]!.re += w * m[i]![j]!.re;
        out[i]![j]!.im += w * m[i]![j]!.im;
      }
    }
  }
  return out;
}

function matSolve(aMat: Cpx[][], bMat: Cpx[][]): Cpx[][] {
  const n = aMat.length;
  const a = aMat.map((row) => row.map((v) => ({ ...v })));
  const b = bMat.map((row) => row.map((v) => ({ ...v })));
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = cAbs(a[col]![col]!);
    for (let row = col + 1; row < n; row++) {
      const mag = cAbs(a[row]![col]!);
      if (mag > best) {
        best = mag;
        piv = row;
      }
    }
    if (piv !== col) {
      [a[col], a[piv]] = [a[piv]!, a[col]!];
      [b[col], b[piv]] = [b[piv]!, b[col]!];
    }
    const diag = a[col]![col]!;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = cDiv(a[row]![col]!, diag);
      if (factor.re === 0 && factor.im === 0) continue;
      for (let j = col; j < n; j++) a[row]![j] = cSub(a[row]![j]!, cMul(factor, a[col]![j]!));
      for (let j = 0; j < n; j++) b[row]![j] = cSub(b[row]![j]!, cMul(factor, b[col]![j]!));
    }
  }
  for (let i = 0; i < n; i++) {
    const diag = a[i]![i]!;
    for (let j = 0; j < n; j++) b[i]![j] = cDiv(b[i]![j]!, diag);
  }
  return b;
}

/** Matrix exponential exp(mat) via scaling-and-squaring with the diagonal [6/6] Pade approximant. */
export function expmPade6(mat: Cpx[][]): Cpx[][] {
  const n = mat.length;
  if (n === 0) return [];
  if (n === 1) return [[cExp(mat[0]![0]!)]];
  let norm1 = 0;
  for (let j = 0; j < n; j++) {
    let colSum = 0;
    for (let i = 0; i < n; i++) colSum += cAbs(mat[i]![j]!);
    if (colSum > norm1) norm1 = colSum;
  }
  const squarings = norm1 > 0.25 ? Math.max(0, Math.ceil(Math.log2(norm1 / 0.25))) : 0;
  const invScale = 2 ** -squarings;
  const x = mat.map((row) => row.map((v) => cScale(v, invScale)));
  const ident = matEye(n);
  const x2 = matMul(x, x);
  const x4 = matMul(x2, x2);
  const x6 = matMul(x4, x2);
  const u = matMul(
    x,
    matAddScaled([
      { w: PADE6[1]!, m: ident },
      { w: PADE6[3]!, m: x2 },
      { w: PADE6[5]!, m: x4 },
    ]),
  );
  const v = matAddScaled([
    { w: PADE6[0]!, m: ident },
    { w: PADE6[2]!, m: x2 },
    { w: PADE6[4]!, m: x4 },
    { w: PADE6[6]!, m: x6 },
  ]);
  const num = matAddScaled([
    { w: 1, m: v },
    { w: 1, m: u },
  ]);
  const den = matAddScaled([
    { w: 1, m: v },
    { w: -1, m: u },
  ]);
  let r = matSolve(den, num);
  for (let k = 0; k < squarings; k++) r = matMul(r, r);
  return r;
}

/** Controllable canonical realization (A, b, c, dInf) for proper rational F(s). */
export function companionSystem(poles: readonly Cpx[], zeros: readonly Cpx[], gain: number): { mat: Cpx[][]; b: Cpx[]; c: Cpx[]; dInf: Cpx } {
  const n = poles.length;
  if (n < 1) throw new Error('companionSystem requires at least one pole');
  if (zeros.length > n) throw new Error('companionSystem requires proper rational F(s) with deg(num) <= deg(den)');
  const den = polyFromRoots(poles);
  const numRaw = polyFromRoots(zeros).map((w) => cScale(w, gain));
  const num: Cpx[] = Array.from({ length: n + 1 }, (_, i) => (i < numRaw.length ? numRaw[i]! : cpx(0, 0)));
  const dInf = num[n]!;
  const c = Array.from({ length: n }, (_, i) => cSub(num[i]!, cMul(dInf, den[i]!)));
  const mat = Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (__, col) => {
      if (r < n - 1) return cpx(col === r + 1 ? 1 : 0, 0);
      return cpx(-den[col]!.re, -den[col]!.im);
    }),
  );
  const b = Array.from({ length: n }, (_, i) => cpx(i === n - 1 ? 1 : 0, 0));
  return { mat, b, c, dInf };
}

export interface ImpulseInvariantResult {
  sigma_max: number;
  r_max: number;
  converges: boolean;
  z_poles: [number, number][];
  z_num: [number, number][];
  z_den: [number, number][];
}

function matVec(mat: readonly (readonly Cpx[])[], vec: readonly Cpx[]): Cpx[] {
  const n = mat.length;
  return Array.from({ length: n }, (_, i) => {
    let acc = cpx(0, 0);
    for (let j = 0; j < n; j++) acc = cAdd(acc, cMul(mat[i]![j]!, vec[j]!));
    return acc;
  });
}

function dotCpx(a: readonly Cpx[], b: readonly Cpx[]): Cpx {
  let acc = cpx(0, 0);
  for (let i = 0; i < a.length; i++) acc = cAdd(acc, cMul(a[i]!, b[i]!));
  return acc;
}

/** Exact causal impulse-invariant Z-transform F(z) = sum_{k>=0} f(kT) z^{-k}. */
export function impulseInvariantZ(
  poles: readonly [number, number][],
  zeros: readonly [number, number][],
  gain: number,
  period: number,
): ImpulseInvariantResult {
  const pCpx = poles.map(([re, im]) => cpx(re, im));
  const zCpx = zeros.map(([re, im]) => cpx(re, im));
  const n = pCpx.length;
  const { mat, b, c, dInf } = companionSystem(pCpx, zCpx, gain);
  const mMat = expmPade6(mat.map((row) => row.map((v) => cScale(v, period))));
  const zPoles = pCpx.map((p) => cExp(cScale(p, period)));
  const q = polyFromRoots(zPoles);
  const pPoly: Cpx[] = Array.from({ length: n + 1 }, () => cpx(0, 0));
  pPoly[0] = cMul(dInf, q[0]!);
  let v = b.map((w) => ({ ...w }));
  for (let r = 0; r < n; r++) {
    const coeff = dotCpx(c, v);
    pPoly[n - r] = cAdd(cMul(dInf, q[n - r]!), coeff);
    if (r + 1 < n) {
      const mv = matVec(mMat, v);
      const qnr = q[n - 1 - r]!;
      v = mv.map((val, idx) => cAdd(val, cMul(qnr, b[idx]!)));
    }
  }
  const sigmaMax = Math.max(...pCpx.map((p) => p.re));
  const rMax = Math.exp(sigmaMax * period);
  return {
    sigma_max: sigmaMax,
    r_max: rMax,
    converges: sigmaMax < -1e-9,
    z_poles: zPoles.map((z) => [z.re, z.im]),
    z_num: pPoly.map((w) => [w.re, w.im]),
    z_den: q.map((w) => [w.re, w.im]),
  };
}

export function evalPoly(coeffs: readonly Cpx[], w: Cpx): Cpx {
  let acc = { ...coeffs[coeffs.length - 1]! };
  for (let i = coeffs.length - 2; i >= 0; i--) acc = cAdd(cMul(acc, w), coeffs[i]!);
  return acc;
}

/**
 * The roots of a polynomial with ascending complex coefficients, by a fixed number of Durand-Kerner steps. The leading coefficients
 * that vanish against the largest one do not count toward the degree, and a multiple root is found to about the square root of the
 * rounding error.
 */
export function polyRoots(coeffs: readonly [number, number][], steps = 80): [number, number][] {
  const largest = Math.max(0, ...coeffs.map(([re, im]) => Math.hypot(re, im)));
  let degree = coeffs.length - 1;
  while (degree > 0 && Math.hypot(coeffs[degree]![0], coeffs[degree]![1]) <= 1e-12 * largest) degree--;
  if (degree < 1 || largest === 0) return [];
  const lead = cpx(coeffs[degree]![0], coeffs[degree]![1]);
  const monic = coeffs.slice(0, degree + 1).map(([re, im]) => cDiv(cpx(re, im), lead));
  // every root lies within the bound of Cauchy, and the starting points lie on a circle inside it, turned off the real axis
  const radius = 1 + Math.max(...monic.slice(0, degree).map(cAbs));
  const roots: Cpx[] = Array.from({ length: degree }, (_, k) => {
    const angle = (2 * Math.PI * k) / degree + 0.4;
    return cpx(0.5 * radius * Math.cos(angle), 0.5 * radius * Math.sin(angle));
  });
  for (let step = 0; step < steps; step++) {
    for (let i = 0; i < degree; i++) {
      let den = cpx(1, 0);
      for (let j = 0; j < degree; j++) if (j !== i) den = cMul(den, cSub(roots[i]!, roots[j]!));
      if (cAbs(den) === 0) continue;
      roots[i] = cSub(roots[i]!, cDiv(evalPoly(monic, roots[i]!), den));
    }
  }
  return roots.map((r) => [r.re, r.im]);
}

/** Magnitude |F(x + j y)| of proper rational Laplace transform. */
export function evalRationalS(poles: readonly [number, number][], zeros: readonly [number, number][], gain: number, x: number, y: number): number {
  const s = cpx(x, y);
  let num = cpx(gain, 0);
  for (const [zr, zi] of zeros) num = cMul(num, cSub(s, cpx(zr, zi)));
  let den = cpx(1, 0);
  for (const [pr, pi] of poles) den = cMul(den, cSub(s, cpx(pr, pi)));
  const aNum = cAbs(num);
  const aDen = cAbs(den);
  if (aDen < 1e-12 * Math.max(1.0, aNum)) return aNum < 1e-12 ? 0.0 : 1e12;
  return aNum / aDen;
}

/** Magnitude |F(x + j y)| of rational Z-transform given z-plane poles and ascending numerator coefficients. */
export function evalRationalZ(zPoles: readonly [number, number][], zNum: readonly [number, number][], x: number, y: number): number {
  const z = cpx(x, y);
  const num = evalPoly(
    zNum.map(([re, im]) => cpx(re, im)),
    z,
  );
  let den = cpx(1, 0);
  for (const [pr, pi] of zPoles) den = cMul(den, cSub(z, cpx(pr, pi)));
  const aNum = cAbs(num);
  const aDen = cAbs(den);
  if (aDen < 1e-12 * Math.max(1.0, aNum)) return aNum < 1e-12 ? 0.0 : 1e12;
  return aNum / aDen;
}

/** Smooth ceiling clamp C - w * ln(1 + exp((C - r) / w)) bounded below by 0. */
export function smoothClamp(r: number, ceilMax: number, softness: number): number {
  const t = (ceilMax - r) / softness;
  const softplus = t > 0 ? t + Math.log1p(Math.exp(-t)) : Math.log1p(Math.exp(t));
  const out = ceilMax - softness * softplus;
  return out > 0 ? out : 0;
}

/** Transforms magnitude to surface height using scale mode, smooth clamp, heightScale, and grow. */
export function mapHeight(
  mag: number,
  scaleMode: 'linear' | 'log' = 'linear',
  clampSpec?: { max: number; softness: number },
  heightScale = 1.0,
  grow = 1.0,
): number {
  const raw = scaleMode === 'log' ? Math.log1p(mag) : mag;
  const val = clampSpec !== undefined ? smoothClamp(raw, clampSpec.max, clampSpec.softness) : raw;
  return val * heightScale * grow;
}

/** Causal inverse Laplace response f(t) on [0, tMax] and discrete impulse samples f(kT). */
export function evalTimeResponse(
  poles: readonly [number, number][],
  zeros: readonly [number, number][],
  gain: number,
  period: number,
  tMax = 8.0,
  nCont = 240,
): { t: number[]; f: number[]; tk: number[]; fk: number[] } {
  const pCpx = poles.map(([re, im]) => cpx(re, im));
  const zCpx = zeros.map(([re, im]) => cpx(re, im));
  const { mat, b, c } = companionSystem(pCpx, zCpx, gain);
  const dt = tMax / Math.max(1, nCont - 1);
  const stepC = expmPade6(mat.map((row) => row.map((v) => cScale(v, dt))));
  const t: number[] = [];
  const f: number[] = [];
  let x = b.map((w) => ({ ...w }));
  for (let i = 0; i < nCont; i++) {
    t.push(i * dt);
    f.push(dotCpx(c, x).re);
    x = matVec(stepC, x);
  }
  const stepD = expmPade6(mat.map((row) => row.map((v) => cScale(v, period))));
  const nDisc = Math.floor(tMax / period + 1e-9) + 1;
  const tk: number[] = [];
  const fk: number[] = [];
  let xd = b.map((w) => ({ ...w }));
  for (let k = 0; k < nDisc; k++) {
    tk.push(k * period);
    fk.push(dotCpx(c, xd).re);
    xd = matVec(stepD, xd);
  }
  return { t, f, tk, fk };
}
