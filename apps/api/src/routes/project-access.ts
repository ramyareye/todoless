import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../lib/types';
import { error, ok, jsonBody, validationError } from '../lib/response';
import { hasScope, requireMembership } from '../services/authz';
import { operation, operationGuard } from '../services/delivery-operations';
import { newId } from '../lib/ids';
import {
  projectListFilter,
  projectIdsSchema,
  validProjects
} from '../services/project-access';

const update = z
  .object({
    version: z.number().int().min(0),
    project_ids: projectIdsSchema.nullable(),
    reason: z.string().trim().min(1).max(2000)
  })
  .strict();

export function registerProjectAccessRoutes(app: Hono<AppEnv>) {
  const path = '/v1/workspaces/:workspaceId/members/:userId/project-access';
  app.get(path, async (c) => {
    if (!hasScope(c.get('principal'), 'members:read'))
      return error(c, 403, 'FORBIDDEN', 'Missing members:read scope');
    const workspace = c.req.param('workspaceId'),
      user = c.req.param('userId');
    const self = user === c.get('principal').userId;
    const member = await requireMembership(
      c,
      workspace,
      self ? 'VIEWER' : 'OWNER'
    );
    if ('error' in member) return member.error;
    const row = await c.env.DB.prepare(
      `SELECT m.user_id,a.project_ids_json,COALESCE(a.version,0) AS version
      FROM memberships m LEFT JOIN member_project_access a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
      WHERE m.workspace_id=? AND m.user_id=?`
    )
      .bind(workspace, user)
      .first<{
        user_id: string;
        project_ids_json: string | null;
        version: number;
      }>();
    if (!row) return error(c, 404, 'NOT_FOUND', 'Member not found');
    return ok(c, {
      workspace_id: workspace,
      user_id: user,
      version: row.version,
      project_ids:
        row.project_ids_json === null ? null : JSON.parse(row.project_ids_json)
    });
  });
  app.put(path, async (c) => {
    if (!hasScope(c.get('principal'), 'members:write'))
      return error(c, 403, 'FORBIDDEN', 'Missing members:write scope');
    const workspace = c.req.param('workspaceId'),
      user = c.req.param('userId');
    const member = await requireMembership(c, workspace, 'OWNER');
    if ('error' in member) return member.error;
    const input = await jsonBody(c);
    if (!input.ok) return input.response;
    const parsed = update.safeParse(input.data);
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const body = parsed.data;
    const target = await c.env.DB.prepare(
      'SELECT role FROM memberships WHERE workspace_id=? AND user_id=?'
    )
      .bind(workspace, user)
      .first<{ role: string }>();
    if (!target) return error(c, 404, 'NOT_FOUND', 'Member not found');
    if (!['MEMBER', 'VIEWER'].includes(target.role))
      return error(
        c,
        403,
        'FORBIDDEN',
        'Project restrictions apply to contributors/viewers, not workspace administrators'
      );
    if (
      body.project_ids !== null &&
      !(await validProjects(c.env.DB, workspace, body.project_ids))
    )
      return error(
        c,
        400,
        'INVALID_PROJECT',
        'Select active projects in this workspace'
      );
    const op = await operation(c, workspace, body);
    if ('response' in op) return op.response;
    const existing = await c.env.DB.prepare(
      'SELECT project_ids_json,version FROM member_project_access WHERE workspace_id=? AND user_id=?'
    )
      .bind(workspace, user)
      .first<{ project_ids_json: string | null; version: number }>();
    if ((existing?.version ?? 0) !== body.version)
      return error(
        c,
        409,
        'VERSION_CONFLICT',
        'Reload the current access policy'
      );
    const projects =
      body.project_ids === null ? null : JSON.stringify(body.project_ids);
    const data = {
      workspace_id: workspace,
      user_id: user,
      version: body.version + 1,
      project_ids: body.project_ids
    };
    return op.commit(
      `COALESCE((SELECT version FROM member_project_access WHERE workspace_id=? AND user_id=?),0)=?
      AND EXISTS (SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=? AND role IN ('MEMBER','VIEWER'))
      AND EXISTS (SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=? AND role='OWNER')
      AND NOT EXISTS (SELECT 1 FROM json_each(?) ids LEFT JOIN projects p ON p.id=ids.value AND p.workspace_id=? AND p.deleted_at IS NULL WHERE p.id IS NULL)`,
      [
        workspace,
        user,
        body.version,
        workspace,
        user,
        workspace,
        c.get('principal').userId,
        projects ?? '[]',
        workspace
      ],
      (id) => [
        c.env.DB.prepare(
          `INSERT INTO member_project_access (workspace_id,user_id,project_ids_json,version)
          SELECT ?,?,?,? WHERE ${operationGuard} ON CONFLICT(workspace_id,user_id) DO UPDATE
          SET project_ids_json=excluded.project_ids_json,version=excluded.version,updated_at=CURRENT_TIMESTAMP`
        ).bind(workspace, user, projects, body.version + 1, id),
        c.env.DB.prepare(
          `INSERT INTO audit_logs (id,workspace_id,actor_user_id,action,entity_type,entity_id,metadata_json)
          SELECT ?,?,?,'SET_PROJECT_ACCESS','membership',?,? WHERE ${operationGuard}`
        ).bind(
          newId('audit_'),
          workspace,
          c.get('principal').userId,
          user,
          JSON.stringify({
            from: existing?.project_ids_json
              ? JSON.parse(existing.project_ids_json)
              : null,
            to: body.project_ids,
            version: data.version,
            reason: body.reason
          }),
          id
        )
      ],
      data
    );
  });
  app.get('/v1/workspaces/:workspaceId/onboarding', async (c) => {
    if (!hasScope(c.get('principal'), 'workspace:read'))
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:read scope');
    const workspace = c.req.param('workspaceId');
    const member = await requireMembership(c, workspace, 'VIEWER');
    if ('error' in member) return member.error;
    const filter = projectListFilter(c, 'id');
    const projects = (
      await c.env.DB.prepare(
        `SELECT id,name FROM projects WHERE workspace_id=? AND deleted_at IS NULL AND ${filter.sql} ORDER BY name,id`
      )
        .bind(workspace, ...filter.params)
        .all()
    ).results;
    return ok(c, {
      workspace_id: workspace,
      user_id: c.get('principal').userId,
      role: member.role,
      access_mode: member.projectIds === null ? 'workspace' : 'projects',
      projects,
      can_manage_tasks:
        member.role !== 'VIEWER' &&
        hasScope(c.get('principal'), 'workspace:write'),
      instructions: [
        "Use your own personal Todoless connection. Never ask for or share another person's key.",
        'These are your accessible projects. Read their current tasks before creating anything; reuse existing task IDs.',
        'Ask which frontend/backend project and desired result if unclear. Keep both queues separate; link real dependencies.',
        'Keep new requests in Backlog until scope, assignee, owner reviewer, setup and acceptance are agreed. Do not invent dates or hours.',
        'For a blocker record who can resolve it, the reason and next action. Keep one Active task per person and two Ready alternatives.',
        'Show a plain-language summary of priorities, progress, blockers and decisions needed. Work paused for a personal day is not overdue.',
        'Only an owner/admin assigns reviewers. Never record human approval, native acceptance or completion without the actual evidence/decision.',
        'No code execution, invitations, permission/provider changes, commits, pushes, deployments, Purchase/Restore/refunds or payments follow from managing tasks.',
        ...(member.projectIds !== null
          ? [
              'Workspace administration, cross-project time reports, approvals and the personal portfolio are unavailable on project-restricted memberships.'
            ]
          : [])
      ],
      example_requests: [
        'What is ready, blocked and waiting for review in my projects?',
        'Add this frontend request as Backlog, after checking for duplicates: ...',
        'Link this task to the backend prerequisite and record who needs to unblock it.'
      ]
    });
  });
}
