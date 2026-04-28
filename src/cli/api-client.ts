import { expectedActionSignature } from "../crypto";
import { loadConfig, type CliConfig } from "./config";

export interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: "human" | "rare" | "none";
  signed?: boolean;
  config?: CliConfig;
}

export async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const config = options.config ?? (await loadConfig());
  const baseUrl = config.baseUrl ?? process.env.UNFOLD_BASE_URL ?? "http://localhost:8787";
  const url = new URL(path, baseUrl);
  const method = options.method ?? "GET";
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const tokenKind = options.token ?? "human";
  const token = tokenKind === "rare" ? config.rareToken : tokenKind === "human" ? config.humanToken : undefined;
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (options.signed) {
    if (!token) throw new Error("Signed Agent request requires a Rare token");
    headers.set("x-unfold-action-signature", await expectedActionSignature(token, method, url.pathname));
  }
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(url, init);
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
