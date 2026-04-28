import { createHumanSession, createRareSession, getActor, HUMAN_COOKIE, requireAgentWrite, requireHuman } from "./auth";
import { hashPassword, randomId, sha256, verifyPassword } from "./crypto";
import { emitEvent } from "./events";
import {
  addSeconds,
  errorResponse,
  html,
  HttpError,
  json,
  methodNotAllowed,
  notFound,
  nowIso,
  optionalString,
  parseJsonArray,
  readJson,
  requireString,
  setCookie,
  splitPath,
  stringArray,
  type Actor,
  type Env
} from "./http";
import { renderApp } from "./web";

const DEFAULT_AGENT_CAPABILITIES = [
  "project:read",
  "context:read",
  "context:write",
  "task:read",
  "task:write",
  "artifact:write",
  "version:validate"
];

const FORBIDDEN_AGENT_CAPABILITIES = new Set([
  "human_acceptance:approve",
  "human_acceptance:request_changes",
  "project:delete",
  "agent:bind",
  "agent:revoke"
]);

interface ProjectRow {
  id: string;
  owner_account_id: string;
  slug: string;
  name: string;
  repo_url: string | null;
  default_branch: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  project_id: string;
  name: string;
  goal: string;
  status: string;
  scope_summary: string | null;
  acceptance_summary: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  version_id: string;
  area_id: string | null;
  function_id: string | null;
  type: string;
  status: string;
  title: string;
  goal: string;
  acceptance_json: string;
  priority: number;
  closable_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  area_slug?: string | null;
  function_slug?: string | null;
}

interface ContextRow {
  id: string;
  kind: string;
  stability: string;
  title: string;
  body: string;
  source_path: string | null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      return errorResponse(error);
    }
  }
};

export async function handleRequest(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
  const parts = splitPath(request);
  if (parts[0] !== "api") {
    if (request.method !== "GET") return methodNotAllowed();
    return html(renderApp());
  }

  const actor = await getActor(env, request);
  const api = parts.slice(1);

  if (api[0] === "auth") return handleHumanAuth(request, env, actor, api.slice(1));
  if (api[0] === "rare") return handleRareAuth(request, env, actor, api.slice(1));
  if (api[0] === "projects") return handleProjectCollection(request, env, actor);
  if (api[0] === "tasks" && api[1]) return handleTaskById(request, env, actor, api[1], api.slice(2));
  if (api.length >= 2) return handleProjectScoped(request, env, actor, api);

  return notFound();
}

