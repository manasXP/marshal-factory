import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ModalClient } from "modal";
import { z } from "zod";
import { SANDBOX_IMAGE_PATH, type SandboxLimits } from "./config";
import { imageDrift, rebuildText, type ImageVersions } from "./machine";
import type { SandboxHandle } from "./modal-host";
import { commandLine, exitCodeOf, PINNED_TOOLS_FIRST, shellQuote, upstash, upstashId, type UpstashBox } from "./upstash-host";
import {
  enabledPstack,
  FACTORY_ROOT,
  IMAGE_BUNDLES,
  installPlaybooks,
  parseVersion,
  pinnedVersions,
  PLAYBOOK_FILES,
  PSTACK_DIR,
  PSTACK_PLUGIN,
  pstackVersion,
  REPO_DIR,
  SANDBOX_HOME,
  SANDBOX_PLAYBOOKS,
  sandboxPaths,
  UPSTASH_HOME,
  type SandboxImage,
} from "./sandbox";
import { forbidInTest } from "./test-mode";

// Builds the image factory sandboxes launch from, and records its id for the runner. The CLI
// (scripts/sandbox-image.ts) and the runner, when its pins drift from the stored image, both call it.
// The base layers come from Dockerfile commands and Modal caches them. The factory's hook and MCP
// entry points are bundled here with Bun, one self-contained file each at the path the wiring
// names, so the sandbox needs no checkout and no install; `factory-verify` on PATH runs
// hooks/verify.ts. A sandbox from the base gets those files and the factory's playbooks,
// and its filesystem snapshot, kept indefinitely, is the image. T3, Claude Code, Codex, Playwright MCP and PStack
// install at the versions factory.sandbox pins, and the build fails unless the sandbox reports
// exactly those, holds this checkout's playbooks and runs the hook bundles; only then is the new
// image id written, so a failed build leaves the old image in place.

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");

const b64 = (text: string) => Buffer.from(text).toString("base64");
const install = (path: string, text: string) => `RUN echo ${b64(text)} | base64 -d > ${path} && chmod 755 ${path}`;

// The job's GitHub token lives in one file under the sandbox's home, so a refresh is a rewrite; git and gh both read it per call.
const credentialHelper = (tokenPath: string) => `#!/bin/sh
test "$1" = get || exit 0
echo username=x-access-token
echo "password=$(cat ${tokenPath})"
`;
const ghWrapper = (tokenPath: string) => `#!/bin/sh
GH_TOKEN="$(cat ${tokenPath} 2>/dev/null)" exec /usr/bin/gh "$@"
`;
const verifyWrapper = `#!/bin/sh
exec bun ${FACTORY_ROOT}/hooks/verify.ts "$@"
`;

export type BuildLimits = Pick<SandboxLimits, "appName" | "t3Version" | "claudeCodeVersion" | "codexVersion" | "playwrightMcpVersion" | "pstack">;
type Log = (message: string) => void;
/** Starts the build sandbox from the base layers; regressions pass a fake one. */
export type OpenBuildSandbox = (limits: BuildLimits, log: Log) => Promise<SandboxHandle>;

/** The Dockerfile commands for the base layers, at the pinned versions, for a sandbox whose home is `home`. */
export const baseLayers = (limits: BuildLimits, home = SANDBOX_HOME) => [
  "RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates procps unzip && rm -rf /var/lib/apt/lists/*",
  "RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg" +
    ' && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list' +
    " && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*",
  "RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash",
  `RUN curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION=${limits.t3Version} T3CODE_INSTALL_BIN_DIR=/usr/local/bin sh`,
  `RUN npm i -g @anthropic-ai/claude-code@${limits.claudeCodeVersion} @openai/codex@${limits.codexVersion}`,
  // The playwright CLI bundled with the pinned package installs the Chromium that exact version drives, with its OS libraries.
  `RUN npm i -g @playwright/mcp@${limits.playwrightMcpVersion} && cd "$(npm root -g)/@playwright/mcp" && npx --no-install playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*`,
  // Neither CLI pins a marketplace to a commit, so each adds the checkout as a local marketplace.
  `RUN git init -q ${PSTACK_DIR} && git -C ${PSTACK_DIR} fetch -q --depth 1 https://github.com/${limits.pstack.repo}.git ${limits.pstack.commit}` +
    ` && git -C ${PSTACK_DIR} checkout -q FETCH_HEAD` +
    ` && claude plugin marketplace add ${PSTACK_DIR} && claude plugin install ${PSTACK_PLUGIN}` +
    ` && codex plugin marketplace add ${PSTACK_DIR} && codex plugin add ${PSTACK_PLUGIN}`,
  install("/usr/local/bin/git-credential-factory", credentialHelper(sandboxPaths(home).githubToken)),
  install("/usr/local/bin/gh", ghWrapper(sandboxPaths(home).githubToken)),
  install("/usr/local/bin/factory-verify", verifyWrapper),
  "RUN git config --global user.name marshal-factory && git config --global user.email marshal-factory@users.noreply.github.com" +
    " && git config --global credential.https://github.com.helper factory && git config --global init.defaultBranch main",
];

