import { beforeAll, afterAll, test, expect } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import sourceApp from '../src/index';
import sourceRecovery from '../src/recovery';
import { issueApiKey } from '../src/services/api-keys';
import { createTodolessMcpServer } from '../../mcp-server/src/mcp-server.mjs';

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
const recovery = exactRelease
  ? (await import(`../.dist/${releaseDirectory}/recovery.mjs`)).default
  : sourceRecovery;

const wrangler = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare } = wrangler('miniflare');
const sdk = createRequire(
  new URL('../../mcp-server/package.json', import.meta.url)
);
const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = sdk('@modelcontextprotocol/sdk/inMemory.js');
const runtime = new Miniflare({
  modules: true,
  script:
    'export default {fetch(){return new Response("synthetic ACL fixture")}}',
  d1Databases: ['DB'],
  d1Persist: false,
  host: '127.0.0.1',
  port: 0
});
let DB: D1Database;
const pepper = 'synthetic-project-access-test-only';
let sequence = 0;
let legacyBefore: unknown;
const legacySnapshot = async () => ({
  tasks: (
    await DB.prepare("SELECT * FROM tasks WHERE workspace_id='legacy_ws'").all()
  ).results,
  history: (
    await DB.prepare(
      "SELECT * FROM task_history WHERE workspace_id='legacy_ws'"
    ).all()
  ).results,
  projects: (
    await DB.prepare(
      "SELECT * FROM projects WHERE workspace_id='legacy_ws'"
    ).all()
  ).results,
  members: (
    await DB.prepare(
      "SELECT * FROM memberships WHERE workspace_id='legacy_ws'"
    ).all()
  ).results
});
beforeAll(async () => {
  DB = await runtime.getD1Database('DB');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(directory))
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (file === '0010_project_access.sql') {
      await DB.batch([
        DB.prepare(
          "INSERT INTO users(id,email,email_verified_at) VALUES('legacy_user','legacy@example.com',CURRENT_TIMESTAMP)"
        ),
        DB.prepare(
          "INSERT INTO workspaces(id,slug,name,created_by_user_id) VALUES('legacy_ws','legacy-acl','Legacy','legacy_user')"
        ),
        DB.prepare(
          "INSERT INTO memberships(id,workspace_id,user_id,role) VALUES('legacy_member','legacy_ws','legacy_user','OWNER')"
        ),
        DB.prepare(
          "INSERT INTO projects(id,workspace_id,name) VALUES('legacy_project','legacy_ws','Existing project')"
        ),
        DB.prepare(
          "INSERT INTO tasks(id,workspace_id,project_id,title,version,metadata_json) VALUES('legacy_task','legacy_ws','legacy_project','Keep exact existing task',7,'{\"external_id\":\"VE-A05\"}')"
        ),
        DB.prepare(
          "INSERT INTO task_history(id,workspace_id,task_id,change_type,from_value_json,to_value_json) VALUES('legacy_history','legacy_ws','legacy_task','UPDATED','{\"old\":1}','{\"new\":2}')"
        )
      ]);
      legacyBefore = await legacySnapshot();
    }
    const sql = await readFile(new URL(file, directory), 'utf8');
    await DB.batch(
      sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => DB.prepare(s))
    );
  }
}, 20000);
afterAll(async () => runtime.dispose());

