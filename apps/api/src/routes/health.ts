import type { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { ok } from '../lib/response';

export function registerHealthRoutes(app: Hono<AppEnv>) {
  app.get('/v1/health', (c) => {
    return ok(c, {
      status: 'healthy',
      service: 'todoless-api',
      environment: c.env.ENVIRONMENT ?? 'dev',
      timestamp: new Date().toISOString(),
    });
  });
}
