/**
 * The screen geometry of an outline layer (rule L8), i.e. the corners of the target panel's visible rectangle on the host panel, widened to a
 * minimum size, cut into dashes across the visible part of the panel, and laid out as triangles with mitered corners.
 */

type Vec2 = [number, number];

/** How far outside the panel, in CSS pixels, the ring is still laid out, so that a line ending there does not show its end. */
const MARGIN = 16;
/** The longest miter, as a multiple of half the width, beyond which a sharp corner is cut. */
const MITER_LIMIT = 4;

/**
 * Corners in the order of a ring, stretched about their center along each screen axis on which they span less than `min` CSS pixels. The corners
 * are those of a parallelogram, which is the image of a rectangle under the affine map from the target frame.
 */
export function widen(corners: [Vec2, Vec2, Vec2, Vec2], min: number): [Vec2, Vec2, Vec2, Vec2] {
  const [p0, p1, p2, p3] = corners;
  const c: Vec2 = [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2];
  const a: Vec2 = [(p1[0] - p0[0]) / 2, (p1[1] - p0[1]) / 2];
  const b: Vec2 = [(p3[0] - p0[0]) / 2, (p3[1] - p0[1]) / 2];
  for (const i of [0, 1]) {
    const extent = 2 * (Math.abs(a[i]!) + Math.abs(b[i]!));
    if (extent >= min) continue;
    if (extent > 0) {
      a[i] *= min / extent;
      b[i] *= min / extent;
    } else {
      // a ring without extent along this axis is opened along the shorter side, which keeps a ring collapsed to a line or a point from staying flat
      (Math.hypot(...a) < Math.hypot(...b) ? a : b)[i] = min / 2;
    }
  }
  return [
    [c[0] - a[0] - b[0], c[1] - a[1] - b[1]],
    [c[0] + a[0] - b[0], c[1] + a[1] - b[1]],
    [c[0] + a[0] + b[0], c[1] + a[1] + b[1]],
    [c[0] - a[0] + b[0], c[1] - a[1] + b[1]],
  ];
}

