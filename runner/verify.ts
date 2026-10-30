import { createHash, randomBytes } from "node:crypto";
import type { ExecError } from "../lib/exec";
import { eventSchema, type FactoryEvent } from "../lib/events";
import { isCloud } from "../lib/execution";
import { combined, planChecks, runChecks, type CheckRunner } from "../lib/evidence";
import { attemptBranch } from "../lib/factory";
import { ensureAwake, HostAsleepError, HostGoneError, WakeDeferredError, type HostedJob, type JobHost } from "../lib/host";
import type { MergeDecision, RepoPolicy, RunnerVerification } from "../lib/merge-decision";
import { parseRecipe, RECIPE_PATH, type Recipe } from "../lib/recipe";
import { REPO_DIR } from "../lib/sandbox";

// The runner's own proof for a Modal job's PR head: in the job's sandbox it checks out exactly
// that commit in a fresh worktree, runs the recipe's setup and checks, and posts the result as
// evidence, so a merge never rests on the agent's word alone. It runs only when the repo merges
// on its own (auto) and verification at the head is the one thing left before a merge, at most
// once per head, one per job (a new head waits for the old head's run) and MAX_RUNNER_VERIFICATIONS
// at a time. A hibernated sandbox is woken for it.
// Runs happen in the background; the decision stays pending until the evidence lands.

export const MAX_RUNNER_VERIFICATIONS = 2;
/** A run recorded on the decision that this runner doesn't know of (it restarted) is retried after this. */
export const VERIFY_RETRY_MS = 10 * 60_000;

/** Where the sandbox keeps the repo and the verification worktrees; regressions point them at temp dirs. */
export const verifyRuntime = { repoDir: REPO_DIR, workDir: "/work/verify" };

type VerifyJob = HostedJob & { attempt: number; repo: string; execution: string | null };
type Flight = { sha: string; finished: boolean; failed?: string; done: Promise<void> };
const flights = new Map<string, Flight>();

const message = (error: unknown) => (error instanceof Error ? error.message.split("\n")[0]! : String(error));

/** Jobs whose sandbox is busy with a verification, which hibernation leaves alone. */
export const verifyingKeys = () => new Set([...flights].filter(([, f]) => !f.finished).map(([key]) => key));

/** Every verification this runner started, settled; for regressions. */
export const verificationsSettled = async () => void (await Promise.all([...flights.values()].map((f) => f.done)));
export const forgetVerifications = () => flights.clear();

/** Whether the runner can run the checks at `sha` for this job: may start, running, tried and couldn't, or can't. */
export function runnerVerification(job: VerifyJob, sha: string, policy: RepoPolicy, previous: MergeDecision | null, now: number): RunnerVerification {
  if (policy.autonomy !== "auto") return { kind: "unavailable", reason: "the factory runs the checks itself only when the repo merges on its own" };
  if (!job.sandbox_id && !job.sandbox_snapshot) {
    return { kind: "unavailable", reason: isCloud(job.execution) ? "the job has no sandbox left to run them in" : "the run isn't in a cloud sandbox, so the factory can't run them itself" };
  }
  const flight = flights.get(job.key);
  // A run for an older head still holds the sandbox; this head waits for it to end.
  if (flight && !flight.finished) return { kind: "running" };
  if (flight?.sha === sha) return { kind: "failed", reason: flight.failed ?? "its run didn't prove the commit" };
  const record = previous?.verification;
  if (record?.sha === sha) {
    if (record.state === "failed") return { kind: "failed", reason: record.reason ?? "it failed" };
    if (now - Date.parse(record.at) < VERIFY_RETRY_MS) return { kind: "running" };
  }
  return { kind: "available" };
}

const git = (host: JobHost, dir: string, args: string[], timeoutMs = 60_000) => host.run("git", ["-C", dir, ...args], { timeoutMs });

