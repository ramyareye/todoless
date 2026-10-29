import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import sourceApp from '../src/index';
import { issueApiKey } from '../src/services/api-keys';
import { issueRecoveryToken } from '../src/services/key-recovery';

const releaseName = process.env.TODOLESS_TEST_EXACT_RELEASE;
if (releaseName && !['key-recovery-2026-10-28', 'usage-protection-2026-10-29', 'google-signup-2026-10-29'].includes(releaseName)) throw new Error('Unknown recovery release');
const releaseDirectory = releaseName === 'google-signup-2026-10-29' ? 'google-signup-release-2026-10-29'
  : releaseName === 'usage-protection-2026-10-29' ? 'usage-protection-release-2026-10-29' : 'key-recovery-release-2026-10-28';
const app = releaseName ? (await import(`../.dist/${releaseDirectory}/api.mjs`)).default : sourceApp;
const allow = { async limit() { return { success: true }; } };
const protectionEnv = ['usage-protection-2026-10-29', 'google-signup-2026-10-29'].includes(releaseName ?? '') ? { ABUSE_PROTECTION: 'on',
  REQUEST_RATE_LIMITER: allow, AUTH_RATE_LIMITER: allow, USER_RATE_LIMITER: allow } : {};

const require = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare } = require('miniflare');
const runtime = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("synthetic recovery DB")}}',
  d1Databases: ['DB'], d1Persist: false, host: '127.0.0.1', port: 0 });
let DB: D1Database;
const pepper = 'synthetic-key-recovery-test-only';
const env = { API_KEY_PEPPER: pepper, ENVIRONMENT: 'prod', APP_BASE_URL: 'https://tasks.example.test',
  ...protectionEnv,
  RESEND_API_KEY: 'synthetic-not-a-provider-key', RESEND_FROM_EMAIL: 'test@example.test' };
const sent: { to: string[]; subject: string; text: string; html: string }[] = [];
const originalFetch = globalThis.fetch;
let deliveryFailure = false, sequence = 0, legacy: unknown;
const businessTables = ['users', 'workspaces', 'memberships', 'projects', 'tasks', 'task_history', 'project_history',
  'member_project_access', 'time_settings', 'time_terms', 'time_weeks', 'time_events'];
const business = async () => Object.fromEntries(await Promise.all(businessTables.map(async name =>
  [name, (await DB.prepare(`SELECT * FROM ${name}`).all()).results])));
beforeAll(async () => {
  DB = await runtime.getD1Database('DB');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(f => f.endsWith('.sql')).sort()) {
    if (file === '0011_key_recovery.sql') {
      await DB.batch([
        DB.prepare("INSERT INTO users(id,email,email_verified_at) VALUES('legacy_recover','legacy@example.test',CURRENT_TIMESTAMP)"),
        DB.prepare("INSERT INTO workspaces(id,slug,name,created_by_user_id) VALUES('legacy_ws','legacy-recovery','Existing work','legacy_recover')"),
        DB.prepare("INSERT INTO memberships(id,workspace_id,user_id,role) VALUES('legacy_mem','legacy_ws','legacy_recover','OWNER')"),
        DB.prepare("INSERT INTO projects(id,workspace_id,name) VALUES('legacy_prj','legacy_ws','Existing project')"),
        DB.prepare("INSERT INTO tasks(id,workspace_id,project_id,title,version,metadata_json) VALUES('legacy_task','legacy_ws','legacy_prj','Keep existing task',7,'{\"external_id\":\"VE-A05\"}')"),
        DB.prepare("INSERT INTO task_history(id,workspace_id,task_id,change_type,change_reason) VALUES('legacy_h','legacy_ws','legacy_task','UPDATED','manual')"),
        DB.prepare("INSERT INTO time_weeks(id,workspace_id,user_id,week_start_date,timezone,week_start,version,state,document_json) VALUES('legacy_week','legacy_ws','legacy_recover','2026-10-19','Europe/Amsterdam',1,3,'approved','{\"submitted_minutes\":210,\"approved_minutes\":180}')"),
        DB.prepare("INSERT INTO time_events(id,week_id,actor_user_id,action,version,document_json) VALUES('legacy_te','legacy_week','legacy_recover','approve',3,'{\"submitted_minutes\":210,\"approved_minutes\":180}')")
      ]);
      legacy = await business();
    }
    const sql = (await readFile(new URL(file, directory), 'utf8')).split(';').map(s => s.trim()).filter(Boolean);
    await DB.batch(sql.map(s => DB.prepare(s)));
  }
  globalThis.fetch = (async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.href === 'https://api.resend.com/emails') {
      const body = JSON.parse(String(options?.body)); sent.push(body);
      return deliveryFailure ? new Response(JSON.stringify(body), { status: 503 }) : Response.json({ id: 'synthetic-mail' });
    }
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return originalFetch(input, options);
    throw new Error('Unexpected external request in recovery test');
  }) as typeof fetch;
}, 20000);
afterAll(async () => { globalThis.fetch = originalFetch; await runtime.dispose(); });

