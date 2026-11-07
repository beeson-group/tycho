// Writes the third-party notices of the runtime bundle. Without an argument, it prints the comment that heads
// tycho.js and tycho.esm.js (the build scripts pass it to esbuild's --banner:js), hence every page
// that pytycho writes names what it carries. With --check, it fails unless ../NOTICE and
// ../THIRD_PARTY_NOTICES.md name every bundled package at its installed version.
// The package list comes from the metafile of esbuild, thus a newly bundled package cannot be missed.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const own = JSON.parse(read('../package.json'));

async function bundled() {
  const { metafile } = await build({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    logLevel: 'silent',
  });
  const names = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (match) names.add(match[1]);
  }
  return [...names].sort().map((name) => {
    const pkg = JSON.parse(read(`../node_modules/${name}/package.json`));
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const source = (repo ?? pkg.homepage ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
    const copyright = read(`../node_modules/${name}/LICENSE`)
      .split('\n')
      .find((line) => /copyright/i.test(line))
      ?.trim()
      .replace(/\(c\)|©/gi, '')
      .replace(/\s+/g, ' ');
    return { name, version: pkg.version, license: pkg.license, source, copyright };
  });
}

const packages = await bundled();

if (process.argv.includes('--check')) {
  const notice = read('../../NOTICE');
  const fullTexts = read('../../THIRD_PARTY_NOTICES.md');
  const missing = packages.filter(({ name, version }) => {
    const label = name === 'three' ? 'three.js' : name;
    return !notice.includes(`${label} ${version}`) || !fullTexts.includes(`## ${label} ${version}`);
  });
  if (missing.length > 0) {
    console.error(`NOTICE or THIRD_PARTY_NOTICES.md is stale for: ${missing.map((p) => `${p.name} ${p.version}`).join(', ')}`);
    process.exit(1);
  }
} else {
  const lines = [
    `TyCHO runtime ${own.version}, Apache-2.0, https://github.com/beeson-group/tycho`,
    'This bundle contains:',
    ...packages.map((p) => `${p.name} ${p.version}, ${p.license}, ${p.copyright}, ${p.source}`),
    'Full license texts: https://github.com/beeson-group/tycho/blob/main/THIRD_PARTY_NOTICES.md',
  ];
  process.stdout.write(`/*! ${lines.join('\n * ')} */`);
}
