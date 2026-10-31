import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { CONFIG_PATH } from "../lib/config";
import { PANEL_ENV, SLACK_ENV, wrappedLines } from "../lib/env-file";
import { readAppFile } from "../lib/github/app";
import { ask, askHidden, WrappedPaste } from "./prompt";

// Sets up a factory from a fresh clone of the live checkout, or finishes one that is half set up. It
// walks the README's install steps in order and skips each one that is already done, so after a
// failure you fix the cause and run it again.
//   bun scripts/setup.ts
// It asks for what only you know (your email, the Linear key and team, the panel's URL), generates
// the secrets, creates and deploys the Neon backend, runs setup-github-app, install-webhooks,
// create-owner and install-runner, pushes the panel's environment to Vercel, and ends with the doctor.

const root = join(import.meta.dirname, "..");
process.chdir(root);
const ENV_PATH = join(root, ".env.local");
const IGNORED_BUILD_STEP = '[ -z "$DATABASE_URL" ]';

class SetupError extends Error {}
// A step that stops the setup says why in one line; anything else keeps its stack.
const stop = (error: unknown) => {
  console.error(error instanceof SetupError ? `\nstopped: ${error.message}` : error);
  process.exit(1);
};
process.on("uncaughtException", stop);
process.on("unhandledRejection", stop);
const step = (title: string) => console.log(`\n== ${title}`);
const ok = (what: string) => console.log(`ok  ${what}`);