export const openModalBuildSandbox: OpenBuildSandbox = async (limits, log) => {
  forbidInTest("Modal");
  const modal = new ModalClient();
  try {
    const app = await modal.apps.fromName(limits.appName, { createIfMissing: true });
    // The caller holds this machine's build lock, so a build sandbox of this machine still running
    // was left by a build that stopped mid-create; it is ended rather than billed until its timeout.
    const tags = { purpose: "image-build", host: hostname() };
    for await (const left of modal.sandboxes.list({ appId: app.appId, tags })) {
      log(`ending build sandbox ${left.sandboxId}, left by an earlier build`);
      await left.terminate().catch((error: unknown) => log(`could not end ${left.sandboxId}: ${String(error)}`));
    }
    const base = modal.images.fromRegistry("node:22-bookworm").dockerfileCommands(baseLayers(limits));
    log("building the base image (the first build takes a few minutes)");
    const sandbox = await modal.sandboxes.create(app, base, {
      name: `image-build-${Date.now()}`,
      tags,
      runtime: "gvisor",
      timeoutMs: 20 * 60_000,
      command: ["sleep", "infinity"],
    });
    // The client goes with the sandbox, so a runner building again later opens a fresh one.
    const terminate = sandbox.terminate.bind(sandbox);
    return Object.assign(sandbox, { terminate: () => terminate().finally(() => modal.close()) });
  } catch (error) {
    modal.close();
    throw error;
  }
};

/** An Upstash box's persistent volume, which ~/.claude and ~/.codex link into. */
const UPSTASH_WORKSPACE = "/workspace/home";

/** How long a base layer may take in a box; Chromium with its OS libraries is the slowest. */
const UPSTASH_LAYER_MS = 20 * 60_000;

/** A finished command in a box, or a throw that names the step; `root` runs it as root with boxuser's home, as Modal's layers run as root in theirs. */
async function boxSh(box: UpstashBox, script: string, { root = false, timeoutMs = UPSTASH_LAYER_MS } = {}) {
  const run = root ? ["sudo", "-H", "env", `HOME=${UPSTASH_HOME}`, "bash", "-c", script] : ["bash", "-c", script];
  const result = await box.exec.command(commandLine(run[0]!, run.slice(1), { timeoutMs }));
  const code = exitCodeOf(result);
  if (code !== 0) throw new Error(`${script.slice(0, 200)} exited ${code}: ${result.stderr.trim().slice(-500)}`);
  return result.stdout;
}

/** Snapshots finish in the background; a box can start from one only once it is ready. */
async function readySnapshot(box: UpstashBox, timeoutMs = 15 * 60_000) {
  const { id } = await box.snapshot({ name: `marshal-factory-base-${Date.now()}` });
  for (const started = Date.now(); Date.now() - started < timeoutMs; await new Promise((r) => setTimeout(r, 5_000))) {
    const status = (await box.listSnapshots()).find((s) => s.id === id)?.status;
    if (status === "ready") return id;
    if (status === "error" || status === "deleted") throw new Error(`snapshot ${id} ended ${status}`);
  }
  throw new Error(`snapshot ${id} was not ready within ${timeoutMs / 60_000} minutes`);
}

/**
 * The base layers in a fresh Upstash box. A box runs as boxuser, and its /root is a noexec tmpfs
 * emptied at every start, so the layers run as root with boxuser's home (UPSTASH_HOME), and that home
 * and the factory's directories are then handed to boxuser.
 */
