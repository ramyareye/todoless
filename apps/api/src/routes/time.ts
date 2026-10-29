import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../lib/types';
import { newId } from '../lib/ids';
import { decodeCursor, encodeCursor, parseLimit } from '../lib/pagination';
import { error, jsonBody, ok, validationError } from '../lib/response';
import { hasScope, requireMembership } from '../services/authz';
import { operation, operationGuard } from '../services/delivery-operations';
import {
  addDays,
  amountMinor,
  csvReport,
  entrySchema,
  localDate,
  report,
  termsOn,
  validWeekStart,
  type Terms,
  type Week
} from '../services/time-review';

const version = z.number().int().nonnegative();
const reason = z.string().trim().min(1).max(1000);
const settingsSchema = z
  .object({
    version,
    timezone: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
    week_start: z.number().int().min(0).max(6),
    confirmed: z.literal(true)
  })
  .strict();
const termsSchema = z
  .object({
    version,
    user_id: z.string().min(1),
    effective_from: localDate,
    rate_minor_per_hour: z.number().int().min(0).max(1_000_000_000).nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    minor_unit_scale: z.number().int().min(0).max(4).nullable(),
    weekly_cap_minutes: z.number().int().min(1).max(10080).nullable()
  })
  .strict()
  .refine(
    (t) =>
      t.rate_minor_per_hour === null
        ? t.currency === null && t.minor_unit_scale === null
        : t.currency !== null && t.minor_unit_scale !== null,
    'Rate, currency, and minor-unit scale must be set together'
  );
const commandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('save_entry'),
      version,
      entry_id: z.string().min(1).optional(),
      entry: entrySchema
    })
    .strict(),
  z.object({ action: z.literal('remove_entry'), version, entry_id: z.string().min(1), reason }).strict(),
  z.object({ action: z.literal('submit'), version, confirmed_human_time: z.literal(true) }).strict(),
  z
    .object({
      action: z.literal('approve'),
      version,
      entries: z
        .array(
          z.object({ entry_id: z.string(), approved_minutes: z.number().int().min(0).max(1440) }).strict()
        )
        .min(1)
        .max(200),
      reason: reason.optional(),
      over_cap_decision: z.literal('approve').optional()
    })
    .strict(),
  z.object({ action: z.literal('request_changes'), version, reason }).strict(),
  z.object({ action: z.literal('revise'), version, reason }).strict()
]);

type Settings = { timezone: string; week_start: number; version: number };
async function access(c: Context<AppEnv>) {
  c.header('cache-control', 'no-store');
  const principal = c.get('principal');
  if (
    principal.workspaceId ||
    !hasScope(principal, c.req.method === 'GET' ? 'workspace:read' : 'workspace:write')
  ) {
    return {
      error: error(
        c,
        403,
        'FORBIDDEN',
        'Time records require a personal key with the appropriate workspace scope'
      )
    };
  }
  const membership = await requireMembership(c, c.req.param('workspaceId')!, 'MEMBER');
  if ('error' in membership) return { error: membership.error! };
  if(membership.projectIds!==null)return {error:error(c,403,'PROJECT_ACCESS_RESTRICTED','Project-restricted coordination cannot read or change workspace time records')};
  const delegated = await c.env.DB.prepare(
    'SELECT 1 FROM time_approvers WHERE workspace_id = ? AND user_id = ?'
  )
    .bind(membership.workspaceId, principal.userId)
    .first();
  return {
    ...membership,
    userId: principal.userId,
    approver: membership.role === 'OWNER' || Boolean(delegated)
  };
}
async function config(c: Context<AppEnv>, ws: string) {
  return c.env.DB.prepare('SELECT timezone, week_start, version FROM time_settings WHERE workspace_id = ?')
    .bind(ws)
    .first<Settings>();
}
async function parse<T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T) {
  const body = await jsonBody(c);
  if (!body.ok) return { response: body.response };
  const parsed = schema.safeParse(body.data);
  return parsed.success
    ? { data: parsed.data as z.infer<T> }
    : { response: validationError(c, parsed.error.flatten()) };
}
function audit(
  c: Context<AppEnv>,
  ws: string,
  actor: string,
  action: string,
  id: string,
  data: unknown,
  op: string
) {
  return c.env.DB.prepare(
    `INSERT INTO audit_logs (id,workspace_id,actor_user_id,action,entity_type,entity_id,metadata_json) SELECT ?,?,?,?,?,?,? WHERE ${operationGuard}`
  ).bind(newId('audit_'), ws, actor, action, 'time_review', id, JSON.stringify(data), op);
}
async function termsFor(c: Context<AppEnv>, ws: string, user: string) {
  return (
    await c.env.DB.prepare(
      'SELECT id,effective_from,rate_minor_per_hour,currency,minor_unit_scale,weekly_cap_minutes FROM time_terms WHERE workspace_id = ? AND user_id = ? ORDER BY effective_from DESC'
    )
      .bind(ws, user)
      .all<Terms>()
  ).results;
}
// One query for the whole bounded week, reused inside the write transaction.
const invalidReferencesSql = `SELECT 1 FROM json_each(?) e
  LEFT JOIN tasks t ON t.id = json_extract(e.value, '$.task_id')
  LEFT JOIN projects p ON p.id = json_extract(e.value, '$.project_id')
  WHERE t.id IS NULL OR p.id IS NULL OR t.project_id IS NOT p.id
    OR t.workspace_id != ? OR p.workspace_id != ? OR t.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL`;
