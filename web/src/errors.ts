/**
 * The one error type a reader throws. `rule` is the rule of spec/tycho-scene.md that the
 * input breaks (`D2`, `F5`, ...), or the section number for a requirement stated without a
 * rule number (`2.3`).
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
