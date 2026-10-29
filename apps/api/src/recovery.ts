// Emergency replacement entry point. Deliberately independent of application
// routes, credentials, bindings and schema: it must boot during a failed rollout.
// Activating this artifact is an explicit deployment, never a request parameter.
export default {
  fetch(request: Request): Response {
    const requestId = `req_${crypto.randomUUID()}`;
    const health = new URL(request.url).pathname === '/v1/health' &&
      (request.method === 'GET' || request.method === 'HEAD');
    const body = health
      ? { success: true, data: { service: 'todoless-api', status: 'maintenance', writes_enabled: false } }
      : { success: false, error: { code: 'API_RECOVERY_MODE', message: 'Todoless is temporarily paused for recovery. Retry the same operation after service resumes.' } };
    return new Response(request.method === 'HEAD' ? null : JSON.stringify({
      ...body, meta: { request_id: requestId }
    }), {
      status: health ? 200 : 503,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '60',
        'x-content-type-options': 'nosniff',
        'x-request-id': requestId
      }
    });
  }
};
