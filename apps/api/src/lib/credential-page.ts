import type { Context } from 'hono';
import type { AppEnv } from './types';
import { randomHex } from './ids';

export function credentialPageNonce(c: Context<AppEnv>): string {
  const nonce = randomHex(16);
  c.header('cache-control', 'no-store');
  c.header('referrer-policy', 'no-referrer');
  c.header('x-content-type-options', 'nosniff');
  c.header(
    'content-security-policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
  );
  return nonce;
}
