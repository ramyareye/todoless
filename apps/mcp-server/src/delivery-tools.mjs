const string = { type: 'string', minLength: 1 };
const nullableId = { type: ['string', 'null'], minLength: 1 };
const references = { type: 'array', items: string, maxItems: 20 };
const details = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(
      ['area', 'repository', 'outcome', 'scope', 'base_ref', 'environment', 'next_action', 'build_ref'].map(
        (key) => [key, { type: 'string', maxLength: 2000 }]
      )
    ),
    ...Object.fromEntries(
      ['contract_refs', 'acceptance_checks', 'exclusions', 'evidence'].map((key) => [key, references])
    ),
    ...Object.fromEntries(
      ['setup_ready', 'source_complete', 'deployed', 'verification_passed', 'device_accepted'].map((key) => [
        key,
        { type: 'boolean' }
      ])
    ),
    integration_mode: { type: 'string', enum: ['live', 'fixture'] }
  }
};
export const deliveryTools = [
  {
    name: 'delivery.get',
    description:
      'Read a delivery card, current dependency readiness and evidence. Old TODO maps to BACKLOG. Source completion, deployment and device acceptance are separate facts.',
    inputSchema: {
      type: 'object',
      properties: { task_id: string },
      required: ['task_id'],
      additionalProperties: false
    }
  },
  {
    name: 'delivery.update',
    description:
      'Update an authorized delivery card with current version and a retry key. Ready requires setup, acceptance details and completed dependencies. Only one ACTIVE task per person/workspace. Blockers need an owner/reason/next action. Admin assigns reviewer; reviewer/admin advances Review to Verify and Verify to Done. Record actual evidence, never infer human verification, release approval or hours.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: string,
        idempotency_key: string,
        version: { type: 'integer', minimum: 1 },
        reason: string,
        stage: {
          type: 'string',
          enum: ['BACKLOG', 'READY', 'ACTIVE', 'BLOCKED', 'REVIEW', 'VERIFY', 'DONE', 'ARCHIVED']
        },
        project_id: nullableId,
        assignee_user_id: nullableId,
        reviewer_user_id: nullableId,
        details,
        depends_on: { type: 'array', items: string, maxItems: 50, uniqueItems: true },
        blocker: {
          type: ['object', 'null'],
          properties: { owner_user_id: string, reason: string, next_action: string },
          required: ['owner_user_id', 'reason', 'next_action'],
          additionalProperties: false
        }
      },
      required: ['task_id', 'idempotency_key', 'version', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'delivery.queue',
    description:
      "Read one person's cross-project workspace queue: active work, two ready alternatives, shortages, blockers, review and verify. Existing duplicate active tasks are flagged for human resolution, never silently paused.",
    inputSchema: {
      type: 'object',
      properties: { workspace_id: string, user_id: string },
      required: ['workspace_id'],
      additionalProperties: false
    }
  }
];
export async function callDeliveryTool(name, args, apiRequest) {
  if (!deliveryTools.some((tool) => tool.name === name)) return undefined;
  if (name === 'delivery.queue') {
    if (!args.workspace_id) throw new Error('workspace_id is required');
    const query = args.user_id ? `?user_id=${encodeURIComponent(args.user_id)}` : '';
    return apiRequest(
      'GET',
      `/v1/workspaces/${encodeURIComponent(args.workspace_id)}/delivery/queue${query}`
    );
  }
  const { task_id, idempotency_key, ...body } = args;
  if (!task_id) throw new Error('task_id is required');
  const path = `/v1/tasks/${encodeURIComponent(task_id)}/delivery`;
  if (name === 'delivery.update' && !idempotency_key) throw new Error('idempotency_key is required');
  return name === 'delivery.get'
    ? apiRequest('GET', path)
    : apiRequest('PUT', path, { headers: { 'idempotency-key': idempotency_key }, body });
}
