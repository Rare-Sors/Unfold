import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliConfig {
  baseUrl?: string;
  humanToken?: string;
  rareToken?: string;
  rareAgentId?: string;
  projectSlug?: string;
}

const configDir = join(homedir(), ".unfold");
const configPath = join(configDir, "config.json");

export async function loadConfig(): Promise<CliConfig> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

export async function saveConfig(config: CliConfig): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

export function resolveBoardUrl(input: string): { baseUrl: string; slug: string } {
  const url = new URL(input);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("Board URL must include /owner/project");
  return { baseUrl: url.origin, slug: `${parts[0]}/${parts[1]}` };
}
