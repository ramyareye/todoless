import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import sourceApp from '../src/index';
import { hashApiKey } from '../src/services/api-keys';
import { issueEmailVerificationToken } from '../src/services/email-verification';
import { dateInZone } from '../src/services/personal-portfolio';

const releaseName = process.env.TODOLESS_TEST_EXACT_RELEASE;
if (releaseName && !['project-access-2026-10-27', 'key-recovery-2026-10-28', 'usage-protection-2026-10-29', 'google-signup-2026-10-29'].includes(releaseName)) throw new Error('Unknown exact release');
const exactRelease = Boolean(releaseName);
const releaseDirectory = releaseName === 'google-signup-2026-10-29' ? 'google-signup-release-2026-10-29'
  : releaseName === 'usage-protection-2026-10-29' ? 'usage-protection-release-2026-10-29'
  : releaseName === 'key-recovery-2026-10-28' ? 'key-recovery-release-2026-10-28' : 'project-access-release-2026-10-27';
const allow = { async limit() { return { success: true }; } };
const protectionEnv = ['usage-protection-2026-10-29', 'google-signup-2026-10-29'].includes(releaseName ?? '') ? { ABUSE_PROTECTION: 'on',
  REQUEST_RATE_LIMITER: allow, AUTH_RATE_LIMITER: allow, USER_RATE_LIMITER: allow } : {};
const app = exactRelease
  ? (await import(`../.dist/${releaseDirectory}/api.mjs`)).default
  : sourceApp;

// Current production errors are deliberately sanitized. Historical frozen
// candidates still emit the old injected error text; retain their test mode.
function auditFailureLogged(args: unknown[], message: string) {
  return args.some(value => typeof value === 'string' && value.includes('"event":"unhandled_error"'))
    || (exactRelease && releaseName !== 'usage-protection-2026-10-29' && args.map(String).join(' ').includes(message));
}

const readyDetails = {
  area: 'app',
  repository: 'https://example.com/synthetic/repo',
  outcome: 'User can finish the chosen flow',
  scope: 'One bounded app change',
  base_ref: 'synthetic-base',
  environment: 'local device fixture',
  next_action: 'Implement and run the acceptance checks',
  contract_refs: ['docs/contracts.md'],
  acceptance_checks: ['Complete the fixture flow on device'],
  setup_ready: true,
  integration_mode: 'fixture',
  exclusions: ['Live backend integration excluded']
};

// Use Wrangler's installed local D1 runtime, without loading .dev.vars, remote
// bindings, or a production database. Hono routes execute directly under Bun.
const wranglerRequire = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare } = wranglerRequire('miniflare');
const runtime = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("local test database"); } };',
  d1Databases: ['DB'],
  d1Persist: false,
  host: '127.0.0.1',
  port: 0
});
let DB: D1Database;
const pepper = 'synthetic-security-test-pepper';
const emails: { to: string[]; text: string; html: string }[] = [];
const originalFetch = globalThis.fetch;
let sequence = 0;

beforeAll(async () => {
  DB = await runtime.getD1Database('DB');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()) {
    if (file === '0006_mutation_integrity.sql') {
      await DB.batch([
        DB.prepare(
          "INSERT INTO users (id,email) VALUES ('migration_user','migration@example.com')"
        ),
        DB.prepare(
          "INSERT INTO workspaces (id,slug,name,created_by_user_id) VALUES ('migration_ws','migration-ws','Migration fixture','migration_user')"
        ),
        DB.prepare(
          "INSERT INTO projects (id,workspace_id,name) VALUES ('migration_project','migration_ws','Existing project')"
        ),
        DB.prepare(`INSERT INTO project_history (id,workspace_id,project_id,actor_user_id,change_type,change_reason,from_value_json,to_value_json,metadata_json,created_at)
          VALUES ('migration_history','migration_ws','migration_project','migration_user','UPDATED','scope_change','{"name":"old"}','{"name":"new"}','{"source":"fixture"}','2025-01-01 00:00:00')`)
      ]);
    }
    const sql = await readFile(new URL(file, directory), 'utf8');
    const statements = sql
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean);
    await DB.batch(statements.map((sql) => DB.prepare(sql)));
  }
  globalThis.fetch = (async (input, options) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    if (url.href === 'https://api.resend.com/emails') {
      emails.push(JSON.parse(String(options?.body)));
      return Response.json({ id: 'synthetic-message' });
    }
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      return originalFetch(input, options);
    }
    throw new Error('Unexpected outbound request in security test');
  }) as typeof fetch;
}, 20_000);

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await runtime.dispose();
});

