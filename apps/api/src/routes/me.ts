import type { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { ok } from '../lib/response';

export function registerMeRoutes(app: Hono<AppEnv>) {
  app.get('/v1/me', (c) => {
    const principal = c.get('principal');
    return ok(c, {
      user_id: principal.userId,
      email: principal.email,
      scopes: principal.scopes,
      api_key_id: principal.apiKeyId,
    });
  });
}
