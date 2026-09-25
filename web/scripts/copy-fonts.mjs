// Self-host the reading and display fonts from their fontsource packages, with their OFL texts.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dest = fileURLToPath(new URL('../public/fonts/', import.meta.url));
mkdirSync(dest, { recursive: true });

const packages = [
  { name: '@fontsource/barlow-condensed', files: ['barlow-condensed-latin-600-normal.woff2', 'barlow-condensed-latin-700-normal.woff2', 'barlow-condensed-latin-ext-600-normal.woff2', 'barlow-condensed-latin-ext-700-normal.woff2'], license: 'OFL-barlow-condensed.txt' },
  { name: '@fontsource/atkinson-hyperlegible', files: ['atkinson-hyperlegible-latin-400-normal.woff2', 'atkinson-hyperlegible-latin-700-normal.woff2', 'atkinson-hyperlegible-latin-ext-400-normal.woff2', 'atkinson-hyperlegible-latin-ext-700-normal.woff2'], license: 'OFL-atkinson-hyperlegible.txt' },
];

for (const pkg of packages) {
  const root = path.dirname(require.resolve(`${pkg.name}/package.json`));
  const filesDir = path.join(root, 'files');
  for (const file of pkg.files) {
    const src = path.join(filesDir, file);
    if (!existsSync(src)) throw new Error(`Missing font file ${src}`);
    copyFileSync(src, path.join(dest, file));
  }
  const license = readdirSync(root).find((f) => /^LICENSE/i.test(f));
  if (!license) throw new Error(`Missing license in ${pkg.name}`);
  copyFileSync(path.join(root, license), path.join(dest, pkg.license));
}
console.log(`fonts copied to ${dest}`);