export const openUpstashBuildSandbox: OpenBuildSandbox = async (limits, log) => {
  forbidInTest("Upstash");
  // The caller holds this machine's build lock, so a build box of this machine still there was left
  // by a build that stopped mid-way (Ctrl-C skips its cleanup); it is ended rather than kept.
  const machine = `b:${createHash("sha256").update(hostname()).digest("hex").slice(0, 12)}`;
  for (const left of await upstash.api.list(machine)) {
    if (left.status === "deleted") continue;
    log(`ending build box ${left.id}, left by an earlier build`);
    await (await upstash.api.get(left.id)).delete().catch((error: unknown) => log(`could not end ${left.id}: ${String(error)}`));
  }
  const box = await upstash.api.create({ name: `image-build-${Date.now()}`, labels: ["mf:image-build", machine], env: {} });
  try {
    log("building the Upstash base snapshot (the first build takes a few minutes)");
    for (const layer of baseLayers(limits, UPSTASH_HOME)) await boxSh(box, layer.replace(/^RUN /, ""), { root: true });
    // Upstash links ~/.claude and ~/.codex into /workspace/home, its persistent volume, which a chown of the home does not follow.
    const owned = [UPSTASH_HOME, UPSTASH_WORKSPACE, PSTACK_DIR, FACTORY_ROOT, dirname(REPO_DIR)];
    await boxSh(box, `mkdir -p ${owned.map(shellQuote).join(" ")} && chown -R boxuser: ${owned.map(shellQuote).join(" ")}`, { root: true });
  } catch (error) {
    await box.delete().catch(() => {});
    throw error;
  }
  return {
    sandboxId: upstashId(box.id),
    async exec(command, params) {
      const result = await box.exec.command(PINNED_TOOLS_FIRST + commandLine(command[0]!, command.slice(1), { cwd: params?.workdir, timeoutMs: params?.timeoutMs }));
      return {
        stdin: { writeText: async () => {}, close: async () => {} },
        stdout: { readText: async () => result.stdout },
        stderr: { readText: async () => result.stderr },
        wait: async () => exitCodeOf(result),
      };
    },
    filesystem: {
      readText: (path) => box.files.read(path),
      writeText: (data, path) => box.files.write({ path, content: data }),
    },
    terminate: () => box.delete(),
    snapshotFilesystem: async () => ({ imageId: await readySnapshot(box) }),
    tunnels: async () => ({}),
  };
};

async function sh(sandbox: SandboxHandle, script: string, timeoutMs = 120_000) {
  const proc = await sandbox.exec(["bash", "-c", script], { timeoutMs });
  const [out, err, code] = await Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]);
  if (code !== 0) throw new Error(`${script} exited ${code}: ${err.trim().slice(-500)}`);
  return out.trim();
}

const codexPluginsSchema = z.object({ installed: z.array(z.object({ pluginId: z.string(), version: z.string(), enabled: z.boolean() })) });

/**
 * PStack as both CLIs see it: enabled for claude and codex, from the pinned checkout, with its
 * skills on disk. Its version string when all of that holds, else undefined.
 */
async function pstackInImage(sandbox: SandboxHandle, limits: BuildLimits, log: Log) {
  const plugin = enabledPstack(await sh(sandbox, "claude plugin list --json"));
  const commit = await sh(sandbox, `git -C ${PSTACK_DIR} rev-parse HEAD`);
  const codex = codexPluginsSchema.parse(JSON.parse(await sh(sandbox, "codex plugin list --json"))).installed.find((p) => p.pluginId === PSTACK_PLUGIN);
  if (!plugin?.version || !plugin.installPath || !codex?.enabled || codex.version !== plugin.version) return undefined;
  const skills = Number(await sh(sandbox, `ls ${plugin.installPath}/skills | wc -l`));
  log(`PStack ${plugin.version} at ${commit.slice(0, 12)}: ${skills} skills in ${plugin.installPath}, enabled for codex too`);
  return skills > 0 ? pstackVersion({ ...limits.pstack, version: plugin.version, commit }) : undefined;
}

