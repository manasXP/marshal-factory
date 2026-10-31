import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadLimits } from "../lib/config";
import { readRollout, ROLLOUT_PATH, startupVerdict, touchedInputs } from "../lib/rollout";
import { imageProblem, IMAGE_BUNDLES, readSandboxImage } from "../lib/sandbox";

// Rolls merged main out to the live setup, in the order the parts depend on each other, and stops
// at the first failure:
//   1. wait for Vercel's production deploy of origin/main, which also migrates the database
//   2. refuse while this machine's runner has jobs in flight (--wait waits for them instead)
//   3. stop the runner, pull main and bun install in the checkout
//   4. bun run db:migrate
//   5. redeploy the ingest Function when its bundle's inputs changed since the last rollout
//   6. rebuild the sandbox image when its pins drifted or its bundles' inputs changed since it was built
//   7. reinstall the runner and wait for its first clean tick
// The runner is the LaunchAgent, or the runner container when the checkout's compose project has one
// (docs/runner-container.md): stopped with docker compose stop, started with docker compose up --build.
// Then it records the commit in ~/.config/marshal-factory/rollout.json for the next run.
//   bun scripts/rollout.ts [--wait] [--canary] [--force] [--checkout <path>]
// --canary runs scripts/canary.ts afterwards. --force rolls out even when the commit was rolled out
// already. --checkout names the live checkout when this script runs from another one.
// Steps 4 to 7 run in a fresh process from the pulled checkout's script, so they are the new code's.

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const checkout = resolve(option("--checkout") ?? join(import.meta.dirname, ".."));
const LOG_PATH = join(homedir(), "Library/Logs/marshal-factory/runner.log");
const ALREADY_STOPPED = "--runner-stopped";

const t0 = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${message}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class StepError extends Error {}
let runnerStopped = flag(ALREADY_STOPPED);

/** Runs a command in the checkout with its output shown, failing the rollout when it fails. */
function run(command: string, commandArgs: string[], env: Record<string, string> = {}) {
  log(`$ ${[...Object.entries(env).map(([k, v]) => `${k}=${v}`), command, ...commandArgs].join(" ")}`);
  const result = spawnSync(command, commandArgs, { cwd: checkout, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) throw new StepError(`${command} ${commandArgs.join(" ")} exited ${result.status ?? result.signal}`);
}
const read = (command: string, commandArgs: string[]) => execFileSync(command, commandArgs, { cwd: checkout, encoding: "utf8" }).trim();
const git = (...gitArgs: string[]) => read("git", gitArgs);

const LABEL = "com.marshal-factory.runner";
const CONFIG_DIR = join(homedir(), ".config/marshal-factory");

type Runner = { stop(): void; startAsIs(): void; start(commit: string): () => string; hint: string };

const launchAgent: Runner = {
  stop: () => run("bun", ["scripts/install-runner.ts", "--uninstall"]),
  startAsIs: () => run("bun", ["scripts/install-runner.ts"]),
  start() {
    const offset = existsSync(LOG_PATH) ? statSync(LOG_PATH).size : 0;
    run("bun", ["scripts/install-runner.ts"]);
    return () => readFrom(LOG_PATH, offset);
  },
  hint: "bun scripts/install-runner.ts",
};

const runnerContainer: Runner = {
  stop: () => run("docker", ["compose", "stop", "runner"]),
  startAsIs: () => run("docker", ["compose", "start", "runner"]),
  start(commit) {
    const since = new Date().toISOString();
    // The image has no .git, so the build takes the commit from FACTORY_COMMIT.
    run("docker", ["compose", "up", "--detach", "--build", "runner"], { FACTORY_COMMIT: commit });
    return () => read("docker", ["compose", "logs", "--no-log-prefix", "--since", since, "runner"]);
  },
  hint: "docker compose start runner",
};

/**
 * The runner container when the checkout's compose project has one, running or stopped, else the
 * LaunchAgent. Docker failing is no answer: guessing the LaunchAgent would put a second runner next to the container.
 */
async function pickRunner(): Promise<Runner> {
  let ids: string;
  try {
    ids = read("docker", ["compose", "ps", "--all", "--quiet", "runner"]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return launchAgent;
    throw new StepError("docker compose ps failed, so it is unknown whether the runner is the container; start Docker and run the rollout again");
  }
  if (ids === "") return launchAgent;
  if (spawnSync("launchctl", ["print", `gui/${userInfo().uid}/${LABEL}`], { stdio: "ignore" }).status === 0) {
    throw new StepError(`both the runner container and the ${LABEL} LaunchAgent exist; remove one (docker compose down, or bun scripts/install-runner.ts --uninstall)`);
  }
  // The steps on this host read the config, the image record and the rollout record from ~/.config;
  // they are the container's only when its compose mounts that directory, as a Mac's override does.
  const config = JSON.parse(read("docker", ["compose", "config", "--format", "json"])) as { services: { runner: { volumes?: { source?: string; target: string }[] } } };
  if (!config.services.runner.volumes?.some((v) => v.source === CONFIG_DIR && v.target === "/home/bun/.config/marshal-factory")) {
    throw new StepError(`the runner container doesn't mount ${CONFIG_DIR}, so this host can't roll it out; update it by hand (docs/runner-container.md)`);
  }
  const { thisMachine } = await import(join(checkout, "runner/heartbeat.ts"));
  if ((await thisMachine()).idFrom !== "config") throw new StepError(`set factory.machineId in ${CONFIG_DIR}/config.json, so this host counts the container's jobs`);
  log("runner: the runner container");
  return runnerContainer;
}
let runner: Runner | undefined;

async function waitFor<T>(what: string, timeoutMs: number, everyMs: number, check: () => Promise<T | undefined> | T | undefined) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new StepError(`gave up waiting for ${what} after ${Math.round(timeoutMs / 60_000)} minutes`);
    await sleep(everyMs);
  }
}

