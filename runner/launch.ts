import { execFile } from "node:child_process";
import { runWithInput, type ExecError } from "../lib/exec";
import { promisify } from "node:util";
import { z } from "zod";
import { forbidInTest } from "../lib/test-mode";
import { PENDING } from "./binding";
import { thisMachine } from "./heartbeat";
import type { JobSource } from "../lib/sources/types";
import { bindThread, claimLaunch, config, factoryCheckouts, machineInFlight, pendingLaunches, releaseLaunch, toLaunch, withLocalImages } from "./ops";

const run = promisify(execFile);
const T3 = process.env.T3CODE_CLI_PATH ?? "t3";
const sh = async (cmd: string, args: string[], cwd?: string) =>
  (await run(cmd, args, { cwd, timeout: 60_000 })).stdout.trim();

/** Thrown when T3 may have created the thread even though the start did not report it. */
export class MaybeStartedError extends Error {}

export function parseThreadId(stdout: string) {
  try {
    return z.object({ threadId: z.string() }).parse(JSON.parse(stdout)).threadId;
  } catch {
    throw new MaybeStartedError(`t3 thread start printed no thread id: ${stdout.slice(0, 200)}`);
  }
}

async function startThread(repo: string, branch: string, title: string, message: string) {
  forbidInTest("t3 thread start");
  const stdout = await runWithInput(
    T3,
    [
      "thread", "start", repo, "-",
      "--worktree", "origin/main",
      "--branch", branch,
      "--title", title,
      "--provider", config.factory.provider,
      "--model", config.factory.model,
      "--json",
    ],
    message,
    60_000,
  );
  return parseThreadId(stdout);
}