/** Runs a check with bash in `dir` on the host; only an unreachable host throws. */
const hostRunner =
  (host: JobHost, dir: string): CheckRunner =>
  async (command, timeoutMs) => {
    try {
      const { stdout, stderr } = await host.run("bash", ["-c", combined(command)], { cwd: dir, timeoutMs, maxBuffer: 64 * 1024 * 1024 });
      return { exitCode: 0, output: `${stdout}${stderr}` };
    } catch (error) {
      if (error instanceof HostGoneError || error instanceof HostAsleepError) throw error;
      const failed = error as ExecError;
      return { exitCode: typeof failed.code === "number" ? failed.code : null, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` || failed.message };
    }
  };

/**
 * Checks out `sha` from the job's branch in a fresh worktree on the host, runs the setup and the
 * checks there, and returns the evidence event. The recipe the factory recorded wins over the one
 * in the commit; without either, package.json scripts are the checks.
 */
export async function verifyAtHead(host: JobHost, job: { key: string; attempt: number; repo: string }, sha: string, recipe: Recipe | null, now = Date.now): Promise<FactoryEvent> {
  const { repoDir, workDir } = verifyRuntime;
  const branch = attemptBranch(job.key, job.attempt);
  const dir = `${workDir}/${sha.slice(0, 12)}-${randomBytes(4).toString("hex")}`;
  await git(host, repoDir, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], 180_000);
  try {
    await git(host, repoDir, ["worktree", "add", "--force", "--detach", dir, sha], 120_000);
  } catch (error) {
    throw new Error(`commit ${sha.slice(0, 7)} isn't on ${branch} (${message(error)})`);
  }
  try {
    const head = (await git(host, dir, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== sha) throw new Error(`the worktree is at ${head.slice(0, 7)}, not ${sha.slice(0, 7)}`);
    const fileRecipe = recipe ? null : await host.readFile(`${dir}/${RECIPE_PATH}`);
    const parsed = fileRecipe ? parseRecipe(fileRecipe) : null;
    const plan = planChecks({ recipe: recipe ?? (parsed?.ok ? parsed.recipe : null), packageJson: await host.readFile(`${dir}/package.json`), files: await host.list(dir) });
    const checks = await runChecks(plan, hostRunner(host, dir), { now });
    const at = now();
    return eventSchema.parse({
      eventId: createHash("sha256").update(`evidence\nrunner\n${job.key}\n${sha}\n${at}`).digest("hex"),
      sessionId: `runner-verify:${branch}`,
      at,
      kind: "evidence",
      jobKey: job.key,
      attempt: job.attempt,
      repo: job.repo,
      sha,
      clean: true,
      producer: "runner",
      source: plan.source,
      checks,
    });
  } finally {
    await git(host, repoDir, ["worktree", "remove", "--force", dir]).catch(() => undefined);
  }
}

/**
 * Starts the runner's verification of `sha` in the background, waking a hibernated sandbox; false
 * when the job's sandbox is running one already, at any head, or MAX_RUNNER_VERIFICATIONS are
 * running. `post` delivers the evidence to ingest.
 */
export function startVerification(job: VerifyJob, sha: string, recipe: Recipe | null, post: (event: FactoryEvent) => Promise<unknown>): boolean {
  const verifying = verifyingKeys();
  if (verifying.has(job.key) || verifying.size >= MAX_RUNNER_VERIFICATIONS) return false;
  const flight: Flight = { sha, finished: false, done: Promise.resolve() };
  flight.done = (async () => {
    try {
      const host = await ensureAwake(job);
      await post(await verifyAtHead(host, job, sha, recipe));
    } catch (error) {
      // No room to wake the sandbox: no run happened, so the head is tried again once the decision's retry comes round.
      if (error instanceof WakeDeferredError) flights.delete(job.key);
      else flight.failed = error instanceof HostGoneError ? "the job's sandbox is gone" : message(error);
    } finally {
      flight.finished = true;
    }
  })();
  flights.set(job.key, flight);
  return true;
}
