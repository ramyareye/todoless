// Static public content only. Keep account data and credentials out of this page.
export const homePage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#101310">
  <title>Todoless - Task backend. HTTP + MCP.</title>
  <meta name="description" content="A task backend for small teams and side projects. Tasks, dependencies, review and weekly hours through HTTP, MCP or HopKit. A HipHop.dev product.">
  <meta property="og:title" content="Todoless - Task backend. HTTP + MCP.">
  <meta property="og:description" content="A shared task queue for a few projects and a few people. Open source. Early pilot. By HipHop.dev.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://todoless.dev/">
  <link rel="canonical" href="https://todoless.dev/">
  <link rel="stylesheet" href="/homepage.css">
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header wrap">
    <a class="wordmark" href="/" aria-label="Todoless home"><span aria-hidden="true">~/</span>todoless</a>
    <nav aria-label="Main navigation">
      <a href="#interface">api</a>
      <a href="#scope">features</a>
      <a href="https://github.com/ramyareye/todoless">source <span aria-hidden="true">&nearr;</span></a>
    </nav>
  </header>
  <main id="main" class="wrap">
    <section class="hero" aria-labelledby="hero-title">
      <p class="file-label"><span aria-hidden="true">#</span> README <span class="pilot">[early pilot]</span></p>
      <h1 id="hero-title">todoless<span class="cursor" aria-hidden="true">_</span></h1>
      <p class="subtitle">Task backend. HTTP + MCP.</p>
      <p class="intro">A shared queue for small teams and side projects. Tasks, dependencies, review and weekly hours.</p>
      <p class="context">Use <a href="https://hopkit.hiphop.dev/delivery">HopKit</a> in a browser, or bring your own tools. Todoless keeps the task state.</p>
      <div class="hero-actions">
        <a class="primary-link" href="https://hopkit.hiphop.dev/delivery"><span aria-hidden="true">&gt;</span> Open HopKit <span aria-hidden="true">&nearr;</span></a>
        <a href="https://github.com/ramyareye/todoless">Browse source <span aria-hidden="true">&nearr;</span></a>
      </div>
      <p class="comment">// Hosted access is a small pilot. Existing accounts required.</p>
    </section>

    <section id="interface" class="section" aria-labelledby="interface-title">
      <h2 id="interface-title"><span class="section-number" aria-hidden="true">01</span>Read your queue</h2>
      <p>Personal API key. Workspace permissions. Your assignments by default.</p>
      <div class="code-panel">
        <div class="code-label"><span>HTTP / curl</span><span>GET</span></div>
        <pre aria-label="Example curl request"><code><span class="code-command">curl</span> --fail-with-body \\
  <span class="code-string">"https://todoless.dev/v1/workspaces/<wbr>$WORKSPACE_ID/<wbr>delivery/queue"</span> \\
  -H <span class="code-string">"Authorization: Bearer $TODOLESS_API_KEY"</span></code></pre>
        <div class="mcp-example"><span>MCP tool</span><code>delivery.queue({ workspace_id })</code></div>
      </div>
      <p class="code-note">Set the two shell variables to your own workspace ID and personal key. The MCP line shows the tool and its arguments.</p>
      <div class="docs-links">
        <a href="https://github.com/ramyareye/todoless/blob/main/apps/api/README.md">API docs <span aria-hidden="true">&nearr;</span></a>
        <a href="https://github.com/ramyareye/todoless/blob/main/apps/mcp-server/README.md">MCP setup <span aria-hidden="true">&nearr;</span></a>
      </div>
    </section>

    <section id="scope" class="section" aria-labelledby="scope-title">
      <h2 id="scope-title"><span class="section-number" aria-hidden="true">02</span>What's implemented</h2>
      <dl class="feature-list">
        <div><dt>queue</dt><dd>One active task per person in a workspace. Up to two Ready alternatives across projects. Stable task IDs and assignees.</dd></div>
        <div><dt>handoffs</dt><dd>Dependencies, blocker notes, Review and Verify steps. Returned work keeps the reason.</dd></div>
        <div><dt>hours</dt><dd>Manual time entries. One weekly submission across projects. Owner approval and CSV export. Submitted and approved hours stay separate.</dd></div>
        <div><dt>history</dt><dd>Version checks on writes and an audit trail. Progress notes stay with the task when you pause and resume.</dd></div>
      </dl>
      <p class="comment">// Hours are records, not invoices. Payments stay manual.</p>
    </section>

    <section class="section project-notes" aria-labelledby="notes-title">
      <h2 id="notes-title"><span class="section-number" aria-hidden="true">03</span>Project notes</h2>
      <p>We're building this for our own projects and collaborations. Plans kept getting buried in chat. We wanted a shared queue we could also use from scripts and assistants.</p>
      <p>Task delivery and weekly hours are being tested with a small team. Public browser signup isn't available yet. Setup instructions are in the repo.</p>
      <dl class="project-meta">
        <div><dt>stack</dt><dd>TypeScript / Hono / Cloudflare Workers / D1</dd></div>
        <div><dt>license</dt><dd><a href="https://github.com/ramyareye/todoless/blob/main/LICENSE">Apache-2.0</a></dd></div>
        <div><dt>bugs</dt><dd><a href="https://github.com/ramyareye/todoless/issues">Open an issue</a> with what you tried and what happened.</dd></div>
      </dl>
    </section>
  </main>
  <footer class="site-footer wrap"><p>todoless <span aria-hidden="true">/</span> a <a href="https://hiphop.dev/">HipHop.dev</a> product</p><a href="https://github.com/ramyareye/todoless">ramyareye/todoless <span aria-hidden="true">&nearr;</span></a></footer>
