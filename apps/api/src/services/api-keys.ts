import type { EnvBindings } from '../lib/types';
import { newId, randomHex } from '../lib/ids';

export function extractKeyPrefix(rawKey: string): string | null {
  const parts = rawKey.split('_');
  if (parts.length !== 4) {
    return null;
  }
  if (parts[0] !== 'tdls') {
    return null;
  }
  if (!['live', 'test'].includes(parts[1])) {
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

export async function hashApiKey(rawKey: string, pepper: string): Promise<string> {
  const payload = `${pepper}:${rawKey}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function issueApiKey(
  env: EnvBindings,
  options: {
    name: string;
    scopes: string[];
    expiresAt?: string | null;
  }
): Promise<{
  id: string;
  name: string;
  raw: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  expiresAt: string | null;
}> {
  if (!env.API_KEY_PEPPER) {
    throw new Error('API_KEY_PEPPER is required');
  }

  const mode = env.ENVIRONMENT === 'prod' ? 'live' : 'test';
  const tokenPrefix = randomHex(8);
  const tokenSecret = randomHex(24);
  const raw = `tdls_${mode}_${tokenPrefix}_${tokenSecret}`;

  return {
    id: newId('key_'),
    name: options.name,
    raw,
    keyPrefix: `tdls_${mode}_${tokenPrefix}`,
    keyHash: await hashApiKey(raw, env.API_KEY_PEPPER),
    scopes: options.scopes,
    expiresAt: options.expiresAt ?? null,
  };
}