/** The Vercel commit status on main's head is the production deploy; it runs the migrations too. */
async function waitForVercel(sha: string) {
  log(`waiting for Vercel's production deploy of ${sha.slice(0, 7)}`);
  let last = "";
  await waitFor("the Vercel deploy", 30 * 60_000, 15_000, () => {
    const statuses = JSON.parse(read("gh", ["api", `repos/{owner}/{repo}/commits/${sha}/statuses`])) as { context: string; state: string; description: string; target_url: string }[];
    const vercel = statuses.find((s) => s.context === "Vercel");
    if (!vercel) return undefined;
    if (vercel.state !== last) log(`Vercel: ${vercel.state}, ${vercel.description}`);
    last = vercel.state;
    if (vercel.state === "success") return true;
    if (vercel.state === "failure" || vercel.state === "error") throw new StepError(`the Vercel deploy of ${sha.slice(0, 7)} failed: ${vercel.target_url}`);
    return undefined;
  });
}

/** This machine's jobs whose thread is working or stopping, counted as the runner counts them. */
async function inFlight() {
  const { machineInFlight } = await import(join(checkout, "runner/ops.ts"));
  const { thisMachine } = await import(join(checkout, "runner/heartbeat.ts"));
  return (await machineInFlight((await thisMachine()).id)) as number;
}

async function beforePull() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") throw new StepError(`${checkout} is on ${branch}; the live checkout must be on main`);
  if (git("status", "--porcelain", "--untracked-files=no") !== "") throw new StepError(`${checkout} has uncommitted changes`);
  git("fetch", "-q", "origin", "main");
  const target = git("rev-parse", "origin/main");
  const last = readRollout();
  if (last?.commit === target && git("rev-parse", "HEAD") === target && !flag("--force")) {
    log(`${target.slice(0, 7)} is rolled out already (${last.at}); --force rolls it out again`);
    return false;
  }
  log(`rolling out ${target.slice(0, 7)} to ${checkout}; last rollout ${last ? `${last.commit.slice(0, 7)} at ${last.at}` : "none recorded"}`);
  process.chdir(checkout);
  process.loadEnvFile(".env.local");
  runner = await pickRunner();
  await waitForVercel(target);

  let busy = await inFlight();
  if (busy > 0 && !flag("--wait")) throw new StepError(`${busy} job(s) in flight on this machine; rerun with --wait to wait for them`);
  if (busy > 0) {
    log(`${busy} job(s) in flight; waiting until none is`);
    await waitFor("jobs in flight to finish", 6 * 3_600_000, 60_000, async () => ((busy = await inFlight()) === 0 ? true : undefined));
  }
  runner.stop();
  runnerStopped = true;
  // The runner may have claimed a job between the count and the stop.
  busy = await inFlight();
  if (busy > 0) {
    runner.startAsIs();
    runnerStopped = false;
    throw new StepError(`a job was claimed while stopping the runner; it runs again, rerun the rollout${flag("--wait") ? "" : " with --wait"}`);
  }
  run("git", ["pull", "--ff-only", "-q", "origin", "main"]);
  run("bun", ["install"]);
  return true;
}

