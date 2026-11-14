import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** The rule names that the runtime raises, as the first argument of fail() or as the default of a parameter named rule. */
function runtimeRules(): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of sources(join(root, 'web/src'))) {
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/\bfail\(\s*'([^']+)'|\brule(?::\s*string)?\s*=\s*'([^']+)'/g)) found.set(m[1] ?? m[2]!, path.slice(root.length));
  }
  return found;
}

/** The rule names that the conformance corpus expects, from every rejections.json. */
function corpusRules(): Map<string, string> {
  const found = new Map<string, string>();
  const corpus = join(root, 'spec/conformance');
  for (const dir of readdirSync(corpus)) {
    const path = join(corpus, dir, 'rejections.json');
    let cases: { rule: string }[];
    try {
      cases = JSON.parse(readFileSync(path, 'utf8')) as { rule: string }[];
    } catch {
      continue;
    }
    for (const c of cases) found.set(c.rule, path.slice(root.length));
  }
  return found;
}

/** The rule names that the specification defines, each as a bullet that opens with the name in backticks and a full stop. */
function specRules(): Set<string> {
  const text = readFileSync(join(root, 'spec/tycho-scene.md'), 'utf8');
  return new Set([...text.matchAll(/^- `([^`]+)`\./gm)].map((m) => m[1]!));
}

describe('rule names', () => {
  const defined = specRules();
  it('defines in spec/tycho-scene.md every rule that the runtime raises', () => {
    expect(runtimeRules().size).toBeGreaterThan(30);
    expect([...runtimeRules()].filter(([name]) => !defined.has(name)).map(([name, file]) => `${name} (${file})`)).toEqual([]);
  });
  it('defines in spec/tycho-scene.md every rule that the conformance corpus expects', () => {
    expect(corpusRules().size).toBeGreaterThan(10);
    expect([...corpusRules()].filter(([name]) => !defined.has(name)).map(([name, file]) => `${name} (${file})`)).toEqual([]);
  });
});
