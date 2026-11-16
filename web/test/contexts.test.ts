// Tests the pool of the WebGL contexts of the viewers on a page with stand-ins for their renderers.
import { describe, expect, it } from 'vitest';
import { ContextPool, type ContextHolder } from '../src/runtime/contexts';

/** A stand-in for a renderer, which holds a live context until it is released, and counts the requests to draw again. */
class Holder implements ContextHolder {
  live = true;
  draws = 0;
  release(): void {
    this.live = false;
  }
  onChange(): void {
    this.draws++;
  }
}

/** `n` holders, each made live and shown, then hidden, in turn, as on a page scrolled from top to bottom. */
function scrolled(pool: ContextPool, n: number): Holder[] {
  const hs = Array.from({ length: n }, () => new Holder());
  for (const h of hs) {
    pool.use(h, true);
    pool.use(h, false);
  }
  return hs;
}

describe('the pool of WebGL contexts', () => {
  it('keeps every context while no more holders than its budget hold one', () => {
    const hs = scrolled(new ContextPool(3), 3);
    expect(hs.map((h) => h.live)).toEqual([true, true, true]);
  });

  it('releases the contexts of the holders shown least recently beyond its budget', () => {
    const pool = new ContextPool(3);
    const hs = scrolled(pool, 5);
    expect(hs.map((h) => h.live)).toEqual([false, false, true, true, true]);
    // the first holder is shown again and makes a new context, which releases the one shown longest ago
    hs[0]!.live = true;
    pool.use(hs[0]!, true);
    expect(hs.map((h) => h.live)).toEqual([true, false, false, true, true]);
  });

  it('keeps the context of a shown holder, also beyond its budget', () => {
    const pool = new ContextPool(2);
    const hs = Array.from({ length: 4 }, () => new Holder());
    for (const h of hs) pool.use(h, true);
    expect(hs.map((h) => h.live)).toEqual([true, true, true, true]);
    pool.use(hs[1]!, false);
    pool.use(hs[2]!, false);
    expect(hs.map((h) => h.live)).toEqual([true, false, false, true]);
  });

  it('asks a shown holder that lost its context to draw again once fewer than its budget of other shown holders hold one', () => {
    const pool = new ContextPool(2);
    const hs = Array.from({ length: 4 }, () => new Holder());
    for (const h of hs) pool.use(h, true);
    // the browser takes the context of the first holder, while the four are shown
    hs[0]!.live = false;
    expect(pool.room(hs[0]!)).toBe(false);
    pool.use(hs[3]!, false);
    expect(hs[3]!.live).toBe(false);
    expect(hs[0]!.draws).toBe(0);
    expect(pool.room(hs[0]!)).toBe(false);
    pool.use(hs[2]!, false);
    expect(hs[0]!.draws).toBe(1);
    expect(pool.room(hs[0]!)).toBe(true);
  });

  it('releases a context that the browser gave back to a holder that is not shown, once beyond its budget', () => {
    const pool = new ContextPool(2);
    const hs = scrolled(pool, 3);
    expect(hs.map((h) => h.live)).toEqual([false, true, true]);
    hs[0]!.live = true;
    pool.settle();
    expect(hs.map((h) => h.live)).toEqual([false, true, true]);
  });

  it('forgets a holder that left the page', () => {
    const pool = new ContextPool(1);
    const [a, b] = scrolled(pool, 2);
    expect([a!.live, b!.live]).toEqual([false, true]);
    pool.drop(b!);
    a!.live = true;
    pool.use(a!, false);
    expect([a!.live, b!.live]).toEqual([true, true]);
  });
});