/** The parameters in [0, 1] of the part of segment p q inside the box [x0, x1] by [y0, y1], or null when it misses the box (Liang and Barsky). */
function clip(p: Vec2, q: Vec2, x0: number, x1: number, y0: number, y1: number): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  for (const [den, num] of [
    [-dx, p[0] - x0],
    [dx, x1 - p[0]],
    [-dy, p[1] - y0],
    [dy, y1 - p[1]],
  ] as const) {
    if (den === 0) {
      if (num < 0) return null;
    } else {
      const t = num / den;
      if (den < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

/**
 * The polylines of a ring with the given corners in CSS pixels that are drawn on a panel of `w` by `h` pixels. They are one closed polyline when
 * the whole ring is solid and within reach of the panel, and open polylines otherwise. A dash pattern of `dash` [on, off] pixels starts at the
 * first corner and runs along the ring. Only the parts of the ring within a margin of the panel are laid out, hence a ring far larger than the
 * panel is not cut into more dashes than the panel can show.
 */
export function outlinePaths(corners: Vec2[], w: number, h: number, dash?: [number, number]): { closed: boolean; paths: Vec2[][] } {
  const n = corners.length;
  const starts: number[] = [];
  let s = 0;
  const visible: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p = corners[i]!;
    const q = corners[(i + 1) % n]!;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    starts.push(s);
    const t = clip(p, q, -MARGIN, w + MARGIN, -MARGIN, h + MARGIN);
    if (t !== null && len > 0) {
      const last = visible[visible.length - 1];
      const a = s + t[0] * len;
      if (last !== undefined && a - last[1] < 1e-9 * Math.max(1, a)) last[1] = s + t[1] * len;
      else visible.push([a, s + t[1] * len]);
    }
    s += len;
  }
  const perimeter = s;
  if (!(perimeter > 0) || !Number.isFinite(perimeter)) return { closed: false, paths: [] };
  const whole = visible.length === 1 && visible[0]![0] === 0 && visible[0]![1] >= perimeter * (1 - 1e-12);
  if (whole && dash === undefined) return { closed: true, paths: [corners.map((c) => [c[0], c[1]] as Vec2)] };
  // the point at arc length u, and the path from u to v through the corners between them
  const at = (u: number): Vec2 => {
    let i = n - 1;
    while (i > 0 && starts[i]! > u) i--;
    const p = corners[i]!;
    const q = corners[(i + 1) % n]!;
    const len = (i + 1 < n ? starts[i + 1]! : perimeter) - starts[i]!;
    const t = len > 0 ? (u - starts[i]!) / len : 0;
    return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
  };
  const path = (u: number, v: number): Vec2[] => {
    const out: Vec2[] = [at(u)];
    for (let i = 1; i < n; i++) if (starts[i]! > u && starts[i]! < v) out.push(corners[i]!);
    out.push(at(v));
    return out;
  };
  const paths: Vec2[][] = [];
  for (const [a, b] of visible) {
    if (dash === undefined) {
      paths.push(path(a, b));
      continue;
    }
    const period = dash[0] + dash[1];
    for (let k = Math.floor(a / period); k * period < b; k++) {
      const u = Math.max(a, k * period);
      const v = Math.min(b, k * period + dash[0]);
      if (v > u) paths.push(path(u, v));
    }
  }
  return { closed: false, paths };
}

/** Appends to `out` the triangles, as x, y pairs in CSS pixels, of a line `width` pixels wide along `path`, with mitered joins and butt ends. */
export function strokeTriangles(path: Vec2[], closed: boolean, width: number, out: number[] = []): number[] {
  const pts = path.filter((p, i) => i === 0 || Math.hypot(p[0] - path[i - 1]![0], p[1] - path[i - 1]![1]) > 1e-9);
  if (closed && pts.length > 1 && Math.hypot(pts[0]![0] - pts[pts.length - 1]![0], pts[0]![1] - pts[pts.length - 1]![1]) <= 1e-9) pts.pop();
  const n = pts.length;
  if (n < 2) return out;
  const hw = width / 2;
  const normal = (p: Vec2, q: Vec2): Vec2 => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    return [-(q[1] - p[1]) / len, (q[0] - p[0]) / len];
  };
  const offsets: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = closed || i > 0 ? normal(pts[(i - 1 + n) % n]!, pts[i]!) : null;
    const next = closed || i < n - 1 ? normal(pts[i]!, pts[(i + 1) % n]!) : null;
    if (prev === null || next === null) {
      const m = (prev ?? next)!;
      offsets.push([m[0] * hw, m[1] * hw]);
      continue;
    }
    const sum: Vec2 = [prev[0] + next[0], prev[1] + next[1]];
    const len = Math.hypot(sum[0], sum[1]);
    const m: Vec2 = len > 1e-9 ? [sum[0] / len, sum[1] / len] : next;
    // the miter reaches hw / cos(theta / 2) from the corner, where theta is the turn there, and it is cut at MITER_LIMIT half widths
    const scale = hw / Math.max(1 / MITER_LIMIT, m[0] * next[0] + m[1] * next[1]);
    offsets.push([m[0] * scale, m[1] * scale]);
  }
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % n;
    const [p, q, op, oq] = [pts[i]!, pts[j]!, offsets[i]!, offsets[j]!];
    const l0 = [p[0] + op[0], p[1] + op[1]];
    const r0 = [p[0] - op[0], p[1] - op[1]];
    const l1 = [q[0] + oq[0], q[1] + oq[1]];
    const r1 = [q[0] - oq[0], q[1] - oq[1]];
    out.push(...l0, ...r0, ...l1, ...r0, ...r1, ...l1);
  }
  return out;
}

/** The triangles, as x, y pairs in CSS pixels, of an outline with the given corners in pixels on a panel of `w` by `h` pixels. */
export function outlineTriangles(
  corners: [Vec2, Vec2, Vec2, Vec2],
  w: number,
  h: number,
  look: { width: number; minSize: number; dash?: [number, number] },
): number[] {
  const { closed, paths } = outlinePaths(widen(corners, look.minSize), w, h, look.dash);
  const out: number[] = [];
  for (const p of paths) strokeTriangles(p, closed, look.width, out);
  return out;
}
