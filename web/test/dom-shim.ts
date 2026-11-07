// A small stand-in for the DOM, enough to build the viewer's controls (its chrome) under Node, since the project does not
// depend on jsdom or happy-dom. The stand-in does not lay out elements or bubble events: an event reaches only the element it
// is dispatched on, every box is empty, and every element has the size of the stage.

type Listener = (ev: any) => void;

export class FakeElement {
  readonly tagName: string;
  readonly namespaceURI: string | null;
  parentNode: FakeElement | null = null;
  readonly childNodes: FakeElement[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Listener[]>();
  private text = '';
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> & { setProperty(k: string, v: string): void } = Object.assign(Object.create(null), {
    setProperty(this: Record<string, string>, k: string, v: string) {
      this[k] = v;
    },
  });
  hidden = false;
  offsetTop = 0;
  offsetHeight = 0;
  offsetWidth = 0;
  clientWidth = 800;
  clientHeight = 500;
  // form properties are plain fields
  [key: string]: any;

  constructor(
    readonly doc: FakeDocument,
    tag: string,
    ns: string | null = null,
  ) {
    this.tagName = ns === null ? tag.toUpperCase() : tag;
    this.namespaceURI = ns;
  }

  get children(): FakeElement[] {
    return this.childNodes;
  }
  get className(): string {
    return this.attrs.get('class') ?? '';
  }
  set className(v: string) {
    this.attrs.set('class', v);
  }
  get id(): string {
    return this.attrs.get('id') ?? '';
  }
  set id(v: string) {
    this.attrs.set('id', v);
  }
  get title(): string {
    return this.attrs.get('title') ?? '';
  }
  set title(v: string) {
    this.attrs.set('title', v);
  }
  get tabIndex(): number {
    return Number(this.attrs.get('tabindex') ?? -1);
  }
  set tabIndex(v: number) {
    this.attrs.set('tabindex', String(v));
  }
  get classList() {
    const get = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const put = (s: Set<string>) => (this.className = [...s].join(' '));
    return {
      contains: (c: string) => get().has(c),
      add: (...cs: string[]) => put(new Set([...get(), ...cs])),
      remove: (...cs: string[]) => put(new Set([...get()].filter((x) => !cs.includes(x)))),
      toggle: (c: string, on?: boolean) => {
        const s = get();
        const want = on ?? !s.has(c);
        if (want) s.add(c);
        else s.delete(c);
        put(s);
        return want;
      },
    };
  }
  get textContent(): string {
    return this.childNodes.length > 0 ? this.childNodes.map((c) => c.textContent).join('') : this.text;
  }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes.length = 0;
    this.text = v;
  }
  get options(): FakeElement[] {
    return this.childNodes.filter((c) => c.tagName === 'OPTION');
  }
  private stored: string | undefined;
  /** A select without a set value takes the value of its first option, as in a browser. */
  get value(): string {
    return this.stored ?? (this.tagName === 'SELECT' ? (this.options[0]?.value ?? '') : '');
  }
  set value(v: string) {
    this.stored = String(v);
  }

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }

  appendChild<T extends FakeElement>(c: T): T {
    c.parentNode?.removeChild(c);
    this.text = '';
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  insertBefore<T extends FakeElement>(c: T, ref: FakeElement | null): T {
    c.parentNode?.removeChild(c);
    const i = ref === null ? -1 : this.childNodes.indexOf(ref);
    c.parentNode = this;
    if (i < 0) this.childNodes.push(c);
    else this.childNodes.splice(i, 0, c);
    return c;
  }
  removeChild(c: FakeElement): void {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
  }
  append(...cs: FakeElement[]): void {
    for (const c of cs) this.appendChild(c);
  }
  prepend(...cs: FakeElement[]): void {
    cs.reverse().forEach((c) => this.insertBefore(c, this.childNodes[0] ?? null));
  }
  replaceChildren(...cs: FakeElement[]): void {
    this.textContent = '';
    this.append(...cs);
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  contains(n: FakeElement | null): boolean {
    for (let x = n; x !== null; x = x.parentNode) if (x === this) return true;
    return false;
  }
  cloneNode(deep = false): FakeElement {
    const c = new FakeElement(this.doc, this.namespaceURI === null ? this.tagName.toLowerCase() : this.tagName, this.namespaceURI);
    for (const [k, v] of this.attrs) c.setAttribute(k, v);
    c.text = this.text;
    if (deep) for (const k of this.childNodes) c.appendChild(k.cloneNode(true));
    return c;
  }

  addEventListener(type: string, f: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]);
  }
  removeEventListener(type: string, f: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((g) => g !== f),
    );
  }
  dispatchEvent(ev: { type: string; [k: string]: unknown }): boolean {
    const e = { target: this, stopPropagation() {}, preventDefault() {}, composedPath: () => [this], ...ev };
    for (const f of this.listeners.get(ev.type) ?? []) f(e);
    return true;
  }
  click(): void {
    if (this.disabled !== true) this.dispatchEvent({ type: 'click' });
  }
  focus(): void {
    this.doc.activeElement = this;
  }
  setPointerCapture(): void {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }
}

export class FakeDocument {
  activeElement: FakeElement | null = null;
  readyState = 'complete';
  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
  createElementNS(ns: string, tag: string): FakeElement {
    return new FakeElement(this, tag, ns);
  }
}

/** Every element under `root`, depth first, `root` first. */
export function walk(root: FakeElement): FakeElement[] {
  return [root, ...root.childNodes.flatMap(walk)];
}

/** The elements under `root` whose class list holds every class of `cls`, a space-separated list. */
export function byClass(root: FakeElement, cls: string): FakeElement[] {
  const want = cls.split(' ');
  return walk(root).filter((e) => want.every((c) => e.classList.contains(c)));
}

export function byTag(root: FakeElement, tag: string): FakeElement[] {
  return walk(root).filter((e) => e.tagName.toLowerCase() === tag);
}

/** Installs the fake `document`, a minimal `window`, and an in-memory `localStorage`, and returns a function that takes them away. */
export function installDom(): { doc: FakeDocument; uninstall: () => void } {
  const g = globalThis as Record<string, unknown>;
  const names = ['document', 'window', 'cancelAnimationFrame', 'requestAnimationFrame', 'localStorage'];
  // the descriptors are saved, since reading the localStorage getter that Node defines prints a warning
  const saved = names.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  const doc = new FakeDocument();
  const stored = new Map<string, string>();
  Object.defineProperty(g, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, String(v)),
      removeItem: (k: string) => void stored.delete(k),
    },
  });
  const listeners = new FakeElement(doc, 'window');
  g.document = doc;
  g.window = {
    addEventListener: listeners.addEventListener.bind(listeners),
    removeEventListener: listeners.removeEventListener.bind(listeners),
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
  };
  g.cancelAnimationFrame = () => undefined;
  g.requestAnimationFrame = () => 0;
  return {
    doc,
    uninstall: () => {
      for (const [k, desc] of saved) {
        if (desc === undefined) delete g[k];
        else Object.defineProperty(g, k, desc);
      }
    },
  };
}
