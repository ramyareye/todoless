import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Bundle the real Worker and exercise HTTP + MCP against disposable local D1.
// Never load Wrangler configuration, .dev.vars, provider credentials, or remote bindings.
const require = createRequire(import.meta.resolve('wrangler/package.json'));
const { build } = require('esbuild');
const { Miniflare } = require('miniflare');
const apiRoot = fileURLToPath(new URL('../', import.meta.url));
const selected = new Set(Bun.argv.slice(2));
const candidate = selected.delete('--candidate');
if ([...selected].some((name) => !['test:api', 'smoke', 'validate'].includes(name))) {
  throw new Error('Optional suites: test:api smoke validate');
}
const output = candidate ? null : await build({
  absWorkingDir: apiRoot,
  entryPoints: ['src/index.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  external: ['node:*'],
  target: 'es2022'
});
let script = output?.outputFiles[0].text;
if (candidate) {
  const directory = resolve(apiRoot, '.dist/release-candidate');
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
  const artifact = manifest.artifacts.find((item: any) => item.name === 'api');
  const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
  script = await readFile(`${directory}/${artifact.file}`, 'utf8');
  if (sha256(script!) !== artifact.sha256) throw new Error('Candidate artifact drift');
  for (const input of artifact.inputs) {
    if (sha256(await readFile(resolve(apiRoot, '../..', input.path))) !== input.sha256) {
      throw new Error(`Candidate source drift: ${input.path}`);
    }
  }
}
const runtime = new Miniflare({
  modules: true,
  script,
  compatibilityDate: '2026-02-05',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'],
  d1Persist: false,
  host: '127.0.0.1',
  port: 0,
  bindings: {
    ENVIRONMENT: 'dev',
    API_KEY_PEPPER: 'synthetic-local-worker-test-pepper',
    APP_BASE_URL: 'http://127.0.0.1'
  },
  outboundService: () => new Response('Outbound requests disabled in local validation', { status: 503 })
});
try {
  const db = await runtime.getD1Database('DB');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(file, directory), 'utf8');
    await db.batch(
      sql
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((sql) => db.prepare(sql))
    );
  }
  const url = String(await runtime.ready).replace(/\/$/, '');
  for (const [cwd, script] of [
    [apiRoot, 'test:api'],
    [apiRoot, 'smoke'],
    [fileURLToPath(new URL('../../mcp-server/', import.meta.url)), 'validate']
  ]) {
    if (selected.size && !selected.has(script)) continue;
    const child = Bun.spawn(['bun', 'run', script], {
      cwd,
      env: { ...process.env, BASE_URL: url, TODOLESS_API_BASE_URL: url },
      stdout: 'inherit',
      stderr: 'inherit'
    });
    if ((await child.exited) !== 0) throw new Error(`${script} failed against the bundled local Worker`);
  }
  console.log('Selected bundled Worker checks passed. Disposable database only.');
} finally {
  await runtime.dispose();
}
