import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { UPSTASH_IMAGE_PATH, type FactoryConfig, type SandboxLimits } from "../lib/config";
import type { ExecError } from "../lib/exec";
import { sandboxTokens, type RepoName } from "../lib/github/app";
import type { JobHost } from "../lib/host";
import { createSandbox, modalHost, rememberSandbox, sandboxName } from "../lib/modal-host";
import {
  BROWSER_SERVER,
  browserServer,
  CODEX_HOME,
  enabledPstack,
  FACTORY_ROOT,
  pathsOf,
  PSTACK_PLUGIN,
  readSandboxImage,
  readSlotHealth,
  REPO_DIR,
  SLOT_HEALTH_PATH,
  slotAuthMtime,
  slotAuthPath,
  slotUnusable,
  T3_PORT,
  type SandboxImage,
  type SlotHealth,
} from "../lib/sandbox";
import type { HarnessChoice } from "../lib/settings";
import { readHarnesses } from "../lib/t3-state";
import { PAIRING_TTL_MINUTES, pairingSchema, type T3Pairing } from "../lib/t3-pairing";
import { codexReportEnv } from "../lib/report-identity";
import { inTestMode } from "../lib/test-mode";
import { json, reportServer, wiredRoots, withHooks, withServer, type Json } from "../lib/target-wiring";

// A job's Modal sandbox: what it is created with and how it is set up before its thread starts.

const CLAUDE = "claudeAgent";
const CODEX = "codex";

/** Writes through a temp file and a rename, owner-only, so a reader never sees half a file. */
function writeAtomic(path: string, text: string) {
  // A regression may only write login and health files it made in the temp dir.
  if (inTestMode() && ![tmpdir(), realpathSync(tmpdir())].some((dir) => resolve(path).startsWith(`${dir}/`))) {
    throw new Error(`a regression run tried to write ${path} outside the temp dir`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
}

/** What a launch reads from this machine; regressions replace any of it. */
export const sandboxRuntime = {
  image: (): SandboxImage | null => readSandboxImage(),
  /** The Upstash base snapshot, recorded like the Modal image; its imageId is the snapshot id. */
  upstashImage: (): SandboxImage | null => readSandboxImage(UPSTASH_IMAGE_PATH),
  claudeToken: (): string | undefined => process.env.CLAUDE_CODE_OAUTH_TOKEN || undefined,
  modalToken: () => Boolean(process.env.MODAL_TOKEN_ID) || existsSync(join(homedir(), ".modal.toml")),
  upstashToken: () => Boolean(process.env.UPSTASH_BOX_API_KEY),
  githubToken: (repo: RepoName) => sandboxTokens.get(repo),
  /** The configured CODEX_HOME dirs that hold a login. */
  slots: (limits: Pick<SandboxLimits, "codexSlots">) => limits.codexSlots.filter((slot) => existsSync(slotAuthPath(slot))),
  slotAuth: (slot: string) => readFileSync(slotAuthPath(slot), "utf8"),
  writeSlotAuth: (slot: string, text: string) => writeAtomic(slotAuthPath(slot), text),
  slotAuthMtime,
  slotHealthPath: SLOT_HEALTH_PATH,
  driverOf: (provider: string) => {
    try {
      return readHarnesses().find((h) => h.id === provider)?.driver ?? provider;
    } catch {
      return provider;
    }
  },
  log: (event: string, detail: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail })),
};

/** Slots with a login that has not failed in a sandbox since it was last written. */
export function usableSlots(limits: Pick<SandboxLimits, "codexSlots">) {
  const health = readSlotHealth(sandboxRuntime.slotHealthPath);
  return sandboxRuntime.slots(limits).filter((slot) => !slotUnusable(health, slot, sandboxRuntime.slotAuthMtime(slot)));
}

/** Records that the slot's login failed; it is skipped until its auth.json changes. */
export function markSlotUnusable(slot: string, reason: string) {
  const authMtimeMs = sandboxRuntime.slotAuthMtime(slot);
  if (authMtimeMs === null) return;
  const health: SlotHealth = [
    ...readSlotHealth(sandboxRuntime.slotHealthPath).filter((h) => h.slot !== slot),
    { slot, status: "unusable", reason, at: new Date().toISOString(), authMtimeMs },
  ];
  writeAtomic(sandboxRuntime.slotHealthPath, `${JSON.stringify(health, null, 2)}\n`);
}

/** The slot's login does not work in the sandbox. */
export class CodexLoginError extends Error {
  constructor(readonly slot: string) {
    super(`the Codex login in slot ${slot} is not logged in`);
  }
}

/**
 * The sandbox has one Claude Code and one Codex instance, so a harness maps by driver. A Claude
 * Code job on a runner without a Claude token, or one on any other driver, falls back to Codex.
 */
