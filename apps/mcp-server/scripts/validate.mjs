import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const API_BASE_URL = (process.env.TODOLESS_API_BASE_URL || 'http://127.0.0.1:8787').replace(
  /\/+$/,
  ''
);

function validationTransport(apiKey) {
  if (process.env.TODOLESS_MCP_VALIDATE_URL) {
    const url = new URL(process.env.TODOLESS_MCP_VALIDATE_URL);
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'HTTP validation is local only');
    return new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${apiKey}` } }
    });
  }
  return new StdioClientTransport({
    command: 'bun', args: ['run', 'start'], cwd: process.cwd(),
    env: { ...process.env, TODOLESS_API_BASE_URL: API_BASE_URL, TODOLESS_API_KEY: apiKey }
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseToolJson(result) {
  const text = result?.content?.[0]?.text;
  if (!text) {
    throw new Error('Tool result missing text content');
  }
  return JSON.parse(text);
}

async function registerUser() {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(API_BASE_URL).hostname)) {
    throw new Error('Validation creates synthetic records and is restricted to a local test API');
  }
  const email = `mcp-validate+${Date.now()}@example.com`;
  const response = await fetch(`${API_BASE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, workspace_name: 'MCP Validate' })
  });

  const payload = await response.json();
  if (!payload?.success) {
    throw new Error(`Register failed: ${JSON.stringify(payload)}`);
  }

  const verified = await fetch(`${API_BASE_URL}/v1/auth/verify-email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verification_token: payload.data.verification_token })
  });
  const identity = await verified.json();
  assert(
    identity.success && identity.data.api_key,
    'Local verification failed; use ENVIRONMENT=dev with synthetic accounts'
  );
  return {
    workspaceId: payload.data.workspace.id,
    apiKey: identity.data.api_key,
    userId: identity.data.user.id
  };
}

async function main() {
  const { workspaceId, apiKey, userId: ownerUserId } = await registerUser();

  const client = new Client(
    { name: 'todoless-mcp-validator', version: '0.1.0' },
    { capabilities: {} }
  );

  const transport = validationTransport(apiKey);

  await client.connect(transport);

  const tools = await client.listTools();
  const names = new Set((tools.tools || []).map((t) => t.name));
  for (const name of [
    'onboarding.get',
    'members.project_access.get',
    'members.project_access.set',
    'time.entry.save',
    'time.week.submit',
    'time.week.approve',
    'delivery.get',
    'delivery.update',
    'delivery.queue',
    'portfolio.get',
    'portfolio.update',
    'time.week.return',
    'time.export_csv'
  ])
    assert(names.has(name), `Missing ${name}`);
  const timeSettings = parseToolJson(
    await client.callTool({
      name: 'time.settings.configure',
      arguments: {
        workspace_id: workspaceId,
        version: 0,
        timezone: 'Europe/Amsterdam',
        week_start: 1,
        confirmed: true,
        idempotency_key: `config-${Date.now()}`
      }
    })
  );
  assert(timeSettings.version === 1, 'MCP time settings failed');
  const week = parseToolJson(
    await client.callTool({
      name: 'time.week.create',
      arguments: {
        workspace_id: workspaceId,
        week_start_date: '2026-10-19',
        idempotency_key: `week-${Date.now()}`
      }
    })
  );
  assert(week.state === 'draft', 'MCP week create failed');
  const csv = parseToolJson(
    await client.callTool({
      name: 'time.export_csv',
      arguments: { workspace_id: workspaceId, from: '2026-10-19', to: '2026-10-19' }
    })
  );
  assert(csv.format === 'csv' && csv.csv.startsWith('week_id,'), 'MCP CSV failed');
  assert(names.has('workspaces.list'), 'Missing tool workspaces.list');
  assert(names.has('workspaces.get'), 'Missing tool workspaces.get');
  assert(names.has('members.list'), 'Missing tool members.list');
  assert(names.has('members.add'), 'Missing tool members.add');
  assert(names.has('members.remove'), 'Missing tool members.remove');
  assert(names.has('projects.list'), 'Missing tool projects.list');
  assert(names.has('projects.create'), 'Missing tool projects.create');
  assert(names.has('projects.get'), 'Missing tool projects.get');
  assert(names.has('projects.update'), 'Missing tool projects.update');
  assert(names.has('projects.delete'), 'Missing tool projects.delete');
  assert(names.has('tasks.list'), 'Missing tool tasks.list');
  assert(names.has('tasks.get'), 'Missing tool tasks.get');
  assert(names.has('tasks.history'), 'Missing tool tasks.history');
  assert(names.has('tasks.create'), 'Missing tool tasks.create');
  assert(names.has('tasks.update'), 'Missing tool tasks.update');
  assert(names.has('tasks.delete'), 'Missing tool tasks.delete');
  assert(names.has('tasks.restore'), 'Missing tool tasks.restore');

  const workspaceListResult = await client.callTool({
    name: 'workspaces.list',
    arguments: { limit: 10 }
  });
  const workspaceListPayload = parseToolJson(workspaceListResult);
  assert(
    Array.isArray(workspaceListPayload.workspaces),
    'workspaces.list returned invalid payload'
  );

  const projectListResult = await client.callTool({
    name: 'projects.list',
    arguments: { workspace_id: workspaceId }
  });
  const projectsPayload = parseToolJson(projectListResult);
  assert(Array.isArray(projectsPayload.projects), 'projects.list returned invalid payload');

  const createProjectResult = await client.callTool({
    name: 'projects.create',
    arguments: {
      workspace_id: workspaceId,
      name: 'Validate MCP Project',
      description: 'Created by MCP validate'
    }
  });
  const createdProject = parseToolJson(createProjectResult);
  assert(typeof createdProject.id === 'string', 'projects.create did not return project id');

  const getProjectResult = await client.callTool({
    name: 'projects.get',
    arguments: { project_id: createdProject.id }
  });
  const projectPayload = parseToolJson(getProjectResult);
  assert(projectPayload.id === createdProject.id, 'projects.get returned wrong project');

  const createTaskResult = await client.callTool({
    name: 'tasks.create',
    arguments: {
      workspace_id: workspaceId,
      title: 'Validate MCP tasks.create',
      project_id: createdProject.id,
      priority: 'P1'
    }
  });
  const createdTask = parseToolJson(createTaskResult);
  assert(typeof createdTask.id === 'string', 'tasks.create did not return task id');
  assert(typeof createdTask.version === 'number', 'tasks.create did not return version');

  const getTaskResult = await client.callTool({
    name: 'tasks.get',
    arguments: { task_id: createdTask.id }
  });
  const taskPayload = parseToolJson(getTaskResult);
  assert(taskPayload.id === createdTask.id, 'tasks.get returned wrong task');

  const listTaskResult = await client.callTool({
    name: 'tasks.list',
    arguments: {
      workspace_id: workspaceId,
      limit: 10
    }
  });
  const tasksPayload = parseToolJson(listTaskResult);
  assert(Array.isArray(tasksPayload.tasks), 'tasks.list returned invalid payload');

  const updateTaskResult = await client.callTool({
    name: 'tasks.update',
    arguments: {
      task_id: createdTask.id,
      version: createdTask.version,
      status: 'IN_PROGRESS',
      change_reason: 'manual'
    }
  });
  const updatedTask = parseToolJson(updateTaskResult);
  assert(updatedTask.status === 'IN_PROGRESS', 'tasks.update did not update status');

  const taskHistoryResult = await client.callTool({
    name: 'tasks.history',
    arguments: {
      task_id: createdTask.id,
      limit: 10
    }
  });
  const historyPayload = parseToolJson(taskHistoryResult);
  assert(Array.isArray(historyPayload.history), 'tasks.history returned invalid payload');

  const memberEmail = `mcp-member+${Date.now()}@example.com`;
  const addMemberResult = await client.callTool({
    name: 'members.add',
    arguments: {
      workspace_id: workspaceId,
      email: memberEmail,
      role: 'MEMBER'
    }
  });
  const memberPayload = parseToolJson(addMemberResult);
  assert(typeof memberPayload.user_id === 'string', 'members.add did not return user_id');

  // Two identities, two projects, one submission: exercise the actual MCP transport.
  const claimedResponse = await fetch(`${API_BASE_URL}/v1/auth/claim-invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invite_token: memberPayload.invite_token })
  });
  const claimed = await claimedResponse.json();
  assert(claimed.success && claimed.data.api_key, 'Synthetic contributor claim failed');
  const contributor = new Client(
    { name: 'todoless-contributor-validator', version: '0.1.0' },
    { capabilities: {} }
  );
  const contributorTransport = validationTransport(claimed.data.api_key);
  await contributor.connect(contributorTransport);
  let operation = 0;
  const call = async (actor, name, args = {}) =>
    parseToolJson(
      await actor.callTool({
        name,
        arguments: {
          ...(name.startsWith('portfolio.') ||
          (name.startsWith('delivery.') && name !== 'delivery.queue')
            ? {}
            : { workspace_id: workspaceId }),
          ...args
        }
      })
    );
  const write = (actor, name, args) =>
    call(actor, name, { ...args, idempotency_key: `mcp-pilot-${Date.now()}-${operation++}` });
  try {
    const deliveryTasks = [];
    const grow = await call(client, 'projects.create', { name: 'Grow synthetic pilot' });
    const veloura = await call(client, 'projects.create', { name: 'Veloura synthetic pilot' });
    let sheet = await write(contributor, 'time.week.create', { week_start_date: '2026-10-19' });
    for (const [project, minutes] of [
      [grow, 90],
      [veloura, 120]
    ]) {
      const task = await call(client, 'tasks.create', {
        title: 'Active device QA',
        project_id: project.id,
        assignee_user_id: memberPayload.user_id
      });
      deliveryTasks.push(task);
      sheet = await write(contributor, 'time.entry.save', {
        week_id: sheet.id,
        version: sheet.version,
        entry: {
          project_id: project.id,
          task_id: task.id,
          work_date: '2026-10-19',
          activity: 'qa',
          minutes,
          note: 'Synthetic human-entered QA fixture'
        }
      });
      assert(sheet.state === 'draft', 'MCP manual entry failed');
    }
    sheet = await write(contributor, 'time.week.submit', {
      week_id: sheet.id,
      version: sheet.version,
      confirmed_human_time: true
    });
    sheet = await write(client, 'time.week.return', {
      week_id: sheet.id,
      version: sheet.version,
      reason: 'Synthetic request to clarify evidence'
    });
    sheet = await write(contributor, 'time.week.revise', {
      week_id: sheet.id,
      version: sheet.version,
      reason: 'Evidence clarified'
    });
    sheet = await write(contributor, 'time.week.submit', {
      week_id: sheet.id,
      version: sheet.version,
      confirmed_human_time: true
    });
    sheet = await write(client, 'time.week.approve', {
      week_id: sheet.id,
      version: sheet.version,
      entries: sheet.entries.map((e) => ({ entry_id: e.id, approved_minutes: e.minutes }))
    });
    assert(
      sheet.state === 'approved' && sheet.payment_status === 'manual_unrecorded',
      'MCP approval failed'
    );
    const range = { from: '2026-10-19', to: '2026-10-19', user_id: memberPayload.user_id };
    const totals = await call(client, 'time.report', range);
    assert(
      totals.combined.submitted_minutes === 210 && totals.combined.approved_minutes === 210,
      'MCP combined totals differ'
    );
    assert(
      totals.projects
        .map((p) => p.approved_minutes)
        .sort((a, b) => a - b)
        .join(',') === '90,120',
      'MCP project totals differ'
    );
    assert(totals.combined.amounts.length === 0, 'MCP inferred commercial terms');
    const exported = await call(client, 'time.export_csv', range);
    assert(exported.csv.trim().split('\r\n').length === 3, 'MCP CSV row count differs');
    assert(
      sheet.entries.every((e) => exported.csv.includes(`"${e.id}"`)),
      'MCP CSV missing approved entries'
    );
    const history = await call(client, 'time.week.history', { week_id: sheet.id });
    assert(
      history.events.some((e) => e.action === 'request_changes') &&
        history.events.at(-1).action === 'approve',
      'MCP audit trail missing'
    );
    console.log(
      'Synthetic Grow 90 + Veloura 120 = 210 minutes: one submission, return/revise, owner approval, report and CSV matched.'
    );
    deliveryTasks.push(
      await call(client, 'tasks.create', {
        title: 'Ready alternative',
        project_id: grow.id,
        assignee_user_id: memberPayload.user_id
      })
    );
    const ready = [];
    for (const task of deliveryTasks) {
      ready.push(
        await write(client, 'delivery.update', {
          task_id: task.id,
          version: task.version,
          reason: 'Prepare bounded fixture work',
          stage: 'READY',
          reviewer_user_id: ownerUserId,
          details: {
            area: 'app',
            repository: 'https://example.com/synthetic/repo',
            outcome: 'Complete fixture flow',
            scope: 'One bounded change',
            base_ref: 'synthetic-base',
            environment: 'local fixture',
            next_action: 'Implement acceptance checks',
            contract_refs: ['docs/contracts.md'],
            acceptance_checks: ['Complete fixture flow'],
            setup_ready: true,
            integration_mode: 'fixture',
            exclusions: ['Live backend integration excluded']
          }
        })
      );
    }
    let active = await write(contributor, 'delivery.update', {
      task_id: ready[0].id,
      version: ready[0].version,
      reason: 'Start selected work',
      stage: 'ACTIVE'
    });
    const personQueue = await call(client, 'delivery.queue', { user_id: memberPayload.user_id });
    assert(
      personQueue.active.length === 1 && personQueue.ready_alternatives.length === 2,
      'MCP delivery queue did not select one active and two ready'
    );
    let portfolio = await call(contributor, 'portfolio.get', { week_start_date: '2026-10-19' });
    await write(contributor, 'portfolio.update', {
      version: portfolio.version,
      project_ids: [grow.id, veloura.id],
      focus_task_id: active.id,
      paused: true,
      resume_note: 'Resume with the fixture acceptance checks',
      availability: [
        { date: '2026-10-19', minutes: 0 },
        { date: '2026-10-20', minutes: 0 },
        { date: '2026-10-21', minutes: 120 }
      ]
    });
    portfolio = await call(contributor, 'portfolio.get', { week_start_date: '2026-10-19' });
    assert(
      portfolio.active_priority.id === active.id &&
        portfolio.ready_alternatives.length === 2 &&
        portfolio.paused,
      'MCP portfolio lost the selected task or alternatives'
    );
    assert(
      portfolio.availability
        .slice(0, 4)
        .map((d) => d.minutes)
        .join(',') === '0,0,120,',
      'MCP capacity confused zero and unset'
    );
    await write(contributor, 'portfolio.update', { version: portfolio.version, paused: false });
    const resumed = await call(contributor, 'portfolio.get', { week_start_date: '2026-10-19' });
    assert(
      !resumed.paused &&
        resumed.resume_note === portfolio.resume_note &&
        resumed.active_priority.version === active.version,
      'MCP resume changed task/evidence or lost context'
    );
    console.log(
      'Personal portfolio MCP: one priority/two alternatives, zero days, pause/resume context; task and time records unchanged.'
    );
    active = await write(contributor, 'delivery.update', {
      task_id: active.id,
      version: active.version,
      reason: 'Implementation ready for review',
      stage: 'REVIEW',
      details: { source_complete: true, evidence: ['https://example.com/synthetic/evidence'] }
    });
    active = await write(client, 'delivery.update', {
      task_id: active.id,
      version: active.version,
      reason: 'Source reviewed; run acceptance',
      stage: 'VERIFY'
    });
    active = await write(client, 'delivery.update', {
      task_id: active.id,
      version: active.version,
      reason: 'Acceptance checks passed',
      stage: 'DONE',
      details: { verification_passed: true }
    });
    const done = await call(contributor, 'delivery.get', { task_id: active.id });
    assert(
      done.stage === 'DONE' &&
        done.details.deployed === false &&
        done.details.device_accepted === false,
      'MCP completion confused acceptance and release facts'
    );
    const dependent = await write(client, 'delivery.update', {
      task_id: ready[1].id,
      version: ready[1].version,
      reason: 'Follow the completed prerequisite',
      depends_on: [done.id]
    });
    assert(
      dependent.depends_on.length === 1 && dependent.depends_on[0].satisfied,
      'MCP dependency update/readiness failed'
    );
    console.log(
      'Synthetic delivery queue: one active + two ready alternatives; Review -> Verify -> Done passed without inferring deployment.'
    );
  } finally {
    await contributor.close();
  }

  const listMembersResult = await client.callTool({
    name: 'members.list',
    arguments: {
      workspace_id: workspaceId,
      limit: 10
    }
  });
  const membersPayload = parseToolJson(listMembersResult);
  assert(Array.isArray(membersPayload.members), 'members.list returned invalid payload');

  const removeMemberResult = await client.callTool({
    name: 'members.remove',
    arguments: {
      workspace_id: workspaceId,
      user_id: memberPayload.user_id,
      task_policy: 'unassign'
    }
  });
  const removedMember = parseToolJson(removeMemberResult);
  assert(removedMember.removed === true, 'members.remove did not remove member');

  const deleteTaskResult = await client.callTool({
    name: 'tasks.delete',
    arguments: { task_id: createdTask.id }
  });
  const deletedTask = parseToolJson(deleteTaskResult);
  assert(deletedTask.deleted === true, 'tasks.delete did not delete task');

  const restoreTaskResult = await client.callTool({
    name: 'tasks.restore',
    arguments: { task_id: createdTask.id }
  });
  const restoredTask = parseToolJson(restoreTaskResult);
  assert(restoredTask.restored === true, 'tasks.restore did not restore task');

  const updateProjectResult = await client.callTool({
    name: 'projects.update',
    arguments: {
      project_id: createdProject.id,
      name: 'Validate MCP Project Updated'
    }
  });
  const updatedProject = parseToolJson(updateProjectResult);
  assert(
    updatedProject.name === 'Validate MCP Project Updated',
    'projects.update did not update project'
  );

  const deleteProjectResult = await client.callTool({
    name: 'projects.delete',
    arguments: { project_id: createdProject.id }
  });
  const deletedProject = parseToolJson(deleteProjectResult);
  assert(deletedProject.deleted === true, 'projects.delete did not delete project');

  await client.close();

  console.log('MCP validate success');
  console.log(`workspace_id=${workspaceId}`);
  console.log(`task_id=${createdTask.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
