import { expect, test } from 'bun:test';
import sourceApp from '../src/index';
const app = process.env.TODOLESS_TEST_EXACT_RELEASE === 'google-signup-2026-10-29'
  ? (await import('../.dist/google-signup-release-2026-10-29/api.mjs')).default : sourceApp;

test('public homepage loads without bindings, reflects no request data and has no account side effects', async () => {
  // No DB or credentials are provided: the public page must never require them.
  const response = await app.request('/?email=private@example.com&key=never-reflect-this');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  const html = await response.text();
  expect(html).not.toContain('private@example.com');
  expect(html).not.toContain('never-reflect-this');
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<form');
  expect(html).not.toContain('href="/signup"');
  expect(html).toContain('https://hopkit.hiphop.dev/delivery');
  expect(html).toContain('https://hiphop.dev/');
  expect(html).not.toContain('workers.dev');
  const cssPath = html.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1];
  expect(cssPath).toBeTruthy();
  const css = await app.request(cssPath!);
  expect(css.status).toBe(200);
  expect(css.headers.get('content-type')).toContain('text/css');
});

test('homepage routing keeps private API authentication and JSON not-found responses', async () => {
  for (const path of ['/v1/me', '/v1/workspaces', '/v1/tasks/example/delivery']) {
    const response = await app.request(path);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
  }
  const unknown = await app.request('/not-a-page');
  expect(unknown.status).toBe(404);
  expect((await unknown.json()).error.code).toBe('NOT_FOUND');
  const head = await app.request('/', { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
});
