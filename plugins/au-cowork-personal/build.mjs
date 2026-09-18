import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

await rm(new URL('./dist/', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
const result = await build({
  entryPoints: [new URL('./src/server.mjs', import.meta.url).pathname],
  outfile: new URL('./dist/cowork-mcp.mjs', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: true,
  metafile: true,
  legalComments: 'linked',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" }
});

const packageName = (input) => {
  const tail = input.split('node_modules/').at(-1); if (tail === input) return null;
  const parts = tail.split('/'); return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
};
const bundledPackages = [...new Set(Object.keys(result.metafile.inputs).map(packageName).filter(Boolean))].sort();
const sections = [];
for (const name of bundledPackages) {
  const root = new URL(`./node_modules/${name}/`, import.meta.url);
  const license = await readFile(new URL('LICENSE', root), 'utf8').catch(() => readFile(new URL('LICENSE.md', root), 'utf8'));
  sections.push(`===== ${name} =====\n\n${license.trim()}`);
}
await writeFile(new URL('./dist/THIRD_PARTY_LICENSES.txt', import.meta.url), `${sections.join('\n\n')}\n`);
await writeFile(new URL('./dist/BUNDLED_PACKAGES.json', import.meta.url), `${JSON.stringify(bundledPackages, null, 2)}\n`);
