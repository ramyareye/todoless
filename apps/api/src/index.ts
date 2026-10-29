import { Hono } from 'hono';
import { authMiddleware } from './middleware/auth';
import { requestIdMiddleware } from './middleware/request-id';
import { requestProtection, protectionLog } from './middleware/protection';
import { error } from './lib/response';
import type { AppEnv } from './lib/types';
import { registerApiKeyRoutes } from './routes/api-keys';
import { registerAuthRoutes } from './routes/auth';
import { registerKeyRecoveryRoutes } from './routes/key-recovery';
import { registerHealthRoutes } from './routes/health';
import { registerHomeRoutes } from './routes/home';
import { registerMeRoutes } from './routes/me';
import { registerMemberRoutes } from './routes/members';
import { registerProjectRoutes } from './routes/projects';
import { registerProjectAccessRoutes } from './routes/project-access';
import { registerTimeRoutes } from './routes/time';
import { registerDeliveryRoutes } from './routes/delivery';
import { registerPortfolioRoutes } from './routes/portfolio';
import { registerTaskRoutes } from './routes/tasks';
import { registerWorkspaceRoutes } from './routes/workspaces';

const app = new Hono<AppEnv>();

app.use('*', requestIdMiddleware);
app.use('*', requestProtection);

registerHomeRoutes(app);
registerHealthRoutes(app);
registerAuthRoutes(app);
registerKeyRecoveryRoutes(app);

app.use('/v1/me', authMiddleware);
app.use('/v1/me/*', authMiddleware);
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
registerProjectAccessRoutes(app);
registerTaskRoutes(app);
registerTimeRoutes(app);
registerDeliveryRoutes(app);
registerPortfolioRoutes(app);

app.onError((_err, c) => {
  protectionLog(c, 'unhandled_error');
  return error(c, 500, 'INTERNAL_ERROR', 'Unexpected server error');
});

app.notFound((c) => error(c, 404, 'NOT_FOUND', 'Route not found'));

export default app;
