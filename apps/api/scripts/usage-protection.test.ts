import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import sourceApp from '../src/index';
import { API_BODY_LIMIT } from '../src/middleware/protection';
import { issueApiKey } from '../src/services/api-keys';
import { Hono } from 'hono';
import type { AppEnv } from '../src/lib/types';
import { queueWelcomeEmail, queueEmailVerificationEmail, queueInviteEmail } from '../src/services/email';
import sourceWorker from '../../mcp-server/src/worker.mjs';
import { MCP_BODY_LIMIT } from '../../mcp-server/src/protection.mjs';

const releaseName = process.env.TODOLESS_TEST_EXACT_RELEASE;
if (releaseName && !['usage-protection-2026-10-29','google-signup-2026-10-29'].includes(releaseName)) throw new Error('Unknown protection release');
const app = releaseName ? (await import(releaseName === 'google-signup-2026-10-29'
  ? '../.dist/google-signup-release-2026-10-29/api.mjs' : '../.dist/usage-protection-release-2026-10-29/api.mjs')).default : sourceApp;
const worker = releaseName ? (await import(releaseName === 'google-signup-2026-10-29'
  ? '../.dist/google-signup-release-2026-10-29/baseline-mcp.mjs' : '../.dist/usage-protection-release-2026-10-29/mcp.mjs')).default : sourceWorker;

const require = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare } = require('miniflare');
const runtime = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("synthetic")}}',
  d1Databases: ['DB'], d1Persist: false, host: '127.0.0.1', port: 0 });
let DB: D1Database;
const pepper = 'synthetic-protection-pepper';
let seq = 0;
const allow = { async limit() { return { success: true }; } };
const deny = { async limit() { return { success: false }; } };
const broken = { async limit() { throw new Error('private-provider-error'); } };
const env = () => ({ DB, ENVIRONMENT: 'dev', API_KEY_PEPPER: pepper, ABUSE_PROTECTION: 'on',
  REQUEST_RATE_LIMITER: allow, AUTH_RATE_LIMITER: allow, USER_RATE_LIMITER: allow });
beforeAll(async () => {
  DB = await runtime.getD1Database('DB');
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql')).sort()) {
    const sql = (await readFile(new URL(name, directory), 'utf8')).split(';').map(s => s.trim()).filter(Boolean);
    await DB.batch(sql.map(s => DB.prepare(s)));
  }
  await DB.batch([
    DB.prepare('CREATE TABLE synthetic_usage_writes(id INTEGER PRIMARY KEY, n INTEGER)'),
    DB.prepare('INSERT INTO synthetic_usage_writes VALUES(1,0)'),
    DB.prepare('CREATE TRIGGER synthetic_key_usage AFTER UPDATE OF last_used_at ON api_keys BEGIN UPDATE synthetic_usage_writes SET n=n+1 WHERE id=1; END')
  ]);
}, 20000);
afterAll(async () => { await runtime.dispose(); });

async function fixture() {
  const id = `usage_user_${++seq}`;
  await DB.prepare('INSERT INTO users(id,email,email_verified_at) VALUES(?,?,CURRENT_TIMESTAMP)').bind(id, `${id}@example.test`).run();
  const keys = [];
  for (let i = 0; i < 2; i++) {
    const key = await issueApiKey({ DB, API_KEY_PEPPER: pepper }, { name: 'Synthetic protection key', scopes: ['*'] });
    await DB.prepare('INSERT INTO api_keys(id,created_by_user_id,name,key_prefix,key_hash,scopes_json) VALUES(?,?,?,?,?,?)')
      .bind(key.id, id, key.name, key.keyPrefix, key.keyHash, '["*"]').run();
    keys.push(key);
  }
  return { id, keys };
}
async function api(path: string, options: { key?: string; body?: BodyInit; headers?: Record<string, string>; overrides?: Record<string, unknown>; method?: string } = {}) {
  const pending: Promise<unknown>[] = [];
  const response = await app.request('https://tasks.example.test' + path, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'), body: options.body,
    headers: { 'cf-connecting-ip': '198.51.100.1', ...(options.key ? { authorization: `Bearer ${options.key}` } : {}), ...options.headers },
    ...(options.body instanceof ReadableStream ? { duplex: 'half' } : {})
  }, { ...env(), ...options.overrides }, { waitUntil(p) { pending.push(p); }, passThroughOnException() {} });
  await Promise.all(pending);
  return { response, pending: pending.length, status: response.status, text: await response.text() };
}
const writes = async () => Number((await DB.prepare('SELECT n FROM synthetic_usage_writes WHERE id=1').first())!.n);

