import type { ChangeReason, TaskPriority, TaskStatus } from '../lib/types';
import { newId } from '../lib/ids';

export async function writeAudit(
  db: D1Database,
  args: {
    workspaceId: string | null;
    actorUserId: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    metadata: unknown;
  }
) {
  await db.prepare(
    `INSERT INTO audit_logs
      (id, workspace_id, actor_user_id, action, entity_type, entity_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('audit_'),
      args.workspaceId,
      args.actorUserId,
      args.action,
      args.entityType,
      args.entityId,
      args.metadata ? JSON.stringify(args.metadata) : null
    )
    .run();
}

export function classifyTaskChangeType(
  prev: { status: TaskStatus; priority: TaskPriority; due_at: string | null; assignee_user_id: string | null },
  next: {
    status: TaskStatus;
    priority: TaskPriority;
    due_at: string | null;
    assignee_user_id: string | null;
  }
):
  | 'UPDATED'
  | 'STATUS_CHANGED'
  | 'PRIORITY_CHANGED'
  | 'DUE_DATE_CHANGED'
  | 'ASSIGNEE_CHANGED' {
  if (prev.status !== next.status) {
    return 'STATUS_CHANGED';
  }
  if (prev.priority !== next.priority) {
    return 'PRIORITY_CHANGED';
  }
  if (prev.due_at !== next.due_at) {
    return 'DUE_DATE_CHANGED';
  }
  if (prev.assignee_user_id !== next.assignee_user_id) {
    return 'ASSIGNEE_CHANGED';
  }
  return 'UPDATED';
}

export async function writeTaskHistory(
  db: D1Database,
  args: {
    workspaceId: string;
    taskId: string;
    actorUserId: string | null;
    changeType:
      | 'CREATED'
      | 'UPDATED'
      | 'STATUS_CHANGED'
      | 'PRIORITY_CHANGED'
      | 'DUE_DATE_CHANGED'
      | 'ASSIGNEE_CHANGED'
      | 'DELETED'
      | 'RESTORED';
    changeReason: ChangeReason;
    fromValue: unknown;
    toValue: unknown;
    metadata: unknown;
  }
) {
  await db.prepare(
    `INSERT INTO task_history
      (id, workspace_id, task_id, actor_user_id, change_type, change_reason, from_value_json, to_value_json, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('th_'),
      args.workspaceId,
      args.taskId,
      args.actorUserId,
      args.changeType,
      args.changeReason,
      args.fromValue ? JSON.stringify(args.fromValue) : null,
      args.toValue ? JSON.stringify(args.toValue) : null,
      args.metadata ? JSON.stringify(args.metadata) : null
    )
    .run();
}

export async function writeProjectHistory(
  db: D1Database,
  args: {
    workspaceId: string;
    projectId: string;
    actorUserId: string | null;
    changeType: 'CREATED' | 'UPDATED' | 'PRIORITY_RULE_CHANGED' | 'DEADLINE_CHANGED' | 'DELETED' | 'RESTORED';
    changeReason: ChangeReason;
    fromValue: unknown;
    toValue: unknown;
    metadata: unknown;
  }
) {
  await db.prepare(
    `INSERT INTO project_history
      (id, workspace_id, project_id, actor_user_id, change_type, change_reason, from_value_json, to_value_json, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('ph_'),
      args.workspaceId,
      args.projectId,
      args.actorUserId,
      args.changeType,
      args.changeReason,
      args.fromValue ? JSON.stringify(args.fromValue) : null,
      args.toValue ? JSON.stringify(args.toValue) : null,
      args.metadata ? JSON.stringify(args.metadata) : null
    )
    .run();
}
