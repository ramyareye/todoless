import { expect, test } from 'bun:test';
import sourceWorker from '../src/worker.mjs';
const worker = process.env.TODOLESS_TEST_EXACT_RELEASE === 'usage-protection-2026-10-29'
  ? (await import('../../api/.dist/usage-protection-release-2026-10-29/mcp.mjs')).default : sourceWorker;

test('stateless MCP declines the optional GET listener promptly without touching upstream', async () => {
  const response = await worker.fetch(new Request('https://mcp.example.test/mcp', {
    headers: { authorization: 'Bearer synthetic-personal-key', accept: 'text/event-stream' }
  }), { TODOLESS_API: { fetch() { throw new Error('GET must not touch upstream'); } } });
  expect(response.status).toBe(405);
  expect(response.headers.get('allow')).toBe('POST, DELETE, OPTIONS');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(await response.text()).not.toContain('synthetic-personal-key');
});

test('GET listener still requires a personal credential and respects MCP gateway authentication', async () => {
  expect((await worker.fetch(new Request('https://mcp.example.test/mcp'), {})).status).toBe(401);
  expect((await worker.fetch(new Request('https://mcp.example.test/mcp', {
    headers: { authorization: 'Bearer wrong-gateway', 'x-todoless-api-key': 'synthetic-personal-key' }
  }), { MCP_AUTH_TOKEN: 'synthetic-gateway' })).status).toBe(401);
  expect((await worker.fetch(new Request('https://mcp.example.test/mcp', {
    headers: { authorization: 'Bearer synthetic-gateway', 'x-todoless-api-key': 'synthetic-personal-key' }
  }), { MCP_AUTH_TOKEN: 'synthetic-gateway' })).status).toBe(405);
});

test('health and CORS preflight retain their existing behavior', async () => {
  const response = await worker.fetch(new Request('https://mcp.example.test/health'), {});
  expect(response.status).toBe(200);
  expect((await response.json()).service).toBe('todoless-mcp-http');
  expect((await worker.fetch(new Request('https://mcp.example.test/mcp', { method: 'OPTIONS' }), {})).status).toBe(204);
});
