import type { Context } from 'hono';
import type { AppEnv, EnvBindings } from '../lib/types';

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

export function resolveAppBaseUrl(c: Context<AppEnv>): string {
  const configured = c.env.APP_BASE_URL?.trim();
  if (configured) {
    return trimTrailingSlash(configured);
  }
  return trimTrailingSlash(new URL(c.req.url).origin);
}

export function buildAcceptInviteUrl(c: Context<AppEnv>, inviteToken: string): string {
  const url = new URL(`${resolveAppBaseUrl(c)}/accept-invite`);
  url.searchParams.set('token', inviteToken);
  return url.toString();
}

export function buildVerifyEmailUrl(c: Context<AppEnv>, verificationToken: string): string {
  const url = new URL(`${resolveAppBaseUrl(c)}/verify-email`);
  url.searchParams.set('token', verificationToken);
  return url.toString();
}

export function isEmailDeliveryConfigured(env: EnvBindings): boolean {
  return Boolean(env.RESEND_API_KEY?.trim() && env.RESEND_FROM_EMAIL?.trim());
}

async function sendResendEmail(
  c: Context<AppEnv>,
  payload: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }
) {
  const apiKey = c.env.RESEND_API_KEY?.trim();
  const from = c.env.RESEND_FROM_EMAIL?.trim();
  if (!apiKey || !from) {
    return { sent: false, skipped: true as const };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [payload.to],
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      reply_to: c.env.RESEND_REPLY_TO_EMAIL?.trim() || undefined,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Resend error ${response.status}: ${body}`);
  }

  return { sent: true as const, skipped: false as const };
}

export function queueWelcomeEmail(
  c: Context<AppEnv>,
  args: {
    email: string;
    displayName?: string | null;
    workspaceName: string;
  }
) {
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const name = args.displayName?.trim() || args.email;
        const appUrl = resolveAppBaseUrl(c);
        await sendResendEmail(c, {
          to: args.email,
          subject: `Welcome to Todoless`,
          text:
            `Hi ${name},\n\n` +
            `Your Todoless access is ready for workspace "${args.workspaceName}".\n` +
            `Open: ${appUrl}\n\n` +
            `If you registered via API, keep your personal API key secure.\n`,
          html:
            `<p>Hi ${escapeHtml(name)},</p>` +
            `<p>Your Todoless access is ready for workspace <strong>${escapeHtml(args.workspaceName)}</strong>.</p>` +
            `<p><a href="${escapeHtml(appUrl)}">Open Todoless</a></p>` +
            `<p>If you registered via API, keep your personal API key secure.</p>`,
        });
      } catch (err) {
        console.error('Welcome email failed', err);
      }
    })()
  );
}

export function queueEmailVerificationEmail(
  c: Context<AppEnv>,
  args: {
    email: string;
    displayName?: string | null;
    verificationUrl: string;
    expiresAt: string;
  }
) {
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const name = args.displayName?.trim() || args.email;
        const expiresAtLabel = new Date(args.expiresAt).toUTCString();
        await sendResendEmail(c, {
          to: args.email,
          subject: 'Verify your Todoless email',
          text:
            `Hi ${name},\n\n` +
            `Verify your Todoless email address to activate your account and receive your personal API key.\n\n` +
            `Verify email: ${args.verificationUrl}\n\n` +
            `This link expires on ${expiresAtLabel}.\n`,
          html:
            `<p>Hi ${escapeHtml(name)},</p>` +
            `<p>Verify your Todoless email address to activate your account and receive your personal API key.</p>` +
            `<p><a href="${escapeHtml(args.verificationUrl)}">Verify email</a></p>` +
            `<p>This link expires on ${escapeHtml(expiresAtLabel)}.</p>`,
        });
      } catch (err) {
        console.error('Email verification delivery failed', err);
      }
    })()
  );
}

export function queueInviteEmail(
  c: Context<AppEnv>,
  args: {
    email: string;
    workspaceName: string;
    inviterEmail: string;
    inviteUrl: string;
  }
) {
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await sendResendEmail(c, {
          to: args.email,
          subject: `You're invited to ${args.workspaceName} on Todoless`,
          text:
            `You've been invited to join "${args.workspaceName}" on Todoless by ${args.inviterEmail}.\n\n` +
            `Accept invitation: ${args.inviteUrl}\n`,
          html:
            `<p>You've been invited to join <strong>${escapeHtml(args.workspaceName)}</strong> on Todoless by ${escapeHtml(args.inviterEmail)}.</p>` +
            `<p><a href="${escapeHtml(args.inviteUrl)}">Accept invitation</a></p>`,
        });
      } catch (err) {
        console.error('Invite email failed', err);
      }
    })()
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
