import type { Context, Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { error, ok, jsonBody, validationError } from '../lib/response';
import { newId } from '../lib/ids';
import { hasScope } from '../services/authz';
import { addDays, localDate, validWeekStart } from '../services/time-review';
import {
  dateInZone,
  eligibleProjects,
  portfolioUpdate,
  readPortfolio,
  weekDays
} from '../services/personal-portfolio';
import {
  activeTaskSql,
  deliveryView,
  dependencyRowsSql,
  type DeliveryTask,
  type Dependency
} from '../services/task-delivery';

async function access(c: Context<AppEnv>, write = false) {
  const principal = c.get('principal');
  if (principal.workspaceId || !hasScope(principal, write ? 'workspace:write' : 'workspace:read'))
    return error(
      c,
      403,
      'FORBIDDEN',
      'Use your own personal key with the required workspace scope'
    );
  if(await c.env.DB.prepare('SELECT 1 FROM member_project_access WHERE user_id=? AND project_ids_json IS NOT NULL LIMIT 1').bind(principal.userId).first())
    return error(c,403,'PROJECT_ACCESS_RESTRICTED','Use project task lists and delivery queues for project-restricted coordination');
}
export function registerPortfolioRoutes(app: Hono<AppEnv>) {
  app.get('/v1/me/portfolio', async (c) => {
    const denied = await access(c);
    if (denied) return denied;
    const query = c.req.queries();
    const week = localDate.safeParse(c.req.query('week_start_date'));
    if (
      !week.success ||
      !validWeekStart(week.data, 1) ||
      Object.keys(query).some((k) => k !== 'week_start_date' || query[k].length !== 1)
    )
      return error(
        c,
        400,
        'INVALID_WEEK',
        'Supply one Monday week_start_date for your personal overview'
      );
    const user = c.get('principal').userId;
    const { version, document } = await readPortfolio(c.env.DB, user);
    const projects = (
      await c.env.DB.prepare(
        `SELECT p.id,p.name,p.workspace_id,w.name AS workspace_name
      FROM projects p JOIN workspaces w ON w.id=p.workspace_id
      WHERE p.id IN (${eligibleProjects}) ORDER BY w.name,p.name,p.id LIMIT 1001`
      )
        .bind(user)
        .all<{ id: string; name: string; workspace_id: string; workspace_name: string }>()
    ).results;
    if (projects.length > 1000)
      return error(
        c,
        400,
        'PORTFOLIO_TOO_LARGE',
        'Too many accessible projects for the personal overview'
      );
    const selected = document.project_ids.filter((id) => projects.some((p) => p.id === id));
    const ids = JSON.stringify(selected);
    const rows = (
      await c.env.DB.prepare(
        `SELECT t.*,1 AS project_live FROM tasks t
      WHERE t.project_id IN (SELECT value FROM json_each(?)) AND t.project_id IN (${eligibleProjects})
      AND t.assignee_user_id=? AND t.deleted_at IS NULL AND t.status NOT IN ('DONE','ARCHIVED')
      ORDER BY t.priority,t.created_at,t.id LIMIT 501`
      )
        .bind(ids, user, user)
        .all<DeliveryTask>()
    ).results;
    if (rows.length > 500)
      return error(
        c,
        400,
        'PORTFOLIO_TOO_LARGE',
        'Select fewer projects before loading this overview'
      );
    const members = new Map<string, Set<string>>();
    const memberships = (
      await c.env.DB.prepare(
        "SELECT workspace_id,user_id FROM memberships WHERE role!='VIEWER' AND workspace_id IN (SELECT value FROM json_each(?))"
      )
        .bind(JSON.stringify([...new Set(rows.map((t) => t.workspace_id))]))
        .all<{ workspace_id: string; user_id: string }>()
    ).results;
    for (const member of memberships) {
      if (!members.has(member.workspace_id)) members.set(member.workspace_id, new Set());
      members.get(member.workspace_id)!.add(member.user_id);
    }
    const dependencies = (
      await c.env.DB.prepare(
        `${dependencyRowsSql} WHERE d.task_id IN (SELECT value FROM json_each(?))`
      )
        .bind(JSON.stringify(rows.map((t) => t.id)))
        .all<Dependency>()
    ).results;
    const cards = rows.map((t) =>
      deliveryView(
        t,
        dependencies.filter((d) => d.task_id === t.id),
        members.get(t.workspace_id) ?? new Set()
      )
    );
    const active = cards.filter((t) => t.stage === 'ACTIVE');
    const focus = active.find((t) => t.id === document.focus_task_id) ?? active[0] ?? null;
    const ready = cards.filter((t) => t.can_start);
    const history = (
      await c.env.DB.prepare(
        `SELECT h.id,h.task_id,t.title,t.project_id,h.created_at,h.metadata_json,h.to_value_json
      FROM task_history h JOIN tasks t ON t.id=h.task_id AND t.workspace_id=h.workspace_id
      WHERE t.project_id IN (SELECT value FROM json_each(?)) AND t.project_id IN (${eligibleProjects})
      AND t.assignee_user_id=? AND t.deleted_at IS NULL
      AND h.created_at>=? AND h.created_at<? ORDER BY h.created_at DESC,h.id DESC LIMIT 1001`
      )
        .bind(ids, user, user, addDays(week.data, -1), addDays(week.data, 8))
        .all<{
          id: string;
          task_id: string;
          title: string;
          project_id: string;
          created_at: string;
          metadata_json: string | null;
          to_value_json: string | null;
        }>()
    ).results;
    if (history.length > 1000)
      return error(
        c,
        400,
        'PORTFOLIO_TOO_LARGE',
        'Too many updates this week; select fewer projects'
      );
    const progress = history
      .flatMap((h) => {
        const date = dateInZone(h.created_at, document.timezone);
        if (date < week.data || date > addDays(week.data, 6)) return [];
        const metadata = JSON.parse(h.metadata_json ?? '{}');
        const to = JSON.parse(h.to_value_json ?? '{}');
        return [
          {
            id: h.id,
            task_id: h.task_id,
            title: h.title,
            project_id: h.project_id,
            date,
            at: h.created_at,
            reason: typeof metadata?.reason === 'string' ? metadata.reason : 'Task updated',
            stage: typeof to?.stage === 'string' ? to.stage : null,
            version: typeof to?.version === 'number' ? to.version : 0
          }
        ];
      })
      .sort(
        (a, b) =>
          b.date.localeCompare(a.date) ||
          b.at.localeCompare(a.at) ||
          a.task_id.localeCompare(b.task_id) ||
          b.version - a.version ||
          b.id.localeCompare(a.id)
      );
    const days = (
      await c.env.DB.prepare(
        'SELECT local_date,minutes FROM personal_availability WHERE user_id=? AND local_date BETWEEN ? AND ?'
      )
        .bind(user, week.data, addDays(week.data, 6))
        .all<{ local_date: string; minutes: number }>()
    ).results;
    return ok(c, {
      version,
      user_id: user,
      ...document,
      project_ids: selected,
      focus_task_id: focus?.id ?? null,
      projects,
      active_priority: focus,
      other_active: active.filter((t) => t.id !== focus?.id),
      active_conflict: active.length > 1,
      ready_alternatives: ready.slice(0, 2),
      ready_count: ready.length,
      blocked: cards.filter((t) => t.effective_stage === 'BLOCKED'),
      review: cards.filter((t) => t.stage === 'REVIEW'),
      verify: cards.filter((t) => t.stage === 'VERIFY'),
      week_start_date: week.data,
      progress,
      availability: weekDays(week.data).map((date) => ({
        date,
        minutes: days.find((d) => d.local_date === date)?.minutes ?? null
      })),
      availability_is_not_logged_time: true
    });
  });
  app.put('/v1/me/portfolio', async (c) => {
    const denied = await access(c, true);
    if (denied) return denied;
    const input = await jsonBody(c);
    if (!input.ok) return input.response;
    const parsed = portfolioUpdate.safeParse(input.data);
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const key = c.req.header('idempotency-key');
    if (!key || !/^[A-Za-z0-9_.:-]{8,120}$/.test(key))
      return error(c, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Use an 8-120 character Idempotency-Key');
    const user = c.get('principal').userId;
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parsed.data)))
      )
    )
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    async function replay() {
      const receipt = await c.env.DB.prepare(
        'SELECT request_hash,response_json FROM personal_portfolio_operations WHERE user_id=? AND idempotency_key=?'
      )
        .bind(user, key)
        .first<{ request_hash: string; response_json: string }>();
      return !receipt
        ? null
        : receipt.request_hash === hash
          ? ok(c, JSON.parse(receipt.response_json))
          : error(c, 409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to a different request');
    }
    const existing = await replay();
    if (existing) return existing;
    const current = await readPortfolio(c.env.DB, user);
    const { version, availability = [], ...patch } = parsed.data;
    if (version !== current.version)
      return error(c, 409, 'VERSION_CONFLICT', 'Reload the personal portfolio');
    const next = { ...current.document, ...patch };
    if (next.paused && !next.resume_note)
      return error(c, 400, 'RESUME_NOTE_REQUIRED', 'Leave a short note for when you resume');
    // Only explicitly selected references require revalidation. Unavailable old
    // references are hidden on reads and never prevent editing private capacity.
    const condition = [`COALESCE((SELECT version FROM personal_portfolios WHERE user_id=?),0)=?`];
    const params: unknown[] = [user, version];
    if (patch.project_ids) {
      condition.push(
        `NOT EXISTS (SELECT value FROM json_each(?) WHERE value NOT IN (${eligibleProjects}))`
      );
      params.push(JSON.stringify(patch.project_ids), user);
    }
    if (patch.focus_task_id) {
      condition.push(`EXISTS (SELECT 1 FROM tasks WHERE id=? AND assignee_user_id=? AND deleted_at IS NULL
        AND project_id IN (SELECT value FROM json_each(?)) AND project_id IN (${eligibleProjects}) AND ${activeTaskSql})`);
      params.push(patch.focus_task_id, user, JSON.stringify(next.project_ids), user);
    }
    const id = newId('pp_');
    const guard = 'EXISTS (SELECT 1 FROM personal_portfolio_operations WHERE id=?)';
    const result = { version: version + 1 };
    try {
      const [receipt] = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO personal_portfolio_operations(id,user_id,idempotency_key,request_hash,response_json)
          SELECT ?,?,?,?,? WHERE ${condition.join(' AND ')}`
        ).bind(id, user, key, hash, JSON.stringify(result), ...params),
        c.env.DB.prepare(
          `INSERT INTO personal_portfolios(user_id,version,document_json) SELECT ?,?,? WHERE ${guard}
          ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,document_json=excluded.document_json,updated_at=datetime('now')`
        ).bind(user, version + 1, JSON.stringify(next), id),
        ...availability.flatMap((day) => [
          c.env.DB.prepare(
            `DELETE FROM personal_availability WHERE user_id=? AND local_date=? AND ${guard}`
          ).bind(user, day.date, id),
          ...(day.minutes === null
            ? []
            : [
                c.env.DB.prepare(
                  `INSERT INTO personal_availability(user_id,local_date,minutes) SELECT ?,?,? WHERE ${guard}`
                ).bind(user, day.date, day.minutes, id)
              ])
        ]),
        c.env.DB.prepare(
          `INSERT INTO audit_logs(id,workspace_id,actor_user_id,action,entity_type,entity_id,metadata_json)
          SELECT ?,NULL,?,'UPDATE_PERSONAL_PORTFOLIO','personal_portfolio',?,? WHERE ${guard}`
        ).bind(
          newId('audit_'),
          user,
          user,
          JSON.stringify({ version: version + 1, paused: next.paused }),
          id
        )
      ]);
      if (receipt.meta.changes === 1) return ok(c, result);
    } catch (e) {
      const duplicate = await replay();
      if (duplicate) return duplicate;
      throw e;
    }
    return (
      (await replay()) ??
      error(
        c,
        409,
        'VERSION_CONFLICT',
        'Portfolio or project/task access changed; reload before retrying'
      )
    );
  });
}
