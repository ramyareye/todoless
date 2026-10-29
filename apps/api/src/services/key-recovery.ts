import type { EnvBindings } from '../lib/types';
import { newId, randomHex } from '../lib/ids';
import { VALID_SCOPES } from '../lib/constants';
import { issueApiKey } from './api-keys';

const encode = (v: string) => new TextEncoder().encode(v);
const hex = (v: ArrayBuffer) => Array.from(new Uint8Array(v), b => b.toString(16).padStart(2, '0')).join('');
async function signingKey(env: EnvBindings) {
  if (!env.API_KEY_PEPPER) throw new Error('Recovery signing configuration missing');
  return crypto.subtle.importKey('raw', encode(env.API_KEY_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export function recoveryOrigin(env: EnvBindings): string | null {
  try {
    const url = new URL(env.APP_BASE_URL ?? '');
    const local = env.ENVIRONMENT === 'dev' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}
export async function issueRecoveryToken(env: EnvBindings) {
  const prefix = `tdls_recover_${randomHex(8)}`;
  const raw = `${prefix}_${randomHex(24)}`;
  return { id: newId('krt_'), raw, prefix,
    hash: hex(await crypto.subtle.sign('HMAC', await signingKey(env), encode(raw))),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() };
}
export async function recoveryRateLimit(env: EnvBindings, ip: string, email?: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000), window = now - now % 3600;
  const buckets: [string, number][] = email === undefined
    ? [[`check:ip:${ip}`, 60]] : [[`request:ip:${ip}`, 20], [`request:email:${email}`, 5]];
  for (const [value, maximum] of buckets) {
    const bucket = hex(await crypto.subtle.sign('HMAC', await signingKey(env), encode(`key-recovery:${value}`)));
    const accepted = await env.DB.prepare(
      `INSERT INTO key_recovery_rate_limits(bucket_hash,window_started_at,attempt_count) VALUES(?,?,1)
       ON CONFLICT(bucket_hash) DO UPDATE SET window_started_at=excluded.window_started_at,
         attempt_count=CASE WHEN window_started_at=excluded.window_started_at THEN attempt_count+1 ELSE 1 END,
         updated_at=CURRENT_TIMESTAMP
       WHERE window_started_at!=excluded.window_started_at OR attempt_count<? RETURNING attempt_count`
    ).bind(bucket, window, maximum).first();
    if (!accepted) return 3600 - (now - window);
  }
  return 0;
}
export async function storeRecoveryRequest(env: EnvBindings, email: string, token: Awaited<ReturnType<typeof issueRecoveryToken>>) {
  const user = await env.DB.prepare('SELECT id FROM users WHERE email=? AND email_verified_at IS NOT NULL').bind(email).first<{ id: string }>();
  if (!user) return false;
  const [, inserted] = await env.DB.batch([
    env.DB.prepare(`UPDATE api_key_recovery_tokens SET consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND consumed_at IS NULL
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND email=? AND email_verified_at IS NOT NULL)`).bind(user.id, user.id, email),
    env.DB.prepare(`INSERT INTO api_key_recovery_tokens(id,user_id,recipient_email,token_prefix,token_hash,expires_at)
      SELECT ?,id,email,?,?,? FROM users WHERE id=? AND email=? AND email_verified_at IS NOT NULL`)
      .bind(token.id, token.prefix, token.hash, token.expiresAt, user.id, email),
    env.DB.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,metadata_json)
      SELECT ?,NULL,'REQUEST_KEY_RECOVERY','user',?,? WHERE EXISTS(SELECT 1 FROM api_key_recovery_tokens WHERE id=?)`)
      .bind(newId('audit_'), user.id, JSON.stringify({ recovery_request_id: token.id, source: 'email_request' }), token.id)
  ]);
  return inserted.meta.changes === 1;
}
export interface RecoveryProof {
  id: string; user_id: string; recipient_email: string; token_hash: string; expires_at: string;
}
export async function recoveryProof(env: EnvBindings, raw: string): Promise<RecoveryProof | null> {
  if (!/^tdls_recover_[a-f0-9]{16}_[a-f0-9]{48}$/.test(raw)) return null;
  const prefix = raw.split('_').slice(0, 3).join('_');
  const row = await env.DB.prepare(
    `SELECT r.id,r.user_id,r.recipient_email,r.token_hash,r.expires_at FROM api_key_recovery_tokens r
     JOIN users u ON u.id=r.user_id AND u.email=r.recipient_email AND u.email_verified_at IS NOT NULL
     WHERE r.token_prefix=? AND r.consumed_at IS NULL AND julianday(r.expires_at)>julianday('now')`
  ).bind(prefix).first<RecoveryProof>();
  if (!row || !/^[a-f0-9]{64}$/.test(row.token_hash)) return null;
  const bytes = new Uint8Array(row.token_hash.match(/../g)!.map(v => parseInt(v, 16)));
  return await crypto.subtle.verify('HMAC', await signingKey(env), bytes, encode(raw)) ? row : null;
}
export function recoveryScopes(value: string): string[] | null {
  try {
    const scopes: unknown = JSON.parse(value);
    return Array.isArray(scopes) && scopes.length > 0 && scopes.every(s => VALID_SCOPES.includes(s)) ? scopes : null;
  } catch { return null; }
}
export async function recoverPersonalKey(env: EnvBindings, proof: RecoveryProof, keyId: string, revoke: boolean) {
  const old = await env.DB.prepare(
    `SELECT name,scopes_json,expires_at,key_prefix FROM api_keys WHERE id=? AND created_by_user_id=?
     AND workspace_id IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))`
  ).bind(keyId, proof.user_id).first<{ name: string; scopes_json: string; expires_at: string | null; key_prefix: string }>();
  if (!old) return null;
  const scopes = recoveryScopes(old.scopes_json);
  if (!scopes) return null;
  const key = await issueApiKey(env, { name: `Recovered: ${old.name}`.slice(0, 80), scopes, expiresAt: old.expires_at });
  const guard = 'EXISTS(SELECT 1 FROM api_keys WHERE id=?)';
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO api_keys(id,workspace_id,created_by_user_id,name,key_prefix,key_hash,scopes_json,expires_at)
       SELECT ?,NULL,r.user_id,?,?,?,k.scopes_json,k.expires_at FROM api_key_recovery_tokens r
       JOIN users u ON u.id=r.user_id AND u.email=r.recipient_email AND u.email_verified_at IS NOT NULL
       JOIN api_keys k ON k.id=? AND k.created_by_user_id=r.user_id AND k.workspace_id IS NULL
       WHERE r.id=? AND r.token_hash=? AND r.recipient_email=? AND r.consumed_at IS NULL
         AND julianday(r.expires_at)>julianday('now') AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR julianday(k.expires_at)>julianday('now'))
         AND k.scopes_json=? AND k.expires_at IS ?`
    ).bind(key.id, key.name, key.keyPrefix, key.keyHash, keyId, proof.id, proof.token_hash, proof.recipient_email, old.scopes_json, old.expires_at),
    env.DB.prepare(`UPDATE api_key_recovery_tokens SET consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND consumed_at IS NULL AND ${guard}`)
      .bind(proof.user_id, key.id),
    env.DB.prepare(`UPDATE api_keys SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND created_by_user_id=? AND ?=1 AND ${guard}`)
      .bind(keyId, proof.user_id, revoke ? 1 : 0, key.id),
    env.DB.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,metadata_json)
      SELECT ?,?,'RECOVER_API_KEY','api_key',?,? WHERE ${guard}`)
      .bind(newId('audit_'), proof.user_id, key.id, JSON.stringify({ replaces_key_id: keyId, old_key_prefix: old.key_prefix,
        key_prefix: key.keyPrefix, revoked_old_key: revoke, recovery_request_id: proof.id }), key.id),
    env.DB.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,metadata_json)
      SELECT ?,?,'REVOKE_API_KEY','api_key',?,? WHERE ?=1 AND ${guard}`)
      .bind(newId('audit_'), proof.user_id, keyId, JSON.stringify({ source: 'key_recovery', replacement_key_id: key.id }), revoke ? 1 : 0, key.id)
  ]);
  return inserted.meta.changes === 1 ? key : null;
}
