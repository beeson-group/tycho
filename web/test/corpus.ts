// Loads the scenes of spec/conformance for the runtime tests. Their containers are parsed once, on
// import, since parsing is asynchronous, and every load of a scene shares its container.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Container } from '../src/container';
import type { Scene, State } from '../src/scene';

const ROOT = fileURLToPath(new URL('../../spec/conformance/', import.meta.url));

export interface CorpusScene {
  name: string;
  text: string;
  scene: Scene;
  data: Container;
  cases: { name: string; state: State; frame_index: number }[];
}

export const corpusNames = (): string[] =>
  existsSync(ROOT)
    ? readdirSync(ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(ROOT, d.name, 'scene.tys')))
        .map((d) => d.name)
        .sort()
    : [];

const containers = new Map(
  await Promise.all(corpusNames().map(async (name) => [name, await Container.parse(new Uint8Array(readFileSync(join(ROOT, name, 'data.tyd'))))] as const)),
);

export function loadCorpus(name: string): CorpusScene {
  const base = join(ROOT, name);
  const text = readFileSync(join(base, 'scene.tys'), 'utf8');
  const casesPath = join(base, 'cases.json');
  const data = containers.get(name);
  if (data === undefined) throw new Error(`no conformance scene ${name}`);
  return {
    name,
    text,
    scene: JSON.parse(text) as Scene,
    data,
    cases: existsSync(casesPath) ? JSON.parse(readFileSync(casesPath, 'utf8')) : [],
  };
}
