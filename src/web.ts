export function renderApp(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unfold</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #16201b;
      --muted: #62706a;
      --line: #d8dfda;
      --paper: #fbfcfa;
      --panel: #ffffff;
      --accent: #146f63;
      --warn: #8a5a00;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body { margin: 0; background: var(--paper); color: var(--ink); }
    header { border-bottom: 1px solid var(--line); background: var(--panel); }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 24px; }
    .top { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
    h1 { font-size: clamp(28px, 4vw, 48px); line-height: 1; margin: 44px 0 14px; letter-spacing: 0; }
    h2 { font-size: 18px; margin: 0 0 12px; }
    p { color: var(--muted); line-height: 1.55; max-width: 760px; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin: 24px 0; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; min-height: 130px; }
    .band { border-top: 1px solid var(--line); margin-top: 20px; padding: 28px 0; }
    label { display: block; font-size: 13px; color: var(--muted); margin: 12px 0 6px; }
    input, textarea, select { width: 100%; box-sizing: border-box; border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; font: inherit; background: white; }
    textarea { min-height: 90px; resize: vertical; }
    button { border: 0; border-radius: 6px; padding: 10px 14px; background: var(--accent); color: white; font-weight: 650; cursor: pointer; }
    button.secondary { background: #e8efeb; color: var(--ink); }
    code, pre { background: #eef3ef; border-radius: 6px; }
    pre { padding: 14px; overflow: auto; white-space: pre-wrap; }
    .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
    .status { color: var(--warn); font-weight: 650; }
    @media (max-width: 760px) {
      .grid, .cols { grid-template-columns: 1fr; }
      .wrap { padding: 18px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap top">
      <strong>Unfold</strong>
      <span>Agent-native task board</span>
    </div>
  </header>
  <main class="wrap">
    <h1>Unfold</h1>
    <p>Set direction in the browser, give Codex a project URL, and let the Agent plan and execute work through a Rare-authenticated CLI. The Web app stays read-only for normal tasks and only gates version acceptance.</p>
    <section class="grid" aria-label="Operating model">
      <article class="card"><h2>Human</h2><p>Signs in, creates the project shell, binds the Agent public key, observes progress, and approves or requests changes at the version gate.</p></article>
      <article class="card"><h2>Agent</h2><p>Authenticates with Rare, creates context and tasks, works through Codex automation, attaches artifacts, and stops at human acceptance.</p></article>
      <article class="card"><h2>CLI</h2><p>The <code>unfold</code> CLI is the write interface for task bundles, status updates, artifacts, decisions, and follow-up tasks.</p></article>
    </section>
    <section class="band cols">
      <form id="signup" class="card">
        <h2>Create account</h2>
        <label>Email</label><input name="email" type="email" required>
        <label>Password</label><input name="password" type="password" required>
        <label>Handle</label><input name="handle" placeholder="sid">
        <button>Create session</button>
      </form>
      <form id="project" class="card">
        <h2>Create project shell</h2>
        <label>Slug</label><input name="slug" placeholder="sid/my-product" required>
        <label>Name</label><input name="name" placeholder="My Product" required>
        <label>Repository URL</label><input name="repo_url" placeholder="https://github.com/sid/my-product">
        <button>Create project URL</button>
      </form>
    </section>
    <section class="band cols">
      <form id="bind" class="card">
        <h2>Bind Agent Rare identity</h2>
        <label>Project slug</label><input name="slug" placeholder="sid/my-product" required>
        <label>Rare Agent public key</label><input name="rare_agent_id" placeholder="ed25519-public-key" required>
        <button>Bind Lead Agent</button>
        <p>If the Agent has no Rare identity, ask Codex to read <code>https://www.rareid.cc/skill.md</code> and register first.</p>
      </form>
      <div class="card">
        <h2>Start in Codex</h2>
        <pre id="prompt">Use unfold for https://unfold.example.com/sid/my-product.
Initialize this project, brainstorm the product and first version with me, then create the initial plan and tasks.</pre>
        <button class="secondary" id="copy" type="button">Copy prompt</button>
      </div>
    </section>
    <section class="band">
      <h2>Automation prompts</h2>
      <div class="grid">
        <article class="card"><strong>General worker</strong><p>Work on the next executable non-human task. Verify, attach artifacts, create follow-ups, stop at human acceptance.</p></article>
        <article class="card"><strong>Design worker</strong><p>Work only on design tasks and load project design context before changing UI direction.</p></article>
        <article class="card"><strong>Test/docs/marketing</strong><p>Use typed filters to keep recurring automations focused near validation and release.</p></article>
      </div>
    </section>
    <p id="result" class="status" role="status"></p>
  </main>
  <script>
    const result = document.getElementById("result");
    async function post(path, body) {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Request failed");
      return data;
    }
    document.getElementById("signup").addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(event.currentTarget));
      const data = await post("/api/auth/signup", body).catch((error) => ({ error: error.message }));
      result.textContent = data.error || "Signed in as " + data.account.handle;
    });
    document.getElementById("project").addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(event.currentTarget));
      const data = await post("/api/projects", body).catch((error) => ({ error: error.message }));
      result.textContent = data.error || "Created " + data.project.slug;
      if (data.project) document.getElementById("prompt").textContent = "Use unfold for " + location.origin + "/" + data.project.slug + ".\\nInitialize this project, brainstorm the product and first version with me, then create the initial plan and tasks.";
    });
    document.getElementById("bind").addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(event.currentTarget));
      const slug = body.slug;
      delete body.slug;
      const data = await post("/api/" + slug + "/agents/bind", body).catch((error) => ({ error: error.message }));
      result.textContent = data.error || "Bound Agent " + data.agent_id;
    });
    document.getElementById("copy").addEventListener("click", () => navigator.clipboard.writeText(document.getElementById("prompt").textContent));
  </script>
</body>
</html>`;
}
