import type { Hono } from 'hono';
import { z } from 'zod';
import { decodeCursor, encodeCursor, parseLimit } from '../lib/pagination';
import { makeWorkspaceSlug, newId } from '../lib/ids';
import { error, jsonBody, ok, validationError } from '../lib/response';
import type { AppEnv, Role } from '../lib/types';
import { writeAudit } from '../services/audit';
import { hasScope, requireMembership } from '../services/authz';

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/).optional(),
});

export function registerWorkspaceRoutes(app: Hono<AppEnv>) {
  app.get('/v1/workspaces', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:read')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:read scope');
    }

    const limit = parseLimit(c.req.query('limit'), 20, 100);
    const cursor = decodeCursor(c.req.query('cursor'));

    const whereClauses: string[] = ['m.user_id = ?', 'w.deleted_at IS NULL'];
    const params: (string | number)[] = [principal.userId];
    if (principal.workspaceId) {
      whereClauses.push('w.id = ?');
      params.push(principal.workspaceId);
    }
    if (cursor) {
      whereClauses.push('(w.created_at < ? OR (w.created_at = ? AND w.id < ?))');
      params.push(cursor.ts, cursor.ts, cursor.id);
    }
    params.push(limit + 1);

    const rows = await c.env.DB.prepare(
      `SELECT w.id, w.slug, w.name, w.created_at, m.role
       FROM memberships m
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY w.created_at DESC, w.id DESC
       LIMIT ?`
    )
      .bind(...params)
      .all<{
        id: string;
        slug: string;
        name: string;
        created_at: string;
        role: Role;
      }>();

    const workspaces = rows.results ?? [];
    const hasMore = workspaces.length > limit;
    const page = hasMore ? workspaces.slice(0, limit) : workspaces;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ ts: last.created_at, id: last.id }) : null;

    return ok(c, {
      workspaces: page,
      pagination: {
        limit,
        next_cursor: nextCursor,
        has_more: hasMore,
      },
    });
  });

  app.post('/v1/workspaces', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:write')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:write scope');
    }

    const body = await jsonBody(c);
    if (!body.ok) {
      return body.response;
    }
    const parsed = createWorkspaceSchema.safeParse(body.data);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }

    const payload = parsed.data;
    const workspaceId = newId('ws_');
    const membershipId = newId('mem_');
    const slug = payload.slug ?? makeWorkspaceSlug(payload.name);

    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          'INSERT INTO workspaces (id, slug, name, created_by_user_id) VALUES (?, ?, ?, ?)'
        ).bind(workspaceId, slug, payload.name.trim(), principal.userId),
        c.env.DB.prepare('INSERT INTO memberships (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)').bind(
          membershipId,
          workspaceId,
          principal.userId,
          'OWNER'
        ),
      ]);
    } catch (err) {
      if (String(err).includes('UNIQUE constraint failed: workspaces.slug')) {
        return error(c, 409, 'SLUG_EXISTS', 'Workspace slug already exists');
      }
      throw err;
    }

    await writeAudit(c.env.DB, {
      workspaceId,
      actorUserId: principal.userId,
      action: 'CREATE_WORKSPACE',
      entityType: 'workspace',
      entityId: workspaceId,
      metadata: { slug },
    });

    return ok(
      c,
      {
        id: workspaceId,
        slug,
        name: payload.name.trim(),
        role: 'OWNER',
      },
      201
    );
  });

  app.get('/v1/workspaces/:workspaceId', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'workspace:read')) {
      return error(c, 403, 'FORBIDDEN', 'Missing workspace:read scope');
    }

    const workspaceId = c.req.param('workspaceId');
    const membership = await requireMembership(c, workspaceId, 'VIEWER');
    if ('error' in membership) {
      return membership.error;
    }

    return ok(c, {
      id: membership.workspaceId,
      slug: membership.workspaceSlug,
      name: membership.workspaceName,
      role: membership.role,
    });
  });

}
