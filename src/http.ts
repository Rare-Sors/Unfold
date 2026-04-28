export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export type RouteParams = Record<string, string>;

export type Actor =
  | { type: "anonymous"; id: "anonymous" }
  | { type: "human"; id: string; account: AccountRow }
  | { type: "agent"; id: string; session: RareSessionRow; capabilities: string[] };

export interface AccountRow {
  id: string;
  handle: string;
  email: string;
  password_hash: string;
  created_at: string;
}

export interface RareSessionRow {
  id: string;
  rare_agent_id: string;
  project_id: string;
  delegated_key_id: string;
  session_token_hash: string;
  capabilities_json: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  agent_id: string;
}

export interface Env {
  DB: D1Database;
  SESSION_SECRET?: string;
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

export async function readJson<T extends Record<string, unknown>>(request: Request): Promise<T> {
  if (request.method === "GET" || request.method === "HEAD") return {} as T;
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

export function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `Missing required string: ${key}`);
  }
  return value.trim();
}

export function optionalString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string`);
  return value.trim();
}

export function stringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError(400, `${key} must be a string array`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

export function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return rawValue.join("=");
  }
  return null;
}

export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

export function splitPath(request: Request): string[] {
  return new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function isExpired(iso: string): boolean {
  return new Date(iso).getTime() <= Date.now();
}

export function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

export function methodNotAllowed(): Response {
  return json({ error: "method_not_allowed" }, { status: 405 });
}

export function notFound(): Response {
  return json({ error: "not_found" }, { status: 404 });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: error.message, details: error.details }, { status: error.status });
  }
  console.error(JSON.stringify({ level: "error", error: String(error) }));
  return json({ error: "internal_server_error" }, { status: 500 });
}
