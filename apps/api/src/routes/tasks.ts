import type { Hono } from 'hono';
import { z } from 'zod';
import { ROLE_RANK } from '../lib/constants';
import { newId } from '../lib/ids';
import { decodeCursor, encodeCursor, parseLimit } from '../lib/pagination';
import { error, jsonBody, ok, validationError } from '../lib/response';
import type { AppEnv, TaskPriority, TaskStatus } from '../lib/types';
import { classifyTaskChangeType, writeAudit, writeTaskHistory } from '../services/audit';
import { hasScope, requireMembership } from '../services/authz';

const createTaskSchema = z.object({
  project_id: z.string().min(1).optional(),
  parent_task_id: z.string().min(1).optional(),
  assignee_user_id: z.string().min(1).optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'ARCHIVED']).optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  due_at: z.string().datetime().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  change_reason: z
    .enum(['manual', 'deadline_shift', 'dependency_blocked', 'rebalancing', 'system'])
    .optional(),
});

const updateTaskSchema = z.object({
  project_id: z.string().min(1).nullable().optional(),
  parent_task_id: z.string().min(1).nullable().optional(),
  assignee_user_id: z.string().min(1).nullable().optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'ARCHIVED']).optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  due_at: z.string().datetime().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  version: z.number().int().positive().optional(),
  change_reason: z
    .enum(['manual', 'deadline_shift', 'dependency_blocked', 'rebalancing', 'system'])
    .optional(),
});

type TaskRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  parent_task_id: string | null;
  assignee_user_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: string | null;
  completed_at: string | null;
  metadata_json: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export function registerTaskRoutes(app: Hono<AppEnv>) {
  app.post('/v1/workspaces/:workspaceId/tasks', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:write')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:write scope');
    }

    const workspaceId = c.req.param('workspaceId');
    const membership = await requireMembership(c, workspaceId, 'MEMBER');
    if ('error' in membership) {
      return membership.error;
    }

    const body = await jsonBody(c);
    if (!body.ok) {
      return body.response;
    }
    const parsed = createTaskSchema.safeParse(body.data);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }

    const payload = parsed.data;
    const taskId = newId('tsk_');
    const title = payload.title.trim();
    const description = payload.description?.trim() || null;
    const status = payload.status ?? 'TODO';
    const priority = payload.priority ?? 'P2';
    const dueAt = payload.due_at ?? null;
    const metadataJson = payload.metadata ? JSON.stringify(payload.metadata) : null;
    const completedAt = status === 'DONE' ? new Date().toISOString() : null;

    if (payload.project_id) {
      const project = await c.env.DB.prepare(
        'SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL LIMIT 1'
      )
        .bind(payload.project_id, workspaceId)
        .first<{ id: string }>();
      if (!project) {
        return error(c, 400, 'INVALID_PROJECT', 'project_id does not exist in workspace');
      }
    }

    if (payload.parent_task_id) {
      const parentTask = await c.env.DB.prepare(
        'SELECT id FROM tasks WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL LIMIT 1'
      )
        .bind(payload.parent_task_id, workspaceId)
        .first<{ id: string }>();
      if (!parentTask) {
        return error(c, 400, 'INVALID_PARENT_TASK', 'parent_task_id does not exist in workspace');
      }
    }

    if (payload.assignee_user_id) {
      const assigneeMembership = await c.env.DB.prepare(
        'SELECT id FROM memberships WHERE workspace_id = ? AND user_id = ? LIMIT 1'
      )
        .bind(workspaceId, payload.assignee_user_id)
        .first<{ id: string }>();
      if (!assigneeMembership) {
        return error(c, 400, 'INVALID_ASSIGNEE', 'assignee_user_id is not a workspace member');
      }
    }

    await c.env.DB.prepare(
      `INSERT INTO tasks
        (id, workspace_id, project_id, parent_task_id, assignee_user_id, title, description, status, priority, due_at, completed_at, metadata_json, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
      .bind(
        taskId,
        workspaceId,
        payload.project_id ?? null,
        payload.parent_task_id ?? null,
        payload.assignee_user_id ?? null,
        title,
        description,
        status,
        priority,
        dueAt,
        completedAt,
        metadataJson
      )
      .run();

    await writeTaskHistory(c.env.DB, {
      workspaceId,
      taskId,
      actorUserId: principal.userId,
      changeType: 'CREATED',
      changeReason: payload.change_reason ?? 'manual',
      fromValue: null,
      toValue: {
        project_id: payload.project_id ?? null,
        parent_task_id: payload.parent_task_id ?? null,
        assignee_user_id: payload.assignee_user_id ?? null,
        title,
        description,
        status,
        priority,
        due_at: dueAt,
      },
      metadata: payload.metadata ?? null,
    });

    await writeAudit(c.env.DB, {
      workspaceId,
      actorUserId: principal.userId,
      action: 'CREATE_TASK',
      entityType: 'task',
      entityId: taskId,
      metadata: { title, status, priority },
    });

    const created = await c.env.DB.prepare(
      `SELECT id, workspace_id, project_id, parent_task_id, assignee_user_id, title, description, status, priority, due_at, completed_at, metadata_json, version, created_at, updated_at, deleted_at
       FROM tasks
       WHERE id = ?
       LIMIT 1`
    )
      .bind(taskId)
      .first();

    return ok(c, created, 201);
  });

  app.get('/v1/workspaces/:workspaceId/tasks', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:read')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:read scope');
    }

    const workspaceId = c.req.param('workspaceId');
    const membership = await requireMembership(c, workspaceId, 'VIEWER');
    if ('error' in membership) {
      return membership.error;
    }

    const statusFilter = c.req.query('status');
    const priorityFilter = c.req.query('priority');
    const projectFilter = c.req.query('project_id');
    const assigneeFilter = c.req.query('assignee_id');
    const dueFrom = c.req.query('due_from');
    const dueTo = c.req.query('due_to');
    const cursor = decodeCursor(c.req.query('cursor'));
    const includeDeleted = c.req.query('include_deleted') === 'true';
    const limit = parseLimit(c.req.query('limit'), 50, 100);

    if (includeDeleted && ROLE_RANK[membership.role] < ROLE_RANK.ADMIN) {
      return error(c, 403, 'FORBIDDEN', 'Only ADMIN+ can include deleted tasks');
    }

    if (statusFilter && !['TODO', 'IN_PROGRESS', 'DONE', 'ARCHIVED'].includes(statusFilter)) {
      return error(c, 400, 'VALIDATION_ERROR', 'Invalid status filter');
    }
    if (priorityFilter && !['P0', 'P1', 'P2', 'P3'].includes(priorityFilter)) {
      return error(c, 400, 'VALIDATION_ERROR', 'Invalid priority filter');
    }

    const whereClauses: string[] = ['workspace_id = ?'];
    const params: (string | number)[] = [workspaceId];

    if (!includeDeleted) {
      whereClauses.push('deleted_at IS NULL');
    }
    if (statusFilter) {
      whereClauses.push('status = ?');
      params.push(statusFilter);
    }
    if (priorityFilter) {
      whereClauses.push('priority = ?');
      params.push(priorityFilter);
    }
    if (projectFilter) {
      whereClauses.push('project_id = ?');
      params.push(projectFilter);
    }
    if (assigneeFilter) {
      whereClauses.push('assignee_user_id = ?');
      params.push(assigneeFilter);
    }
    if (dueFrom) {
      whereClauses.push('due_at >= ?');
      params.push(dueFrom);
    }
    if (dueTo) {
      whereClauses.push('due_at <= ?');
      params.push(dueTo);
    }

    if (cursor) {
      whereClauses.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
      params.push(cursor.ts, cursor.ts, cursor.id);
    }

    params.push(limit + 1);

    const rows = await c.env.DB.prepare(
      `SELECT id, workspace_id, project_id, parent_task_id, assignee_user_id, title, description, status, priority, due_at, completed_at, metadata_json, version, created_at, updated_at, deleted_at
       FROM tasks
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`
    )
      .bind(...params)
      .all();

    const tasks = rows.results ?? [];
    const hasMore = tasks.length > limit;
    const page = hasMore ? tasks.slice(0, limit) : tasks;
    const last = page[page.length - 1] as { updated_at: string; id: string } | undefined;
    const nextCursor = hasMore && last ? encodeCursor({ ts: last.updated_at, id: last.id }) : null;

    return ok(c, {
      workspace_id: workspaceId,
      filters: {
        status: statusFilter ?? null,
        priority: priorityFilter ?? null,
        project_id: projectFilter ?? null,
        assignee_id: assigneeFilter ?? null,
        due_from: dueFrom ?? null,
        due_to: dueTo ?? null,
        include_deleted: includeDeleted,
        limit,
        cursor: cursor ? c.req.query('cursor') ?? null : null,
      },
      tasks: page,
      pagination: {
        limit,
        next_cursor: nextCursor,
        has_more: hasMore,
      },
    });
  });

  app.get('/v1/tasks/:taskId', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:read')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:read scope');
    }

    const taskId = c.req.param('taskId');
    const task = await c.env.DB.prepare(
      `SELECT id, workspace_id, project_id, parent_task_id, assignee_user_id, title, description, status, priority, due_at, completed_at, metadata_json, version, created_at, updated_at, deleted_at
       FROM tasks
       WHERE id = ?
       LIMIT 1`
    )
      .bind(taskId)
      .first<TaskRow>();

    if (!task) {
      return error(c, 404, 'NOT_FOUND', 'Task not found');
    }

    const membership = await requireMembership(c, task.workspace_id, 'VIEWER');
    if ('error' in membership) {
      return membership.error;
    }

    return ok(c, task);
  });

  app.patch('/v1/tasks/:taskId', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:write')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:write scope');
    }

    const taskId = c.req.param('taskId');
    const task = await c.env.DB.prepare(
      `SELECT id, workspace_id, project_id, parent_task_id, assignee_user_id, title, description, status, priority, due_at, completed_at, metadata_json, version, created_at, updated_at, deleted_at
       FROM tasks
       WHERE id = ?
       LIMIT 1`
    )
      .bind(taskId)
      .first<TaskRow>();

    if (!task) {
      return error(c, 404, 'NOT_FOUND', 'Task not found');
    }

    const membership = await requireMembership(c, task.workspace_id, 'MEMBER');
    if ('error' in membership) {
      return membership.error;
    }

    const body = await jsonBody(c);
    if (!body.ok) {
      return body.response;
    }
    const parsed = updateTaskSchema.safeParse(body.data);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }

    const payload = parsed.data;
    const versionHeader = c.req.header('if-match-version');
    const expectedVersion = payload.version ?? (versionHeader ? Number.parseInt(versionHeader, 10) : null);

    if (!expectedVersion || !Number.isInteger(expectedVersion)) {
      return error(c, 400, 'MISSING_VERSION', 'version is required via body.version or If-Match-Version header');
    }

    if (expectedVersion !== task.version) {
      return error(c, 409, 'VERSION_CONFLICT', 'Task version mismatch', { current: task });
    }

    if (payload.project_id !== undefined && payload.project_id !== null) {
      const project = await c.env.DB.prepare(
        'SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL LIMIT 1'
      )
        .bind(payload.project_id, task.workspace_id)
        .first<{ id: string }>();
      if (!project) {
        return error(c, 400, 'INVALID_PROJECT', 'project_id does not exist in workspace');
      }
    }

    if (payload.parent_task_id !== undefined && payload.parent_task_id !== null) {
      if (payload.parent_task_id === taskId) {
        return error(c, 400, 'INVALID_PARENT_TASK', 'parent_task_id cannot equal task id');
      }
      const parentTask = await c.env.DB.prepare(
        'SELECT id FROM tasks WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL LIMIT 1'
      )
        .bind(payload.parent_task_id, task.workspace_id)
        .first<{ id: string }>();
      if (!parentTask) {
        return error(c, 400, 'INVALID_PARENT_TASK', 'parent_task_id does not exist in workspace');
      }
    }

    if (payload.assignee_user_id !== undefined && payload.assignee_user_id !== null) {
      const assigneeMembership = await c.env.DB.prepare(
        'SELECT id FROM memberships WHERE workspace_id = ? AND user_id = ? LIMIT 1'
      )
        .bind(task.workspace_id, payload.assignee_user_id)
        .first<{ id: string }>();
      if (!assigneeMembership) {
        return error(c, 400, 'INVALID_ASSIGNEE', 'assignee_user_id is not a workspace member');
      }
    }

    const nextStatus = payload.status ?? task.status;
    const nextPriority = payload.priority ?? task.priority;
    const nextTitle = payload.title?.trim() ?? task.title;
    const nextDescription =
      payload.description === undefined
        ? task.description
        : payload.description === null
          ? null
          : payload.description.trim();
    const nextProjectId = payload.project_id === undefined ? task.project_id : (payload.project_id ?? null);
    const nextParentTaskId =
      payload.parent_task_id === undefined ? task.parent_task_id : (payload.parent_task_id ?? null);
    const nextAssigneeUserId =
      payload.assignee_user_id === undefined ? task.assignee_user_id : (payload.assignee_user_id ?? null);
    const nextDueAt = payload.due_at === undefined ? task.due_at : payload.due_at;
    const nextMetadataJson =
      payload.metadata === undefined
        ? task.metadata_json
        : payload.metadata === null
          ? null
          : JSON.stringify(payload.metadata);

    const nextCompletedAt =
      payload.status === undefined
        ? task.completed_at
        : payload.status === 'DONE'
          ? task.completed_at ?? new Date().toISOString()
          : null;

    await c.env.DB.prepare(
      `UPDATE tasks
       SET
         project_id = ?,
         parent_task_id = ?,
         assignee_user_id = ?,
         title = ?,
         description = ?,
         status = ?,
         priority = ?,
         due_at = ?,
         completed_at = ?,
         metadata_json = ?,
         version = version + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND version = ?`
    )
      .bind(
        nextProjectId,
        nextParentTaskId,
        nextAssigneeUserId,
        nextTitle,
        nextDescription,
        nextStatus,
        nextPriority,
        nextDueAt,
        nextCompletedAt,
        nextMetadataJson,
        taskId,
        expectedVersion
      )
      .run();

    const updated = await c.env.DB.prepare(
      `SELECT id, workspace_id, project_id, parent_task_id, assignee_user_id, title, description, status, priority, due_at, completed_at, metadata_json, version, created_at, updated_at, deleted_at
       FROM tasks
       WHERE id = ?
       LIMIT 1`
    )
      .bind(taskId)
      .first();

    await writeTaskHistory(c.env.DB, {
      workspaceId: task.workspace_id,
      taskId,
      actorUserId: principal.userId,
      changeType: classifyTaskChangeType(task, {
        status: nextStatus,
        priority: nextPriority,
        due_at: nextDueAt,
        assignee_user_id: nextAssigneeUserId,
      }),
      changeReason: payload.change_reason ?? 'manual',
      fromValue: {
        project_id: task.project_id,
        parent_task_id: task.parent_task_id,
        assignee_user_id: task.assignee_user_id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        due_at: task.due_at,
        metadata_json: task.metadata_json,
        version: task.version,
      },
      toValue: {
        project_id: nextProjectId,
        parent_task_id: nextParentTaskId,
        assignee_user_id: nextAssigneeUserId,
        title: nextTitle,
        description: nextDescription,
        status: nextStatus,
        priority: nextPriority,
        due_at: nextDueAt,
        metadata_json: nextMetadataJson,
        version: task.version + 1,
      },
      metadata: null,
    });

    await writeAudit(c.env.DB, {
      workspaceId: task.workspace_id,
      actorUserId: principal.userId,
      action: 'UPDATE_TASK',
      entityType: 'task',
      entityId: taskId,
      metadata: { status: nextStatus, priority: nextPriority },
    });

    return ok(c, updated);
  });

  app.delete('/v1/tasks/:taskId', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:write')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:write scope');
    }

    const taskId = c.req.param('taskId');
    const task = await c.env.DB.prepare(
      `SELECT id, workspace_id, deleted_at
       FROM tasks
       WHERE id = ?
       LIMIT 1`
    )
      .bind(taskId)
      .first<{ id: string; workspace_id: string; deleted_at: string | null }>();

    if (!task) {
      return error(c, 404, 'NOT_FOUND', 'Task not found');
    }

    const membership = await requireMembership(c, task.workspace_id, 'MEMBER');
    if ('error' in membership) {
      return membership.error;
    }

    if (task.deleted_at) {
      return ok(c, { id: taskId, deleted: true, already_deleted: true });
    }

    await c.env.DB.prepare(
      `UPDATE tasks
       SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, version = version + 1
       WHERE id = ?`
    )
      .bind(taskId)
      .run();

    await writeTaskHistory(c.env.DB, {
      workspaceId: task.workspace_id,
      taskId,
      actorUserId: principal.userId,
      changeType: 'DELETED',
      changeReason: 'manual',
      fromValue: { deleted_at: null },
      toValue: { deleted_at: new Date().toISOString() },
      metadata: null,
    });

    await writeAudit(c.env.DB, {
      workspaceId: task.workspace_id,
      actorUserId: principal.userId,
      action: 'DELETE_TASK',
      entityType: 'task',
      entityId: taskId,
      metadata: null,
    });

    return ok(c, { id: taskId, deleted: true });
  });

  app.post('/v1/tasks/:taskId/restore', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:write')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:write scope');
    }

    const taskId = c.req.param('taskId');
    const task = await c.env.DB.prepare(
      `SELECT id, workspace_id, deleted_at
       FROM tasks
       WHERE id = ?
       LIMIT 1`
    )
      .bind(taskId)
      .first<{ id: string; workspace_id: string; deleted_at: string | null }>();

    if (!task) {
      return error(c, 404, 'NOT_FOUND', 'Task not found');
    }

    const membership = await requireMembership(c, task.workspace_id, 'ADMIN');
    if ('error' in membership) {
      return membership.error;
    }

    if (!task.deleted_at) {
      return ok(c, { id: taskId, restored: true, already_restored: true });
    }

    await c.env.DB.prepare(
      `UPDATE tasks
       SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP, version = version + 1
       WHERE id = ?`
    )
      .bind(taskId)
      .run();

    await writeTaskHistory(c.env.DB, {
      workspaceId: task.workspace_id,
      taskId,
      actorUserId: principal.userId,
      changeType: 'RESTORED',
      changeReason: 'manual',
      fromValue: { deleted_at: task.deleted_at },
      toValue: { deleted_at: null },
      metadata: null,
    });

    await writeAudit(c.env.DB, {
      workspaceId: task.workspace_id,
      actorUserId: principal.userId,
      action: 'RESTORE_TASK',
      entityType: 'task',
      entityId: taskId,
      metadata: null,
    });

    return ok(c, { id: taskId, restored: true });
  });
}
