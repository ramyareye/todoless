import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const API_BASE_URL = (process.env.TODOLESS_API_BASE_URL || 'https://todoless-api.formahsa.workers.dev').replace(/\/+$/, '');

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
  const email = `mcp-validate+${Date.now()}@example.com`;
  const response = await fetch(`${API_BASE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, workspace_name: 'MCP Validate' }),
  });

  const payload = await response.json();
  if (!payload?.success) {
    throw new Error(`Register failed: ${JSON.stringify(payload)}`);
  }

  return {
    workspaceId: payload.data.workspace.id,
    apiKey: payload.data.api_key,
  };
}

async function main() {
  const { workspaceId, apiKey } = await registerUser();

  const client = new Client(
    { name: 'todoless-mcp-validator', version: '0.1.0' },
    { capabilities: {} }
  );

  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['run', 'start'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      TODOLESS_API_BASE_URL: API_BASE_URL,
      TODOLESS_API_KEY: apiKey,
    },
  });

  await client.connect(transport);

  const tools = await client.listTools();
  const names = new Set((tools.tools || []).map((t) => t.name));
  assert(names.has('projects.list'), 'Missing tool projects.list');
  assert(names.has('tasks.list'), 'Missing tool tasks.list');
  assert(names.has('tasks.create'), 'Missing tool tasks.create');
  assert(names.has('tasks.update'), 'Missing tool tasks.update');

  const projectListResult = await client.callTool({
    name: 'projects.list',
    arguments: { workspace_id: workspaceId },
  });
  const projectsPayload = parseToolJson(projectListResult);
  assert(Array.isArray(projectsPayload.projects), 'projects.list returned invalid payload');

  const createTaskResult = await client.callTool({
    name: 'tasks.create',
    arguments: {
      workspace_id: workspaceId,
      title: 'Validate MCP tasks.create',
      priority: 'P1',
    },
  });
  const createdTask = parseToolJson(createTaskResult);
  assert(typeof createdTask.id === 'string', 'tasks.create did not return task id');
  assert(typeof createdTask.version === 'number', 'tasks.create did not return version');

  const listTaskResult = await client.callTool({
    name: 'tasks.list',
    arguments: {
      workspace_id: workspaceId,
      limit: 10,
    },
  });
  const tasksPayload = parseToolJson(listTaskResult);
  assert(Array.isArray(tasksPayload.tasks), 'tasks.list returned invalid payload');

  const updateTaskResult = await client.callTool({
    name: 'tasks.update',
    arguments: {
      task_id: createdTask.id,
      version: createdTask.version,
      status: 'IN_PROGRESS',
      change_reason: 'manual',
    },
  });
  const updatedTask = parseToolJson(updateTaskResult);
  assert(updatedTask.status === 'IN_PROGRESS', 'tasks.update did not update status');

  await client.close();

  console.log('MCP validate success');
  console.log(`workspace_id=${workspaceId}`);
  console.log(`task_id=${createdTask.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