async function handleHumanAuth(request: Request, env: Env, actor: Actor, parts: string[]): Promise<Response> {
  if (parts[0] === "signup" && request.method === "POST") {
    const body = await readJson(request);
    const email = requireString(body, "email").toLowerCase();
    const password = requireString(body, "password");
    const handle = (optionalString(body, "handle") ?? email.split("@")[0] ?? "user").toLowerCase();
    const accountId = randomId("acct");
    await env.DB.prepare(`INSERT INTO accounts (id, handle, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(accountId, handle, email, await hashPassword(password), nowIso())
      .run();
    const token = await createHumanSession(env, accountId);
    return json(
      { token, account: { id: accountId, handle, email } },
      { headers: { "set-cookie": setCookie(HUMAN_COOKIE, token, 60 * 60 * 24 * 14) } }
    );
  }

  if (parts[0] === "login" && request.method === "POST") {
    const body = await readJson(request);
    const email = requireString(body, "email").toLowerCase();
    const password = requireString(body, "password");
    const account = await env.DB.prepare(`SELECT * FROM accounts WHERE email = ?`).bind(email).first<{
      id: string;
      handle: string;
      email: string;
      password_hash: string;
    }>();
    if (!account || !(await verifyPassword(password, account.password_hash))) throw new HttpError(401, "Invalid credentials");
    const token = await createHumanSession(env, account.id);
    return json(
      { token, account: { id: account.id, handle: account.handle, email: account.email } },
      { headers: { "set-cookie": setCookie(HUMAN_COOKIE, token, 60 * 60 * 24 * 14) } }
    );
  }

  if (parts[0] === "logout" && request.method === "POST") {
    requireHuman(actor);
    await env.DB.prepare(`DELETE FROM human_sessions WHERE account_id = ?`).bind(actor.id).run();
    return json({ ok: true }, { headers: { "set-cookie": setCookie(HUMAN_COOKIE, "", 0) } });
  }

  if (parts[0] === "me" && request.method === "GET") {
    if (actor.type === "human") return json({ actor: "human", account: actor.account });
    if (actor.type === "agent") return json({ actor: "agent", agent_id: actor.id, capabilities: actor.capabilities });
    return json({ actor: "anonymous" });
  }

  return notFound();
}

async function handleRareAuth(request: Request, env: Env, actor: Actor, parts: string[]): Promise<Response> {
  if (parts[0] === "challenge" && request.method === "POST") {
    const body = await readJson(request);
    const projectSlug = requireString(body, "project_slug");
    const project = await requireProject(env, projectSlug);
    const nonce = randomId("nonce");
    const challengeId = randomId("chal");
    await env.DB.prepare(
      `INSERT INTO rare_challenges (id, nonce, project_id, rare_agent_id, audience, used_at, expires_at, created_at)
       VALUES (?, ?, ?, NULL, ?, NULL, ?, ?)`
    )
      .bind(challengeId, nonce, project.id, optionalString(body, "audience") ?? "unfold", addSeconds(300), nowIso())
      .run();
    await emitEvent(env, {
      projectId: project.id,
      actor,
      type: "rare.challenge_created",
      payload: { challenge_id: challengeId }
    });
    return json({ challenge_id: challengeId, nonce, project_slug: project.slug, expires_in: 300 });
  }

  if (parts[0] === "complete" && request.method === "POST") {
    const body = await readJson(request);
    const challengeId = requireString(body, "challenge_id");
    const nonce = requireString(body, "nonce");
    const agentId = requireString(body, "agent_id");
    const delegatedKeyId = requireString(body, "delegated_key_id");
    const authSubject = requireString(body, "auth_subject");
    const delegationSubject = requireString(body, "delegation_subject");
    const attestationSubject = requireString(body, "attestation_subject");
    if (authSubject !== agentId || delegationSubject !== agentId || attestationSubject !== agentId) {
      throw new HttpError(401, "Rare subject triad mismatch");
    }
    const challenge = await env.DB.prepare(`SELECT * FROM rare_challenges WHERE id = ? AND nonce = ?`)
      .bind(challengeId, nonce)
      .first<{ id: string; project_id: string; used_at: string | null; expires_at: string }>();
    if (!challenge) throw new HttpError(404, "Rare challenge not found");
    if (challenge.used_at) throw new HttpError(409, "Rare challenge already used");
    if (new Date(challenge.expires_at).getTime() <= Date.now()) throw new HttpError(410, "Rare challenge expired");
    const rareAgent = await getOrCreateRareAgent(env, agentId, optionalString(body, "display_name"));
    const grant = await env.DB.prepare(
      `SELECT * FROM project_agent_grants
       WHERE project_id = ? AND rare_agent_id = ? AND status = 'active' AND revoked_at IS NULL`
    )
      .bind(challenge.project_id, rareAgent.id)
      .first<{ capabilities_json: string }>();
    if (!grant) throw new HttpError(403, "Rare Agent is not bound to this project");
    await env.DB.prepare(`UPDATE rare_challenges SET used_at = ?, rare_agent_id = ? WHERE id = ?`)
      .bind(nowIso(), rareAgent.id, challenge.id)
      .run();
    const capabilities = parseJsonArray(grant.capabilities_json).filter((capability) => !FORBIDDEN_AGENT_CAPABILITIES.has(capability));
    const token = await createRareSession(env, {
      rareAgentId: rareAgent.id,
      projectId: challenge.project_id,
      delegatedKeyId,
      capabilities
    });
    await emitEvent(env, {
      projectId: challenge.project_id,
      actor: { type: "agent", id: agentId, session: {} as never, capabilities },
      type: "rare.session_created",
      payload: { delegated_key_id: delegatedKeyId }
    });
    return json({ token, agent_id: agentId, capabilities, expires_in: 3600 });
  }

  if (parts[0] === "session" && parts[1] === "refresh" && request.method === "POST") {
    if (actor.type !== "agent") throw new HttpError(401, "Rare Agent session required");
    const token = await createRareSession(env, {
      rareAgentId: actor.session.rare_agent_id,
      projectId: actor.session.project_id,
      delegatedKeyId: actor.session.delegated_key_id,
      capabilities: actor.capabilities
    });
    await env.DB.prepare(`UPDATE rare_sessions SET revoked_at = ? WHERE id = ?`).bind(nowIso(), actor.session.id).run();
    return json({ token, agent_id: actor.id, capabilities: actor.capabilities, expires_in: 3600 });
  }

  return notFound();
}

async function handleProjectCollection(request: Request, env: Env, actor: Actor): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  requireHuman(actor);
  const body = await readJson(request);
  const rawSlug = requireString(body, "slug").toLowerCase();
  const slug = rawSlug.includes("/") ? rawSlug : `${actor.account.handle}/${rawSlug}`;
  if (!slug.startsWith(`${actor.account.handle}/`)) throw new HttpError(403, "Project slug must belong to the signed-in account");
  const projectId = randomId("proj");
  await env.DB.prepare(
    `INSERT INTO projects (id, owner_account_id, slug, name, repo_url, default_branch, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'shell', ?, ?)`
  )
    .bind(
      projectId,
      actor.id,
      slug,
      requireString(body, "name"),
      optionalString(body, "repo_url") ?? optionalString(body, "repo"),
      optionalString(body, "default_branch") ?? "main",
      nowIso(),
      nowIso()
    )
    .run();
  await emitEvent(env, { projectId, actor, type: "project.created", payload: { slug } });
  return json({ project: await requireProject(env, slug) }, { status: 201 });
}

async function handleProjectScoped(request: Request, env: Env, actor: Actor, parts: string[]): Promise<Response> {
  const slug = `${parts[0]}/${parts[1]}`;
  const project = await requireProject(env, slug);
  await ensureCanReadProject(project, actor);
  const rest = parts.slice(2);

  if (rest.length === 0 && request.method === "GET") {
    return json({ project, versions: await listVersions(env, project.id), events: await listEvents(env, project.id) });
  }

  if (rest[0] === "versions") return handleVersions(request, env, actor, project, rest.slice(1));
  if (rest[0] === "agents") return handleAgents(request, env, actor, project, rest.slice(1));
  if (rest[0] === "areas") return handleAreas(request, env, actor, project, rest.slice(1));
  if (rest[0] === "context") return handleContext(request, env, actor, project);
  if (rest[0] === "decisions") return handleDecision(request, env, actor, project);
  if (rest[0] === "tasks") return handleTasks(request, env, actor, project, rest.slice(1));

  return notFound();
}

async function handleAgents(request: Request, env: Env, actor: Actor, project: ProjectRow, parts: string[]): Promise<Response> {
  if (request.method === "GET" && parts.length === 0) {
    const grants = await env.DB.prepare(
      `SELECT g.*, a.agent_id FROM project_agent_grants g JOIN rare_agents a ON a.id = g.rare_agent_id WHERE g.project_id = ?`
    )
      .bind(project.id)
      .all();
    return json({ agents: grants.results ?? [] });
  }

  if (request.method === "POST" && parts[0] === "bind") {
    requireHuman(actor);
    if (actor.id !== project.owner_account_id) throw new HttpError(403, "Only the project owner can bind Agents");
    const body = await readJson(request);
    const agent = await getOrCreateRareAgent(env, requireString(body, "rare_agent_id"), optionalString(body, "display_name"));
    const requested = stringArray(body, "capabilities");
    const capabilities = (requested.length > 0 ? requested : DEFAULT_AGENT_CAPABILITIES).filter(
      (capability) => !FORBIDDEN_AGENT_CAPABILITIES.has(capability)
    );
    await env.DB.prepare(
      `INSERT INTO project_agent_grants
       (id, project_id, rare_agent_id, status, capabilities_json, bound_by_account_id, created_at, revoked_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, NULL)`
    )
      .bind(randomId("grant"), project.id, agent.id, JSON.stringify(capabilities), actor.id, nowIso())
      .run();
    await emitEvent(env, { projectId: project.id, actor, type: "agent.bound", payload: { agent_id: agent.agent_id, capabilities } });
    return json({ agent_id: agent.agent_id, capabilities }, { status: 201 });
  }

  if (request.method === "POST" && parts[1] === "revoke") {
    requireHuman(actor);
    if (actor.id !== project.owner_account_id) throw new HttpError(403, "Only the project owner can revoke Agents");
    await env.DB.prepare(
      `UPDATE project_agent_grants SET status = 'revoked', revoked_at = ?
       WHERE project_id = ? AND rare_agent_id IN (SELECT id FROM rare_agents WHERE agent_id = ?)`
    )
      .bind(nowIso(), project.id, parts[0])
      .run();
    await emitEvent(env, { projectId: project.id, actor, type: "agent.revoked", payload: { agent_id: parts[0] } });
    return json({ ok: true });
  }

  return notFound();
}

async function handleVersions(request: Request, env: Env, actor: Actor, project: ProjectRow, parts: string[]): Promise<Response> {
  if (request.method === "POST" && parts.length === 0) {
    await ensureProjectWrite(env, request, actor, project, "task:write");
    const body = await readJson(request);
    const versionId = randomId("ver");
    await env.DB.prepare(
      `INSERT INTO versions
       (id, project_id, name, goal, status, scope_summary, acceptance_summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'planning', ?, ?, ?, ?)`
    )
      .bind(
        versionId,
        project.id,
        requireString(body, "name"),
        requireString(body, "goal"),
        optionalString(body, "scope_summary") ?? optionalString(body, "scope"),
        optionalString(body, "acceptance_summary"),
        nowIso(),
        nowIso()
      )
      .run();
    await emitEvent(env, { projectId: project.id, versionId, actor, type: "version.created", payload: { name: body.name } });
    return json({ version: await requireVersion(env, project.id, String(body.name)) }, { status: 201 });
  }

  const versionName = parts[0];
  if (!versionName) return notFound();
  const version = await requireVersion(env, project.id, versionName);
  if (request.method === "GET" && parts.length === 1) return json({ version, tasks: await listTasks(env, project.id, version.id) });
  if (request.method === "POST" && parts[1] === "validate") return validateVersion(request, env, actor, project, version);
  if (request.method === "POST" && parts[1] === "human-approval") return humanApproval(request, env, actor, project, version);
  if (request.method === "POST" && parts[1] === "request-changes") return requestChanges(request, env, actor, project, version);
  return notFound();
}

async function handleAreas(request: Request, env: Env, actor: Actor, project: ProjectRow, parts: string[]): Promise<Response> {
  if (request.method !== "PUT" || !parts[0]) return notFound();
  await ensureProjectWrite(env, request, actor, project, "context:write");
  const body = await readJson(request);
  const area = await upsertArea(env, project.id, parts[0], optionalString(body, "name") ?? parts[0], optionalString(body, "description"));
  await emitEvent(env, { projectId: project.id, actor, type: "context.updated", payload: { area: area.slug } });
  if (parts[1] === "functions" && parts[2]) {
    const fn = await upsertFunction(env, project.id, area.id, parts[2], optionalString(body, "name") ?? parts[2], optionalString(body, "description"));
    return json({ area, function: fn });
  }
  return json({ area });
}

async function handleContext(request: Request, env: Env, actor: Actor, project: ProjectRow): Promise<Response> {
  if (request.method === "GET") {
    const rows = await env.DB.prepare(`SELECT * FROM context_blocks WHERE project_id = ? ORDER BY created_at`).bind(project.id).all();
    return json({ context: rows.results ?? [] });
  }
  if (request.method !== "POST") return methodNotAllowed();
  await ensureProjectWrite(env, request, actor, project, "context:write");
  const body = await readJson(request);
  const contextId = randomId("ctx");
  await env.DB.prepare(
    `INSERT INTO context_blocks
     (id, project_id, version_id, area_id, function_id, kind, stability, title, body, source_path, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      contextId,
      project.id,
      requireString(body, "kind"),
      Boolean(body.stable) ? "stable" : optionalString(body, "stability") ?? "working",
      requireString(body, "title"),
      requireString(body, "body"),
      optionalString(body, "source_path"),
      actor.id,
      actor.id,
      nowIso(),
      nowIso()
    )
    .run();
  await emitEvent(env, { projectId: project.id, actor, type: "context.created", payload: { context_id: contextId } });
  return json({ context: await getContext(env, contextId) }, { status: 201 });
}

async function handleDecision(request: Request, env: Env, actor: Actor, project: ProjectRow): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  await ensureProjectWrite(env, request, actor, project, "context:write");
  const body = await readJson(request);
  const contextId = randomId("ctx");
  await env.DB.prepare(
    `INSERT INTO context_blocks
     (id, project_id, kind, stability, title, body, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, 'decision', 'stable', ?, ?, ?, ?, ?, ?)`
  )
    .bind(contextId, project.id, requireString(body, "title"), requireString(body, "body"), actor.id, actor.id, nowIso(), nowIso())
    .run();
  await emitEvent(env, { projectId: project.id, actor, type: "decision.created", payload: { title: body.title } });
  return json({ decision: await getContext(env, contextId) }, { status: 201 });
}

async function handleTasks(request: Request, env: Env, actor: Actor, project: ProjectRow, parts: string[]): Promise<Response> {
  if (request.method === "GET" && parts[0] === "next") return nextTask(request, env, project);
  if (request.method === "POST" && parts[0] === "import") return importTasks(request, env, actor, project);
  if (request.method === "POST" && parts.length === 0) return createTask(request, env, actor, project);
  return notFound();
}

async function createTask(request: Request, env: Env, actor: Actor, project: ProjectRow): Promise<Response> {
  await ensureProjectWrite(env, request, actor, project, "task:write");
  const body = await readJson(request);
  const version = await requireVersion(env, project.id, requireString(body, "version"));
  const areaSlug = optionalString(body, "area");
  const functionSlug = optionalString(body, "function");
  const area = areaSlug ? await upsertArea(env, project.id, areaSlug, areaSlug, null) : null;
  const fn = area && functionSlug ? await upsertFunction(env, project.id, area.id, functionSlug, functionSlug, null) : null;
  const task = await insertTask(env, project, version, actor, body, area?.id ?? null, fn?.id ?? null);
  await emitEvent(env, { projectId: project.id, versionId: version.id, taskId: task.id, actor, type: "task.created", payload: { title: task.title } });
  return json({ task }, { status: 201 });
}

async function importTasks(request: Request, env: Env, actor: Actor, project: ProjectRow): Promise<Response> {
  await ensureProjectWrite(env, request, actor, project, "task:write");
  const body = await readJson(request);
  const tasks = Array.isArray(body.tasks) ? (body.tasks as Record<string, unknown>[]) : [];
  const created = [];
  for (const taskInput of tasks) {
    const fakeRequest = new Request(request.url, { method: "POST", body: JSON.stringify(taskInput) });
    const response = await createTask(fakeRequest, env, actor, project);
    created.push((await response.json()) as unknown);
  }
  return json({ imported: created.length, tasks: created });
}

async function nextTask(request: Request, env: Env, project: ProjectRow): Promise<Response> {
  const url = new URL(request.url);
  const typeFilter = url.searchParams.get("type");
  const versionName = url.searchParams.get("version");
  const version = versionName
    ? await requireVersion(env, project.id, versionName)
    : await env.DB.prepare(`SELECT * FROM versions WHERE project_id = ? AND status IN ('planning','active','validation') ORDER BY created_at LIMIT 1`)
        .bind(project.id)
        .first<VersionRow>();
  if (!version) return json({ task: null });
  const task = await env.DB.prepare(
    `SELECT t.*, a.slug AS area_slug, f.slug AS function_slug
     FROM tasks t
     LEFT JOIN areas a ON a.id = t.area_id
     LEFT JOIN project_functions f ON f.id = t.function_id
     WHERE t.project_id = ? AND t.version_id = ? AND t.status = 'ready'
       AND t.type != 'human_acceptance'
       AND (? IS NULL OR t.type = ?)
       AND NOT EXISTS (
         SELECT 1 FROM task_dependencies d
         JOIN tasks dep ON dep.id = d.depends_on_task_id
         WHERE d.task_id = t.id AND dep.status != 'done'
       )
     ORDER BY t.priority DESC, t.created_at ASC
     LIMIT 1`
  )
    .bind(project.id, version.id, typeFilter, typeFilter)
    .first<TaskRow>();
  if (!task) return json({ task: null });
  if (url.searchParams.get("bundle") === "true") return json(await buildBundle(env, project, version, task));
  return json({ task });
}

async function handleTaskById(request: Request, env: Env, actor: Actor, taskId: string, parts: string[]): Promise<Response> {
  const task = await requireTask(env, taskId);
  const project = await requireProjectById(env, task.project_id);
  await ensureCanReadProject(project, actor);
  const version = await requireVersionById(env, task.version_id);
  if (request.method === "GET" && parts.length === 0) return json(await buildBundle(env, project, version, task));

  if (parts[0] === "start" && request.method === "POST") {
    await ensureProjectWrite(env, request, actor, project, "task:write");
    await updateTaskStatus(env, actor, task, "in_progress", "task.started");
    return json({ task: await requireTask(env, taskId) });
  }
  if (parts[0] === "note" && request.method === "POST") {
    await ensureProjectWrite(env, request, actor, project, "task:write");
    const body = await readJson(request);
    await emitEvent(env, { projectId: project.id, versionId: task.version_id, taskId, actor, type: "task.note_added", payload: { summary: requireString(body, "summary") } });
    return json({ ok: true });
  }
  if (parts[0] === "attach" && request.method === "POST") {
    await ensureProjectWrite(env, request, actor, project, "artifact:write");
    const body = await readJson(request);
    const artifactId = randomId("art");
    await env.DB.prepare(
      `INSERT INTO artifacts
       (id, project_id, task_id, version_id, kind, provider, external_id, url, summary, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        artifactId,
        project.id,
        task.id,
        task.version_id,
        requireString(body, "kind"),
        optionalString(body, "provider"),
        optionalString(body, "external_id"),
        optionalString(body, "url"),
        optionalString(body, "summary"),
        JSON.stringify(body.metadata ?? {}),
        nowIso()
      )
      .run();
    await emitEvent(env, { projectId: project.id, versionId: task.version_id, taskId, actor, type: "task.artifact_attached", payload: { artifact_id: artifactId } });
    return json({ artifact: { id: artifactId } }, { status: 201 });
  }
  if (parts[0] === "block" && request.method === "POST") {
    await ensureProjectWrite(env, request, actor, project, "task:write");
    const body = await readJson(request);
    await updateTaskStatus(env, actor, task, "blocked", "task.blocked", {
      reason: requireString(body, "reason"),
      next_step: requireString(body, "next_step")
    });
    return json({ task: await requireTask(env, taskId) });
  }
  if (parts[0] === "done" && request.method === "POST") {
    if (task.type === "human_acceptance" && actor.type !== "human") throw new HttpError(403, "Agent cannot close human_acceptance");
    await ensureProjectWrite(env, request, actor, project, "task:write");
    await updateTaskStatus(env, actor, task, "done", "task.done", { tests: optionalString(await readJson(request), "tests") });
    return json({ task: await requireTask(env, taskId) });
  }

  return notFound();
}

async function validateVersion(request: Request, env: Env, actor: Actor, project: ProjectRow, version: VersionRow): Promise<Response> {
  await ensureProjectWrite(env, request, actor, project, "version:validate");
  const blocked = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM tasks
     WHERE project_id = ? AND version_id = ? AND type != 'human_acceptance' AND status IN ('blocked')`
  )
    .bind(project.id, version.id)
    .first<{ count: number }>();
  const incomplete = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM tasks
     WHERE project_id = ? AND version_id = ? AND type != 'human_acceptance' AND status != 'done'`
  )
    .bind(project.id, version.id)
    .first<{ count: number }>();
  const releaseSummary = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM artifacts WHERE project_id = ? AND version_id = ? AND kind IN ('release_note', 'release_summary')`
  )
    .bind(project.id, version.id)
    .first<{ count: number }>();
  const failures = [];
  if ((blocked?.count ?? 0) > 0) failures.push("blocked tasks remain");
  if ((incomplete?.count ?? 0) > 0) failures.push("incomplete normal tasks remain");
  if ((releaseSummary?.count ?? 0) === 0) failures.push("release summary artifact is missing");
  if (failures.length > 0) throw new HttpError(409, "Version validation failed", { failures });

  await env.DB.prepare(`UPDATE versions SET status = 'human_review', updated_at = ? WHERE id = ?`).bind(nowIso(), version.id).run();
  const existing = await env.DB.prepare(`SELECT id FROM tasks WHERE version_id = ? AND type = 'human_acceptance'`).bind(version.id).first<{ id: string }>();
  if (!existing) {
    const taskId = randomId("task");
    await env.DB.prepare(
      `INSERT INTO tasks
       (id, project_id, version_id, type, status, title, goal, acceptance_json, priority, created_by, closable_by, created_at, updated_at)
       VALUES (?, ?, ?, 'human_acceptance', 'waiting_human', 'Approve version release', 'Human approval gate for this version.', ?, 100, ?, 'human', ?, ?)`
    )
      .bind(taskId, project.id, version.id, JSON.stringify(["Human approves this version or requests changes."]), actor.id, nowIso(), nowIso())
      .run();
    await emitEvent(env, { projectId: project.id, versionId: version.id, taskId, actor, type: "task.created", payload: { type: "human_acceptance" } });
  }
  await emitEvent(env, { projectId: project.id, versionId: version.id, actor, type: "version.human_review_started" });
  return json({ version: await requireVersionById(env, version.id), human_acceptance: true });
}

async function humanApproval(_request: Request, env: Env, actor: Actor, project: ProjectRow, version: VersionRow): Promise<Response> {
  requireHuman(actor);
  if (actor.id !== project.owner_account_id) throw new HttpError(403, "Only the project owner can approve versions");
  await env.DB.prepare(`UPDATE versions SET status = 'released', updated_at = ? WHERE id = ?`).bind(nowIso(), version.id).run();
  await env.DB.prepare(`UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE version_id = ? AND type = 'human_acceptance'`)
    .bind(nowIso(), nowIso(), version.id)
    .run();
  await emitEvent(env, { projectId: project.id, versionId: version.id, actor, type: "version.released" });
  return json({ version: await requireVersionById(env, version.id) });
}

async function requestChanges(request: Request, env: Env, actor: Actor, project: ProjectRow, version: VersionRow): Promise<Response> {
  requireHuman(actor);
  if (actor.id !== project.owner_account_id) throw new HttpError(403, "Only the project owner can request changes");
  const body = await readJson(request);
  await env.DB.prepare(`UPDATE versions SET status = 'active', updated_at = ? WHERE id = ?`).bind(nowIso(), version.id).run();
  await env.DB.prepare(`UPDATE tasks SET status = 'waiting_human', updated_at = ? WHERE version_id = ? AND type = 'human_acceptance'`)
    .bind(nowIso(), version.id)
    .run();
  await emitEvent(env, { projectId: project.id, versionId: version.id, actor, type: "version.changes_requested", payload: { feedback: requireString(body, "feedback") } });
  return json({ version: await requireVersionById(env, version.id) });
}

async function ensureProjectWrite(env: Env, request: Request, actor: Actor, project: ProjectRow, capability: string): Promise<void> {
  if (actor.type === "human") {
    if (actor.id !== project.owner_account_id) throw new HttpError(403, "Project owner required");
    return;
  }
  await requireAgentWrite(env, request, actor, project.id, capability);
}

async function ensureCanReadProject(project: ProjectRow, actor: Actor): Promise<void> {
  if (actor.type === "human" && actor.id === project.owner_account_id) return;
  if (actor.type === "agent" && actor.session.project_id === project.id && actor.capabilities.includes("project:read")) return;
  throw new HttpError(401, "Project access required");
}

async function requireProject(env: Env, slug: string): Promise<ProjectRow> {
  const row = await env.DB.prepare(`SELECT * FROM projects WHERE slug = ?`).bind(slug).first<ProjectRow>();
  if (!row) throw new HttpError(404, "Project not found");
  return row;
}

async function requireProjectById(env: Env, id: string): Promise<ProjectRow> {
  const row = await env.DB.prepare(`SELECT * FROM projects WHERE id = ?`).bind(id).first<ProjectRow>();
  if (!row) throw new HttpError(404, "Project not found");
  return row;
}

async function requireVersion(env: Env, projectId: string, name: string): Promise<VersionRow> {
  const row = await env.DB.prepare(`SELECT * FROM versions WHERE project_id = ? AND name = ?`).bind(projectId, name).first<VersionRow>();
  if (!row) throw new HttpError(404, "Version not found");
  return row;
}

async function requireVersionById(env: Env, id: string): Promise<VersionRow> {
  const row = await env.DB.prepare(`SELECT * FROM versions WHERE id = ?`).bind(id).first<VersionRow>();
  if (!row) throw new HttpError(404, "Version not found");
  return row;
}

async function requireTask(env: Env, taskId: string): Promise<TaskRow> {
  const row = await env.DB.prepare(
    `SELECT t.*, a.slug AS area_slug, f.slug AS function_slug
     FROM tasks t
     LEFT JOIN areas a ON a.id = t.area_id
     LEFT JOIN project_functions f ON f.id = t.function_id
     WHERE t.id = ?`
  )
    .bind(taskId)
    .first<TaskRow>();
  if (!row) throw new HttpError(404, "Task not found");
  return row;
}

async function listVersions(env: Env, projectId: string): Promise<unknown[]> {
  const rows = await env.DB.prepare(`SELECT * FROM versions WHERE project_id = ? ORDER BY created_at`).bind(projectId).all();
  return rows.results ?? [];
}

async function listTasks(env: Env, projectId: string, versionId: string): Promise<unknown[]> {
  const rows = await env.DB.prepare(`SELECT * FROM tasks WHERE project_id = ? AND version_id = ? ORDER BY priority DESC, created_at`).bind(projectId, versionId).all();
  return rows.results ?? [];
}

async function listEvents(env: Env, projectId: string): Promise<unknown[]> {
  const rows = await env.DB.prepare(`SELECT * FROM events WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`).bind(projectId).all();
  return rows.results ?? [];
}

async function getOrCreateRareAgent(env: Env, agentId: string, displayName: string | null): Promise<{ id: string; agent_id: string }> {
  const existing = await env.DB.prepare(`SELECT id, agent_id FROM rare_agents WHERE agent_id = ?`).bind(agentId).first<{ id: string; agent_id: string }>();
  if (existing) return existing;
  const id = randomId("ra");
  await env.DB.prepare(
    `INSERT INTO rare_agents (id, agent_id, display_name, custody_mode, trust_level, created_at, updated_at)
     VALUES (?, ?, ?, 'public-only', 'quickstart', ?, ?)`
  )
    .bind(id, agentId, displayName, nowIso(), nowIso())
    .run();
  return { id, agent_id: agentId };
}

async function upsertArea(env: Env, projectId: string, slug: string, name: string, description: string | null): Promise<{ id: string; slug: string }> {
  const existing = await env.DB.prepare(`SELECT id, slug FROM areas WHERE project_id = ? AND slug = ?`).bind(projectId, slug).first<{ id: string; slug: string }>();
  if (existing) return existing;
  const id = randomId("area");
  await env.DB.prepare(`INSERT INTO areas (id, project_id, slug, name, description) VALUES (?, ?, ?, ?, ?)`).bind(id, projectId, slug, name, description).run();
  return { id, slug };
}

async function upsertFunction(env: Env, projectId: string, areaId: string, slug: string, name: string, description: string | null): Promise<{ id: string; slug: string }> {
  const existing = await env.DB.prepare(`SELECT id, slug FROM project_functions WHERE project_id = ? AND area_id = ? AND slug = ?`)
    .bind(projectId, areaId, slug)
    .first<{ id: string; slug: string }>();
  if (existing) return existing;
  const id = randomId("fn");
  await env.DB.prepare(`INSERT INTO project_functions (id, project_id, area_id, slug, name, description) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, projectId, areaId, slug, name, description)
    .run();
  return { id, slug };
}

async function insertTask(env: Env, project: ProjectRow, version: VersionRow, actor: Actor, body: Record<string, unknown>, areaId: string | null, functionId: string | null): Promise<TaskRow> {
  const taskId = randomId("task");
  const type = requireString(body, "type");
  const status = type === "human_acceptance" ? "waiting_human" : optionalString(body, "status") ?? "ready";
  const acceptance = stringArray(body, "acceptance");
  await env.DB.prepare(
    `INSERT INTO tasks
     (id, project_id, version_id, area_id, function_id, parent_task_id, type, status, title, goal, acceptance_json, priority, created_by, closable_by, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      taskId,
      project.id,
      version.id,
      areaId,
      functionId,
      type,
      status,
      requireString(body, "title"),
      requireString(body, "goal"),
      JSON.stringify(acceptance),
      Number(body.priority ?? 0),
      actor.id,
      type === "human_acceptance" ? "human" : "agent",
      optionalString(body, "source"),
      nowIso(),
      nowIso()
    )
    .run();
  for (const dependency of stringArray(body, "depends_on")) {
    await env.DB.prepare(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`).bind(taskId, dependency).run();
  }
  for (const contextId of stringArray(body, "context_ids")) {
    await env.DB.prepare(`INSERT INTO task_context_refs (task_id, context_block_id, relevance) VALUES (?, ?, 'required')`).bind(taskId, contextId).run();
  }
  return requireTask(env, taskId);
}

async function updateTaskStatus(env: Env, actor: Actor, task: TaskRow, status: string, eventType: string, payload: Record<string, unknown> = {}): Promise<void> {
  await env.DB.prepare(`UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
    .bind(status, status === "done" ? nowIso() : null, nowIso(), task.id)
    .run();
  await emitEvent(env, { projectId: task.project_id, versionId: task.version_id, taskId: task.id, actor, type: eventType, payload });
}

async function getContext(env: Env, id: string): Promise<ContextRow> {
  const row = await env.DB.prepare(`SELECT id, kind, stability, title, body, source_path FROM context_blocks WHERE id = ?`).bind(id).first<ContextRow>();
  if (!row) throw new HttpError(404, "Context block not found");
  return row;
}

async function buildBundle(env: Env, project: ProjectRow, version: VersionRow, task: TaskRow): Promise<unknown> {
  const explicit = await env.DB.prepare(
    `SELECT c.id, c.kind, c.stability, c.title, c.body, c.source_path
     FROM context_blocks c
     JOIN task_context_refs r ON r.context_block_id = c.id
     WHERE r.task_id = ?`
  )
    .bind(task.id)
    .all<ContextRow>();
  const fallback = await env.DB.prepare(
    `SELECT id, kind, stability, title, body, source_path
     FROM context_blocks
     WHERE project_id = ? AND (
       stability = 'stable' OR
       (? IN ('design') AND kind = 'design') OR
       (? = 'dev' AND ? = 'web' AND kind = 'design')
     )
     ORDER BY created_at`
  )
    .bind(project.id, task.type, task.type, task.area_slug ?? "")
    .all<ContextRow>();
  const contexts = [...(explicit.results ?? []), ...(fallback.results ?? [])];
  const deduped = [...new Map(contexts.map((context) => [context.id, context])).values()];
  const decisions = await env.DB.prepare(
    `SELECT title, body FROM context_blocks WHERE project_id = ? AND kind = 'decision' ORDER BY created_at DESC LIMIT 5`
  )
    .bind(project.id)
    .all();
  const artifacts = await env.DB.prepare(`SELECT kind, provider, external_id, url, summary FROM artifacts WHERE task_id = ? OR version_id = ? ORDER BY created_at DESC`)
    .bind(task.id, version.id)
    .all();
  return {
    project: { slug: project.slug, repo_url: project.repo_url },
    version: { name: version.name, goal: version.goal, status: version.status },
    task: {
      id: task.id,
      type: task.type,
      status: task.status,
      area: task.area_slug,
      function: task.function_slug,
      title: task.title,
      goal: task.goal,
      acceptance: parseJsonArray(task.acceptance_json)
    },
    context: { required: deduped },
    decisions: { recent: decisions.results ?? [] },
    artifacts: { related: artifacts.results ?? [] },
    execution_rules: [
      "Start task before modifying code.",
      "Attach commits or PRs before marking done.",
      "Create follow-up tasks when test, docs, ops, marketing, or review work remains.",
      "Never close human_acceptance."
    ]
  };
}
