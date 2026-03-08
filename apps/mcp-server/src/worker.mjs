import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createTodolessMcpServer, DEFAULT_API_BASE_URL } from './mcp-server.mjs';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers':
    'content-type, authorization, x-todoless-api-key, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
};

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function requestApiKeyHeader(request) {
  const value = request.headers.get('x-todoless-api-key');
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function resolveUpstreamApiKey(request, env) {
  const headerApiKey = requestApiKeyHeader(request);
  if (headerApiKey) {
    return {
      apiKey: headerApiKey,
      source: 'x-todoless-api-key',
    };
  }

  const bearer = bearerToken(request);
  if (!env.MCP_AUTH_TOKEN && bearer) {
    return {
      apiKey: bearer,
      source: 'authorization',
    };
  }

  return {
    apiKey: null,
    source: null,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const serviceBinding = env.TODOLESS_API || null;
    const fetchFn = serviceBinding ? serviceBinding.fetch.bind(serviceBinding) : fetch;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/health') {
      const apiBaseUrl = (env.TODOLESS_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
      const probe = url.searchParams.get('probe') === '1';
      let upstream = null;
      if (probe) {
        try {
          const upstreamResponse = await fetchFn(`${apiBaseUrl}/v1/health`, {
            headers: {
              accept: 'application/json',
            },
          });
          const upstreamText = await upstreamResponse.text();
          upstream = {
            url: `${apiBaseUrl}/v1/health`,
            via: serviceBinding ? 'service_binding' : 'fetch',
            status: upstreamResponse.status,
            content_type: upstreamResponse.headers.get('content-type'),
            body_prefix: upstreamText.slice(0, 120),
          };
        } catch (err) {
          upstream = { error: String(err) };
        }
      }

      return jsonResponse({
        ok: true,
        service: 'todoless-mcp-http',
        timestamp: new Date().toISOString(),
        api_base_url: apiBaseUrl,
        requires_mcp_auth_token: Boolean(env.MCP_AUTH_TOKEN),
        accepts_bearer_as_api_key: !Boolean(env.MCP_AUTH_TOKEN),
        accepts_request_api_key_header: true,
        has_service_binding: Boolean(serviceBinding),
        upstream,
      });
    }

    if (url.pathname !== '/mcp') {
      return jsonResponse({ ok: false, error: 'Not Found' }, 404);
    }

    if (env.MCP_AUTH_TOKEN) {
      const token = bearerToken(request);
      if (!token || token !== env.MCP_AUTH_TOKEN) {
        return jsonResponse({ ok: false, error: 'Unauthorized' }, 401, {
          'www-authenticate': 'Bearer',
        });
      }
    }

    const upstreamAuth = resolveUpstreamApiKey(request, env);
    if (!upstreamAuth.apiKey) {
      return jsonResponse(
        {
          ok: false,
          error:
            env.MCP_AUTH_TOKEN
              ? 'Missing Todoless API key. Send x-todoless-api-key.'
              : 'Missing Todoless API key. Send Authorization: Bearer <TODOLESS_API_KEY>.',
        },
        401,
        { 'www-authenticate': 'Bearer' }
      );
    }

    const apiBaseUrl = (env.TODOLESS_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
    const server = createTodolessMcpServer({
      apiBaseUrl,
      apiKey: upstreamAuth.apiKey,
      fetchFn,
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless mode works well in Worker environments and horizontal scaling.
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    const response = await transport.handleRequest(request);
    return withCors(response);
  },
};
