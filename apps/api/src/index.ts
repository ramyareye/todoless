import { Hono } from 'hono';
import { authMiddleware } from './middleware/auth';
import { requestIdMiddleware } from './middleware/request-id';
import { error } from './lib/response';
import type { AppEnv } from './lib/types';
import { registerApiKeyRoutes } from './routes/api-keys';
import { registerAuthRoutes } from './routes/auth';
import { registerHealthRoutes } from './routes/health';
import { registerMeRoutes } from './routes/me';
import { registerMemberRoutes } from './routes/members';
import { registerProjectRoutes } from './routes/projects';
import { registerTaskRoutes } from './routes/tasks';
import { registerWorkspaceRoutes } from './routes/workspaces';

const app = new Hono<AppEnv>();

app.use('*', requestIdMiddleware);

registerHealthRoutes(app);
registerAuthRoutes(app);

app.use('/v1/me', authMiddleware);
app.use('/v1/workspaces', authMiddleware);
app.use('/v1/workspaces/*', authMiddleware);
app.use('/v1/api-keys/*', authMiddleware);
app.use('/v1/projects/*', authMiddleware);
app.use('/v1/tasks/*', authMiddleware);

registerMeRoutes(app);
registerWorkspaceRoutes(app);
registerMemberRoutes(app);
registerApiKeyRoutes(app);
registerProjectRoutes(app);
registerTaskRoutes(app);

app.onError((err, c) => {
  console.error('Unhandled error', err);
  return error(c, 500, 'INTERNAL_ERROR', 'Unexpected server error');
});

app.notFound((c) => error(c, 404, 'NOT_FOUND', 'Route not found'));

export default app;
