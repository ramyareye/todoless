import type { Context } from 'hono';
import type { AppEnv } from '../lib/types';

const REGISTER_WINDOW_SECONDS = 60 * 60;
const REGISTER_MAX_ATTEMPTS_PER_IP = 20;
const REGISTER_MAX_ATTEMPTS_PER_EMAIL = 5;

interface BucketResult {
  limited: boolean;
  retryAfterSeconds: number;
}

function currentWindowStart(nowSec: number): number {
  return nowSec - (nowSec % REGISTER_WINDOW_SECONDS);
}

function getClientIp(c: Context<AppEnv>): string {
  const direct = c.req.header('cf-connecting-ip');
  if (direct && direct.trim()) {
    return direct.trim();
  }

  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }

  return 'unknown';
}

async function consumeBucket(
  db: D1Database,
  bucketKey: string,
  nowSec: number,
  maxAttempts: number
): Promise<BucketResult> {
  const windowStart = currentWindowStart(nowSec);
  const retryAfter = Math.max(1, REGISTER_WINDOW_SECONDS - (nowSec - windowStart));

  const row = await db
    .prepare(
      `SELECT bucket_key, window_started_at, attempt_count
       FROM register_rate_limits
       WHERE bucket_key = ?
       LIMIT 1`
    )
    .bind(bucketKey)
    .first<{
      bucket_key: string;
      window_started_at: number;
      attempt_count: number;
    }>();

  if (!row) {
    await db
      .prepare(
        `INSERT INTO register_rate_limits (bucket_key, window_started_at, attempt_count, updated_at)
         VALUES (?, ?, 1, CURRENT_TIMESTAMP)`
      )
      .bind(bucketKey, windowStart)
      .run();

    return { limited: false, retryAfterSeconds: retryAfter };
  }

  if (row.window_started_at !== windowStart) {
    await db
      .prepare(
        `UPDATE register_rate_limits
         SET window_started_at = ?, attempt_count = 1, updated_at = CURRENT_TIMESTAMP
         WHERE bucket_key = ?`
      )
      .bind(windowStart, bucketKey)
      .run();

    return { limited: false, retryAfterSeconds: retryAfter };
  }

  if (row.attempt_count >= maxAttempts) {
    return { limited: true, retryAfterSeconds: retryAfter };
  }

  await db
    .prepare(
      `UPDATE register_rate_limits
       SET attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE bucket_key = ?`
    )
    .bind(bucketKey)
    .run();

  return { limited: false, retryAfterSeconds: retryAfter };
}

export async function enforceRegisterRateLimit(
  c: Context<AppEnv>,
  normalizedEmail: string
): Promise<{ limited: boolean; retryAfterSeconds: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const ipBucket = `register:ip:${getClientIp(c)}`;
  const emailBucket = `register:email:${normalizedEmail}`;

  const [ipResult, emailResult] = await Promise.all([
    consumeBucket(c.env.DB, ipBucket, nowSec, REGISTER_MAX_ATTEMPTS_PER_IP),
    consumeBucket(c.env.DB, emailBucket, nowSec, REGISTER_MAX_ATTEMPTS_PER_EMAIL),
  ]);

  if (ipResult.limited || emailResult.limited) {
    return {
      limited: true,
      retryAfterSeconds: Math.max(ipResult.retryAfterSeconds, emailResult.retryAfterSeconds),
    };
  }

  return { limited: false, retryAfterSeconds: 0 };
}
