import type { Role, Scope } from './types';

export const VALID_SCOPES: Scope[] = [
  'workspace:read',
  'workspace:write',
  'members:read',
  'members:write',
  'apikeys:write',
  '*',
];

export const ROLE_RANK: Record<Role, number> = {
  VIEWER: 10,
  MEMBER: 20,
  ADMIN: 30,
  OWNER: 40,
};
