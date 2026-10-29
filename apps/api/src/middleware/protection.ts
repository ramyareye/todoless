import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/types';
import { error } from '../lib/response';
import { boundedBody } from '../lib/bounded-body';

export const API_BODY_LIMIT = 128 * 1024;

export function protectionLog(c: Context<AppEnv>, event: string) {
  // Values are generated/classified internally. No raw URL, query, headers,
  // IP, token, SQL, body, exception message or private task content is logged.
  // Keep server failures; sample noisy rejection/telemetry events without a
  // stateful counter or database write. Platform metrics still count all calls.
  if (event !== 'unhandled_error' && Math.random() >= 0.01) return;
  const record = JSON.stringify({ event, service: 'todoless-api', request_id: c.get('requestId') });
  if (event === 'unhandled_error') console.error(record);
  else console.warn(record);
}

export const requestProtection = createMiddleware<AppEnv>(async (c, next) => {
  if (c.env?.ABUSE_PROTECTION === 'on' && c.req.method !== 'OPTIONS' && c.req.path !== '/v1/health') {
    const ip = c.req.header('cf-connecting-ip') || 'unidentified';
    const auth = c.req.path.startsWith('/v1/auth/');
    const leaf = c.req.path.split('/')[3];
    const family = !auth ? 'api' : leaf === 'key-recovery' ? 'recovery'
      : ['register', 'verify-email', 'claim-invite'].includes(leaf) ? leaf : 'auth-other';
    try {
      if (!c.env.REQUEST_RATE_LIMITER || (auth && !c.env.AUTH_RATE_LIMITER)) throw new Error('missing limiter');
      const allowed = await c.env.REQUEST_RATE_LIMITER.limit({ key: `ip:${ip}` });
      const authAllowed = allowed.success && (!auth || (await c.env.AUTH_RATE_LIMITER!.limit({ key: `${family}:${ip}` })).success);
      if (!authAllowed) {
        c.header('retry-after', '60'); c.header('cache-control', 'no-store');
        protectionLog(c, 'request_rate_limited');
        return error(c, 429, 'RATE_LIMITED', 'Too many requests. Retry later.');
      }
    } catch {
      c.header('retry-after', '60'); c.header('cache-control', 'no-store');
      protectionLog(c, 'request_protection_unavailable');
      return error(c, 503, 'PROTECTION_UNAVAILABLE', 'Request protection is temporarily unavailable');
    }
  }
  const bounded = await boundedBody(c.req.raw, API_BODY_LIMIT);
  if (typeof bounded === 'number') {
    c.header('cache-control', 'no-store'); protectionLog(c, bounded === 413 ? 'request_body_too_large' : 'request_body_unreadable');
    return error(c, bounded, bounded === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_BODY',
      bounded === 413 ? 'Request body exceeds 128 KiB' : 'Request body could not be read');
  }
  c.req.raw = bounded;
  await next();
});