/** The files a Bun bundle of these entry points is built from, relative to the checkout. */
function bundleInputs(entries: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), "rollout-bundle-"));
  try {
    execFileSync("bun", ["build", ...entries, "--target=bun", "--root", ".", "--outdir", join(dir, "out"), `--metafile=${join(dir, "meta.json")}`], { cwd: checkout, stdio: "ignore" });
    return Object.keys((JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { inputs: Record<string, unknown> }).inputs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Files changed between a commit and HEAD, or null when the commit is unknown here. */
function changedSince(commit: string | undefined) {
  if (!commit) return null;
  try {
    return git("diff", "--name-only", commit, "HEAD").split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

async function afterPull() {
  process.chdir(checkout);
  process.loadEnvFile(".env.local");
  runner = await pickRunner();
  const head = git("rev-parse", "HEAD");
  const last = readRollout();

  run("bun", ["run", "db:migrate"]);

  const ingestChanged = changedSince(last?.commit);
  const ingestTouched = ingestChanged && touchedInputs(ingestChanged, bundleInputs(["functions/ingest/index.ts"]));
  if (ingestTouched === null) log("ingest: no earlier rollout to compare with, so it is deployed");
  else if (ingestTouched.length > 0) log(`ingest: ${ingestTouched.join(", ")} changed`);
  if (ingestTouched === null || ingestTouched.length > 0) run("neon", ["functions", "deploy", "ingest", "--branch", "main", "--src", "functions/ingest/index.ts"]);
  else log("ingest: unchanged since the last rollout, not deployed");

  const image = readSandboxImage();
  if (!image) log("image: none was ever built on this machine (no Modal jobs), not built");
  else {
    const problem = imageProblem(image, loadLimits().sandbox);
    const imageChanged = changedSince(image.factoryCommit);
    const imageTouched = imageChanged && touchedInputs(imageChanged, [...(bundleInputs(IMAGE_BUNDLES)), "scripts/sandbox-image.ts", "lib/sandbox-image-build.ts"]);
    const why = [problem, imageTouched === null ? `its commit ${image.factoryCommit.slice(0, 7)} is not in this checkout` : imageTouched.length > 0 && `${imageTouched.join(", ")} changed`].filter(Boolean);
    if (why.length > 0) {
      log(`image: rebuilding, ${why.join("; ")}`);
      run("bun", ["scripts/sandbox-image.ts"]);
    } else log(`image: ${image.imageId} is current (built from ${image.factoryCommit.slice(0, 7)})`);
  }

  const logSinceStart = runner.start(head);
  runnerStopped = false;
  log("waiting for the runner's first tick");
  const verdict = await waitFor("the runner's first tick", 15 * 60_000, 5_000, () => {
    const v = startupVerdict(logSinceStart().split("\n"));
    return v.state === "waiting" ? undefined : v;
  });
  if (verdict.state === "failed") throw new StepError(`the runner came up unhealthy: ${verdict.why}`);
  log(`runner ticked cleanly at ${verdict.at}`);

  mkdirSync(dirname(ROLLOUT_PATH), { recursive: true });
  writeFileSync(ROLLOUT_PATH, `${JSON.stringify({ commit: head, at: new Date().toISOString() }, null, 2)}\n`);
  chmodSync(ROLLOUT_PATH, 0o600);
  log(`rolled out ${head.slice(0, 7)}; recorded in ${ROLLOUT_PATH}`);
}

function readFrom(path: string, offset: number) {
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
  if (size <= offset) return "";
  const buffer = Buffer.alloc(size - offset);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

try {
  if (flag("--after-pull")) await afterPull();
  else {
    if (await beforePull()) {
      // The pulled checkout's own rollout script does the rest, so a change to it applies at once.
      const next = existsSync(join(checkout, "scripts/rollout.ts")) ? join(checkout, "scripts/rollout.ts") : import.meta.filename;
      const rest = spawnSync("bun", [next, "--after-pull", ALREADY_STOPPED, "--checkout", checkout], { cwd: checkout, stdio: "inherit" });
      if (rest.status !== 0) process.exit(rest.status ?? 1);
      runnerStopped = false;
    }
    if (flag("--canary")) run("bun", [join(import.meta.dirname, "canary.ts"), "--checkout", checkout]);
  }
  process.exit(0);
} catch (error) {
  console.error(`rollout stopped: ${error instanceof Error ? error.message : String(error)}`);
  if (runnerStopped) console.error(`The runner is stopped. Fix the cause and run the rollout again, or start the runner as it is with ${runner?.hint ?? launchAgent.hint}.`);
  if (!(error instanceof StepError) && error instanceof Error) console.error(error.stack);
  process.exit(1);
}
