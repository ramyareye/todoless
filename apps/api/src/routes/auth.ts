import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Scope } from '../lib/types';
import { defaultWorkspaceName, makeWorkspaceSlug, newId } from '../lib/ids';
import { credentialPageNonce } from '../lib/credential-page';
import { exposesDevelopmentTokens } from '../lib/development-tokens';
import { error, jsonBody, ok, validationError } from '../lib/response';
import { hashApiKey, issueApiKey } from '../services/api-keys';
import { writeAudit } from '../services/audit';
import {
  extractEmailVerificationPrefix,
  issueEmailVerificationToken,
} from '../services/email-verification';
import {
  buildVerifyEmailUrl,
  isEmailDeliveryConfigured,
  queueEmailVerificationEmail,
  queueWelcomeEmail,
} from '../services/email';
import { extractInvitePrefix, hashInviteToken } from '../services/invites';
import { enforceRegisterRateLimit } from '../services/rate-limit';

const registerSchema = z.object({
  email: z.string().email(),
  display_name: z.string().min(1).max(80).optional(),
  workspace_name: z.string().min(1).max(100).optional(),
});

const verifyEmailSchema = z.object({
  verification_token: z.string().min(1),
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

function renderVerificationPendingResponse(
  c: Parameters<typeof ok>[0],
  args: {
    user: {
      id: string;
      email: string;
      display_name: string | null;
    };
    workspace: {
      id: string;
      slug: string;
      name: string;
      role: 'OWNER';
    };
    verification: {
      raw: string;
      expiresAt: string;
    };
  },
  status: 200 | 201
) {
  const verificationUrl = buildVerifyEmailUrl(c, args.verification.raw);
  const exposeToken = exposesDevelopmentTokens(c.env);

  return ok(
    c,
    {
      user: args.user,
      workspace: args.workspace,
      email_verification_required: true,
      email_verification_expires_at: args.verification.expiresAt,
      verification_url: exposeToken ? verificationUrl : undefined,
      verification_token: exposeToken ? args.verification.raw : undefined,
    },
    status
  );
}

async function findOwnedWorkspace(db: D1Database, userId: string) {
  return db
    .prepare(
      `SELECT id, slug, name
       FROM workspaces
       WHERE created_by_user_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 1`
    )
    .bind(userId)
    .first<{ id: string; slug: string; name: string }>();
}

export function registerAuthRoutes(app: Hono<AppEnv>) {
  app.use('/v1/auth/*', async (c, next) => {
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    await next();
  });

  app.get('/accept-invite', (c) => {
    const nonce = credentialPageNonce(c);
    return c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Accept Todoless Invitation</title>
    <style nonce="${nonce}">
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
          <button id="claim-button" type="submit">Accept invitation</button>
        </form>
        <p id="status" class="muted"></p>
        <div id="result" hidden>
          <p><strong>Workspace:</strong> <span id="workspace-name"></span></p>
          <p><strong>User:</strong> <span id="user-email"></span></p>
          <pre id="api-key"></pre>
        </div>
      </div>
    </main>
    <script nonce="${nonce}">
      const inviteToken = new URLSearchParams(window.location.search).get('token') || '';
      const form = document.getElementById('claim-form');
      const button = document.getElementById('claim-button');
      const statusEl = document.getElementById('status');
      const resultEl = document.getElementById('result');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (button.disabled) return;
        button.disabled = true;
        statusEl.textContent = 'Claiming invitation...';
        resultEl.hidden = true;
        const displayName = document.getElementById('display_name').value.trim();
        const response = await fetch('/v1/auth/claim-invite', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            invite_token: inviteToken,
            display_name: displayName || undefined
          })
        }).catch(() => null);
        const payload = response && await response.json().catch(() => null);
        if (!payload || payload.success !== true) {
          statusEl.textContent = payload?.error?.message || 'Invitation claim failed';
          statusEl.className = 'error';
          button.disabled = false;
          return;
        }
        statusEl.textContent = 'Invitation accepted. This API key is shown once.';
        statusEl.className = 'muted';
        document.getElementById('workspace-name').textContent = payload.data.workspace.name;
        document.getElementById('user-email').textContent = payload.data.user.email;
        document.getElementById('api-key').textContent = payload.data.api_key;
        resultEl.hidden = false;
      });
    </script>
  </body>
