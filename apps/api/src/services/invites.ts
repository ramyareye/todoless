import type { EnvBindings } from '../lib/types';
import { newId, randomHex } from '../lib/ids';
import { hashApiKey } from './api-keys';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function extractInvitePrefix(rawToken: string): string | null {
  const parts = rawToken.split('_');
  if (parts.length !== 4) {
    return null;
  }
  if (parts[0] !== 'tdls') {
    return null;
  }
  if (parts[1] !== 'invite') {
    return null;
  }
  if (!/^[a-f0-9]{16}$/.test(parts[2])) {
    return null;
  }
  if (!/^[a-f0-9]{48}$/.test(parts[3])) {
    return null;
  }
  return `${parts[0]}_${parts[1]}_${parts[2]}`;
}

export async function issueInviteToken(
  env: EnvBindings,
  options?: { expiresAt?: string | null }
): Promise<{
  id: string;
  raw: string;
  tokenPrefix: string;
  tokenHash: string;
  expiresAt: string;
}> {
  if (!env.API_KEY_PEPPER) {
    throw new Error('API_KEY_PEPPER is required');
  }

  const tokenPrefix = randomHex(8);
  const tokenSecret = randomHex(24);
  const raw = `tdls_invite_${tokenPrefix}_${tokenSecret}`;

  return {
    id: newId('inv_'),
    raw,
    tokenPrefix: `tdls_invite_${tokenPrefix}`,
    tokenHash: await hashApiKey(raw, env.API_KEY_PEPPER),
    expiresAt: options?.expiresAt ?? new Date(Date.now() + INVITE_TTL_MS).toISOString(),
  };
}