test('API rejects declared oversized bodies before touching D1', async () => {
  let touched = false;
  const r = await api('/v1/auth/register', { body: '{}', headers: { 'content-type': 'application/json', 'content-length': String(API_BODY_LIMIT + 1) },
    overrides: { DB: { prepare() { touched = true; throw Error('Must not query'); } } } });
  expect(r.status).toBe(413); expect(touched).toBe(false); expect(r.response.headers.get('cache-control')).toBe('no-store');
});
test('API caps actual streamed bytes despite a small Content-Length and cancels input', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(API_BODY_LIMIT)); c.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  const r = await api('/unknown', { body: stream, headers: { 'content-length': '1' } });
  expect(r.status).toBe(413); expect(cancelled).toBe(true);
});
test('API permits the exact byte boundary and counts multi-byte data as bytes', async () => {
  expect((await api('/unknown', { body: 'x'.repeat(API_BODY_LIMIT) })).status).toBe(404);
  expect((await api('/unknown', { body: '€'.repeat(Math.ceil(API_BODY_LIMIT / 3)) })).status).toBe(413);
});
test('API handles unreadable streams without leaking their error message', async () => {
  const r = await api('/unknown', { body: new ReadableStream({ start(c) { c.error(Error('private-stream-secret')); } }) });
  expect(r.status).toBe(400); expect(r.text).not.toContain('private-stream-secret');
});
test('API protects anonymous requests before database lookup and returns retry guidance', async () => {
  let reads = 0;
  const r = await api('/v1/me', { key: 'private-credential', overrides: { REQUEST_RATE_LIMITER: deny, DB: { prepare() { reads++; throw Error(); } } } });
  expect(r.status).toBe(429); expect(reads).toBe(0); expect(r.response.headers.get('retry-after')).toBe('60');
  expect(r.response.headers.get('x-request-id')).toStartWith('req_'); expect(r.text).not.toContain('private-credential');
});
test('API uses only Cloudflare client IP, never caller forwarded headers, and bounded auth families', async () => {
  const seen: string[] = [], limiter = { async limit(v: { key: string }) { seen.push(v.key); return { success: true }; } };
  await api('/v1/auth/key-recovery/attacker-path', { headers: { 'x-forwarded-for': 'attacker' }, overrides: { REQUEST_RATE_LIMITER: limiter, AUTH_RATE_LIMITER: limiter } });
  expect(seen).toEqual(['ip:198.51.100.1', 'recovery:198.51.100.1']);
});
test('API keeps health and CORS probes independent of broken limiter bindings', async () => {
  expect((await api('/v1/health', { overrides: { REQUEST_RATE_LIMITER: broken } })).status).toBe(200);
  expect((await api('/unknown', { method: 'OPTIONS', overrides: { REQUEST_RATE_LIMITER: broken } })).status).not.toBe(503);
});
test('Enabled API protection fails closed for unavailable/missing bindings', async () => {
  for (const limiter of [undefined, broken]) {
    const r = await api('/v1/me', { overrides: { REQUEST_RATE_LIMITER: limiter } });
    expect(r.status).toBe(503); expect(r.text).not.toContain('private-provider-error');
  }
});
test('Anonymous auth quota rejects before registration or recovery writes', async () => {
  let reads = 0;
  const r = await api('/v1/auth/key-recovery/request', { body: '{"email":"never@example.test"}', headers: { 'content-type': 'application/json' },
    overrides: { AUTH_RATE_LIMITER: deny, DB: { prepare() { reads++; throw Error(); } } } });
  expect(r.status).toBe(429); expect(reads).toBe(0);
});
test('Per-person quota follows the user across rotated keys and does not mix users', async () => {
  const a = await fixture(), b = await fixture(), seen: string[] = [];
  const limiter = { async limit(v: { key: string }) { seen.push(v.key); return { success: true }; } };
  for (const key of [a.keys[0], a.keys[1], b.keys[0]]) expect((await api('/v1/me', { key: key.raw, overrides: { USER_RATE_LIMITER: limiter } })).status).toBe(200);
  expect(seen).toEqual([`user:${a.id}`, `user:${a.id}`, `user:${b.id}`]);
});
test('User quota rejects before business writes and usage telemetry; key revocation remains reachable', async () => {
  const f = await fixture();
  const r = await api('/v1/workspaces', { key: f.keys[0].raw, body: '{}', headers: { 'content-type': 'application/json' }, overrides: { USER_RATE_LIMITER: deny } });
  expect(r.status).toBe(429); expect(r.pending).toBe(0);
  const revoke = await api(`/v1/api-keys/${f.keys[1].id}/revoke`, { key: f.keys[0].raw, method: 'POST', overrides: { USER_RATE_LIMITER: deny } });
  expect(revoke.status).toBe(200);
});
test('Missing user limiter fails closed without converting invalid credentials into an identity', async () => {
  const f = await fixture();
  expect((await api('/v1/me', { key: f.keys[0].raw, overrides: { USER_RATE_LIMITER: undefined } })).status).toBe(503);
  expect((await api('/v1/me', { key: 'bad', overrides: { USER_RATE_LIMITER: undefined } })).status).toBe(401);
});
test('Repeated reads write key usage once per coarse interval; concurrent stale reads have one database write', async () => {
  const f = await fixture(), count = await writes();
  const first = await Promise.all(Array.from({ length: 12 }, () => api('/v1/me', { key: f.keys[0].raw })));
  expect(first.every(r => r.status === 200)).toBe(true); expect(await writes()).toBe(count + 1);
  const repeat = await Promise.all(Array.from({ length: 12 }, () => api('/v1/me', { key: f.keys[0].raw })));
  expect(repeat.every(r => r.pending === 0)).toBe(true); expect(await writes()).toBe(count + 1);
  await DB.prepare("UPDATE api_keys SET last_used_at=datetime('now','-6 minutes') WHERE id=?").bind(f.keys[0].id).run();
  const expiredCount = await writes();
  expect((await api('/v1/me', { key: f.keys[0].raw })).status).toBe(200); expect(await writes()).toBe(expiredCount + 1);
});
test('Recent usage never caches credential revocation/expiry or unverified identity', async () => {
  const f = await fixture(); await api('/v1/me', { key: f.keys[0].raw });
  await DB.prepare('UPDATE api_keys SET revoked_at=CURRENT_TIMESTAMP WHERE id=?').bind(f.keys[0].id).run();
  expect((await api('/v1/me', { key: f.keys[0].raw })).status).toBe(401);
  await DB.prepare("UPDATE api_keys SET expires_at=datetime('now','-1 minute') WHERE id=?").bind(f.keys[1].id).run();
  expect((await api('/v1/me', { key: f.keys[1].raw })).status).toBe(401);
});
test('Invalid timestamps are repaired; telemetry failure cannot change successful authentication', async () => {
  const f = await fixture();
  await DB.prepare("UPDATE api_keys SET last_used_at='invalid' WHERE id=?").bind(f.keys[0].id).run();
  expect((await api('/v1/me', { key: f.keys[0].raw })).status).toBe(200);
  expect((await DB.prepare('SELECT last_used_at FROM api_keys WHERE id=?').bind(f.keys[0].id).first())!.last_used_at).not.toBe('invalid');
  const db = { prepare(sql: string) { if (sql.startsWith('UPDATE api_keys SET last_used_at')) return { bind() { return { async run() { throw Error('private-telemetry-secret'); } }; } }; return DB.prepare(sql); } };
  expect((await api('/v1/me', { key: f.keys[1].raw, overrides: { DB: db } })).status).toBe(200);
});
test('Protection/unhandled-error logs and responses contain no URL, credential, email, body or exception text', async () => {
  const logs: string[] = [], warn = console.warn, err = console.error, random = Math.random;
  Math.random = () => 0;
  console.warn = (...v) => { logs.push(v.join(' ')); }; console.error = (...v) => { logs.push(v.join(' ')); };
  try {
    await api('/v1/me?token=private-proof', { key: 'private-key', overrides: { REQUEST_RATE_LIMITER: deny } });
    await api('/v1/auth/register?email=private@example.test', { body: '{"email":"private@example.test"}', headers: { 'content-type': 'application/json' },
      overrides: { DB: { prepare() { throw Error('private-SQL-proof'); } } } });
    expect(logs.length).toBe(2);
    const text = logs.join(' ');
    for (const secret of ['private-proof', 'private-key', 'private@example.test', 'private-SQL-proof', '198.51.100.1']) expect(text).not.toContain(secret);
    expect(logs.map(l => JSON.parse(l).event)).toEqual(['request_rate_limited', 'unhandled_error']);
  } finally { console.warn = warn; console.error = err; Math.random = random; }
});