/** T3 prepares the worktree after start returns; wait for it and confirm it sits on fresh origin/main. */
async function worktreeHead(threadId: string) {
  for (let i = 0; i < 30; i++) {
    const { thread } = z
      .object({ thread: z.object({ worktreePath: z.string().nullable() }) })
      .parse(JSON.parse(await sh(T3, ["thread", "show", threadId, "--json"])));
    if (thread.worktreePath) {
      try {
        return { path: thread.worktreePath, head: await sh("git", ["rev-parse", "HEAD"], thread.worktreePath) };
      } catch {
        // The directory exists before git has finished checking it out.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return undefined;
}

const PENDING_STALE_MS = 120_000;

/**
 * A launch that died between starting the thread and recording it leaves a pending marker. Once
 * it is stale, look for the thread T3 made on that branch and record it, or clear the marker.
 */
async function threadBranches(checkout: string) {
  const list = z.array(z.object({ threadId: z.string() })).parse(JSON.parse(await sh(T3, ["thread", "list", "--project", checkout, "--json"])));
  return Promise.all(
    list.map(async ({ threadId }) => ({
      threadId,
      branch: z.object({ thread: z.object({ branch: z.string().nullable() }) }).parse(JSON.parse(await sh(T3, ["thread", "show", threadId, "--json"]))).thread.branch,
    })),
  );
}

async function recoverPending(checkouts: ReadonlyMap<string, string>) {
  // A pending launch whose repo left this machine's config has no project to look in; it waits for the repo to come back.
  const stale = (await pendingLaunches()).filter(
    (p) => checkouts.has(p.repo) && Date.now() - Number(p.marker.slice(PENDING.length)) > PENDING_STALE_MS,
  );
  const branchesByRepo = new Map<string, Awaited<ReturnType<typeof threadBranches>>>();
  const recovered = [];
  for (const p of stale) {
    if (!branchesByRepo.has(p.repo)) branchesByRepo.set(p.repo, await threadBranches(checkouts.get(p.repo)!));
    const found = branchesByRepo.get(p.repo)!.find((b) => b.branch === p.branch);
    // bindThread delivers an owed stop. Without a thread, clearing the marker leaves nothing owed.
    await (found ? bindThread(p.key, found.threadId) : releaseLaunch(p.key, p.marker));
    recovered.push({ key: p.key, threadId: found?.threadId ?? null });
  }
  return recovered;
}

type LaunchEntry = { key: string; source: JobSource; repo: string; branch: string; threadTitle: string; message: string };

export type LaunchDeps = {
  claim: (key: string, marker: string) => Promise<boolean>;
  start: (entry: LaunchEntry) => Promise<string>;
  bind: (key: string, threadId: string) => Promise<unknown>;
  release: (key: string, marker: string) => Promise<unknown>;
  now: () => number;
};

/**
 * Whether a failed start may still have made the thread. Only a start that never ran (ENOENT)
 * or exited non-zero with its input fully written counts as a clear failure; a timeout, a broken
 * stdin pipe or unparsable output is ambiguous, and the pending marker is kept for recovery.
 */
export function maybeStarted(error: unknown) {
  if (error instanceof MaybeStartedError) return true;
  const failure = error as ExecError;
  if (failure?.code === "ENOENT") return false;
  return Boolean(failure?.killed || failure?.stdinError);
}

/**
 * Launches each entry on its own: a failure is logged and the rest still launch. A start that
 * clearly failed releases its marker so the next pass retries it; one that timed out keeps the
 * marker for recoverPending, which attaches the thread T3 made or clears the marker.
 */
export async function launchEntries(entries: readonly LaunchEntry[], deps: LaunchDeps) {
  const results: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const marker = `${PENDING}${deps.now()}`;
    if (!(await deps.claim(entry.key, marker))) continue;
    const startedAt = deps.now();
    try {
      const threadId = await deps.start(entry);
      await deps.bind(entry.key, threadId);
      results.push({ key: entry.key, threadId, branch: entry.branch, startMs: deps.now() - startedAt });
    } catch (error) {
      const timedOut = maybeStarted(error);
      if (!timedOut) await deps.release(entry.key, marker);
      results.push({
        key: entry.key,
        error: error instanceof Error ? error.message.split("\n")[0] : String(error),
        retry: timedOut ? "after launch recovery" : "next pass",
      });
    }
  }
  return results;
}

/**
 * Starts a T3 thread for every queued job no machine holds, in this machine's checkout of the
 * job's repo, on a worktree cut from freshly fetched origin/main. Each launch is claimed with a
 * pending marker first, so a crash or timeout after T3 created the thread can never start a
 * second one on the same branch, and another machine can never start the same job.
 */
export async function launchQueued(onWorktree: (check: Record<string, unknown>) => void = () => {}) {
  const checkouts = await factoryCheckouts();
  if (checkouts.size === 0) return [];
  const recovered = await recoverPending(checkouts);
  const machine = await thisMachine();
  if ((await machineInFlight(machine.id)) >= config.factory.maxInFlight) return recovered;
  const pending = (await toLaunch()).filter((entry) => checkouts.has(entry.repo));
  if (pending.length === 0) return recovered;
  const origins = new Map<string, string>();
  for (const repo of new Set(pending.map((entry) => entry.repo))) {
    const checkout = checkouts.get(repo)!;
    await sh("git", ["fetch", "origin", "--prune"], checkout);
    origins.set(repo, await sh("git", ["rev-parse", "origin/main"], checkout));
  }
  const slot = { id: machine.id, repos: [...checkouts.keys()], maxInFlight: config.factory.maxInFlight };
  const launched = await launchEntries(pending, {
    claim: (key, marker) => claimLaunch(key, marker, slot),
    // After the claim, so a job another machine wins downloads nothing here.
    start: async (entry) =>
      startThread(checkouts.get(entry.repo)!, entry.branch, entry.threadTitle, await withLocalImages(entry.source, entry.key, entry.message)),
    bind: bindThread,
    release: releaseLaunch,
    now: Date.now,
  });
  // Diagnostic only and up to 30 s per thread, so it runs off the runner's queue.
  for (const result of launched) {
    if (typeof result.threadId !== "string") continue;
    const origin = origins.get(pending.find((entry) => entry.key === result.key)!.repo)!;
    void worktreeHead(result.threadId)
      .then((tree) => onWorktree({ key: result.key, worktree: tree?.path, freshFromOrigin: tree ? tree.head === origin : undefined, originMain: origin.slice(0, 7) }))
      .catch((error: unknown) => onWorktree({ key: result.key, error: String(error) }));
  }
  return [...recovered, ...launched];
}