async function response(
  method: string,
  path: string,
  key: string,
  body?: unknown,
  headers: Record<string, string> = {},
  database = DB
) {
  const pending: Promise<unknown>[] = [];
  const result = await app.request(
    `http://localhost${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    },
    { DB: database, API_KEY_PEPPER: pepper, ENVIRONMENT: 'dev', ...protectionEnv },
    {
      waitUntil(p) {
        pending.push(p);
      },
      passThroughOnException() {}
    }
  );
  await Promise.all(pending);
  return result;
}
async function req(
  method: string,
  path: string,
  key: string,
  body?: unknown,
  headers: Record<string, string> = {},
  database = DB
) {
  const res = await response(method, path, key, body, headers, database);
  return { status: res.status, body: (await res.json()) as any };
}
type Actor = { id: string; key: string };
async function actor(
  id: string,
  ws: string,
  role: string,
  scoped = false
): Promise<Actor> {
  const key = await issueApiKey(
    { DB, API_KEY_PEPPER: pepper, ENVIRONMENT: 'dev' },
    { name: 'Synthetic fixture', scopes: ['*'] }
  );
  await DB.batch([
    DB.prepare(
      'INSERT INTO users(id,email,email_verified_at) VALUES(?,?,CURRENT_TIMESTAMP)'
    ).bind(id, `${id}@example.com`),
    DB.prepare(
      'INSERT INTO memberships(id,workspace_id,user_id,role) VALUES(?,?,?,?)'
    ).bind(`mem_${id}`, ws, id, role),
    DB.prepare(
      'INSERT INTO api_keys(id,workspace_id,created_by_user_id,name,key_prefix,key_hash,scopes_json) VALUES(?,?,?,?,?,?,?)'
    ).bind(
      key.id,
      scoped ? ws : null,
      id,
      key.name,
      key.keyPrefix,
      key.keyHash,
      JSON.stringify(key.scopes)
    )
  ]);
  return { id, key: key.raw };
}
async function fixture(restrict = true) {
  const id = ++sequence,
    ws = `ws_acl_${id}`,
    ownerId = `owner_${id}`;
  await DB.prepare(
    'INSERT INTO users(id,email,email_verified_at) VALUES(?,?,CURRENT_TIMESTAMP)'
  )
    .bind(ownerId, `${ownerId}@example.com`)
    .run();
  await DB.prepare(
    'INSERT INTO workspaces(id,slug,name,created_by_user_id) VALUES(?,?,?,?)'
  )
    .bind(ws, `acl-${id}`, 'Shared delivery', ownerId)
    .run();
  // Owner is created separately because the workspace FK needs its identity first.
  const ownerKey = await issueApiKey(
    { DB, API_KEY_PEPPER: pepper },
    { name: 'Synthetic owner', scopes: ['*'] }
  );
  await DB.batch([
    DB.prepare(
      "INSERT INTO memberships(id,workspace_id,user_id,role) VALUES(?,?,?,'OWNER')"
    ).bind(`mem_${ownerId}`, ws, ownerId),
    DB.prepare(
      'INSERT INTO api_keys(id,created_by_user_id,name,key_prefix,key_hash,scopes_json) VALUES(?,?,?,?,?,?)'
    ).bind(
      ownerKey.id,
      ownerId,
      ownerKey.name,
      ownerKey.keyPrefix,
      ownerKey.keyHash,
      '["*"]'
    )
  ]);
  const owner = { id: ownerId, key: ownerKey.raw },
    manager = await actor(`manager_${id}`, ws, 'MEMBER'),
    developer = await actor(`dev_${id}`, ws, 'MEMBER'),
    growOnly = await actor(`growmember_${id}`, ws, 'MEMBER');
  const grow = `grow_${id}`,
    front = `ve_front_${id}`,
    back = `ve_back_${id}`;
  await DB.batch([
    ...[
      [grow, 'GROW PRIVATE PROJECT'],
      [front, 'Veloura / Frontend'],
      [back, 'Veloura / Backend']
    ].map(([p, name]) =>
      DB.prepare(
        'INSERT INTO projects(id,workspace_id,name) VALUES(?,?,?)'
      ).bind(p, ws, name)
    ),
    DB.prepare(
      'INSERT INTO member_project_access(workspace_id,user_id,project_ids_json,version) VALUES(?,?,?,1)'
    ).bind(ws, growOnly.id, JSON.stringify([grow]))
  ]);
  if (restrict)
    expect(
      (await policy({ ws, owner, manager }, 0, [front, back])).status
    ).toBe(200);
  const tasks = [];
  for (const [p, title] of [
    [grow, 'GROW PRIVATE TITLE'],
    [front, 'VE-A04 current frontend'],
    [back, 'VE-B02 current backend']
  ]) {
    const created = await req('POST', `/v1/workspaces/${ws}/tasks`, owner.key, {
      title,
      project_id: p,
      assignee_user_id: developer.id
    });
    expect(created.status).toBe(201);
    tasks.push(created.body.data.id as string);
  }
  return { ws, owner, manager, developer, growOnly, grow, front, back, tasks };
}
async function policy(
  f: { ws: string; owner: Actor; manager: Actor },
  version: number,
  project_ids: string[] | null,
  key = `policy-${++sequence}`
) {
  return req(
    'PUT',
    `/v1/workspaces/${f.ws}/members/${f.manager.id}/project-access`,
    f.owner.key,
    { version, project_ids, reason: 'Explicit synthetic owner decision' },
    { 'idempotency-key': key }
  );
}
const details = {
  area: 'frontend',
  repository: 'https://example.com/synthetic',
  outcome: 'Bounded test flow',
  scope: 'One local task',
  base_ref: 'synthetic',
  environment: 'local fixture',
  next_action: 'Implement and test',
  contract_refs: ['docs/contract'],
  acceptance_checks: ['Fixture passes'],
  setup_ready: true,
  integration_mode: 'fixture',
  exclusions: ['No live acceptance']
};
async function delivery(
  f: Awaited<ReturnType<typeof fixture>>,
  index: number,
  key: string,
  body: Record<string, unknown>,
  idempotency = `delivery-${++sequence}`,
  database = DB
) {
  const current = await req(
    'GET',
    `/v1/tasks/${f.tasks[index]}/delivery`,
    f.owner.key
  );
  return req(
    'PUT',
    `/v1/tasks/${f.tasks[index]}/delivery`,
    key,
    {
      version: current.body.data.version,
      reason: 'Synthetic bounded update',
      ...body
    },
    { 'idempotency-key': idempotency },
    database
  );
}
async function state(task: string) {
  return {
    task: await DB.prepare('SELECT * FROM tasks WHERE id=?').bind(task).first(),
    history: (
      await DB.prepare('SELECT * FROM task_history WHERE task_id=? ORDER BY id')
        .bind(task)
        .all()
    ).results,
    audit: (
      await DB.prepare('SELECT * FROM audit_logs WHERE entity_id=? ORDER BY id')
        .bind(task)
        .all()
    ).results
  };
}

test('additive migration preserves task IDs, versions, metadata, memberships and complete history', async () => {
  expect(await legacySnapshot()).toEqual(legacyBefore);
  expect(
    (await DB.prepare('SELECT * FROM member_project_access').all()).results
  ).toEqual([]);
});
test('existing owner and unrestricted member retain complete project access', async () => {
  const f = await fixture();
  for (const user of [f.owner, f.developer]) {
    expect(
      (await req('GET', `/v1/workspaces/${f.ws}/projects`, user.key)).body.data
        .projects
    ).toHaveLength(3);
    expect((await req('GET', `/v1/tasks/${f.tasks[0]}`, user.key)).status).toBe(
      200
    );
  }
});
test('project and paginated task lists expose only Veloura, including assignee and forged project filters', async () => {
  const f = await fixture();
  const projects = await req(
    'GET',
    `/v1/workspaces/${f.ws}/projects`,
    f.manager.key
  );
  expect(projects.body.data.projects.map((p: any) => p.id).sort()).toEqual(
    [f.front, f.back].sort()
  );
  let cursor: string | undefined;
  const found = [];
  do {
    const page = await req(
      'GET',
      `/v1/workspaces/${f.ws}/tasks?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      f.manager.key
    );
    expect(page.status).toBe(200);
    expect(JSON.stringify(page.body)).not.toContain('GROW PRIVATE');
    found.push(...page.body.data.tasks);
    cursor = page.body.data.pagination.next_cursor;
  } while (cursor);
  expect(found).toHaveLength(2);
  expect(
    (
      await req(
        'GET',
        `/v1/workspaces/${f.ws}/tasks?project_id=${f.grow}&assignee_id=${f.developer.id}`,
        f.manager.key
      )
    ).body.data.tasks
  ).toEqual([]);
  expect(
    (
      await req(
        'GET',
        `/v1/workspaces/${f.ws}/tasks?include_deleted=true`,
        f.manager.key
      )
    ).status
  ).toBe(403);
});
test('guessed Grow IDs fail closed before detail, stale-version, history or mutation responses', async () => {
  const f = await fixture(),
    before = await state(f.tasks[0]);
  for (const [method, path, body] of [
    ['GET', `/v1/projects/${f.grow}`, undefined],
    ['PATCH', `/v1/projects/${f.grow}`, { name: 'leak' }],
    ['GET', `/v1/tasks/${f.tasks[0]}`, undefined],
    ['GET', `/v1/tasks/${f.tasks[0]}/history`, undefined],
    ['PATCH', `/v1/tasks/${f.tasks[0]}`, { version: 999, title: 'leak' }],
    ['DELETE', `/v1/tasks/${f.tasks[0]}`, undefined],
    ['GET', `/v1/tasks/${f.tasks[0]}/delivery`, undefined],
    [
      'PUT',
      `/v1/tasks/${f.tasks[0]}/delivery`,
      { version: 999, reason: 'leak' }
    ]
  ] as const) {
    const r = await req(method, path, f.manager.key, body, {
      'idempotency-key': `hidden-${++sequence}`
    });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain('GROW PRIVATE');
  }
  expect(await state(f.tasks[0])).toEqual(before);
});
test('manager creates managed Backlog and edits allowed task without changing existing records', async () => {
  const f = await fixture(),
    before = await state(f.tasks[0]);
  const created = await req(
    'POST',
    `/v1/workspaces/${f.ws}/tasks`,
    f.manager.key,
    {
      title: 'Manager request',
      project_id: f.front,
      assignee_user_id: f.developer.id
    }
  );
  expect(created.status).toBe(201);
  expect(created.body.data.delivery_state).toBe('BACKLOG');
  const id = created.body.data.id;
  expect(
    (
      await req('PATCH', `/v1/tasks/${id}`, f.manager.key, {
        version: 1,
        title: 'Clearer outcome'
      })
    ).status
  ).toBe(200);
  expect(
    (await req('GET', `/v1/tasks/${id}/history`, f.manager.key)).body.data
      .history
  ).toHaveLength(2);
  expect(
    (
      await req('PATCH', `/v1/tasks/${id}`, f.manager.key, {
        version: 2,
        status: 'DONE'
      })
    ).status
  ).toBe(409);
  expect(await state(f.tasks[0])).toEqual(before);
});
test('forged destination, parent, dependencies and unprojected tasks cannot reach Grow or escape review', async () => {
  const f = await fixture();
  for (const body of [
    { project_id: f.grow },
    {},
    { project_id: f.front, parent_task_id: f.tasks[0] },
    { project_id: f.front, status: 'DONE' }
  ]) {
    expect(
      (
        await req('POST', `/v1/workspaces/${f.ws}/tasks`, f.manager.key, {
          title: 'forged',
          ...body
        })
      ).status
    ).toBeOneOf([404, 409]);
  }
  expect(
    (
      await req('PATCH', `/v1/tasks/${f.tasks[1]}`, f.manager.key, {
        version: 1,
        project_id: f.grow
      })
    ).status
  ).toBe(404);
  expect(
    (
      await req('PATCH', `/v1/tasks/${f.tasks[1]}`, f.manager.key, {
        version: 1,
        parent_task_id: f.tasks[0]
      })
    ).status
  ).toBe(404);
  expect(
    (await delivery(f, 1, f.manager.key, { depends_on: [f.tasks[0]] })).status
  ).toBe(404);
  expect((await delivery(f, 1, f.manager.key, { stage: 'DONE' })).status).toBe(
    403
  );
  for (const flag of ['verification_passed', 'device_accepted', 'deployed']) {
    expect(
      (await delivery(f, 1, f.manager.key, { details: { [flag]: true } }))
        .status
    ).toBe(403);
  }
  expect(
    (await delivery(f, 1, f.manager.key, { reviewer_user_id: f.manager.id }))
      .status
  ).toBe(403);
});
test('visible frontend/backend dependencies and blocker updates work; owner review remains separate', async () => {
  const f = await fixture();
  const r = await delivery(f, 1, f.manager.key, {
    stage: 'BLOCKED',
    depends_on: [f.tasks[2]],
    blocker: {
      owner_user_id: f.owner.id,
      reason: 'Backend contract missing',
      next_action: 'Owner publishes contract'
    }
  });
  expect(r.status).toBe(200);
  expect(r.body.data.depends_on[0].id).toBe(f.tasks[2]);
  expect(
    (
      await delivery(f, 1, f.manager.key, {
        details: { next_action: 'Waiting for the documented backend response' }
      })
    ).status
  ).toBe(200);
  expect(
    (await req('GET', `/v1/tasks/${f.tasks[1]}/history`, f.manager.key)).body
      .data.history
  ).toHaveLength(3);
});
test('hidden dependency/parent identities are redacted, remain blocking and cannot be silently removed', async () => {
  const f = await fixture();
  await DB.batch([
    DB.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').bind(
      f.tasks[0],
      f.tasks[1]
    ),
    DB.prepare(
      'INSERT INTO task_dependencies(workspace_id,task_id,depends_on_task_id) VALUES(?,?,?)'
    ).bind(f.ws, f.tasks[1], f.tasks[0])
  ]);
  const card = await req(
    'GET',
    `/v1/tasks/${f.tasks[1]}/delivery`,
    f.manager.key
  );
  expect(card.body.data.depends_on).toEqual([]);
  expect(card.body.data.has_restricted_dependencies).toBe(true);
  expect(card.body.data.readiness_issues).toContain('unfinished_dependencies');
  expect(JSON.stringify(card.body)).not.toContain(f.tasks[0]);
  expect(
    (await req('GET', `/v1/tasks/${f.tasks[1]}`, f.manager.key)).body.data
      .parent_task_id
  ).toBe(null);
  expect((await delivery(f, 1, f.manager.key, { depends_on: [] })).status).toBe(
    403
  );
  const queue = await req(
    'GET',
    `/v1/workspaces/${f.ws}/delivery/queue?user_id=${f.developer.id}`,
    f.manager.key
  );
  expect(queue.status).toBe(200);
  expect(JSON.stringify(queue.body)).not.toContain('GROW PRIVATE');
  expect(JSON.stringify(queue.body)).not.toContain(f.tasks[0]);
});
test('moved task history stays intact for owner but is withheld when it contains a hidden project snapshot', async () => {
  const f = await fixture();
  expect(
    (
      await req('PATCH', `/v1/tasks/${f.tasks[0]}`, f.owner.key, {
        version: 1,
        project_id: f.front,
        title: 'Now shared'
      })
    ).status
  ).toBe(200);
  expect(
    (await req('GET', `/v1/tasks/${f.tasks[0]}`, f.manager.key)).status
  ).toBe(200);
  expect(
    (await req('GET', `/v1/tasks/${f.tasks[0]}/history`, f.manager.key)).status
  ).toBe(403);
  const history = await req(
    'GET',
    `/v1/tasks/${f.tasks[0]}/history`,
    f.owner.key
  );
  expect(history.body.data.history).toHaveLength(2);
  expect(JSON.stringify(history.body)).toContain('GROW PRIVATE');
});
test('member picker and assignment exclude people restricted to Grow; scoped keys cannot bypass policy', async () => {
  const f = await fixture();
  const members = await req(
    'GET',
    `/v1/workspaces/${f.ws}/members`,
    f.manager.key
  );
  expect(
    members.body.data.members.some((m: any) => m.user_id === f.growOnly.id)
  ).toBe(false);
  expect(
    members.body.data.members.some((m: any) => m.user_id === f.developer.id)
  ).toBe(true);
  expect(
    (
      await req('POST', `/v1/workspaces/${f.ws}/tasks`, f.manager.key, {
        title: 'Bad owner',
        project_id: f.front,
        assignee_user_id: f.growOnly.id
      })
    ).status
  ).toBe(400);
  expect(
    (
      await req('POST', `/v1/workspaces/${f.ws}/tasks`, f.owner.key, {
        title: 'Bad owner',
        project_id: f.grow,
        assignee_user_id: f.manager.id
      })
    ).status
  ).toBe(400);
  const key = await issueApiKey(
    { DB, API_KEY_PEPPER: pepper },
    { name: 'Second scoped key', scopes: ['*'] }
  );
  await DB.prepare(
    'INSERT INTO api_keys(id,workspace_id,created_by_user_id,name,key_prefix,key_hash,scopes_json) VALUES(?,?,?,?,?,?,?)'
  )
    .bind(
      key.id,
      f.ws,
      f.manager.id,
      key.name,
      key.keyPrefix,
      key.keyHash,
      '["*"]'
    )
    .run();
  expect((await req('GET', `/v1/tasks/${f.tasks[0]}`, key.raw)).status).toBe(
    404
  );
});
test('administration, time, exports and portfolio cannot leak Grow or grant new access', async () => {
  const f = await fixture();
  for (const [method, path, body] of [
    ['POST', `/v1/workspaces/${f.ws}/projects`, { name: 'Escape' }],
    [
      'POST',
      `/v1/workspaces/${f.ws}/members`,
      { email: 'never-sent@example.com', role: 'ADMIN' }
    ],
    [
      'PUT',
      `/v1/workspaces/${f.ws}/members/${f.manager.id}/project-access`,
      { version: 1, project_ids: null, reason: 'escape' }
    ],
    [
      'POST',
      `/v1/workspaces/${f.ws}/api-keys`,
      { name: 'escape', scopes: ['*'] }
    ],
    ['GET', `/v1/workspaces/${f.ws}/time/settings`, undefined],
    [
      'GET',
      `/v1/workspaces/${f.ws}/time/report?from=2026-10-19&to=2026-10-19`,
      undefined
    ],
    [
      'GET',
      `/v1/workspaces/${f.ws}/time/export.csv?from=2026-10-19&to=2026-10-19`,
      undefined
    ],
    ['GET', '/v1/me/portfolio?week_start_date=2026-10-19', undefined]
  ] as const) {
    const r = await req(method, path, f.manager.key, body, {
      'idempotency-key': `forbid-${++sequence}`
    });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain('GROW PRIVATE');
  }
});
test('policy changes are owner-only, versioned, audited, idempotent and empty means deny all', async () => {
  const f = await fixture();
  const key = `policy-race-${++sequence}`;
  const results = await Promise.all([
    policy(f, 1, [f.front], key),
    policy(f, 1, [f.back], `other-${key}`)
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  const audit = await DB.prepare(
    "SELECT * FROM audit_logs WHERE workspace_id=? AND action='SET_PROJECT_ACCESS'"
  )
    .bind(f.ws)
    .all();
  expect(audit.results).toHaveLength(2);
  expect((await policy(f, 2, [], `deny-${key}`)).status).toBe(200);
  expect(
    (await req('GET', `/v1/workspaces/${f.ws}/tasks`, f.manager.key)).body.data
      .tasks
  ).toEqual([]);
  expect(
    (await req('GET', `/v1/tasks/${f.tasks[1]}`, f.manager.key)).status
  ).toBe(404);
  expect((await policy(f, 3, null, `restore-${key}`)).status).toBe(200);
  expect(
    (await req('GET', `/v1/tasks/${f.tasks[0]}`, f.manager.key)).status
  ).toBe(200);
  expect((await policy(f, 3, null, `restore-${key}`)).status).toBe(200);
  expect((await policy(f, 4, [f.grow], `restore-${key}`)).status).toBe(409);
});
test('cached write response cannot cross a later access-policy revision', async () => {
  const f = await fixture(false),
    key = `old-cache-${++sequence}`;
  const body = {
    version: 1,
    reason: 'old unrestricted dependency result',
    depends_on: [f.tasks[0]]
  };
  expect(
    (
      await req(
        'PUT',
        `/v1/tasks/${f.tasks[1]}/delivery`,
        f.manager.key,
        body,
        { 'idempotency-key': key }
      )
    ).status
  ).toBe(200);
  expect((await policy(f, 0, [f.front, f.back])).status).toBe(200);
  const replay = await req(
    'PUT',
    `/v1/tasks/${f.tasks[1]}/delivery`,
    f.manager.key,
    body,
    { 'idempotency-key': key }
  );
  expect(replay.status).toBeOneOf([404, 409]);
  expect(JSON.stringify(replay.body)).not.toContain('GROW PRIVATE');
});
test('retry without explicit dependency IDs cannot replay a private pre-restriction response', async () => {
  const f = await fixture(false);
  expect(
    (await delivery(f, 1, f.owner.key, { depends_on: [f.tasks[0]] })).status
  ).toBe(200);
  const key = `cached-no-refs-${++sequence}`;
  const body = {
    version: 2,
    reason: 'Record old progress',
    details: { next_action: 'Wait for existing dependency' }
  };
  const saved = await req(
    'PUT',
    `/v1/tasks/${f.tasks[1]}/delivery`,
    f.manager.key,
    body,
    { 'idempotency-key': key }
  );
  expect(saved.status).toBe(200);
  expect(JSON.stringify(saved.body)).toContain('GROW PRIVATE');
  expect((await policy(f, 0, [f.front, f.back])).status).toBe(200);
  const replay = await req(
    'PUT',
    `/v1/tasks/${f.tasks[1]}/delivery`,
    f.manager.key,
    body,
    { 'idempotency-key': key }
  );
  expect(replay.status).toBe(409);
  expect(replay.body.error.code).toBe('ACCESS_CHANGED');
  expect(JSON.stringify(replay.body)).not.toContain('GROW PRIVATE');
});
test('access revocation between validation and commit prevents task/audit/history writes', async () => {
  for (const mode of ['legacy', 'delivery']) {
    const f = await fixture(),
      before = await state(f.tasks[1]);
    let intercepted = false;
    const wrapped = {
      prepare: DB.prepare.bind(DB),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!intercepted) {
          intercepted = true;
          expect((await policy(f, 1, [])).status).toBe(200);
        }
        return DB.batch(statements);
      }
    } as D1Database;
    const r =
      mode === 'legacy'
        ? await req(
            'PATCH',
            `/v1/tasks/${f.tasks[1]}`,
            f.manager.key,
            { version: 1, title: 'race' },
            {},
            wrapped
          )
        : await delivery(
            f,
            1,
            f.manager.key,
            { details: { next_action: 'race' } },
            `race-test-${++sequence}`,
            wrapped
          );
    expect(intercepted).toBe(true);
    expect(r.status).toBe(409);
    expect(await state(f.tasks[1])).toEqual(before);
  }
});
test('a dependency moved into Grow during validation cannot be linked by a restricted manager', async () => {
  const f = await fixture(),
    before = await state(f.tasks[1]);
  let intercepted = false;
  const wrapped = {
    prepare: DB.prepare.bind(DB),
    batch: async (statements: D1PreparedStatement[]) => {
      if (!intercepted) {
        intercepted = true;
        await DB.prepare(
          'UPDATE tasks SET project_id=?,version=version+1 WHERE id=?'
        )
          .bind(f.grow, f.tasks[2])
          .run();
      }
      return DB.batch(statements);
    }
  } as D1Database;
  expect(
    (
      await delivery(
        f,
        1,
        f.manager.key,
        { depends_on: [f.tasks[2]] },
        `moved-dep-${++sequence}`,
        wrapped
      )
    ).status
  ).toBe(409);
  expect(await state(f.tasks[1])).toEqual(before);
});
test('scoped invitation rechecks owner authority in its atomic batch and audit failure grants nothing', async () => {
  const f = await fixture();
  let intercepted = false;
  const email = `raced-invite-${++sequence}@example.com`;
  const wrapped = {
    prepare: DB.prepare.bind(DB),
    batch: async (statements: D1PreparedStatement[]) => {
      if (!intercepted) {
        intercepted = true;
        await DB.prepare(
          "UPDATE memberships SET role='MEMBER' WHERE workspace_id=? AND user_id=?"
        )
          .bind(f.ws, f.owner.id)
          .run();
      }
      return DB.batch(statements);
    }
  } as D1Database;
  expect(
    (
      await req(
        'POST',
        `/v1/workspaces/${f.ws}/members`,
        f.owner.key,
        { email, role: 'MEMBER', project_ids: [f.front] },
        {},
        wrapped
      )
    ).status
  ).toBe(409);
  expect(
    (
      await DB.prepare(
        'SELECT * FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.email=?'
      )
        .bind(f.ws, email)
        .all()
    ).results
  ).toEqual([]);
  expect(
    (
      await DB.prepare(
        'SELECT * FROM member_invites WHERE workspace_id=? AND email=?'
      )
        .bind(f.ws, email)
        .all()
    ).results
  ).toEqual([]);
  await DB.prepare(
    "UPDATE memberships SET role='OWNER' WHERE workspace_id=? AND user_id=?"
  )
    .bind(f.ws, f.owner.id)
    .run();
  const trigger = `invite_fail_${++sequence}`;
  await DB.prepare(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON member_project_access WHEN NEW.workspace_id='${f.ws}' BEGIN SELECT RAISE(ABORT,'synthetic grant failure'); END`
  ).run();
  try {
    expect(
      (
        await req('POST', `/v1/workspaces/${f.ws}/members`, f.owner.key, {
          email,
          role: 'MEMBER',
          project_ids: [f.front]
        })
      ).status
    ).toBe(500);
    expect(
      (
        await DB.prepare(
          'SELECT * FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.email=?'
        )
          .bind(f.ws, email)
          .all()
      ).results
    ).toEqual([]);
    expect(
      (
        await DB.prepare(
          'SELECT * FROM member_invites WHERE workspace_id=? AND email=?'
        )
          .bind(f.ws, email)
          .all()
      ).results
    ).toEqual([]);
  } finally {
    await DB.prepare(`DROP TRIGGER ${trigger}`).run();
  }
});
test('project-restricted viewers can read Veloura but cannot coordinate or change access', async () => {
  const f = await fixture();
  await DB.prepare(
    "UPDATE memberships SET role='VIEWER' WHERE workspace_id=? AND user_id=?"
  )
    .bind(f.ws, f.manager.id)
    .run();
  expect(
    (await req('GET', `/v1/tasks/${f.tasks[1]}`, f.manager.key)).status
  ).toBe(200);
  expect(
    (await req('GET', `/v1/tasks/${f.tasks[0]}`, f.manager.key)).status
  ).toBe(404);
  expect(
    (
      await req('POST', `/v1/workspaces/${f.ws}/tasks`, f.manager.key, {
        title: 'no write',
        project_id: f.front
      })
    ).status
  ).toBe(403);
  const onboarding = await req(
    'GET',
    `/v1/workspaces/${f.ws}/onboarding`,
    f.manager.key
  );
  expect(onboarding.body.data.can_manage_tasks).toBe(false);
});
test('reviewed work cannot be changed or approved through legacy routes by the manager', async () => {
  const f = await fixture();
  expect(
    (
      await delivery(f, 1, f.owner.key, {
        stage: 'READY',
        reviewer_user_id: f.owner.id,
        details
      })
    ).status
  ).toBe(200);
  expect(
    (await delivery(f, 1, f.manager.key, { stage: 'ACTIVE' })).status
  ).toBe(200);
  expect(
    (
      await delivery(f, 1, f.manager.key, {
        stage: 'REVIEW',
        details: {
          source_complete: true,
          evidence: ['synthetic source/test report']
        }
      })
    ).status
  ).toBe(200);
  const version = (await req('GET', `/v1/tasks/${f.tasks[1]}`, f.owner.key))
    .body.data.version;
  expect(
    (
      await req('PATCH', `/v1/tasks/${f.tasks[1]}`, f.manager.key, {
        version,
        title: 'Changed after review'
      })
    ).status
  ).toBe(409);
  expect(
    (
      await delivery(f, 1, f.manager.key, {
        stage: 'VERIFY',
        details: { verification_passed: true }
      })
    ).status
  ).toBe(403);
  expect((await delivery(f, 1, f.owner.key, { stage: 'VERIFY' })).status).toBe(
    200
  );
});
test('audit failure rolls back policy and operation response atomically', async () => {
  const f = await fixture();
  const trigger = `acl_fail_${++sequence}`;
  await DB.prepare(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_logs WHEN NEW.action='SET_PROJECT_ACCESS' AND NEW.workspace_id='${f.ws}' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`
  ).run();
  try {
    const r = await policy(f, 1, [f.front]);
    expect(r.status).toBe(500);
    expect(
      (
        (await DB.prepare(
          'SELECT version FROM member_project_access WHERE workspace_id=? AND user_id=?'
        )
          .bind(f.ws, f.manager.id)
          .first()) as any
      ).version
    ).toBe(1);
    expect(
      (await req('GET', `/v1/projects/${f.back}`, f.manager.key)).status
    ).toBe(200);
  } finally {
    await DB.prepare(`DROP TRIGGER ${trigger}`).run();
  }
});
test('synthetic restricted invitation grants no full-workspace interval; reinvite retains boundary', async () => {
  const f = await fixture();
  const email = `new-coordinator-${++sequence}@example.com`;
  const invited = await req(
    'POST',
    `/v1/workspaces/${f.ws}/members`,
    f.owner.key,
    { email, role: 'MEMBER', project_ids: [f.front, f.back] }
  );
  expect(invited.status).toBe(201);
  const claimed = await req('POST', '/v1/auth/claim-invite', '', {
    invite_token: invited.body.data.invite_token,
    display_name: 'Synthetic coordinator'
  });
  expect(claimed.status).toBe(201);
  const key = claimed.body.data.api_key;
  expect((await req('GET', `/v1/tasks/${f.tasks[0]}`, key)).status).toBe(404);
  expect(
    (
      await req('POST', `/v1/workspaces/${f.ws}/members`, f.owner.key, {
        email,
        role: 'MEMBER'
      })
    ).status
  ).toBe(201);
  expect((await req('GET', `/v1/tasks/${f.tasks[0]}`, key)).status).toBe(404);
  expect(
    (
      await req('POST', `/v1/workspaces/${f.ws}/members`, f.owner.key, {
        email,
        role: 'ADMIN'
      })
    ).status
  ).toBe(403);
  expect(
    (
      await req('POST', `/v1/workspaces/${f.ws}/members`, f.owner.key, {
        email: `${f.developer.id}@example.com`,
        role: 'MEMBER',
        project_ids: []
      })
    ).status
  ).toBe(409);
});
test('onboarding and real MCP transport enforce the same boundary without exposing credentials', async () => {
  const f = await fixture();
  const server = createTodolessMcpServer({
    apiBaseUrl: 'http://localhost',
    apiKey: f.manager.key,
    fetchFn: async (url: string, init: RequestInit) =>
      response(
        init.method!,
        new URL(url).pathname + new URL(url).search,
        f.manager.key,
        init.body ? JSON.parse(String(init.body)) : undefined,
        Object.fromEntries(new Headers(init.headers).entries())
      )
  });
  const client = new Client(
    { name: 'synthetic-manager', version: '1' },
    { capabilities: {} }
  );
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const parse = (r: any) => JSON.parse(r.content[0].text);
  try {
    const onboard = parse(await call('onboarding.get', { workspace_id: f.ws }));
    expect(onboard.access_mode).toBe('projects');
    expect(onboard.projects).toHaveLength(2);
    expect(JSON.stringify(onboard)).not.toContain('GROW PRIVATE');
    expect(JSON.stringify(onboard)).not.toContain(f.manager.key);
    const tools = await client.listTools();
    expect(
      tools.tools.some((t: any) => t.name === 'members.project_access.set')
    ).toBe(true);
    await expect(call('tasks.get', { task_id: f.tasks[0] })).rejects.toThrow(
      'NOT_FOUND'
    );
    const created = parse(
      await call('tasks.create', {
        workspace_id: f.ws,
        project_id: f.back,
        title: 'Plain-language manager request',
        assignee_user_id: f.developer.id
      })
    );
    expect(created.delivery_state).toBe('BACKLOG');
    expect(
      parse(await call('tasks.history', { task_id: created.id })).history
    ).toHaveLength(1);
    await expect(
      call('members.project_access.set', {
        workspace_id: f.ws,
        user_id: f.manager.id,
        version: 1,
        project_ids: null,
        reason: 'escape',
        idempotency_key: 'mcp-no-escalate'
      })
    ).rejects.toThrow('FORBIDDEN');
  } finally {
    await client.close();
    await server.close();
  }
});
test('owner MCP forwards the exact invite boundary, version and retry key', async () => {
  const f = await fixture();
  const server = createTodolessMcpServer({
    apiBaseUrl: 'http://localhost',
    apiKey: f.owner.key,
    fetchFn: async (url: string, init: RequestInit) =>
      response(
        init.method!,
        new URL(url).pathname + new URL(url).search,
        f.owner.key,
        init.body ? JSON.parse(String(init.body)) : undefined,
        Object.fromEntries(new Headers(init.headers).entries())
      )
  });
  const client = new Client(
    { name: 'synthetic-owner', version: '1' },
    { capabilities: {} }
  );
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(
      (await client.callTool({ name, arguments: args })).content[0].text
    );
  try {
    const ownPolicy = await call('members.project_access.get', {
      workspace_id: f.ws,
      user_id: f.manager.id
    });
    expect(ownPolicy.project_ids.sort()).toEqual([f.front, f.back].sort());
    const command = {
      workspace_id: f.ws,
      user_id: f.manager.id,
      version: 1,
      project_ids: [f.front],
      reason: 'Explicit synthetic narrowing',
      idempotency_key: 'mcp-owner-policy'
    };
    expect((await call('members.project_access.set', command)).version).toBe(2);
    expect((await call('members.project_access.set', command)).version).toBe(2);
    expect(
      (await req('GET', `/v1/projects/${f.back}`, f.manager.key)).status
    ).toBe(404);
    const email = `mcp-invite-${++sequence}@example.com`;
    const invite = await call('members.add', {
      workspace_id: f.ws,
      email,
      role: 'MEMBER',
      project_ids: [f.front, f.back]
    });
    const policy = (await DB.prepare(
      'SELECT project_ids_json FROM member_project_access WHERE workspace_id=? AND user_id=?'
    )
      .bind(f.ws, invite.user_id)
      .first()) as any;
    expect(JSON.parse(policy.project_ids_json)).toEqual([f.front, f.back]);
  } finally {
    await client.close();
    await server.close();
  }
});

test('schema-independent recovery withholds private data instead of reverting access controls', async () => {
  for (const [method, path] of [
    ['GET', '/v1/tasks/grow-private/history'],
    ['GET', '/v1/workspaces/shared/tasks'],
    ['PUT', '/v1/tasks/veloura/delivery']
  ]) {
    const result = recovery.fetch(
      new Request(`https://example.com${path}`, { method })
    );
    expect(result.status).toBe(503);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const body = (await result.json()) as any;
    expect(body.error.code).toBe('API_RECOVERY_MODE');
    expect(body.data).toBeUndefined();
  }
});