/** A command with its output shown and its prompts left to you; a failure stops the setup. */
function run(command: string, args: string[], options: { env?: Record<string, string>; input?: string } = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    input: options.input,
    stdio: [options.input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) throw new SetupError(`${command} ${args[0] ?? ""} exited ${result.status ?? result.signal}; fix it, then run this again`);
}
const read = (command: string, args: string[]) => execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const succeeds = (command: string, args: string[]) => {
  try {
    read(command, args);
    return true;
  } catch {
    return false;
  }
};
const yes = async (question: string, byDefault: boolean) => {
  const answer = (await ask(`${question} ${byDefault ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  return answer === "" ? byDefault : answer.startsWith("y");
};
/** Asks until the answer passes check, which returns what is wrong with it. */
async function askUntil(question: string, check: (value: string) => string | undefined | Promise<string | undefined>, hidden = false) {
  for (;;) {
    let value: string;
    try {
      value = hidden ? await askHidden(question) : await ask(question);
    } catch (error) {
      if (!(error instanceof WrappedPaste)) throw error;
      console.log(error.message);
      continue;
    }
    const problem = await check(value);
    if (!problem) return value;
    console.log(problem);
  }
}

const envText = () => (existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "");
const env = () => parseEnv(envText());
function setEnv(name: string, value: string) {
  const text = envText();
  writeFileSync(ENV_PATH, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${name}=${value}\n`, { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
}
const appFile = () => {
  try {
    return readAppFile();
  } catch {
    return undefined;
  }
};

async function linear(key: string, query: string, variables: object) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: key, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: unknown; errors?: unknown };
  return res.ok && !json.errors ? json.data : undefined;
}

// --- tools
step("Tools");
for (const [command, args, fix] of [
  ["git", ["--version"], "install git"],
  ["gh", ["auth", "status"], "install the GitHub CLI and run gh auth login"],
  ["neon", ["me"], "install the neon CLI and run neon auth"],
  ["vercel", ["whoami"], "install the vercel CLI and run vercel login"],
] as const) {
  if (!succeeds(command, [...args])) throw new SetupError(`${command} is missing or not signed in: ${fix}`);
}
ok("git, gh, neon and vercel are installed and signed in");

// --- .env.local
step(".env.local");
const wrapped = wrappedLines(envText());
if (wrapped.length > 0) throw new SetupError(`.env.local line ${wrapped.join(", ")} is not NAME=value: a pasted value wrapped onto it. Join it to the line above, then run this again`);
const secrets = {
  FACTORY_INGEST_SECRET: () => randomBytes(32).toString("hex"),
  LINEAR_WEBHOOK_SECRET: () => randomBytes(32).toString("hex"),
  NEON_AUTH_COOKIE_SECRET: () => randomBytes(32).toString("base64"),
};
for (const [name, generate] of Object.entries(secrets)) {
  if (env()[name]) continue;
  setEnv(name, generate());
  ok(`generated ${name}`);
}
if (!env().FACTORY_OWNER_EMAILS) {
  setEnv("FACTORY_OWNER_EMAILS", await askUntil("Your email address, the panel's owner: ", (v) => (/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(v) ? undefined : "That is not one email address.")));
}
if (!env().FACTORY_TEAM_KEY) setEnv("FACTORY_TEAM_KEY", ((await ask("The Linear team key, the prefix of its issue ids [FAC]: ")) || "FAC").toUpperCase());
if (!env().FACTORY_LABEL) setEnv("FACTORY_LABEL", (await ask("The Linear label that sends an issue to the factory [factory]: ")) || "factory");
if (!env().LINEAR_API_KEY) {
  const teamKey = env().FACTORY_TEAM_KEY!;
  const key = await askUntil(
    "A Linear personal API key (Settings → Security & access; hidden): ",
    async (v) => {
      if (!/^lin_api_\w+$/.test(v)) return "A Linear API key starts with lin_api_ and has no spaces.";
      const data = (await linear(v, `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`, { key: teamKey })) as { teams: { nodes: unknown[] } } | undefined;
      if (!data) return "Linear rejected that key.";
      return data.teams.nodes.length > 0 ? undefined : `That key works, but it sees no team ${teamKey}; fix FACTORY_TEAM_KEY in .env.local if that is wrong.`;
    },
    true,
  );
  setEnv("LINEAR_API_KEY", key);
}
if (!env().FACTORY_PANEL_URL) {
  const project = existsSync(".vercel/project.json") ? z.object({ projectName: z.string() }).safeParse(JSON.parse(readFileSync(".vercel/project.json", "utf8"))).data : undefined;
  const fallback = project ? `https://${project.projectName}.vercel.app` : undefined;
  const url = await askUntil(`The panel's URL, https://<Vercel project>.vercel.app or your own domain${fallback ? ` [${fallback}]` : ""}: `, (v) =>
    (v || fallback) && /^https:\/\/[^/\s]+\/?$/.test(v || fallback!) ? undefined : "Give an https:// URL with no path.",
  );
  setEnv("FACTORY_PANEL_URL", (url || fallback!).replace(/\/+$/, ""));
}
ok(".env.local has your values and the secrets");

// The team and label live in the runner's config too; install-webhooks reads the team from there.
const { FACTORY_TEAM_KEY: teamKey = "FAC", FACTORY_LABEL: label = "factory" } = env();
if (teamKey !== "FAC" || label !== "factory") {
  const raw = (existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {}) as { factory?: Record<string, unknown> };
  if (raw.factory?.teamKey !== teamKey || raw.factory?.label !== label) {
    raw.factory = { ...raw.factory, teamKey, label };
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    chmodSync(CONFIG_PATH, 0o600);
    ok(`config.json works on team ${teamKey}, label ${label}`);
  }
}

// --- Neon
step("Neon backend");
const linkedProject = () => (existsSync(".neon") ? z.object({ projectId: z.string() }).safeParse(JSON.parse(readFileSync(".neon", "utf8"))).data?.projectId : undefined);
if (!linkedProject()) {
  const id = await ask("A Neon project id to use (blank creates one named marshal-factory): ");
  if (id) run("neon", ["link", "--project-id", id, "--yes"]);
  else run("neon", ["link", "--project-name", "marshal-factory", "--region-id", (await ask("Its region [aws-us-east-2]: ")) || "aws-us-east-2", "--yes"]);
}
const projectId = linkedProject();
if (!projectId) throw new SetupError("this checkout is not linked to a Neon project: run neon link");
ok(`linked to Neon project ${projectId}`);
if (!env().NEON_REALTIME_URL) run("neon", ["realtime", "enable", "--branch", "main", "--allowed-origin", "*"]);

const ingestBase = () => env().NEON_FUNCTION_INGEST_BASE_URL?.replace(/\/+$/, "");
/** An empty body passes the secret check and fails validation, so ingest answers 400 and stores nothing. */
async function ingestAcceptsSecret() {
  if (!ingestBase()) return false;
  const res = await fetch(`${ingestBase()}/ingest`, {
    method: "POST",
    headers: { authorization: `Bearer ${env().FACTORY_INGEST_SECRET}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined);
  return res?.status === 400;
}
const NEON_GENERATED = ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "NEON_AUTH_BASE_URL", "NEON_REALTIME_URL", "NEON_REALTIME_SECRET", "NEON_FUNCTION_INGEST_BASE_URL"];
const deploy = !(await ingestAcceptsSecret());
if (deploy) {
  // Before the GitHub App exists its webhook secret is a placeholder, replaced once the App is created.
  run("neon", ["deploy", "--branch", "main", "--env", ".env.local", "--no-env-pull"], { env: appFile() ? {} : { GITHUB_APP_WEBHOOK_SECRET: "pending" } });
}
if (deploy || NEON_GENERATED.some((name) => !env()[name])) run("neon", ["env", "pull", "--branch", "main"]);
if (!env().NEXT_PUBLIC_NEON_REALTIME_URL && env().NEON_REALTIME_URL) setEnv("NEXT_PUBLIC_NEON_REALTIME_URL", env().NEON_REALTIME_URL!);
if (!(await ingestAcceptsSecret())) throw new SetupError("the ingest Function doesn't accept FACTORY_INGEST_SECRET after the deploy; run neon deploy --branch main --env .env.local by hand to see why");
ok("Neon Auth, Realtime and the ingest Function are deployed");
run("bun", ["run", "db:migrate"]);

// --- GitHub App
step("GitHub App");
if (!appFile()?.installation_id) run("bun", ["scripts/setup-github-app.ts"]);
const app = appFile();
if (!app?.installation_id) throw new SetupError("the GitHub App isn't installed yet: run bun scripts/setup-github-app.ts");
ok(`GitHub App ${app.slug}, installation ${app.installation_id}`);
/** A signed delivery without an id is refused with 400 after the signature check, and with 401 before it. */
async function ingestHasAppSecret() {
  const body = "{}";
  const signature = `sha256=${createHmac("sha256", app!.webhook_secret).update(body).digest("hex")}`;
  const res = await fetch(`${ingestBase()}/webhooks/github`, { method: "POST", headers: { "x-hub-signature-256": signature, "content-type": "application/json" }, body, signal: AbortSignal.timeout(20_000) });
  return res.status === 400;
}
if (!(await ingestHasAppSecret())) {
  run("neon", ["functions", "deploy", "ingest", "--branch", "main", "--src", "functions/ingest/index.ts", "--env", `GITHUB_APP_WEBHOOK_SECRET=${app.webhook_secret}`]);
  if (!(await ingestHasAppSecret())) throw new SetupError("ingest still rejects the GitHub App's webhook signature after the redeploy");
}
ok("ingest checks the App's webhook secret");

// --- Linear webhook
step("Linear webhook");
run("bun", ["scripts/install-webhooks.ts"]);

// --- Vercel
step("Vercel");
if (!existsSync(".vercel/project.json")) {
  console.log("Link this checkout to the panel's Vercel project. Create it as a Next.js project from your fork if it doesn't exist yet.");
  run("vercel", ["link"]);
}
const vercelProject = z.object({ projectId: z.string() }).parse(JSON.parse(readFileSync(".vercel/project.json", "utf8"))).projectId;
const vercelNames = (environment: string) => new Set([...read("vercel", ["env", "ls", environment]).matchAll(/^\s+([A-Z][A-Z0-9_]*)\s/gm)].map((m) => m[1]!));
// Values that aren't secret stay readable in Vercel's dashboard; the rest are Sensitive.
const READABLE = new Set(["NEON_AUTH_BASE_URL", "NEON_REALTIME_URL", "NEXT_PUBLIC_NEON_REALTIME_URL", "FACTORY_OWNER_EMAILS", "GITHUB_APP_ID", "FACTORY_TEAM_KEY", "FACTORY_LABEL", "FACTORY_PANEL_URL", "FACTORY_PRODUCTION_ENDPOINTS"]);
/** Adds each value the environment doesn't have yet; one it has is left alone, since Vercel can't show a sensitive one to compare. */
function pushEnv(environment: string, values: Record<string, string | undefined>) {
  const have = vercelNames(environment);
  const added: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (have.has(name) || !value) continue;
    run("vercel", ["env", "add", name, environment, "--yes", ...(READABLE.has(name) ? ["--no-sensitive"] : [])], { input: value });
    added.push(name);
  }
  return added;
}
const local = env();
const production = {
  ...Object.fromEntries(PANEL_ENV.map((name) => [name, local[name]])),
  GITHUB_APP_ID: String(app.id),
  GITHUB_APP_PRIVATE_KEY: app.pem,
  // The panel falls back to its Vercel domain, so it needs the URL only for a custom domain.
  ...(/\.vercel\.app$/.test(local.FACTORY_PANEL_URL ?? "") ? {} : { FACTORY_PANEL_URL: local.FACTORY_PANEL_URL }),
  ...(teamKey !== "FAC" || label !== "factory" ? { FACTORY_TEAM_KEY: teamKey, FACTORY_LABEL: label } : {}),
  ...(local.SLACK_BOT_TOKEN ? Object.fromEntries(SLACK_ENV.map((name) => [name, local[name]])) : {}),
};
const added = pushEnv("production", production);
// A preview build refuses to migrate unless it knows which endpoint is production's.
const endpoint = /@(ep-[^.]+)\./.exec(local.DATABASE_URL ?? "")?.[1]?.replace(/-pooler$/, "");
pushEnv("preview", { FACTORY_PRODUCTION_ENDPOINTS: endpoint });
ok(added.length > 0 ? `added ${added.join(", ")} to Production` : "Production has every value the panel needs");
const settings = z.object({ commandForIgnoringBuildStep: z.string().nullish() }).parse(JSON.parse(read("vercel", ["api", `/v9/projects/${vercelProject}`, "--raw"])));
if (settings.commandForIgnoringBuildStep !== IGNORED_BUILD_STEP) {
  read("vercel", ["api", `/v9/projects/${vercelProject}`, "-X", "PATCH", "-f", `commandForIgnoringBuildStep=${IGNORED_BUILD_STEP}`, "--silent"]);
  ok(`Ignored Build Step set to ${IGNORED_BUILD_STEP}, so previews without a database are skipped`);
}
const latest = z
  .object({ deployments: z.array(z.object({ uid: z.string(), readyState: z.string() })) })
  .parse(JSON.parse(read("vercel", ["api", `/v6/deployments?projectId=${vercelProject}&target=production&limit=1`, "--raw"]))).deployments[0];
if (!latest) console.log("The panel has no production deployment yet: push main to the fork Vercel deploys from, then run this again.");
else if (added.length > 0 && (await yes("Redeploy the panel so it picks up the new variables?", true))) run("vercel", ["redeploy", latest.uid, "--target", "production"]);

// --- owner
step("Owner account");
run("bun", ["scripts/create-owner.ts"]);

// --- runner
step("Runner");
if (process.platform !== "darwin") {
  console.log("The LaunchAgent is macOS only; on Linux run the runner as a container (docs/runner-container.md).");
} else {
  const plist = join(homedir(), "Library/LaunchAgents/com.marshal-factory.runner.plist");
  const current = existsSync(plist) ? /<key>WorkingDirectory<\/key><string>([^<]*)<\/string>/.exec(readFileSync(plist, "utf8"))?.[1] : undefined;
  // A disabled LaunchAgent means the runner was moved, such as into the container; a second one would share its machine id.
  const disabled = read("launchctl", ["print-disabled", `gui/${process.getuid!()}`]).includes(`"com.marshal-factory.runner" => disabled`);
  if (disabled) console.log("left the runner alone: its LaunchAgent is disabled, so it runs elsewhere, such as in the runner container");
  // The runner runs from the live checkout; a setup run from another clone mustn't move it there unasked.
  else if (current && current !== root && !(await yes(`The runner runs from ${current}. Run it from ${root} instead?`, false))) console.log(`left the runner on ${current}`);
  else run("bun", ["scripts/install-runner.ts"]);
}

// --- doctor
step("Doctor");
const doctor = spawnSync("bun", ["scripts/doctor.ts"], { cwd: root, stdio: "inherit" });
console.log(
  doctor.status === 0
    ? "\nThe factory is set up. Next, add a repo: Add repository in the panel, or bun scripts/install-target.ts <repo> (README, Add your repo)."
    : "\nThe doctor found problems above; each line says what fixes it. Run this again once they're fixed.",
);
process.exit(doctor.status ?? 1);
