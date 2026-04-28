#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { randomId } from "../crypto";
import { apiFetch } from "./api-client";
import { loadConfig, resolveBoardUrl, saveConfig } from "./config";
import { printData } from "./format";

const program = new Command();

program.name("unfold").description("Agent-native Unfold CLI").version("0.1.0");

program
  .command("login")
  .requiredOption("--email <email>")
  .requiredOption("--password <password>")
  .option("--base-url <url>", "Unfold API origin", "http://localhost:8787")
  .action(async (options) => {
    const config = await loadConfig();
    config.baseUrl = options.baseUrl;
    const result = await apiFetch<{ token: string; account: unknown }>("/api/auth/login", {
      method: "POST",
      token: "none",
      body: { email: options.email, password: options.password },
      config
    });
    await saveConfig({ ...config, humanToken: result.token });
    printData({ account: result.account });
  });

program.command("whoami").action(async () => printData(await apiFetch("/api/auth/me")));

const rare = program.command("rare");

rare.command("status").action(async () => {
  const config = await loadConfig();
  printData({ rare_agent_id: config.rareAgentId ?? null, authenticated: Boolean(config.rareToken), project_slug: config.projectSlug ?? null });
});

rare.command("register").action(() => {
  process.stdout.write("Read https://www.rareid.cc/skill.md and follow the instructions to register Rare.\n");
});

rare
  .command("login")
  .argument("<board-url>")
  .option("--agent-id <agentId>", "Rare Agent public key")
  .action(async (boardUrl, options) => {
    const { baseUrl, slug } = resolveBoardUrl(boardUrl);
    const config = { ...(await loadConfig()), baseUrl, projectSlug: slug };
    const agentId = options.agentId ?? config.rareAgentId ?? process.env.UNFOLD_RARE_AGENT_ID;
    if (!agentId) throw new Error("Provide --agent-id or UNFOLD_RARE_AGENT_ID");
    const challenge = await apiFetch<{ challenge_id: string; nonce: string }>(
      "/api/rare/challenge",
      { method: "POST", token: "none", body: { project_slug: slug }, config }
    );
    const result = await apiFetch<{ token: string; capabilities: string[] }>("/api/rare/complete", {
      method: "POST",
      token: "none",
      config,
      body: {
        challenge_id: challenge.challenge_id,
        nonce: challenge.nonce,
        agent_id: agentId,
        delegated_key_id: randomId("delegated"),
        auth_subject: agentId,
        delegation_subject: agentId,
        attestation_subject: agentId
      }
    });
    await saveConfig({ ...config, rareAgentId: agentId, rareToken: result.token });
    printData({ agent_id: agentId, capabilities: result.capabilities });
  });

const project = program.command("project");

project.command("resolve").argument("<board-url>").action((boardUrl) => printData(resolveBoardUrl(boardUrl)));

project
  .command("create")
  .argument("<slug>")
  .requiredOption("--name <name>")
  .option("--repo <url>")
  .action(async (slug, options) => {
    printData(await apiFetch("/api/projects", { method: "POST", body: { slug, name: options.name, repo_url: options.repo } }));
  });

project.command("init").argument("<board-url>").action(async (boardUrl) => {
  const { baseUrl, slug } = resolveBoardUrl(boardUrl);
  const config = { ...(await loadConfig()), baseUrl, projectSlug: slug };
  await saveConfig(config);
  const files: Array<[string, string]> = [
    ["context/vision.md", "# Product Vision\n\nDescribe the product direction, target users, and long-term constraints.\n"],
    ["context/design.md", "# Design Direction\n\nRecord the stable visual and interaction direction before UI work starts.\n"],
    ["context/scope.md", "# Version Scope\n\nRecord the current version goal, non-goals, acceptance criteria, and risks.\n"]
  ];
  for (const [path, body] of files) {
    if (!existsSync(path)) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    }
    await apiFetch(`/api/${slug}/context`, {
      method: "POST",
      token: "rare",
      signed: true,
      config,
      body: {
        kind: path.includes("design") ? "design" : path.includes("scope") ? "version" : "overview",
        title: path.includes("design") ? "Global design direction" : path.includes("scope") ? "Version scope" : "Product vision",
        body,
        source_path: path,
        stable: true
      }
    }).catch(() => undefined);
  }
  printData({ project_slug: slug, context_files: files.map(([path]) => join(process.cwd(), path)) });
});

const agent = program.command("agent");

agent
  .command("bind")
  .argument("<board-url>")
  .requiredOption("--rare-agent-id <agentId>")
  .option("--capability <capability...>")
  .action(async (boardUrl, options) => {
    const { baseUrl, slug } = resolveBoardUrl(boardUrl);
    const config = { ...(await loadConfig()), baseUrl };
    printData(
      await apiFetch(`/api/${slug}/agents/bind`, {
        method: "POST",
        config,
        body: { rare_agent_id: options.rareAgentId, capabilities: options.capability ?? [] }
      })
    );
  });

