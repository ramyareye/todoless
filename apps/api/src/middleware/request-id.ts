import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../lib/types';

export const requestIdMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const requestId = `req_${crypto.randomUUID()}`;
  c.set('requestId', requestId);
  await next();
  c.header('x-request-id', requestId);
});
