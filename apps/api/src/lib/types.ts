export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'ARCHIVED';
export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type ChangeReason =
  'manual' | 'deadline_shift' | 'dependency_blocked' | 'rebalancing' | 'system';

export type Scope =
  | 'workspace:read'
  | 'workspace:write'
  | 'members:read'
  | 'members:write'
  | 'apikeys:write'
  | '*';

export interface EnvBindings extends Partial<Pick<ApiWorkerBindings,
  'ABUSE_PROTECTION' | 'REQUEST_RATE_LIMITER' | 'AUTH_RATE_LIMITER' | 'USER_RATE_LIMITER'>> {
  DB: D1Database;
  ENVIRONMENT?: string;
  API_KEY_PEPPER?: string;
  APP_BASE_URL?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  RESEND_REPLY_TO_EMAIL?: string;
}

export interface Principal {
  apiKeyId: string;
  userId: string;
  email: string;
  scopes: string[];
  workspaceId: string | null;
}

export interface Variables {
  requestId: string;
  principal: Principal;
  projectAccess: {
    workspaceId: string;
    membershipId: string;
    version: number;
    projectIds: string[] | null;
    minimumRole: Role;
  };
}

export type AppEnv = {
  Bindings: EnvBindings;
  Variables: Variables;
};
