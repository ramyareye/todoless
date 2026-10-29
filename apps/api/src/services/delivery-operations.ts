import type { Context } from 'hono';
import type { AppEnv } from '../lib/types';
import { newId } from '../lib/ids';
import { error, ok } from '../lib/response';
import { membershipWriteGuard } from './authz';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// Each write, its immutable snapshot/audit, and the retry result share a batch.
// A unique operation ID gates every effect after the optimistic insert.
export async function operation(c: Context<AppEnv>, workspaceId: string, body: unknown) {
  const key = c.req.header('idempotency-key');
  if (!key || !/^[A-Za-z0-9_.:-]{8,120}$/.test(key)) {
    return {
      response: error(
        c,
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Use an Idempotency-Key of 8-120 letters, digits, _, ., :, or -'
      )
    };
  }
  const bytes = new TextEncoder().encode(canonical([c.req.method, c.req.path, body]));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const actor = c.get('principal').userId;
  const policy = c.get('projectAccess');
  // Portfolio has its own transactional eligibility checks and no single workspace policy.
  const accessVersion = policy?.workspaceId === workspaceId ? policy.version : 0;
  async function replay() {
    const row = await c.env.DB.prepare(
      'SELECT request_hash, response_json, response_status, access_version FROM delivery_operations WHERE workspace_id = ? AND actor_user_id = ? AND idempotency_key = ?'
    )
      .bind(workspaceId, actor, key)
      .first<{ request_hash: string; response_json: string; response_status: number; access_version: number }>();
    if (!row) return null;
    if (row.access_version !== accessVersion) return error(c,409,'ACCESS_CHANGED','Access changed; read current state before making a new request');
    return row.request_hash === hash
      ? ok(c, JSON.parse(row.response_json), row.response_status as 200 | 201)
      : error(c, 409, 'IDEMPOTENCY_CONFLICT', 'This key was already used for a different request');
  }
  const existing = await replay();
  if (existing) return { response: existing };
  return {
    async commit(
      condition: string,
      params: unknown[],
      build: (id: string) => D1PreparedStatement[],
      data: unknown,
      status: 200 | 201 = 200
    ) {
      const id = newId('op_');
      const guard = policy?.workspaceId === workspaceId ? membershipWriteGuard(c, workspaceId) : { sql: '1', params: [] };
      try {
        const [inserted] = await c.env.DB.batch([
          c.env.DB.prepare(
            `INSERT INTO delivery_operations (id, workspace_id, actor_user_id, idempotency_key, request_hash, response_json, response_status, access_version) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (${condition}) AND (${guard.sql}) AND EXISTS (SELECT 1 FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = ? AND m.user_id = ? AND m.role != 'VIEWER' AND w.deleted_at IS NULL)`
          ).bind(
            id,
            workspaceId,
            actor,
            key,
            hash,
            JSON.stringify(data),
            status,
            accessVersion,
            ...params,
            ...guard.params,
            workspaceId,
            actor
          ),
          ...build(id)
        ]);
        if (inserted.meta.changes === 1) return ok(c, data, status);
      } catch (e) {
        const duplicate = await replay();
        if (duplicate) return duplicate;
        throw e;
      }
      return (
        (await replay()) ??
        error(c, 409, 'VERSION_CONFLICT', 'State changed; reload and retry with the current version')
      );
    }
  };
}

export const operationGuard = 'EXISTS (SELECT 1 FROM delivery_operations WHERE id = ?)';
