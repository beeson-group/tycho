"""Closed-form complex-domain evaluators for schema 0.6 morph layers.

All arithmetic runs in float64 or complex128 and matches ``web/src/evaluate/complex.ts``.
"""

from __future__ import annotations

import cmath
import math


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
