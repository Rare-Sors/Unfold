import { randomId, randomToken, sha256, verifyActionSignature } from "./crypto";
import {
  addSeconds,
  bearerToken,
  getCookie,
  HttpError,
  isExpired,
  parseJsonArray,
  type AccountRow,
  type Actor,
  type Env,
  type RareSessionRow
} from "./http";

const HUMAN_COOKIE = "unfold_session";

export async function createHumanSession(env: Env, accountId: string): Promise<string> {
  const token = randomToken("hum");
  await env.DB.prepare(
    `INSERT INTO human_sessions (id, account_id, session_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(randomId("hs"), accountId, await sha256(token), addSeconds(60 * 60 * 24 * 14), new Date().toISOString())
    .run();
  return token;
}

export async function getHumanActor(env: Env, request: Request): Promise<Actor | null> {
  const token = bearerToken(request) ?? getCookie(request, HUMAN_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT a.* FROM accounts a
     JOIN human_sessions s ON s.account_id = a.id
     WHERE s.session_hash = ? AND s.expires_at > ?`
  )
    .bind(await sha256(token), new Date().toISOString())
    .first<AccountRow>();
  if (!row) return null;
  return { type: "human", id: row.id, account: row };
}

export async function createRareSession(
  env: Env,
  input: { rareAgentId: string; projectId: string; delegatedKeyId: string; capabilities: string[] }
): Promise<string> {
  const token = randomToken("rare");
  await env.DB.prepare(
    `INSERT INTO rare_sessions
       (id, rare_agent_id, project_id, delegated_key_id, session_token_hash, capabilities_json, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  )
    .bind(
      randomId("rs"),
      input.rareAgentId,
      input.projectId,
      input.delegatedKeyId,
      await sha256(token),
      JSON.stringify(input.capabilities),
      addSeconds(60 * 60),
      new Date().toISOString()
    )
    .run();
  return token;
}

export async function getAgentActor(env: Env, request: Request): Promise<Actor | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.*, a.agent_id FROM rare_sessions s
     JOIN rare_agents a ON a.id = s.rare_agent_id
     WHERE s.session_token_hash = ? AND s.expires_at > ? AND s.revoked_at IS NULL`
  )
    .bind(await sha256(token), new Date().toISOString())
    .first<RareSessionRow>();
  if (!row) return null;
  return { type: "agent", id: row.agent_id, session: row, capabilities: parseJsonArray(row.capabilities_json) };
}

export async function getActor(env: Env, request: Request): Promise<Actor> {
  return (await getHumanActor(env, request)) ?? (await getAgentActor(env, request)) ?? { type: "anonymous", id: "anonymous" };
}

export function requireHuman(actor: Actor): asserts actor is Extract<Actor, { type: "human" }> {
  if (actor.type !== "human") throw new HttpError(401, "Human login required");
}

export async function requireAgentWrite(env: Env, request: Request, actor: Actor, projectId: string, capability: string): Promise<void> {
  if (actor.type !== "agent") throw new HttpError(401, "Rare Agent session required");
  if (actor.session.project_id !== projectId) throw new HttpError(403, "Rare session is not scoped to this project");
  if (!actor.capabilities.includes(capability)) throw new HttpError(403, `Missing capability: ${capability}`);
  const token = bearerToken(request);
  const path = new URL(request.url).pathname;
  const signature = request.headers.get("x-unfold-action-signature");
  if (!token || !(await verifyActionSignature(token, request.method, path, signature))) {
    throw new HttpError(401, "Invalid signed action");
  }
}

export function requireHumanOrAgent(actor: Actor): void {
  if (actor.type === "anonymous") throw new HttpError(401, "Authentication required");
}

export function assertChallengeUsable(challenge: { used_at: string | null; expires_at: string }): void {
  if (challenge.used_at) throw new HttpError(409, "Rare challenge already used");
  if (isExpired(challenge.expires_at)) throw new HttpError(410, "Rare challenge expired");
}

export { HUMAN_COOKIE };
