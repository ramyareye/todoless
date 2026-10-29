import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../lib/types';
import { error } from '../lib/response';
import { extractKeyPrefix, hashApiKey } from '../services/api-keys';
import { protectionLog } from './protection';

const KEY_USAGE_INTERVAL_MS = 5 * 60 * 1000;
function staleUsage(value: string | null) {
  if (!value) return true;
  const parsed = Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return !Number.isFinite(parsed) || parsed <= Date.now() - KEY_USAGE_INTERVAL_MS;
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  // Hono's root and wildcard registrations can both match one request. Reuse
  // only this request's already-verified principal, not a cross-request cache.
  if (c.get('principal')) { await next(); return; }
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
      ak.last_used_at,
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
      last_used_at: string | null;
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

  // Per-person protection also covers clients rotating several personal keys.
  // Revoke remains available without consuming this narrower user quota.
  const revokingKey = c.req.method === 'POST' && /^\/v1\/api-keys\/[^/]+\/revoke\/?$/.test(c.req.path);
  if (c.env.ABUSE_PROTECTION === 'on' && !revokingKey) {
    try {
      if (!c.env.USER_RATE_LIMITER) throw new Error('missing limiter');
      if (!(await c.env.USER_RATE_LIMITER.limit({ key: `user:${keyRecord.user_id}` })).success) {
        c.header('retry-after', '60'); c.header('cache-control', 'no-store');
        protectionLog(c, 'user_rate_limited');
        return error(c, 429, 'RATE_LIMITED', 'Too many requests for this account. Retry later.');
      }
    } catch {
      c.header('retry-after', '60'); c.header('cache-control', 'no-store');
      protectionLog(c, 'user_protection_unavailable');
      return error(c, 503, 'PROTECTION_UNAVAILABLE', 'Request protection is temporarily unavailable');
    }
  }

  // Usage is telemetry only, never a cache of expiry, revocation or membership.
  // The SQL guard prevents a write storm when concurrent requests read stale data.
  if (staleUsage(keyRecord.last_used_at)) c.executionCtx.waitUntil(
    c.env.DB.prepare(`UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL
      AND (last_used_at IS NULL OR julianday(last_used_at) IS NULL OR julianday(last_used_at) <= julianday('now', '-5 minutes'))`)
      .bind(keyRecord.id).run().then(() => undefined)
      .catch(() => { protectionLog(c, 'key_usage_write_failed'); })
  );

  await next();
});