const version = program.command("version");

version
  .command("create")
  .argument("<slug>")
  .argument("<version>")
  .requiredOption("--goal <goal>")
  .option("--scope <scope>")
  .action(async (slug, version, options) => {
    printData(await apiFetch(`/api/${slug}/versions`, { method: "POST", token: "rare", signed: true, body: { name: version, goal: options.goal, scope: options.scope } }));
  });

version
  .command("validate")
  .argument("<slug>")
  .argument("<version>")
  .action(async (slug, version) => {
    printData(await apiFetch(`/api/${slug}/versions/${version}/validate`, { method: "POST", token: "rare", signed: true }));
  });

const area = program.command("area");

area
  .command("upsert")
  .argument("<slug>")
  .argument("<area>")
  .option("--name <name>")
  .option("--description <description>")
  .action(async (slug, area, options) => {
    printData(await apiFetch(`/api/${slug}/areas/${area}`, { method: "PUT", token: "rare", signed: true, body: options }));
  });

const fn = program.command("function");

fn
  .command("upsert")
  .argument("<slug>")
  .argument("<area>")
  .argument("<fn>")
  .option("--name <name>")
  .option("--description <description>")
  .action(async (slug, area, fn, options) => {
    printData(await apiFetch(`/api/${slug}/areas/${area}/functions/${fn}`, { method: "PUT", token: "rare", signed: true, body: options }));
  });

const context = program.command("context");

context
  .command("add")
  .argument("<slug>")
  .requiredOption("--kind <kind>")
  .requiredOption("--title <title>")
  .requiredOption("--body-file <path>")
  .option("--stable")
  .action(async (slug, options) => {
    const body = await import("node:fs/promises").then((fs) => fs.readFile(options.bodyFile, "utf8"));
    printData(await apiFetch(`/api/${slug}/context`, { method: "POST", token: "rare", signed: true, body: { kind: options.kind, title: options.title, body, stable: Boolean(options.stable), source_path: options.bodyFile } }));
  });

const decision = program.command("decision");

decision
  .command("add")
  .argument("<slug>")
  .requiredOption("--title <title>")
  .requiredOption("--body <body>")
  .action(async (slug, options) => {
    printData(await apiFetch(`/api/${slug}/decisions`, { method: "POST", token: "rare", signed: true, body: options }));
  });

const task = program.command("task");

task
  .command("create")
  .argument("<slug>")
  .requiredOption("--version <version>")
  .requiredOption("--type <type>")
  .option("--area <area>")
  .option("--function <function>")
  .requiredOption("--title <title>")
  .requiredOption("--goal <goal>")
  .option("--acceptance <acceptance...>")
  .option("--depends-on <task...>")
  .action(async (slug, options) => {
    printData(await apiFetch(`/api/${slug}/tasks`, { method: "POST", token: "rare", signed: true, body: { ...options, depends_on: options.dependsOn ?? [] } }));
  });

const tasks = program.command("tasks");

tasks
  .command("import")
  .argument("<slug>")
  .requiredOption("--file <path>")
  .action(async (slug, options) => {
    const YAML = await import("yaml");
    const text = await import("node:fs/promises").then((fs) => fs.readFile(options.file, "utf8"));
    const parsed = YAML.parse(text);
    printData(await apiFetch(`/api/${slug}/tasks/import`, { method: "POST", token: "rare", signed: true, body: parsed }));
  });

task
  .command("next")
  .argument("<board-url>")
  .option("--type <type>")
  .option("--bundle")
  .option("--format <format>", "json or yaml", "json")
  .action(async (boardUrl, options) => {
    const { baseUrl, slug } = resolveBoardUrl(boardUrl);
    const config = { ...(await loadConfig()), baseUrl, projectSlug: slug };
    const params = new URLSearchParams();
    if (options.type) params.set("type", options.type);
    if (options.bundle) params.set("bundle", "true");
    printData(await apiFetch(`/api/${slug}/tasks/next?${params}`, { token: "rare", config }), options.format);
  });

for (const action of ["start", "done", "block", "note", "attach"] as const) {
  const cmd = task.command(action).argument("<task-id>");
  if (action === "block") cmd.requiredOption("--reason <reason>").requiredOption("--next-step <nextStep>");
  if (action === "note") cmd.requiredOption("--summary <summary>");
  if (action === "done") cmd.option("--tests <tests>");
  if (action === "attach") cmd.requiredOption("--kind <kind>").option("--external-id <id>").option("--url <url>").option("--summary <summary>");
  cmd.action(async (taskId, options) => {
    printData(await apiFetch(`/api/tasks/${taskId}/${action}`, { method: "POST", token: "rare", signed: true, body: options }));
  });
}

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
