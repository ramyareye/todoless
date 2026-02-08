export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'ARCHIVED';
export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type ChangeReason =
  | 'manual'
  | 'deadline_shift'
  | 'dependency_blocked'
  | 'rebalancing'
  | 'system';

export type Scope =
  | 'workspace:read'
  | 'workspace:write'
  | 'members:read'
  | 'members:write'
  | 'apikeys:write'
  | '*';

export interface EnvBindings {
  DB: D1Database;
  ENVIRONMENT?: string;
  API_KEY_PEPPER?: string;
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
}

export type AppEnv = {
  Bindings: EnvBindings;
  Variables: Variables;
};
