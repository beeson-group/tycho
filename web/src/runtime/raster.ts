/**
 * Paints a laid-out element tree onto a 2D canvas, for a video frame that shows what the page shows. The browser lays the tree out,
 * and `rasterize` draws every box, text run, and canvas where the layout put it, in the colors, fonts, and shadows of its computed
 * style. The painter covers the CSS that the viewer uses over its panel area: background colors and linear gradients, solid borders (also
 * a triangle made of borders), box and text shadows, opacity, overflow clipping, 2D transforms, absolutely positioned `::before` and
 * `::after` boxes without text, and canvases. Boxes are painted in tree order, which is the order of their z-index in the viewer.
 * Visibility is not read, since the tree is hidden while it is painted.
 */

type G = CanvasRenderingContext2D;

interface Shadow {
  color: string;
  x: number;
  y: number;
  blur: number;
  spread: number;
  inset: boolean;
}

const px = (s: string): number => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
};

/** Splits a computed list at its top-level commas, i.e. outside parentheses. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out.filter((x) => x !== '');
}

const COLOR = /^(rgba?\([^)]*\)|#[0-9a-f]+|[a-z]+)/i;

/** The shadows of a computed `text-shadow` or `box-shadow`, whose color Chrome writes first. Exported for the tests. */
export function parseShadows(s: string): Shadow[] {
  if (s === 'none' || s === '') return [];
  return splitTop(s).map((one) => {
    const color = COLOR.exec(one)?.[0] ?? 'transparent';
    const rest = one.slice(color.length);
    const lengths = [...rest.matchAll(/-?[\d.]+px/g)].map((m) => px(m[0]));
    return { color, x: lengths[0] ?? 0, y: lengths[1] ?? 0, blur: lengths[2] ?? 0, spread: lengths[3] ?? 0, inset: /\binset\b/.test(rest) };
  });
}

/**
 * The direction and the stops of a computed `linear-gradient(...)`, or null for any other image. The direction is a unit vector in
 * CSS pixels with y down, and each stop is a position in [0, 1] and a color. Exported for the tests.
 */
export function parseGradient(s: string): { dir: [number, number]; stops: [number, string][] } | null {
  const m = /^linear-gradient\((.*)\)$/.exec(s.trim());
  if (m === null) return null;
  const args = splitTop(m[1]!);
  let dir: [number, number] = [0, 1];
  const sides: Record<string, [number, number]> = { 'to top': [0, -1], 'to bottom': [0, 1], 'to left': [-1, 0], 'to right': [1, 0] };
  if (sides[args[0]!] !== undefined) dir = sides[args.shift()!]!;
  else if (/^-?[\d.]+deg$/.test(args[0]!)) {
    const a = (px(args.shift()!) * Math.PI) / 180;
    dir = [Math.sin(a), -Math.cos(a)];
  }
  const stops: [number, string][] = args.map((a, i) => {
    const color = COLOR.exec(a)?.[0] ?? 'transparent';
    const at = /(-?[\d.]+)%/.exec(a.slice(color.length));
    return [at === null ? (args.length === 1 ? 0 : i / (args.length - 1)) : Math.min(1, Math.max(0, px(at[1]!) / 100)), color];
  });
  return { dir, stops };
}

const clear = (c: string) => c === 'transparent' || c === '' || /rgba\([^)]*,\s*0\)$/.test(c);

/**
 * Paints the shadow `s` of a shape without the shape. `draw` draws the shape moved by its argument along x, far off the canvas, and
 * the shadow is offset back, since a canvas draws a shadow only together with its shape. The blur and the offset of a canvas shadow
 * are in device pixels, hence they are scaled by the current transform.
 */
function shadowOnly(g: G, s: Shadow, draw: (dx: number) => void): void {
  const m = g.getTransform();
  const far = 1e5;
  g.save();
  g.shadowColor = s.color;
  g.shadowBlur = s.blur * Math.hypot(m.a, m.b);
  g.shadowOffsetX = -far * m.a + (s.x * m.a + s.y * m.c);
  g.shadowOffsetY = -far * m.b + (s.x * m.b + s.y * m.d);
  g.fillStyle = '#000';
  draw(far);
  g.restore();
}

