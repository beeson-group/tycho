"""Closed-form complex-domain evaluators for schema 0.6 morph and surface layers.

All arithmetic runs in float64 or complex128 and matches ``web/src/evaluate/complex.ts``.
"""

from __future__ import annotations

import cmath
import math
from collections.abc import Sequence
from typing import Any

import numpy as np

# Pade [6/6] weights (12 - k)! * 6! / (12! * k! * (6 - k)!) for k in 0..6
_PADE6 = (
    1.0,
    0.5,
    5.0 / 44.0,
    1.0 / 66.0,
    1.0 / 792.0,
    1.0 / 15840.0,
    1.0 / 665280.0,
)


def conformal_exp(u: float, v: float, alpha: float, period: float) -> tuple[float, float]:
    """The image of u + j v under the conformal rolling-ribbon homotopy at progress alpha and sampling period."""
    denom_a = (1.0 - alpha) * period + alpha
    w_re = alpha * u * period
    w_im = alpha * v * period
    w_abs = math.hypot(w_re, w_im)
    if alpha < 1e-5 or w_abs < 1e-4:
        # cancel the leading alpha factor near alpha = 0 or w = 0 using a third-order Taylor sum
        w = complex(w_re, w_im)
        s_scaled = complex(u * period, v * period) / denom_a
        series = 1.0 + w * (0.5 + w * ((1.0 / 6.0) + w / 24.0))
        res = alpha + s_scaled * series
        return float(res.real), float(res.imag)
    c_alpha = alpha * denom_a
    ez_minus_1 = cmath.exp(complex(w_re, w_im)) - 1.0
    res = alpha + ez_minus_1 / c_alpha
    return float(res.real), float(res.imag)


def poly_from_roots(roots: Sequence[complex]) -> np.ndarray:
    """The monic polynomial whose roots are the given sequence, ordered from degree zero up."""
    coeffs = np.array([1.0 + 0.0j], dtype=np.complex128)
    for r in roots:
        nxt = np.zeros(len(coeffs) + 1, dtype=np.complex128)
        nxt[1:] = coeffs
        nxt[:-1] -= complex(r) * coeffs
        coeffs = nxt
    return coeffs


def expm_pade6(mat: np.ndarray) -> np.ndarray:
    """The matrix exponential computed by scaling and squaring with the diagonal [6/6] Pade approximant."""
    a = np.asarray(mat, dtype=np.complex128)
    n = a.shape[0]
    if n == 0:
        return np.empty((0, 0), dtype=np.complex128)
    if n == 1:
        return np.array([[cmath.exp(complex(a[0, 0]))]], dtype=np.complex128)
    norm1 = float(np.max(np.sum(np.abs(a), axis=0)))
    squarings = max(0, math.ceil(math.log2(norm1 / 0.25))) if norm1 > 0.25 else 0
    scale = 2.0**squarings
    x = a / scale
    ident = np.eye(n, dtype=np.complex128)
    x2 = x @ x
    x4 = x2 @ x2
    x6 = x4 @ x2
    u = x @ (_PADE6[1] * ident + _PADE6[3] * x2 + _PADE6[5] * x4)
    v = _PADE6[0] * ident + _PADE6[2] * x2 + _PADE6[4] * x4 + _PADE6[6] * x6
    num = v + u
    den = v - u
    r = np.linalg.solve(den, num)
    for _ in range(squarings):
        r = r @ r
    return r


def companion_system(
    poles: Sequence[complex],
    zeros: Sequence[complex],
    gain: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, complex | float]:
    """The controllable canonical state-space tuple (A, b, c, d_inf) for a proper rational Laplace transform."""
    n = len(poles)
    if n < 1:
        raise ValueError("companion_system requires at least one pole")
    if len(zeros) > n:
        raise ValueError("companion_system requires proper rational F(s) with at most as many zeros as poles")
    den = poly_from_roots(poles)
    num_raw = float(gain) * poly_from_roots(zeros)
    num = np.zeros(n + 1, dtype=np.complex128)
    num[: len(num_raw)] = num_raw
    d_inf = complex(num[n])
    c = num[:n] - d_inf * den[:n]
    mat = np.zeros((n, n), dtype=np.complex128)
    for r in range(n - 1):
        mat[r, r + 1] = 1.0
    mat[n - 1, :] = -den[:n]
    b = np.zeros(n, dtype=np.complex128)
    b[n - 1] = 1.0
    return mat, b, c, float(d_inf.real) if abs(d_inf.imag) < 1e-14 else d_inf


def _to_cpx_list(pairs: Sequence[Sequence[float]] | None) -> list[complex]:
    if not pairs:
        return []
    return [complex(float(p[0]), float(p[1])) for p in pairs]


def _f(x: float) -> float:
    return 0.0 if x == 0.0 else float(x)


