// Only a server-generated nonce is interpolated. All account/key data is rendered
// as text/value properties. Tokens/keys stay in this page's memory, never storage.
export function keyRecoveryPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Recover a personal key - Todoless</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body { margin: 0; background: #f7f7f5; color: #161616; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; }
    main { max-width: 560px; margin: 40px auto; padding: 20px; }
    .card { background: #fff; border: 1px solid #ddd; border-radius: 16px; padding: 24px; }
    h1 { margin-top: 0; font-size: 27px; line-height: 1.2; }
    label { display: block; font-weight: 600; margin: 16px 0 6px; }
    input, select, button, textarea { font: inherit; max-width: 100%; }
    input[type=email], select, textarea, button { width: 100%; padding: 12px; border-radius: 10px; }
    input, select, textarea { border: 1px solid #999; }
    select { white-space: normal; }
    button { margin-top: 14px; border: 0; background: #161616; color: #fff; cursor: pointer; }
    button:disabled { opacity: .55; cursor: default; }
    fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
    .choice { font-weight: 400; display: flex; gap: 10px; align-items: flex-start; }
    .choice input { flex-shrink: 0; margin-top: 6px; }
    .muted { color: #555; font-size: 14px; overflow-wrap: anywhere; }
    .error { color: #9b1c1c; }
    #account, #key-details { overflow-wrap: anywhere; }
    textarea { font-family: ui-monospace, monospace; overflow-wrap: anywhere; min-height: 110px; }
    :focus-visible { outline: 3px solid #3567b0; outline-offset: 3px; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
<main><div class="card">
  <h1>Recover a personal key</h1>
  <p>Your projects, tasks and access stay as they are. This creates a replacement for one personal key.</p>
  <section id="request-section">
    <form id="request-form" method="post" action="/v1/auth/key-recovery/request">
      <fieldset id="request-fields">
        <label for="email">Your Todoless email</label>
        <input id="email" name="email" type="email" autocomplete="email" maxlength="254" required />
        <button id="request-button" type="submit" disabled>Email me a recovery link</button>
      </fieldset>
    </form>
    <p class="muted">The link lasts 15 minutes. Use the newest recovery email. Nothing changes until you choose a key and confirm.</p>
  </section>
  <section id="proof-section" hidden>
    <p>Check this email link to see the personal keys you can replace.</p>
    <button id="inspect-button" type="button">Check recovery link</button>
    <p id="account"></p>
    <form id="complete-form" method="post" action="/v1/auth/key-recovery/complete" hidden>
      <fieldset id="complete-fields">
        <label for="key-id">Key to replace</label>
        <select id="key-id" name="key_id" required></select>
        <p id="key-details" class="muted"></p>
        <label class="choice" for="revoke-old"><input id="revoke-old" type="checkbox" /><span>Also revoke this old key. Connections using it will stop working.</span></label>
        <p class="muted">Leave this unchecked to keep existing connections working. The replacement keeps the same permissions and expiry.</p>
        <button id="complete-button" type="submit" disabled>Create replacement key</button>
      </fieldset>
    </form>
  </section>
  <section id="result" hidden>
    <label for="new-key">Your replacement key</label>
    <textarea id="new-key" readonly spellcheck="false" autocomplete="off"></textarea>
    <button id="copy-button" type="button">Copy key</button>
    <p class="muted">Save it privately before closing this page. It is shown only once. Never paste it into a chat.</p>
  </section>
  <p id="status" role="status" aria-live="polite" aria-atomic="true"></p>
  <p id="script-help">Enable JavaScript to use recovery. No key has been created.</p>
  <p class="muted"><a href="/">Todoless</a></p>
</div></main>
<script nonce="${nonce}">
  const el = (id) => document.getElementById(id);
  let recoveryToken = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
  window.history.replaceState(null, '', window.location.pathname);
  const statusEl = el('status');
  let choices = [];
  let pageActive = true;
  const message = (text, failed = false) => { statusEl.className = failed ? 'error' : 'muted'; statusEl.textContent = text; };
  window.addEventListener('pagehide', () => {
    pageActive = false; recoveryToken = ''; choices = [];
    el('new-key').value = ''; el('result').hidden = true;
    el('account').textContent = ''; el('complete-form').hidden = true;
    el('proof-section').hidden = true; el('request-section').hidden = false;
    message('Request a fresh recovery email to continue.');
  });
  // An email app may reuse this tab. A new fragment must start a fresh page
  // lifecycle; it still does not inspect or consume the link automatically.
  window.addEventListener('hashchange', () => {
    if (new URLSearchParams(window.location.hash.slice(1)).get('token')) window.location.reload();
  });
  const call = async (action, body) => {
    const response = await fetch('/v1/auth/key-recovery/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    return { response, payload };
  };
  el('request-button').disabled = false;
  if (recoveryToken) { el('request-section').hidden = true; el('proof-section').hidden = false; }
  el('request-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (el('request-button').disabled || !el('request-form').reportValidity()) return;
    el('request-button').disabled = true; el('request-fields').disabled = true;
    message('Requesting a recovery email...');
    try {
      const { response, payload } = await call('request', { email: el('email').value.trim() });
      if (response.ok && payload?.success === true) message('If a verified account exists for this email, a recovery link will be sent. Check your inbox and spam folder.');
      else message(response.status === 429 ? 'Too many attempts. Please wait before requesting another link.' : 'Could not request recovery. Check your email and try again later.', true);
    } catch { message('Could not reach Todoless. Check your inbox before trying again.', true); }
    finally { el('request-button').disabled = false; el('request-fields').disabled = false; }
  });
  el('inspect-button').addEventListener('click', async () => {
    if (el('inspect-button').disabled || !recoveryToken) return;
    el('inspect-button').disabled = true; message('Checking your recovery link...');
    try {
      const { response, payload } = await call('inspect', { recovery_token: recoveryToken });
      if (!pageActive) return;
      if (response.status === 429) { message('Too many link checks. Please wait before requesting a new recovery email.', true); return; }
      if (!response.ok || payload?.success !== true || !Array.isArray(payload.data?.keys)) throw new Error('Invalid recovery link');
      choices = payload.data.keys;
      el('account').textContent = 'Account: ' + String(payload.data.email);
      el('key-id').replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose the key you lost';
      el('key-id').appendChild(placeholder);
      for (const key of choices) { const option = document.createElement('option'); option.value = String(key.id); option.textContent = String(key.name) + ' (' + String(key.key_prefix) + ')'; el('key-id').appendChild(option); }
      el('inspect-button').hidden = true;
      if (!choices.length) { message('No active personal key is available to replace. Contact your workspace operator for help.', true); return; }
      el('complete-form').hidden = false; message('Choose one personal key. Nothing has been replaced yet.');
    } catch {
      recoveryToken = ''; el('request-section').hidden = false;
      message('This link could not be checked. It may be invalid, expired or already used. Request a new recovery email.', true);
    }
  });
  el('key-id').addEventListener('change', () => {
    const key = choices.find((k) => k.id === el('key-id').value);
    el('revoke-old').checked = false;
    el('complete-button').disabled = !key;
    el('key-details').textContent = key ? 'Permissions: ' + key.scopes.join(', ') + '. Expiry: ' + (key.expires_at || 'No expiry') + '.' : '';
  });
  el('complete-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (el('complete-button').disabled || !el('complete-form').reportValidity() || !recoveryToken) return;
    el('complete-button').disabled = true; el('complete-fields').disabled = true;
    message('Creating your replacement key...');
    try {
      const { response, payload } = await call('complete', { recovery_token: recoveryToken, key_id: el('key-id').value, revoke_old_key: el('revoke-old').checked });
      if (!pageActive) return;
      if (!response.ok || payload?.success !== true || typeof payload.data?.api_key !== 'string' || !payload.data.api_key) throw new Error('Recovery not confirmed');
      el('new-key').value = payload.data.api_key;
      el('complete-form').hidden = true; el('result').hidden = false;
      message(payload.data.revoked_old_key ? 'Replacement created. The selected old key was revoked.' : 'Replacement created. Your existing keys still work.');
    } catch {
      el('request-section').hidden = false;
      message('Recovery could not be confirmed. It may already have completed. Request a fresh email before trying again.', true);
    } finally { recoveryToken = ''; }
  });
  el('copy-button').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(el('new-key').value); message('Key copied. Save it somewhere private.'); }
    catch { el('new-key').focus(); el('new-key').select(); message('Select and copy the key, then save it privately.'); }
  });
  el('script-help').hidden = true;
</script>
</body></html>`;
}