async function validReferences(c: Context<AppEnv>, week: Week) {
  const invalid = await c.env.DB.prepare(`${invalidReferencesSql} LIMIT 1`)
    .bind(JSON.stringify(week.entries), week.workspace_id, week.workspace_id)
    .first();
  return !invalid;
}

export function registerTimeRoutes(app: Hono<AppEnv>) {
  const root = '/v1/workspaces/:workspaceId/time';
  app.get(`${root}/settings`, async (c) => {
    const member = await access(c);
    if ('error' in member) return member.error;
    return ok(c, {
      settings: await config(c, member.workspaceId),
      access: { user_id: member.userId, can_approve: member.approver, can_configure: member.role === 'OWNER' }
    });
  });
  app.put(`${root}/settings`, async (c) => {
    const member = await access(c);
    if ('error' in member) return member.error;
    if (member.role !== 'OWNER')
      return error(c, 403, 'FORBIDDEN', 'Only the workspace owner configures weekly review');
    const input = await parse(c, settingsSchema);
    if ('response' in input) return input.response;
    const body = input.data;
    const op = await operation(c, member.workspaceId, body);
    if ('response' in op) return op.response;
    const data = { timezone: body.timezone, week_start: body.week_start, version: body.version + 1 };
    return op.commit(
      'COALESCE((SELECT version FROM time_settings WHERE workspace_id = ?), 0) = ?',
      [member.workspaceId, body.version],
      (id) => [
        c.env.DB.prepare(
          `INSERT INTO time_settings (workspace_id,timezone,week_start,version) SELECT ?,?,?,? WHERE ${operationGuard} ON CONFLICT(workspace_id) DO UPDATE SET timezone=excluded.timezone,week_start=excluded.week_start,version=excluded.version`
        ).bind(member.workspaceId, data.timezone, data.week_start, data.version, id),
        audit(c, member.workspaceId, member.userId, 'TIME_SETTINGS', member.workspaceId, data, id)
      ],
      data
    );
  });
  app.put(`${root}/approvers/:userId`, async (c) => {
    const member = await access(c);
    if ('error' in member) return member.error;
    if (member.role !== 'OWNER') return error(c, 403, 'FORBIDDEN', 'Only the owner delegates review access');
    const input = await parse(c, z.object({ version, enabled: z.boolean() }).strict());
    if ('response' in input) return input.response;
    const body = input.data;
    const userId = c.req.param('userId');
    if (
      !(await c.env.DB.prepare(
        "SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND role != 'VIEWER'"
      )
        .bind(member.workspaceId, userId)
        .first())
    )
      return error(c, 400, 'INVALID_MEMBER', 'Approver must be a current contributor');
    const op = await operation(c, member.workspaceId, body);
    if ('response' in op) return op.response;
    const data = { user_id: userId, enabled: body.enabled, settings_version: body.version + 1 };
    return op.commit(
      `EXISTS (SELECT 1 FROM time_settings WHERE workspace_id = ? AND version = ?)
       AND EXISTS (SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND role != 'VIEWER')`,
      [member.workspaceId, body.version, member.workspaceId, userId],
      (id) => [
        body.enabled
          ? c.env.DB.prepare(
              `INSERT OR IGNORE INTO time_approvers (workspace_id,user_id) SELECT ?,? WHERE ${operationGuard}`
            ).bind(member.workspaceId, userId, id)
          : c.env.DB.prepare(
              `DELETE FROM time_approvers WHERE workspace_id = ? AND user_id = ? AND ${operationGuard}`
            ).bind(member.workspaceId, userId, id),
        c.env.DB.prepare(
          `UPDATE time_settings SET version = version + 1 WHERE workspace_id = ? AND ${operationGuard}`
        ).bind(member.workspaceId, id),
        audit(c, member.workspaceId, member.userId, 'TIME_APPROVER', userId, data, id)
      ],
      data
    );
  });
  app.get(`${root}/terms`, async (c) => {
    const member = await access(c);
    if ('error' in member) return member.error;
    const userId = c.req.query('user_id') ?? member.userId;
    if (userId !== member.userId && !member.approver)
      return error(c, 403, 'FORBIDDEN', "Only an approver may read another person's terms");
    return ok(c, { user_id: userId, terms: await termsFor(c, member.workspaceId, userId) });
  });
  app.post(`${root}/terms`, async (c) => {
    const member = await access(c);
    if ('error' in member) return member.error;
    if (member.role !== 'OWNER') return error(c, 403, 'FORBIDDEN', 'Only the owner records agreed terms');
    const input = await parse(c, termsSchema);
    if ('response' in input) return input.response;
    const body = input.data;
    const op = await operation(c, member.workspaceId, body);
    if ('response' in op) return op.response;
    if (
      !(await c.env.DB.prepare(
        "SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND role != 'VIEWER'"
      )
        .bind(member.workspaceId, body.user_id)
        .first())
    )
      return error(c, 400, 'INVALID_MEMBER', 'Terms require a contributor in this workspace');
    if (
      await c.env.DB.prepare(
        'SELECT 1 FROM time_terms WHERE workspace_id = ? AND user_id = ? AND effective_from = ?'
      )
        .bind(member.workspaceId, body.user_id, body.effective_from)
        .first()
    )
      return error(c, 409, 'TERMS_EXIST', 'Terms are immutable; use a new effective date');
    if (
      body.currency &&
      (await c.env.DB.prepare(
        'SELECT 1 FROM time_terms WHERE workspace_id = ? AND currency = ? AND minor_unit_scale != ?'
      )
        .bind(member.workspaceId, body.currency, body.minor_unit_scale)
        .first())
    )
      return error(c, 400, 'CURRENCY_SCALE_MISMATCH', 'Use a consistent minor-unit scale for this currency');
    const data = { ...body, id: newId('term_'), settings_version: body.version + 1 };
    return op.commit(
      `EXISTS (SELECT 1 FROM time_settings WHERE workspace_id = ? AND version = ?)
       AND EXISTS (SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND role != 'VIEWER')`,
      [member.workspaceId, body.version, member.workspaceId, body.user_id],
      (id) => [
        c.env.DB.prepare(
          `INSERT INTO time_terms (id,workspace_id,user_id,effective_from,rate_minor_per_hour,currency,minor_unit_scale,weekly_cap_minutes,created_by) SELECT ?,?,?,?,?,?,?,?,? WHERE ${operationGuard}`
        ).bind(
          data.id,
          member.workspaceId,
          body.user_id,
          body.effective_from,
          body.rate_minor_per_hour,
          body.currency,
          body.minor_unit_scale,
          body.weekly_cap_minutes,
          member.userId,
          id
        ),
        c.env.DB.prepare(
          `UPDATE time_settings SET version = version + 1 WHERE workspace_id = ? AND ${operationGuard}`
        ).bind(member.workspaceId, id),
        audit(c, member.workspaceId, member.userId, 'TIME_TERMS', data.id, data, id)
      ],
      data,
      201
    );
  });
  app.post(`${root}/weeks`, async (c) => {
    const member = await access(c);
    if ('error' in member) return member.error;
    const input = await parse(c, z.object({ week_start_date: localDate }).strict());
    if ('response' in input) return input.response;
    const op = await operation(c, member.workspaceId, input.data);
    if ('response' in op) return op.response;
    const settings = await config(c, member.workspaceId);
    if (!settings)
      return error(
        c,
        409,
        'WEEK_CONFIG_REQUIRED',
        'Owner must explicitly confirm timezone and week start first'
      );
    const date = input.data.week_start_date;
    if (!validWeekStart(date, settings.week_start))
      return error(c, 400, 'INVALID_WEEK', 'Date must match the configured first day of the week');
    const week: Week = {
      id: newId('week_'),
      workspace_id: member.workspaceId,
      user_id: member.userId,
      week_start_date: date,
      timezone: settings.timezone,
      week_start: settings.week_start,
      version: 1,
      revision: 1,
      state: 'draft',
      entries: [],
      submission: null,
      approval: null,
      payment_status: 'manual_unrecorded'
    };
    return op.commit(
      `EXISTS (SELECT 1 FROM time_settings WHERE workspace_id = ? AND version = ?) AND NOT EXISTS (SELECT 1 FROM time_weeks WHERE workspace_id = ? AND user_id = ? AND week_start_date <= ? AND date(week_start_date, '+6 days') >= ?)`,
      [member.workspaceId, settings.version, member.workspaceId, member.userId, addDays(date, 6), date],
      (id) => [
        c.env.DB.prepare(
          `INSERT INTO time_weeks (id,workspace_id,user_id,week_start_date,timezone,week_start,version,state,document_json) SELECT ?,?,?,?,?,?,?,?,? WHERE ${operationGuard}`
        ).bind(
          week.id,
          week.workspace_id,
          week.user_id,
          date,
          week.timezone,
          week.week_start,
          1,
          week.state,
          JSON.stringify(week),
          id
        ),
        ...weekEvents(c, week, member.userId, 'create', null, id)
      ],
      week,
      201
    );
  });
  app.get(`${root}/weeks/:weekId`, async (c) => {
    const member = await access(c);
    if ('error' in member) return member.error;
    const week = await readWeek(c, member.workspaceId, c.req.param('weekId'));
    if (!week || (week.user_id !== member.userId && !member.approver))
      return error(c, 404, 'NOT_FOUND', 'Week not found');
    return ok(c, week);
  });
  app.get(`${root}/weeks/:weekId/history`, async (c) => {
    const member = await access(c);
    if ('error' in member) return member.error;
    const week = await readWeek(c, member.workspaceId, c.req.param('weekId'));
    if (!week || (week.user_id !== member.userId && !member.approver))
      return error(c, 404, 'NOT_FOUND', 'Week not found');
    const cursor = decodeCursor(c.req.query('cursor'));
    const after = Number(cursor?.ts ?? 0);
    if (
      (c.req.query('cursor') && (!cursor || cursor.id !== week.id)) ||
      !Number.isSafeInteger(after) ||
      after < 0
    )
      return error(c, 400, 'INVALID_CURSOR', 'Use this week history response cursor');
    const events = (
      await c.env.DB.prepare(
        'SELECT id,actor_user_id,action,reason,version,document_json,created_at FROM time_events WHERE week_id = ? AND version > ? ORDER BY version LIMIT 101'
      )
        .bind(week.id, after)
        .all()
    ).results;
    return ok(c, {
      events: events
        .slice(0, 100)
        .map((e) => ({ ...e, document: JSON.parse(e.document_json as string), document_json: undefined })),
      pagination: {
        limit: 100,
        has_more: events.length > 100,
        next_cursor:
          events.length > 100 ? encodeCursor({ ts: String(events[99].version), id: week.id }) : null
      }
    });
  });
  for (const kind of ['weeks', 'report', 'export.csv'])
    app.get(`${root}/${kind}`, async (c) => {
      const member = await access(c);
      if ('error' in member) return member.error;
      const userId = c.req.query('user_id') ?? member.userId;
      if (userId !== member.userId && !member.approver)
        return error(c, 403, 'FORBIDDEN', 'Only an approver may view team time records');
      const from = localDate.safeParse(c.req.query('from'));
      const to = localDate.safeParse(c.req.query('to'));
      if (!from.success || !to.success || to.data < from.data || to.data > addDays(from.data, 370))
        return error(c, 400, 'INVALID_RANGE', 'Supply from/to week-start dates spanning at most 370 days');
      const cursor = decodeCursor(c.req.query('cursor'));
      if (c.req.query('cursor') && (kind !== 'weeks' || !cursor || !localDate.safeParse(cursor.ts).success))
        return error(c, 400, 'INVALID_CURSOR', 'Use the week list response cursor');
      const limit = kind === 'weeks' ? parseLimit(c.req.query('limit'), 50) : 500;
      const rows = (
        await c.env.DB.prepare(
          `SELECT document_json FROM time_weeks WHERE workspace_id = ? AND week_start_date BETWEEN ? AND ? ${userId === 'all' ? '' : 'AND user_id = ?'} ${cursor ? 'AND (week_start_date > ? OR (week_start_date = ? AND id > ?))' : ''} ORDER BY week_start_date,id LIMIT ?`
        )
          .bind(
            member.workspaceId,
            from.data,
            to.data,
            ...(userId === 'all' ? [] : [userId]),
            ...(cursor ? [cursor.ts, cursor.ts, cursor.id] : []),
            limit + 1
          )
          .all<{ document_json: string }>()
      ).results;
      if (kind === 'weeks') {
        const weeks = rows.slice(0, limit).map((r) => JSON.parse(r.document_json) as Week);
        const last = weeks.at(-1);
        return ok(c, {
          weeks,
          pagination: {
            limit,
            has_more: rows.length > limit,
            next_cursor:
              rows.length > limit && last ? encodeCursor({ ts: last.week_start_date, id: last.id }) : null
          }
        });
      }
      if (rows.length > 500)
        return error(c, 400, 'REPORT_TOO_LARGE', 'Narrow the date range or select one contributor');
      const weeks = rows.map((r) => JSON.parse(r.document_json) as Week);
      if (kind === 'export.csv') {
        c.header('content-type', 'text/csv; charset=utf-8');
        c.header('content-disposition', 'attachment; filename="todoless-time.csv"');
        return c.body(csvReport(weeks));
      }
      return ok(c, report(weeks));
    });
  app.post(`${root}/weeks/:weekId/actions`, async (c) => {
    const member = await access(c);
    if ('error' in member) return member.error;
    const current = await readWeek(c, member.workspaceId, c.req.param('weekId'));
    if (!current || (current.user_id !== member.userId && !member.approver))
      return error(c, 404, 'NOT_FOUND', 'Week not found');
    const input = await parse(c, commandSchema);
    if ('response' in input) return input.response;
    const body = input.data;
    const reviewing = body.action === 'approve' || body.action === 'request_changes';
    if (reviewing ? !member.approver || current.user_id === member.userId : current.user_id !== member.userId)
      return error(
        c,
        403,
        'FORBIDDEN',
        reviewing
          ? 'An authorized person other than the contributor must review'
          : 'Only the contributor may change their entries'
      );
    const op = await operation(c, member.workspaceId, body);
    if ('response' in op) return op.response;
    if (body.version !== current.version) return error(c, 409, 'VERSION_CONFLICT', 'Reload the current week');
    const settings = await config(c, member.workspaceId);
    if (!settings) return error(c, 409, 'WEEK_CONFIG_REQUIRED', 'Week settings are required');
    const week: Week = structuredClone(current);
    week.version++;
    if (body.action === 'save_entry' || body.action === 'remove_entry') {
      if (week.state !== 'draft')
        return error(c, 409, 'WEEK_FROZEN', 'Create a revision before editing a submitted or reviewed week');
      if (body.action === 'save_entry') {
        if (
          body.entry.work_date < week.week_start_date ||
          body.entry.work_date > addDays(week.week_start_date, 6)
        )
          return error(
            c,
            400,
            'DATE_OUTSIDE_WEEK',
            "Work date must fall in this week's snapshotted local calendar"
          );
        if (body.entry_id && !week.entries.some((e) => e.id === body.entry_id))
          return error(c, 404, 'NOT_FOUND', 'Entry not found');
        const entry = { ...body.entry, id: body.entry_id ?? newId('time_') };
        week.entries = [...week.entries.filter((e) => e.id !== entry.id), entry];
        if (week.entries.length > 200)
          return error(c, 400, 'ENTRY_LIMIT', 'A week supports at most 200 manual entries');
        for (const date of new Set(week.entries.map((e) => e.work_date)))
          if (week.entries.filter((e) => e.work_date === date).reduce((n, e) => n + e.minutes, 0) > 1440)
            return error(c, 400, 'DAILY_LIMIT', 'Daily recorded work cannot exceed 1440 minutes');
      } else {
        if (!week.entries.some((e) => e.id === body.entry_id))
          return error(c, 404, 'NOT_FOUND', 'Entry not found');
        week.entries = week.entries.filter((e) => e.id !== body.entry_id);
      }
    } else if (body.action === 'revise') {
      if (!['approved', 'changes_requested'].includes(week.state))
        return error(c, 409, 'INVALID_STATE', 'Only approved or returned weeks may be revised');
      week.revision++;
      week.state = 'draft';
      week.approval = null;
      week.submission = null;
    } else if (body.action === 'submit') {
      if (week.state !== 'draft' || week.entries.length === 0)
        return error(c, 409, 'INVALID_STATE', 'Submit a nonempty draft');
      const terms = await termsFor(c, member.workspaceId, week.user_id);
      const cap = termsOn(terms, week.week_start_date)?.weekly_cap_minutes ?? null;
      week.state = 'submitted';
      week.submission = {
        at: new Date().toISOString(),
        revision: week.revision,
        confirmed_human_time: true,
        cap_minutes: cap,
        over_cap: cap !== null && week.entries.reduce((n, e) => n + e.minutes, 0) > cap
      };
    } else if (body.action === 'request_changes') {
      if (week.state !== 'submitted')
        return error(c, 409, 'INVALID_STATE', 'Only submitted weeks can be returned');
      week.state = 'changes_requested';
    } else {
      if (week.state !== 'submitted')
        return error(c, 409, 'INVALID_STATE', 'Only submitted weeks can be approved');
      const selected = new Map(body.entries.map((e) => [e.entry_id, e.approved_minutes]));
      if (
        selected.size !== week.entries.length ||
        selected.size !== body.entries.length ||
        week.entries.some((e) => !selected.has(e.id) || selected.get(e.id)! > e.minutes)
      )
        return error(
          c,
          400,
          'INVALID_APPROVAL',
          'Supply each entry exactly once, with approved minutes between zero and submitted minutes'
        );
      if (week.entries.some((e) => selected.get(e.id)! < e.minutes) && !body.reason)
        return error(c, 400, 'REASON_REQUIRED', 'Reduced minutes require a visible reason');
      const terms = await termsFor(c, member.workspaceId, week.user_id);
      const cap = termsOn(terms, week.week_start_date)?.weekly_cap_minutes ?? null;
      if (cap !== null && week.entries.reduce((n, e) => n + e.minutes, 0) > cap && !body.over_cap_decision)
        return error(
          c,
          409,
          'OVER_CAP_DECISION_REQUIRED',
          'Keep the logged hours and explicitly approve the over-cap submission or return it with a reason'
        );
      week.approval = {
        at: new Date().toISOString(),
        actor_user_id: member.userId,
        reason: body.reason ?? null,
        cap_minutes: cap,
        over_cap_decision: body.over_cap_decision ?? null,
        entries: week.entries.map((e) => {
          const termsAtDate = termsOn(terms, e.work_date);
          const minutes = selected.get(e.id)!;
          return {
            entry_id: e.id,
            submitted_minutes: e.minutes,
            approved_minutes: minutes,
            terms: termsAtDate,
            amount_minor:
              termsAtDate?.rate_minor_per_hour === null || !termsAtDate
                ? null
                : amountMinor(minutes, termsAtDate.rate_minor_per_hour)
          };
        })
      };
      week.state = 'approved';
    }
    if ((body.action === 'save_entry' || body.action === 'submit') && !(await validReferences(c, week)))
      return error(
        c,
        400,
        'INVALID_TIME_REFERENCE',
        'Each entry needs an active task in its project and workspace'
      );
    const checkReferences = body.action === 'save_entry' || body.action === 'submit';
    const referencesSql = checkReferences ? ` AND NOT EXISTS (${invalidReferencesSql})` : '';
    return op.commit(
      `EXISTS (SELECT 1 FROM time_weeks WHERE id = ? AND version = ?) AND EXISTS (SELECT 1 FROM time_settings WHERE workspace_id = ? AND version = ?)
      AND EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = ? AND m.user_id = ? AND m.role != 'VIEWER'
        ${reviewing ? "AND (m.role = 'OWNER' OR EXISTS (SELECT 1 FROM time_approvers a WHERE a.workspace_id = m.workspace_id AND a.user_id = m.user_id))" : ''})${referencesSql}`,
      [
        week.id,
        body.version,
        member.workspaceId,
        settings.version,
        member.workspaceId,
        member.userId,
        ...(checkReferences ? [JSON.stringify(week.entries), member.workspaceId, member.workspaceId] : [])
      ],
      (id) => [
        c.env.DB.prepare(
          `UPDATE time_weeks SET version = ?,state = ?,document_json = ? WHERE id = ? AND ${operationGuard}`
        ).bind(week.version, week.state, JSON.stringify(week), week.id, id),
        ...weekEvents(
          c,
          week,
          member.userId,
          body.action,
          'reason' in body ? (body.reason ?? null) : null,
          id
        )
      ],
      week
    );
  });
}
async function readWeek(c: Context<AppEnv>, workspace: string, id: string) {
  const row = await c.env.DB.prepare('SELECT document_json FROM time_weeks WHERE workspace_id = ? AND id = ?')
    .bind(workspace, id)
    .first<{ document_json: string }>();
  return row ? (JSON.parse(row.document_json) as Week) : null;
}
function weekEvents(
  c: Context<AppEnv>,
  week: Week,
  actor: string,
  action: string,
  reason: string | null,
  op: string
) {
  return [
    c.env.DB.prepare(
      `INSERT INTO time_events (id,week_id,actor_user_id,action,reason,version,document_json) SELECT ?,?,?,?,?,?,? WHERE ${operationGuard}`
    ).bind(newId('te_'), week.id, actor, action, reason, week.version, JSON.stringify(week), op),
    audit(
      c,
      week.workspace_id,
      actor,
      `TIME_${action.toUpperCase()}`,
      week.id,
      { version: week.version, revision: week.revision, reason },
      op
    )
  ];
}