def impulse_invariant_z(
    poles: Sequence[Sequence[float]],
    zeros: Sequence[Sequence[float]] | None,
    gain: float,
    period: float,
) -> dict[str, Any]:
    """The causal impulse-invariant Z-transform coefficients and convergence bounds for the given poles and zeros."""
    p_cpx = _to_cpx_list(poles)
    z_cpx = _to_cpx_list(zeros)
    n = len(p_cpx)
    mat, b, c, d_inf = companion_system(p_cpx, z_cpx, gain)
    m_mat = expm_pade6(mat * float(period))
    z_poles = [cmath.exp(p * float(period)) for p in p_cpx]
    q = poly_from_roots(z_poles)
    p_poly = np.zeros(n + 1, dtype=np.complex128)
    p_poly[0] = d_inf * q[0]
    v = b.copy()
    for r in range(n):
        coeff = complex(np.dot(c, v))
        p_poly[n - r] = d_inf * q[n - r] + coeff
        if r + 1 < n:
            v = m_mat @ v + q[n - 1 - r] * b
    sigma_max = max(p.real for p in p_cpx)
    r_max = math.exp(sigma_max * float(period))
    return {
        "sigma_max": _f(sigma_max),
        "r_max": _f(r_max),
        "converges": bool(sigma_max < -1e-9),
        "z_poles": [[_f(z.real), _f(z.imag)] for z in z_poles],
        "z_num": [[_f(w.real), _f(w.imag)] for w in p_poly],
        "z_den": [[_f(w.real), _f(w.imag)] for w in q],
    }


def eval_poly(coeffs: Sequence[complex], w: complex) -> complex:
    """The value of a polynomial ordered from degree zero up, evaluated at w by Horner's rule."""
    acc = complex(coeffs[-1])
    for i in range(len(coeffs) - 2, -1, -1):
        acc = acc * w + complex(coeffs[i])
    return acc


def eval_rational_s(
    poles: Sequence[Sequence[float]],
    zeros: Sequence[Sequence[float]] | None,
    gain: float,
    x: float,
    y: float,
) -> float:
    """The magnitude of a proper rational Laplace transform evaluated at x + j y."""
    s = complex(x, y)
    num = complex(float(gain), 0.0)
    if zeros:
        for z in zeros:
            num *= s - complex(float(z[0]), float(z[1]))
    den = 1.0 + 0.0j
    for p in poles:
        den *= s - complex(float(p[0]), float(p[1]))
    a_num = abs(num)
    a_den = abs(den)
    if a_den < 1e-12 * max(1.0, a_num):
        return 0.0 if a_num < 1e-12 else 1e12
    return float(a_num / a_den)


def eval_rational_z(
    z_poles: Sequence[Sequence[float]],
    z_num: Sequence[Sequence[float]],
    x: float,
    y: float,
) -> float:
    """The magnitude of a rational Z-transform given z-plane poles and numerator coefficients."""
    z = complex(x, y)
    num = eval_poly([complex(float(c[0]), float(c[1])) for c in z_num], z)
    den = 1.0 + 0.0j
    for zp in z_poles:
        den *= z - complex(float(zp[0]), float(zp[1]))
    a_num = abs(num)
    a_den = abs(den)
    if a_den < 1e-12 * max(1.0, a_num):
        return 0.0 if a_num < 1e-12 else 1e12
    return float(a_num / a_den)


def smooth_clamp(r: float, ceil_max: float, softness: float) -> float:
    """The smooth ceiling clamp bounded below at zero."""
    t = (ceil_max - r) / softness
    softplus = t + math.log1p(math.exp(-t)) if t > 0.0 else math.log1p(math.exp(t))
    out = ceil_max - softness * softplus
    return max(0.0, out)


def map_height(
    mag: float,
    scale_mode: str = "linear",
    clamp_spec: tuple[float, float] | None = None,
    height_scale: float = 1.0,
    grow: float = 1.0,
) -> float:
    """The transformed height after applying logarithmic scaling, smooth clamping, and vertical scaling."""
    raw = math.log1p(mag) if scale_mode == "log" else mag
    val = smooth_clamp(raw, clamp_spec[0], clamp_spec[1]) if clamp_spec is not None else raw
    return float(val * height_scale * grow)


def eval_time_response(
    poles: Sequence[Sequence[float]],
    zeros: Sequence[Sequence[float]] | None,
    gain: float,
    period: float,
    t_max: float = 8.0,
    n_cont: int = 240,
) -> dict[str, Any]:
    """The causal time-domain impulse response f(t) and its samples f(k T) up to t_max."""
    p_cpx = _to_cpx_list(poles)
    z_cpx = _to_cpx_list(zeros)
    mat, b, c, _d_inf = companion_system(p_cpx, z_cpx, gain)
    dt = float(t_max) / max(1, n_cont - 1)
    step_c = expm_pade6(mat * dt)
    t_cont: list[float] = []
    f_cont: list[float] = []
    x = b.copy()
    for i in range(n_cont):
        t_cont.append(i * dt)
        val = complex(np.dot(c, x))
        f_cont.append(float(val.real))
        x = step_c @ x
    step_d = expm_pade6(mat * float(period))
    n_disc = math.floor(t_max / period + 1e-9) + 1
    t_disc: list[float] = []
    f_disc: list[float] = []
    xd = b.copy()
    for k in range(n_disc):
        t_disc.append(k * float(period))
        val = complex(np.dot(c, xd))
        f_disc.append(float(val.real))
        xd = step_d @ xd
    return {"t": t_cont, "f": f_cont, "tk": t_disc, "fk": f_disc}
