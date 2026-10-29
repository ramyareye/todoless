import { z } from 'zod';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/types';
import { error } from '../lib/response';

export const projectAllowed = (ids: string[] | null, project: string | null) =>
  ids === null || (project !== null && ids.includes(project));

export async function requireProject(
  c: Context<AppEnv>,
  project: string | null
) {
  const access = c.get('projectAccess');
  if (access.projectIds === null) return null;
  if (
    projectAllowed(access.projectIds, project) &&
    (await c.env.DB.prepare(
      'SELECT 1 FROM projects WHERE id=? AND workspace_id=? AND deleted_at IS NULL'
    )
      .bind(project, access.workspaceId)
      .first())
  )
    return null;
  return error(c, 404, 'NOT_FOUND', 'Project or task not found');
}

// Used inside assignee/reference queries and atomic writes, not a UI-only filter.
export const memberCanAccessProjectSql = (member: string, project: string) =>
  `NOT EXISTS (SELECT 1 FROM member_project_access access WHERE access.workspace_id=${member}.workspace_id
    AND access.user_id=${member}.user_id AND access.project_ids_json IS NOT NULL
    AND (${project} IS NULL OR NOT EXISTS (SELECT 1 FROM json_each(access.project_ids_json) WHERE value=${project})))`;

export function projectListFilter(c: Context<AppEnv>, column: string) {
  const ids = c.get('projectAccess').projectIds;
  return {
    sql:
      ids === null
        ? '1'
        : `${column} IN (SELECT access_project.id FROM projects access_project WHERE access_project.deleted_at IS NULL AND access_project.id IN (SELECT value FROM json_each(?)))`,
    params: ids === null ? [] : [JSON.stringify(ids)]
  };
}

export async function referenceAllowed(
  c: Context<AppEnv>,
  workspace: string,
  taskId: string
) {
  const row = await c.env.DB.prepare(
    'SELECT t.project_id FROM tasks t JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id WHERE t.id=? AND t.workspace_id=? AND t.deleted_at IS NULL AND p.deleted_at IS NULL'
  )
    .bind(taskId, workspace)
    .first<{ project_id: string | null }>();
  return Boolean(
    row && projectAllowed(c.get('projectAccess').projectIds, row.project_id)
  );
}

export function referenceWriteGuard(
  c: Context<AppEnv>,
  workspace: string,
  ids: string[],
  project: string | null
) {
  const allowed = c.get('projectAccess').projectIds;
  return {
    sql: `(? IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id=? AND workspace_id=? AND deleted_at IS NULL))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) requested LEFT JOIN tasks ref ON ref.id=requested.value
        LEFT JOIN projects ref_project ON ref_project.id=ref.project_id AND ref_project.workspace_id=ref.workspace_id
        WHERE ref.id IS NULL OR ref.workspace_id!=? OR ref.deleted_at IS NOT NULL OR
          (? IS NOT NULL AND (ref.project_id IS NULL OR ref_project.id IS NULL OR ref_project.deleted_at IS NOT NULL OR ref.project_id NOT IN (SELECT value FROM json_each(?)))))`,
    params: [
      allowed === null ? null : JSON.stringify(allowed),
      project,
      workspace,
      JSON.stringify(ids),
      workspace,
      allowed === null ? null : JSON.stringify(allowed),
      JSON.stringify(allowed ?? [])
    ]
  };
}

export async function readableTasks<
  T extends { parent_task_id?: string | null }
>(c: Context<AppEnv>, workspace: string, tasks: T[]) {
  if (c.get('projectAccess').projectIds === null) return tasks;
  const parents = [
    ...new Set(
      tasks.flatMap((t) => (t.parent_task_id ? [t.parent_task_id] : []))
    )
  ];
  const visible = new Set<string>();
  for (const id of parents)
    if (await referenceAllowed(c, workspace, id)) visible.add(id);
  return tasks.map((t) =>
    t.parent_task_id && !visible.has(t.parent_task_id)
      ? { ...t, parent_task_id: null }
      : t
  );
}

export function readableDependencies<
  T extends { depends_on: { id: string }[] }
>(
  c: Context<AppEnv>,
  card: T,
  dependencies: {
    id: string;
    project_id: string | null;
    project_live: number;
    deleted_at: string | null;
  }[]
) {
  const ids = c.get('projectAccess').projectIds;
  if (ids === null) return card;
  const visible = new Set(
    dependencies
      .filter(
        (d) =>
          projectAllowed(ids, d.project_id) && d.project_live && !d.deleted_at
      )
      .map((d) => d.id)
  );
  const filtered = card.depends_on.filter((d) => visible.has(d.id));
  return {
    ...card,
    depends_on: filtered,
    has_restricted_dependencies: filtered.length !== card.depends_on.length
  };
}

export async function readableHistoryValue(
  c: Context<AppEnv>,
  workspace: string,
  raw: unknown
): Promise<unknown> {
  if (!raw || typeof raw !== 'object') return raw;
  const value = { ...(raw as Record<string, unknown>) };
  if (
    typeof value.parent_task_id === 'string' &&
    !(await referenceAllowed(c, workspace, value.parent_task_id))
  )
    value.parent_task_id = null;
  if (Array.isArray(value.depends_on)) {
    const visible = [];
    for (const id of value.depends_on)
      if (typeof id === 'string' && (await referenceAllowed(c, workspace, id)))
        visible.push(id);
    value.depends_on = visible;
  }
  return value;
}

export const projectIdsSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate project');

export async function validProjects(
  db: D1Database,
  workspace: string,
  ids: string[]
) {
  const invalid = await db
    .prepare(
      `SELECT 1 FROM json_each(?) requested LEFT JOIN projects p
    ON p.id=requested.value AND p.workspace_id=? AND p.deleted_at IS NULL WHERE p.id IS NULL LIMIT 1`
    )
    .bind(JSON.stringify(ids), workspace)
    .first();
  return !invalid;
}
