import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { parseEnv, promisify } from "node:util";
import { sql } from "drizzle-orm";
import { z } from "zod";

// Checks a factory end to end and changes nothing: the tools, the files setup writes, the database,
// ingest, Linear, the GitHub App, Vercel, Neon Auth and the runner. Each line says what is wrong and
// what fixes it; the exit code is 1 when anything failed. Run it from the live checkout after setup
// or when something stops working.
//   bun scripts/doctor.ts

const root = join(import.meta.dirname, "..");
process.chdir(root);
const ENV_PATH = join(root, ".env.local");
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const { loadConfig } = await import("../lib/config");
const { PANEL_ENV, SLACK_ENV, wrappedLines } = await import("../lib/env-file");
const { readIngestTarget } = await import("../lib/outbox");
const { appJwt, GITHUB_API, githubRequest, readAppFile } = await import("../lib/github/app");
const { panelUrl, redact, secretValues } = await import("../lib/slack");
const { ONLINE_WINDOW_MS } = await import("../lib/machine");
const { readSettings, resolveExecution } = await import("../lib/settings");
const { sandboxReadiness } = await import("../lib/sandbox");

const exec = promisify(execFile);
const run = async (command: string, args: string[]) => (await exec(command, args, { cwd: root, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
const runs = (command: string, args: string[]) => run(command, args).then(() => true, () => false);

type Outcome = { status: "ok" | "warn" | "fail" | "skip"; detail: string };
const ok = (detail: string): Outcome => ({ status: "ok", detail });
const warn = (detail: string): Outcome => ({ status: "warn", detail });
const fail = (detail: string): Outcome => ({ status: "fail", detail });
const skip = (detail: string): Outcome => ({ status: "skip", detail });

const config = (() => {
  try {
    return loadConfig();
  } catch {
    return undefined;
  }
})();
const app = (() => {
  try {
    return readAppFile();
  } catch {
    return undefined;
  }
})();
// Nothing this prints may hold a secret, whatever an error message quotes.
const secrets = [...secretValues(process.env), config?.secret ?? "", config?.linearApiKey ?? "", app?.pem ?? "", app?.webhook_secret ?? ""];

const LABELS = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" } as const;
const tally = { ok: 0, warn: 0, fail: 0, skip: 0 };
async function check(name: string, body: () => Outcome | Promise<Outcome>) {
  let outcome: Outcome;
  try {
    outcome = await body();
  } catch (error) {
    outcome = fail(error instanceof Error ? error.message : String(error));
  }
  tally[outcome.status]++;
  console.log(`${LABELS[outcome.status]}  ${name}: ${redact(outcome.detail, secrets).split("\n")[0]}`);
}

const section = (title: string) => console.log(`\n${title}`);

// --- tools
section("Tools");
await check("bun", () => {
  const pinned = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { packageManager?: string }).packageManager?.replace(/^bun@/, "");
  const version = process.versions.bun ?? "unknown";
  return !pinned || version === pinned ? ok(version) : warn(`${version}, but package.json pins ${pinned}; bun install would rewrite bun.lock`);
});
await check("git", async () => ok((await run("git", ["--version"])).trim()));
await check("GitHub CLI", async () => ((await runs("gh", ["auth", "status"])) ? ok("signed in") : fail("not installed or not signed in: run gh auth login")));
await check("neon CLI", async () => ok((await run("neon", ["--version"])).trim()));
await check("vercel CLI", async () => ((await runs("vercel", ["--version"])) ? ok("installed") : warn("not installed; the Vercel checks below are skipped")));

// --- files
section("Files");
const REQUIRED_ENV = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "NEON_AUTH_BASE_URL",
  "NEON_AUTH_COOKIE_SECRET",
  "NEON_REALTIME_URL",
  "NEXT_PUBLIC_NEON_REALTIME_URL",
  "NEON_REALTIME_SECRET",
  "NEON_FUNCTION_INGEST_BASE_URL",
  "FACTORY_INGEST_SECRET",
  "LINEAR_WEBHOOK_SECRET",
  "LINEAR_API_KEY",
  "FACTORY_OWNER_EMAILS",
];
await check(".env.local", () => {
  if (!existsSync(ENV_PATH)) return fail("missing: create it as in README step 4");
  const text = readFileSync(ENV_PATH, "utf8");
  const broken = wrappedLines(text);
  if (broken.length > 0) return fail(`line ${broken.join(", ")} is not NAME=value; a pasted value may have wrapped onto it`);
  const env = parseEnv(text);
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length > 0) return fail(`missing ${missing.join(", ")}`);
  if (statSync(ENV_PATH).mode & 0o077) return warn("readable by other users: chmod 600 .env.local");
  return ok(`${Object.keys(env).length} values`);
});
await check(".neon", () => {
  const projectId = existsSync(join(root, ".neon")) ? z.object({ projectId: z.string() }).safeParse(JSON.parse(readFileSync(join(root, ".neon"), "utf8"))).data?.projectId : undefined;
  return projectId ? ok(`project ${projectId}`) : fail("missing or names no project: run neon init --no-agent-setup");
});
await check("runner config", () => {
  loadConfig();
  return ok(`team ${config!.factory.teamKey}, label ${config!.factory.label}`);
});
await check("reporter config", () => {
  if (!config) return skip("the runner config does not load");
  const target = readIngestTarget();
  if (!target) return fail("the hooks find no ingest URL and secret, so runs report nothing");
  if (target.ingestUrl !== config.ingestUrl || target.secret !== config.secret) return fail("the hooks and the runner disagree on the ingest URL or secret");
  return ok("the hooks report where the runner does");
});
await check("GitHub App file", () => {
  readAppFile();
  return ok(`${app!.slug}, installation ${app!.installation_id ?? "unknown"}`);
});

