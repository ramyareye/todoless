import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const API_BASE_URL = (
  process.env.TODOLESS_API_BASE_URL || "https://todoless.dev"
).replace(/\/+$/, "");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseToolJson(result) {
  const text = result?.content?.[0]?.text;
  if (!text) {
    throw new Error("Tool result missing text content");
  }
  return JSON.parse(text);
}

async function registerUser() {
  const email = `mcp-validate+${Date.now()}@example.com`;
  const response = await fetch(`${API_BASE_URL}/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, workspace_name: "MCP Validate" }),
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
    { name: "todoless-mcp-validator", version: "0.1.0" },
    { capabilities: {} },
  );

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", "start"],
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
  assert(names.has("workspaces.list"), "Missing tool workspaces.list");
  assert(names.has("workspaces.get"), "Missing tool workspaces.get");
  assert(names.has("members.list"), "Missing tool members.list");
  assert(names.has("members.add"), "Missing tool members.add");
  assert(names.has("members.remove"), "Missing tool members.remove");
  assert(names.has("projects.list"), "Missing tool projects.list");
  assert(names.has("projects.create"), "Missing tool projects.create");
  assert(names.has("projects.get"), "Missing tool projects.get");
  assert(names.has("projects.update"), "Missing tool projects.update");
  assert(names.has("projects.delete"), "Missing tool projects.delete");
  assert(names.has("tasks.list"), "Missing tool tasks.list");
  assert(names.has("tasks.get"), "Missing tool tasks.get");
  assert(names.has("tasks.history"), "Missing tool tasks.history");
  assert(names.has("tasks.create"), "Missing tool tasks.create");
  assert(names.has("tasks.update"), "Missing tool tasks.update");
  assert(names.has("tasks.delete"), "Missing tool tasks.delete");
  assert(names.has("tasks.restore"), "Missing tool tasks.restore");

  const workspaceListResult = await client.callTool({
    name: "workspaces.list",
    arguments: { limit: 10 },
  });
  const workspaceListPayload = parseToolJson(workspaceListResult);
  assert(
    Array.isArray(workspaceListPayload.workspaces),
    "workspaces.list returned invalid payload",
  );

  const projectListResult = await client.callTool({
    name: "projects.list",
    arguments: { workspace_id: workspaceId },
  });
  const projectsPayload = parseToolJson(projectListResult);
  assert(
    Array.isArray(projectsPayload.projects),
    "projects.list returned invalid payload",
  );

  const createProjectResult = await client.callTool({
    name: "projects.create",
    arguments: {
      workspace_id: workspaceId,
      name: "Validate MCP Project",
      description: "Created by MCP validate",
    },
  });
  const createdProject = parseToolJson(createProjectResult);
  assert(
    typeof createdProject.id === "string",
    "projects.create did not return project id",
  );

  const getProjectResult = await client.callTool({
    name: "projects.get",
    arguments: { project_id: createdProject.id },
  });
  const projectPayload = parseToolJson(getProjectResult);
  assert(
    projectPayload.id === createdProject.id,
    "projects.get returned wrong project",
  );

  const createTaskResult = await client.callTool({
    name: "tasks.create",
    arguments: {
      workspace_id: workspaceId,
      title: "Validate MCP tasks.create",
      project_id: createdProject.id,
      priority: "P1",
    },
  });
  const createdTask = parseToolJson(createTaskResult);
  assert(
    typeof createdTask.id === "string",
    "tasks.create did not return task id",
  );
  assert(
    typeof createdTask.version === "number",
    "tasks.create did not return version",
  );

  const getTaskResult = await client.callTool({
    name: "tasks.get",
    arguments: { task_id: createdTask.id },
  });
  const taskPayload = parseToolJson(getTaskResult);
  assert(taskPayload.id === createdTask.id, "tasks.get returned wrong task");

  const listTaskResult = await client.callTool({
    name: "tasks.list",
    arguments: {
      workspace_id: workspaceId,
      limit: 10,
    },
  });
  const tasksPayload = parseToolJson(listTaskResult);
  assert(
    Array.isArray(tasksPayload.tasks),
    "tasks.list returned invalid payload",
  );

  const updateTaskResult = await client.callTool({
    name: "tasks.update",
    arguments: {
      task_id: createdTask.id,
      version: createdTask.version,
      status: "IN_PROGRESS",
      change_reason: "manual",
    },
  });
  const updatedTask = parseToolJson(updateTaskResult);
  assert(
    updatedTask.status === "IN_PROGRESS",
    "tasks.update did not update status",
  );

  const taskHistoryResult = await client.callTool({
    name: "tasks.history",
    arguments: {
      task_id: createdTask.id,
      limit: 10,
    },
  });
  const historyPayload = parseToolJson(taskHistoryResult);
  assert(
    Array.isArray(historyPayload.history),
    "tasks.history returned invalid payload",
  );

  const memberEmail = `mcp-member+${Date.now()}@example.com`;
  const addMemberResult = await client.callTool({
    name: "members.add",
    arguments: {
      workspace_id: workspaceId,
      email: memberEmail,
      role: "MEMBER",
    },
  });
  const memberPayload = parseToolJson(addMemberResult);
  assert(
    typeof memberPayload.user_id === "string",
    "members.add did not return user_id",
  );

  const listMembersResult = await client.callTool({
    name: "members.list",
    arguments: {
      workspace_id: workspaceId,
      limit: 10,
    },
  });
  const membersPayload = parseToolJson(listMembersResult);
  assert(
    Array.isArray(membersPayload.members),
    "members.list returned invalid payload",
  );

  const removeMemberResult = await client.callTool({
    name: "members.remove",
    arguments: {
      workspace_id: workspaceId,
      user_id: memberPayload.user_id,
    },
  });
  const removedMember = parseToolJson(removeMemberResult);
  assert(
    removedMember.removed === true,
    "members.remove did not remove member",
  );

  const deleteTaskResult = await client.callTool({
    name: "tasks.delete",
    arguments: { task_id: createdTask.id },
  });
  const deletedTask = parseToolJson(deleteTaskResult);
  assert(deletedTask.deleted === true, "tasks.delete did not delete task");

  const restoreTaskResult = await client.callTool({
    name: "tasks.restore",
    arguments: { task_id: createdTask.id },
  });
  const restoredTask = parseToolJson(restoreTaskResult);
  assert(restoredTask.restored === true, "tasks.restore did not restore task");

  const updateProjectResult = await client.callTool({
    name: "projects.update",
    arguments: {
      project_id: createdProject.id,
      name: "Validate MCP Project Updated",
    },
  });
  const updatedProject = parseToolJson(updateProjectResult);
  assert(
    updatedProject.name === "Validate MCP Project Updated",
    "projects.update did not update project",
  );

  const deleteProjectResult = await client.callTool({
    name: "projects.delete",
    arguments: { project_id: createdProject.id },
  });
  const deletedProject = parseToolJson(deleteProjectResult);
  assert(
    deletedProject.deleted === true,
    "projects.delete did not delete project",
  );

  await client.close();

  console.log("MCP validate success");
  console.log(`workspace_id=${workspaceId}`);
  console.log(`task_id=${createdTask.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
