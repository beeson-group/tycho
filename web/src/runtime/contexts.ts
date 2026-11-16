// The WebGL contexts of the viewers on a page. Chrome keeps at most 16 contexts on a page, and when a further one is made, it loses
// the one used least recently for good. A viewer therefore makes its context only when it first draws, and the pool releases the
// contexts of the viewers that were shown least recently, once more than a budget of viewers hold one. A released viewer makes a
// new context when it draws again. A viewer that is shown keeps its context.

/** A holder of a WebGL context, i.e. the renderer of a viewer. */
export interface ContextHolder {
  /** Whether it holds a context that is not lost. */
  readonly live: boolean;
  /** Frees its context, which it makes again when it next draws. */
  release(): void;
  /** Asks it to draw again, e.g. when the pool has room for a context that it lost while it was shown. */
  onChange(): void;
}

export class ContextPool {
  /** The holders, from the one shown least recently to the one shown last, with whether each is shown now. */
  private readonly order: { holder: ContextHolder; shown: boolean }[] = [];

  /** The number of live contexts that the pool keeps, beyond which it releases the contexts of holders that are not shown. */
  readonly budget: number;

  constructor(budget: number) {
    this.budget = budget;
  }

  /** Notes that `holder` was shown or hidden, or made a context, just now, and settles the pool. */
  use(holder: ContextHolder, shown: boolean): void {
    this.forget(holder);
    this.order.push({ holder, shown });
    this.settle();
  }

  /**
   * Releases the contexts of the holders that were shown least recently and are not shown now, until at most `budget` holders hold a
   * live context, and asks every shown holder that lost its context to draw again once there is room. It runs when a holder is shown
   * or hidden, and when the browser takes a context or gives one back.
   */
  settle(): void {
    let live = this.order.filter((e) => e.holder.live).length;
    for (const e of [...this.order]) {
      if (live <= this.budget) break;
      if (e.shown || !e.holder.live) continue;
      e.holder.release();
      live--;
    }
    this.wake();
  }

  /**
   * Whether `holder`, which is shown and lost its context, may make a new one, i.e. whether fewer than `budget` other holders that
   * are shown hold a live context. When more viewers are shown than the browser keeps contexts, each new context would take the
   * context of another shown viewer, which would then take one back at its next draw.
   */
  room(holder: ContextHolder): boolean {
    return this.order.filter((e) => e.holder !== holder && e.shown && e.holder.live).length < this.budget;
  }

  /** Forgets `holder`, e.g. the renderer of a viewer that left the page. */
  drop(holder: ContextHolder): void {
    this.forget(holder);
    this.wake();
  }

  private forget(holder: ContextHolder): void {
    const i = this.order.findIndex((e) => e.holder === holder);
    if (i >= 0) this.order.splice(i, 1);
  }

  /** Asks every shown holder that lost its context to draw again, once there is room for a new one. */
  private wake(): void {
    for (const e of this.order) if (e.shown && !e.holder.live && this.room(e.holder)) e.holder.onChange();
  }
}

/**
 * The pool of the viewers on this page. It keeps half the contexts that Chrome allows, which leaves room for the other WebGL
 * contexts of a page, e.g. those of the slides template.
 */
export const viewerContexts = new ContextPool(8);
