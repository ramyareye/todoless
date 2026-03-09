import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../lib/types';
import { error } from '../lib/response';
import { extractKeyPrefix, hashApiKey } from '../services/api-keys';

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return error(c, 401, 'UNAUTHORIZED', 'Missing Bearer token');
  }

  const pepper = c.env.API_KEY_PEPPER;
  if (!pepper) {
    return error(c, 500, 'SERVER_MISCONFIGURED', 'API_KEY_PEPPER is required');
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const keyPrefix = extractKeyPrefix(token);
  if (!keyPrefix) {
    return error(c, 401, 'UNAUTHORIZED', 'Invalid API key format');
  }

  const keyRecord = await c.env.DB.prepare(
    `SELECT
      ak.id,
      ak.workspace_id,
      ak.key_hash,
      ak.scopes_json,
      ak.revoked_at,
      ak.expires_at,
      u.id AS user_id,
      u.email,
      u.email_verified_at
    FROM api_keys ak
    JOIN users u ON u.id = ak.created_by_user_id
    WHERE ak.key_prefix = ?
    LIMIT 1`
  )
    .bind(keyPrefix)
    .first<{
      id: string;
      workspace_id: string | null;
      key_hash: string;
      scopes_json: string;
      revoked_at: string | null;
      expires_at: string | null;
      user_id: string;
      email: string;
      email_verified_at: string | null;
    }>();

  if (!keyRecord || keyRecord.revoked_at) {
    return error(c, 401, 'UNAUTHORIZED', 'Invalid API key');
  }

  if (keyRecord.expires_at && Date.parse(keyRecord.expires_at) <= Date.now()) {
    return error(c, 401, 'UNAUTHORIZED', 'API key is expired');
  }

  const incomingHash = await hashApiKey(token, pepper);
  if (incomingHash !== keyRecord.key_hash) {
    return error(c, 401, 'UNAUTHORIZED', 'Invalid API key');
  }

  if (!keyRecord.email_verified_at) {
    return error(c, 403, 'EMAIL_NOT_VERIFIED', 'Verify your email before using this API key');
  }

  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(keyRecord.scopes_json);
    if (Array.isArray(parsed)) {
      scopes = parsed.filter((s) => typeof s === 'string');
    }
  } catch {
    return error(c, 500, 'SERVER_ERROR', 'Invalid scopes configuration');
  }

  c.set('principal', {
    apiKeyId: keyRecord.id,
    userId: keyRecord.user_id,
    email: keyRecord.email,
    scopes,
    workspaceId: keyRecord.workspace_id,
  });

  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(keyRecord.id)
      .run()
      .then(() => undefined)
  );

  await next();
});