// --- services
section("Services");
// db/client connects on import, so it loads only when there is a database to reach.
const dbReady = Boolean(process.env.DATABASE_URL);
const db = dbReady ? (await import("../db/client")).db : undefined;
await check("database", async () => {
  if (!db) return skip("no DATABASE_URL");
  const journal = z.object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) }).parse(JSON.parse(readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8")));
  const applied = await db.execute<{ last: string | null }>(sql`select max(created_at)::text as last from drizzle.__drizzle_migrations`);
  const last = Number(applied.rows[0]?.last ?? 0);
  const pending = journal.entries.filter((entry) => entry.when > last);
  return pending.length === 0 ? ok(`reachable, all ${journal.entries.length} migrations applied`) : fail(`${pending.length} migrations pending (${pending[0]!.tag}…): run bun run db:migrate`);
});
await check("repositories", async () => {
  if (!db) return skip("no DATABASE_URL");
  const rows = await db.execute<{ repo: string }>(sql`select repo from repo_settings where enabled`);
  const count = rows.rows.length;
  return count > 0 ? ok(`${count} enabled`) : warn("none enabled, so no job is claimed: Add repository in the panel, or run bun scripts/install-target.ts <repo>");
});
await check("ingest", async () => {
  if (!config) return skip("the runner config does not load");
  // An empty object fails validation after the secret is checked, so ingest stores nothing.
  const res = await fetch(config.ingestUrl, { method: "POST", headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(20_000) });
  if (res.status === 400) return ok("reachable, secret accepted");
  if (res.status === 401) return fail("secret rejected: FACTORY_INGEST_SECRET differs from the Function's; redeploy it as in README step 4");
  return fail(`answered ${res.status}: deploy the Function as in README step 4`);
});