/** Paints the borders of a box as four trapezoids, which also draws a triangle made of borders. */
function borders(g: G, x: number, y: number, w: number, h: number, cs: CSSStyleDeclaration): void {
  const t = cs.borderTopStyle === 'none' ? 0 : px(cs.borderTopWidth);
  const r = cs.borderRightStyle === 'none' ? 0 : px(cs.borderRightWidth);
  const b = cs.borderBottomStyle === 'none' ? 0 : px(cs.borderBottomWidth);
  const l = cs.borderLeftStyle === 'none' ? 0 : px(cs.borderLeftWidth);
  const sides: [number, string, number[]][] = [
    [t, cs.borderTopColor, [x, y, x + w, y, x + w - r, y + t, x + l, y + t]],
    [r, cs.borderRightColor, [x + w, y, x + w, y + h, x + w - r, y + h - b, x + w - r, y + t]],
    [b, cs.borderBottomColor, [x + w, y + h, x, y + h, x + l, y + h - b, x + w - r, y + h - b]],
    [l, cs.borderLeftColor, [x, y + h, x, y, x + l, y + t, x + l, y + h - b]],
  ];
  for (const [width, color, p] of sides) {
    if (width <= 0 || clear(color)) continue;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(p[0]!, p[1]!);
    for (let i = 2; i < 8; i += 2) g.lineTo(p[i]!, p[i + 1]!);
    g.closePath();
    g.fill();
  }
}

/** Paints the outer shadows, the background, and the borders of a box at (x, y) of size w by h in the current coordinates. */
function box(g: G, x: number, y: number, w: number, h: number, cs: CSSStyleDeclaration): void {
  for (const s of parseShadows(cs.boxShadow).reverse()) {
    if (s.inset || clear(s.color)) continue;
    if (s.blur === 0) {
      g.fillStyle = s.color;
      g.fillRect(x + s.x - s.spread, y + s.y - s.spread, w + 2 * s.spread, h + 2 * s.spread);
    } else shadowOnly(g, s, (dx) => g.fillRect(x - s.spread + dx, y - s.spread, w + 2 * s.spread, h + 2 * s.spread));
  }
  if (!clear(cs.backgroundColor)) {
    g.fillStyle = cs.backgroundColor;
    g.fillRect(x, y, w, h);
  }
  const grad = parseGradient(cs.backgroundImage);
  if (grad !== null) {
    // the gradient line of CSS runs through the center, as long as the box projected on its direction
    const [dx, dy] = grad.dir;
    const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const lg = g.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
    for (const [at, color] of grad.stops) lg.addColorStop(at, color);
    g.fillStyle = lg;
    g.fillRect(x, y, w, h);
  }
  borders(g, x, y, w, h, cs);
}

/** Whether a computed transform turns, scales, or skews, rather than only moving a box, whose client rect then stays its box. */
const turns = (t: string): boolean => t !== 'none' && t !== '' && !/^matrix\(1, 0, 0, 1, [^,]+, [^,]+\)$/.test(t);

