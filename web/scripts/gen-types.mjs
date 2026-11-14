// Generates src/scene.gen.ts from spec/scene.schema.json. Run with `npm run gen:types`.
// test/scene-types.test.ts calls generate() and compares the output with the committed file.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const SCHEMA_PATH = here('../../spec/scene.schema.json');
export const OUTPUT_PATH = here('../src/scene.gen.ts');

const BANNER = `/**
 * Types for scene.tys, generated from spec/scene.schema.json by scripts/gen-types.mjs.
 * Do not edit. Run \`npm run gen:types\` after changing the schema.
 */`;

const pascal = (s) => s.replace(/(^|[_-])([a-z])/g, (_, __, c) => c.toUpperCase());

/** Returns the TypeScript source for the scene schema. */
export async function generate() {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
  // Name every $defs entry after its key, so that renaming a title cannot rename a type.
  for (const [key, def] of Object.entries(schema.$defs)) def.title = pascal(key);
  // A $ref with a sibling description would become a numbered copy of its type, hence it is written as the
  // name of the type, and the description becomes the doc comment of the property.
  const named = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (typeof node.$ref === 'string' && node.description !== undefined) {
      node.tsType = pascal(node.$ref.replace('#/$defs/', ''));
      delete node.$ref;
    }
    Object.values(node).forEach(named);
  };
  named(schema);
  schema.title = 'Scene';
  return compile(schema, 'Scene', {
    bannerComment: BANNER,
    additionalProperties: false,
    strictIndexSignatures: true,
    unreachableDefinitions: true,
    unknownAny: true,
    style: { singleQuote: true, printWidth: 100 },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await writeFile(OUTPUT_PATH, await generate());
}
