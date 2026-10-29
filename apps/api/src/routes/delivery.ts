import type { Context, Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { error, jsonBody, ok, validationError } from '../lib/response';
import { requireMembership, hasScope } from '../services/authz';
import { requireProject, projectListFilter, projectAllowed, referenceAllowed, readableDependencies, memberCanAccessProjectSql, referenceWriteGuard } from '../services/project-access';
import { operation, operationGuard } from '../services/delivery-operations';
import { prepareAudit, prepareTaskHistory } from '../services/audit';
import {
  cardOf,
  contributors,
  deliveryUpdateSchema,
  deliveryView,
  dependencyRowsSql,
  freeActiveSlotSql,
  legacyStatus,
  needsReady,
  readDeliveryTask,
  readinessIssues,
  stageOf,
  transitions,
  type DeliveryTask,
  type Dependency
} from '../services/task-delivery';

const cycleSql = `WITH RECURSIVE reachable(id) AS (
  SELECT value FROM json_each(?) UNION
  SELECT d.depends_on_task_id FROM task_dependencies d JOIN reachable r ON d.task_id = r.id WHERE d.workspace_id = ?
) SELECT 1 FROM reachable WHERE id = ?`;
const invalidDependencySql = `SELECT 1 FROM json_each(?) ids LEFT JOIN tasks t ON t.id = ids.value
  WHERE t.id IS NULL OR t.workspace_id != ? OR t.deleted_at IS NOT NULL OR t.id = ?`;
const unfinishedDependencySql = `SELECT 1 FROM json_each(?) ids JOIN tasks t ON t.id = ids.value
  LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
  WHERE t.status != 'DONE' OR t.deleted_at IS NOT NULL OR (t.project_id IS NOT NULL AND (p.id IS NULL OR p.deleted_at IS NOT NULL))`;
async function access(c: Context<AppEnv>, workspace: string, write = false) {
  if (!hasScope(c.get('principal'), write ? 'workspace:write' : 'workspace:read'))
    return { error: error(c, 403, 'FORBIDDEN', 'Missing workspace scope') };
  return requireMembership(c, workspace, write ? 'MEMBER' : 'VIEWER');
}

export function registerDeliveryRoutes(app: Hono<AppEnv>) {
  app.get('/v1/tasks/:taskId/delivery', async (c) => {
    const task = await readDeliveryTask(c.env.DB, c.req.param('taskId'));
    if (!task || task.deleted_at) return error(c, 404, 'NOT_FOUND', 'Task not found');
    const member = await access(c, task.workspace_id);
    if ('error' in member) return member.error;
    const denied=await requireProject(c,task.project_id);if(denied)return denied;
    const dependencies = (
      await c.env.DB.prepare(`${dependencyRowsSql} WHERE d.task_id = ? AND d.workspace_id = ?`)
        .bind(task.id, task.workspace_id)
        .all<Dependency>()
    ).results;
    return ok(c, readableDependencies(c,deliveryView(task, dependencies, await contributors(c.env.DB, task.workspace_id,task.project_id)),dependencies));
  });

  app.put('/v1/tasks/:taskId/delivery', async (c) => {
    const task = await readDeliveryTask(c.env.DB, c.req.param('taskId'));
    if (!task || task.deleted_at) return error(c, 404, 'NOT_FOUND', 'Task not found');
    const member = await access(c, task.workspace_id, true);
    if ('error' in member) return member.error;
    const denied=await requireProject(c,task.project_id);if(denied)return denied;
    const input = await jsonBody(c);
    if (!input.ok) return input.response;
    const parsed = deliveryUpdateSchema.safeParse(input.data);
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const body = parsed.data;
    const projectDenied=await requireProject(c,body.project_id===undefined?task.project_id:body.project_id);if(projectDenied)return projectDenied;
    if(member.projectIds!==null){
      if(body.stage==='VERIFY'||body.stage==='DONE')return error(c,403,'FORBIDDEN','Project-restricted coordination cannot approve or verify work');
      if(body.details?.verification_passed||body.details?.device_accepted||body.details?.deployed)
        return error(c,403,'FORBIDDEN','Project-restricted coordination cannot record acceptance or deployment decisions');
      for(const id of body.depends_on??[])if(!await referenceAllowed(c,task.workspace_id,id))return error(c,404,'NOT_FOUND','Referenced task not found');
    }
    const actor = c.get('principal').userId;
    const admin = ['OWNER', 'ADMIN'].includes(member.role);
    const op = await operation(c, task.workspace_id, body);
    if ('response' in op) return op.response;
    if (task.version !== body.version) return error(c, 409, 'VERSION_CONFLICT', 'Reload the current task');
    const previousCard = cardOf(task);
    const previousStage = stageOf(task);
    const stage = body.stage ?? previousStage;
    if (stage !== previousStage && !transitions[previousStage].includes(stage))
      return error(c, 409, 'INVALID_TRANSITION', `Cannot move ${previousStage} directly to ${stage}`);
    const reviewerChanged =
      body.reviewer_user_id !== undefined && body.reviewer_user_id !== previousCard.reviewer_user_id;
    if (reviewerChanged && !admin)
      return error(c, 403, 'FORBIDDEN', 'An admin assigns or changes the reviewer');
    const reviewDecision = stage !== previousStage && ['VERIFY', 'DONE'].includes(stage);
    const reviewed = task.delivery_state && ['REVIEW', 'VERIFY', 'DONE'].includes(previousStage);
    const reopening = ['ACTIVE', 'BACKLOG'].includes(stage) && stage !== previousStage;
    const scopeEdit =
      body.project_id !== undefined ||
      body.assignee_user_id !== undefined ||
      body.depends_on !== undefined ||
      Object.keys(body.details ?? {}).some(
        (key) =>
          ![
            'source_complete',
            'deployed',
            'verification_passed',
            'device_accepted',
            'evidence',
            'build_ref'
          ].includes(key)
      );
    if (reviewed && !reopening && (scopeEdit || (previousStage === 'DONE' && body.details !== undefined)))
      return error(
        c,
        409,
        'REWORK_REQUIRED',
        'Reopen implementation before changing reviewed scope or completed evidence'
      );
    const reviewWrite = reviewDecision || Boolean(reviewed && !reopening && body.details !== undefined);
    if (reviewWrite && !admin && previousCard.reviewer_user_id !== actor)
      return error(
        c,
        403,
        'FORBIDDEN',
        'Only the designated reviewer or an admin records review and verification'
      );
    const card = {
      ...previousCard,
      reviewer_user_id:
        body.reviewer_user_id === undefined ? previousCard.reviewer_user_id : body.reviewer_user_id,
      details: { ...previousCard.details, ...body.details },
      blocker: body.blocker === undefined ? previousCard.blocker : body.blocker
    };
    // Returning to implementation invalidates evidence about the previous build.
    if (stage !== previousStage && (stage === 'BACKLOG' || stage === 'ACTIVE')) {
      Object.assign(card.details, {
        source_complete: false,
        deployed: false,
        verification_passed: false,
        device_accepted: false,
        build_ref: '',
        evidence: []
      });
    }
    if (stage !== 'BLOCKED') card.blocker = null;
    if (stage === 'BLOCKED' && !card.blocker)
      return error(c, 400, 'BLOCKER_REQUIRED', 'Blocked work needs an owner, reason and next action');
    const projectId = body.project_id === undefined ? task.project_id : body.project_id;
    const assignee = body.assignee_user_id === undefined ? task.assignee_user_id : body.assignee_user_id;
    const members = await contributors(c.env.DB, task.workspace_id,projectId);
    if ([assignee, card.reviewer_user_id, card.blocker?.owner_user_id].some((id) => id && !members.has(id)))
      return error(
        c,
        400,
        'INVALID_MEMBER',
        'Owner, reviewer and blocker owner must be current contributors'
      );
    const project = projectId
      ? await c.env.DB.prepare(
          'SELECT 1 FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
        )
          .bind(projectId, task.workspace_id)
          .first()
      : null;
    if (projectId && !project)
      return error(c, 400, 'INVALID_PROJECT', 'Project must be active in this workspace');
    const oldDependencies = (
      await c.env.DB.prepare(`${dependencyRowsSql} WHERE d.task_id = ? AND d.workspace_id = ?`)
        .bind(task.id, task.workspace_id)
        .all<Dependency>()
    ).results;
    if(member.projectIds!==null && body.depends_on!==undefined && oldDependencies.some(d=>!projectAllowed(member.projectIds,d.project_id)))
      return error(c,403,'DEPENDENCY_RESTRICTED','An owner must change dependencies outside your project access');
    const ids = body.depends_on ?? oldDependencies.map((d) => d.id);
    const idsJson = JSON.stringify(ids);
    if (
      await c.env.DB.prepare(`${invalidDependencySql} LIMIT 1`)
        .bind(idsJson, task.workspace_id, task.id)
        .first()
    )
      return error(c, 400, 'INVALID_DEPENDENCY', 'Dependencies must be other active tasks in this workspace');
    if (await c.env.DB.prepare(cycleSql).bind(idsJson, task.workspace_id, task.id).first())
      return error(c, 409, 'DEPENDENCY_CYCLE', 'Dependency would introduce a cycle');
    const dependencies = (
      await c.env.DB.prepare(
        `SELECT t.id,t.title,t.status,t.deleted_at,t.project_id,? AS task_id,
      CASE WHEN t.project_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL) THEN 1 ELSE 0 END AS project_live
      FROM tasks t LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id WHERE t.id IN (SELECT value FROM json_each(?)) AND t.workspace_id = ?`
      )
        .bind(task.id, idsJson, task.workspace_id)
        .all<Dependency>()
    ).results;
    const next: DeliveryTask = {
      ...task,
      project_id: projectId,
      assignee_user_id: assignee,
      version: task.version + 1,
      status: legacyStatus[stage],
      delivery_state: stage,
      delivery_json: JSON.stringify(card),
      project_live: project ? 1 : 0
    };
    const issues = readinessIssues(next, card, dependencies, members);
    if (needsReady(stage) && issues.length)
      return error(c, 409, 'NOT_READY', 'Complete readiness requirements and dependencies', { issues });
    if (
      ['REVIEW', 'VERIFY', 'DONE'].includes(stage) &&
      (!card.details.source_complete || !card.details.evidence.length)
    )
      return error(c, 400, 'EVIDENCE_REQUIRED', 'Review requires completed source and evidence references');
    if (stage === 'DONE' && !card.details.verification_passed)
      return error(c, 400, 'VERIFICATION_REQUIRED', 'Record passed acceptance checks before marking done');
    if (
      stage === 'ACTIVE' &&
      assignee &&
      (await c.env.DB.prepare(`SELECT 1 WHERE NOT (${freeActiveSlotSql})`)
        .bind(task.workspace_id, assignee, task.id)
        .first())
    )
      return error(c, 409, 'ACTIVE_TASK_LIMIT', 'This person already has active work in this workspace');
    const referencedMembers = JSON.stringify(
      [assignee, card.reviewer_user_id, card.blocker?.owner_user_id].filter(Boolean)
    );
    const data = readableDependencies(c,deliveryView(next, dependencies, members),dependencies);
    const refsGuard=referenceWriteGuard(c,task.workspace_id,body.depends_on??[],projectId);
    return op.commit(
      `EXISTS (SELECT 1 FROM tasks WHERE id = ? AND version = ? AND deleted_at IS NULL)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) ids LEFT JOIN memberships m ON m.user_id = ids.value AND m.workspace_id = ? WHERE m.user_id IS NULL OR m.role = 'VIEWER' OR NOT (${memberCanAccessProjectSql('m','?')}))
      AND NOT EXISTS (${invalidDependencySql}) AND NOT EXISTS (${cycleSql})
      AND (? = 0 OR NOT EXISTS (${unfinishedDependencySql}))
      AND (? != 'ACTIVE' OR ${freeActiveSlotSql}) AND ${refsGuard.sql}
      AND EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = ? AND m.user_id = ?
        AND (? = 0 OR m.role IN ('OWNER','ADMIN')) AND (? = 0 OR m.role IN ('OWNER','ADMIN') OR m.user_id = ?))`,
      [
        task.id,
        body.version,
        projectId,
        projectId,
        task.workspace_id,
        referencedMembers,
        task.workspace_id,
        projectId,projectId,
        idsJson,
        task.workspace_id,
        task.id,
        idsJson,
        task.workspace_id,
        task.id,
        needsReady(stage) ? 1 : 0,
        idsJson,
        stage,
        task.workspace_id,
        assignee,
        task.id,
        ...refsGuard.params,
        task.workspace_id,
        actor,
        reviewerChanged ? 1 : 0,
        reviewWrite ? 1 : 0,
        previousCard.reviewer_user_id
      ],
      (id) => {
        const guard = { table: 'tasks' as const, id: task.id, mutationId: id };
        return [
          c.env.DB.prepare(
            `UPDATE tasks SET project_id=?,assignee_user_id=?,status=?,delivery_state=?,delivery_json=?,version=version+1,last_mutation_id=?,updated_at=CURRENT_TIMESTAMP,
            completed_at=CASE WHEN ? = 'DONE' THEN COALESCE(completed_at,CURRENT_TIMESTAMP) ELSE NULL END WHERE id=? AND ${operationGuard}`
          ).bind(projectId, assignee, next.status, stage, next.delivery_json, id, next.status, task.id, id),
          c.env.DB.prepare(`DELETE FROM task_dependencies WHERE task_id=? AND ${operationGuard}`).bind(
            task.id,
            id
          ),
          c.env.DB.prepare(
            `INSERT INTO task_dependencies (workspace_id,task_id,depends_on_task_id) SELECT ?,?,value FROM json_each(?) WHERE ${operationGuard}`
          ).bind(task.workspace_id, task.id, idsJson, id),
          prepareTaskHistory(
            c.env.DB,
            {
              workspaceId: task.workspace_id,
              taskId: task.id,
              actorUserId: actor,
              changeType: stage === previousStage ? 'UPDATED' : 'STATUS_CHANGED',
              changeReason: stage === 'BLOCKED' ? 'dependency_blocked' : 'manual',
              fromValue: {
                stage: previousStage,
                version: task.version,
                project_id: task.project_id,
                assignee_user_id: task.assignee_user_id,
                ...previousCard,
                depends_on: oldDependencies.map((d) => d.id)
              },
              toValue: {
                stage,
                version: next.version,
                project_id: projectId,
                assignee_user_id: assignee,
                ...card,
                depends_on: ids
              },
              metadata: { reason: body.reason, workflow: 'delivery' }
            },
            guard
          ),
          prepareAudit(
            c.env.DB,
            {
              workspaceId: task.workspace_id,
              actorUserId: actor,
              action: 'UPDATE_DELIVERY',
              entityType: 'task',
              entityId: task.id,
              metadata: { stage, version: next.version, reason: body.reason }
            },
            guard
          )
        ];
      },
      data
    );
  });

  app.get('/v1/workspaces/:workspaceId/delivery/queue', async (c) => {
    const workspace = c.req.param('workspaceId');
    const member = await access(c, workspace);
    if ('error' in member) return member.error;
    const userId = c.req.query('user_id') ?? c.get('principal').userId;
    const members = await contributors(c.env.DB, workspace);
    if (!members.has(userId)) return error(c, 400, 'INVALID_MEMBER', 'Select a current contributor');
    // A bounded person queue is complete or rejected, never silently truncated.
    const visible=projectListFilter(c,'t.project_id');
    const rows = (
      await c.env.DB.prepare(
        `SELECT t.*,CASE WHEN p.id IS NOT NULL AND p.deleted_at IS NULL THEN 1 ELSE 0 END AS project_live
      FROM tasks t LEFT JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id
      WHERE t.workspace_id=? AND t.assignee_user_id=? AND t.deleted_at IS NULL AND t.status NOT IN ('DONE','ARCHIVED') AND ${visible.sql}
      ORDER BY t.priority,t.due_at IS NULL,t.due_at,t.created_at,t.id LIMIT 501`
      )
        .bind(workspace, userId,...visible.params)
        .all<DeliveryTask>()
    ).results;
    if (rows.length > 500)
      return error(c, 400, 'QUEUE_TOO_LARGE', 'Archive or reassign old work before loading this queue');
    const dependencies = (
      await c.env.DB.prepare(
        `${dependencyRowsSql} WHERE d.workspace_id=? AND d.task_id IN (SELECT value FROM json_each(?))`
      )
        .bind(workspace, JSON.stringify(rows.map((r) => r.id)))
        .all<Dependency>()
    ).results;
    const cards = rows.map((t) =>
      readableDependencies(c,deliveryView(
        t,
        dependencies.filter((d) => d.task_id === t.id),
        members
      ),dependencies.filter(d=>d.task_id===t.id))
    );
    const active = cards.filter((t) => t.stage === 'ACTIVE');
    const ready = cards.filter((t) => t.can_start);
    return ok(c, {
      workspace_id: workspace,
      user_id: userId,
      active,
      active_limit: 1,
      active_conflict: active.length > 1,
      ready_alternatives: ready.slice(0, 2),
      ready_count: ready.length,
      missing_ready_alternatives: Math.max(0, 2 - ready.length),
      blocked: cards.filter((t) => t.effective_stage === 'BLOCKED'),
      review: cards.filter((t) => t.stage === 'REVIEW'),
      verify: cards.filter((t) => t.stage === 'VERIFY')
    });
  });
}
