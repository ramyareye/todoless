import type { Hono } from 'hono';
import { z } from 'zod';
import { ROLE_RANK } from '../lib/constants';
import { newId } from '../lib/ids';
import { error, jsonBody, ok, validationError } from '../lib/response';
import type { AppEnv } from '../lib/types';
import { writeAudit, writeProjectHistory } from '../services/audit';
import { hasScope, requireMembership } from '../services/authz';

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  change_reason: z
    .enum(['manual', 'deadline_shift', 'dependency_blocked', 'rebalancing', 'system'])
    .optional(),
});

export function registerProjectRoutes(app: Hono<AppEnv>) {
  app.post('/v1/workspaces/:workspaceId/projects', async (c) => {
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
    const parsed = createProjectSchema.safeParse(body.data);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }

    const payload = parsed.data;
    const projectId = newId('prj_');
    const name = payload.name.trim();
    const description = payload.description?.trim() || null;

    await c.env.DB.prepare(
      `INSERT INTO projects (id, workspace_id, name, description)
       VALUES (?, ?, ?, ?)`
    )
      .bind(projectId, workspaceId, name, description)
      .run();

    await writeProjectHistory(c.env.DB, {
      workspaceId,
      projectId,
      actorUserId: principal.userId,
      changeType: 'CREATED',
      changeReason: 'manual',
      fromValue: null,
      toValue: { name, description },
      metadata: null,
    });

    await writeAudit(c.env.DB, {
      workspaceId,
      actorUserId: principal.userId,
      action: 'CREATE_PROJECT',
      entityType: 'project',
      entityId: projectId,
      metadata: { name },
    });

    return ok(
      c,
      {
        id: projectId,
        workspace_id: workspaceId,
        name,
        description,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      },
      201
    );
  });

  app.get('/v1/workspaces/:workspaceId/projects', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:read')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:read scope');
    }

    const workspaceId = c.req.param('workspaceId');
    const membership = await requireMembership(c, workspaceId, 'VIEWER');
    if ('error' in membership) {
      return membership.error;
    }

    const includeDeleted = c.req.query('include_deleted') === 'true';
    if (includeDeleted && ROLE_RANK[membership.role] < ROLE_RANK.ADMIN) {
      return error(c, 403, 'FORBIDDEN', 'Only ADMIN+ can include deleted projects');
    }

    const rows = includeDeleted
      ? await c.env.DB.prepare(
          `SELECT id, workspace_id, name, description, created_at, updated_at, deleted_at
           FROM projects
           WHERE workspace_id = ?
           ORDER BY created_at DESC`
        )
          .bind(workspaceId)
          .all()
      : await c.env.DB.prepare(
          `SELECT id, workspace_id, name, description, created_at, updated_at, deleted_at
           FROM projects
           WHERE workspace_id = ? AND deleted_at IS NULL
           ORDER BY created_at DESC`
        )
          .bind(workspaceId)
          .all();

    return ok(c, {
      workspace_id: workspaceId,
      projects: rows.results ?? [],
    });
  });

  app.get('/v1/projects/:projectId', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:read')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:read scope');
    }

    const projectId = c.req.param('projectId');
    const project = await c.env.DB.prepare(
      `SELECT id, workspace_id, name, description, created_at, updated_at, deleted_at
       FROM projects
       WHERE id = ?
       LIMIT 1`
    )
      .bind(projectId)
      .first<{
        id: string;
        workspace_id: string;
        name: string;
        description: string | null;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
      }>();

    if (!project) {
      return error(c, 404, 'NOT_FOUND', 'Project not found');
    }

    const membership = await requireMembership(c, project.workspace_id, 'VIEWER');
    if ('error' in membership) {
      return membership.error;
    }

    return ok(c, project);
  });

  app.patch('/v1/projects/:projectId', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:write')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:write scope');
    }

    const projectId = c.req.param('projectId');
    const project = await c.env.DB.prepare(
      `SELECT id, workspace_id, name, description, created_at, updated_at, deleted_at
       FROM projects
       WHERE id = ?
       LIMIT 1`
    )
      .bind(projectId)
      .first<{
        id: string;
        workspace_id: string;
        name: string;
        description: string | null;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
      }>();

    if (!project) {
      return error(c, 404, 'NOT_FOUND', 'Project not found');
    }

    const membership = await requireMembership(c, project.workspace_id, 'MEMBER');
    if ('error' in membership) {
      return membership.error;
    }

    const body = await jsonBody(c);
    if (!body.ok) {
      return body.response;
    }
    const parsed = updateProjectSchema.safeParse(body.data);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }

    const payload = parsed.data;
    if (payload.name === undefined && payload.description === undefined) {
      return error(c, 400, 'VALIDATION_ERROR', 'No updatable fields were provided');
    }

    const nextName = payload.name?.trim() ?? project.name;
    const nextDescription =
      payload.description === undefined
        ? project.description
        : payload.description === null
          ? null
          : payload.description.trim();

    await c.env.DB.prepare(
      `UPDATE projects
       SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
      .bind(nextName, nextDescription, projectId)
      .run();

    await writeProjectHistory(c.env.DB, {
      workspaceId: project.workspace_id,
      projectId,
      actorUserId: principal.userId,
      changeType: 'UPDATED',
      changeReason: payload.change_reason ?? 'manual',
      fromValue: { name: project.name, description: project.description },
      toValue: { name: nextName, description: nextDescription },
      metadata: null,
    });

    await writeAudit(c.env.DB, {
      workspaceId: project.workspace_id,
      actorUserId: principal.userId,
      action: 'UPDATE_PROJECT',
      entityType: 'project',
      entityId: projectId,
      metadata: { name: nextName },
    });

    const updated = await c.env.DB.prepare(
      `SELECT id, workspace_id, name, description, created_at, updated_at, deleted_at
       FROM projects
       WHERE id = ?
       LIMIT 1`
    )
      .bind(projectId)
      .first();

    return ok(c, updated);
  });

  app.delete('/v1/projects/:projectId', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:write')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:write scope');
    }

    const projectId = c.req.param('projectId');
    const project = await c.env.DB.prepare(
      `SELECT id, workspace_id, name, deleted_at
       FROM projects
       WHERE id = ?
       LIMIT 1`
    )
      .bind(projectId)
      .first<{
        id: string;
        workspace_id: string;
        name: string;
        deleted_at: string | null;
      }>();

    if (!project) {
      return error(c, 404, 'NOT_FOUND', 'Project not found');
    }

    const membership = await requireMembership(c, project.workspace_id, 'ADMIN');
    if ('error' in membership) {
      return membership.error;
    }

    if (project.deleted_at) {
      return ok(c, { id: projectId, deleted: true, already_deleted: true });
    }

    await c.env.DB.prepare(
      `UPDATE projects
       SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
      .bind(projectId)
      .run();

    await writeProjectHistory(c.env.DB, {
      workspaceId: project.workspace_id,
      projectId,
      actorUserId: principal.userId,
      changeType: 'DELETED',
      changeReason: 'manual',
      fromValue: { deleted_at: null },
      toValue: { deleted_at: new Date().toISOString() },
      metadata: null,
    });

    await writeAudit(c.env.DB, {
      workspaceId: project.workspace_id,
      actorUserId: principal.userId,
      action: 'DELETE_PROJECT',
      entityType: 'project',
      entityId: projectId,
      metadata: null,
    });

    return ok(c, { id: projectId, deleted: true });
  });
}
