import type { Hono } from 'hono';
import { z } from 'zod';
import { ROLE_RANK } from '../lib/constants';
import { newId } from '../lib/ids';
import { decodeCursor, encodeCursor, parseLimit } from '../lib/pagination';
import { error, jsonBody, ok, validationError } from '../lib/response';
import type { AppEnv, TaskPriority, TaskStatus } from '../lib/types';
import { classifyTaskChangeType, prepareAudit, prepareTaskHistory } from '../services/audit';
import { hasScope, requireMembership, membershipWriteGuard } from '../services/authz';
import { requireProject, projectListFilter, referenceAllowed, readableTasks, readableHistoryValue, memberCanAccessProjectSql, referenceWriteGuard } from '../services/project-access';
import { activeTaskSql, freeActiveSlotSql, type Stage } from '../services/task-delivery';

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
  delivery_state: Stage | null;
  priority: TaskPriority;
  due_at: string | null;
  completed_at: string | null;
  metadata_json: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

function parseJsonValue(raw: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

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
    const denied = await requireProject(c,payload.project_id??null);if(denied)return denied;
    if(payload.parent_task_id && membership.projectIds!==null && !await referenceAllowed(c,workspaceId,payload.parent_task_id))return error(c,404,'NOT_FOUND','Referenced task not found');
    const taskId = newId('tsk_');
    const title = payload.title.trim();
    const description = payload.description?.trim() || null;
    const status = payload.status ?? 'TODO';
    if(membership.projectIds!==null && status!=='TODO')return error(c,409,'DELIVERY_REQUIRED','Create Backlog tasks, then use the delivery workflow');
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
        `SELECT id FROM memberships m WHERE workspace_id = ? AND user_id = ? AND ${memberCanAccessProjectSql('m','?')} LIMIT 1`
      )
        .bind(workspaceId, payload.assignee_user_id,payload.project_id??null,payload.project_id??null)
        .first<{ id: string }>();
      if (!assigneeMembership) {
        return error(c, 400, 'INVALID_ASSIGNEE', 'assignee_user_id is not a workspace member');
      }
    }

    const accessGuard=membershipWriteGuard(c,workspaceId);
    const refsGuard=referenceWriteGuard(c,workspaceId,payload.parent_task_id?[payload.parent_task_id]:[],payload.project_id??null);
    const mutation = c.env.DB.prepare(
      `INSERT INTO tasks
        (id, workspace_id, project_id, parent_task_id, assignee_user_id, title, description, status, priority, due_at, completed_at, metadata_json, version, last_mutation_id,delivery_state)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
       WHERE (? IS NULL OR EXISTS (SELECT 1 FROM memberships m WHERE workspace_id = ? AND user_id = ? AND ${memberCanAccessProjectSql('m','?')}))
         AND (? != 'IN_PROGRESS' OR ? IS NULL OR ${freeActiveSlotSql}) AND ${accessGuard.sql} AND ${refsGuard.sql}`
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
        metadataJson,
        taskId,
        membership.projectIds!==null?'BACKLOG':null,
        payload.assignee_user_id ?? null,
        workspaceId,
        payload.assignee_user_id ?? null,
        payload.project_id??null,payload.project_id??null,
        status, payload.assignee_user_id ?? null, workspaceId, payload.assignee_user_id ?? null, taskId,...accessGuard.params,...refsGuard.params
      );
    const guard = { table: 'tasks' as const, id: taskId, mutationId: taskId };

    const history = prepareTaskHistory(c.env.DB, {
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
    }, guard);

    const audit = prepareAudit(c.env.DB, {
      workspaceId,
      actorUserId: principal.userId,
      action: 'CREATE_TASK',
      entityType: 'task',
      entityId: taskId,
      metadata: { title, status, priority },
    }, guard);

    const [written] = await c.env.DB.batch([mutation, history, audit]);
    if (written.meta.changes !== 1) return error(c, 409, 'TASK_CONFLICT', 'Assignee membership or active work changed during this request');

    const created = await c.env.DB.prepare(
      `SELECT id, workspace_id, project_id, parent_task_id, assignee_user_id, title, description, status, priority, due_at, completed_at, metadata_json, version, delivery_state, created_at, updated_at, deleted_at
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
    const visible = projectListFilter(c,'project_id');
    whereClauses.push(visible.sql);params.push(...visible.params);

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
      `SELECT id, workspace_id, project_id, parent_task_id, assignee_user_id, title, description, status, priority, due_at, completed_at, metadata_json, version, delivery_state, created_at, updated_at, deleted_at
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
      tasks: await readableTasks(c,workspaceId,page),
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
      `SELECT id, workspace_id, project_id, parent_task_id, assignee_user_id, title, description, status, priority, due_at, completed_at, metadata_json, version, delivery_state, created_at, updated_at, deleted_at
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
    const denied = await requireProject(c,task.project_id);if(denied)return denied;
    if(membership.projectIds!==null && task.deleted_at)return error(c,404,'NOT_FOUND','Task not found');

    return ok(c, (await readableTasks(c,task.workspace_id,[task]))[0]);
  });

  app.get('/v1/tasks/:taskId/history', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:read')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:read scope');
    }

    const taskId = c.req.param('taskId');
    const task = await c.env.DB.prepare(
      `SELECT id, workspace_id, project_id, deleted_at
       FROM tasks
       WHERE id = ?
       LIMIT 1`
    )
      .bind(taskId)
      .first<{ id: string; workspace_id: string; project_id:string|null;deleted_at:string|null }>();

    if (!task) {
      return error(c, 404, 'NOT_FOUND', 'Task not found');
    }

    const membership = await requireMembership(c, task.workspace_id, 'VIEWER');
    if ('error' in membership) {
      return membership.error;
    }
    const denied = await requireProject(c,task.project_id);if(denied)return denied;
    if(membership.projectIds!==null && task.deleted_at)return error(c,404,'NOT_FOUND','Task not found');

    const limit = parseLimit(c.req.query('limit'), 50, 100);
    const cursor = decodeCursor(c.req.query('cursor'));
    const whereClauses = ['th.task_id = ?'];
    if(membership.projectIds!==null) {
      // A task deliberately shared after a move must not expose its old private project history.
      const hidden=await c.env.DB.prepare(`SELECT 1 FROM task_history WHERE task_id=? AND (
        (json_extract(from_value_json,'$.project_id') IS NOT NULL AND json_extract(from_value_json,'$.project_id') NOT IN (SELECT value FROM json_each(?))) OR
        (json_extract(to_value_json,'$.project_id') IS NOT NULL AND json_extract(to_value_json,'$.project_id') NOT IN (SELECT value FROM json_each(?)))) LIMIT 1`)
        .bind(taskId,JSON.stringify(membership.projectIds),JSON.stringify(membership.projectIds)).first();
      if(hidden)return error(c,403,'HISTORY_RESTRICTED','An owner must review history from outside your project access');
    }
    const params: (string | number)[] = [taskId];

    if (cursor) {
      whereClauses.push('(th.created_at < ? OR (th.created_at = ? AND th.id < ?))');
      params.push(cursor.ts, cursor.ts, cursor.id);
    }

    params.push(limit + 1);

    const rows = await c.env.DB.prepare(
      `SELECT
         th.id,
         th.workspace_id,
         th.task_id,
         th.actor_user_id,
         u.email AS actor_email,
         u.display_name AS actor_display_name,
         th.change_type,
         th.change_reason,
         th.from_value_json,
         th.to_value_json,
         th.metadata_json,
         th.created_at
       FROM task_history th
       LEFT JOIN users u ON u.id = th.actor_user_id
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY th.created_at DESC, th.id DESC
       LIMIT ?`
    )
      .bind(...params)
      .all<{
        id: string;
        workspace_id: string;
        task_id: string;
        actor_user_id: string | null;
        actor_email: string | null;
        actor_display_name: string | null;
        change_type: string;
        change_reason: string;
        from_value_json: string | null;
        to_value_json: string | null;
        metadata_json: string | null;
        created_at: string;
      }>();

    const entries = await Promise.all((rows.results ?? []).map(async (row) => ({
      id: row.id,
      workspace_id: row.workspace_id,
      task_id: row.task_id,
      actor: row.actor_user_id
        ? {
            user_id: row.actor_user_id,
            email: row.actor_email,
            display_name: row.actor_display_name,
          }
        : null,
      change_type: row.change_type,
      change_reason: row.change_reason,
      from_value: membership.projectIds===null ? parseJsonValue(row.from_value_json) : await readableHistoryValue(c,task.workspace_id,parseJsonValue(row.from_value_json)),
      to_value: membership.projectIds===null ? parseJsonValue(row.to_value_json) : await readableHistoryValue(c,task.workspace_id,parseJsonValue(row.to_value_json)),
      metadata: parseJsonValue(row.metadata_json),
      created_at: row.created_at,
    })));

    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ ts: last.created_at, id: last.id }) : null;

    return ok(c, {
      task_id: taskId,
      history: page,
      pagination: {
        limit,
        next_cursor: nextCursor,
        has_more: hasMore,
      },
    });
  });

  app.patch('/v1/tasks/:taskId', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:write')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:write scope');
    }

    const taskId = c.req.param('taskId');
    const task = await c.env.DB.prepare(
      `SELECT id, workspace_id, project_id, parent_task_id, assignee_user_id, title, description, status, priority, due_at, completed_at, metadata_json, version, delivery_state, created_at, updated_at, deleted_at
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
    const denied = await requireProject(c,task.project_id);if(denied)return denied;
    if(membership.projectIds!==null && task.deleted_at)return error(c,404,'NOT_FOUND','Task not found');

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
    if(membership.projectIds!==null && ['REVIEW','VERIFY','DONE'].includes(task.delivery_state??task.status))
      return error(c,409,'REWORK_REQUIRED','Return reviewed work through the delivery workflow before changing its fields');
    const projectDenied=await requireProject(c,payload.project_id===undefined?task.project_id:payload.project_id);if(projectDenied)return projectDenied;
    if(payload.parent_task_id && membership.projectIds!==null && !await referenceAllowed(c,task.workspace_id,payload.parent_task_id))return error(c,404,'NOT_FOUND','Referenced task not found');
    const expectedVersion = payload.version ?? (versionHeader ? Number.parseInt(versionHeader, 10) : null);

    if (!expectedVersion || !Number.isInteger(expectedVersion)) {
      return error(c, 400, 'MISSING_VERSION', 'version is required via body.version or If-Match-Version header');
    }

    if (expectedVersion !== task.version) {
      return error(c, 409, 'VERSION_CONFLICT', 'Task version mismatch', { current: (await readableTasks(c,task.workspace_id,[task]))[0] });
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
        `SELECT id FROM memberships m WHERE workspace_id = ? AND user_id = ? AND ${memberCanAccessProjectSql('m','?')} LIMIT 1`
      )
        .bind(task.workspace_id, payload.assignee_user_id,payload.project_id===undefined?task.project_id:payload.project_id,payload.project_id===undefined?task.project_id:payload.project_id)
        .first<{ id: string }>();
      if (!assigneeMembership) {
        return error(c, 400, 'INVALID_ASSIGNEE', 'assignee_user_id is not a workspace member');
      }
    }

    const nextStatus = payload.status ?? task.status;
    if(membership.projectIds!==null && nextStatus!==task.status)return error(c,409,'DELIVERY_REQUIRED','Use the delivery workflow for status changes');
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

    // Managed delivery changes must pass its readiness, dependency and review checks.
    // An admin can repair a deleted task's departed assignee before restoring it.
    const repairDeletedAssignee = task.deleted_at && ROLE_RANK[membership.role] >= ROLE_RANK.ADMIN;
    if (task.delivery_state && (nextStatus !== task.status || (!repairDeletedAssignee && nextAssigneeUserId !== task.assignee_user_id) || nextProjectId !== task.project_id)) {
      return error(c, 409, 'DELIVERY_MANAGED', 'Use the delivery endpoint to change stage, assignment or project');
    }
    const nextActive = !task.deleted_at && (task.delivery_state === 'ACTIVE' || (!task.delivery_state && nextStatus === 'IN_PROGRESS'));

    const nextCompletedAt =
      payload.status === undefined
        ? task.completed_at
        : payload.status === 'DONE'
          ? task.completed_at ?? new Date().toISOString()
          : null;

    const accessGuard=membershipWriteGuard(c,task.workspace_id);
    const refsGuard=referenceWriteGuard(c,task.workspace_id,payload.parent_task_id?[payload.parent_task_id]:[],nextProjectId);
    const mutationId = newId('mut_');
    const mutation = c.env.DB.prepare(
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
         updated_at = CURRENT_TIMESTAMP, last_mutation_id = ?
       WHERE id = ? AND version = ?
         AND (? IS NULL OR EXISTS (SELECT 1 FROM memberships m WHERE workspace_id = ? AND user_id = ? AND ${memberCanAccessProjectSql('m','?')}))
         AND (? = 0 OR ? IS NULL OR ${freeActiveSlotSql}) AND ${accessGuard.sql} AND ${refsGuard.sql}`
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
        mutationId,
        taskId,
        expectedVersion,
        nextAssigneeUserId,
        task.workspace_id,
        nextAssigneeUserId,
        nextProjectId,nextProjectId,
        nextActive ? 1 : 0, nextAssigneeUserId, task.workspace_id, nextAssigneeUserId, taskId,...accessGuard.params,...refsGuard.params
      );
    const guard = { table: 'tasks' as const, id: taskId, mutationId };

    const history = prepareTaskHistory(c.env.DB, {
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
    }, guard);

    const audit = prepareAudit(c.env.DB, {
      workspaceId: task.workspace_id,
      actorUserId: principal.userId,
      action: 'UPDATE_TASK',
      entityType: 'task',
      entityId: taskId,
      metadata: { status: nextStatus, priority: nextPriority },
    }, guard);

    const readUpdated = c.env.DB.prepare(
      `SELECT id, workspace_id, project_id, parent_task_id, assignee_user_id, title, description, status, priority, due_at, completed_at, metadata_json, version, delivery_state, created_at, updated_at, deleted_at
       FROM tasks
       WHERE id = ?
       LIMIT 1`
    )
      .bind(taskId);
    const [written, , , snapshot] = await c.env.DB.batch([mutation, history, audit, readUpdated]);
    if (written.meta.changes !== 1) return error(c, 409, 'VERSION_CONFLICT', 'Resource changed during this request');
    const updated = snapshot.results[0];

    return ok(c, (await readableTasks(c,task.workspace_id,[updated as TaskRow]))[0]);
  });

  app.delete('/v1/tasks/:taskId', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:write')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:write scope');
    }

    const taskId = c.req.param('taskId');
    const task = await c.env.DB.prepare(
      `SELECT id, workspace_id, project_id, deleted_at, version, assignee_user_id, status, delivery_state
       FROM tasks
       WHERE id = ?
       LIMIT 1`
    )
      .bind(taskId)
      .first<{ id: string; workspace_id: string; project_id:string|null; deleted_at: string | null; version: number; assignee_user_id: string | null; status: TaskStatus; delivery_state: Stage | null }>();

    if (!task) {
      return error(c, 404, 'NOT_FOUND', 'Task not found');
    }

    const membership = await requireMembership(c, task.workspace_id, 'MEMBER');
    if ('error' in membership) {
      return membership.error;
    }
    const denied = await requireProject(c,task.project_id);if(denied)return denied;
    if(membership.projectIds!==null && task.deleted_at)return error(c,404,'NOT_FOUND','Task not found');

    if (task.deleted_at) {
      return ok(c, { id: taskId, deleted: true, already_deleted: true });
    }

    const accessGuard=membershipWriteGuard(c,task.workspace_id);
    const mutationId = newId('mut_');
    const mutation = c.env.DB.prepare(
      `UPDATE tasks
       SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, last_mutation_id = ?, version = version + 1
       WHERE id = ? AND deleted_at IS NULL AND version=? AND ${accessGuard.sql}`
    )
      .bind(mutationId, taskId,task.version,...accessGuard.params);
    const guard = { table: 'tasks' as const, id: taskId, mutationId };

    const history = prepareTaskHistory(c.env.DB, {
      workspaceId: task.workspace_id,
      taskId,
      actorUserId: principal.userId,
      changeType: 'DELETED',
      changeReason: 'manual',
      fromValue: { deleted_at: null },
      toValue: { deleted_at: new Date().toISOString() },
      metadata: null,
    }, guard);

    const audit = prepareAudit(c.env.DB, {
      workspaceId: task.workspace_id,
      actorUserId: principal.userId,
      action: 'DELETE_TASK',
      entityType: 'task',
      entityId: taskId,
      metadata: null,
    }, guard);

    const [written] = await c.env.DB.batch([mutation, history, audit]);
    if (written.meta.changes !== 1) return error(c, 409, 'VERSION_CONFLICT', 'Resource changed during this request');

    return ok(c, { id: taskId, deleted: true });
  });

  app.post('/v1/tasks/:taskId/restore', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:write')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:write scope');
    }

    const taskId = c.req.param('taskId');
    const task = await c.env.DB.prepare(
      `SELECT id, workspace_id, project_id, deleted_at, version, assignee_user_id, status, delivery_state
       FROM tasks
       WHERE id = ?
       LIMIT 1`
    )
      .bind(taskId)
      .first<{ id: string; workspace_id: string; project_id:string|null; deleted_at: string | null; version: number; assignee_user_id: string | null; status: TaskStatus; delivery_state: Stage | null }>();

    if (!task) {
      return error(c, 404, 'NOT_FOUND', 'Task not found');
    }

    const membership = await requireMembership(c, task.workspace_id, 'ADMIN');
    if ('error' in membership) {
      return membership.error;
    }
    const denied = await requireProject(c,task.project_id);if(denied)return denied;
    if(membership.projectIds!==null && task.deleted_at)return error(c,404,'NOT_FOUND','Task not found');

    if (!task.deleted_at) {
      return ok(c, { id: taskId, restored: true, already_restored: true });
    }

    const accessGuard=membershipWriteGuard(c,task.workspace_id);
    const mutationId = newId('mut_');
    const mutation = c.env.DB.prepare(
      `UPDATE tasks
       SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP, last_mutation_id = ?, version = version + 1
       WHERE id = ? AND deleted_at IS NOT NULL AND version = ?
         AND (assignee_user_id IS NULL OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = tasks.workspace_id AND m.user_id = tasks.assignee_user_id))
         AND (NOT ${activeTaskSql} OR assignee_user_id IS NULL OR ${freeActiveSlotSql}) AND ${accessGuard.sql}`
    )
      .bind(mutationId, taskId, task.version, task.workspace_id, task.assignee_user_id, taskId,...accessGuard.params);
    const guard = { table: 'tasks' as const, id: taskId, mutationId };

    const history = prepareTaskHistory(c.env.DB, {
      workspaceId: task.workspace_id,
      taskId,
      actorUserId: principal.userId,
      changeType: 'RESTORED',
      changeReason: 'manual',
      fromValue: { deleted_at: task.deleted_at },
      toValue: { deleted_at: null },
      metadata: null,
    }, guard);

    const audit = prepareAudit(c.env.DB, {
      workspaceId: task.workspace_id,
      actorUserId: principal.userId,
      action: 'RESTORE_TASK',
      entityType: 'task',
      entityId: taskId,
      metadata: null,
    }, guard);

    const [written] = await c.env.DB.batch([mutation, history, audit]);
    if (written.meta.changes !== 1) return error(c, 409, 'VERSION_CONFLICT', 'Resource changed during this request');

    return ok(c, { id: taskId, restored: true });
  });
}
