/**
 * The one error type a reader throws. `rule` is the name of the rule of spec/tycho-scene.md that the
 * input breaks, such as `array-keys`, `transform-channels`, or the section-level rule `frame`.
 */
export class TychoError extends Error {
  readonly rule: string;

  constructor(rule: string, message: string) {
    super(`[${rule}] ${message}`);
    this.name = 'TychoError';
    this.rule = rule;
  }
}

export function fail(rule: string, message: string): never {
  throw new TychoError(rule, message);
}
