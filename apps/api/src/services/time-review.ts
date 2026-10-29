import { z } from 'zod';

export const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  }, 'Use a valid local calendar date');
export const evidence = z
  .string()
  .url()
  .max(2000)
  .refine((value) => ['https:', 'http:'].includes(new URL(value).protocol));
export const entrySchema = z
  .object({
    project_id: z.string().min(1),
    task_id: z.string().min(1),
    work_date: localDate,
    activity: z.enum(['development', 'qa', 'setup', 'research', 'rework', 'review']),
    minutes: z.number().int().min(1).max(1440),
    note: z.string().trim().min(1).max(1000),
    evidence_ref: evidence.nullable().optional()
  })
  .strict();
export type TimeEntry = z.infer<typeof entrySchema> & { id: string };
export type Terms = {
  id: string;
  effective_from: string;
  rate_minor_per_hour: number | null;
  currency: string | null;
  minor_unit_scale: number | null;
  weekly_cap_minutes: number | null;
};
export type ApprovalEntry = {
  entry_id: string;
  approved_minutes: number;
  submitted_minutes: number;
  terms: Terms | null;
  amount_minor: number | null;
};
export type Week = {
  id: string;
  workspace_id: string;
  user_id: string;
  week_start_date: string;
  timezone: string;
  week_start: number;
  version: number;
  revision: number;
  state: 'draft' | 'submitted' | 'approved' | 'changes_requested';
  entries: TimeEntry[];
  submission: {
    at: string;
    revision: number;
    confirmed_human_time: true;
    cap_minutes: number | null;
    over_cap: boolean;
  } | null;
  approval: {
    at: string;
    actor_user_id: string;
    entries: ApprovalEntry[];
    reason: string | null;
    cap_minutes: number | null;
    over_cap_decision: string | null;
  } | null;
  payment_status: 'manual_unrecorded';
};
export function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function validWeekStart(date: string, start: number) {
  return new Date(`${date}T12:00:00Z`).getUTCDay() === start;
}
export function termsOn(terms: Terms[], date: string) {
  return (
    terms
      .filter((t) => t.effective_from <= date)
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ?? null
  );
}
// Explicit rounding rule: nearest minor unit, halves up, separately per entry.
export function amountMinor(minutes: number, rate: number) {
  return Number((BigInt(minutes) * BigInt(rate) + 30n) / 60n);
}
export function report(weeks: Week[]) {
  const rows = weeks.flatMap((week) =>
    week.entries.map((entry) => {
      const approval = week.approval?.entries.find((a) => a.entry_id === entry.id);
      return {
        week_id: week.id,
        revision: week.revision,
        state: week.state,
        user_id: week.user_id,
        week_start_date: week.week_start_date,
        timezone: week.timezone,
        ...entry,
        submitted_minutes: week.submission ? entry.minutes : 0,
        approved_minutes: approval?.approved_minutes ?? 0,
        amount_minor: approval?.amount_minor ?? null,
        currency: approval?.terms?.currency ?? null,
        minor_unit_scale: approval?.terms?.minor_unit_scale ?? null,
        payment_status: week.payment_status
      };
    })
  );
  function totals(items: typeof rows) {
    const money: Record<string, { currency: string; minor_unit_scale: number; amount_minor: number }> = {};
    for (const row of items)
      if (row.currency && row.amount_minor !== null && row.minor_unit_scale !== null) {
        const key = `${row.currency}:${row.minor_unit_scale}`;
        money[key] ??= { currency: row.currency, minor_unit_scale: row.minor_unit_scale, amount_minor: 0 };
        money[key].amount_minor += row.amount_minor;
      }
    return {
      entered_minutes: items.reduce((n, r) => n + r.minutes, 0),
      submitted_minutes: items.reduce((n, r) => n + r.submitted_minutes, 0),
      approved_minutes: items.reduce((n, r) => n + r.approved_minutes, 0),
      unpriced_approved_minutes: items
        .filter((r) => r.amount_minor === null)
        .reduce((n, r) => n + r.approved_minutes, 0),
      amounts: Object.values(money)
    };
  }
  function group(field: 'project_id' | 'task_id' | 'week_id') {
    return [...new Set(rows.map((row) => row[field]))].map((id) => ({
      [field]: id,
      ...totals(rows.filter((row) => row[field] === id))
    }));
  }
  return {
    rows,
    combined: totals(rows),
    projects: group('project_id'),
    tasks: group('task_id'),
    weeks: group('week_id')
  };
}
export function csvReport(weeks: Week[]) {
  const rows = report(weeks).rows;
  const fields = [
    'week_id',
    'revision',
    'state',
    'user_id',
    'week_start_date',
    'timezone',
    'id',
    'project_id',
    'task_id',
    'work_date',
    'activity',
    'minutes',
    'submitted_minutes',
    'approved_minutes',
    'amount_minor',
    'currency',
    'minor_unit_scale',
    'payment_status',
    'note',
    'evidence_ref'
  ] as const;
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? '' : String(value);
    // Spreadsheet formula injection includes whitespace/control-prefixed formulas.
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return (
    [fields.join(','), ...rows.map((row) => fields.map((field) => cell(row[field])).join(','))].join('\r\n') +
    '\r\n'
  );
}
