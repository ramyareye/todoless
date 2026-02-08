import type { Context } from 'hono';
import type { AppEnv } from './types';

export function ok(c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) {
  return c.json(
    {
      success: true,
      data,
      meta: {
        request_id: c.get('requestId'),
      },
    },
    status
  );
}

export function error(
  c: Context<AppEnv>,
  status: 400 | 401 | 403 | 404 | 409 | 415 | 429 | 500,
  code: string,
  message: string,
  details?: unknown
) {
  return c.json(
    {
      success: false,
      error: {
        code,
        message,
        details,
      },
      meta: {
        request_id: c.get('requestId'),
      },
    },
    status
  );
}

export function validationError(c: Context<AppEnv>, details: unknown) {
  return error(c, 400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

export type JsonBodyResult =
  | { ok: true; data: unknown }
  | { ok: false; response: Response };

export async function jsonBody(c: Context<AppEnv>): Promise<JsonBodyResult> {
  const contentType = c.req.header('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    return {
      ok: false,
      response: error(c, 415, 'INVALID_CONTENT_TYPE', 'Expected content-type: application/json'),
    };
  }

  try {
    return { ok: true, data: await c.req.json() };
  } catch {
    return {
      ok: false,
      response: error(c, 400, 'INVALID_JSON', 'Malformed JSON body'),
    };
  }
}
