import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const DEFAULT_API_BASE_URL = "https://todoless.dev";

function normalizeBaseUrl(rawBaseUrl) {
  return (rawBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

function textResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function queryString(params) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    search.set(k, String(v));
  }
  const raw = search.toString();
  return raw ? `?${raw}` : "";
}

export function createTodolessMcpServer({ apiBaseUrl, apiKey, fetchFn }) {
  if (!apiKey) {
    throw new Error("TODOLESS_API_KEY is required");
  }

  const normalizedBaseUrl = normalizeBaseUrl(apiBaseUrl);
  const doFetch = fetchFn || fetch;
  const server = new Server(
    {
      name: "todoless-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  async function apiRequest(method, path, { body, headers } = {}) {
    const url = `${normalizedBaseUrl}${path}`;
    const response = await doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const payload = await response.json().catch(() => null);
    if (!payload || payload.success !== true) {
      const code = payload?.error?.code ?? `HTTP_${response.status}`;
      const message = payload?.error?.message ?? "Request failed";
      throw new Error(`${code}: ${message}`);
    }

    return payload.data;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "workspaces.list",
          description: "List workspaces for the authenticated user.",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "number" },
              cursor: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        {
          name: "workspaces.get",
          description: "Get a workspace by id.",
          inputSchema: {
            type: "object",
            properties: {
              workspace_id: { type: "string" },
            },
            required: ["workspace_id"],
            additionalProperties: false,
          },
        },
        {
          name: "members.list",
          description: "List members for a workspace.",
          inputSchema: {
            type: "object",
            properties: {
              workspace_id: { type: "string" },
              limit: { type: "number" },
              cursor: { type: "string" },
            },
            required: ["workspace_id"],
            additionalProperties: false,
          },
        },
        {
          name: "members.add",
          description: "Add or re-invite a member to a workspace.",
          inputSchema: {
            type: "object",
            properties: {
              workspace_id: { type: "string" },
              email: { type: "string" },
              role: { type: "string" },
            },
            required: ["workspace_id", "email", "role"],
            additionalProperties: false,
          },
        },
        {
          name: "members.remove",
          description:
            "Remove a member from a workspace, optionally unassigning or reassigning their tasks.",
          inputSchema: {
            type: "object",
            properties: {
              workspace_id: { type: "string" },
              user_id: { type: "string" },
              task_policy: { type: "string" },
              reassign_to_user_id: { type: "string" },
            },
            required: ["workspace_id", "user_id"],
            additionalProperties: false,
          },
        },
        {
          name: "projects.list",
          description: "List projects for a workspace.",
          inputSchema: {
            type: "object",
            properties: {
              workspace_id: { type: "string" },
              include_deleted: { type: "boolean" },
            },
            required: ["workspace_id"],
            additionalProperties: false,
          },
        },
        {
          name: "projects.create",
          description: "Create a project in a workspace.",
          inputSchema: {
            type: "object",
            properties: {
              workspace_id: { type: "string" },
              name: { type: "string" },
              description: { type: "string" },
            },
            required: ["workspace_id", "name"],
            additionalProperties: false,
          },
        },
        {
          name: "projects.get",
          description: "Get a project by id.",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string" },
            },
            required: ["project_id"],
            additionalProperties: false,
          },
        },
        {
          name: "projects.update",
          description: "Update a project.",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string" },
              name: { type: "string" },
              description: { type: ["string", "null"] },
              change_reason: { type: "string" },
            },
            required: ["project_id"],
            additionalProperties: false,
          },
        },
        {
          name: "projects.delete",
          description: "Soft delete a project.",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string" },
            },
            required: ["project_id"],
            additionalProperties: false,
          },
        },
        {
          name: "tasks.list",
          description:
            "List tasks for a workspace with filters and pagination.",
          inputSchema: {
            type: "object",
            properties: {
              workspace_id: { type: "string" },
              status: { type: "string" },
              priority: { type: "string" },
              project_id: { type: "string" },
              assignee_id: { type: "string" },
              due_from: { type: "string" },
              due_to: { type: "string" },
              include_deleted: { type: "boolean" },
              limit: { type: "number" },
              cursor: { type: "string" },
            },
            required: ["workspace_id"],
            additionalProperties: false,
          },
        },
        {
          name: "tasks.get",
          description: "Get a task by id.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "string" },
            },
            required: ["task_id"],
            additionalProperties: false,
          },
        },
        {
          name: "tasks.history",
          description: "Get task history entries with pagination.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "string" },
              limit: { type: "number" },
              cursor: { type: "string" },
            },
            required: ["task_id"],
            additionalProperties: false,
          },
        },
        {
          name: "tasks.create",
          description: "Create a task in a workspace.",
          inputSchema: {
            type: "object",
            properties: {
              workspace_id: { type: "string" },
              title: { type: "string" },
              project_id: { type: "string" },
              parent_task_id: { type: "string" },
              assignee_user_id: { type: "string" },
              description: { type: "string" },
              status: { type: "string" },
              priority: { type: "string" },
              due_at: { type: "string" },
              metadata: { type: "object" },
              change_reason: { type: "string" },
            },
            required: ["workspace_id", "title"],
            additionalProperties: false,
          },
        },
        {
          name: "tasks.update",
          description:
            "Update an existing task with optimistic concurrency version check.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "string" },
              version: { type: "number" },
              project_id: { type: ["string", "null"] },
              parent_task_id: { type: ["string", "null"] },
              assignee_user_id: { type: ["string", "null"] },
              title: { type: "string" },
              description: { type: ["string", "null"] },
              status: { type: "string" },
              priority: { type: "string" },
              due_at: { type: ["string", "null"] },
              metadata: { type: ["object", "null"] },
              change_reason: { type: "string" },
            },
            required: ["task_id", "version"],
            additionalProperties: false,
          },
        },
        {
          name: "tasks.delete",
          description: "Soft delete a task.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "string" },
            },
            required: ["task_id"],
            additionalProperties: false,
          },
        },
        {
          name: "tasks.restore",
          description: "Restore a soft-deleted task.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "string" },
            },
            required: ["task_id"],
            additionalProperties: false,
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};

    if (name === "workspaces.list") {
      const data = await apiRequest(
        "GET",
        `/v1/workspaces${queryString({
          limit: args.limit,
          cursor: args.cursor,
        })}`,
      );
      return textResult(data);
    }

    if (name === "workspaces.get") {
      const workspaceId = String(args.workspace_id || "");
      if (!workspaceId) {
        throw new Error("workspace_id is required");
      }
      const data = await apiRequest("GET", `/v1/workspaces/${workspaceId}`);
      return textResult(data);
    }

    if (name === "members.list") {
      const workspaceId = String(args.workspace_id || "");
      if (!workspaceId) {
        throw new Error("workspace_id is required");
      }
      const data = await apiRequest(
        "GET",
        `/v1/workspaces/${workspaceId}/members${queryString({
          limit: args.limit,
          cursor: args.cursor,
        })}`,
      );
      return textResult(data);
    }

    if (name === "members.add") {
      const workspaceId = String(args.workspace_id || "");
      const email = String(args.email || "").trim();
      const role = String(args.role || "").trim();
      if (!workspaceId) {
        throw new Error("workspace_id is required");
      }
      if (!email) {
        throw new Error("email is required");
      }
      if (!role) {
        throw new Error("role is required");
      }

      const data = await apiRequest(
        "POST",
        `/v1/workspaces/${workspaceId}/members`,
        {
          body: { email, role },
        },
      );
      return textResult(data);
    }

    if (name === "members.remove") {
      const workspaceId = String(args.workspace_id || "");
      const userId = String(args.user_id || "");
      if (!workspaceId) {
        throw new Error("workspace_id is required");
      }
      if (!userId) {
        throw new Error("user_id is required");
      }

      const data = await apiRequest(
        "DELETE",
        `/v1/workspaces/${workspaceId}/members/${userId}${queryString({
          task_policy: args.task_policy,
          reassign_to_user_id: args.reassign_to_user_id,
        })}`,
      );
      return textResult(data);
    }

    if (name === "projects.list") {
      const workspaceId = String(args.workspace_id || "");
      if (!workspaceId) {
        throw new Error("workspace_id is required");
      }

      const includeDeleted = args.include_deleted === true;
      const data = await apiRequest(
        "GET",
        `/v1/workspaces/${workspaceId}/projects${queryString({ include_deleted: includeDeleted ? "true" : undefined })}`,
      );
      return textResult(data);
    }

    if (name === "projects.create") {
      const workspaceId = String(args.workspace_id || "");
      const projectName = String(args.name || "").trim();
      if (!workspaceId) {
        throw new Error("workspace_id is required");
      }
      if (!projectName) {
        throw new Error("name is required");
      }

      const data = await apiRequest(
        "POST",
        `/v1/workspaces/${workspaceId}/projects`,
        {
          body: {
            name: projectName,
            description: args.description,
          },
        },
      );
      return textResult(data);
    }

    if (name === "projects.get") {
      const projectId = String(args.project_id || "");
      if (!projectId) {
        throw new Error("project_id is required");
      }

      const data = await apiRequest("GET", `/v1/projects/${projectId}`);
      return textResult(data);
    }

    if (name === "projects.update") {
      const projectId = String(args.project_id || "");
      if (!projectId) {
        throw new Error("project_id is required");
      }

      const data = await apiRequest("PATCH", `/v1/projects/${projectId}`, {
        body: {
          name: args.name,
          description: args.description,
          change_reason: args.change_reason,
        },
      });
      return textResult(data);
    }

    if (name === "projects.delete") {
      const projectId = String(args.project_id || "");
      if (!projectId) {
        throw new Error("project_id is required");
      }

      const data = await apiRequest("DELETE", `/v1/projects/${projectId}`);
      return textResult(data);
    }

    if (name === "tasks.list") {
      const workspaceId = String(args.workspace_id || "");
      if (!workspaceId) {
        throw new Error("workspace_id is required");
      }

      const data = await apiRequest(
        "GET",
        `/v1/workspaces/${workspaceId}/tasks${queryString({
          status: args.status,
          priority: args.priority,
          project_id: args.project_id,
          assignee_id: args.assignee_id,
          due_from: args.due_from,
          due_to: args.due_to,
          include_deleted: args.include_deleted ? "true" : undefined,
          limit: args.limit,
          cursor: args.cursor,
        })}`,
      );
      return textResult(data);
    }

    if (name === "tasks.get") {
      const taskId = String(args.task_id || "");
      if (!taskId) {
        throw new Error("task_id is required");
      }

      const data = await apiRequest("GET", `/v1/tasks/${taskId}`);
      return textResult(data);
    }

    if (name === "tasks.history") {
      const taskId = String(args.task_id || "");
      if (!taskId) {
        throw new Error("task_id is required");
      }

      const data = await apiRequest(
        "GET",
        `/v1/tasks/${taskId}/history${queryString({
          limit: args.limit,
          cursor: args.cursor,
        })}`,
      );
      return textResult(data);
    }

    if (name === "tasks.create") {
      const workspaceId = String(args.workspace_id || "");
      if (!workspaceId) {
        throw new Error("workspace_id is required");
      }

      const body = {
        title: args.title,
        project_id: args.project_id,
        parent_task_id: args.parent_task_id,
        assignee_user_id: args.assignee_user_id,
        description: args.description,
        status: args.status,
        priority: args.priority,
        due_at: args.due_at,
        metadata: args.metadata,
        change_reason: args.change_reason,
      };

      const data = await apiRequest(
        "POST",
        `/v1/workspaces/${workspaceId}/tasks`,
        { body },
      );
      return textResult(data);
    }

    if (name === "tasks.update") {
      const taskId = String(args.task_id || "");
      const version = Number(args.version);
      if (!taskId) {
        throw new Error("task_id is required");
      }
      if (!Number.isFinite(version) || version <= 0) {
        throw new Error("version must be a positive number");
      }

      const body = {
        project_id: args.project_id,
        parent_task_id: args.parent_task_id,
        assignee_user_id: args.assignee_user_id,
        title: args.title,
        description: args.description,
        status: args.status,
        priority: args.priority,
        due_at: args.due_at,
        metadata: args.metadata,
        change_reason: args.change_reason,
        version,
      };

      const data = await apiRequest("PATCH", `/v1/tasks/${taskId}`, {
        body,
        headers: {
          "if-match-version": String(version),
        },
      });
      return textResult(data);
    }

    if (name === "tasks.delete") {
      const taskId = String(args.task_id || "");
      if (!taskId) {
        throw new Error("task_id is required");
      }

      const data = await apiRequest("DELETE", `/v1/tasks/${taskId}`);
      return textResult(data);
    }

    if (name === "tasks.restore") {
      const taskId = String(args.task_id || "");
      if (!taskId) {
        throw new Error("task_id is required");
      }

      const data = await apiRequest("POST", `/v1/tasks/${taskId}/restore`);
      return textResult(data);
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}
