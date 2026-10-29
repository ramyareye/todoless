import type { Hono } from 'hono';
import { z } from 'zod';
import { ROLE_RANK } from '../lib/constants';
import { newId } from '../lib/ids';
import { decodeCursor, encodeCursor, parseLimit } from '../lib/pagination';
import { exposesDevelopmentTokens } from '../lib/development-tokens';
import { error, jsonBody, ok, validationError } from '../lib/response';
import type { AppEnv, Role } from '../lib/types';
import { activeTaskSql } from '../services/task-delivery';
import { hasScope, requireMembership, membershipWriteGuard } from '../services/authz';
import { buildAcceptInviteUrl, isEmailDeliveryConfigured, queueInviteEmail } from '../services/email';
import { issueInviteToken } from '../services/invites';
import { projectIdsSchema, validProjects } from '../services/project-access';

const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']),
  project_ids: projectIdsSchema.optional(),
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
    if(membership.projectIds!==null){
      // Only people who can access at least one of the same projects are assignable.
      whereClauses.push(`(m.user_id=? OR NOT EXISTS (SELECT 1 FROM member_project_access policy WHERE policy.workspace_id=m.workspace_id AND policy.user_id=m.user_id AND policy.project_ids_json IS NOT NULL)
        OR EXISTS (SELECT 1 FROM member_project_access policy,json_each(policy.project_ids_json) granted WHERE policy.workspace_id=m.workspace_id AND policy.user_id=m.user_id AND granted.value IN (SELECT value FROM json_each(?))))`);
      params.push(principal.userId,JSON.stringify(membership.projectIds));
    }
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
    c.header('cache-control', 'no-store');
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
    if(payload.project_ids!==undefined){
      if(actorMembership.role!=='OWNER'||targetRole==='ADMIN')return error(c,403,'FORBIDDEN','Only an owner can invite project-restricted contributors/viewers');
      if(!await validProjects(c.env.DB,workspaceId,payload.project_ids))return error(c,400,'INVALID_PROJECT','Select active projects in this workspace');
    }

    if (ROLE_RANK[targetRole] > ROLE_RANK[actorMembership.role]) {
      return error(c, 403, 'FORBIDDEN', 'Cannot assign a role higher than your own');
    }

    const exposeToken = exposesDevelopmentTokens(c.env);
    if (!exposeToken && !isEmailDeliveryConfigured(c.env)) {
      return error(c, 500, 'SERVER_MISCONFIGURED', 'Invitation email delivery must be configured');
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
    const existingPolicy=await c.env.DB.prepare('SELECT project_ids_json,version FROM member_project_access WHERE workspace_id=? AND user_id=?')
      .bind(workspaceId,user.id).first<{project_ids_json:string|null;version:number}>();
    if(existingMembership && payload.project_ids!==undefined && (existingPolicy?.project_ids_json==null || JSON.stringify([...JSON.parse(existingPolicy.project_ids_json)].sort())!==JSON.stringify([...payload.project_ids].sort())))
      return error(c,409,'ACCESS_CHANGE_REQUIRED','Change existing member access through the versioned project-access endpoint first');
    if(existingPolicy?.project_ids_json!==undefined && existingPolicy.project_ids_json!==null && targetRole==='ADMIN')
      return error(c,403,'FORBIDDEN','Project-restricted members cannot be promoted through an invitation');

    const membershipId = newId('mem_');
    const invite = await issueInviteToken(c.env);
    const receiptId=newId('audit_');
    const accessGuard=membershipWriteGuard(c,workspaceId);
    const receiptGuard='EXISTS (SELECT 1 FROM audit_logs WHERE id=?)';
    const metadata={role:payload.role,email,invite_id:invite.id,invite_prefix:invite.tokenPrefix,...(payload.project_ids!==undefined?{project_ids:payload.project_ids}:{})};
    const targetGuard=existingMembership
      ? 'EXISTS (SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=? AND role=?)'
      : 'NOT EXISTS (SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?)';
    const targetParams=existingMembership?[workspaceId,user.id,existingMembership.role]:[workspaceId,user.id];
    const membershipWrite = existingMembership
      ? c.env.DB.prepare(`UPDATE memberships SET role=?,updated_at=CURRENT_TIMESTAMP WHERE workspace_id=? AND user_id=? AND ${receiptGuard}`)
        .bind(targetRole,workspaceId,user.id,receiptId)
      : c.env.DB.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role) SELECT ?,?,?,? WHERE ${receiptGuard}`)
        .bind(membershipId,workspaceId,user.id,targetRole,receiptId);
    // Membership, initial allowlist, invitation and audit share one receipt/transaction.
    // A stale owner/admin or changed target policy cannot send an unrestricted invite.
    const [written]=await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO audit_logs(id,workspace_id,actor_user_id,action,entity_type,entity_id,metadata_json)
        SELECT ?,?,?,'UPSERT_MEMBERSHIP','membership',?,? WHERE ${accessGuard.sql} AND ${targetGuard}
        AND COALESCE((SELECT version FROM member_project_access WHERE workspace_id=? AND user_id=?),0)=?
        AND (?=0 OR EXISTS (SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=? AND role='OWNER'))
        AND NOT EXISTS (SELECT 1 FROM json_each(?) ids LEFT JOIN projects p ON p.id=ids.value AND p.workspace_id=? AND p.deleted_at IS NULL WHERE p.id IS NULL)`)
        .bind(receiptId,workspaceId,principal.userId,`${workspaceId}:${user.id}`,JSON.stringify(metadata),...accessGuard.params,...targetParams,
          workspaceId,user.id,existingPolicy?.version??0,payload.project_ids===undefined?0:1,workspaceId,principal.userId,JSON.stringify(payload.project_ids??[]),workspaceId),
      membershipWrite,
      ...(!existingMembership&&payload.project_ids!==undefined?[c.env.DB.prepare(
        `INSERT INTO member_project_access(workspace_id,user_id,project_ids_json,version) SELECT ?,?,?,1 WHERE ${receiptGuard}`
      ).bind(workspaceId,user.id,JSON.stringify(payload.project_ids),receiptId)]:[]),
      c.env.DB.prepare(`DELETE FROM time_approvers WHERE workspace_id=? AND user_id=? AND ?='VIEWER' AND ${receiptGuard}`)
        .bind(workspaceId,user.id,targetRole,receiptId),
      c.env.DB.prepare(`UPDATE member_invites SET expires_at=CURRENT_TIMESTAMP WHERE workspace_id=? AND user_id=? AND claimed_at IS NULL AND ${receiptGuard}`)
        .bind(workspaceId,user.id,receiptId),
      c.env.DB.prepare(`INSERT INTO member_invites(id,workspace_id,user_id,email,role,created_by_user_id,token_prefix,token_hash,expires_at)
        SELECT ?,?,?,?,?,?,?,?,? WHERE ${receiptGuard}`)
        .bind(invite.id,workspaceId,user.id,email,targetRole,principal.userId,invite.tokenPrefix,invite.tokenHash,invite.expiresAt,receiptId)
    ]);
    if(written.meta.changes!==1)return error(c,409,'MEMBERSHIP_CHANGED','Access or membership changed; reload before inviting');

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
        invite_delivery: exposeToken ? 'development_response' : 'email',
        invite_token: exposeToken ? invite.raw : undefined,
        invite_url: exposeToken ? inviteUrl : undefined,
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

    const auditId = newId('audit_');
    const nextAssignee = taskPolicy === 'reassign' ? reassignToUserId! : null;
    const guard = 'EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)';
    const metadata = { email: targetMembership.email, role: targetMembership.role, task_policy: taskPolicy ?? null, reassigned_to_user_id: nextAssignee };
    // The audit insert is the transaction receipt. Task snapshots are taken from
    // the rows actually reassigned in this transaction, not an earlier read.
    const [removed] = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO audit_logs (id,workspace_id,actor_user_id,action,entity_type,entity_id,metadata_json)
        SELECT ?,?,?,'REMOVE_MEMBERSHIP','membership',?,json_set(?, '$.affected_task_count',
          (SELECT count(*) FROM tasks WHERE workspace_id = ? AND assignee_user_id = ? AND deleted_at IS NULL))
        WHERE EXISTS (SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND role = ?)
          AND EXISTS (SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND role = ?)
          AND (? OR NOT EXISTS (SELECT 1 FROM tasks WHERE workspace_id = ? AND assignee_user_id = ? AND deleted_at IS NULL))
          AND (? IS NULL OR EXISTS (SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?))
          AND (? IS NULL OR (SELECT count(*) FROM tasks WHERE workspace_id = ? AND assignee_user_id IN (?,?) AND deleted_at IS NULL AND ${activeTaskSql}) <= 1)`)
        .bind(auditId, workspaceId, principal.userId, `${workspaceId}:${targetUserId}`, JSON.stringify(metadata), workspaceId, targetUserId,
          workspaceId, targetUserId, targetMembership.role, workspaceId, principal.userId, actorMembership.role,
          taskPolicy ? 1 : 0, workspaceId, targetUserId, nextAssignee, workspaceId, nextAssignee,
          nextAssignee, workspaceId, targetUserId, nextAssignee),
      c.env.DB.prepare(`INSERT INTO task_history (id,workspace_id,task_id,actor_user_id,change_type,change_reason,from_value_json,to_value_json,metadata_json)
        SELECT 'th_' || lower(hex(randomblob(16))),workspace_id,id,?,'ASSIGNEE_CHANGED','manual',json_object('assignee_user_id',assignee_user_id),json_object('assignee_user_id',?),'{"trigger":"member_removed"}'
        FROM tasks WHERE workspace_id = ? AND assignee_user_id = ? AND deleted_at IS NULL AND ${guard}`)
        .bind(principal.userId, nextAssignee, workspaceId, targetUserId, auditId),
      c.env.DB.prepare(`UPDATE tasks SET assignee_user_id = ?,version = version + 1,updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND assignee_user_id = ? AND deleted_at IS NULL AND ${guard}`).bind(nextAssignee, workspaceId, targetUserId, auditId),
      c.env.DB.prepare(`DELETE FROM memberships WHERE workspace_id = ? AND user_id = ? AND ${guard}`).bind(workspaceId, targetUserId, auditId),
      c.env.DB.prepare(`DELETE FROM time_approvers WHERE workspace_id = ? AND user_id = ? AND ${guard}`).bind(workspaceId, targetUserId, auditId),
      c.env.DB.prepare(`UPDATE member_invites SET expires_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND user_id = ? AND claimed_at IS NULL AND ${guard}`).bind(workspaceId, targetUserId, auditId),
    ]);
    if (removed.meta.changes !== 1) return error(c, 409, 'MEMBERSHIP_CHANGED', 'Membership or assigned work changed; reload before removal');
    const actual = await c.env.DB.prepare('SELECT metadata_json FROM audit_logs WHERE id = ?').bind(auditId).first<{metadata_json: string}>();
    const affectedCount = JSON.parse(actual!.metadata_json).affected_task_count;

    return ok(c, {
      workspace_id: workspaceId,
      user_id: targetUserId,
      removed: true,
      task_policy: taskPolicy ?? null,
      reassigned_to_user_id: reassignToUserId ?? null,
      affected_task_count: affectedCount,
    });
  });
}
