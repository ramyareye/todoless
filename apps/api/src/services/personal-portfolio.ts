import { z } from 'zod';
import { localDate, addDays } from './time-review';
export const portfolioDefaults = {
  project_ids: [] as string[],
  focus_task_id: null as string | null,
  paused: false,
  resume_note: '',
  timezone: 'Europe/Amsterdam'
};
export type PortfolioDocument = typeof portfolioDefaults;
export const portfolioUpdate = z
  .object({
    version: z.number().int().min(0),
    project_ids: z
      .array(z.string().min(1).max(200))
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate project')
      .optional(),
    focus_task_id: z.string().min(1).max(200).nullable().optional(),
    paused: z.boolean().optional(),
    resume_note: z.string().trim().max(2000).optional(),
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
      }, 'Use an IANA time zone')
      .optional(),
    availability: z
      .array(
        z.object({ date: localDate, minutes: z.number().int().min(0).max(120).nullable() }).strict()
      )
      .max(31)
      .refine((days) => new Set(days.map((d) => d.date)).size === days.length, 'Duplicate date')
      .optional()
  })
  .strict();
export async function readPortfolio(db: D1Database, user: string) {
  const row = await db
    .prepare('SELECT version,document_json FROM personal_portfolios WHERE user_id=?')
    .bind(user)
    .first<{ version: number; document_json: string }>();
  return {
    version: row?.version ?? 0,
    document: row ? (JSON.parse(row.document_json) as PortfolioDocument) : { ...portfolioDefaults }
  };
}
export function dateInZone(utc: string, timezone: string) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(utc.endsWith('Z') ? utc : `${utc.replace(' ', 'T')}Z`));
  const field = (name: string) => parts.find((p) => p.type === name)!.value;
  return `${field('year')}-${field('month')}-${field('day')}`;
}
export const weekDays = (start: string) => Array.from({ length: 7 }, (_, i) => addDays(start, i));
// Reference existing projects, never move or copy them. This same predicate is
// checked inside the write batch so revocation cannot race a new selection.
export const eligibleProjects = `SELECT p.id FROM projects p
  JOIN workspaces w ON w.id=p.workspace_id JOIN memberships m ON m.workspace_id=w.id
  WHERE m.user_id=? AND m.role!='VIEWER' AND w.deleted_at IS NULL AND p.deleted_at IS NULL`;
