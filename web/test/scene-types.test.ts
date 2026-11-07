import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { generate, OUTPUT_PATH, SCHEMA_PATH } from '../scripts/gen-types.mjs';
import { baseScene, MemoryStore, state } from './helpers';

describe('scene types', () => {
  it('src/scene.gen.ts matches the types generated from the schema', async () => {
    expect(readFileSync(OUTPUT_PATH, 'utf8')).toBe(await generate());
  });
  it('the test fixture scene satisfies the schema', () => {
    const ajv = new Ajv2020({ strict: false });
    const check = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
    expect(check(baseScene()), JSON.stringify(check.errors)).toBe(true);
  });
});
