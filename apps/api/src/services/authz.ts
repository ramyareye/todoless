import type { Context } from 'hono';
import { ROLE_RANK } from '../lib/constants';
import type { AppEnv, Principal, Role, Scope } from '../lib/types';
import { error } from '../lib/response';

export function hasScope(principal: Principal, needed: Scope): boolean {
  if (principal.scopes.includes('*')) {
    return true;
  }
  if (principal.scopes.includes(needed)) {
    return true;
  }
  const [namespace] = needed.split(':');
  return principal.scopes.includes(`${namespace}:*`);
}

export async function requireMembership(
  c: Context<AppEnv>,
  workspaceId: string,
  minimumRole: Role
) {
  const principal = c.get('principal') as Principal;
  if (principal.workspaceId && principal.workspaceId !== workspaceId) {
    return {
      error: error(
        c,
        403,
        'FORBIDDEN',
        'API key is scoped to another workspace'
      )
    };
  }

  const row = await c.env.DB.prepare(
    `SELECT m.role, m.id AS membership_id, w.id, w.slug, w.name, w.deleted_at,
       a.project_ids_json, COALESCE(a.version,0) AS access_version
     FROM memberships m
     JOIN workspaces w ON w.id = m.workspace_id
     LEFT JOIN member_project_access a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
     WHERE m.workspace_id = ? AND m.user_id = ?
     LIMIT 1`
  )
    .bind(workspaceId, principal.userId)
    .first<{
      role: Role;
      id: string;
      slug: string;
      name: string;
      deleted_at: string | null;
      membership_id: string;
      project_ids_json: string | null;
      access_version: number;
    }>();

  if (!row || row.deleted_at) {
    return { error: error(c, 404, 'NOT_FOUND', 'Workspace not found') };
  }

  const projectIds: string[] | null =
    row.project_ids_json === null ? null : JSON.parse(row.project_ids_json);
  // Restrictions also apply to stale/legacy elevated roles and all of this user's keys.
  if (
    ROLE_RANK[row.role] < ROLE_RANK[minimumRole] ||
    (projectIds !== null && ROLE_RANK[minimumRole] >= ROLE_RANK.ADMIN)
  ) {
    return {
      error: error(
        c,
        403,
        'FORBIDDEN',
        `Insufficient role. Required ${minimumRole}, got ${row.role}`
      )
    };
  }

  c.set('projectAccess', {
    workspaceId,
    membershipId: row.membership_id,
    version: row.access_version,
    projectIds,
    minimumRole
  });

  return {
    workspaceId: row.id,
    workspaceSlug: row.slug,
    workspaceName: row.name,
    role:
      projectIds !== null && ROLE_RANK[row.role] > ROLE_RANK.MEMBER
        ? ('MEMBER' as const)
        : row.role,
    projectIds,
    accessVersion: row.access_version
  };
}

// Recheck the same membership and policy revision in each mutation's SQL batch.
// Revocation, role downgrade or remove/rejoin between validation and commit fails closed.
export function membershipWriteGuard(c: Context<AppEnv>, workspaceId: string) {
  const access = c.get('projectAccess');
  if (!access || access.workspaceId !== workspaceId)
    throw new Error('Membership must be checked before mutation');
  return {
    sql: `EXISTS (SELECT 1 FROM memberships actor JOIN workspaces workspace ON workspace.id=actor.workspace_id
      LEFT JOIN member_project_access policy ON policy.workspace_id=actor.workspace_id AND policy.user_id=actor.user_id
      WHERE actor.id=? AND actor.workspace_id=? AND actor.user_id=?
      AND (CASE actor.role WHEN 'OWNER' THEN 40 WHEN 'ADMIN' THEN 30 WHEN 'MEMBER' THEN 20 ELSE 10 END)>=?
      AND workspace.deleted_at IS NULL AND COALESCE(policy.version,0)=?)`,
    params: [
      access.membershipId,
      workspaceId,
      c.get('principal').userId,
      ROLE_RANK[access.minimumRole],
      access.version
    ]
  };
}