async function request(method: string, path: string, body?: unknown, options: { key?: string; ip?: string; overrides?: Record<string, unknown>; contentType?: string; drain?: boolean } = {}) {
  const pending: Promise<unknown>[] = [];
  const response = await app.request('https://untrusted-request-origin.example' + path, { method,
    headers: { 'content-type': options.contentType ?? 'application/json', 'cf-connecting-ip': options.ip ?? `fixture-ip-${++sequence}`,
      ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  }, { ...env, DB, ...options.overrides }, { waitUntil(p) { pending.push(p); }, passThroughOnException() {} });
  if (options.drain !== false) await Promise.all(pending);
  return { response, status: response.status, body: await response.json() as any, pending };
}
const root = '/v1/auth/key-recovery';
async function key(user: string, scopes = ['workspace:read', 'workspace:write'], workspace: string | null = null, expires: string | null = null, name = 'Existing personal key') {
  const result = await issueApiKey({ ...env, DB }, { name, scopes, expiresAt: expires });
  await DB.prepare('INSERT INTO api_keys(id,workspace_id,created_by_user_id,name,key_prefix,key_hash,scopes_json,expires_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(result.id, workspace, user, result.name, result.keyPrefix, result.keyHash, JSON.stringify(scopes), result.expiresAt).run();
  return result;
}
async function fixture(scopes?: string[], expires?: string | null) {
  const n = ++sequence, user = `recover_user_${n}`, owner = `recover_owner_${n}`, foreign = `recover_foreign_${n}`, ws = `recover_ws_${n}`;
  await DB.batch([
    DB.prepare('INSERT INTO users(id,email,email_verified_at) VALUES(?,?,CURRENT_TIMESTAMP),(?,?,CURRENT_TIMESTAMP),(?,?,CURRENT_TIMESTAMP)')
      .bind(user, `${user}@example.test`, owner, `${owner}@example.test`, foreign, `${foreign}@example.test`),
    DB.prepare('INSERT INTO workspaces(id,slug,name,created_by_user_id) VALUES(?,?,?,?)').bind(ws, `recover-${n}`, 'Synthetic recovery', owner),
    DB.prepare("INSERT INTO memberships(id,workspace_id,user_id,role) VALUES(?,?,?,'OWNER'),(?,?,?,'MEMBER')").bind(`m_${owner}`, ws, owner, `m_${user}`, ws, user),
    DB.prepare('INSERT INTO projects(id,workspace_id,name) VALUES(?,?,?),(?,?,?)').bind(`grow_${n}`, ws, 'GROW PRIVATE', `ve_${n}`, ws, 'Veloura'),
    DB.prepare("INSERT INTO member_project_access(workspace_id,user_id,project_ids_json,version) VALUES(?,?,?,1)").bind(ws, user, JSON.stringify([`ve_${n}`])),
    DB.prepare('INSERT INTO tasks(id,workspace_id,project_id,title,version) VALUES(?,?,?,?,7)').bind(`task_${n}`, ws, `ve_${n}`, 'Existing Veloura task')
  ]);
  return { user, owner, foreign, ws, grow: `grow_${n}`, project: `ve_${n}`, task: `task_${n}`, email: `${user}@example.test`, old: await key(user, scopes, null, expires) };
}
async function emailLink(f: Awaited<ReturnType<typeof fixture>>) {
  const before = sent.length;
  const result = await request('POST', root + '/request', { email: f.email }); expect(result.status).toBe(200);
  const message = sent.slice(before).find(e => e.subject === 'Recover your Todoless personal key'); expect(message).toBeDefined();
  const url = new URL(message!.text.match(/https:\/\/[^\s]+/)![0]);
  expect(url.origin).toBe(env.APP_BASE_URL); expect(url.pathname).toBe('/recover-key'); expect(url.search).toBe('');
  expect(message!.to).toEqual([f.email]);
  const token = new URLSearchParams(url.hash.slice(1)).get('token')!; expect(token).toStartWith('tdls_recover_');
  expect(JSON.stringify(result.body)).not.toContain(token); return token;
}
const finish = (f: Awaited<ReturnType<typeof fixture>>, token: string, revoke = false, options = {}) =>
  request('POST', root + '/complete', { recovery_token: token, key_id: f.old.id, revoke_old_key: revoke }, options);

test('0011 is additive and preserves existing tasks/history and approved hours exactly', async () => {
  expect(await business()).toEqual(legacy);
});
test('unknown, unverified and verified email requests are indistinguishable and never expose a link', async () => {
  const f = await fixture();
  await DB.prepare('INSERT INTO users(id,email) VALUES(?,?)').bind('pending_recovery', 'unverified@example.test').run();
  const count = sent.length, states = await business();
  const replies = [];
  for (const email of ['unknown@example.test', 'unverified@example.test', f.email]) {
    const r = await request('POST', root + '/request', { email }); replies.push(r.body.data);
    expect(r.status).toBe(200); expect(r.response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(r.body)).not.toContain('tdls_'); expect(JSON.stringify(r.body)).not.toContain(email);
  }
  expect(replies[0]).toEqual(replies[1]); expect(replies[1]).toEqual(replies[2]);
  expect(sent.length).toBe(count + 1); expect(sent.at(-1)!.to).toEqual([f.email]);
  expect(await business()).toEqual(states);
});
test('account lookup and email dispatch do not block the public request response', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const delayed = { prepare(sql: string) {
    const stmt = DB.prepare(sql);
    if (!sql.startsWith('SELECT id FROM users')) return stmt;
    return { bind() { return { async first() { await gate; return null; } }; } };
  } };
  const result = await request('POST', root + '/request', { email: 'delayed-unknown@example.test' }, { overrides: { DB: delayed }, drain: false });
  expect(result.status).toBe(200); expect(result.pending).toHaveLength(1); release(); await Promise.all(result.pending);
});
test('GET page is non-mutating, ignores hostile URL input, and has fresh matching CSP nonces', async () => {
  const before = await business(), tokens = (await DB.prepare('SELECT count(*) n FROM api_key_recovery_tokens').first())!.n;
  const attack = '<img src=x onerror=globalThis.injected=true>';
  const response = await app.request('/recover-key?email=' + encodeURIComponent(attack));
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  const html = await response.text(), nonce = html.match(/<script nonce="([a-f0-9]+)">/)![1];
  expect(html).not.toContain(attack); expect(response.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
  expect(html).toContain(`style nonce="${nonce}"`); expect(html).not.toContain('localStorage'); expect(html).not.toContain('sessionStorage');
  expect(await (await app.request('/recover-key')).text()).not.toContain(nonce);
  expect(await business()).toEqual(before); expect((await DB.prepare('SELECT count(*) n FROM api_key_recovery_tokens').first())!.n).toBe(tokens);
});
test('request requires explicit safe origin/email config even in dev; Host cannot choose the link', async () => {
  const f = await fixture(), before = sent.length;
  for (const overrides of [{ APP_BASE_URL: undefined }, { APP_BASE_URL: 'http://evil.example' },
    { APP_BASE_URL: 'https://user:password@evil.example' }, { RESEND_API_KEY: undefined }, { ENVIRONMENT: 'dev', RESEND_API_KEY: undefined }])
    expect((await request('POST', root + '/request', { email: `config-${++sequence}@example.test` }, { overrides })).status).toBe(500);
  expect(sent).toHaveLength(before); await emailLink(f);
});
test('JSON/schema validation rejects malformed requests and client-selected key permissions', async () => {
  expect((await request('POST', root + '/request', { email: 'bad' })).status).toBe(400);
  expect((await request('POST', root + '/request', { email: 'a@example.test' }, { contentType: 'text/plain' })).status).toBe(415);
  const f = await fixture(), token = await emailLink(f);
  for (const extra of [{ scopes: ['*'] }, { workspace_id: f.ws }, { user_id: f.foreign }])
    expect((await request('POST', root + '/complete', { recovery_token: token, key_id: f.old.id, revoke_old_key: false, ...extra })).status).toBe(400);
  expect((await request('POST', root + '/complete', { recovery_token: token, key_id: f.old.id })).status).toBe(400);
});
test('inspect requires email proof, is non-consuming and reveals only active personal key metadata', async () => {
  const f = await fixture(); const scoped = await key(f.user, ['*'], f.ws), revoked = await key(f.user), expired = await key(f.user, undefined, null, '2020-01-01T00:00:00Z');
  await DB.prepare('UPDATE api_keys SET revoked_at=CURRENT_TIMESTAMP WHERE id=?').bind(revoked.id).run();
  expect((await request('POST', root + '/inspect', { recovery_token: 'no' })).status).toBe(401);
  const token = await emailLink(f);
  for (let i = 0; i < 2; i++) {
    const r = await request('POST', root + '/inspect', { recovery_token: token }); expect(r.status).toBe(200);
    expect(r.body.data.keys.map((k: any) => k.id)).toEqual([f.old.id]);
    const text = JSON.stringify(r.body); for (const secret of [token, f.old.raw, scoped.raw, revoked.raw, expired.raw, f.old.keyHash]) expect(text).not.toContain(secret);
  }
  expect((await finish(f, token)).status).toBe(201);
});
test('replacement retains exact scopes/expiry, current Veloura restriction and all business records; old keys stay valid by default', async () => {
  const f = await fixture(['workspace:read'], '2099-01-01T00:00:00Z'), token = await emailLink(f), before = await business();
  const untouched = await key(f.user, ['members:read']);
  const result = await finish(f, token); expect(result.status).toBe(201); expect(result.body.data.scopes).toEqual(['workspace:read']);
  expect(result.body.data.expires_at).toBe('2099-01-01T00:00:00Z'); expect(result.body.data.revoked_old_key).toBe(false);
  expect(await business()).toEqual(before);
  for (const raw of [f.old.raw, untouched.raw, result.body.data.api_key]) expect((await request('GET', '/v1/me', undefined, { key: raw })).status).toBe(200);
  const projects = await request('GET', `/v1/workspaces/${f.ws}/projects`, undefined, { key: result.body.data.api_key });
  expect(projects.body.data.projects.map((p: any) => p.id)).toEqual([f.project]);
  expect((await request('GET', `/v1/projects/${f.grow}`, undefined, { key: result.body.data.api_key })).status).toBe(404);
  expect((await request('POST', `/v1/workspaces/${f.ws}/tasks`, { title: 'No write grant', project_id: f.project }, { key: result.body.data.api_key })).status).toBe(403);
  const audits = await DB.prepare("SELECT metadata_json FROM audit_logs WHERE action='RECOVER_API_KEY' AND actor_user_id=?").bind(f.user).all();
  expect(audits.results).toHaveLength(1); expect(JSON.stringify(audits.results)).not.toContain(token); expect(JSON.stringify(audits.results)).not.toContain(result.body.data.api_key);
  const notice = sent.at(-1)!; expect(notice.subject).toBe('Your Todoless personal key was recovered');
  expect(notice.text).not.toContain(result.body.data.api_key); expect(notice.text).not.toContain(token);
});
test('explicit revocation affects only the selected old key and is audited in the issuance transaction', async () => {
  const f = await fixture(), keep = await key(f.user), token = await emailLink(f);
  const r = await finish(f, token, true); expect(r.status).toBe(201); expect(r.body.data.revoked_old_key).toBe(true);
  expect((await request('GET', '/v1/me', undefined, { key: f.old.raw })).status).toBe(401);
  for (const raw of [keep.raw, r.body.data.api_key]) expect((await request('GET', '/v1/me', undefined, { key: raw })).status).toBe(200);
  expect((await DB.prepare("SELECT count(*) n FROM audit_logs WHERE action='REVOKE_API_KEY' AND entity_id=?").bind(f.old.id).first())!.n).toBe(1);
});
test('tampered, expired, used and signup/invitation tokens cannot recover a key', async () => {
  const f = await fixture(), token = await emailLink(f);
  for (const raw of [token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'), token.replace('recover', 'verify'), token.replace('recover', 'invite')])
    expect((await finish(f, raw)).status).toBe(401);
  await DB.prepare('UPDATE api_key_recovery_tokens SET expires_at=? WHERE user_id=?').bind('2020-01-01T00:00:00Z', f.user).run();
  expect((await finish(f, token)).status).toBe(401);
  const current = await emailLink(f); expect((await finish(f, current)).status).toBe(201);
  expect((await finish(f, current)).status).toBe(401);
  expect((await request('POST', '/v1/auth/verify-email', { verification_token: current })).status).toBe(401);
});
test('foreign, workspace-scoped, revoked and expired keys cannot be resurrected or replaced', async () => {
  const f = await fixture(), token = await emailLink(f), foreign = await key(f.foreign), workspace = await key(f.user, ['*'], f.ws),
    expired = await key(f.user, undefined, null, '2020-01-01T00:00:00Z'), revoked = await key(f.user);
  await DB.prepare('UPDATE api_keys SET revoked_at=CURRENT_TIMESTAMP WHERE id=?').bind(revoked.id).run();
  for (const id of [foreign.id, workspace.id, expired.id, revoked.id])
    expect((await request('POST', root + '/complete', { recovery_token: token, key_id: id, revoke_old_key: true })).status).toBe(409);
  expect((await finish(f, token)).status).toBe(201);
});
test('a replacement email invalidates earlier recovery links without touching keys', async () => {
  const f = await fixture(), old = await emailLink(f), current = await emailLink(f);
  expect((await finish(f, old)).status).toBe(401); expect((await finish(f, current)).status).toBe(201);
});
test('concurrent redemption has exactly one key, recovery audit, revocation and notification', async () => {
  const f = await fixture(), token = await emailLink(f), mail = sent.length;
  const results = await Promise.all(Array.from({ length: 6 }, () => finish(f, token, true)));
  expect(results.filter(r => r.status === 201)).toHaveLength(1);
  expect(results.every(r => [201, 401, 409].includes(r.status))).toBe(true);
  expect((await DB.prepare('SELECT count(*) n FROM api_keys WHERE created_by_user_id=?').bind(f.user).first())!.n).toBe(2);
  expect((await DB.prepare("SELECT count(*) n FROM audit_logs WHERE action='RECOVER_API_KEY' AND actor_user_id=?").bind(f.user).first())!.n).toBe(1);
  expect(sent.length).toBe(mail + 1);
});
test('different valid tokens for one user still issue only one replacement', async () => {
  const f = await fixture(), tokens = await Promise.all([issueRecoveryToken({ ...env, DB }), issueRecoveryToken({ ...env, DB })]);
  for (const t of tokens) await DB.prepare('INSERT INTO api_key_recovery_tokens(id,user_id,recipient_email,token_prefix,token_hash,expires_at) VALUES(?,?,?,?,?,?)')
    .bind(t.id, f.user, f.email, t.prefix, t.hash, t.expiresAt).run();
  const results = await Promise.all(tokens.map(t => finish(f, t.raw)));
  expect(results.filter(r => r.status === 201)).toHaveLength(1);
  expect((await DB.prepare('SELECT count(*) n FROM api_keys WHERE created_by_user_id=?').bind(f.user).first())!.n).toBe(2);
});
test('audit failure rolls back key issuance, token consumption and selected-key revocation', async () => {
  const f = await fixture(), token = await emailLink(f), before = sent.length;
  await DB.prepare(`CREATE TRIGGER recovery_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='RECOVER_API_KEY' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`).run();
  try {
    const result = await finish(f, token, true); expect(result.status).toBe(500);
    expect((await DB.prepare('SELECT count(*) n FROM api_keys WHERE created_by_user_id=?').bind(f.user).first())!.n).toBe(1);
    expect((await DB.prepare('SELECT revoked_at FROM api_keys WHERE id=?').bind(f.old.id).first())!.revoked_at).toBeNull();
    expect((await request('POST', root + '/inspect', { recovery_token: token })).status).toBe(200);
    expect(sent).toHaveLength(before);
  } finally { await DB.prepare('DROP TRIGGER recovery_audit_failure').run(); }
  expect((await finish(f, token, true)).status).toBe(201);
});
test('expiry, account verification, old-key revocation and scope changes are rechecked inside the write transaction', async () => {
  for (const change of ['token', 'user', 'revoke', 'scope', 'expiry']) {
    const f = await fixture(), token = await emailLink(f);
    const racing = { prepare: DB.prepare.bind(DB), async batch(statements: D1PreparedStatement[]) {
      if (change === 'token') await DB.prepare("UPDATE api_key_recovery_tokens SET expires_at='2020-01-01T00:00:00Z' WHERE user_id=?").bind(f.user).run();
      if (change === 'user') await DB.prepare('UPDATE users SET email_verified_at=NULL WHERE id=?').bind(f.user).run();
      if (change === 'revoke') await DB.prepare('UPDATE api_keys SET revoked_at=CURRENT_TIMESTAMP WHERE id=?').bind(f.old.id).run();
      if (change === 'scope') await DB.prepare('UPDATE api_keys SET scopes_json=? WHERE id=?').bind('["workspace:read"]', f.old.id).run();
      if (change === 'expiry') await DB.prepare("UPDATE api_keys SET expires_at='2020-01-01T00:00:00Z' WHERE id=?").bind(f.old.id).run();
      return DB.batch(statements);
    } };
    expect((await finish(f, token, true, { overrides: { DB: racing } })).status).toBe(409);
    expect((await DB.prepare('SELECT count(*) n FROM api_keys WHERE created_by_user_id=?').bind(f.user).first())!.n).toBe(1);
  }
});
test('a changed email invalidates proof; recovery never re-adds membership or restores removed project grants', async () => {
  const f = await fixture(), token = await emailLink(f);
  await DB.prepare('UPDATE users SET email=? WHERE id=?').bind('changed@example.test', f.user).run();
  expect((await finish(f, token)).status).toBe(401);
  await DB.prepare('UPDATE users SET email=? WHERE id=?').bind(f.email, f.user).run();
  await DB.prepare("UPDATE member_project_access SET project_ids_json='[]',version=version+1 WHERE user_id=?").bind(f.user).run();
  const r = await finish(f, token); expect(r.status).toBe(201);
  expect((await request('GET', `/v1/projects/${f.project}`, undefined, { key: r.body.data.api_key })).status).toBe(404);
  const fresh = await emailLink(f);
  await DB.prepare('DELETE FROM memberships WHERE workspace_id=? AND user_id=?').bind(f.ws, f.user).run();
  const after = await finish(f, fresh); expect(after.status).toBe(201);
  expect((await request('GET', `/v1/workspaces/${f.ws}/projects`, undefined, { key: after.body.data.api_key })).status).toBe(404);
  expect((await DB.prepare('SELECT count(*) n FROM memberships WHERE workspace_id=? AND user_id=?').bind(f.ws, f.user).first())!.n).toBe(0);
});
test('parallel request limits are atomic, prevent inbox flooding and store only bucket hashes', async () => {
  const f = await fixture(), before = sent.length;
  const replies = await Promise.all(Array.from({ length: 9 }, (_, i) => request('POST', root + '/request', { email: f.email }, { ip: `limit-ip-${i}` })));
  expect(replies.filter(r => r.status === 200)).toHaveLength(5); expect(replies.filter(r => r.status === 429)).toHaveLength(4);
  expect(sent.length).toBe(before + 5); expect(replies.find(r => r.status === 429)!.response.headers.get('retry-after')).toBeTruthy();
  const rows = await DB.prepare('SELECT * FROM key_recovery_rate_limits').all();
  expect(JSON.stringify(rows.results)).not.toContain(f.email); expect(JSON.stringify(rows.results)).not.toContain('limit-ip');
});
test('IP request limit caps distinct-email spam; proof checks are bounded independently', async () => {
  const requests = [];
  for (let i = 0; i < 21; i++) requests.push(await request('POST', root + '/request', { email: `ip-${i}@example.test` }, { ip: 'fixed-request-ip' }));
  expect(requests.filter(r => r.status === 200)).toHaveLength(20); expect(requests.at(-1)!.status).toBe(429);
  for (let i = 0; i < 60; i++) expect((await request('POST', root + '/inspect', { recovery_token: 'invalid' }, { ip: 'fixed-inspect-ip' })).status).toBe(401);
  expect((await request('POST', root + '/inspect', { recovery_token: 'invalid' }, { ip: 'fixed-inspect-ip' })).status).toBe(429);
});
test('provider failures and echoed email bodies never expose a recovery link in response/logs', async () => {
  const f = await fixture(), logs: unknown[][] = [], original = console.error;
  console.error = (...args) => { logs.push(args); }; deliveryFailure = true;
  try {
    const r = await request('POST', root + '/request', { email: f.email }); expect(r.status).toBe(200);
    expect(logs).toHaveLength(1); expect(JSON.stringify(logs)).not.toContain('tdls_recover_');
    expect(JSON.stringify(r.body)).not.toContain('tdls_recover_');
  } finally { deliveryFailure = false; console.error = original; }
});
test('request audit failure keeps the previous link usable and does not send a broken replacement', async () => {
  const f = await fixture(), token = await emailLink(f), count = sent.length, original = console.error;
  await DB.prepare(`CREATE TRIGGER recovery_request_failure BEFORE INSERT ON audit_logs WHEN NEW.action='REQUEST_KEY_RECOVERY' BEGIN SELECT RAISE(ABORT,'synthetic request audit failure'); END`).run();
  console.error = () => {};
  try {
    expect((await request('POST', root + '/request', { email: f.email })).status).toBe(200);
    expect(sent).toHaveLength(count);
    expect((await request('POST', root + '/inspect', { recovery_token: token })).status).toBe(200);
  } finally { console.error = original; await DB.prepare('DROP TRIGGER recovery_request_failure').run(); }
  expect((await finish(f, token)).status).toBe(201);
});
test('a stale request cannot invalidate a newer link after the verified account email changes', async () => {
  const f = await fixture(), newer = await issueRecoveryToken({ ...env, DB }), email = `${f.user}-new@example.test`, count = sent.length;
  const changedEmail = { prepare: DB.prepare.bind(DB), async batch(statements: D1PreparedStatement[]) {
    await DB.prepare('UPDATE users SET email=? WHERE id=?').bind(email, f.user).run();
    await DB.prepare('INSERT INTO api_key_recovery_tokens(id,user_id,recipient_email,token_prefix,token_hash,expires_at) VALUES(?,?,?,?,?,?)')
      .bind(newer.id, f.user, email, newer.prefix, newer.hash, newer.expiresAt).run();
    return DB.batch(statements);
  } };
  expect((await request('POST', root + '/request', { email: f.email }, { overrides: { DB: changedEmail } })).status).toBe(200);
  expect(sent).toHaveLength(count);
  expect((await request('POST', root + '/inspect', { recovery_token: newer.raw })).body.data.email).toBe(email);
  expect((await finish(f, newer.raw)).status).toBe(201);
});
test('no eligible personal keys means no default credential or revived grant', async () => {
  const f = await fixture(), token = await emailLink(f);
  await DB.prepare('UPDATE api_keys SET scopes_json=? WHERE id=?').bind('malformed scopes', f.old.id).run();
  const inspected = await request('POST', root + '/inspect', { recovery_token: token });
  expect(inspected.status).toBe(200); expect(inspected.body.data.keys).toEqual([]);
  expect((await finish(f, token)).status).toBe(409);
  expect((await DB.prepare('SELECT count(*) n FROM api_keys WHERE created_by_user_id=?').bind(f.user).first())!.n).toBe(1);
});
test('a failed security notification does not turn successful recovery into an unsafe retry', async () => {
  const f = await fixture(), token = await emailLink(f), original = console.error, logs: unknown[][] = [];
  deliveryFailure = true; console.error = (...args) => { logs.push(args); };
  try {
    const result = await finish(f, token); expect(result.status).toBe(201);
    expect(logs).toHaveLength(1); expect(JSON.stringify(logs)).not.toContain(result.body.data.api_key);
    expect(JSON.stringify(logs)).not.toContain(token); expect((await finish(f, token)).status).toBe(401);
    expect((await request('GET', '/v1/me', undefined, { key: result.body.data.api_key })).status).toBe(200);
  } finally { deliveryFailure = false; console.error = original; }
});

// Execute the real inline page script with strict text-only DOM sinks. These
// cover lifecycle, accidental secret storage and uncertain-write UI behavior.
async function browser(send: (url: string, init: RequestInit) => Promise<Response>, token = '') {
  const html = await (await app.request('/recover-key')).text();
  const script = html.match(/<script nonce="[a-f0-9]+">([\s\S]*?)<\/script>/)![1];
  const elements = new Map<string, any>(), events = new Map<string, any>(), copied: string[] = [];
  const make = (id: string) => ({ value: '', textContent: '', disabled: ['request-button','complete-button'].includes(id), hidden: ['proof-section','complete-form','result'].includes(id), checked: false, valid: true, children: [] as any[],
    reportValidity() { return this.valid; }, replaceChildren() { this.children = []; }, appendChild(child: any) { this.children.push(child); }, focus() {}, select() {},
    addEventListener(name: string, callback: unknown) { events.set(`${id}:${name}`, callback); },
    set innerHTML(_v: string) { throw new Error('Unsafe HTML sink'); } });
  const history: unknown[] = [];
  const location = { hash: token ? `#token=${token}` : '', pathname: '/recover-key', reloads: 0, reload() { this.reloads++; } };
  runInNewContext(script, { URLSearchParams, window: { location, history: { replaceState(...args: unknown[]) { history.push(args); } }, addEventListener(name: string, fn: unknown) { events.set(`window:${name}`, fn); } },
    document: { getElementById(id: string) { if (!elements.has(id)) elements.set(id, make(id)); return elements.get(id); }, createElement() { return make('option'); } },
    navigator: { clipboard: { async writeText(value: string) { copied.push(value); } } }, fetch: send });
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, make(id)); return elements.get(id); };
  const fire = async (id: string, name: string) => events.get(`${id}:${name}`)({ preventDefault() {} });
  return { get, fire, history, copied, location };
}
test('browser request uses JSON, generic confirmation and prevents double submissions', async () => {
  let release!: () => void, count = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const page = await browser(async (url, init) => { count++; expect(url).toBe(root + '/request'); expect(JSON.parse(String(init.body))).toEqual({ email: 'person@example.test' }); await pending; return Response.json({ success: true, data: {} }); });
  page.get('email').value = ' person@example.test ';
  const submit = page.fire('request-form', 'submit'); expect(page.get('request-button').disabled).toBe(true);
  await page.fire('request-form', 'submit'); expect(count).toBe(1); release(); await submit;
  expect(page.get('status').textContent).toContain('If a verified account exists'); expect(page.get('request-button').disabled).toBe(false);
});
test('browser strips the fragment, performs no automatic recovery and safely renders hostile key/account names', async () => {
  const calls: any[] = [], attack = '<img src=x onerror=globalThis.injected=true>';
  const page = await browser(async (url, init) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return Response.json({ success: true, data: { email: attack, keys: [{ id: 'safe-id', name: attack, key_prefix: attack, scopes: ['workspace:read'], expires_at: null }] } }); }, 'synthetic-proof');
  expect(calls).toHaveLength(0); expect(page.history[0]).toEqual([null, '', '/recover-key']);
  await page.fire('inspect-button', 'click'); expect(calls).toHaveLength(1);
  expect(calls[0].body).toEqual({ recovery_token: 'synthetic-proof' }); expect(page.get('account').textContent).toContain(attack);
  expect(page.get('key-id').children[1].textContent).toContain(attack); expect(page.get('complete-button').disabled).toBe(true);
});
test('browser requires explicit key choice, defaults to keeping old connections, shows/copies one key and never resubmits completion', async () => {
  const calls: any[] = [];
  const page = await browser(async (url, init) => { const body = JSON.parse(String(init.body)); calls.push({ url, body }); return Response.json({ success: true, data: url.endsWith('inspect') ? { email: 'synthetic@example.test', keys: [{ id: 'selected', name: 'Key', key_prefix: 'prefix', scopes: ['workspace:read'], expires_at: null }] } : { api_key: 'synthetic-one-time-key', revoked_old_key: false } }, { status: url.endsWith('complete') ? 201 : 200 }); }, 'proof');
  await page.fire('inspect-button', 'click'); page.get('key-id').value = 'selected'; page.get('revoke-old').checked = true;
  await page.fire('key-id', 'change'); expect(page.get('revoke-old').checked).toBe(false);
  await page.fire('complete-form', 'submit');
  expect(calls.at(-1).body).toEqual({ recovery_token: 'proof', key_id: 'selected', revoke_old_key: false });
  expect(page.get('new-key').value).toBe('synthetic-one-time-key'); expect(page.get('result').hidden).toBe(false);
  await page.fire('complete-form', 'submit'); expect(calls.filter(c => c.url.endsWith('complete'))).toHaveLength(1);
  await page.fire('copy-button', 'click'); expect(page.copied).toEqual(['synthetic-one-time-key']);
});
test('browser uncertain completion cannot be blindly retried and asks for a fresh email', async () => {
  let completions = 0;
  const page = await browser(async url => { if (url.endsWith('inspect')) return Response.json({ success: true, data: { email: 'x@example.test', keys: [{ id: 'k', name: 'Key', key_prefix: 'prefix', scopes: [], expires_at: null }] } }); completions++; throw new Error('Synthetic connection dropped after possible commit'); }, 'proof');
  await page.fire('inspect-button', 'click'); page.get('key-id').value = 'k'; await page.fire('key-id', 'change');
  await page.fire('complete-form', 'submit'); await page.fire('complete-form', 'submit');
  expect(completions).toBe(1); expect(page.get('status').textContent).toContain('may already have completed');
  expect(page.get('request-section').hidden).toBe(false); expect(page.get('result').hidden).toBe(true);
});
test('leaving the browser page clears displayed keys/proof instead of restoring secrets through back navigation', async () => {
  const page = await browser(async () => Response.json({ success: true, data: {} }), 'synthetic-proof');
  page.get('new-key').value = 'synthetic-key-to-clear'; page.get('result').hidden = false;
  await page.fire('window', 'pagehide');
  expect(page.get('new-key').value).toBe(''); expect(page.get('result').hidden).toBe(true);
  expect(page.get('account').textContent).toBe(''); expect(page.get('proof-section').hidden).toBe(true);
  expect(page.get('request-section').hidden).toBe(false);
});
test('a new email fragment in the same tab reloads without inspecting or consuming it', async () => {
  let calls = 0;
  const page = await browser(async () => { calls++; return Response.json({}); });
  expect(page.get('script-help').hidden).toBe(true);
  page.location.hash = '#token=synthetic-new-email-proof';
  await page.fire('window', 'hashchange');
  expect(page.location.reloads).toBe(1); expect(calls).toBe(0);
});
