import { describe, expect, it } from "vitest";
import { expectedActionSignature } from "../src/crypto";
import { errorResponse } from "../src/http";
import { handleRequest } from "../src/worker";
import { createTestDb, type TestD1 } from "./d1";

interface TestEnv {
  DB: TestD1;
}

async function call<T = any>(env: TestEnv, path: string, init: RequestInit = {}) {
  const request = new Request(`http://localhost${path}`, init);
  const response = await handleRequest(request, env as never).catch(errorResponse);
  const data = (await response.json().catch(() => null)) as T;
  return { response, data };
}

async function post<T = any>(env: TestEnv, path: string, body: unknown, token?: string, signed = false) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (token && signed) headers.set("x-unfold-action-signature", await expectedActionSignature(token, "POST", path));
  return call<T>(env, path, { method: "POST", headers, body: JSON.stringify(body) });
}

async function put(env: TestEnv, path: string, body: unknown, token: string) {
  const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${token}` });
  headers.set("x-unfold-action-signature", await expectedActionSignature(token, "PUT", path));
  return call(env, path, { method: "PUT", headers, body: JSON.stringify(body) });
}

async function setupProject() {
  const env = { DB: await createTestDb() };
  const signup = await post(env, "/api/auth/signup", { email: "sid@example.com", password: "secret123", handle: "sid" });
  const humanToken = signup.data.token as string;
  const project = await post(env, "/api/projects", { slug: "sid/my-product", name: "My Product", repo_url: "https://github.com/sid/my-product" }, humanToken);
  return { env, humanToken, projectId: project.data.project.id as string };
}

async function bindAndLoginAgent(env: TestEnv, humanToken: string) {
  await post(env, "/api/sid/my-product/agents/bind", { rare_agent_id: "ed25519-agent" }, humanToken);
  const challenge = await post(env, "/api/rare/challenge", { project_slug: "sid/my-product" });
  const body = {
    challenge_id: challenge.data.challenge_id,
    nonce: challenge.data.nonce,
    agent_id: "ed25519-agent",
    delegated_key_id: "delegated-key",
    auth_subject: "ed25519-agent",
    delegation_subject: "ed25519-agent",
    attestation_subject: "ed25519-agent"
  };
  const complete = await post(env, "/api/rare/complete", body);
  return { token: complete.data.token as string, replayBody: body };
}

describe("Unfold Worker MVP", () => {
  it("creates a human project shell and appends a project event", async () => {
    const { env, humanToken, projectId } = await setupProject();
    expect(humanToken).toMatch(/^hum_/);
    const events = await env.DB.prepare("SELECT * FROM events WHERE project_id = ?").bind(projectId).all<{ event_type: string }>();
    expect(events.results.map((event) => event.event_type)).toContain("project.created");
  });

  it("rejects replayed Rare challenges and enforces Agent capabilities", async () => {
    const { env, humanToken } = await setupProject();
    const login = await bindAndLoginAgent(env, humanToken);

    const replay = await post(env, "/api/rare/complete", login.replayBody);
    expect(replay.response.status).toBe(409);

    const version = await post(
      env,
      "/api/sid/my-product/versions",
      { name: "v1.0", goal: "Ship first usable Agent-native board" },
      login.token,
      true
    );
    expect(version.response.status).toBe(201);

    const context = await post(
      env,
      "/api/sid/my-product/context",
      { kind: "design", title: "Global design direction", body: "Quiet operational dashboard.", stable: true },
      login.token,
      true
    );
    expect(context.response.status).toBe(201);

    const task = await post(
      env,
      "/api/sid/my-product/tasks",
      {
        version: "v1.0",
        type: "dev",
        area: "web",
        function: "dashboard",
        title: "Build dashboard",
        goal: "Show version progress.",
        acceptance: ["Dashboard shows progress"],
        context_ids: [context.data.context.id]
      },
      login.token,
      true
    );
    expect(task.response.status).toBe(201);

    const next = await call(env, "/api/sid/my-product/tasks/next?bundle=true", {
      headers: { authorization: `Bearer ${login.token}` }
    });
    expect(next.data.task.title).toBe("Build dashboard");
    expect(next.data.context.required.some((item: { kind: string }) => item.kind === "design")).toBe(true);
  });

  it("keeps human_acceptance human-only after version validation", async () => {
    const { env, humanToken } = await setupProject();
    const { token } = await bindAndLoginAgent(env, humanToken);

    await post(env, "/api/sid/my-product/versions", { name: "v1.0", goal: "Ship" }, token, true);
    const task = await post(
      env,
      "/api/sid/my-product/tasks",
      { version: "v1.0", type: "docs", area: "docs", function: "release", title: "Write release summary", goal: "Summarize release.", acceptance: ["Release summary attached"] },
      token,
      true
    );
    await post(env, `/api/tasks/${task.data.task.id}/start`, {}, token, true);
    await post(env, `/api/tasks/${task.data.task.id}/attach`, { kind: "release_note", summary: "Ready to release" }, token, true);
    await post(env, `/api/tasks/${task.data.task.id}/done`, { tests: "npm test" }, token, true);

    const validation = await post(env, "/api/sid/my-product/versions/v1.0/validate", {}, token, true);
    expect(validation.response.status).toBe(200);

    const humanTask = await env.DB.prepare("SELECT id FROM tasks WHERE type = 'human_acceptance'").first<{ id: string }>();
    expect(humanTask?.id).toBeTruthy();

    const agentClose = await post(env, `/api/tasks/${humanTask!.id}/done`, {}, token, true);
    expect(agentClose.response.status).toBe(403);

    const approval = await post(env, "/api/sid/my-product/versions/v1.0/human-approval", {}, humanToken);
    expect(approval.data.version.status).toBe("released");
  });

  it("rejects Agent writes without a signed action header", async () => {
    const { env, humanToken } = await setupProject();
    const { token } = await bindAndLoginAgent(env, humanToken);
    const response = await post(env, "/api/sid/my-product/versions", { name: "v1.0", goal: "Ship" }, token, false);
    expect(response.response.status).toBe(401);
  });

  it("renders the onboarding dashboard without normal task mutation controls", async () => {
    const response = await handleRequest(new Request("http://localhost/"), { DB: await createTestDb() } as never);
    const body = await response.text();
    expect(body).toContain("Create project shell");
    expect(body).toContain("Bind Agent Rare identity");
    expect(body).not.toContain("drag");
  });
});