/** Writes through a temp file and a rename, owner-only, so a runner reading it never sees half a file. */
function writeImage(path: string, state: SandboxImage) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** A build holds this file for its whole run, so the runner and the CLI never build at once on one machine. */
export const buildLockPath = (path: string) => `${path}.lock`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Takes the build lock, or returns the pid of the live process that holds it. A dead holder's lock is taken over. */
function lock(path: string): { release: () => void } | { heldBy: number } {
  const lockPath = buildLockPath(path);
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return { release: () => rmSync(lockPath, { force: true }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number(readFileSync(lockPath, "utf8"));
      if (holder > 0 && alive(holder)) return { heldBy: holder };
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`could not take the build lock ${lockPath}`);
}

export class BuildLockedError extends Error {
  constructor(readonly pid: number) {
    super(`another sandbox image build (pid ${pid}) is running on this machine`);
  }
}

/**
 * Builds, verifies and records a new image under these pins. Throws without touching the stored
 * image when the build or its verification fails, or when another build holds the lock.
 */
export async function buildSandboxImage({
  limits,
  log,
  open = openModalBuildSandbox,
  path = SANDBOX_IMAGE_PATH,
  signal,
}: {
  limits: BuildLimits;
  log: Log;
  open?: OpenBuildSandbox;
  path?: string;
  /** Aborting ends the build sandbox, at once or as soon as its create returns, so the build fails and records nothing. */
  signal?: AbortSignal;
}): Promise<SandboxImage> {
  const held = lock(path);
  if ("heldBy" in held) throw new BuildLockedError(held.heldBy);
  let bundleDir: string | undefined;
  let sandbox: SandboxHandle | undefined;
  try {
    bundleDir = mkdtempSync(join(tmpdir(), "factory-bundle-"));
    await execFileAsync("bun", ["build", ...IMAGE_BUNDLES, "--target=bun", "--root", ".", "--outdir", bundleDir, "--entry-naming", "[dir]/[name].ts"], { cwd: ROOT });
    log(`bundled ${IMAGE_BUNDLES.join(", ")}`);
    if (signal?.aborted) throw new Error("the build was stopped");
    sandbox = await open(limits, log);
    log(`build sandbox ${sandbox.sandboxId} up`);
    const opened = sandbox;
    const end = () => void opened.terminate().catch(() => {});
    signal?.addEventListener("abort", end, { once: true });
    if (signal?.aborted) end();
    for (const entry of IMAGE_BUNDLES) await sandbox.filesystem.writeText(readFileSync(join(bundleDir, entry), "utf8"), join(FACTORY_ROOT, entry));
    const playbooks = await installPlaybooks(sandbox.filesystem);
    log(`playbooks ${PLAYBOOK_FILES.join(", ")} in ${SANDBOX_PLAYBOOKS} at ${playbooks}`);
    const pinned = pinnedVersions(limits);
    const built: ImageVersions = {
      t3: parseVersion("t3", await sh(sandbox, "t3 --version")) ?? undefined,
      claudeCode: parseVersion("claudeCode", await sh(sandbox, "claude --version")) ?? undefined,
      codex: parseVersion("codex", await sh(sandbox, "codex --version")) ?? undefined,
      playwrightMcp: parseVersion("playwrightMcp", await sh(sandbox, "playwright-mcp --version")) ?? undefined,
      pstack: await pstackInImage(sandbox, limits, log),
      playbooks,
    };
    const drift = imageDrift(built, pinned);
    if (drift.length > 0) throw new Error(`the build sandbox does not match the pins: ${rebuildText(drift)}`);
    log(`versions: ${Object.entries(built).map(([component, version]) => `${component} ${version}`).join(" | ")} | bun ${await sh(sandbox, "bun --version")}`);
    await sh(sandbox, `cd /tmp && echo '{}' | bun ${FACTORY_ROOT}/hooks/report.ts && echo '{}' | bun ${FACTORY_ROOT}/hooks/budget.ts`);
    // Outside a git repo factory-verify refuses with exit 2, which shows the bundle loads.
    await sh(sandbox, `cd /tmp && { factory-verify --no-post 2>/dev/null; test $? -eq 2; }`);
    log("hook bundles run");

    // A stop from here on ends the sandbox under the snapshot, which then fails; one after it records the image, which passed every check.
    const image = await sandbox.snapshotFilesystem({ ttlMs: null, timeoutMs: 300_000 });
    const factoryCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ROOT })).stdout.trim();
    const state: SandboxImage = { imageId: image.imageId, t3Version: limits.t3Version, versions: pinned, factoryCommit, builtAt: new Date().toISOString() };
    writeImage(path, state);
    log(`image ${image.imageId} recorded in ${path}`);
    return state;
  } finally {
    await sandbox?.terminate().catch((error: unknown) => log(`could not terminate the build sandbox: ${String(error)}`));
    if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
    held.release();
  }
}