async function request(
  method: string,
  path: string,
  body?: unknown,
  key?: string,
  production = false,
  overrides = {},
  extraHeaders: Record<string, string> = {}
) {
  const pending: Promise<unknown>[] = [];
  const response = await app.request(
    `http://localhost${path}`,
    {
      method,
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': `test-${sequence++}`,
        ...extraHeaders,
        ...(key ? { authorization: `Bearer ${key}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    },
    {
      DB,
      API_KEY_PEPPER: pepper,
      ENVIRONMENT: production ? 'prod' : 'dev',
      ...protectionEnv,
      ...(production
        ? { RESEND_API_KEY: 'synthetic-key', RESEND_FROM_EMAIL: 'test@example.com' }
        : {}),
      ...overrides
    },
    {
      waitUntil(promise) {
        pending.push(promise);
      },
      passThroughOnException() {}
    }
  );
  await Promise.all(pending);
  return {
    response,
    status: response.status,
    body: response.headers.get('content-type')?.includes('text/csv')
      ? await response.text()
      : ((await response.json()) as any)
  };
}

async function user() {
  const email = `security-${sequence++}@example.com`;
  const registered = await request('POST', '/v1/auth/register', {
    email,
    workspace_name: 'Test workspace'
  });
  expect(registered.status).toBe(201);
  const verified = await request('POST', '/v1/auth/verify-email', {
    verification_token: registered.body.data.verification_token
  });
  expect(verified.status).toBe(201);
  return {
    email,
    id: verified.body.data.user.id,
    key: verified.body.data.api_key,
    workspace: registered.body.data.workspace.id
  };
}

async function invite(
  owner: Awaited<ReturnType<typeof user>>,
  email: string,
  production = false,
  overrides = {},
  extraHeaders: Record<string, string> = {}
) {
  return request(
    'POST',
    `/v1/workspaces/${owner.workspace}/members`,
    { email, role: 'MEMBER' },
    owner.key,
    production,
    overrides
  );
}

async function countKeys(userId: string) {
  return (await DB.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE created_by_user_id = ?')
    .bind(userId)
    .first<{ count: number }>())!.count;
}

test('production sends existing-user claim credentials only to the recipient, not the inviter', async () => {
  const owner = await user();
  const recipient = await user();
  expect(
    (await request('GET', `/v1/workspaces/${recipient.workspace}`, undefined, owner.key)).status
  ).toBe(404);
  const sentBefore = emails.length;
  const result = await invite(owner, recipient.email, true);
  expect(result.status).toBe(201);
  expect(result.response.headers.get('cache-control')).toBe('no-store');
  expect(result.body.data.invite_delivery).toBe('email');
  expect(result.body.data).not.toHaveProperty('invite_token');
  expect(result.body.data).not.toHaveProperty('invite_url');
  expect(emails.length).toBe(sentBefore + 1);
  const mail = emails.at(-1)!;
  expect(mail.to).toEqual([recipient.email]);
  const url = new URL(mail.text.match(/Accept invitation: (\S+)/)![1]);
  const token = url.searchParams.get('token')!;
  expect(JSON.stringify(result.body)).not.toContain(token);
  expect(await countKeys(recipient.id)).toBe(1);
  // The inviter has no claim secret; its own credential cannot stand in for one.
  expect(
    (await request('POST', '/v1/auth/claim-invite', { invite_token: owner.key }, owner.key, true))
      .status
  ).toBe(401);
  expect(
    (await request('GET', `/v1/workspaces/${recipient.workspace}`, undefined, owner.key)).status
  ).toBe(404);
  const claimed = await request(
    'POST',
    '/v1/auth/claim-invite',
    { invite_token: token },
    undefined,
    true
  );
  expect(claimed.status).toBe(201);
  expect(claimed.body.data.user.id).toBe(recipient.id);
  expect(
    (await request('GET', '/v1/me', undefined, claimed.body.data.api_key)).body.data.user.id
  ).toBe(recipient.id);
  expect(
    (await request('POST', '/v1/auth/claim-invite', { invite_token: token }, undefined, true))
      .status
  ).toBe(409);
});

test('new recipients can verify identity using the emailed link', async () => {
  const owner = await user();
  const email = `new-recipient-${sequence++}@example.com`;
  const result = await invite(owner, email, true);
  expect(result.status).toBe(201);
  expect(result.body.data).not.toHaveProperty('invite_token');
  const mail = emails.at(-1)!;
  expect(mail.to).toEqual([email]);
  const token = new URL(mail.text.match(/Accept invitation: (\S+)/)![1]).searchParams.get('token');
  const claimed = await request(
    'POST',
    '/v1/auth/claim-invite',
    { invite_token: token },
    undefined,
    true
  );
  expect(claimed.status).toBe(201);
  expect(
    (
      await request(
        'GET',
        `/v1/workspaces/${owner.workspace}`,
        undefined,
        claimed.body.data.api_key
      )
    ).status
  ).toBe(200);
});

test('only explicit dev mode exposes test credentials; missing/other environments fail closed', async () => {
  const owner = await user();
  for (const environment of [undefined, 'preview', 'production', 'test']) {
    const email = `environment-${sequence++}@example.com`;
    const result = await invite(owner, email, true, { ENVIRONMENT: environment });
    expect(result.status).toBe(201);
    expect(result.body.data).not.toHaveProperty('invite_token');
    expect(result.body.data).not.toHaveProperty('invite_url');
    const registered = await request(
      'POST',
      '/v1/auth/register',
      { email: `registration-${sequence++}@example.com` },
      undefined,
      true,
      { ENVIRONMENT: environment }
    );
    expect(registered.status).toBe(201);
    expect(registered.body.data).not.toHaveProperty('verification_token');
    expect(registered.body.data).not.toHaveProperty('verification_url');
  }
  const dev = await invite(owner, `dev-${sequence++}@example.com`);
  expect(dev.body.data.invite_delivery).toBe('development_response');
  expect(dev.body.data.invite_token).toBeString();
});

test('non-development invitation without email configuration fails before creating a user', async () => {
  const owner = await user();
  const email = `no-delivery-${sequence++}@example.com`;
  const result = await invite(owner, email, true, { RESEND_API_KEY: undefined });
  expect(result.status).toBe(500);
  expect(result.body.error.code).toBe('SERVER_MISCONFIGURED');
  expect(await DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()).toBeNull();
});

test('legacy inviter-visible tokens cannot issue keys; a fresh invitation works', async () => {
  const owner = await user();
  const recipient = await user();
  const result = await invite(owner, recipient.email);
  const { invite_token: token, invite_id: id } = result.body.data;
  await DB.prepare('UPDATE member_invites SET token_hash = ? WHERE id = ?')
    .bind(await hashApiKey(token, pepper), id)
    .run();
  const baseline = await countKeys(recipient.id);
  expect((await request('POST', '/v1/auth/claim-invite', { invite_token: token })).status).toBe(
    401
  );
  expect(await countKeys(recipient.id)).toBe(baseline);
  const fresh = await invite(owner, recipient.email);
  expect(
    (await request('POST', '/v1/auth/claim-invite', { invite_token: fresh.body.data.invite_token }))
      .status
  ).toBe(201);
});

test('re-invitation invalidates the previous link', async () => {
  const owner = await user();
  const email = `reinvite-${sequence++}@example.com`;
  const first = await invite(owner, email);
  const second = await invite(owner, email);
  expect(
    (await request('POST', '/v1/auth/claim-invite', { invite_token: first.body.data.invite_token }))
      .status
  ).toBe(409);
  expect(
    (
      await request('POST', '/v1/auth/claim-invite', {
        invite_token: second.body.data.invite_token
      })
    ).status
  ).toBe(201);
});

test('tampered, expired, removed-member, and deleted-workspace invitations cannot issue keys', async () => {
  for (const condition of ['tampered', 'expired', 'removed', 'deleted']) {
    const owner = await user();
    const result = await invite(owner, `invalid-${sequence++}@example.com`);
    const { invite_id: id, user_id: userId } = result.body.data;
    let token = result.body.data.invite_token;
    if (condition === 'tampered') token = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    if (condition === 'expired')
      await DB.prepare("UPDATE member_invites SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?")
        .bind(id)
        .run();
    if (condition === 'removed')
      await DB.prepare('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?')
        .bind(owner.workspace, userId)
        .run();
    if (condition === 'deleted')
      await DB.prepare('UPDATE workspaces SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(owner.workspace)
        .run();
    const claim = await request('POST', '/v1/auth/claim-invite', { invite_token: token });
    expect(claim.status).toBe(condition === 'tampered' ? 401 : 409);
    expect(await countKeys(userId)).toBe(0);
  }
});

test('concurrent invitation redemption issues exactly one key and one audit event', async () => {
  const owner = await user();
  const invitation = await invite(owner, `concurrent-${sequence++}@example.com`);
  const { invite_token, user_id, invite_id } = invitation.body.data;
  const claims = await Promise.all(
    Array.from({ length: 5 }, () => request('POST', '/v1/auth/claim-invite', { invite_token }))
  );
  expect(claims.map((result) => result.status).sort()).toEqual([201, 409, 409, 409, 409]);
  expect(await countKeys(user_id)).toBe(1);
  const audit = await DB.prepare(
    "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'CLAIM_MEMBER_INVITE' AND json_extract(metadata_json, '$.invite_id') = ?"
  )
    .bind(invite_id)
    .first<{ count: number }>();
  expect(audit!.count).toBe(1);
});

test('a failed claim transaction does not consume the invite or leave a credential', async () => {
  const owner = await user();
  const invitation = await invite(owner, `rollback-${sequence++}@example.com`);
  const { invite_token, user_id, invite_id } = invitation.body.data;
  await DB.prepare(
    "CREATE TRIGGER fail_claim_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'CLAIM_MEMBER_INVITE' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END"
  ).run();
  const originalError = console.error;
  console.error = () => {};
  let failed;
  try {
    failed = await request('POST', '/v1/auth/claim-invite', { invite_token });
  } finally {
    console.error = originalError;
    await DB.prepare('DROP TRIGGER fail_claim_audit').run();
  }
  expect(failed!.status).toBe(500);
  expect(await countKeys(user_id)).toBe(0);
  expect(
    (await DB.prepare('SELECT claimed_at FROM member_invites WHERE id = ?')
      .bind(invite_id)
      .first<{ claimed_at: string | null }>())!.claimed_at
  ).toBeNull();
  expect((await request('POST', '/v1/auth/claim-invite', { invite_token })).status).toBe(201);
});

async function pendingVerification() {
  const email = `verification-${sequence++}@example.com`;
  const registered = await request('POST', '/v1/auth/register', { email });
  expect(registered.status).toBe(201);
  return {
    email,
    userId: registered.body.data.user.id,
    token: registered.body.data.verification_token
  };
}

// Preserve real D1 transactions while controlling the gap between route reads
// and the write batch. This makes races deterministic, without sleeps.
function beforeBatch(callback: () => Promise<void>) {
  return {
    prepare: DB.prepare.bind(DB),
    async batch(statements: D1PreparedStatement[]) {
      await callback();
      return DB.batch(statements);
    }
  };
}

function simultaneousBatches(count: number) {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return beforeBatch(async () => {
    if (++arrived === count) release();
    await ready;
  });
}

async function verificationState(userId: string) {
  const user = await DB.prepare('SELECT email_verified_at FROM users WHERE id = ?')
    .bind(userId)
    .first<{ email_verified_at: string | null }>();
  const tokens = await DB.prepare(
    'SELECT consumed_at FROM email_verification_tokens WHERE user_id = ?'
  )
    .bind(userId)
    .all<{ consumed_at: string | null }>();
  const audit = await DB.prepare(
    "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'VERIFY_EMAIL' AND entity_id = ?"
  )
    .bind(userId)
    .first<{ count: number }>();
  return {
    verifiedAt: user!.email_verified_at,
    tokens: tokens.results,
    auditCount: audit!.count,
    keyCount: await countKeys(userId)
  };
}

test('email verification concurrent redemption issues one usable key, audit, and welcome email', async () => {
  const pending = await pendingVerification();
  const synchronizedDB = simultaneousBatches(5);
  const emailsBefore = emails.length;
  const claims = await Promise.all(
    Array.from({ length: 5 }, () =>
      request(
        'POST',
        '/v1/auth/verify-email',
        { verification_token: pending.token },
        undefined,
        true,
        {
          DB: synchronizedDB
        }
      )
    )
  );
  expect(claims.map((result) => result.status).sort()).toEqual([201, 409, 409, 409, 409]);
  for (const loser of claims.filter((result) => result.status === 409)) {
    expect(loser.body.error.code).toBe('EMAIL_VERIFICATION_INVALID');
    expect(loser.body.data).toBeUndefined();
  }
  const winner = claims.find((result) => result.status === 201)!;
  expect(
    (await request('GET', '/v1/me', undefined, winner.body.data.api_key)).body.data.user.id
  ).toBe(pending.userId);
  const state = await verificationState(pending.userId);
  expect(state.keyCount).toBe(1);
  expect(state.auditCount).toBe(1);
  expect(state.verifiedAt).not.toBeNull();
  expect(state.tokens.every((token) => token.consumed_at !== null)).toBe(true);
  expect(emails.length).toBe(emailsBefore + 1);
  expect(emails.at(-1)!.to).toEqual([pending.email]);
  const replay = await request('POST', '/v1/auth/verify-email', {
    verification_token: pending.token
  });
  expect(replay.status).toBe(409);
  expect(replay.body.error.code).toBe('VERIFICATION_TOKEN_ALREADY_USED');
});

test('email verification with different live tokens for one user still issues only one initial key', async () => {
  const pending = await pendingVerification();
  // Model two outstanding tokens, e.g. from overlapping resend/verification.
  const second = await issueEmailVerificationToken({ API_KEY_PEPPER: pepper } as any);
  await DB.prepare(
    'INSERT INTO email_verification_tokens (id, user_id, token_prefix, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(second.id, pending.userId, second.tokenPrefix, second.tokenHash, second.expiresAt)
    .run();
  const synchronizedDB = simultaneousBatches(2);
  const claims = await Promise.all(
    [pending.token, second.raw].map((verification_token) =>
      request('POST', '/v1/auth/verify-email', { verification_token }, undefined, false, {
        DB: synchronizedDB
      })
    )
  );
  expect(claims.map((result) => result.status).sort()).toEqual([201, 409]);
  const state = await verificationState(pending.userId);
  expect(state.keyCount).toBe(1);
  expect(state.auditCount).toBe(1);
  expect(state.tokens).toHaveLength(2);
  expect(state.tokens.every((token) => token.consumed_at !== null)).toBe(true);
});

test('email verification rechecks token and user validity inside the write transaction', async () => {
  for (const condition of ['consumed', 'expired', 'rehashed', 'verified']) {
    const pending = await pendingVerification();
    const guardedDB = beforeBatch(async () => {
      if (condition === 'consumed')
        await DB.prepare(
          'UPDATE email_verification_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE user_id = ?'
        )
          .bind(pending.userId)
          .run();
      if (condition === 'expired')
        await DB.prepare(
          "UPDATE email_verification_tokens SET expires_at = '2000-01-01T00:00:00Z' WHERE user_id = ?"
        )
          .bind(pending.userId)
          .run();
      if (condition === 'rehashed')
        await DB.prepare(
          "UPDATE email_verification_tokens SET token_hash = 'changed-after-read' WHERE user_id = ?"
        )
          .bind(pending.userId)
          .run();
      if (condition === 'verified')
        await DB.prepare('UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind(pending.userId)
          .run();
    });
    const result = await request(
      'POST',
      '/v1/auth/verify-email',
      { verification_token: pending.token },
      undefined,
      false,
      { DB: guardedDB }
    );
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('EMAIL_VERIFICATION_INVALID');
    expect(result.body.data).toBeUndefined();
    const state = await verificationState(pending.userId);
    expect(state.keyCount).toBe(0);
    expect(state.auditCount).toBe(0);
    if (condition !== 'verified') expect(state.verifiedAt).toBeNull();
    if (condition !== 'consumed')
      expect(state.tokens.every((token) => token.consumed_at === null)).toBe(true);
  }
});

test('email verification audit failure rolls back keys, identity, and tokens and permits retry', async () => {
  const pending = await pendingVerification();
  const emailsBefore = emails.length;
  await DB.prepare(
    "CREATE TRIGGER fail_verify_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'VERIFY_EMAIL' BEGIN SELECT RAISE(ABORT, 'test verification audit failure'); END"
  ).run();
  const originalError = console.error;
  console.error = () => {};
  let failed;
  try {
    failed = await request(
      'POST',
      '/v1/auth/verify-email',
      { verification_token: pending.token },
      undefined,
      true
    );
  } finally {
    console.error = originalError;
    await DB.prepare('DROP TRIGGER fail_verify_audit').run();
  }
  expect(failed!.status).toBe(500);
  const state = await verificationState(pending.userId);
  expect(state.keyCount).toBe(0);
  expect(state.auditCount).toBe(0);
  expect(state.verifiedAt).toBeNull();
  expect(state.tokens.every((token) => token.consumed_at === null)).toBe(true);
  expect(emails.length).toBe(emailsBefore);
  expect(
    (await request('POST', '/v1/auth/verify-email', { verification_token: pending.token })).status
  ).toBe(201);
});

test('email verification resend invalidates the old link and the replacement is single-use', async () => {
  const pending = await pendingVerification();
  const resent = await request('POST', '/v1/auth/register', { email: pending.email });
  expect(resent.status).toBe(200);
  expect(
    (await request('POST', '/v1/auth/verify-email', { verification_token: pending.token })).status
  ).toBe(409);
  expect(await countKeys(pending.userId)).toBe(0);
  const token = resent.body.data.verification_token;
  expect(
    (await request('POST', '/v1/auth/verify-email', { verification_token: token })).status
  ).toBe(201);
  expect(
    (await request('POST', '/v1/auth/verify-email', { verification_token: token })).status
  ).toBe(409);
  expect(await countKeys(pending.userId)).toBe(1);
});

for (const path of ['/accept-invite', '/verify-email']) {
  test(`${path} never reflects URL input and uses matching, fresh CSP nonces`, async () => {
    const attack = '</script><script>globalThis.injected=true</script><img src=x onerror=alert(1)>';
    const response = await app.request(`${path}?token=${encodeURIComponent(attack)}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain(attack);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const nonce = html.match(/<script nonce="([a-f0-9]+)">/)![1];
    expect(response.headers.get('content-security-policy')).toContain(
      `script-src 'nonce-${nonce}'`
    );
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('content-security-policy')).not.toContain('unsafe-inline');
    expect(html).toContain(`<style nonce="${nonce}">`);
    const again = await (await app.request(path)).text();
    expect(again).not.toContain(nonce);
  });

  test(`${path} displays hostile response fields as text while preserving the claim request`, async () => {
    const html = await (await app.request(path)).text();
    const script = html.match(/<script nonce="[a-f0-9]+">([\s\S]*?)<\/script>/)![1];
    const callbacks = new Map<string, (event?: unknown) => Promise<void>>();
    const elements = new Map<string, any>();
    const hostileName = '<img src=x onerror="globalThis.injected=true">';
    const hostileEmail = '</span><script>globalThis.injected=true</script>';
    let submitted: any;
    let submissions = 0;
    let failNetwork = true;
    const sandbox = {
      URLSearchParams,
      window: { location: { search: '?token=recipient-only-token' } },
      document: {
        getElementById(id: string) {
          if (!elements.has(id))
            elements.set(id, {
              textContent: '',
              hidden: true,
              value: 'Recipient',
              disabled: false,
              addEventListener(event: string, callback: any) {
                callbacks.set(event, callback);
              },
              set innerHTML(_value: string) {
                throw new Error('Unsafe HTML parsing in credential page');
              }
            });
          return elements.get(id);
        }
      },
      async fetch(url: string, options: any) {
        submissions++;
        if (failNetwork) throw new Error('Synthetic network failure');
        submitted = { url, body: JSON.parse(options.body) };
        return {
          json: async () => ({
            success: true,
            data: {
              workspace: { name: hostileName },
              user: { email: hostileEmail },
              api_key: 'synthetic-personal-key'
            }
          })
        };
      }
    };
    runInNewContext(script, sandbox);
    const event = path === '/accept-invite' ? 'submit' : 'click';
    const button = elements.get(path === '/accept-invite' ? 'claim-button' : 'verify-button');
    await callbacks.get(event)!({ preventDefault() {} });
    expect(button.disabled).toBe(false);
    expect(elements.get('result').hidden).toBe(true);
    failNetwork = false;
    await callbacks.get(event)!({ preventDefault() {} });
    expect(elements.get('workspace-name').textContent).toBe(hostileName);
    expect(elements.get('user-email').textContent).toBe(hostileEmail);
    expect(elements.get('api-key').textContent).toBe('synthetic-personal-key');
    expect(elements.get('result').hidden).toBe(false);
    expect(submitted.body[path === '/accept-invite' ? 'invite_token' : 'verification_token']).toBe(
      'recipient-only-token'
    );
    expect(button.disabled).toBe(true);
    await callbacks.get(event)!({ preventDefault() {} });
    expect(submissions).toBe(2);
    expect(elements.get('result').hidden).toBe(false);
    expect(sandbox).not.toHaveProperty('injected');
  });
}

test('task concurrent updates have one winner and no false history or audit', async () => {
  const owner = await user();
  const created = await request(
    'POST',
    `/v1/workspaces/${owner.workspace}/tasks`,
    { title: 'Race' },
    owner.key
  );
  const id = created.body.data.id;
  const db = simultaneousBatches(2);
  const writes = await Promise.all(
    ['A', 'B'].map((title) =>
      request('PATCH', `/v1/tasks/${id}`, { title, version: 1 }, owner.key, false, { DB: db })
    )
  );
  expect(writes.map((x) => x.status).sort()).toEqual([200, 409]);
  expect(
    (
      await DB.prepare(
        "SELECT count(*) AS n FROM task_history WHERE task_id = ? AND change_type = 'UPDATED'"
      )
        .bind(id)
        .first<any>()
    ).n
  ).toBe(1);
  expect(
    (
      await DB.prepare(
        "SELECT count(*) AS n FROM audit_logs WHERE entity_id = ? AND action = 'UPDATE_TASK'"
      )
        .bind(id)
        .first<any>()
    ).n
  ).toBe(1);
  expect((await request('GET', `/v1/tasks/${id}`, undefined, owner.key)).body.data.title).toBe(
    writes.find((x) => x.status === 200)!.body.data.title
  );
});

test('task mutation and history roll back when audit fails', async () => {
  const owner = await user();
  const created = await request(
    'POST',
    `/v1/workspaces/${owner.workspace}/tasks`,
    { title: 'Original' },
    owner.key
  );
  const id = created.body.data.id;
  await DB.prepare(
    "CREATE TRIGGER fail_task_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'UPDATE_TASK' BEGIN SELECT RAISE(ABORT, 'test task audit failure'); END"
  ).run();
  const log = console.error;
  let sawInjected = false;
  console.error = (...args) => {
    sawInjected ||= auditFailureLogged(args, 'test task audit failure');
  };
  try {
    expect(
      (await request('PATCH', `/v1/tasks/${id}`, { title: 'Lost', version: 1 }, owner.key)).status
    ).toBe(500);
  } finally {
    console.error = log;
    await DB.prepare('DROP TRIGGER fail_task_audit').run();
  }
  expect(sawInjected).toBe(true);
  const current = (await request('GET', `/v1/tasks/${id}`, undefined, owner.key)).body.data;
  expect(current.title).toBe('Original');
  expect(current.version).toBe(1);
  expect(
    (
      await DB.prepare('SELECT count(*) AS n FROM task_history WHERE task_id = ?')
        .bind(id)
        .first<any>()
    ).n
  ).toBe(1);
});

test('project dependency_blocked reason persists atomically without losing existing history', async () => {
  const owner = await user();
  const created = await request(
    'POST',
    `/v1/workspaces/${owner.workspace}/projects`,
    { name: 'Before' },
    owner.key
  );
  const id = created.body.data.id;
  expect(
    (
      await request(
        'PATCH',
        `/v1/projects/${id}`,
        { name: 'After', change_reason: 'dependency_blocked' },
        owner.key
      )
    ).status
  ).toBe(200);
  expect(
    (
      await DB.prepare('SELECT count(*) AS n FROM project_history WHERE project_id = ?')
        .bind(id)
        .first<any>()
    ).n
  ).toBe(2);
});

async function timeCall(
  method: string,
  path: string,
  body: unknown,
  key: string,
  idem = `time-test-${sequence++}`,
  overrides = {}
) {
  return request(method, path, body, key, false, overrides, { 'idempotency-key': idem });
}
async function timePilot(configure = true) {
  const owner = await user();
  const person = await user();
  await invite(owner, person.email);
  const root = `/v1/workspaces/${owner.workspace}/time`;
  if (configure)
    expect(
      (
        await timeCall(
          'PUT',
          `${root}/settings`,
          { version: 0, timezone: 'Europe/Amsterdam', week_start: 1, confirmed: true },
          owner.key
        )
      ).status
    ).toBe(200);
  const projects = [];
  for (const name of ['Grow', 'Veloura']) {
    const project = (
      await request('POST', `/v1/workspaces/${owner.workspace}/projects`, { name }, owner.key)
    ).body.data;
    const task = (
      await request(
        'POST',
        `/v1/workspaces/${owner.workspace}/tasks`,
        { title: `${name} device QA`, project_id: project.id, assignee_user_id: person.id },
        owner.key
      )
    ).body.data;
    projects.push({ project, task });
  }
  return { owner, person, root, projects };
}
async function draftWithEntries(pilot: Awaited<ReturnType<typeof timePilot>>, date = '2026-10-19') {
  let result = await timeCall(
    'POST',
    `${pilot.root}/weeks`,
    { week_start_date: date },
    pilot.person.key
  );
  expect(result.status).toBe(201);
  let week = result.body.data;
  for (const [index, pair] of pilot.projects.entries()) {
    result = await timeCall(
      'POST',
      `${pilot.root}/weeks/${week.id}/actions`,
      {
        action: 'save_entry',
        version: week.version,
        entry: {
          project_id: pair.project.id,
          task_id: pair.task.id,
          work_date: date,
          activity: 'qa',
          minutes: index ? 120 : 90,
          note: index ? 'Device QA and active rework' : '=untrusted spreadsheet formula'
        }
      },
      pilot.person.key
    );
    expect(result.status).toBe(200);
    week = result.body.data;
  }
  return week;
}
function approval(week: any) {
  return {
    action: 'approve',
    version: week.version,
    entries: week.entries.map((e: any) => ({ entry_id: e.id, approved_minutes: e.minutes }))
  };
}

test('time pilot logs Grow and Veloura once, freezes submission, approves and exports matching totals', async () => {
  const p = await timePilot();
  let week = await draftWithEntries(p);
  const path = `${p.root}/weeks/${week.id}/actions`;
  const submitted = await timeCall(
    'POST',
    path,
    { action: 'submit', version: week.version, confirmed_human_time: true },
    p.person.key
  );
  expect(submitted.status).toBe(200);
  week = submitted.body.data;
  expect(week.submission.over_cap).toBe(false);
  expect(week.submission.cap_minutes).toBeNull();
  expect(
    (
      await timeCall(
        'POST',
        path,
        {
          action: 'remove_entry',
          version: week.version,
          entry_id: week.entries[0].id,
          reason: 'Try editing frozen week'
        },
        p.person.key
      )
    ).status
  ).toBe(409);
  expect((await timeCall('POST', path, approval(week), p.person.key)).status).toBe(403);
  const result = await timeCall('POST', path, approval(week), p.owner.key);
  expect(result.status).toBe(200);
  expect(result.body.data.state).toBe('approved');
  expect(
    result.body.data.approval.entries.every((e: any) => e.terms === null && e.amount_minor === null)
  ).toBe(true);
  expect(result.body.data.payment_status).toBe('manual_unrecorded');
  const summary = (
    await timeCall(
      'GET',
      `${p.root}/report?from=2026-10-19&to=2026-10-19&user_id=all`,
      undefined,
      p.owner.key
    )
  ).body.data;
  expect(summary.combined).toMatchObject({
    submitted_minutes: 210,
    approved_minutes: 210,
    unpriced_approved_minutes: 210,
    amounts: []
  });
  expect(
    summary.projects.map((x: any) => x.approved_minutes).sort((a: number, b: number) => a - b)
  ).toEqual([90, 120]);
  const exported = await timeCall(
    'GET',
    `${p.root}/export.csv?from=2026-10-19&to=2026-10-19`,
    undefined,
    p.person.key
  );
  expect(exported.status).toBe(200);
  expect(exported.body).toContain("'=untrusted spreadsheet formula");
  expect(exported.body.trim().split('\r\n')).toHaveLength(3);
  for (const row of summary.rows) expect(exported.body).toContain(`"${row.id}"`);
});

test('time privacy denies cross-tenant references, other contributors, viewers and workspace keys', async () => {
  const p = await timePilot();
  const week = await draftWithEntries(p);
  const stranger = await user();
  expect(
    (await timeCall('GET', `${p.root}/weeks/${week.id}`, undefined, stranger.key)).status
  ).toBe(404);
  await invite(p.owner, stranger.email);
  expect(
    (await timeCall('GET', `${p.root}/weeks/${week.id}`, undefined, stranger.key)).status
  ).toBe(404);
  expect(
    (
      await timeCall(
        'GET',
        `${p.root}/report?from=2026-10-19&to=2026-10-19&user_id=all`,
        undefined,
        stranger.key
      )
    ).status
  ).toBe(403);
  const foreign = (
    await request(
      'POST',
      `/v1/workspaces/${stranger.workspace}/projects`,
      { name: 'Private' },
      stranger.key
    )
  ).body.data;
  expect(
    (
      await timeCall(
        'POST',
        `${p.root}/weeks/${week.id}/actions`,
        {
          action: 'save_entry',
          version: week.version,
          entry: { ...week.entries[0], id: undefined, project_id: foreign.id }
        },
        p.person.key
      )
    ).status
  ).toBe(400);
  await request(
    'POST',
    `/v1/workspaces/${p.owner.workspace}/members`,
    { email: stranger.email, role: 'VIEWER' },
    p.owner.key
  );
  expect((await timeCall('GET', `${p.root}/settings`, undefined, stranger.key)).status).toBe(403);
  const scoped = await request(
    'POST',
    `/v1/workspaces/${p.owner.workspace}/api-keys`,
    { name: 'Project viewer', scopes: ['workspace:read', 'workspace:write'] },
    p.owner.key
  );
  expect(scoped.status).toBe(201);
  expect(
    (await timeCall('GET', `${p.root}/weeks/${week.id}`, undefined, scoped.body.data.api_key))
      .status
  ).toBe(403);
});

test('time review preserves reductions, return reasons and revoked approvals through revisions', async () => {
  const p = await timePilot();
  let week = await draftWithEntries(p);
  const path = `${p.root}/weeks/${week.id}/actions`;
  week = (
    await timeCall(
      'POST',
      path,
      { action: 'submit', version: week.version, confirmed_human_time: true },
      p.person.key
    )
  ).body.data;
  expect(
    (
      await timeCall(
        'POST',
        path,
        { action: 'request_changes', version: week.version },
        p.owner.key
      )
    ).status
  ).toBe(400);
  week = (
    await timeCall(
      'POST',
      path,
      {
        action: 'request_changes',
        version: week.version,
        reason: 'Clarify evidence; failed QA can still count'
      },
      p.owner.key
    )
  ).body.data;
  week = (
    await timeCall(
      'POST',
      path,
      { action: 'revise', version: week.version, reason: 'Clarified note' },
      p.person.key
    )
  ).body.data;
  expect(week.revision).toBe(2);
  week = (
    await timeCall(
      'POST',
      path,
      { action: 'submit', version: week.version, confirmed_human_time: true },
      p.person.key
    )
  ).body.data;
  const body = approval(week);
  body.entries[0].approved_minutes = 60;
  expect((await timeCall('POST', path, body, p.owner.key)).status).toBe(400);
  week = (
    await timeCall(
      'POST',
      path,
      { ...body, reason: '30 minutes duplicated in another entry' },
      p.owner.key
    )
  ).body.data;
  expect(week.approval.entries[0]).toMatchObject({ submitted_minutes: 90, approved_minutes: 60 });
  week = (
    await timeCall(
      'POST',
      path,
      { action: 'revise', version: week.version, reason: 'Correction after approval' },
      p.person.key
    )
  ).body.data;
  expect(week.approval).toBeNull();
  expect(week.state).toBe('draft');
  expect(week.revision).toBe(3);
  const history = (
    await timeCall('GET', `${p.root}/weeks/${week.id}/history`, undefined, p.owner.key)
  ).body.data.events;
  expect(
    history.some(
      (e: any) => e.action === 'approve' && e.document.approval.entries[0].approved_minutes === 60
    )
  ).toBe(true);
  expect(history.some((e: any) => e.action === 'request_changes' && e.reason)).toBe(true);
});

test('time concurrent submit and approve reject stale versions and replay exactly once', async () => {
  const p = await timePilot();
  let week = await draftWithEntries(p);
  const path = `${p.root}/weeks/${week.id}/actions`;
  const db = simultaneousBatches(2);
  const submit = { action: 'submit', version: week.version, confirmed_human_time: true };
  const results = await Promise.all(
    [1, 2].map((n) =>
      timeCall('POST', path, submit, p.person.key, `submit-${sequence++}`, { DB: db })
    )
  );
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  week = results.find((r) => r.status === 200)!.body.data;
  const key = `approval-${sequence++}`;
  const approve = approval(week);
  const db2 = simultaneousBatches(2);
  const approvals = await Promise.all(
    [1, 2].map(() => timeCall('POST', path, approve, p.owner.key, key, { DB: db2 }))
  );
  expect(approvals.map((r) => r.status)).toEqual([200, 200]);
  expect(approvals[0].body.data).toEqual(approvals[1].body.data);
  expect(
    (await timeCall('POST', path, { ...approve, reason: 'Different payload' }, p.owner.key, key))
      .status
  ).toBe(409);
  expect(
    (
      await DB.prepare(
        "SELECT count(*) AS n FROM time_events WHERE week_id = ? AND action = 'approve'"
      )
        .bind(week.id)
        .first<any>()
    ).n
  ).toBe(1);
  expect((await timeCall('POST', path, approve, p.owner.key)).status).toBe(409);
});

test('time failed audit rolls back approval, immutable event and idempotency receipt', async () => {
  const p = await timePilot();
  let week = await draftWithEntries(p);
  const path = `${p.root}/weeks/${week.id}/actions`;
  week = (
    await timeCall(
      'POST',
      path,
      { action: 'submit', version: week.version, confirmed_human_time: true },
      p.person.key
    )
  ).body.data;
  const key = `rollback-${sequence++}`;
  const body = approval(week);
  await DB.prepare(
    "CREATE TRIGGER fail_time_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'TIME_APPROVE' BEGIN SELECT RAISE(ABORT, 'test time audit failure'); END"
  ).run();
  const log = console.error;
  let sawInjected = false;
  console.error = (...args) => {
    sawInjected = auditFailureLogged(args, 'test time audit failure');
  };
  try {
    expect((await timeCall('POST', path, body, p.owner.key, key)).status).toBe(500);
  } finally {
    console.error = log;
    await DB.prepare('DROP TRIGGER fail_time_audit').run();
  }
  expect(sawInjected).toBe(true);
  expect(
    (await timeCall('GET', `${p.root}/weeks/${week.id}`, undefined, p.person.key)).body.data
  ).toEqual(week);
  expect(
    (
      await DB.prepare('SELECT count(*) AS n FROM delivery_operations WHERE idempotency_key = ?')
        .bind(key)
        .first<any>()
    ).n
  ).toBe(0);
  expect((await timeCall('POST', path, body, p.owner.key, key)).status).toBe(200);
});

test('time calendar settings are explicit and DST weeks keep their original local dates', async () => {
  const p = await timePilot(false);
  expect(
    (await timeCall('POST', `${p.root}/weeks`, { week_start_date: '2026-10-19' }, p.person.key))
      .body.error.code
  ).toBe('WEEK_CONFIG_REQUIRED');
  expect(
    (
      await timeCall(
        'PUT',
        `${p.root}/settings`,
        { version: 0, timezone: 'Invalid/Zone', week_start: 1, confirmed: true },
        p.owner.key
      )
    ).status
  ).toBe(400);
  expect(
    (
      await timeCall(
        'PUT',
        `${p.root}/settings`,
        { version: 0, timezone: 'Europe/Amsterdam', week_start: 1, confirmed: true },
        p.owner.key
      )
    ).status
  ).toBe(200);
  const week = await draftWithEntries(p);
  const sunday = { ...week.entries[0], id: undefined, work_date: '2026-10-25' };
  expect(
    (
      await timeCall(
        'POST',
        `${p.root}/weeks/${week.id}/actions`,
        { action: 'save_entry', version: week.version, entry: sunday },
        p.person.key
      )
    ).status
  ).toBe(200);
  expect(
    (await timeCall('POST', `${p.root}/weeks`, { week_start_date: '2026-02-30' }, p.person.key))
      .status
  ).toBe(400);
  expect(
    (
      await timeCall(
        'PUT',
        `${p.root}/settings`,
        { version: 1, timezone: 'America/New_York', week_start: 0, confirmed: true },
        p.owner.key
      )
    ).status
  ).toBe(200);
  expect(
    (await timeCall('POST', `${p.root}/weeks`, { week_start_date: '2026-10-25' }, p.person.key))
      .status
  ).toBe(409);
  const existing = (await timeCall('GET', `${p.root}/weeks/${week.id}`, undefined, p.person.key))
    .body.data;
  expect(existing.timezone).toBe('Europe/Amsterdam');
  expect(existing.week_start).toBe(1);
});

test('time agreed terms use effective dates, exact money and explicit over-cap approval', async () => {
  const p = await timePilot();
  const term = {
    version: 1,
    user_id: p.person.id,
    effective_from: '2026-10-19',
    rate_minor_per_hour: 1001,
    currency: 'EUR',
    minor_unit_scale: 2,
    weekly_cap_minutes: 100
  };
  expect((await timeCall('POST', `${p.root}/terms`, term, p.owner.key)).status).toBe(201);
  expect(
    (
      await timeCall(
        'POST',
        `${p.root}/terms`,
        { ...term, version: 2, effective_from: '2026-10-20', rate_minor_per_hour: 2001 },
        p.owner.key
      )
    ).status
  ).toBe(201);
  let week = await draftWithEntries(p);
  const path = `${p.root}/weeks/${week.id}/actions`;
  week = (
    await timeCall(
      'POST',
      path,
      {
        action: 'save_entry',
        version: week.version,
        entry_id: week.entries[1].id,
        entry: { ...week.entries[1], id: undefined, work_date: '2026-10-20' }
      },
      p.person.key
    )
  ).body.data;
  week = (
    await timeCall(
      'POST',
      path,
      { action: 'submit', version: week.version, confirmed_human_time: true },
      p.person.key
    )
  ).body.data;
  expect(week.submission.over_cap).toBe(true);
  expect((await timeCall('POST', path, approval(week), p.owner.key)).body.error.code).toBe(
    'OVER_CAP_DECISION_REQUIRED'
  );
  const approved = (
    await timeCall('POST', path, { ...approval(week), over_cap_decision: 'approve' }, p.owner.key)
  ).body.data;
  expect(approved.approval.entries.map((e: any) => e.amount_minor)).toEqual([1502, 4002]);
  expect(
    (
      await timeCall(
        'POST',
        `${p.root}/terms`,
        { ...term, version: 3, effective_from: '2026-10-21', rate_minor_per_hour: 9001 },
        p.owner.key
      )
    ).status
  ).toBe(201);
  const report = (
    await timeCall('GET', `${p.root}/report?from=2026-10-19&to=2026-10-19`, undefined, p.person.key)
  ).body.data;
  expect(report.combined.amounts).toEqual([
    { currency: 'EUR', minor_unit_scale: 2, amount_minor: 5504 }
  ]);
  expect(report.combined.approved_minutes).toBe(210);
});

test('history migration preserves existing rows, reasons and timestamps', async () => {
  expect(
    await DB.prepare("SELECT * FROM project_history WHERE id = 'migration_history'").first()
  ).toEqual({
    id: 'migration_history',
    workspace_id: 'migration_ws',
    project_id: 'migration_project',
    actor_user_id: 'migration_user',
    change_type: 'UPDATED',
    change_reason: 'scope_change',
    from_value_json: '{"name":"old"}',
    to_value_json: '{"name":"new"}',
    metadata_json: '{"source":"fixture"}',
    created_at: '2025-01-01 00:00:00'
  });
});

test('member removal rolls back tasks and access on audit failure, then revokes review access permanently', async () => {
  const p = await timePilot();
  const week = await draftWithEntries(p);
  expect(
    (
      await timeCall(
        'PUT',
        `${p.root}/approvers/${p.person.id}`,
        { version: 1, enabled: true },
        p.owner.key
      )
    ).status
  ).toBe(200);
  await DB.prepare(
    "CREATE TRIGGER fail_remove_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'REMOVE_MEMBERSHIP' BEGIN SELECT RAISE(ABORT, 'test removal audit failure'); END"
  ).run();
  const path = `/v1/workspaces/${p.owner.workspace}/members/${p.person.id}?task_policy=unassign`;
  const log = console.error;
  let sawInjected = false;
  console.error = (...args) => {
    sawInjected ||= auditFailureLogged(args, 'test removal audit failure');
  };
  try {
    expect((await request('DELETE', path, undefined, p.owner.key)).status).toBe(500);
  } finally {
    console.error = log;
    await DB.prepare('DROP TRIGGER fail_remove_audit').run();
  }
  expect(sawInjected).toBe(true);
  expect(
    await DB.prepare('SELECT 1 FROM time_approvers WHERE workspace_id = ? AND user_id = ?')
      .bind(p.owner.workspace, p.person.id)
      .first()
  ).not.toBeNull();
  const task = p.projects[0].task;
  expect(
    (await request('GET', `/v1/tasks/${task.id}`, undefined, p.owner.key)).body.data
      .assignee_user_id
  ).toBe(p.person.id);
  expect(
    (await request('DELETE', path, undefined, p.owner.key)).body.data.affected_task_count
  ).toBe(2);
  const current = (await request('GET', `/v1/tasks/${task.id}`, undefined, p.owner.key)).body.data;
  expect(current.assignee_user_id).toBeNull();
  expect(current.version).toBe(task.version + 1);
  expect(
    (
      await DB.prepare(
        "SELECT count(*) AS n FROM task_history WHERE task_id = ? AND change_type = 'ASSIGNEE_CHANGED'"
      )
        .bind(task.id)
        .first<any>()
    ).n
  ).toBe(1);
  expect(
    (await timeCall('GET', `${p.root}/weeks/${week.id}`, undefined, p.person.key)).status
  ).toBe(404);
  // Owner retains submitted/work history even when a collaborator leaves.
  expect((await timeCall('GET', `${p.root}/weeks/${week.id}`, undefined, p.owner.key)).status).toBe(
    200
  );
  await invite(p.owner, p.person.email);
  expect(
    (
      await timeCall(
        'GET',
        `${p.root}/report?from=2026-10-19&to=2026-10-19&user_id=all`,
        undefined,
        p.person.key
      )
    ).status
  ).toBe(403);
});

test('approval permission and task references are rechecked inside the transaction', async () => {
  const p = await timePilot();
  let week = await draftWithEntries(p);
  const path = `${p.root}/weeks/${week.id}/actions`;
  const reviewer = await user();
  await invite(p.owner, reviewer.email);
  expect(
    (
      await timeCall(
        'PUT',
        `${p.root}/approvers/${reviewer.id}`,
        { version: 1, enabled: true },
        p.owner.key
      )
    ).status
  ).toBe(200);
  week = (
    await timeCall(
      'POST',
      path,
      { action: 'submit', version: week.version, confirmed_human_time: true },
      p.person.key
    )
  ).body.data;
  const db = beforeBatch(async () => {
    await DB.prepare('DELETE FROM time_approvers WHERE workspace_id = ? AND user_id = ?')
      .bind(p.owner.workspace, reviewer.id)
      .run();
  });
  expect(
    (
      await timeCall('POST', path, approval(week), reviewer.key, `revoked-${sequence++}`, {
        DB: db
      })
    ).status
  ).toBe(409);
  const racing = simultaneousBatches(2);
  const decisions = await Promise.all(
    [1, 2].map(() =>
      timeCall('POST', path, approval(week), p.owner.key, `decision-${sequence++}`, { DB: racing })
    )
  );
  expect(decisions.map((x) => x.status).sort()).toEqual([200, 409]);
  week = decisions.find((x) => x.status === 200)!.body.data;
  week = (
    await timeCall(
      'POST',
      path,
      { action: 'revise', version: week.version, reason: 'Correct work note' },
      p.person.key
    )
  ).body.data;
  const stale = beforeBatch(async () => {
    await DB.prepare('UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(week.entries[0].task_id)
      .run();
  });
  expect(
    (
      await timeCall(
        'POST',
        path,
        { action: 'submit', version: week.version, confirmed_human_time: true },
        p.person.key,
        `stale-task-${sequence++}`,
        { DB: stale }
      )
    ).status
  ).toBe(409);
  expect(
    (await timeCall('GET', `${p.root}/weeks/${week.id}`, undefined, p.person.key)).body.data.state
  ).toBe('draft');
});

test('time week list uses stable cursors and enforces bounded exports', async () => {
  const p = await timePilot();
  const first = await draftWithEntries(p);
  const second = await draftWithEntries(p, '2026-10-26');
  const range = `${p.root}/weeks?from=2026-10-19&to=2026-10-26&limit=1`;
  const page = (await timeCall('GET', range, undefined, p.person.key)).body.data;
  expect(page.weeks.map((w: any) => w.id)).toEqual([first.id]);
  expect(page.pagination.has_more).toBe(true);
  const next = (
    await timeCall(
      'GET',
      `${range}&cursor=${encodeURIComponent(page.pagination.next_cursor)}`,
      undefined,
      p.person.key
    )
  ).body.data;
  expect(next.weeks.map((w: any) => w.id)).toEqual([second.id]);
  expect(next.pagination.has_more).toBe(false);
  expect((await timeCall('GET', `${range}&cursor=invalid`, undefined, p.person.key)).status).toBe(
    400
  );
  expect(
    (
      await timeCall(
        'GET',
        `${p.root}/export.csv?from=2020-01-01&to=2026-10-26`,
        undefined,
        p.person.key
      )
    ).status
  ).toBe(400);
});

test('new task assignments cannot race member removal into orphaned work or false history', async () => {
  for (const creating of [true, false]) {
    const owner = await user();
    const person = await user();
    await invite(owner, person.email);
    const path = `/v1/workspaces/${owner.workspace}/tasks`;
    const task = creating
      ? null
      : (await request('POST', path, { title: 'Unassigned' }, owner.key)).body.data;
    const db = beforeBatch(async () => {
      await DB.prepare('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?')
        .bind(owner.workspace, person.id)
        .run();
    });
    const result = await request(
      creating ? 'POST' : 'PATCH',
      creating ? path : `/v1/tasks/${task.id}`,
      {
        title: 'Late assignment',
        assignee_user_id: person.id,
        ...(task ? { version: task.version } : {})
      },
      owner.key,
      false,
      { DB: db }
    );
    expect(result.status).toBe(409);
    expect(
      (
        await DB.prepare(
          'SELECT count(*) AS n FROM tasks WHERE workspace_id = ? AND assignee_user_id = ?'
        )
          .bind(owner.workspace, person.id)
          .first<any>()
      ).n
    ).toBe(0);
    expect(
      (
        await DB.prepare('SELECT count(*) AS n FROM task_history WHERE workspace_id = ?')
          .bind(owner.workspace)
          .first<any>()
      ).n
    ).toBe(creating ? 0 : 1);
    expect(
      (
        await DB.prepare(
          'SELECT count(*) AS n FROM audit_logs WHERE workspace_id = ? AND action = ?'
        )
          .bind(owner.workspace, creating ? 'CREATE_TASK' : 'UPDATE_TASK')
          .first<any>()
      ).n
    ).toBe(0);
  }
});

test('a concurrent review grant cannot survive member removal and re-add', async () => {
  const p = await timePilot();
  const db = beforeBatch(async () => {
    await DB.prepare('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?')
      .bind(p.owner.workspace, p.person.id)
      .run();
  });
  expect(
    (
      await timeCall(
        'PUT',
        `${p.root}/approvers/${p.person.id}`,
        { version: 1, enabled: true },
        p.owner.key,
        `late-grant-${sequence++}`,
        { DB: db }
      )
    ).status
  ).toBe(409);
  expect(
    await DB.prepare('SELECT 1 FROM time_approvers WHERE workspace_id = ? AND user_id = ?')
      .bind(p.owner.workspace, p.person.id)
      .first()
  ).toBeNull();
  await invite(p.owner, p.person.email);
  expect(
    (
      await timeCall(
        'GET',
        `${p.root}/report?from=2026-10-19&to=2026-10-19&user_id=all`,
        undefined,
        p.person.key
      )
    ).status
  ).toBe(403);
});

async function delivery(
  p: Awaited<ReturnType<typeof timePilot>>,
  task: any,
  body: any,
  key = p.owner.key,
  overrides = {},
  idem = `delivery-${sequence++}`
) {
  return timeCall(
    'PUT',
    `/v1/tasks/${task.id}/delivery`,
    { version: task.version, reason: 'Synthetic delivery decision', ...body },
    key,
    idem,
    overrides
  );
}
async function readyTask(p: Awaited<ReturnType<typeof timePilot>>, index = 0) {
  const task =
    index < 2
      ? p.projects[index].task
      : (
          await request(
            'POST',
            `/v1/workspaces/${p.owner.workspace}/tasks`,
            {
              title: `Alternative ${index}`,
              project_id: p.projects[index % 2].project.id,
              assignee_user_id: p.person.id
            },
            p.owner.key
          )
        ).body.data;
  const result = await delivery(p, task, {
    stage: 'READY',
    reviewer_user_id: p.owner.id,
    details: readyDetails
  });
  expect(result.status).toBe(200);
  return result.body.data;
}
async function queue(p: Awaited<ReturnType<typeof timePilot>>) {
  return request(
    'GET',
    `/v1/workspaces/${p.owner.workspace}/delivery/queue?user_id=${p.person.id}`,
    undefined,
    p.owner.key
  );
}

test('delivery lifecycle separates readiness, active work, review, verification and release facts', async () => {
  const p = await timePilot();
  expect(
    (await request('GET', `/v1/tasks/${p.projects[0].task.id}/delivery`, undefined, p.owner.key))
      .body.data.stage
  ).toBe('BACKLOG');
  expect((await delivery(p, p.projects[0].task, { stage: 'READY' })).body.error.code).toBe(
    'NOT_READY'
  );
  let first = await readyTask(p, 0);
  const second = await readyTask(p, 1);
  await readyTask(p, 2);
  first = (await delivery(p, first, { stage: 'ACTIVE' }, p.person.key)).body.data;
  let q = (await queue(p)).body.data;
  expect(q.active.map((x: any) => x.id)).toEqual([first.id]);
  expect(q.ready_alternatives).toHaveLength(2);
  expect(q.missing_ready_alternatives).toBe(0);
  expect((await delivery(p, second, { stage: 'ACTIVE' }, p.person.key)).body.error.code).toBe(
    'ACTIVE_TASK_LIMIT'
  );
  expect((await delivery(p, first, { stage: 'BLOCKED' }, p.person.key)).body.error.code).toBe(
    'BLOCKER_REQUIRED'
  );
  first = (
    await delivery(
      p,
      first,
      {
        stage: 'BLOCKED',
        blocker: {
          owner_user_id: p.owner.id,
          reason: 'Need backend contract clarification',
          next_action: 'Confirm response shape'
        }
      },
      p.person.key
    )
  ).body.data;
  expect(first.blocker.owner_user_id).toBe(p.owner.id);
  let active = (await delivery(p, second, { stage: 'ACTIVE' }, p.person.key)).body.data;
  expect((await delivery(p, active, { stage: 'DONE' }, p.person.key)).body.error.code).toBe(
    'INVALID_TRANSITION'
  );
  expect((await delivery(p, active, { stage: 'REVIEW' }, p.person.key)).body.error.code).toBe(
    'EVIDENCE_REQUIRED'
  );
  active = (
    await delivery(
      p,
      active,
      {
        stage: 'REVIEW',
        details: { source_complete: true, evidence: ['https://example.com/synthetic/pr'] }
      },
      p.person.key
    )
  ).body.data;
  expect((await delivery(p, active, { stage: 'VERIFY' }, p.person.key)).status).toBe(403);
  expect((await delivery(p, active, { reviewer_user_id: p.person.id }, p.person.key)).status).toBe(
    403
  );
  active = (await delivery(p, active, { stage: 'VERIFY' })).body.data;
  expect((await delivery(p, active, { stage: 'DONE' })).body.error.code).toBe(
    'VERIFICATION_REQUIRED'
  );
  active = (await delivery(p, active, { stage: 'DONE', details: { verification_passed: true } }))
    .body.data;
  expect(active.status).toBe('DONE');
  expect(active.details.source_complete).toBe(true);
  expect(active.details.deployed).toBe(false);
  expect(active.details.device_accepted).toBe(false);
  q = (await queue(p)).body.data;
  expect(q.active).toHaveLength(0);
  expect(q.blocked.map((x: any) => x.id)).toContain(first.id);
  expect(q.missing_ready_alternatives).toBe(1);
  const history = (await request('GET', `/v1/tasks/${active.id}/history`, undefined, p.owner.key))
    .body.data.history;
  expect(history.some((e: any) => e.to_value?.stage === 'VERIFY' && e.metadata?.reason)).toBe(true);
});

test('delivery dependency links reject foreign tasks, self links and cycles, including concurrent opposite links', async () => {
  const p = await timePilot();
  const [a, b] = p.projects.map((x) => x.task);
  const foreign = await timePilot();
  expect((await delivery(p, a, { depends_on: [foreign.projects[0].task.id] })).status).toBe(400);
  expect((await delivery(p, a, { depends_on: [a.id] })).status).toBe(400);
  const db = simultaneousBatches(2);
  const results = await Promise.all([
    delivery(p, a, { depends_on: [b.id] }, p.owner.key, { DB: db }),
    delivery(p, b, { depends_on: [a.id] }, p.owner.key, { DB: db })
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    (
      await DB.prepare('SELECT count(*) AS n FROM task_dependencies WHERE workspace_id=?')
        .bind(p.owner.workspace)
        .first<any>()
    ).n
  ).toBe(1);
  const loser = results[0].status === 409 ? a : b;
  const target = loser.id === a.id ? b : a;
  expect((await delivery(p, loser, { depends_on: [target.id] })).body.error.code).toBe(
    'DEPENDENCY_CYCLE'
  );
});

test('delivery readiness tracks reopened and deleted dependencies without treating review or archive as done', async () => {
  const p = await timePilot();
  let dependency = p.projects[1].task;
  let task = (
    await delivery(p, p.projects[0].task, {
      depends_on: [dependency.id],
      reviewer_user_id: p.owner.id,
      details: readyDetails
    })
  ).body.data;
  expect((await delivery(p, task, { stage: 'READY' })).body.error.code).toBe('NOT_READY');
  dependency = (
    await request(
      'PATCH',
      `/v1/tasks/${dependency.id}`,
      { version: dependency.version, status: 'DONE' },
      p.owner.key
    )
  ).body.data;
  task = (await delivery(p, task, { stage: 'READY' })).body.data;
  expect(task.can_start).toBe(true);
  dependency = (
    await request(
      'PATCH',
      `/v1/tasks/${dependency.id}`,
      { version: dependency.version, status: 'TODO' },
      p.owner.key
    )
  ).body.data;
  const q = (await queue(p)).body.data;
  expect(q.ready_alternatives).toHaveLength(0);
  expect(q.blocked[0].readiness_issues).toContain('unfinished_dependencies');
  expect((await delivery(p, task, { stage: 'ACTIVE' })).body.error.code).toBe('NOT_READY');
  await request(
    'PATCH',
    `/v1/tasks/${dependency.id}`,
    { version: dependency.version, status: 'DONE' },
    p.owner.key
  );
  await request('DELETE', `/v1/tasks/${dependency.id}`, undefined, p.owner.key);
  expect(
    (await request('GET', `/v1/tasks/${task.id}/delivery`, undefined, p.owner.key)).body.data
      .depends_on[0].satisfied
  ).toBe(false);
  expect((await delivery(p, task, { stage: 'ACTIVE' })).status).toBe(400);
});

test('delivery simultaneous starts across projects have one winner and preserve exact history', async () => {
  const p = await timePilot();
  const tasks = [await readyTask(p, 0), await readyTask(p, 1)];
  const db = simultaneousBatches(2);
  const results = await Promise.all(
    tasks.map((t) => delivery(p, t, { stage: 'ACTIVE' }, p.person.key, { DB: db }))
  );
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await queue(p)).body.data.active).toHaveLength(1);
  expect(
    (
      await DB.prepare(
        "SELECT count(*) AS n FROM task_history WHERE workspace_id=? AND json_extract(to_value_json,'$.stage')='ACTIVE'"
      )
        .bind(p.owner.workspace)
        .first<any>()
    ).n
  ).toBe(1);
});

test('delivery active limit also covers legacy creation, patch, restore and member reassignment', async () => {
  const p = await timePilot();
  const path = `/v1/workspaces/${p.owner.workspace}/tasks`;
  const first = (
    await request(
      'POST',
      path,
      { title: 'Existing active', status: 'IN_PROGRESS', assignee_user_id: p.person.id },
      p.owner.key
    )
  ).body.data;
  expect(
    (
      await request(
        'POST',
        path,
        { title: 'Second active', status: 'IN_PROGRESS', assignee_user_id: p.person.id },
        p.owner.key
      )
    ).status
  ).toBe(409);
  expect(
    (
      await request(
        'PATCH',
        `/v1/tasks/${p.projects[0].task.id}`,
        { version: 1, status: 'IN_PROGRESS' },
        p.owner.key
      )
    ).status
  ).toBe(409);
  let ready = await readyTask(p);
  expect((await delivery(p, ready, { stage: 'ACTIVE' })).status).toBe(409);
  await request('DELETE', `/v1/tasks/${first.id}`, undefined, p.owner.key);
  ready = (await delivery(p, ready, { stage: 'ACTIVE' })).body.data;
  expect(
    (await request('POST', `/v1/tasks/${first.id}/restore`, undefined, p.owner.key)).status
  ).toBe(409);
  const replacement = await user();
  await invite(p.owner, replacement.email);
  expect(
    (
      await request(
        'POST',
        path,
        { title: 'Replacement active', status: 'IN_PROGRESS', assignee_user_id: replacement.id },
        p.owner.key
      )
    ).status
  ).toBe(201);
  expect(
    (
      await request(
        'DELETE',
        `/v1/workspaces/${p.owner.workspace}/members/${p.person.id}?task_policy=reassign&reassign_to_user_id=${replacement.id}`,
        undefined,
        p.owner.key
      )
    ).status
  ).toBe(409);
  expect((await queue(p)).body.data.active[0].id).toBe(ready.id);
  expect(
    (
      await request(
        'DELETE',
        `/v1/workspaces/${p.owner.workspace}/members/${p.person.id}?task_policy=unassign`,
        undefined,
        p.owner.key
      )
    ).status
  ).toBe(200);
});

test('delivery access, stale writes, managed legacy updates and idempotent audit rollback', async () => {
  const p = await timePilot();
  const task = await readyTask(p);
  const stranger = await user();
  expect((await delivery(p, task, { stage: 'ACTIVE' }, stranger.key)).status).toBe(404);
  await request(
    'POST',
    `/v1/workspaces/${p.owner.workspace}/members`,
    { email: stranger.email, role: 'VIEWER' },
    p.owner.key
  );
  expect((await delivery(p, task, { stage: 'ACTIVE' }, stranger.key)).status).toBe(403);
  expect(
    (
      await request(
        'PATCH',
        `/v1/tasks/${task.id}`,
        { version: task.version, status: 'DONE' },
        p.person.key
      )
    ).body.error.code
  ).toBe('DELIVERY_MANAGED');
  expect((await delivery(p, { ...task, version: 1 }, { stage: 'ACTIVE' })).body.error.code).toBe(
    'VERSION_CONFLICT'
  );
  const idem = `delivery-retry-${sequence++}`;
  await DB.prepare(
    "CREATE TRIGGER fail_delivery_audit BEFORE INSERT ON audit_logs WHEN NEW.action='UPDATE_DELIVERY' BEGIN SELECT RAISE(ABORT,'test delivery audit failure'); END"
  ).run();
  const log = console.error;
  let injected = false;
  console.error = (...args) => {
    injected ||= auditFailureLogged(args, 'test delivery audit failure');
  };
  try {
    expect((await delivery(p, task, { stage: 'ACTIVE' }, p.person.key, {}, idem)).status).toBe(500);
  } finally {
    console.error = log;
    await DB.prepare('DROP TRIGGER fail_delivery_audit').run();
  }
  expect(injected).toBe(true);
  expect(
    (await request('GET', `/v1/tasks/${task.id}/delivery`, undefined, p.owner.key)).body.data
      .version
  ).toBe(task.version);
  expect(
    (
      await DB.prepare('SELECT count(*) AS n FROM delivery_operations WHERE idempotency_key=?')
        .bind(idem)
        .first<any>()
    ).n
  ).toBe(0);
  const db = simultaneousBatches(2);
  const results = await Promise.all(
    [1, 2].map(() => delivery(p, task, { stage: 'ACTIVE' }, p.person.key, { DB: db }, idem))
  );
  expect(results.map((r) => r.status)).toEqual([200, 200]);
  expect(results[0].body.data).toEqual(results[1].body.data);
  expect(
    (await delivery(p, task, { stage: 'BLOCKED' }, p.person.key, {}, idem)).body.error.code
  ).toBe('IDEMPOTENCY_CONFLICT');
});

test('delivery rechecks dependency and membership eligibility in the write transaction', async () => {
  const p = await timePilot();
  let dependency = p.projects[1].task;
  dependency = (
    await request(
      'PATCH',
      `/v1/tasks/${dependency.id}`,
      { version: 1, status: 'DONE' },
      p.owner.key
    )
  ).body.data;
  let task = await readyTask(p);
  task = (await delivery(p, task, { depends_on: [dependency.id] })).body.data;
  const db = beforeBatch(async () => {
    await DB.prepare("UPDATE tasks SET status='TODO' WHERE id=?").bind(dependency.id).run();
  });
  expect((await delivery(p, task, { stage: 'ACTIVE' }, p.person.key, { DB: db })).status).toBe(409);
  await DB.prepare("UPDATE tasks SET status='DONE' WHERE id=?").bind(dependency.id).run();
  const removed = beforeBatch(async () => {
    await DB.prepare('DELETE FROM memberships WHERE workspace_id=? AND user_id=?')
      .bind(p.owner.workspace, p.person.id)
      .run();
  });
  expect((await delivery(p, task, { stage: 'ACTIVE' }, p.person.key, { DB: removed })).status).toBe(
    409
  );
});

test('delivery rework clears build acceptance and legacy duplicate active work is preserved but flagged', async () => {
  const p = await timePilot();
  let task = await readyTask(p);
  task = (await delivery(p, task, { stage: 'ACTIVE' })).body.data;
  task = (
    await delivery(p, task, {
      stage: 'REVIEW',
      details: {
        source_complete: true,
        deployed: true,
        device_accepted: true,
        verification_passed: true,
        evidence: ['synthetic build'],
        build_ref: 'build-one'
      }
    })
  ).body.data;
  task = (await delivery(p, task, { stage: 'ACTIVE' })).body.data;
  expect(task.details).toMatchObject({
    source_complete: false,
    deployed: false,
    device_accepted: false,
    verification_passed: false,
    evidence: [],
    build_ref: ''
  });
  // Represents pre-migration data: do not silently pause or discard existing assignments.
  await DB.prepare("UPDATE tasks SET status='IN_PROGRESS' WHERE id=?")
    .bind(p.projects[1].task.id)
    .run();
  const q = (await queue(p)).body.data;
  expect(q.active).toHaveLength(2);
  expect(q.active_conflict).toBe(true);
  expect((await delivery(p, task, { details: { next_action: 'Still working' } })).status).toBe(409);
  expect(
    (
      await request(
        'PATCH',
        `/v1/tasks/${p.projects[1].task.id}`,
        { version: 1, status: 'TODO' },
        p.owner.key
      )
    ).status
  ).toBe(200);
});

test('delivery reviewed scope requires rework and contributors cannot record their own verification decision', async () => {
  const p = await timePilot();
  let task = await readyTask(p);
  task = (await delivery(p, task, { stage: 'ACTIVE' }, p.person.key)).body.data;
  task = (
    await delivery(
      p,
      task,
      { stage: 'REVIEW', details: { source_complete: true, evidence: ['source changes'] } },
      p.person.key
    )
  ).body.data;
  expect(
    (await delivery(p, task, { details: { verification_passed: true } }, p.person.key)).status
  ).toBe(403);
  expect(
    (await delivery(p, task, { details: { scope: 'Changed acceptance scope' } })).body.error.code
  ).toBe('REWORK_REQUIRED');
  task = (await delivery(p, task, { stage: 'VERIFY' })).body.data;
  task = (await delivery(p, task, { stage: 'DONE', details: { verification_passed: true } })).body
    .data;
  expect(
    (await delivery(p, task, { details: { evidence: ['Replacement evidence'] } })).body.error.code
  ).toBe('REWORK_REQUIRED');
  task = (await delivery(p, task, { stage: 'BACKLOG', details: { scope: 'New iteration' } })).body
    .data;
  expect(task.details.verification_passed).toBe(false);
  expect(task.details.evidence).toEqual([]);
});

test('delivery direct and managed starts share one atomic active slot', async () => {
  const p = await timePilot();
  const task = await readyTask(p);
  const db = simultaneousBatches(2);
  const results = await Promise.all([
    delivery(p, task, { stage: 'ACTIVE' }, p.person.key, { DB: db }),
    request(
      'POST',
      `/v1/workspaces/${p.owner.workspace}/tasks`,
      { title: 'Legacy concurrent start', status: 'IN_PROGRESS', assignee_user_id: p.person.id },
      p.owner.key,
      false,
      { DB: db }
    )
  ]);
  expect(results.filter((r) => [200, 201].includes(r.status))).toHaveLength(1);
  expect(results.filter((r) => r.status === 409)).toHaveLength(1);
  expect((await queue(p)).body.data.active).toHaveLength(1);
});

test('delivery deleted work remains recoverable after its assignee leaves', async () => {
  const p = await timePilot();
  let task = await readyTask(p);
  task = (await delivery(p, task, { stage: 'ACTIVE' })).body.data;
  await request('DELETE', `/v1/tasks/${task.id}`, undefined, p.owner.key);
  await request(
    'DELETE',
    `/v1/workspaces/${p.owner.workspace}/members/${p.person.id}?task_policy=unassign`,
    undefined,
    p.owner.key
  );
  expect(
    (await request('POST', `/v1/tasks/${task.id}/restore`, undefined, p.owner.key)).status
  ).toBe(409);
  const repaired = await request(
    'PATCH',
    `/v1/tasks/${task.id}`,
    { version: task.version + 1, assignee_user_id: p.owner.id },
    p.owner.key
  );
  expect(repaired.status).toBe(200);
  expect(
    (await request('POST', `/v1/tasks/${task.id}/restore`, undefined, p.owner.key)).status
  ).toBe(200);
  const restored = (await request('GET', `/v1/tasks/${task.id}/delivery`, undefined, p.owner.key))
    .body.data;
  expect(restored.id).toBe(task.id);
  expect(restored.assignee_user_id).toBe(p.owner.id);
  expect(restored.details).toEqual(task.details);
  expect(restored.version).toBe(task.version + 3);
});

test('delivery UI capabilities identify personal keys and current owner/delegate access', async () => {
  const p = await timePilot();
  const me = await request('GET', '/v1/me', undefined, p.person.key);
  expect(me.body.data.workspace_id).toBeNull();
  expect(
    (await timeCall('GET', `${p.root}/settings`, undefined, p.owner.key)).body.data.access
  ).toEqual({
    user_id: p.owner.id,
    can_approve: true,
    can_configure: true
  });
  expect(
    (await timeCall('GET', `${p.root}/settings`, undefined, p.person.key)).body.data.access
  ).toEqual({
    user_id: p.person.id,
    can_approve: false,
    can_configure: false
  });
  expect(
    (
      await timeCall(
        'PUT',
        `${p.root}/approvers/${p.person.id}`,
        { version: 1, enabled: true },
        p.owner.key
      )
    ).status
  ).toBe(200);
  expect(
    (await timeCall('GET', `${p.root}/settings`, undefined, p.person.key)).body.data.access
      .can_approve
  ).toBe(true);
  expect(
    (
      await timeCall(
        'PUT',
        `${p.root}/approvers/${p.person.id}`,
        { version: 2, enabled: false },
        p.owner.key
      )
    ).status
  ).toBe(200);
  expect(
    (await timeCall('GET', `${p.root}/settings`, undefined, p.person.key)).body.data.access
      .can_approve
  ).toBe(false);
  const scoped = await request(
    'POST',
    `/v1/workspaces/${p.owner.workspace}/api-keys`,
    { name: 'UI scoped fixture', scopes: ['workspace:read'] },
    p.owner.key
  );
  expect(
    (await request('GET', '/v1/me', undefined, scoped.body.data.api_key)).body.data.workspace_id
  ).toBe(p.owner.workspace);
  expect(
    (await timeCall('GET', `${p.root}/settings`, undefined, scoped.body.data.api_key)).status
  ).toBe(403);
});

const portfolioPath = '/v1/me/portfolio';
const portfolioWeek = `${portfolioPath}?week_start_date=2026-10-19`;
const portfolioGet = (key: string) => request('GET', portfolioWeek, undefined, key);
const portfolioPut = (
  key: string,
  body: unknown,
  idem = `portfolio-${sequence++}`,
  overrides = {}
) => timeCall('PUT', portfolioPath, body, key, idem, overrides);

test('portfolio zero days and pause/resume preserve tasks, queues, deadlines and approved hours', async () => {
  const p = await timePilot();
  let task = await readyTask(p);
  task = (await delivery(p, task, { stage: 'ACTIVE' })).body.data;
  await readyTask(p, 1);
  await readyTask(p, 2);
  await readyTask(p, 3);
  let week = await draftWithEntries(p);
  week = (
    await timeCall(
      'POST',
      `${p.root}/weeks/${week.id}/actions`,
      { action: 'submit', version: week.version, confirmed_human_time: true },
      p.person.key
    )
  ).body.data;
  week = (await timeCall('POST', `${p.root}/weeks/${week.id}/actions`, approval(week), p.owner.key))
    .body.data;
  const beforeTask = await DB.prepare('SELECT * FROM tasks WHERE id=?').bind(task.id).first();
  const beforeWeek = await DB.prepare('SELECT * FROM time_weeks WHERE id=?').bind(week.id).first();
  const initial = (await portfolioGet(p.person.key)).body.data;
  expect(initial.project_ids).toEqual([]);
  expect(initial.active_priority).toBeNull();
  const change = {
    version: 0,
    project_ids: p.projects.map((p) => p.project.id),
    focus_task_id: task.id,
    paused: true,
    resume_note: 'Continue the existing offline check',
    availability: [
      { date: '2026-10-19', minutes: 0 },
      { date: '2026-10-20', minutes: 0 },
      { date: '2026-10-21', minutes: 0 },
      { date: '2026-10-22', minutes: 120 },
      { date: '2026-10-23', minutes: 30 }
    ]
  };
  expect((await portfolioPut(p.person.key, change)).status).toBe(200);
  let view = (await portfolioGet(p.person.key)).body.data;
  expect(view.active_priority.id).toBe(task.id);
  expect(view.ready_alternatives).toHaveLength(2);
  expect(view.ready_count).toBe(3);
  expect(view.paused).toBe(true);
  expect(view.availability.map((d: any) => d.minutes)).toEqual([0, 0, 0, 120, 30, null, null]);
  expect(
    (
      await portfolioPut(p.person.key, {
        version: 1,
        paused: false,
        availability: [{ date: '2026-10-23', minutes: null }]
      })
    ).status
  ).toBe(200);
  view = (await portfolioGet(p.person.key)).body.data;
  expect(view.paused).toBe(false);
  expect(view.resume_note).toBe(change.resume_note);
  expect(view.availability[4].minutes).toBeNull();
  expect(view.active_priority).not.toHaveProperty('overdue');
  expect(await DB.prepare('SELECT * FROM tasks WHERE id=?').bind(task.id).first()).toEqual(
    beforeTask
  );
  expect(await DB.prepare('SELECT * FROM time_weeks WHERE id=?').bind(week.id).first()).toEqual(
    beforeWeek
  );
  expect((await queue(p)).body.data.active[0].id).toBe(task.id);
  expect(view.availability_is_not_logged_time).toBe(true);
});

test('portfolio references multiple workspaces without moving tasks or hiding active conflicts', async () => {
  const p = await timePilot(false);
  let first = await readyTask(p);
  first = (await delivery(p, first, { stage: 'ACTIVE' })).body.data;
  const other = await user();
  await invite(other, p.person.email);
  const project = (
    await request(
      'POST',
      `/v1/workspaces/${other.workspace}/projects`,
      { name: 'Liquicity' },
      other.key
    )
  ).body.data;
  const created = (
    await request(
      'POST',
      `/v1/workspaces/${other.workspace}/tasks`,
      {
        title: 'Existing Liquicity task',
        project_id: project.id,
        assignee_user_id: p.person.id,
        status: 'IN_PROGRESS'
      },
      other.key
    )
  ).body.data;
  const original = await DB.prepare('SELECT * FROM tasks WHERE id=?').bind(created.id).first();
  expect(
    (
      await portfolioPut(p.person.key, {
        version: 0,
        project_ids: [p.projects[0].project.id, project.id],
        focus_task_id: created.id
      })
    ).status
  ).toBe(200);
  const view = (await portfolioGet(p.person.key)).body.data;
  expect(view.active_priority.id).toBe(created.id);
  expect(view.other_active.map((t: any) => t.id)).toEqual([first.id]);
  expect(view.active_conflict).toBe(true);
  expect(await DB.prepare('SELECT * FROM tasks WHERE id=?').bind(created.id).first()).toEqual(
    original
  );
  expect((await portfolioGet(other.key)).body.data.project_ids).toEqual([]);
  expect(
    (await request('GET', `${portfolioWeek}&user_id=${p.person.id}`, undefined, other.key)).status
  ).toBe(400);
});

test('portfolio authorization rejects foreign references, workspace keys and revoked selections', async () => {
  const p = await timePilot(false);
  const stranger = await user();
  expect((await request('GET', portfolioWeek)).status).toBe(401);
  expect(
    (await portfolioPut(stranger.key, { version: 0, project_ids: [p.projects[0].project.id] }))
      .status
  ).toBe(409);
  const scoped = (
    await request(
      'POST',
      `/v1/workspaces/${p.owner.workspace}/api-keys`,
      { name: 'Scoped', scopes: ['workspace:read', 'workspace:write'] },
      p.owner.key
    )
  ).body.data.api_key;
  expect((await portfolioGet(scoped)).status).toBe(403);
  expect((await portfolioPut(scoped, { version: 0, paused: false })).status).toBe(403);
  const t = await readyTask(p);
  const task = (await delivery(p, t, { stage: 'ACTIVE' })).body.data;
  expect(
    (
      await portfolioPut(p.person.key, {
        version: 0,
        project_ids: [p.projects[0].project.id],
        focus_task_id: task.id
      })
    ).status
  ).toBe(200);
  await DB.prepare("UPDATE memberships SET role='VIEWER' WHERE workspace_id=? AND user_id=?")
    .bind(p.owner.workspace, p.person.id)
    .run();
  const view = (await portfolioGet(p.person.key)).body.data;
  expect(view.project_ids).toEqual([]);
  expect(view.active_priority).toBeNull();
  expect(view.progress).toEqual([]);
  expect((await portfolioPut(p.person.key, { version: 1, focus_task_id: task.id })).status).toBe(
    409
  );
  expect(
    (
      await portfolioPut(p.person.key, {
        version: 1,
        availability: [{ date: '2026-10-19', minutes: 0 }]
      })
    ).status
  ).toBe(200);
  const race = await timePilot(false);
  const db = beforeBatch(async () => {
    await DB.prepare('DELETE FROM memberships WHERE workspace_id=? AND user_id=?')
      .bind(race.owner.workspace, race.person.id)
      .run();
  });
  expect(
    (
      await portfolioPut(
        race.person.key,
        { version: 0, project_ids: [race.projects[0].project.id] },
        `portfolio-revoke-${sequence++}`,
        { DB: db }
      )
    ).status
  ).toBe(409);
  expect((await portfolioGet(race.person.key)).body.data.version).toBe(0);
});

test('portfolio validation bounds capacity and rejects ambiguous calendar/user inputs', async () => {
  const p = await timePilot(false);
  for (const minutes of [-1, 121, 1.5, '60'])
    expect(
      (
        await portfolioPut(p.person.key, {
          version: 0,
          availability: [{ date: '2026-10-19', minutes }]
        })
      ).status
    ).toBe(400);
  for (const body of [
    { availability: [{ date: '2026-02-30', minutes: 0 }] },
    {
      availability: [
        { date: '2026-10-19', minutes: 0 },
        { date: '2026-10-19', minutes: 20 }
      ]
    },
    { timezone: 'Not/AZone' },
    { project_ids: [p.projects[0].project.id, p.projects[0].project.id] },
    { user_id: p.owner.id },
    { paused: true, resume_note: '' }
  ])
    expect((await portfolioPut(p.person.key, { version: 0, ...body })).status).toBe(400);
  for (const query of [
    '',
    '?week_start_date=2026-10-20',
    '?week_start_date=2026-10-19&week_start_date=2026-10-19'
  ])
    expect((await request('GET', portfolioPath + query, undefined, p.person.key)).status).toBe(400);
  expect(dateInZone('2026-10-25 23:30:00', 'Europe/Amsterdam')).toBe('2026-10-26');
  expect(dateInZone('2026-10-25 00:30:00', 'Europe/Amsterdam')).toBe('2026-10-25');
});

test('portfolio concurrent saves and duplicate retries have one atomic winner and audit', async () => {
  const p = await timePilot(false);
  const db = simultaneousBatches(2);
  const writes = await Promise.all(
    [0, 120].map((minutes) =>
      portfolioPut(
        p.person.key,
        { version: 0, availability: [{ date: '2026-10-19', minutes }] },
        `portfolio-race-${sequence++}`,
        { DB: db }
      )
    )
  );
  expect(writes.map((w) => w.status).sort()).toEqual([200, 409]);
  const body = { version: 1, paused: true, resume_note: 'Resume from the same task' };
  const idem = `portfolio-same-${sequence++}`;
  const same = simultaneousBatches(2);
  const retries = await Promise.all(
    [1, 2].map(() => portfolioPut(p.person.key, body, idem, { DB: same }))
  );
  expect(retries.map((r) => r.status)).toEqual([200, 200]);
  expect(retries[0].body.data).toEqual(retries[1].body.data);
  expect((await portfolioPut(p.person.key, body, idem)).body.data).toEqual(retries[0].body.data);
  expect((await portfolioPut(p.person.key, { ...body, paused: false }, idem)).body.error.code).toBe(
    'IDEMPOTENCY_CONFLICT'
  );
  expect(
    (
      await DB.prepare(
        "SELECT count(*) AS n FROM audit_logs WHERE actor_user_id=? AND action='UPDATE_PERSONAL_PORTFOLIO'"
      )
        .bind(p.person.id)
        .first<any>()
    ).n
  ).toBe(2);
});

test('portfolio audit failure rolls back preferences, availability and receipt', async () => {
  const p = await timePilot(false);
  const idem = `portfolio-rollback-${sequence++}`;
  const body = { version: 0, availability: [{ date: '2026-10-19', minutes: 120 }] };
  await DB.prepare(
    "CREATE TRIGGER fail_portfolio BEFORE INSERT ON audit_logs WHEN NEW.action='UPDATE_PERSONAL_PORTFOLIO' BEGIN SELECT RAISE(ABORT,'portfolio audit fixture'); END"
  ).run();
  const log = console.error;
  console.error = () => {};
  try {
    expect((await portfolioPut(p.person.key, body, idem)).status).toBe(500);
  } finally {
    console.error = log;
    await DB.prepare('DROP TRIGGER fail_portfolio').run();
  }
  expect((await portfolioGet(p.person.key)).body.data.version).toBe(0);
  expect(
    await DB.prepare('SELECT 1 FROM personal_availability WHERE user_id=?')
      .bind(p.person.id)
      .first()
  ).toBeNull();
  expect(
    await DB.prepare('SELECT 1 FROM personal_portfolio_operations WHERE idempotency_key=?')
      .bind(idem)
      .first()
  ).toBeNull();
  expect((await portfolioPut(p.person.key, body, idem)).status).toBe(200);
});

test('portfolio weekly progress includes completed work and uses its own local calendar', async () => {
  const p = await timePilot(false);
  const task = await readyTask(p);
  await portfolioPut(p.person.key, { version: 0, project_ids: [p.projects[0].project.id] });
  await DB.prepare("UPDATE task_history SET created_at='2026-10-18 22:30:00' WHERE task_id=?")
    .bind(task.id)
    .run();
  await DB.prepare("UPDATE tasks SET status='DONE',delivery_state='DONE' WHERE id=?")
    .bind(task.id)
    .run();
  const view = (await portfolioGet(p.person.key)).body.data;
  expect(view.progress.length).toBeGreaterThan(0);
  expect(view.progress.every((e: any) => e.date === '2026-10-19')).toBe(true);
  expect(view.progress.some((e: any) => e.task_id === task.id)).toBe(true);
  expect(
    await DB.prepare('SELECT 1 FROM time_settings WHERE workspace_id=?')
      .bind(p.owner.workspace)
      .first()
  ).toBeNull();
});
