import type { Hono } from 'hono';
import { z } from 'zod';
import { VALID_SCOPES } from '../lib/constants';
import { error, jsonBody, ok, validationError } from '../lib/response';
import type { AppEnv, Scope } from '../lib/types';
import { issueApiKey } from '../services/api-keys';
import { writeAudit } from '../services/audit';
import { hasScope, requireMembership } from '../services/authz';

const createApiKeySchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.string()).min(1).max(20),
  expires_at: z.string().datetime().optional(),
});

export function registerApiKeyRoutes(app: Hono<AppEnv>) {
  app.post('/v1/workspaces/:workspaceId/api-keys', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'apikeys:write')) {
      return error(c, 403, 'FORBIDDEN', 'Missing apikeys:write scope');
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
    const parsed = createApiKeySchema.safeParse(body.data);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }

    const payload = parsed.data;
    const scopes = payload.scopes;
    const invalidScopes = scopes.filter((scope) => !VALID_SCOPES.includes(scope as Scope));
    if (invalidScopes.length > 0) {
      return error(c, 400, 'INVALID_SCOPES', 'One or more scopes are invalid', {
        invalid_scopes: invalidScopes,
        valid_scopes: VALID_SCOPES,
      });
    }

    const expiresAt = payload.expires_at ?? null;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      return error(c, 400, 'INVALID_EXPIRES_AT', 'expires_at must be in the future');
    }

    const key = await issueApiKey(c.env, {
      name: payload.name.trim(),
      scopes,
      expiresAt,
    });

    await c.env.DB.prepare(
      `INSERT INTO api_keys
        (id, workspace_id, created_by_user_id, name, key_prefix, key_hash, scopes_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        key.id,
        workspaceId,
        principal.userId,
        key.name,
        key.keyPrefix,
        key.keyHash,
        JSON.stringify(key.scopes),
        key.expiresAt
      )
      .run();

    await writeAudit(c.env.DB, {
      workspaceId,
      actorUserId: principal.userId,
      action: 'CREATE_API_KEY',
      entityType: 'api_key',
      entityId: key.id,
      metadata: { key_prefix: key.keyPrefix, scopes: key.scopes },
    });

    return ok(
      c,
      {
        id: key.id,
        name: key.name,
        key_prefix: key.keyPrefix,
        scopes: key.scopes,
        expires_at: key.expiresAt,
        api_key: key.raw,
      },
      201
    );
  });

  app.post('/v1/api-keys/:apiKeyId/revoke', async (c) => {
    const principal = c.get('principal');
    if (!hasScope(principal, 'apikeys:write')) {
      return error(c, 403, 'FORBIDDEN', 'Missing apikeys:write scope');
    }

    const apiKeyId = c.req.param('apiKeyId');
    const key = await c.env.DB.prepare(
      `SELECT id, workspace_id, created_by_user_id, revoked_at
       FROM api_keys
       WHERE id = ?
       LIMIT 1`
    )
      .bind(apiKeyId)
      .first<{
        id: string;
        workspace_id: string | null;
        created_by_user_id: string;
        revoked_at: string | null;
      }>();

    if (!key) {
      return error(c, 404, 'NOT_FOUND', 'API key not found');
    }

    if (key.revoked_at) {
      return ok(c, { id: apiKeyId, revoked: true, already_revoked: true });
    }

    if (key.workspace_id) {
      const membership = await requireMembership(c, key.workspace_id, 'ADMIN');
      if ('error' in membership) {
        return membership.error;
      }
    } else if (key.created_by_user_id !== principal.userId) {
      return error(c, 403, 'FORBIDDEN', 'Cannot revoke this API key');
    }

    await c.env.DB.prepare('UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(apiKeyId)
      .run();

    await writeAudit(c.env.DB, {
      workspaceId: key.workspace_id,
      actorUserId: principal.userId,
      action: 'REVOKE_API_KEY',
      entityType: 'api_key',
      entityId: apiKeyId,
      metadata: null,
    });

    return ok(c, { id: apiKeyId, revoked: true });
  });
}
