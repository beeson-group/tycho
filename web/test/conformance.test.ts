// Runs every case of spec/conformance/*/cases.json, compared as described in spec/conformance/README.md.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Container } from '../src/container';
import { TychoError } from '../src/errors';
import { evaluate } from '../src/evaluate/index';
import type { Scene, State } from '../src/scene';
import { validate } from '../src/validate';

const ROOT = fileURLToPath(new URL('../../spec/conformance/', import.meta.url));

interface Case {
  name: string;
  source: string;
  state: State;
  frame_index: number;
  tolerance: number;
  expected: { panels: Record<string, unknown> };
}

interface Rejection {
  name: string;
  rule: string;
  scene?: Record<string, unknown>;
  state?: State;
  frame_index?: number;
}

/** A deep merge of `patch` into a copy of `base`, where an object is merged recursively, a null deletes the key, and any other value replaces it. */
function merge(base: unknown, patch: unknown): unknown {
  if (base === null || typeof base !== 'object' || Array.isArray(base) || patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete out[k];
    else out[k] = merge(out[k], v);
  }
  return out;
}

/** The differences between `actual` and `expected`, as paths. Numbers must agree within `tol`, and every other value must be equal. */
export function compare(actual: unknown, expected: unknown, tol: number, path = '$', out: string[] = []): string[] {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !(Math.abs(actual - expected) <= tol)) out.push(`${path}: ${String(actual)} != ${expected}`);
  } else if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      out.push(`${path}: length ${Array.isArray(actual) ? actual.length : 'not a list'} != ${expected.length}`);
    } else expected.forEach((e, i) => compare(actual[i], e, tol, `${path}[${i}]`, out));
  } else if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) out.push(`${path}: not an object`);
    else {
      const a = actual as Record<string, unknown>;
      const e = expected as Record<string, unknown>;
      const keys = new Set([...Object.keys(a), ...Object.keys(e)]);
      for (const k of keys) {
        if (!(k in e)) out.push(`${path}.${k}: unexpected`);
        else if (!(k in a)) out.push(`${path}.${k}: missing`);
        else compare(a[k], e[k], tol, `${path}.${k}`, out);
      }
    }
  } else if (actual !== expected) out.push(`${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  return out;
}

/** Compares only the panels a case lists, and skips layers written as null. */
function compareCase(actual: { panels: Record<string, unknown> }, expected: Case['expected'], tol: number): string[] {
  const out: string[] = [];
  for (const [pid, ep] of Object.entries(expected.panels)) {
    const ap = actual.panels[pid] as { frame: unknown; layers: unknown[] } | undefined;
    if (ap === undefined) {
      out.push(`$.panels.${pid}: missing`);
      continue;
    }
    const e = ep as { frame: unknown; layers: unknown[] } & Record<string, unknown>;
    for (const k of Object.keys(e)) if (k !== 'layers') compare((ap as Record<string, unknown>)[k], e[k], tol, `$.panels.${pid}.${k}`, out);
    if (e.layers === undefined) continue;
    if (ap.layers.length !== e.layers.length) out.push(`$.panels.${pid}.layers: length ${ap.layers.length} != ${e.layers.length}`);
    else e.layers.forEach((el, i) => el !== null && compare(ap.layers[i], el, tol, `$.panels.${pid}.layers[${i}]`, out));
  }
  return out;
}

const dirs = existsSync(ROOT)
  ? readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(ROOT, d.name, 'cases.json')))
      .map((d) => d.name)
      .sort()
  : [];

describe('conformance corpus', () => {
  if (dirs.length === 0) {
    it.skip(`the conformance cases are missing, since ${ROOT} does not hold a <scene>/cases.json directory`, () => {});
    return;
  }
  for (const dir of dirs) {
    describe(dir, () => {
      const base = join(ROOT, dir);
      const cases = JSON.parse(readFileSync(join(base, 'cases.json'), 'utf8')) as Case[];
      const load = async () => ({
        scene: JSON.parse(readFileSync(join(base, 'scene.tys'), 'utf8')) as Scene,
        data: await Container.parse(new Uint8Array(readFileSync(join(base, 'data.tyd')))),
      });
      for (const c of cases) {
        it(`${c.name} (${c.source})`, async () => {
          const { scene, data } = await load();
          validate(scene, data, c.state);
          const actual = evaluate(scene, data, c.state, c.frame_index);
          expect(compareCase(actual as unknown as { panels: Record<string, unknown> }, c.expected, c.tolerance)).toEqual([]);
        });
      }
      const rejectionsPath = join(base, 'rejections.json');
      if (existsSync(rejectionsPath)) {
        for (const r of JSON.parse(readFileSync(rejectionsPath, 'utf8')) as Rejection[]) {
          it(`rejects: ${r.name}`, async () => {
            const { scene: original, data } = await load();
            const scene = merge(original, r.scene ?? {}) as Scene;
            const state = r.state ?? scene.initial;
            let rule = 'no error';
            try {
              validate(scene, data, state);
              evaluate(scene, data, state, r.frame_index ?? 0);
            } catch (e) {
              if (!(e instanceof TychoError)) throw e;
              rule = e.rule;
            }
            expect(rule).toBe(r.rule);
          });
        }
      }
    });
  }
});
