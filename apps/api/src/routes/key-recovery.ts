import type { Hono, Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../lib/types';
import { credentialPageNonce } from '../lib/credential-page';
import { keyRecoveryPage } from '../lib/key-recovery-page';
import { error, jsonBody, ok, validationError } from '../lib/response';
import { isEmailDeliveryConfigured, sendKeyRecoveryEmail, sendKeyRecoveryNotice } from '../services/email';
import { issueRecoveryToken, recoverPersonalKey, recoveryOrigin, recoveryProof, recoveryRateLimit, recoveryScopes, storeRecoveryRequest } from '../services/key-recovery';

const requestSchema = z.object({ email: z.string().trim().email().max(254) }).strict();
const proofSchema = z.object({ recovery_token: z.string().trim().min(1).max(200) }).strict();
const completeSchema = proofSchema.extend({ key_id: z.string().min(1).max(100), revoke_old_key: z.boolean() }).strict();
const invalid = (c: Context<AppEnv>) => error(c, 401, 'INVALID_RECOVERY_TOKEN', 'This link is invalid, expired or already used. Request a new recovery email.');
async function rate(c: Context<AppEnv>, email?: string) {
  if (!c.env.API_KEY_PEPPER) return error(c, 500, 'SERVER_MISCONFIGURED', 'Recovery is not configured');
  const seconds = await recoveryRateLimit(c.env, c.req.header('cf-connecting-ip')?.trim() || 'unknown', email);
  if (!seconds) return null;
  c.header('retry-after', String(seconds));
  return error(c, 429, 'RATE_LIMITED', 'Too many recovery attempts. Try again later.');
}
export function registerKeyRecoveryRoutes(app: Hono<AppEnv>) {
  app.get('/recover-key', c => c.html(keyRecoveryPage(credentialPageNonce(c))));
  const root = '/v1/auth/key-recovery';
  app.use(`${root}/*`, async (c, next) => {
    c.header('cache-control', 'no-store'); c.header('referrer-policy', 'no-referrer');
    c.header('x-content-type-options', 'nosniff'); await next();
  });
  app.post(`${root}/request`, async c => {
    const input = await jsonBody(c); if (!input.ok) return input.response;
    const parsed = requestSchema.safeParse(input.data); if (!parsed.success) return validationError(c, parsed.error.flatten());
    const email = parsed.data.email.toLowerCase();
    const limited = await rate(c, email); if (limited) return limited;
    const origin = recoveryOrigin(c.env);
    if (!origin || !isEmailDeliveryConfigured(c.env)) return error(c, 500, 'SERVER_MISCONFIGURED', 'Recovery email delivery is not configured');
    // Same foreground work/response for unknown and verified accounts. Neither
    // tokens nor account existence are returned, including in development.
    const token = await issueRecoveryToken(c.env);
    c.executionCtx.waitUntil((async () => {
      if (await storeRecoveryRequest(c.env, email, token)) {
        const url = new URL('/recover-key', origin); url.hash = `token=${token.raw}`;
        await sendKeyRecoveryEmail(c, { email, recoveryUrl: url.toString(), expiresAt: token.expiresAt });
      }
    })().catch(() => { console.error('Key recovery request could not be completed'); }));
    return ok(c, { message: 'If a verified account exists for this email, a recovery link will be sent. Check your inbox and spam folder.' });
  });
  app.post(`${root}/inspect`, async c => {
    const input = await jsonBody(c); if (!input.ok) return input.response;
    const parsed = proofSchema.safeParse(input.data); if (!parsed.success) return validationError(c, parsed.error.flatten());
    const limited = await rate(c); if (limited) return limited;
    const proof = await recoveryProof(c.env, parsed.data.recovery_token); if (!proof) return invalid(c);
    const keys = (await c.env.DB.prepare(
      `SELECT id,name,key_prefix,scopes_json,expires_at FROM api_keys WHERE created_by_user_id=? AND workspace_id IS NULL
       AND revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at)>julianday('now')) ORDER BY created_at DESC,id DESC LIMIT 50`
    ).bind(proof.user_id).all<{ id: string; name: string; key_prefix: string; scopes_json: string; expires_at: string | null }>()).results;
    return ok(c, { email: proof.recipient_email, expires_at: proof.expires_at,
      keys: keys.flatMap(({ scopes_json, ...key }) => {
        const scopes = recoveryScopes(scopes_json); return scopes ? [{ ...key, scopes }] : [];
      }) });
  });
  app.post(`${root}/complete`, async c => {
    const input = await jsonBody(c); if (!input.ok) return input.response;
    const parsed = completeSchema.safeParse(input.data); if (!parsed.success) return validationError(c, parsed.error.flatten());
    const limited = await rate(c); if (limited) return limited;
    const body = parsed.data;
    const proof = await recoveryProof(c.env, body.recovery_token); if (!proof) return invalid(c);
    try {
      const key = await recoverPersonalKey(c.env, proof, body.key_id, body.revoke_old_key);
      if (!key) return error(c, 409, 'RECOVERY_CONFLICT', 'The key or link changed. Request a new recovery email and check the current keys.');
      c.executionCtx.waitUntil(sendKeyRecoveryNotice(c, { email: proof.recipient_email, revokedOldKey: body.revoke_old_key })
        .catch(() => { console.error('Key recovery notification could not be delivered'); }));
      return ok(c, { api_key: key.raw, api_key_id: key.id, api_key_prefix: key.keyPrefix,
        scopes: key.scopes, expires_at: key.expiresAt, replaced_key_id: body.key_id, revoked_old_key: body.revoke_old_key }, 201);
    } catch {
      // No provider payload, token, key or raw SQL is logged/returned here.
      return error(c, 500, 'RECOVERY_FAILED', 'Recovery could not be confirmed. Request a fresh email before trying again.');
    }
  });
}
