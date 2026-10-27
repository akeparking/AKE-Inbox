import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// One maintained source; WordPress keeps ordinary files for direct installation.
for (const name of ['collector.js', 'consent.js']) {
  const source = new URL(`../deploy/marketing/${name}`, import.meta.url);
  const target = new URL(`../deploy/marketing/wordpress/${name}`, import.meta.url);
  const expected = await readFile(source);
  if (process.argv.includes('--check')) {
    if (!(await readFile(target)).equals(expected)) {
      throw new Error(`${fileURLToPath(target).split('/').slice(-4).join('/')} differs; run npm run sync:marketing-assets`);
    }
  } else {
    await writeFile(target, expected);
  }
}
