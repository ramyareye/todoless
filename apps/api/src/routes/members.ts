import type { Hono } from 'hono';
import { z } from 'zod';
import { ROLE_RANK } from '../lib/constants';
import { newId } from '../lib/ids';
import { decodeCursor, encodeCursor, parseLimit } from '../lib/pagination';
import { error, jsonBody, ok, validationError } from '../lib/response';
import type { AppEnv, Role } from '../lib/types';
import { writeAudit } from '../services/audit';
import { hasScope, requireMembership } from '../services/authz';

const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']),
});

export function registerMemberRoutes(app: Hono<AppEnv>) {
  app.get('/v1/workspaces/:workspaceId/members', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'members:read')) {
      return error(c, 403, 'FORBIDDEN', 'Missing members:read scope');
    }

    const workspaceId = c.req.param('workspaceId');
    const membership = await requireMembership(c, workspaceId, 'VIEWER');
    if ('error' in membership) {
      return membership.error;
    }

    const limit = parseLimit(c.req.query('limit'), 50, 100);
    const cursor = decodeCursor(c.req.query('cursor'));
    const whereClauses: string[] = ['m.workspace_id = ?'];
    const params: (string | number)[] = [workspaceId];
    if (cursor) {
      whereClauses.push('(m.created_at > ? OR (m.created_at = ? AND m.id > ?))');
      params.push(cursor.ts, cursor.ts, cursor.id);
    }
    params.push(limit + 1);

    const rows = await c.env.DB.prepare(
      `SELECT m.id, m.role, m.created_at, u.id AS user_id, u.email, u.display_name
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT ?`
    )
      .bind(...params)
      .all<{
        id: string;
        role: Role;
        created_at: string;
        user_id: string;
        email: string;
        display_name: string | null;
      }>();

    const members = rows.results ?? [];
    const hasMore = members.length > limit;
    const page = hasMore ? members.slice(0, limit) : members;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ ts: last.created_at, id: last.id }) : null;

    return ok(c, {
      workspace_id: workspaceId,
      role: membership.role,
      members: page,
      pagination: {
        limit,
        next_cursor: nextCursor,
        has_more: hasMore,
      },
    });
  });

  app.post('/v1/workspaces/:workspaceId/members', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'members:write')) {
      return error(c, 403, 'FORBIDDEN', 'Missing members:write scope');
    }

    const workspaceId = c.req.param('workspaceId');
    const actorMembership = await requireMembership(c, workspaceId, 'ADMIN');
    if ('error' in actorMembership) {
      return actorMembership.error;
    }

    const body = await jsonBody(c);
    if (!body.ok) {
      return body.response;
    }
    const parsed = addMemberSchema.safeParse(body.data);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }

    const payload = parsed.data;
    const email = payload.email.trim().toLowerCase();
    const targetRole = payload.role as Role;

    if (ROLE_RANK[targetRole] > ROLE_RANK[actorMembership.role]) {
      return error(c, 403, 'FORBIDDEN', 'Cannot assign a role higher than your own');
    }

    let user = await c.env.DB.prepare('SELECT id, email FROM users WHERE email = ? LIMIT 1')
      .bind(email)
      .first<{ id: string; email: string }>();

    if (!user) {
      const userId = newId('usr_');
      await c.env.DB.prepare('INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)')
        .bind(userId, email, null)
        .run();
      user = { id: userId, email };
    }

    const existingMembership = await c.env.DB.prepare(
      'SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ? LIMIT 1'
    )
      .bind(workspaceId, user.id)
      .first<{ role: Role }>();

    if (existingMembership?.role === 'OWNER') {
      return error(c, 403, 'FORBIDDEN', 'Owner role cannot be changed');
    }

    const membershipId = newId('mem_');
    if (existingMembership) {
      await c.env.DB.prepare(
        `UPDATE memberships
         SET role = ?, updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = ? AND user_id = ?`
      )
        .bind(targetRole, workspaceId, user.id)
        .run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO memberships (id, workspace_id, user_id, role)
         VALUES (?, ?, ?, ?)`
      )
        .bind(membershipId, workspaceId, user.id, targetRole)
        .run();
    }

    await writeAudit(c.env.DB, {
      workspaceId,
      actorUserId: principal.userId,
      action: 'UPSERT_MEMBERSHIP',
      entityType: 'membership',
      entityId: `${workspaceId}:${user.id}`,
      metadata: { role: payload.role, email },
    });

    return ok(
      c,
      {
        workspace_id: workspaceId,
        user_id: user.id,
        email,
        role: targetRole,
      },
      201
    );
  });
}