const fontOf = (cs: CSSStyleDeclaration) => `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;

/** Paints a run of text whose alphabetic baseline starts at (x, y), over the text shadows of `cs`. */
function run(g: G, s: string, x: number, y: number, cs: CSSStyleDeclaration): void {
  y = snapY(g, y);
  g.font = fontOf(cs);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
  for (const sh of parseShadows(cs.textShadow).reverse()) if (!clear(sh.color)) shadowOnly(g, sh, (dx) => g.fillText(s, x + dx, y));
  g.fillStyle = cs.color;
  g.fillText(s, x, y);
}

/**
 * The ascent and the descent of the font of `cs` in CSS pixels. The page lays text out in device pixels, in which it rounds them to
 * whole pixels, hence they are measured at the size in device pixels of the current transform of `g`.
 */
function metrics(g: G, cs: CSSStyleDeclaration): [number, number] {
  const m = g.getTransform();
  const scale = Math.hypot(m.a, m.b) || 1;
  g.font = `${cs.fontStyle} ${cs.fontWeight} ${px(cs.fontSize) * scale}px ${cs.fontFamily}`;
  const t = g.measureText('Hg');
  return [Math.round(t.fontBoundingBoxAscent) / scale, Math.round(t.fontBoundingBoxDescent) / scale];
}

/**
 * A box snapped to whole device pixels, as the page paints a box, when the transform of `g` only scales and moves. Each edge goes
 * to the nearest device pixel.
 */
function snap(g: G, x: number, y: number, w: number, h: number): [number, number, number, number] {
  const m = g.getTransform();
  if (m.b !== 0 || m.c !== 0 || m.a === 0 || m.d === 0) return [x, y, w, h];
  const sx = (v: number) => (Math.round(v * m.a + m.e) - m.e) / m.a;
  const sy = (v: number) => (Math.round(v * m.d + m.f) - m.f) / m.d;
  return [sx(x), sy(y), sx(x + w) - sx(x), sy(y + h) - sy(y)];
}

/** A y coordinate snapped to a whole device pixel, as the page lays a text baseline, when the transform of `g` only scales and moves. */
function snapY(g: G, y: number): number {
  const m = g.getTransform();
  return m.b !== 0 || m.c !== 0 || m.d === 0 ? y : (Math.round(y * m.d + m.f) - m.f) / m.d;
}

/** The corner of the painted root on the page, and the page's scale of it, e.g. under a CSS transform of a slide. */
interface Origin {
  x: number;
  y: number;
  scale: number;
  /** The baseline of the first line of a text node, in the CSS pixels of the root, where a probe measured it. */
  baselines: Map<Text, number>;
}

/**
 * Paints `root` and its descendants, inside its open shadow root too, onto `g`. The transform of `g` maps the CSS pixels of the
 * root, from its top left corner, to the canvas.
 */
export function rasterize(g: G, root: HTMLElement): void {
  const r = root.getBoundingClientRect();
  const width = root.offsetWidth || r.width;
  const o: Origin = { x: r.left, y: r.top, scale: width > 0 ? r.width / width : 1, baselines: new Map() };
  const probes = new Map<Text, HTMLElement>();
  placeProbes(root, probes);
  try {
    for (const [n, p] of probes) o.baselines.set(n, local(o, p.getBoundingClientRect()).y);
    paintElement(g, root, o, null);
  } finally {
    for (const p of probes.values()) p.remove();
  }
}

/**
 * Puts an empty inline block before each text node of the tree outside a transform, since the top of an empty inline block lies on
 * the baseline of its line, which the DOM does not give otherwise. A text node in a flex or grid container is left out, since a
 * probe there would be an item of its own.
 */
function placeProbes(e: HTMLElement, probes: Map<Text, HTMLElement>): void {
  if (!e.checkVisibility()) return;
  const cs = getComputedStyle(e);
  if (turns(cs.transform)) return;
  const item = /flex|grid/.test(cs.display);
  for (const n of [...(e.shadowRoot ?? e).childNodes]) {
    if (n.nodeType === Node.TEXT_NODE && !item && (n as Text).data.trim() !== '') {
      const p = document.createElement('tycho-probe');
      p.style.cssText = 'display: inline-block; width: 0; height: 0; margin: 0; padding: 0; border: 0; vertical-align: baseline;';
      n.parentNode!.insertBefore(p, n);
      probes.set(n as Text, p);
    } else if (n instanceof HTMLElement && !(n instanceof HTMLStyleElement) && !(n instanceof HTMLScriptElement)) placeProbes(n, probes);
  }
}

/** A client rect in the CSS pixels of the root. */
function local(o: Origin, r: DOMRect): { x: number; y: number; w: number; h: number } {
  return { x: (r.left - o.x) / o.scale, y: (r.top - o.y) / o.scale, w: r.width / o.scale, h: r.height / o.scale };
}

/**
 * Paints one element. Outside a transform, the box of `e` is its client rect. Inside one, `at` is the corner of the offset parent of
 * `e` in the coordinates of the transformed ancestor, and its text is laid out as one line.
 */
function paintElement(g: G, e: HTMLElement, o: Origin, at: { x: number; y: number } | null): void {
  if (!e.checkVisibility()) return;
  const cs = getComputedStyle(e);
  const transformed = turns(cs.transform);
  let x: number;
  let y: number;
  let w: number;
  let h: number;
  g.save();
  if (at === null && !transformed) ({ x, y, w, h } = local(o, e.getBoundingClientRect()));
  else {
    // the layout box before the transform, placed from the offset parent, whose box is not transformed
    w = e.offsetWidth;
    h = e.offsetHeight;
    if (at !== null) [x, y] = [at.x + e.offsetLeft, at.y + e.offsetTop];
    else {
      const parent = e.offsetParent as HTMLElement | null;
      const p = parent === null ? { x: 0, y: 0 } : local(o, parent.getBoundingClientRect());
      const pcs = parent === null ? null : getComputedStyle(parent);
      x = p.x + e.offsetLeft + (pcs === null ? 0 : px(pcs.borderLeftWidth));
      y = p.y + e.offsetTop + (pcs === null ? 0 : px(pcs.borderTopWidth));
    }
    if (transformed) {
      const [ox, oy] = cs.transformOrigin.split(' ').map(px) as [number, number];
      const m = new DOMMatrix(cs.transform);
      g.translate(x + ox, y + oy);
      g.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      g.translate(-ox, -oy);
      [x, y] = [0, 0];
    }
  }
  const inside = transformed || at !== null;
  g.globalAlpha *= px(cs.opacity);
  if (!transformed) [x, y, w, h] = snap(g, x, y, w, h);
  if (e instanceof HTMLCanvasElement) {
    if (e.width > 0 && e.height > 0) g.drawImage(e, x, y, w, h);
  } else box(g, x, y, w, h, cs);
  if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
    const bl = px(cs.borderLeftWidth);
    const bt = px(cs.borderTopWidth);
    g.beginPath();
    g.rect(x + bl, y + bt, w - bl - px(cs.borderRightWidth), h - bt - px(cs.borderBottomWidth));
    g.clip();
  }
  pseudo(g, e, '::before', x, y, w, h, cs);
  for (const n of (e.shadowRoot ?? e).childNodes) {
    if (n.nodeType === Node.TEXT_NODE) text(g, n as Text, o, cs, inside ? { x, y } : null);
    else if (n instanceof HTMLElement && !(n instanceof HTMLStyleElement) && !(n instanceof HTMLScriptElement)) {
      paintElement(g, n, o, inside ? (n.offsetParent === e ? { x, y } : at) : null);
    }
  }
  pseudo(g, e, '::after', x, y, w, h, cs);
  g.restore();
}

/** Paints a text node. Inside a transform, `inside` is the corner of the parent's box, in which the text is one line. */
function text(g: G, n: Text, o: Origin, cs: CSSStyleDeclaration, inside: { x: number; y: number } | null): void {
  const s = n.data;
  if (s.trim() === '') return;
  const [a, d] = metrics(g, cs);
  if (inside !== null) {
    // the line box puts half the leading above the content area
    const lh = cs.lineHeight === 'normal' ? a + d : px(cs.lineHeight);
    run(g, s, inside.x + px(cs.paddingLeft) + px(cs.borderLeftWidth), inside.y + px(cs.paddingTop) + px(cs.borderTopWidth) + (lh - a - d) / 2 + a, cs);
    return;
  }
  // a line lies a probe's baseline below the top of the first line, or else, without a probe, one ascent below the top of its rect
  const range = document.createRange();
  range.selectNodeContents(n);
  const first = range.getClientRects()[0];
  if (first === undefined) return;
  const top = local(o, first).y;
  const probe = o.baselines.get(n);
  const base = (y: number) => (probe === undefined ? y + a : probe + y - top);
  const at = (i: number, j: number) => {
    range.setStart(n, i);
    range.setEnd(n, j);
    const r = range.getClientRects()[0];
    return r === undefined ? null : local(o, r);
  };
  if (/tabular-nums/.test(cs.fontVariantNumeric)) {
    // a canvas does not set tabular figures, hence each character goes where the page put it
    for (let i = 0; i < s.length; i++) {
      const l = /\s/.test(s[i]!) ? null : at(i, i + 1);
      if (l !== null) run(g, s[i]!, l.x, base(l.y), cs);
    }
    return;
  }
  range.selectNodeContents(n);
  const rects = [...range.getClientRects()];
  const lines = s.split('\n');
  if (rects.length === lines.length) {
    rects.forEach((r, i) => {
      const l = local(o, r);
      run(g, lines[i]!, l.x, base(l.y), cs);
    });
    return;
  }
  // a run that the page wrapped is laid out word by word
  let i = 0;
  for (const word of s.split(/(\s+)/)) {
    const l = word.trim() === '' ? null : at(i, i + word.length);
    if (l !== null) run(g, word, l.x, base(l.y), cs);
    i += word.length;
  }
}

/** Paints the absolutely positioned `::before` or `::after` box of `e`, without text, in the padding box of `e`. */
function pseudo(g: G, e: Element, which: '::before' | '::after', x: number, y: number, w: number, h: number, ecs: CSSStyleDeclaration): void {
  const cs = getComputedStyle(e, which);
  if (cs.content === 'none' || cs.content === 'normal' || cs.display === 'none' || cs.position !== 'absolute') return;
  const cx = x + px(ecs.borderLeftWidth);
  const cy = y + px(ecs.borderTopWidth);
  const cw = w - px(ecs.borderLeftWidth) - px(ecs.borderRightWidth);
  const ch = h - px(ecs.borderTopWidth) - px(ecs.borderBottomWidth);
  const ex = px(cs.borderLeftWidth) + px(cs.borderRightWidth) + px(cs.paddingLeft) + px(cs.paddingRight);
  const ey = px(cs.borderTopWidth) + px(cs.borderBottomWidth) + px(cs.paddingTop) + px(cs.paddingBottom);
  const auto = (v: string) => v === 'auto' || v === '';
  // an empty box of auto size shrinks to its borders and padding, unless both of its insets are set
  const span = (start: string, end: string, size: string, full: number, extra: number): [number, number] => {
    let inner = auto(size) ? (auto(start) || auto(end) ? 0 : full - px(start) - px(end) - extra) : px(size);
    if (cs.boxSizing === 'border-box' && !auto(size)) inner -= extra;
    const total = inner + extra;
    return [auto(start) ? (auto(end) ? 0 : full - px(end) - total) : px(start), total];
  };
  const [bx, bw] = span(cs.left, cs.right, cs.width, cw, ex);
  const [by, bh] = span(cs.top, cs.bottom, cs.height, ch, ey);
  g.save();
  g.globalAlpha *= px(cs.opacity);
  box(g, ...snap(g, cx + bx, cy + by, bw, bh), cs);
  g.restore();
}