export function sandboxHarness(harness: HarnessChoice, driver: string, hasClaude: boolean, codexModel: string): { choice: HarnessChoice; fallback?: string } {
  if (driver === CODEX) return { choice: { provider: CODEX, model: harness.model } };
  if (driver === CLAUDE && hasClaude) return { choice: { provider: CLAUDE, model: harness.model } };
  const why = driver === CLAUDE ? "this runner has no CLAUDE_CODE_OAUTH_TOKEN" : `sandboxes have no ${driver} harness`;
  return { choice: { provider: CODEX, model: codexModel }, fallback: `${harness.provider} / ${harness.model} cannot run in a sandbox (${why}); launching on ${CODEX} / ${codexModel}` };
}

/** Only a sandbox thread on Codex needs a Codex login slot; Claude Code logs in with the runner's token, in any number of sandboxes. */
export const needsCodexSlot = (provider: string | null) => provider !== CLAUDE;

export const t3Settings = (choice: HarnessChoice, hasClaude: boolean, codexHome = CODEX_HOME) => ({
  defaultModelSelection: { instanceId: choice.provider, model: choice.model },
  textGenerationModelSelection: { instanceId: choice.provider, model: choice.model },
  defaultRuntimeMode: "full-access",
  providerInstances: {
    [CODEX]: { driver: CODEX, enabled: true, config: { binaryPath: "codex", homePath: codexHome } },
    [CLAUDE]: { driver: CLAUDE, enabled: hasClaude },
  },
});

/**
 * Codex gets the factory-report server too, and has no hooks, so the server posts each report_stage
 * itself for the job its env names. It goes after the image's config, which holds the PStack
 * marketplace and plugin. An onboarding run names no job and has no ingest config, so it posts nothing.
 */
export function codexConfig(image: string | null = null, job?: { key: string; attempt: number; repo: string }) {
  const { command, args } = reportServer(FACTORY_ROOT);
  const env = Object.entries(job ? codexReportEnv(job) : { FACTORY_REPORTER: "mcp" }).map(([name, value]) => `${name} = ${JSON.stringify(value)}`);
  const servers =
    `[mcp_servers.factory-report]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\nenv = { ${env.join(", ")} }\n` +
    `\n[mcp_servers.${BROWSER_SERVER}]\ncommand = ${JSON.stringify(browserServer.command)}\nargs = ${JSON.stringify(browserServer.args)}\n`;
  return image?.trim() ? `${image.trimEnd()}\n\n${servers}` : servers;
}

/** Whether the sandbox's claude has PStack enabled; a launch without it only warns. */
async function pstackEnabled(host: JobHost) {
  try {
    return enabledPstack((await host.run("claude", ["plugin", "list", "--json"], { timeoutMs: 30_000 })).stdout) !== null;
  } catch {
    return false;
  }
}

/** Just what the hooks read: where to report. */
export const ingestConfig = (config: Pick<FactoryConfig, "ingestUrl" | "secret">) => json({ ingestUrl: config.ingestUrl, secret: config.secret });

/** Secrets the sandbox's processes see as environment variables; never an API key that would bill per token. */
export const sandboxSecrets = (claudeToken: string | undefined): Record<string, string> =>
  claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeToken } : {};

const sh = async (host: JobHost, script: string, timeoutMs = 60_000) => (await host.run("bash", ["-c", script], { timeoutMs })).stdout;

async function writeSecretFile(host: JobHost, path: string, text: string) {
  await host.writeFile(path, text);
  await host.run("chmod", ["600", path], { timeoutMs: 30_000 });
}

/** Whether a CLI's login check exits zero; any other exit means it is not logged in. Output is never kept. */
async function loggedIn(host: JobHost, command: string, args: string[]) {
  try {
    await host.run(command, args, { timeoutMs: 30_000 });
    return true;
  } catch (error) {
    if (typeof (error as ExecError).code === "number") return false;
    throw error;
  }
}

/**
 * The GitHub token the image's git credential helper and gh wrapper read. Rewriting it is all a
 * token refresh takes: nothing caches it, and it is never in the environment.
 */
export const writeGithubToken = (host: JobHost, token: string) => writeSecretFile(host, pathsOf(host).githubToken, token);

/** Puts the slot's login in the sandbox and checks Codex accepts it; CodexLoginError when it does not. */
export async function installCodexLogin(host: JobHost, slot: string, auth: string) {
  const { codexHome, codexAuth } = pathsOf(host);
  await host.run("mkdir", ["-p", codexHome], { timeoutMs: 30_000 });
  await host.run("chmod", ["700", codexHome], { timeoutMs: 30_000 });
  await writeSecretFile(host, codexAuth, auth);
  if (!(await loggedIn(host, "codex", ["login", "status"]))) throw new CodexLoginError(slot);
}

