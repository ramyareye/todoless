import type { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { homePage, homeStyles } from '../lib/home-page';

export function registerHomeRoutes(app: Hono<AppEnv>) {
  app.get('/', (c) => {
    c.header('cache-control', 'public, max-age=300');
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('content-security-policy', "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    return c.html(homePage);
  });
  app.get('/homepage.css', (c) => {
    c.header('content-type', 'text/css; charset=utf-8');
    c.header('cache-control', 'public, max-age=300');
    c.header('x-content-type-options', 'nosniff');
    return c.body(homeStyles);
  });
}
