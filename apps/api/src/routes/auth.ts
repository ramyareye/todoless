import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Scope } from '../lib/types';
import { defaultWorkspaceName, makeWorkspaceSlug, newId } from '../lib/ids';
import { error, jsonBody, ok, validationError } from '../lib/response';
import { hashApiKey, issueApiKey } from '../services/api-keys';
import { writeAudit } from '../services/audit';
import { queueWelcomeEmail } from '../services/email';
import { extractInvitePrefix } from '../services/invites';
import { enforceRegisterRateLimit } from '../services/rate-limit';

const registerSchema = z.object({
  email: z.string().email(),
  display_name: z.string().min(1).max(80).optional(),
  workspace_name: z.string().min(1).max(100).optional(),
});

const claimInviteSchema = z.object({
  invite_token: z.string().min(1),
  display_name: z.string().min(1).max(80).optional(),
  api_key_name: z.string().min(1).max(80).optional(),
});

const PERSONAL_API_KEY_SCOPES: Scope[] = [
  'workspace:read',
  'workspace:write',
  'members:read',
  'members:write',
  'apikeys:write',
];

export function registerAuthRoutes(app: Hono<AppEnv>) {
  app.get('/accept-invite', (c) => {
    const token = c.req.query('token') ?? '';
    return c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Accept Todoless Invitation</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: #f7f7f5; color: #161616; margin: 0; }
      main { max-width: 640px; margin: 48px auto; padding: 24px; }
      .card { background: #fff; border: 1px solid #ddd; border-radius: 16px; padding: 24px; box-shadow: 0 8px 24px rgba(0,0,0,0.06); }
      h1 { margin-top: 0; font-size: 28px; }
      p { line-height: 1.5; }
      label { display: block; font-weight: 600; margin-bottom: 8px; }
      input, button, textarea { width: 100%; font: inherit; }
      input { box-sizing: border-box; padding: 12px; border: 1px solid #ccc; border-radius: 12px; margin-bottom: 16px; }
      button { padding: 12px 16px; border: 0; border-radius: 12px; background: #111; color: #fff; cursor: pointer; }
      pre { white-space: pre-wrap; word-break: break-word; background: #111; color: #f5f5f5; padding: 16px; border-radius: 12px; }
      .muted { color: #666; font-size: 14px; }
      .error { color: #9b1c1c; }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        <h1>Accept invitation</h1>
        <p>Claim your Todoless invitation and receive your personal API key.</p>
        <form id="claim-form">
          <label for="display_name">Display name</label>
          <input id="display_name" name="display_name" type="text" maxlength="80" placeholder="Jane Doe" />
          <button type="submit">Accept invitation</button>
        </form>
        <p id="status" class="muted"></p>
        <div id="result"></div>
      </div>
    </main>
    <script>
      const inviteToken = ${JSON.stringify(token)};
      const form = document.getElementById('claim-form');
      const statusEl = document.getElementById('status');
      const resultEl = document.getElementById('result');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        statusEl.textContent = 'Claiming invitation...';
        resultEl.innerHTML = '';
        const displayName = document.getElementById('display_name').value.trim();
        const response = await fetch('/v1/auth/claim-invite', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            invite_token: inviteToken,
            display_name: displayName || undefined
          })
        });
        const payload = await response.json().catch(() => null);
        if (!payload || payload.success !== true) {
          statusEl.textContent = payload?.error?.message || 'Invitation claim failed';
          statusEl.className = 'error';
          return;
        }
        statusEl.textContent = 'Invitation accepted. This API key is shown once.';
        statusEl.className = 'muted';
        resultEl.innerHTML =
          '<p><strong>Workspace:</strong> ' + payload.data.workspace.name + '</p>' +
          '<p><strong>User:</strong> ' + payload.data.user.email + '</p>' +
          '<pre>' + payload.data.api_key + '</pre>';
      });
    </script>
  </body>
</html>`);
  });

  app.post('/v1/auth/register', async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) {
      return body.response;
    }
    const parsed = registerSchema.safeParse(body.data);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }

    const payload = parsed.data;
    const email = payload.email.trim().toLowerCase();
    const displayName = payload.display_name?.trim() || null;

    const rateLimit = await enforceRegisterRateLimit(c, email);
    if (rateLimit.limited) {
      c.header('retry-after', String(rateLimit.retryAfterSeconds));
      return error(c, 429, 'RATE_LIMITED', 'Too many registration attempts', {
        retry_after_seconds: rateLimit.retryAfterSeconds,
      });
    }

    const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? LIMIT 1')
      .bind(email)
      .first<{ id: string }>();

    if (existingUser) {
      return error(c, 409, 'EMAIL_EXISTS', 'Email is already registered');
    }

    const userId = newId('usr_');
    const workspaceId = newId('ws_');
    const membershipId = newId('mem_');
    const workspaceName = payload.workspace_name?.trim() || defaultWorkspaceName(email);
    const workspaceSlug = makeWorkspaceSlug(workspaceName);

    const apiKey = await issueApiKey(c.env, {
      name: 'Default Personal Key',
      scopes: PERSONAL_API_KEY_SCOPES,
    });

    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)').bind(
        userId,
        email,
        displayName
      ),
      c.env.DB.prepare(
        'INSERT INTO workspaces (id, slug, name, created_by_user_id) VALUES (?, ?, ?, ?)'
      ).bind(workspaceId, workspaceSlug, workspaceName, userId),
      c.env.DB.prepare('INSERT INTO memberships (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)').bind(
        membershipId,
        workspaceId,
        userId,
        'OWNER'
      ),
      c.env.DB.prepare(
        `INSERT INTO api_keys
         (id, workspace_id, created_by_user_id, name, key_prefix, key_hash, scopes_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        apiKey.id,
        null,
        userId,
        apiKey.name,
        apiKey.keyPrefix,
        apiKey.keyHash,
        JSON.stringify(apiKey.scopes),
        null
      ),
    ]);

    await writeAudit(c.env.DB, {
      workspaceId,
      actorUserId: userId,
      action: 'REGISTER',
      entityType: 'workspace',
      entityId: workspaceId,
      metadata: { email },
    });

    const response = ok(
      c,
      {
        user: {
          id: userId,
          email,
          display_name: displayName,
        },
        workspace: {
          id: workspaceId,
          slug: workspaceSlug,
          name: workspaceName,
          role: 'OWNER',
        },
        api_key: apiKey.raw,
        api_key_prefix: apiKey.keyPrefix,
        api_key_scopes: apiKey.scopes,
      },
      201
    );

    queueWelcomeEmail(c, {
      email,
      displayName,
      workspaceName,
    });

    return response;
  });

  app.post('/v1/auth/claim-invite', async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) {
      return body.response;
    }
    const parsed = claimInviteSchema.safeParse(body.data);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }

    const payload = parsed.data;
    const invitePrefix = extractInvitePrefix(payload.invite_token.trim());
    if (!invitePrefix) {
      return error(c, 401, 'INVALID_INVITE_TOKEN', 'Invalid invite token');
    }

    const invite = await c.env.DB.prepare(
      `SELECT mi.id, mi.workspace_id, mi.user_id, mi.email, mi.token_hash, mi.expires_at, mi.claimed_at,
              w.slug AS workspace_slug, w.name AS workspace_name, w.deleted_at
       FROM member_invites mi
       JOIN workspaces w ON w.id = mi.workspace_id
       WHERE mi.token_prefix = ?
       LIMIT 1`
    )
      .bind(invitePrefix)
      .first<{
        id: string;
        workspace_id: string;
        user_id: string;
        email: string;
        token_hash: string;
        expires_at: string;
        claimed_at: string | null;
        workspace_slug: string;
        workspace_name: string;
        deleted_at: string | null;
      }>();

    if (!invite) {
      return error(c, 401, 'INVALID_INVITE_TOKEN', 'Invalid invite token');
    }

    if (invite.claimed_at) {
      return error(c, 409, 'INVITE_ALREADY_CLAIMED', 'Invite token has already been claimed');
    }

    if (invite.deleted_at) {
      return error(c, 409, 'INVITE_NO_LONGER_VALID', 'Invite no longer points to an active workspace');
    }

    if (Date.parse(invite.expires_at) <= Date.now()) {
      return error(c, 409, 'INVITE_EXPIRED', 'Invite token has expired');
    }

    if (!c.env.API_KEY_PEPPER) {
      return error(c, 500, 'SERVER_MISCONFIGURED', 'API_KEY_PEPPER is required');
    }

    const incomingHash = await hashApiKey(payload.invite_token.trim(), c.env.API_KEY_PEPPER);
    if (incomingHash !== invite.token_hash) {
      return error(c, 401, 'INVALID_INVITE_TOKEN', 'Invalid invite token');
    }

    const user = await c.env.DB.prepare(
      'SELECT id, email, display_name FROM users WHERE id = ? LIMIT 1'
    )
      .bind(invite.user_id)
      .first<{ id: string; email: string; display_name: string | null }>();

    if (!user) {
      return error(c, 409, 'INVITE_NO_LONGER_VALID', 'Invite no longer points to an active user');
    }

    const membership = await c.env.DB.prepare(
      `SELECT role
       FROM memberships
       WHERE workspace_id = ? AND user_id = ?
       LIMIT 1`
    )
      .bind(invite.workspace_id, invite.user_id)
      .first<{ role: string }>();

    if (!membership) {
      return error(c, 409, 'INVITE_NO_LONGER_VALID', 'Invite no longer points to an active membership');
    }

    const nextDisplayName = payload.display_name?.trim() || user.display_name;
    const apiKey = await issueApiKey(c.env, {
      name: payload.api_key_name?.trim() || 'Personal API Key',
      scopes: PERSONAL_API_KEY_SCOPES,
    });

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO api_keys
         (id, workspace_id, created_by_user_id, name, key_prefix, key_hash, scopes_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        apiKey.id,
        null,
        invite.user_id,
        apiKey.name,
        apiKey.keyPrefix,
        apiKey.keyHash,
        JSON.stringify(apiKey.scopes),
        null
      ),
      c.env.DB.prepare(
        `UPDATE member_invites
         SET claimed_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).bind(invite.id),
      c.env.DB.prepare(
        `UPDATE users
         SET display_name = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).bind(nextDisplayName, invite.user_id),
    ]);

    await writeAudit(c.env.DB, {
      workspaceId: invite.workspace_id,
      actorUserId: invite.user_id,
      action: 'CLAIM_MEMBER_INVITE',
      entityType: 'membership',
      entityId: `${invite.workspace_id}:${invite.user_id}`,
      metadata: { invite_id: invite.id, key_prefix: apiKey.keyPrefix },
    });

    const response = ok(
      c,
      {
        user: {
          id: user.id,
          email: user.email,
          display_name: nextDisplayName,
        },
        workspace: {
          id: invite.workspace_id,
          slug: invite.workspace_slug,
          name: invite.workspace_name,
          role: membership.role,
        },
        api_key: apiKey.raw,
        api_key_prefix: apiKey.keyPrefix,
        api_key_scopes: apiKey.scopes,
      },
      201
    );

    queueWelcomeEmail(c, {
      email: user.email,
      displayName: nextDisplayName,
      workspaceName: invite.workspace_name,
    });

    return response;
  });
}