export type CodexLogin = { slot: string; auth: string };

export type SandboxSetup = {
  repo: string;
  choice: HarnessChoice;
  hasClaude: boolean;
  /** A leased slot's Codex login; null for a Claude Code job, which holds none. */
  codex: CodexLogin | null;
  /** Leases a slot when a job without one falls back to Codex; undefined when none is free. */
  leaseCodex?: () => Promise<CodexLogin | undefined>;
  githubToken: string;
  /** The hooks' ingest config; null for an onboarding run, which reports to no job. */
  ingest: string | null;
  /** The job the sandbox runs, which Codex's report server posts for; absent for an onboarding run. */
  job?: { key: string; attempt: number };
  /** Set when the sandbox starts from the repo's warm image, which has the repo at REPO_DIR already. */
  warm?: { setup: readonly string[] };
};

const WARM_SETUP_TIMEOUT_MS = 180_000;

/**
 * A warm image has the repo cloned at the commit it was built from: bring it to origin/main and run
 * the recipe's setup again, which only adds what changed since. A setup that fails or runs long is
 * logged and the launch goes on; the thread's own worktree installs what it needs.
 */
async function refreshWarmCheckout(host: JobHost, repo: string, setup: readonly string[]) {
  await host.run("git", ["-C", REPO_DIR, "fetch", "--quiet", "origin", "--prune"], { timeoutMs: 120_000 });
  await host.run("git", ["-C", REPO_DIR, "checkout", "--quiet", "-B", "main", "origin/main"], { timeoutMs: 60_000 });
  const started = Date.now();
  for (const command of setup) {
    const left = WARM_SETUP_TIMEOUT_MS - (Date.now() - started);
    if (left <= 0) break;
    try {
      await host.run("bash", ["-c", command], { cwd: REPO_DIR, timeoutMs: left });
    } catch (error) {
      sandboxRuntime.log("sandbox:warm-setup-failed", { repo, command, error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
      return;
    }
  }
}

/**
 * Every step before the thread: logins, T3 and Codex settings, the clone, the wiring, a serving T3.
 * Files go through the host's file API, so no secret ever appears in a command line. A Claude Code
 * job whose token the sandbox's claude does not accept falls back to Codex, as one without a token
 * does; the harness it runs on comes back.
 */
export async function setupSandbox(host: JobHost, setup: SandboxSetup, codexModel: string): Promise<{ choice: HarnessChoice; fallback?: string }> {
  const paths = pathsOf(host);
  await host.run("mkdir", ["-p", paths.t3Userdata, "/work"], { timeoutMs: 30_000 });
  if (setup.codex) await installCodexLogin(host, setup.codex.slot, setup.codex.auth);
  let { choice, hasClaude } = setup;
  let fallback: string | undefined;
  if (choice.provider === CLAUDE && !(await loggedIn(host, "claude", ["auth", "status"]))) {
    fallback = `claude in the sandbox is not logged in with this runner's CLAUDE_CODE_OAUTH_TOKEN; launching on ${CODEX} / ${codexModel}`;
    choice = { provider: CODEX, model: codexModel };
    hasClaude = false;
    if (!setup.codex) {
      const codex = await setup.leaseCodex?.();
      if (!codex) throw new Error(`${fallback}, but no Codex login slot is free`);
      await installCodexLogin(host, codex.slot, codex.auth);
    }
  }
  await host.writeFile(`${paths.codexHome}/config.toml`, codexConfig(await host.readFile(`${paths.codexHome}/config.toml`), setup.job && { ...setup.job, repo: setup.repo }));
  await host.writeFile(`${paths.t3Userdata}/settings.json`, json(t3Settings(choice, hasClaude, paths.codexHome)));
  if (setup.ingest !== null) await writeSecretFile(host, paths.ingestConfig, setup.ingest);
  await writeGithubToken(host, setup.githubToken);
  if (setup.warm) await refreshWarmCheckout(host, setup.repo, setup.warm.setup);
  else await host.run("git", ["clone", "--quiet", `https://github.com/${setup.repo}.git`, REPO_DIR], { timeoutMs: 300_000 });
  await wire(host);
  if (!(await pstackEnabled(host))) sandboxRuntime.log("sandbox:no-pstack", { repo: setup.repo, plugin: PSTACK_PLUGIN });
  await startT3(host);
  await host.run(host.t3, ["project", "add", REPO_DIR, "--title", setup.repo.split("/").pop()!], { timeoutMs: 60_000 });
  return { choice, ...(fallback && { fallback }) };
}

/**
 * T3 cuts each thread's worktree from origin/main, so the repo's committed wiring is what the
 * thread sees. Its factory paths are this runner's checkout; each one becomes a link to the
 * sandbox's copy. User-level wiring covers a repo that commits none.
 */
async function wire(host: JobHost) {
  const committed = wiredRoots(await host.readFile(`${REPO_DIR}/.claude/settings.json`), await host.readFile(`${REPO_DIR}/.mcp.json`));
  for (const root of committed.filter((r) => r !== FACTORY_ROOT)) {
    await host.run("mkdir", ["-p", root.slice(0, root.lastIndexOf("/")) || "/"], { timeoutMs: 30_000 });
    await host.run("ln", ["-sfn", FACTORY_ROOT, root], { timeoutMs: 30_000 });
  }
  const parse = (text: string | null): Json => (text ? (JSON.parse(text) as Json) : {});
  const userSettings = `${pathsOf(host).home}/.claude/settings.json`;
  const userConfig = `${pathsOf(host).home}/.claude.json`;
  await host.writeFile(userSettings, json(withHooks(parse(await host.readFile(userSettings)), FACTORY_ROOT)));
  const config = withServer(parse(await host.readFile(userConfig)), FACTORY_ROOT);
  const mcpServers = { ...(config.mcpServers as Json), [BROWSER_SERVER]: browserServer };
  await host.writeFile(userConfig, json({ ...config, mcpServers, hasCompletedOnboarding: true }));
}

const t3Runtime = (host: JobHost) => `${pathsOf(host).t3Userdata}/server-runtime.json`;

/**
 * Started from an exec, `t3 serve` outlives it. Its log holds a pairing token, so it is never read
 * back. A sandbox woken from a snapshot still has the last server's runtime file, so it goes first.
 * It listens on every interface so the sandbox's encrypted tunnel reaches it; T3 refuses any client
 * that has not paired, so the open port grants nothing without a pairing token.
 */
export async function startT3(host: JobHost) {
  await host.remove(t3Runtime(host));
  await sh(host, `nohup ${host.t3} serve --host 0.0.0.0 --port ${T3_PORT} ${REPO_DIR} > /work/t3.log 2>&1 &`);
  for (let i = 0; i < 60; i++) {
    if (await host.exists(t3Runtime(host))) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("t3 serve did not become ready in the sandbox within 120 s");
}

/**
 * Mints a one-time T3 pairing link on `baseUrl`, the sandbox's tunnel. The CLI's output holds the
 * token, so neither it nor a parse failure's text is ever logged or thrown.
 */
export async function pairT3(host: JobHost, baseUrl: string): Promise<T3Pairing> {
  const { stdout } = await host.run(
    host.t3,
    ["auth", "pairing", "create", "--ttl", `${PAIRING_TTL_MINUTES}m`, "--label", "panel", "--base-url", baseUrl, "--json"],
    { timeoutMs: 60_000 },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("t3 auth pairing create printed no JSON");
  }
  const pairing = pairingSchema.safeParse(parsed);
  if (!pairing.success) throw new Error("t3 auth pairing create printed no pairing link");
  return { pairUrl: pairing.data.pairUrl, expiresAt: pairing.data.expiresAt };
}

/** Ends `t3 serve` so its SQLite state is on disk before a snapshot; a server already down is fine. */
export async function stopT3(host: JobHost) {
  // The bracket keeps the pattern from matching this script's own command line.
  const server = "[t]3 serve";
  await sh(host, `pkill -TERM -f '${server}'; for i in $(seq 1 20); do pgrep -f '${server}' >/dev/null || exit 0; sleep 0.5; done; pkill -KILL -f '${server}'; exit 0`);
}

/**
 * Creates the job's sandbox, from the image or from its hibernation snapshot; its id must be
 * recorded on the job before anything else runs in it.
 */
export async function createJobSandbox({ key, attempt, label, machineId, imageId, limits, claudeToken, namedSecrets = [] }: {
  key: string;
  attempt: number;
  label: string;
  machineId: string;
  imageId: string;
  limits: SandboxLimits;
  claudeToken: string | undefined;
  /** The repo's Modal secret, when its recipe's env vars have values saved. */
  namedSecrets?: string[];
}) {
  const sandbox = await createSandbox({
    name: sandboxName(key, attempt),
    tags: { job: key, attempt: String(attempt), label, machine: machineId },
    imageId,
    secrets: sandboxSecrets(claudeToken),
    namedSecrets,
    // Claude Code refuses full access as root unless told it is in a sandbox.
    env: { IS_SANDBOX: "1" },
    encryptedPorts: [T3_PORT],
    limits,
  });
  rememberSandbox(sandbox);
  return { sandboxId: sandbox.sandboxId, host: modalHost(sandbox.sandboxId) };
}
