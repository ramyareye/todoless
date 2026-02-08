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

export async function requireMembership(c: Context<AppEnv>, workspaceId: string, minimumRole: Role) {
  const principal = c.get('principal') as Principal;
  if (principal.workspaceId && principal.workspaceId !== workspaceId) {
    return { error: error(c, 403, 'FORBIDDEN', 'API key is scoped to another workspace') };
  }

  const row = await c.env.DB.prepare(
    `SELECT m.role, w.id, w.slug, w.name, w.deleted_at
     FROM memberships m
     JOIN workspaces w ON w.id = m.workspace_id
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
    }>();

  if (!row || row.deleted_at) {
    return { error: error(c, 404, 'NOT_FOUND', 'Workspace not found') };
  }

  if (ROLE_RANK[row.role] < ROLE_RANK[minimumRole]) {
    return {
      error: error(
        c,
        403,
        'FORBIDDEN',
        `Insufficient role. Required ${minimumRole}, got ${row.role}`
      ),
    };
  }

  return {
    workspaceId: row.id,
    workspaceSlug: row.slug,
    workspaceName: row.name,
    role: row.role,
  };
}