</html>`);
  });

  app.get('/verify-email', (c) => {
    const nonce = credentialPageNonce(c);
    return c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Verify Todoless Email</title>
    <style nonce="${nonce}">
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: #f7f7f5; color: #161616; margin: 0; }
      main { max-width: 640px; margin: 48px auto; padding: 24px; }
      .card { background: #fff; border: 1px solid #ddd; border-radius: 16px; padding: 24px; box-shadow: 0 8px 24px rgba(0,0,0,0.06); }
      h1 { margin-top: 0; font-size: 28px; }
      p { line-height: 1.5; }
      button { width: 100%; padding: 12px 16px; border: 0; border-radius: 12px; background: #111; color: #fff; font: inherit; cursor: pointer; }
      pre { white-space: pre-wrap; word-break: break-word; background: #111; color: #f5f5f5; padding: 16px; border-radius: 12px; }
      .muted { color: #666; font-size: 14px; }
      .error { color: #9b1c1c; }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        <h1>Verify email</h1>
        <p>Verify your email to activate your Todoless account and reveal your personal API key.</p>
        <button id="verify-button" type="button">Verify email</button>
        <p id="status" class="muted"></p>
        <div id="result" hidden>
          <p><strong>Workspace:</strong> <span id="workspace-name"></span></p>
          <p><strong>User:</strong> <span id="user-email"></span></p>
          <pre id="api-key"></pre>
        </div>
      </div>
    </main>
    <script nonce="${nonce}">
      const verificationToken = new URLSearchParams(window.location.search).get('token') || '';
      const button = document.getElementById('verify-button');
      const statusEl = document.getElementById('status');
      const resultEl = document.getElementById('result');
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        statusEl.textContent = 'Verifying email...';
        resultEl.hidden = true;
        const response = await fetch('/v1/auth/verify-email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            verification_token: verificationToken
          })
        }).catch(() => null);
        const payload = response && await response.json().catch(() => null);
        if (!payload || payload.success !== true) {
          statusEl.textContent = payload?.error?.message || 'Email verification failed';
          statusEl.className = 'error';
          button.disabled = false;
          return;
        }
        statusEl.textContent = 'Email verified. This API key is shown once.';
        statusEl.className = 'muted';
        document.getElementById('workspace-name').textContent = payload.data.workspace.name;
        document.getElementById('user-email').textContent = payload.data.user.email;
        document.getElementById('api-key').textContent = payload.data.api_key;
        resultEl.hidden = false;
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

    if (!exposesDevelopmentTokens(c.env) && !isEmailDeliveryConfigured(c.env)) {
      return error(
        c,
        500,
        'SERVER_MISCONFIGURED',
        'Email verification delivery must be configured in production'
      );
    }

    const existingUser = await c.env.DB.prepare(
      'SELECT id, email_verified_at, display_name FROM users WHERE email = ? LIMIT 1'
    )
      .bind(email)
      .first<{
        id: string;
        email_verified_at: string | null;
        display_name: string | null;
      }>();

    if (existingUser?.email_verified_at) {
      return error(c, 409, 'EMAIL_EXISTS', 'Email is already registered');
    }

    if (existingUser) {
      const ownedWorkspace = await findOwnedWorkspace(c.env.DB, existingUser.id);
      if (!ownedWorkspace) {
        return error(c, 409, 'EMAIL_EXISTS', 'Email is already registered');
      }

      const verification = await issueEmailVerificationToken(c.env);
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE email_verification_tokens
           SET consumed_at = CURRENT_TIMESTAMP
           WHERE user_id = ? AND consumed_at IS NULL`
        ).bind(existingUser.id),
        c.env.DB.prepare(
          `INSERT INTO email_verification_tokens
           (id, user_id, token_prefix, token_hash, expires_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(
          verification.id,
          existingUser.id,
          verification.tokenPrefix,
          verification.tokenHash,
          verification.expiresAt
        ),
      ]);

      const verificationUrl = buildVerifyEmailUrl(c, verification.raw);
      queueEmailVerificationEmail(c, {
        email,
        displayName: existingUser.display_name,
        verificationUrl,
        expiresAt: verification.expiresAt,
      });

      return renderVerificationPendingResponse(
        c,
        {
          user: {
            id: existingUser.id,
            email,
            display_name: existingUser.display_name,
          },
          workspace: {
            id: ownedWorkspace.id,
            slug: ownedWorkspace.slug,
            name: ownedWorkspace.name,
            role: 'OWNER',
          },
          verification,
        },
        200
      );
    }

    const userId = newId('usr_');
    const workspaceId = newId('ws_');
    const membershipId = newId('mem_');
    const workspaceName = payload.workspace_name?.trim() || defaultWorkspaceName(email);
    const workspaceSlug = makeWorkspaceSlug(workspaceName);
    const verification = await issueEmailVerificationToken(c.env);

    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO users (id, email, display_name, email_verified_at) VALUES (?, ?, ?, ?)'
      ).bind(userId, email, displayName, null),
      c.env.DB.prepare(
        'INSERT INTO workspaces (id, slug, name, created_by_user_id) VALUES (?, ?, ?, ?)'
      ).bind(workspaceId, workspaceSlug, workspaceName, userId),
      c.env.DB.prepare(
        'INSERT INTO memberships (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)'
      ).bind(membershipId, workspaceId, userId, 'OWNER'),
      c.env.DB.prepare(
        `INSERT INTO email_verification_tokens
         (id, user_id, token_prefix, token_hash, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        verification.id,
        userId,
        verification.tokenPrefix,
        verification.tokenHash,
        verification.expiresAt
      ),
    ]);

    await writeAudit(c.env.DB, {
      workspaceId,
      actorUserId: userId,
      action: 'REGISTER',
      entityType: 'workspace',
      entityId: workspaceId,
      metadata: { email, email_verification_required: true },
    });

    const verificationUrl = buildVerifyEmailUrl(c, verification.raw);
    queueEmailVerificationEmail(c, {
      email,
      displayName,
      verificationUrl,
      expiresAt: verification.expiresAt,
    });

    return renderVerificationPendingResponse(
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
        verification,
      },
      201
    );
  });

  app.post('/v1/auth/verify-email', async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) {
      return body.response;
    }
    const parsed = verifyEmailSchema.safeParse(body.data);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }

    const rawToken = parsed.data.verification_token.trim();
    const tokenPrefix = extractEmailVerificationPrefix(rawToken);
    if (!tokenPrefix) {
      return error(c, 401, 'INVALID_VERIFICATION_TOKEN', 'Invalid verification token');
    }

    if (!c.env.API_KEY_PEPPER) {
      return error(c, 500, 'SERVER_MISCONFIGURED', 'API_KEY_PEPPER is required');
    }

    const record = await c.env.DB.prepare(
      `SELECT
         evt.id,
         evt.user_id,
         evt.token_hash,
         evt.expires_at,
         evt.consumed_at,
         u.email,
         u.display_name,
         u.email_verified_at
       FROM email_verification_tokens evt
       JOIN users u ON u.id = evt.user_id
       WHERE evt.token_prefix = ?
       LIMIT 1`
    )
      .bind(tokenPrefix)
      .first<{
        id: string;
        user_id: string;
        token_hash: string;
        expires_at: string;
        consumed_at: string | null;
        email: string;
        display_name: string | null;
        email_verified_at: string | null;
      }>();

    if (!record) {
      return error(c, 401, 'INVALID_VERIFICATION_TOKEN', 'Invalid verification token');
    }

    if (record.consumed_at) {
      return error(
        c,
        409,
        'VERIFICATION_TOKEN_ALREADY_USED',
        'Verification token has already been used'
      );
    }

    if (Date.parse(record.expires_at) <= Date.now()) {
      return error(c, 409, 'VERIFICATION_TOKEN_EXPIRED', 'Verification token has expired');
    }

    const incomingHash = await hashApiKey(rawToken, c.env.API_KEY_PEPPER);
    if (incomingHash !== record.token_hash) {
      return error(c, 401, 'INVALID_VERIFICATION_TOKEN', 'Invalid verification token');
    }

    if (record.email_verified_at) {
      return error(c, 409, 'EMAIL_ALREADY_VERIFIED', 'Email is already verified');
    }

    const workspace = await findOwnedWorkspace(c.env.DB, record.user_id);
    if (!workspace) {
      return error(c, 409, 'EMAIL_VERIFICATION_INVALID', 'Verification no longer points to a workspace');
    }

    const apiKey = await issueApiKey(c.env, {
      name: 'Default Personal Key',
      scopes: PERSONAL_API_KEY_SCOPES,
    });

    // Recheck the token and unverified identity inside the write transaction.
    // Only a request that inserts its unique key may verify, consume, or audit.
    const [issuedKey] = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO api_keys
         (id, workspace_id, created_by_user_id, name, key_prefix, key_hash, scopes_json, expires_at)
         SELECT ?, NULL, evt.user_id, ?, ?, ?, ?, NULL
         FROM email_verification_tokens evt
         JOIN users u ON u.id = evt.user_id
         JOIN workspaces w ON w.id = ? AND w.created_by_user_id = u.id
         WHERE evt.id = ? AND evt.token_hash = ? AND evt.consumed_at IS NULL
           AND julianday(evt.expires_at) > julianday('now') AND u.email_verified_at IS NULL`
      ).bind(
        apiKey.id,
        apiKey.name,
        apiKey.keyPrefix,
        apiKey.keyHash,
        JSON.stringify(apiKey.scopes),
        workspace.id,
        record.id,
        incomingHash
      ),
      c.env.DB.prepare(
        `UPDATE users
         SET email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND EXISTS (SELECT 1 FROM api_keys WHERE id = ?)`
      ).bind(record.user_id, apiKey.id),
      c.env.DB.prepare(
        `UPDATE email_verification_tokens
         SET consumed_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND consumed_at IS NULL
           AND EXISTS (SELECT 1 FROM api_keys WHERE id = ?)`
      ).bind(record.user_id, apiKey.id),
      c.env.DB.prepare(
        `INSERT INTO audit_logs
         (id, workspace_id, actor_user_id, action, entity_type, entity_id, metadata_json)
         SELECT ?, ?, ?, 'VERIFY_EMAIL', 'user', ?, ?
         WHERE EXISTS (SELECT 1 FROM api_keys WHERE id = ?)`
      ).bind(
        newId('audit_'),
        workspace.id,
        record.user_id,
        record.user_id,
        JSON.stringify({ key_prefix: apiKey.keyPrefix }),
        apiKey.id
      ),
    ]);

    if (issuedKey.meta.changes !== 1) {
      return error(c, 409, 'EMAIL_VERIFICATION_INVALID', 'Verification token or user is no longer eligible');
    }

    queueWelcomeEmail(c, {
      email: record.email,
      displayName: record.display_name,
      workspaceName: workspace.name,
    });

    return ok(
      c,
      {
        user: {
          id: record.user_id,
          email: record.email,
          display_name: record.display_name,
          email_verified_at: new Date().toISOString(),
        },
        workspace: {
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          role: 'OWNER',
        },
        api_key: apiKey.raw,
        api_key_prefix: apiKey.keyPrefix,
        api_key_scopes: apiKey.scopes,
      },
      201
    );
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

    const incomingHash = await hashInviteToken(payload.invite_token.trim(), c.env.API_KEY_PEPPER);
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

    // The insert rechecks invitation validity inside the same transaction as
    // consumption. Only the request that inserts its unique key may mutate the
    // user or write an audit event; concurrent replays insert zero rows.
    const [issuedKey] = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO api_keys
         (id, workspace_id, created_by_user_id, name, key_prefix, key_hash, scopes_json, expires_at)
         SELECT ?, NULL, mi.user_id, ?, ?, ?, ?, NULL
         FROM member_invites mi
         JOIN users u ON u.id = mi.user_id AND u.email = mi.email
         JOIN workspaces w ON w.id = mi.workspace_id
         JOIN memberships m ON m.workspace_id = mi.workspace_id AND m.user_id = mi.user_id
         WHERE mi.id = ? AND mi.token_hash = ? AND mi.claimed_at IS NULL
           AND julianday(mi.expires_at) > julianday('now') AND w.deleted_at IS NULL`
      ).bind(
        apiKey.id,
        apiKey.name,
        apiKey.keyPrefix,
        apiKey.keyHash,
        JSON.stringify(apiKey.scopes),
        invite.id,
        incomingHash
      ),
      c.env.DB.prepare(
        `UPDATE member_invites
         SET claimed_at = CURRENT_TIMESTAMP
         WHERE id = ? AND EXISTS (SELECT 1 FROM api_keys WHERE id = ?)`
      ).bind(invite.id, apiKey.id),
      c.env.DB.prepare(
        `UPDATE users
         SET display_name = ?, email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND EXISTS (SELECT 1 FROM api_keys WHERE id = ?)`
      ).bind(nextDisplayName, invite.user_id, apiKey.id),
      c.env.DB.prepare(
        `INSERT INTO audit_logs
         (id, workspace_id, actor_user_id, action, entity_type, entity_id, metadata_json)
         SELECT ?, ?, ?, 'CLAIM_MEMBER_INVITE', 'membership', ?, ?
         WHERE EXISTS (SELECT 1 FROM api_keys WHERE id = ?)`
      ).bind(
        newId('audit_'),
        invite.workspace_id,
        invite.user_id,
        `${invite.workspace_id}:${invite.user_id}`,
        JSON.stringify({ invite_id: invite.id, key_prefix: apiKey.keyPrefix }),
        apiKey.id
      ),
    ]);

    if (issuedKey.meta.changes !== 1) {
      return error(c, 409, 'INVITE_NO_LONGER_VALID', 'Invite has already been claimed or is no longer valid');
    }

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