test('MCP body limits cover declared and streamed bytes before SDK or upstream work', async () => {
  let calls = 0;
  const upstream = { fetch() { calls++; throw Error('Must not reach upstream'); } };
  for (const headers of [{ 'content-length': String(MCP_BODY_LIMIT + 1) }, { 'content-length': '1' }, {}]) {
    const response = await worker.fetch(new Request('https://mcp.example.test/mcp', { method: 'POST',
      headers: { authorization: 'Bearer private-key', ...headers }, body: 'x'.repeat(MCP_BODY_LIMIT + 1) }), { TODOLESS_API: upstream });
    expect(response.status).toBe(413); expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.text()).not.toContain('private-key');
  }
  expect(calls).toBe(0);
});

test('Noisy rejections may be sampled out while unhandled failures remain visible', async () => {
  const logs: string[] = [], warn = console.warn, err = console.error, random = Math.random;
  Math.random = () => 0.99; console.warn = (...v) => { logs.push(v.join(' ')); }; console.error = (...v) => { logs.push(v.join(' ')); };
  try {
    expect((await api('/v1/me', { overrides: { REQUEST_RATE_LIMITER: deny } })).status).toBe(429);
    expect(logs).toHaveLength(0);
    expect((await api('/v1/auth/register', { body: '{"email":"synthetic@example.test"}', headers: { 'content-type': 'application/json' },
      overrides: { DB: { prepare() { throw Error('private-error'); } } } })).status).toBe(500);
    expect(logs).toHaveLength(1); expect(JSON.parse(logs[0]).event).toBe('unhandled_error');
  } finally { Math.random = random; console.warn = warn; console.error = err; }
});
test('Email delivery failures never log a provider body that echoes private proof or recipient data', async () => {
  const logs: string[] = [], original = globalThis.fetch, originalError = console.error, pending: Promise<unknown>[] = [];
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return new Response('private-provider-proof private@example.test', { status: 502 }); }) as typeof fetch;
  console.error = (...v) => { logs.push(v.join(' ')); };
  try {
    const mail = new Hono<AppEnv>();
    mail.post('/send', c => {
      const email = 'private@example.test', proof = 'https://tasks.example.test/?token=private-provider-proof';
      queueWelcomeEmail(c, { email, workspaceName: 'Synthetic' });
      queueEmailVerificationEmail(c, { email, verificationUrl: proof, expiresAt: new Date(Date.now() + 10000).toISOString() });
      queueInviteEmail(c, { email, workspaceName: 'Synthetic', inviterEmail: email, inviteUrl: proof });
      return c.json({ ok: true });
    });
    expect((await mail.request('/send', { method: 'POST' }, { ...env(), APP_BASE_URL: 'https://tasks.example.test',
      RESEND_API_KEY: 'synthetic-provider-key', RESEND_FROM_EMAIL: 'synthetic@example.test' },
      { waitUntil(p) { pending.push(p); }, passThroughOnException() {} })).status).toBe(200);
    await Promise.all(pending);
    expect(sends).toBe(3); expect(logs).toHaveLength(3);
    expect(logs.join(' ')).not.toContain('private');
  } finally { globalThis.fetch = original; console.error = originalError; }
});
test('MCP burst rejection and limiter failure have bounded private CORS responses and no upstream calls', async () => {
  for (const [limiter, status] of [[deny, 429], [broken, 503], [undefined, 503]] as const) {
    const r = await worker.fetch(new Request('https://mcp.example.test/mcp?token=private-proof', { method: 'POST', body: '{}' }),
      { ABUSE_PROTECTION: 'on', REQUEST_RATE_LIMITER: limiter, TODOLESS_API: { fetch() { throw Error('Must not reach upstream'); } } });
    expect(r.status).toBe(status); expect(r.headers.get('retry-after')).toBe('60');
    expect(r.headers.get('cache-control')).toBe('no-store'); expect(await r.text()).not.toContain('private-proof');
  }
});
test('MCP simple health/preflight still work; upstream probes are limited', async () => {
  const e = { ABUSE_PROTECTION: 'on', REQUEST_RATE_LIMITER: deny };
  expect((await worker.fetch(new Request('https://mcp.example.test/health'), e)).status).toBe(200);
  expect((await worker.fetch(new Request('https://mcp.example.test/mcp', { method: 'OPTIONS' }), e)).status).toBe(204);
  expect((await worker.fetch(new Request('https://mcp.example.test/health?probe=1'), e)).status).toBe(429);
});
test('Normal MCP initialization survives bounded-body reconstruction and native protection shape', async () => {
  const r = await worker.fetch(new Request('https://mcp.example.test/mcp', { method: 'POST',
    headers: { authorization: 'Bearer synthetic-key', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } })
  }), { ABUSE_PROTECTION: 'on', REQUEST_RATE_LIMITER: allow });
  expect(r.status).toBe(200); expect(await r.text()).toContain('protocolVersion');
});
