import { z } from 'zod';
import type { TaskStatus } from '../lib/types';
import { memberCanAccessProjectSql } from './project-access';

export const stages = [
  'BACKLOG',
  'READY',
  'ACTIVE',
  'BLOCKED',
  'REVIEW',
  'VERIFY',
  'DONE',
  'ARCHIVED'
] as const;
export type Stage = (typeof stages)[number];
const text = z.string().trim().max(2000);
const references = z.array(z.string().trim().min(1).max(2000)).max(20);
export const detailsSchema = z
  .object({
    area: text.default(''),
    repository: text.default(''),
    outcome: text.default(''),
    scope: text.default(''),
    base_ref: text.default(''),
    environment: text.default(''),
    next_action: text.default(''),
    contract_refs: references.default([]),
    acceptance_checks: references.default([]),
    setup_ready: z.boolean().default(false),
    integration_mode: z.enum(['live', 'fixture']).default('live'),
    exclusions: references.default([]),
    evidence: references.default([]),
    build_ref: text.default(''),
    source_complete: z.boolean().default(false),
    deployed: z.boolean().default(false),
    verification_passed: z.boolean().default(false),
    device_accepted: z.boolean().default(false)
  })
  .strict();
export const blockerSchema = z
  .object({
    owner_user_id: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
    next_action: z.string().trim().min(1).max(2000)
  })
  .strict();
export const deliveryUpdateSchema = z
  .object({
    version: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2000),
    stage: z.enum(stages).optional(),
    project_id: z.string().min(1).nullable().optional(),
    assignee_user_id: z.string().min(1).nullable().optional(),
    reviewer_user_id: z.string().min(1).nullable().optional(),
    details: detailsSchema.partial().optional(),
    blocker: blockerSchema.nullable().optional(),
    depends_on: z
      .array(z.string().min(1))
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate dependency')
      .optional()
  })
  .strict();
export type Card = {
  reviewer_user_id: string | null;
  details: z.infer<typeof detailsSchema>;
  blocker: z.infer<typeof blockerSchema> | null;
};
export type DeliveryTask = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  assignee_user_id: string | null;
  title: string;
  status: TaskStatus;
  priority: string;
  version: number;
  deleted_at: string | null;
  delivery_state: Stage | null;
  delivery_json: string | null;
  project_live: number;
};
export type Dependency = {
  project_id: string | null;
  task_id: string;
  id: string;
  title: string;
  status: TaskStatus;
  deleted_at: string | null;
  project_live: number;
};
export const legacyStatus: Record<Stage, TaskStatus> = {
  BACKLOG: 'TODO',
  READY: 'TODO',
  BLOCKED: 'TODO',
  ACTIVE: 'IN_PROGRESS',
  REVIEW: 'IN_PROGRESS',
  VERIFY: 'IN_PROGRESS',
  DONE: 'DONE',
  ARCHIVED: 'ARCHIVED'
};
export function stageOf(task: Pick<DeliveryTask, 'delivery_state' | 'status'>): Stage {
  return (
    task.delivery_state ??
    ({ TODO: 'BACKLOG', IN_PROGRESS: 'ACTIVE', DONE: 'DONE', ARCHIVED: 'ARCHIVED' } as const)[task.status]
  );
}
export function cardOf(task: DeliveryTask): Card {
  return task.delivery_json
    ? JSON.parse(task.delivery_json)
    : { reviewer_user_id: null, details: detailsSchema.parse({}), blocker: null };
}
export const transitions: Record<Stage, readonly Stage[]> = {
  BACKLOG: ['READY', 'BLOCKED', 'ARCHIVED'],
  READY: ['BACKLOG', 'ACTIVE', 'BLOCKED', 'ARCHIVED'],
  ACTIVE: ['BACKLOG', 'BLOCKED', 'REVIEW', 'ARCHIVED'],
  BLOCKED: ['BACKLOG', 'READY', 'ARCHIVED'],
  REVIEW: ['ACTIVE', 'BLOCKED', 'VERIFY', 'ARCHIVED'],
  VERIFY: ['ACTIVE', 'BLOCKED', 'DONE', 'ARCHIVED'],
  DONE: ['BACKLOG', 'ARCHIVED'],
  ARCHIVED: ['BACKLOG']
};
export const needsReady = (stage: Stage) => ['READY', 'ACTIVE', 'REVIEW', 'VERIFY', 'DONE'].includes(stage);
export function readinessIssues(
  task: DeliveryTask,
  card: Card,
  dependencies: Dependency[],
  members: Set<string>
) {
  const issues: string[] = [];
  if (!task.project_id || !task.project_live) issues.push('active_project_required');
  if (!task.assignee_user_id || !members.has(task.assignee_user_id)) issues.push('contributor_required');
  if (!card.reviewer_user_id || !members.has(card.reviewer_user_id)) issues.push('reviewer_required');
  for (const field of [
    'area',
    'repository',
    'outcome',
    'scope',
    'base_ref',
    'environment',
    'next_action'
  ] as const)
    if (!card.details[field]) issues.push(`${field}_required`);
  if (!card.details.contract_refs.length) issues.push('contract_refs_required');
  if (!card.details.acceptance_checks.length) issues.push('acceptance_checks_required');
  if (!card.details.setup_ready) issues.push('setup_not_ready');
  if (card.details.integration_mode === 'fixture' && !card.details.exclusions.length)
    issues.push('fixture_exclusions_required');
  if (dependencies.some((d) => d.status !== 'DONE' || d.deleted_at || !d.project_live))
    issues.push('unfinished_dependencies');
  return issues;
}
// Reused by new and legacy write paths. Existing duplicate active tasks are not
// silently changed by migration, but no new write may add another active slot.
export const activeTaskSql =
  "(COALESCE(delivery_state, '') = 'ACTIVE' OR (delivery_state IS NULL AND status = 'IN_PROGRESS'))";
