// Copies the repository's license files into web/ before npm packs it, since npm takes them
// only from the package root. With --clean, removes the copies again (the postpack script).
import { copyFileSync, rmSync } from 'node:fs';

const FILES = ['LICENSE', 'NOTICE', 'AUTHORS', 'THIRD_PARTY_NOTICES.md'];
const clean = process.argv.includes('--clean');

for (const name of FILES) {
  const target = new URL(`../${name}`, import.meta.url);
  if (clean) rmSync(target, { force: true });
  else copyFileSync(new URL(`../../${name}`, import.meta.url), target);
}
