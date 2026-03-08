import type { Hono } from 'hono';
import { z } from 'zod';
import { ROLE_RANK } from '../lib/constants';
import { newId } from '../lib/ids';
import { decodeCursor, encodeCursor, parseLimit } from '../lib/pagination';
import { error, jsonBody, ok, validationError } from '../lib/response';
import type { AppEnv, Role } from '../lib/types';
import { writeAudit, writeTaskHistory } from '../services/audit';
import { hasScope, requireMembership } from '../services/authz';
import { buildAcceptInviteUrl, queueInviteEmail } from '../services/email';
import { issueInviteToken } from '../services/invites';

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
    const invite = await issueInviteToken(c.env);
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

    await c.env.DB.prepare(
      `INSERT INTO member_invites
       (id, workspace_id, user_id, email, role, created_by_user_id, token_prefix, token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        invite.id,
        workspaceId,
        user.id,
        email,
        targetRole,
        principal.userId,
        invite.tokenPrefix,
        invite.tokenHash,
        invite.expiresAt
      )
      .run();

    await writeAudit(c.env.DB, {
      workspaceId,
      actorUserId: principal.userId,
      action: 'UPSERT_MEMBERSHIP',
      entityType: 'membership',
      entityId: `${workspaceId}:${user.id}`,
      metadata: { role: payload.role, email, invite_id: invite.id, invite_prefix: invite.tokenPrefix },
    });

    const inviteUrl = buildAcceptInviteUrl(c, invite.raw);
    queueInviteEmail(c, {
      email,
      workspaceName: actorMembership.workspaceName,
      inviterEmail: principal.email,
      inviteUrl,
    });

    return ok(
      c,
      {
        workspace_id: workspaceId,
        user_id: user.id,
        email,
        role: targetRole,
        invite_id: invite.id,
        invite_token: invite.raw,
        invite_url: inviteUrl,
        invite_expires_at: invite.expiresAt,
      },
      201
    );
  });

  app.delete('/v1/workspaces/:workspaceId/members/:userId', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'members:write')) {
      return error(c, 403, 'FORBIDDEN', 'Missing members:write scope');
    }

    const workspaceId = c.req.param('workspaceId');
    const targetUserId = c.req.param('userId');
    const actorMembership = await requireMembership(c, workspaceId, 'ADMIN');
    if ('error' in actorMembership) {
      return actorMembership.error;
    }

    const targetMembership = await c.env.DB.prepare(
      `SELECT m.role, u.email
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? AND m.user_id = ?
       LIMIT 1`
    )
      .bind(workspaceId, targetUserId)
      .first<{ role: Role; email: string }>();

    if (!targetMembership) {
      return error(c, 404, 'NOT_FOUND', 'Member not found');
    }

    if (targetMembership.role === 'OWNER') {
      return error(c, 403, 'FORBIDDEN', 'Owner cannot be removed from workspace');
    }

    if (ROLE_RANK[targetMembership.role] >= ROLE_RANK[actorMembership.role] && principal.userId !== targetUserId) {
      return error(c, 403, 'FORBIDDEN', 'Cannot remove a member with equal or higher role');
    }

    const taskPolicy = c.req.query('task_policy');
    const reassignToUserId = c.req.query('reassign_to_user_id');

    if (taskPolicy && !['unassign', 'reassign'].includes(taskPolicy)) {
      return error(c, 400, 'INVALID_TASK_POLICY', 'task_policy must be one of: unassign, reassign');
    }

    if (taskPolicy === 'reassign') {
      if (!reassignToUserId) {
        return error(c, 400, 'MISSING_REASSIGN_USER', 'reassign_to_user_id is required when task_policy=reassign');
      }
      if (reassignToUserId === targetUserId) {
        return error(c, 400, 'INVALID_REASSIGN_USER', 'reassign_to_user_id must differ from removed user');
      }

      const replacementMembership = await c.env.DB.prepare(
        'SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ? LIMIT 1'
      )
        .bind(workspaceId, reassignToUserId)
        .first<{ role: Role }>();

      if (!replacementMembership) {
        return error(c, 400, 'INVALID_REASSIGN_USER', 'reassign_to_user_id is not a workspace member');
      }
    }

    const assignedTasks = await c.env.DB.prepare(
      `SELECT id, status, priority, due_at, assignee_user_id
       FROM tasks
       WHERE workspace_id = ? AND assignee_user_id = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC, id DESC`
    )
      .bind(workspaceId, targetUserId)
      .all<{
        id: string;
        status: string;
        priority: string;
        due_at: string | null;
        assignee_user_id: string | null;
      }>();

    const activeTasks = assignedTasks.results ?? [];
    if (activeTasks.length > 0 && !taskPolicy) {
      return error(c, 409, 'ASSIGNED_TASKS_EXIST', 'Member still has assigned tasks', {
        assigned_task_count: activeTasks.length,
        task_policy_options: ['unassign', 'reassign'],
      });
    }

    if (taskPolicy === 'unassign') {
      await c.env.DB.prepare(
        `UPDATE tasks
         SET assignee_user_id = NULL, version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = ? AND assignee_user_id = ? AND deleted_at IS NULL`
      )
        .bind(workspaceId, targetUserId)
        .run();

      for (const task of activeTasks) {
        await writeTaskHistory(c.env.DB, {
          workspaceId,
          taskId: task.id,
          actorUserId: principal.userId,
          changeType: 'ASSIGNEE_CHANGED',
          changeReason: 'manual',
          fromValue: { assignee_user_id: targetUserId },
          toValue: { assignee_user_id: null },
          metadata: { trigger: 'member_removed' },
        });
      }
    }

    if (taskPolicy === 'reassign' && reassignToUserId) {
      await c.env.DB.prepare(
        `UPDATE tasks
         SET assignee_user_id = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = ? AND assignee_user_id = ? AND deleted_at IS NULL`
      )
        .bind(reassignToUserId, workspaceId, targetUserId)
        .run();

      for (const task of activeTasks) {
        await writeTaskHistory(c.env.DB, {
          workspaceId,
          taskId: task.id,
          actorUserId: principal.userId,
          changeType: 'ASSIGNEE_CHANGED',
          changeReason: 'manual',
          fromValue: { assignee_user_id: targetUserId },
          toValue: { assignee_user_id: reassignToUserId },
          metadata: { trigger: 'member_removed' },
        });
      }
    }

    await c.env.DB.prepare(
      `DELETE FROM memberships
       WHERE workspace_id = ? AND user_id = ?`
    )
      .bind(workspaceId, targetUserId)
      .run();

    await writeAudit(c.env.DB, {
      workspaceId,
      actorUserId: principal.userId,
      action: 'REMOVE_MEMBERSHIP',
      entityType: 'membership',
      entityId: `${workspaceId}:${targetUserId}`,
      metadata: {
        email: targetMembership.email,
        role: targetMembership.role,
        task_policy: taskPolicy ?? null,
        reassigned_to_user_id: reassignToUserId ?? null,
        affected_task_count: activeTasks.length,
      },
    });

    return ok(c, {
      workspace_id: workspaceId,
      user_id: targetUserId,
      removed: true,
      task_policy: taskPolicy ?? null,
      reassigned_to_user_id: reassignToUserId ?? null,
      affected_task_count: activeTasks.length,
    });
  });
}
