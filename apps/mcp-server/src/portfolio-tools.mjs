const id = { type: 'string', minLength: 1, maxLength: 200 };
export const portfolioTools = [
  {
    name: 'portfolio.get',
    description:
      'Read your private cross-project portfolio and Monday weekly overview: one chosen active priority, at most two Ready fallbacks, progress, blockers and optional shared daily availability. Uses existing task IDs/queues. Availability is not logged or approved time. Personal keys only.',
    inputSchema: {
      type: 'object',
      properties: { week_start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
      required: ['week_start_date'],
      additionalProperties: false
    }
  },
  {
    name: 'portfolio.update',
    description:
      'Update your own portfolio preferences with version and exact retry key. Select existing project IDs; do not create/move projects. Pause/resume preserves task status, evidence, deadlines and a restart note; it does not release a workspace active slot. Daily minutes are one shared 0-120 budget, null clears to unset. Zero days never create overdue work or time entries. Do not include company work without explicit selection.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { type: 'integer', minimum: 0 },
        idempotency_key: { type: 'string', minLength: 8, maxLength: 120 },
        project_ids: { type: 'array', items: id, maxItems: 50, uniqueItems: true },
        focus_task_id: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
        paused: { type: 'boolean' },
        resume_note: { type: 'string', maxLength: 2000 },
        timezone: { type: 'string', maxLength: 100 },
        availability: {
          type: 'array',
          maxItems: 31,
          items: {
            type: 'object',
            properties: {
              date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              minutes: { type: ['integer', 'null'], minimum: 0, maximum: 120 }
            },
            required: ['date', 'minutes'],
            additionalProperties: false
          }
        }
      },
      required: ['version', 'idempotency_key']
    }
  }
];
export async function callPortfolioTool(name, args, apiRequest) {
  if (!portfolioTools.some((t) => t.name === name)) return undefined;
  if (name === 'portfolio.get') {
    if (!args.week_start_date) throw new Error('week_start_date is required');
    return apiRequest(
      'GET',
      `/v1/me/portfolio?week_start_date=${encodeURIComponent(args.week_start_date)}`
    );
  }
  const { idempotency_key, ...body } = args;
  if (!idempotency_key) throw new Error('idempotency_key is required');
  return apiRequest('PUT', '/v1/me/portfolio', {
    headers: { 'idempotency-key': idempotency_key },
    body
  });
}
