import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { hashApiKey, extractKeyPrefix } from '../src/services/api-keys';

// Exact compiled artifacts, synthetic data and disposable local D1 only.
const root = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(root, '../..');
const directory = resolve(root, '.dist/release-candidate');
const require = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare } = require('miniflare');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
const scripts: Record<string, string> = {};
for (const artifact of manifest.artifacts) {
  scripts[artifact.name] = await readFile(`${directory}/${artifact.file}`, 'utf8');
  assert.equal(sha256(scripts[artifact.name]), artifact.sha256, 'Artifact drift');
  for (const input of artifact.inputs) {
    assert.equal(sha256(await readFile(resolve(repo, input.path))), input.sha256, `Input drift: ${input.path}`);
  }
}
assert.deepEqual(manifest.artifacts.find((a: any) => a.name === 'recovery').inputs.map((i: any) => i.path),
  ['apps/api/src/recovery.ts'], 'Recovery must not import application dependencies');
const pepper = 'synthetic-release-rehearsal-pepper';
const ownerKey = `tdls_test_1111111111111111_${'a'.repeat(48)}`;
const memberKey = `tdls_test_2222222222222222_${'b'.repeat(48)}`;
const legacyInvite = `tdls_invite_3333333333333333_${'c'.repeat(48)}`;
const runtime = new Miniflare({
  host: '127.0.0.1', port: 0, d1Persist: false,
  workers: [
    { name: 'candidate', modules: true, script: scripts.api, compatibilityDate: '2026-02-05',
      d1Databases: { DB: 'release-rehearsal' },
      bindings: { ENVIRONMENT: 'prod', API_KEY_PEPPER: pepper, APP_BASE_URL: 'https://tasks.example.test' },
      outboundService: () => new Response('External requests disabled', { status: 503 }) },
    // No bindings at all: recovery also works before/partway through migrations.
    { name: 'recovery', modules: true, script: scripts.recovery, compatibilityDate: '2026-02-05' },
    ...['candidate', 'recovery'].map((target) => ({
      name: `mcp-${target}`, modules: true, script: scripts.mcp, compatibilityDate: '2026-02-07',
      bindings: { TODOLESS_API_BASE_URL: 'https://tasks.example.test' },
      serviceBindings: { TODOLESS_API: target },
      outboundService: () => new Response('External requests disabled', { status: 503 })
    }))
  ]
});
const checks: string[] = [];
try {
  const db = await runtime.getD1Database('DB', 'candidate');
  const candidate = await runtime.getWorker('candidate');
  const recovery = await runtime.getWorker('recovery');
  const call = async (method: string, path: string, body?: unknown, key = ownerKey, idem = crypto.randomUUID()) => {
    const response = await candidate.fetch(`https://tasks.example.test${path}`, {
      method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': idem },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = response.headers.get('content-type')?.includes('text/csv') ? await response.text() : await response.json();
    return { status: response.status, data };
  };
  const success = async (...args: Parameters<typeof call>) => {
    const result = await call(...args);
    assert.ok([200, 201].includes(result.status), JSON.stringify(result));
    return result.data.data;
  };
  const snapshot = async () => {
    const schema = (await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all()).results;
    const data: Record<string, unknown> = {};
    for (const row of schema.filter((row: any) => row.type === 'table')) {
      const rows = (await db.prepare(`SELECT * FROM "${row.name}"`).all()).results;
      data[row.name] = rows.map((row: any) => JSON.stringify(row)).sort();
    }
    return { schema, data };
  };
  const frozen = async () => {
    const before = await snapshot();
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const path of ['/v1/health', '/v1/me', '/v1/workspaces/release_ws/tasks', '/v1/tasks/release_task/delivery',
        '/v1/me/portfolio', '/v1/workspaces/release_ws/time/weeks', '/v1/api-keys/key/revoke',
        '/v1/auth/register', '/v1/auth/claim-invite', '/v1/auth/verify-email',
        '/accept-invite?token=private-query-token', '/verify-email?token=private-query-token', '/unknown']) {
        const response = await recovery.fetch(`https://tasks.example.test${path}`, {
          method, headers: { authorization: `Bearer ${ownerKey}`, 'x-http-method-override': 'GET' }
        });
        const health = path === '/v1/health' && ['GET', 'HEAD'].includes(method);
        assert.equal(response.status, health ? 200 : 503);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('retry-after'), '60');
        assert.ok(response.headers.get('x-request-id'));
        const text = await response.text();
        assert.ok(!text.includes('private-query-token') && !text.includes(ownerKey));
        if (method !== 'HEAD') assert.ok(text.includes(health ? 'maintenance' : 'API_RECOVERY_MODE'));
      }
    }
    assert.deepEqual(await snapshot(), before, 'Freeze must not mutate schema, records, keys or receipts');
  };
  await frozen();
  checks.push('Recovery boots without DB, secrets or application dependencies; all non-health routes/methods fail closed');
  const migrations = (await readdir(`${root}/migrations`)).filter((f) => f.endsWith('.sql')).sort();
  await db.prepare('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)').run();
  for (const file of migrations) {
    const statements = (await readFile(`${root}/migrations/${file}`, 'utf8')).split(';').map((s) => s.trim()).filter(Boolean);
    const apply = (fail = false) => db.batch([
      ...statements.map((s) => db.prepare(s)),
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(file),
      ...(fail ? [db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(file)] : [])
    ]);
    if (file >= '0005') {
      const before = await snapshot();
      await assert.rejects(() => apply(true), /UNIQUE/);
      assert.deepEqual(await snapshot(), before, `${file}: failed batch must roll back DDL, rows and migration ledger`);
      await frozen();
    }
    await apply();
    if (file.startsWith('0004')) {
      await db.batch([
        db.prepare("INSERT INTO users (id,email) VALUES ('release_owner','owner@example.test'),('release_member','member@example.test')"),
        db.prepare("INSERT INTO workspaces (id,slug,name,created_by_user_id) VALUES ('release_ws','release-rehearsal','Synthetic release rehearsal','release_owner')"),
        db.prepare("INSERT INTO memberships (id,workspace_id,user_id,role) VALUES ('release_om','release_ws','release_owner','OWNER'),('release_mm','release_ws','release_member','MEMBER')"),
        db.prepare("INSERT INTO projects (id,workspace_id,name) VALUES ('release_project','release_ws','Synthetic Grow'),('release_project2','release_ws','Synthetic Veloura')"),
        ...[ownerKey, memberKey].map((key, index) => db.prepare('INSERT INTO api_keys (id,created_by_user_id,name,key_prefix,key_hash,scopes_json) VALUES (?,?,?,?,?,?)')
          .bind(`release_key${index}`, index ? 'release_member' : 'release_owner', 'Existing personal key', extractKeyPrefix(key), '', '["*"]')),
        db.prepare("INSERT INTO tasks (id,workspace_id,project_id,assignee_user_id,title,status,version,metadata_json) VALUES ('release_task','release_ws','release_project','release_member','Legacy task','IN_PROGRESS',7,'{\"external_id\":\"SYN-A05\"}'),('release_task2','release_ws','release_project2','release_member','Existing active conflict','IN_PROGRESS',3,NULL)"),
        db.prepare("INSERT INTO project_history (id,workspace_id,project_id,actor_user_id,change_type,change_reason,from_value_json,to_value_json,metadata_json,created_at) VALUES ('release_ph','release_ws','release_project','release_owner','UPDATED','scope_change','{\"name\":\"old\"}','{\"name\":\"new\"}','{\"fixture\":true}','2025-01-01 00:00:00')"),
        db.prepare("INSERT INTO task_history (id,workspace_id,task_id,actor_user_id,change_type,change_reason,created_at) VALUES ('release_th','release_ws','release_task','release_member','UPDATED','manual','2025-01-02 00:00:00')"),
        db.prepare("INSERT INTO member_invites (id,workspace_id,user_id,email,role,created_by_user_id,token_prefix,token_hash,expires_at) VALUES ('release_invite','release_ws','release_member','member@example.test','MEMBER','release_owner','tdls_invite_3333333333333333',?,'2099-01-01T00:00:00Z')").bind(await hashApiKey(legacyInvite, pepper))
      ]);
      for (const [index, key] of [ownerKey, memberKey].entries()) {
        await db.prepare('UPDATE api_keys SET key_hash=? WHERE id=?').bind(await hashApiKey(key, pepper), `release_key${index}`).run();
      }
      // Retain every original column/value for comparison after all migrations.
      var baseline = await snapshot();
    }
  }
  const migrated = await snapshot();
  for (const [table, rows] of Object.entries(baseline!.data)) {
    if (table === 'd1_migrations') continue;
    const original = (rows as string[]).map((row) => JSON.parse(row));
    const current = (migrated.data[table] as string[]).map((row) => JSON.parse(row));
    assert.equal(current.length, original.length, `${table}: row count preserved`);
    for (const row of original) {
      const after = current.find((r) => r.id === row.id);
      for (const [column, value] of Object.entries(row)) assert.deepEqual(after[column], value, `${table}.${column}`);
    }
  }
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM users WHERE email_verified_at IS NOT NULL").first()).n, 2);
  checks.push('Populated schema0004 -> 0009; all original columns/history/IDs/keys/conflicts preserved; each of five failed migrations rolled back before retry');
  assert.equal((await success('GET', '/v1/me')).user.id, 'release_owner');
  assert.equal((await call('POST', '/v1/auth/claim-invite', { invite_token: legacyInvite })).status, 401);
  const history = await success('GET', '/v1/tasks/release_task/history');
  assert.ok(JSON.stringify(history).includes('release_th'));
  const time = '/v1/workspaces/release_ws/time';
  await success('PUT', `${time}/settings`, { version: 0, timezone: 'Europe/Amsterdam', week_start: 1, confirmed: true });
  let week = await success('POST', `${time}/weeks`, { week_start_date: '2026-10-19' }, memberKey);
  for (const [project, task, minutes] of [['release_project', 'release_task', 90], ['release_project2', 'release_task2', 120]]) {
    week = await success('POST', `${time}/weeks/${week.id}/actions`, { action: 'save_entry', version: week.version,
      entry: { project_id: project, task_id: task, work_date: '2026-10-19', activity: 'qa', minutes, note: 'Synthetic actual human hours' } }, memberKey);
  }
  const actions = `${time}/weeks/${week.id}/actions`;
  week = await success('POST', actions, { action: 'submit', version: week.version, confirmed_human_time: true }, memberKey);
  const approval = { action: 'approve', version: week.version, reason: 'Synthetic duplicate 30 minutes',
    entries: week.entries.map((entry: any, index: number) => ({ entry_id: entry.id, approved_minutes: index ? 120 : 60 })) };
  assert.equal((await call('POST', actions, approval, memberKey)).status, 403);
  const receipt = 'release-approval-exact-retry';
  week = await success('POST', actions, approval, ownerKey, receipt);
  const beforeExport = await call('GET', `${time}/export.csv?from=2026-10-19&to=2026-10-19`, undefined, memberKey);
  const beforeHistory = await success('GET', `${time}/weeks/${week.id}/history`);
  const beforeFreeze = await snapshot();
  await frozen();
  assert.deepEqual(await snapshot(), beforeFreeze);
  assert.deepEqual(await success('POST', actions, approval, ownerKey, receipt), week, 'Lost success replays after freeze');
  assert.deepEqual(await success('GET', `${time}/weeks/${week.id}/history`), beforeHistory);
  assert.equal((await call('GET', `${time}/export.csv?from=2026-10-19&to=2026-10-19`, undefined, memberKey)).data, beforeExport.data);
  const report = await success('GET', `${time}/report?from=2026-10-19&to=2026-10-19&user_id=all`);
  assert.equal(report.combined.submitted_minutes, 210);
  assert.equal(report.combined.approved_minutes, 180);
  assert.deepEqual(report.combined.amounts, []);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM time_terms').first()).n, 0);
  checks.push('Existing personal credentials resume; legacy leaked invite denied; 210 submitted/180 approved minutes, audit, CSV and exact retry survive freeze; terms remain unset');
  for (const target of ['candidate', 'recovery']) {
    const mcp = await runtime.getWorker(`mcp-${target}`);
    const response = await mcp.fetch('https://mcp.example.test/mcp', { method: 'POST', headers: {
      authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream'
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspaces.list', arguments: {} } }) });
    assert.equal(response.status, 200);
    const text = await response.text();
    const rpc = JSON.parse(text.startsWith('event:') ? text.split('\n').find((line) => line.startsWith('data:'))!.slice(5) : text);
    if (target === 'candidate') assert.ok(JSON.stringify(rpc).includes('release_ws'));
    else {
      assert.ok(rpc.error || rpc.result?.isError, 'Frozen API must not be reported as successful tool output');
      assert.ok(JSON.stringify(rpc).includes('API_RECOVERY_MODE'));
    }
  }
  checks.push('Exact compiled MCP Worker reaches API via service binding and exposes frozen API as a tool error');
  await writeFile(`${directory}/validation.json`, JSON.stringify({ passed: true, checks,
    artifacts: manifest.artifacts.map(({ inputs, ...artifact }: any) => artifact),
    migrations, live_changes: false, database: 'disposable synthetic D1' }, null, 2) + '\n');
  for (const check of checks) console.log(`PASS ${check}`);
} finally {
  await runtime.dispose();
}
