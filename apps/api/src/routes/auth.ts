import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Scope } from '../lib/types';
import { defaultWorkspaceName, makeWorkspaceSlug, newId } from '../lib/ids';
import { error, jsonBody, ok, validationError } from '../lib/response';
import { issueApiKey } from '../services/api-keys';
import { writeAudit } from '../services/audit';
import { enforceRegisterRateLimit } from '../services/rate-limit';

const registerSchema = z.object({
  email: z.string().email(),
  display_name: z.string().min(1).max(80).optional(),
  workspace_name: z.string().min(1).max(100).optional(),
});

export function registerAuthRoutes(app: Hono<AppEnv>) {
  app.post('/v1/auth/register', async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) {
      return body.response;
    }
    const parsed = registerSchema.safeParse(body.data);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }

    const payload = parsed.data;
    const email = payload.email.trim().toLowerCase();
    const displayName = payload.display_name?.trim() || null;

    const rateLimit = await enforceRegisterRateLimit(c, email);
    if (rateLimit.limited) {
      c.header('retry-after', String(rateLimit.retryAfterSeconds));
      return error(c, 429, 'RATE_LIMITED', 'Too many registration attempts', {
        retry_after_seconds: rateLimit.retryAfterSeconds,
      });
    }

    const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? LIMIT 1')
      .bind(email)
      .first<{ id: string }>();

    if (existingUser) {
      return error(c, 409, 'EMAIL_EXISTS', 'Email is already registered');
    }

    const userId = newId('usr_');
    const workspaceId = newId('ws_');
    const membershipId = newId('mem_');
    const workspaceName = payload.workspace_name?.trim() || defaultWorkspaceName(email);
    const workspaceSlug = makeWorkspaceSlug(workspaceName);

    const defaultScopes: Scope[] = [
      'workspace:read',
      'workspace:write',
      'members:read',
      'members:write',
      'apikeys:write',
    ];

    const apiKey = await issueApiKey(c.env, {
      name: 'Default Owner Key',
      scopes: defaultScopes,
    });

    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)').bind(
        userId,
        email,
        displayName
      ),
      c.env.DB.prepare(
        'INSERT INTO workspaces (id, slug, name, created_by_user_id) VALUES (?, ?, ?, ?)'
      ).bind(workspaceId, workspaceSlug, workspaceName, userId),
      c.env.DB.prepare('INSERT INTO memberships (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)').bind(
        membershipId,
        workspaceId,
        userId,
        'OWNER'
      ),
      c.env.DB.prepare(
        `INSERT INTO api_keys
         (id, workspace_id, created_by_user_id, name, key_prefix, key_hash, scopes_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        apiKey.id,
        workspaceId,
        userId,
        apiKey.name,
        apiKey.keyPrefix,
        apiKey.keyHash,
        JSON.stringify(apiKey.scopes),
        null
      ),
    ]);

    await writeAudit(c.env.DB, {
      workspaceId,
      actorUserId: userId,
      action: 'REGISTER',
      entityType: 'workspace',
      entityId: workspaceId,
      metadata: { email },
    });

    return ok(
      c,
      {
        user: {
          id: userId,
          email,
          display_name: displayName,
        },
        workspace: {
          id: workspaceId,
          slug: workspaceSlug,
          name: workspaceName,
          role: 'OWNER',
        },
        api_key: apiKey.raw,
        api_key_prefix: apiKey.keyPrefix,
        api_key_scopes: apiKey.scopes,
      },
      201
    );
  });
}
