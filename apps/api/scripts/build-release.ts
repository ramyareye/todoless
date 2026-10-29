import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';

// Local compilation only. No Wrangler config, .dev.vars, remote reads or upload.
const apiRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(apiRoot, '../..');
const directory = resolve(apiRoot, '.dist/release-candidate');
const require = createRequire(import.meta.resolve('wrangler/package.json'));
const { build, version: esbuildVersion } = require('esbuild');
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
await mkdir(directory, { recursive: true });
const artifacts = [];
for (const [name, root, entry] of [
  ['api', apiRoot, 'src/index.ts'],
  ['recovery', apiRoot, 'src/recovery.ts'],
  ['mcp', resolve(repoRoot, 'apps/mcp-server'), 'src/worker.mjs']
]) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022', metafile: true, external: ['node:*']
  });
  const code = result.outputFiles[0].contents;
  const inputs = await Promise.all(Object.keys(result.metafile.inputs).sort().map(async (path) => ({
    path: relative(repoRoot, resolve(root, path)),
    sha256: sha256(await readFile(resolve(root, path)))
  })));
  await writeFile(resolve(directory, `${name}.mjs`), code);
  artifacts.push({ name, file: `${name}.mjs`, sha256: sha256(code), bytes: code.length, inputs });
}
await writeFile(resolve(directory, 'manifest.json'), JSON.stringify({
  format: 1, deployable: false, esbuild_version: esbuildVersion,
  note: 'Compiled local candidates only. Preserve live bindings/settings. No deploy configuration is generated.',
  artifacts
}, null, 2) + '\n');
console.log(JSON.stringify({ directory, artifacts: artifacts.map(({ inputs, ...artifact }) => artifact) }, null, 2));