</body>
</html>`;

export const homeStyles = `
:root {
  color-scheme: dark;
  --bg: #101310;
  --panel: #151b16;
  --ink: #dce4db;
  --muted: #9aa996;
  --line: #344032;
  --accent: #b6e88b;
  --amber: #dfbd7d;
  --mono: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
}
* { box-sizing: border-box; }
html { scroll-padding-top: 24px; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.85 var(--mono); -webkit-font-smoothing: antialiased; }
::selection { background: var(--accent); color: var(--bg); }
a { color: var(--accent); text-underline-offset: 4px; text-decoration-thickness: 1px; }
a:hover { color: #e1ffc8; }
a:focus-visible { outline: 2px solid var(--amber); outline-offset: 5px; }
h1, h2, p { margin-top: 0; }
code { font-family: inherit; }
.wrap { width: min(900px, calc(100% - 96px)); margin-inline: auto; }
.skip-link { position: absolute; left: 16px; top: -80px; background: var(--accent); color: var(--bg); padding: 10px 18px; z-index: 2; }
.skip-link:focus { top: 12px; }
.site-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding-block: 24px; border-bottom: 1px solid var(--line); font-size: 12px; }
.wordmark { color: var(--ink); text-decoration: none; }
.wordmark>span { color: var(--muted); }
.site-header nav { display: flex; align-items: center; gap: 27px; }
.site-header nav a { color: var(--muted); padding-block: 7px; text-decoration: none; }
.site-header nav a:hover { color: var(--accent); text-decoration: underline; }
.hero { padding-block: 46px 35px; }
.file-label { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 11px; letter-spacing: .6px; margin-bottom: 22px; }
.file-label>span:first-child { color: var(--accent); }
.pilot { color: var(--amber); margin-left: auto; letter-spacing: 0; }
h1 { font-size: clamp(45px, 7vw, 76px); line-height: 1.1; font-weight: 500; letter-spacing: -5px; margin-bottom: 17px; }
.cursor { color: var(--accent); }
.subtitle { color: var(--accent); font-size: 18px; margin-bottom: 23px; }
.intro { max-width: 650px; margin-bottom: 8px; }
.context { max-width: 700px; color: var(--muted); margin-bottom: 25px; }
.hero-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 28px; margin-bottom: 22px; font-size: 13px; }
.primary-link { display: inline-flex; align-items: center; gap: 14px; padding: 9px 16px; border: 1px solid var(--accent); text-decoration: none; }
.primary-link:hover { background: var(--accent); color: var(--bg); }
.comment { color: var(--muted); font-size: 11px; margin: 0; }
.section { border-top: 1px solid var(--line); padding-block: 29px 32px; }
h2 { display: flex; align-items: baseline; gap: 16px; font-size: 15px; font-weight: 500; margin-bottom: 14px; }
.section-number { color: var(--accent); font-size: 11px; }
.section>p { color: var(--muted); max-width: 780px; }
.code-panel { background: var(--panel); border: 1px solid var(--line); margin-top: 21px; }
.code-label { display: flex; justify-content: space-between; padding: 9px 18px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 10px; }
.code-label>span:last-child { color: var(--accent); }
pre { margin: 0; padding: 20px 18px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/2 var(--mono); }
.code-command { color: var(--amber); }
.code-string { color: var(--accent); }
.mcp-example { display: flex; align-items: baseline; flex-wrap: wrap; gap: 12px 24px; border-top: 1px dashed var(--line); padding: 11px 18px; font-size: 12px; }
.mcp-example>span { color: var(--muted); font-size: 10px; }
.mcp-example code { overflow-wrap: anywhere; }
.code-note { font-size: 11px; margin: 12px 0 18px; }
.docs-links { display: flex; flex-wrap: wrap; gap: 26px; font-size: 12px; }
.feature-list { margin: 20px 0 22px; }
.feature-list>div { display: grid; grid-template-columns: 105px 1fr; gap: 20px; padding-block: 13px; border-top: 1px dashed var(--line); }
.feature-list>div:first-child { padding-top: 0; border-top: 0; }
.feature-list dt { color: var(--accent); font-size: 12px; }
.feature-list dd { margin: 0; color: var(--muted); font-size: 13px; }
.project-notes>p { font-size: 13px; margin-bottom: 16px; }
.project-meta { display: grid; gap: 8px; margin: 25px 0 0; font-size: 11px; }
.project-meta>div { display: grid; grid-template-columns: 105px 1fr; gap: 20px; }
.project-meta dt { color: var(--muted); }
.project-meta dd { margin: 0; }
.site-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-top: 1px solid var(--line); padding-block: 22px 34px; color: var(--muted); font-size: 10px; }
.site-footer p { margin: 0; }
.site-footer p>span { margin-inline: 7px; }
@media (max-width: 600px) {
  .wrap { width: calc(100% - 40px); }
  body { font-size: 13px; }
  .site-header { padding-block: 17px; gap: 15px; font-size: 11px; }
  .site-header nav { gap: 15px; }
  .hero { padding-block: 30px; }
  h1 { font-size: 50px; letter-spacing: -3px; }
  .subtitle { font-size: 15px; margin-bottom: 19px; }
  .file-label { font-size: 10px; }
  .hero-actions { gap: 23px; font-size: 12px; }
  .primary-link { padding: 8px 12px; gap: 10px; }
  .comment { font-size: 10px; }
  .section { padding-block: 24px; }
  h2 { font-size: 14px; gap: 12px; }
  pre { padding: 15px 12px; font-size: 11px; }
  .code-label, .mcp-example { padding-inline: 12px; }
  .mcp-example { font-size: 11px; gap: 4px 18px; }
  .feature-list>div { grid-template-columns: 1fr; gap: 4px; }
  .feature-list dd { font-size: 12px; }
  .project-notes>p { font-size: 12px; }
  .project-meta>div { grid-template-columns: 60px 1fr; gap: 15px; }
  .site-footer { flex-direction: column; align-items: start; gap: 8px; }
}
@media (max-width: 360px) {
  .wrap { width: calc(100% - 32px); }
  .site-header nav { gap: 11px; font-size: 10px; }
  .hero-actions { gap: 17px; font-size: 11px; }
}
`;