export const freeActiveSlotSql = `NOT EXISTS (SELECT 1 FROM tasks WHERE workspace_id = ? AND assignee_user_id = ? AND id != ? AND deleted_at IS NULL AND ${activeTaskSql})`;
export const dependencyRowsSql = `SELECT d.task_id,t.id,t.title,t.status,t.deleted_at,t.project_id,
  CASE WHEN t.project_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL) THEN 1 ELSE 0 END AS project_live
  FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id AND t.workspace_id = d.workspace_id
  LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id`;
export async function readDeliveryTask(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT t.*, CASE WHEN p.id IS NOT NULL AND p.deleted_at IS NULL THEN 1 ELSE 0 END AS project_live
    FROM tasks t LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id WHERE t.id = ?`
    )
    .bind(id)
    .first<DeliveryTask>();
}
export async function contributors(db: D1Database, workspace: string, project?: string|null) {
  return new Set(
    (
      await db
        .prepare(`SELECT user_id FROM memberships m WHERE workspace_id = ? AND role != 'VIEWER' ${project===undefined?'':`AND ${memberCanAccessProjectSql('m','?')}`}`)
        .bind(workspace,...(project===undefined?[]:[project,project]))
        .all<{ user_id: string }>()
    ).results.map((m) => m.user_id)
  );
}
export function deliveryView(task: DeliveryTask, dependencies: Dependency[], members: Set<string>) {
  const card = cardOf(task);
  const stage = stageOf(task);
  const issues = readinessIssues(task, card, dependencies, members);
  return {
    id: task.id,
    workspace_id: task.workspace_id,
    project_id: task.project_id,
    assignee_user_id: task.assignee_user_id,
    title: task.title,
    priority: task.priority,
    status: task.status,
    version: task.version,
    stage,
    managed: task.delivery_state !== null,
    ...card,
    depends_on: dependencies.map((d) => ({
      id: d.id,
      title: d.title,
      satisfied: d.status === 'DONE' && !d.deleted_at && Boolean(d.project_live)
    })),
    readiness_issues: issues,
    can_start: stage === 'READY' && issues.length === 0,
    effective_stage:
      task.delivery_state && needsReady(stage) && stage !== 'DONE' && issues.length ? 'BLOCKED' : stage
  };
}
