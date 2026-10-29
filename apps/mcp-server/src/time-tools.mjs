const string = { type: 'string', minLength: 1 };
const version = { type: 'integer', minimum: 0 };
const entry = {
  type: 'object',
  properties: {
    project_id: string,
    task_id: string,
    work_date: string,
    activity: { type: 'string', enum: ['development', 'qa', 'setup', 'research', 'rework', 'review'] },
    minutes: { type: 'integer', minimum: 1, maximum: 1440 },
    note: string,
    evidence_ref: { type: ['string', 'null'] }
  },
  required: ['project_id', 'task_id', 'work_date', 'activity', 'minutes', 'note'],
  additionalProperties: false
};
const read = (name, description, properties = {}, required = []) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: { workspace_id: string, ...properties },
    required: ['workspace_id', ...required],
    additionalProperties: false
  }
});
const write = (name, description, properties = {}, required = []) =>
  read(name, description, { idempotency_key: string, ...properties }, ['idempotency_key', ...required]);
const action = (name, description, properties = {}, required = []) =>
  write(name, description, { week_id: string, version, ...properties }, ['week_id', 'version', ...required]);
const range = { from: string, to: string, user_id: string };
export const timeTools = [
  read('time.settings.get', 'Read explicit weekly time settings. Null means not configured.'),
  write(
    'time.settings.configure',
    'Owner only. Record agreed timezone/week start; never infer these settings.',
    {
      version,
      timezone: string,
      week_start: { type: 'integer', minimum: 0, maximum: 6 },
      confirmed: { const: true }
    },
    ['version', 'timezone', 'week_start', 'confirmed']
  ),
  read('time.terms.get', 'Read own terms; authorized approvers may read a named contributor.', {
    user_id: string
  }),
  write(
    'time.terms.set',
    'Owner only: record explicitly agreed effective-date terms. Never guess a rate, currency or cap from availability.',
    {
      version,
      user_id: string,
      effective_from: string,
      rate_minor_per_hour: { type: ['integer', 'null'], minimum: 0 },
      currency: { type: ['string', 'null'] },
      minor_unit_scale: { type: ['integer', 'null'], minimum: 0, maximum: 4 },
      weekly_cap_minutes: { type: ['integer', 'null'], minimum: 1 }
    },
    [
      'version',
      'user_id',
      'effective_from',
      'rate_minor_per_hour',
      'currency',
      'minor_unit_scale',
      'weekly_cap_minutes'
    ]
  ),
  write(
    'time.approvers.set',
    'Owner only: grant or revoke private team-time review access after explicit owner authorization.',
    { version, user_id: string, enabled: { type: 'boolean' } },
    ['version', 'user_id', 'enabled']
  ),
  write(
    'time.week.create',
    'Create own draft week using its local start date; requires configured week settings.',
    { week_start_date: string },
    ['week_start_date']
  ),
  read(
    'time.week.get',
    "Read own week or, for an authorized approver, a team member's week.",
    { week_id: string },
    ['week_id']
  ),
  read(
    'time.week.list',
    'List weeks in a bounded date range. user_id=all is restricted to approvers.',
    { ...range, cursor: string, limit: { type: 'integer', minimum: 1, maximum: 100 } },
    ['from', 'to']
  ),
  read(
    'time.week.history',
    'Read immutable versions, reasons and actors. Continue with pagination.next_cursor.',
    { week_id: string, cursor: string },
    ['week_id']
  ),
  action(
    'time.entry.save',
    'Record or edit manual human-supplied work only. Do not infer minutes from commits, estimates, AI runs or unattended work.',
    { entry_id: string, entry },
    ['entry']
  ),
  action(
    'time.entry.remove',
    'Remove an entry only from a draft, preserving the prior snapshot and the supplied reason.',
    { entry_id: string, reason: string },
    ['entry_id', 'reason']
  ),
  action(
    'time.week.submit',
    'Submit frozen human-confirmed hours across all projects. Confirmation excludes breaks, unattended work and duplicate time; ask the human rather than infer it.',
    { confirmed_human_time: { const: true } },
    ['confirmed_human_time']
  ),
  action(
    'time.week.approve',
    'Record an authorized human review decision; never self-approve or invent approval. Approved hours do not mean paid. Reductions require a reason; over-cap hours require an explicit decision.',
    {
      entries: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: { entry_id: string, approved_minutes: { type: 'integer', minimum: 0 } },
          required: ['entry_id', 'approved_minutes'],
          additionalProperties: false
        }
      },
      reason: string,
      over_cap_decision: { const: 'approve' }
    },
    ['entries']
  ),
  action(
    'time.week.return',
    'Authorized approver returns a submitted week with a reason; failed work is not automatically unpaid.',
    { reason: string },
    ['reason']
  ),
  action(
    'time.week.revise',
    'Contributor opens a correction revision of an approved/returned week. Any old approval is invalidated; history stays intact.',
    { reason: string },
    ['reason']
  ),
  read(
    'time.report',
    'Get entered/submitted/approved minutes by project, task and week; exact minor-unit amounts stay separated by currency.',
    range,
    ['from', 'to']
  ),
  read(
    'time.export_csv',
    'Export the same private report rows as spreadsheet-safe CSV. Unset amounts remain blank, never guessed.',
    range,
    ['from', 'to']
  )
];
const query = (params) => {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) values.set(key, String(value));
  return values.size ? `?${values}` : '';
};
export async function callTimeTool(name, args, apiRequest) {
  if (!timeTools.some((tool) => tool.name === name)) return undefined;
  const { workspace_id, week_id, idempotency_key, user_id, ...input } = args;
  if (!workspace_id) throw new Error('workspace_id is required');
  const root = `/v1/workspaces/${encodeURIComponent(workspace_id)}/time`;
  const headers = idempotency_key ? { 'idempotency-key': idempotency_key } : {};
  const actions = {
    'time.entry.save': 'save_entry',
    'time.entry.remove': 'remove_entry',
    'time.week.submit': 'submit',
    'time.week.approve': 'approve',
    'time.week.return': 'request_changes',
    'time.week.revise': 'revise'
  };
  if (actions[name]) {
    if (!week_id) throw new Error('week_id is required');
    return apiRequest('POST', `${root}/weeks/${encodeURIComponent(week_id)}/actions`, {
      headers,
      body: { ...input, action: actions[name] }
    });
  }
  switch (name) {
    case 'time.settings.get':
      return apiRequest('GET', `${root}/settings`);
    case 'time.settings.configure':
      return apiRequest('PUT', `${root}/settings`, { headers, body: input });
    case 'time.terms.get':
      return apiRequest('GET', `${root}/terms${query({ user_id })}`);
    case 'time.terms.set':
      return apiRequest('POST', `${root}/terms`, { headers, body: { ...input, user_id } });
    case 'time.approvers.set':
      if (!user_id) throw new Error('user_id is required');
      return apiRequest('PUT', `${root}/approvers/${encodeURIComponent(user_id)}`, { headers, body: input });
    case 'time.week.create':
      return apiRequest('POST', `${root}/weeks`, { headers, body: input });
    case 'time.week.get':
    case 'time.week.history':
      if (!week_id) throw new Error('week_id is required');
      return apiRequest(
        'GET',
        `${root}/weeks/${encodeURIComponent(week_id)}${name.endsWith('history') ? `/history${query({ cursor: input.cursor })}` : ''}`
      );
    case 'time.week.list':
      return apiRequest('GET', `${root}/weeks${query({ ...input, user_id })}`);
    case 'time.report':
      return apiRequest('GET', `${root}/report${query({ ...input, user_id })}`);
    case 'time.export_csv':
      return apiRequest('GET', `${root}/export.csv${query({ ...input, user_id })}`);
  }
}
