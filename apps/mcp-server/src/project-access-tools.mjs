const id = { type: 'string', minLength: 1 };
const projectIds = {
  type: 'array',
  items: id,
  maxItems: 50,
  uniqueItems: true
};
export const projectAccessTools = [
  {
    name: 'onboarding.get',
    description:
      "Start a personal task-manager connection: show only accessible projects and simple AI instructions. Use the account's own key, read existing tasks before adding, and preserve owner review, privacy and release gates.",
    inputSchema: {
      type: 'object',
      properties: { workspace_id: id },
      required: ['workspace_id'],
      additionalProperties: false
    }
  },
  {
    name: 'members.project_access.get',
    description:
      "Read your own project boundary. Only an owner may inspect another member's policy. null means workspace access; an empty list means no projects.",
    inputSchema: {
      type: 'object',
      properties: { workspace_id: id, user_id: id },
      required: ['workspace_id', 'user_id'],
      additionalProperties: false
    }
  },
  {
    name: 'members.project_access.set',
    description:
      "Owner-only security change after explicit authorization: set a member's exact project allowlist with current version, reason and stable retry key. null restores full workspace access; [] revokes project access. Never change access just to complete a task.",
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: id,
        user_id: id,
        version: { type: 'integer', minimum: 0 },
        project_ids: { anyOf: [projectIds, { type: 'null' }] },
        reason: id,
        idempotency_key: id
      },
      required: [
        'workspace_id',
        'user_id',
        'version',
        'project_ids',
        'reason',
        'idempotency_key'
      ],
      additionalProperties: false
    }
  }
];
export async function callProjectAccessTool(name, args, apiRequest) {
  if (!projectAccessTools.some((t) => t.name === name)) return undefined;
  if (!args.workspace_id) throw new Error('workspace_id is required');
  const base = `/v1/workspaces/${encodeURIComponent(args.workspace_id)}`;
  if (name === 'onboarding.get') return apiRequest('GET', `${base}/onboarding`);
  if (!args.user_id) throw new Error('user_id is required');
  const path = `${base}/members/${encodeURIComponent(args.user_id)}/project-access`;
  if (name === 'members.project_access.get') return apiRequest('GET', path);
  const { workspace_id, user_id, idempotency_key, ...body } = args;
  if (!idempotency_key) throw new Error('idempotency_key is required');
  return apiRequest('PUT', path, {
    headers: { 'idempotency-key': idempotency_key },
    body
  });
}