async function linear<T>(query: string, variables: object, schema: z.ZodType<T>) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: config!.linearApiKey, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: unknown; errors?: { message?: string }[] };
  if (!res.ok || json.errors) throw new Error(`Linear answered ${res.status}${json.errors?.[0]?.message ? `: ${json.errors[0].message}` : ""}`);
  return schema.parse(json.data);
}
await check("Linear", async () => {
  if (!config) return skip("the runner config does not load");
  const { teamKey, label } = config.factory;
  const data = await linear(
    `query($key: String!, $label: String!) {
      viewer { name }
      teams(filter: { key: { eq: $key } }) { nodes { id } }
      issueLabels(filter: { name: { eq: $label } }) { nodes { team { key } } }
    }`,
    { key: teamKey, label },
    z.object({
      viewer: z.object({ name: z.string() }),
      teams: z.object({ nodes: z.array(z.object({ id: z.string() })) }),
      issueLabels: z.object({ nodes: z.array(z.object({ team: z.object({ key: z.string() }).nullable() })) }),
    }),
  );
  if (data.teams.nodes.length === 0) return fail(`the key works (${data.viewer.name}), but there is no team ${teamKey}`);
  if (!data.issueLabels.nodes.some((node) => node.team === null || node.team.key === teamKey)) return fail(`team ${teamKey} has no label ${label}: create it in Linear`);
  return ok(`key works (${data.viewer.name}), team ${teamKey} has label ${label}`);
});
await check("Linear webhook", async () => {
  if (!config) return skip("the runner config does not load");
  const id = config.factory.webhooks.linear;
  if (!id) return fail("none recorded: run bun scripts/install-webhooks.ts");
  const { webhooks } = await linear(
    `{ webhooks(first: 100) { nodes { id url enabled } } }`,
    {},
    z.object({ webhooks: z.object({ nodes: z.array(z.object({ id: z.string(), url: z.string(), enabled: z.boolean() })) }) }),
  );
  const hook = webhooks.nodes.find((node) => node.id === String(id));
  const url = `${config.ingestUrl.replace(/\/ingest$/, "")}/webhooks/linear`;
  if (!hook) return fail(`webhook ${id} is gone: run bun scripts/install-webhooks.ts`);
  if (hook.url !== url) return fail(`webhook points at ${hook.url}, not ingest: run bun scripts/install-webhooks.ts`);
  return hook.enabled ? ok("points at ingest") : fail("disabled: enable it under Linear → Settings → API");
});
await check("GitHub App", async () => {
  if (!app) return skip("no app file");
  const jwt = appJwt(app);
  await githubRequest(GITHUB_API, jwt, "GET", "/app");
  const { json } = await githubRequest(GITHUB_API, jwt, "GET", "/app/installations");
  const installations = z.array(z.object({ id: z.number(), repository_selection: z.string() })).parse(json);
  const installation = installations.find((i) => i.id === app.installation_id) ?? installations[0];
  if (!installation) return fail("not installed anywhere: install it from its GitHub settings page");
  if (installation.repository_selection === "all") return warn("installed on all your repos; consider narrowing it to the repos the factory works in");
  return ok("key works, installed on selected repos");
});

const vercelLinked = existsSync(join(root, ".vercel/project.json"));
const vercelNames = async (environment: string) =>
  new Set([...(await run("vercel", ["env", "ls", environment])).matchAll(/^\s+([A-Z][A-Z0-9_]*)\s/gm)].map((m) => m[1]!));
await check("Vercel env", async () => {
  if (!vercelLinked) return skip("this checkout is not linked to a Vercel project: run vercel link");
  if (!(await runs("vercel", ["--version"]))) return skip("no vercel CLI");
  const needed = [...PANEL_ENV, ...(process.env.SLACK_BOT_TOKEN ? SLACK_ENV : [])];
  const production = await vercelNames("production");
  const missing = needed.filter((name) => !production.has(name));
  if (missing.length > 0) return fail(`Production is missing ${missing.join(", ")} (README step 8)`);
  if (!(await vercelNames("preview")).has("FACTORY_PRODUCTION_ENDPOINTS")) return warn("Preview has no FACTORY_PRODUCTION_ENDPOINTS, so previews refuse to migrate");
  return ok(`Production has all ${needed.length} values`);
});
await check("panel", async () => {
  const res = await fetch(panelUrl(), { redirect: "manual", signal: AbortSignal.timeout(20_000) });
  return res.status < 500 ? ok(`${panelUrl()} answers ${res.status}`) : fail(`${panelUrl()} answers ${res.status}`);
});
await check("Neon Auth domain", async () => {
  const projectId = z.object({ projectId: z.string() }).parse(JSON.parse(readFileSync(join(root, ".neon"), "utf8"))).projectId;
  const domains = z.array(z.object({ domain: z.string() })).parse(JSON.parse(await run("neon", ["neon-auth", "domain", "list", "--branch", "main", "--project-id", projectId, "--output", "json"])));
  return domains.some((d) => d.domain.replace(/\/+$/, "") === panelUrl())
    ? ok(`trusts ${panelUrl()}`)
    : fail(`does not trust ${panelUrl()}, so sign-up fails with "Invalid origin": run neon neon-auth domain add ${panelUrl()} --branch main`);
});

// --- runner
section("Runner");
// The label scripts/install-runner.ts gives the LaunchAgent; importing it would run the installer.
const LABEL = "com.marshal-factory.runner";
await check("LaunchAgent", async () => {
  if (process.platform !== "darwin") return skip("the runner installs only on macOS");
  return (await runs("launchctl", ["print", `gui/${userInfo().uid}/${LABEL}`])) ? ok(`${LABEL} is loaded`) : fail("not loaded: run bun scripts/install-runner.ts");
});
await check("heartbeat", async () => {
  if (!config || !db) return skip("no config or database");
  const { identify } = await import("../runner/heartbeat");
  const machine = await identify(config.factory.machineId);
  const rows = await db.execute<{ last_seen_at: Date }>(sql`select last_seen_at from machines where id = ${machine.id}`);
  const seen = rows.rows[0]?.last_seen_at;
  if (!seen) return fail(`${machine.name} has never reported: check ~/Library/Logs/marshal-factory/runner.log`);
  const ago = Math.round((Date.now() - new Date(seen).getTime()) / 1000);
  return ago * 1000 <= ONLINE_WINDOW_MS ? ok(`${machine.name} reported ${ago}s ago`) : fail(`${machine.name} last reported ${ago}s ago: check ~/Library/Logs/marshal-factory/runner.log`);
});
await check("jobs run on", async () => {
  if (!config || !db) return skip("no config or database");
  const execution = resolveExecution(await readSettings(db));
  if (execution === "local") {
    const t3 = process.env.T3CODE_CLI_PATH ?? join(homedir(), ".t3/bin/t3");
    return existsSync(t3) || (await runs("which", ["t3"])) ? ok("this Mac's T3") : fail("this Mac's T3, but there is no t3 CLI: install T3 Code or pick a cloud in Settings");
  }
  const ready = sandboxReadiness(config.factory.sandbox);
  const harness = ready.claude ? "Claude Code" : ready.codexSlots > 0 ? "Codex only (no CLAUDE_CODE_OAUTH_TOKEN)" : undefined;
  if (execution === "upstash") {
    if (!ready.upstash) return fail("Upstash Box, but there is no UPSTASH_BOX_API_KEY");
    if (!ready.upstashImageInfo) return fail("Upstash Box, but no snapshot: run bun scripts/sandbox-image.ts --backend upstash");
  } else {
    if (!ready.modal) return fail("Modal, but there is no Modal token: run modal token new");
    if (!ready.image) return fail("Modal, but no image: run bun scripts/sandbox-image.ts");
  }
  return harness ? ok(`${execution}, ${harness}`) : fail(`${execution}, but no harness can run: add CLAUDE_CODE_OAUTH_TOKEN or a Codex login`);
});

console.log(`\n${tally.fail} failed, ${tally.warn} warnings, ${tally.ok} ok${tally.skip ? `, ${tally.skip} skipped` : ""}`);
process.exit(tally.fail > 0 ? 1 : 0);
