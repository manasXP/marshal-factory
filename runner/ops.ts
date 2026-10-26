import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { agents, jobs, runs } from "../db/schema";
import { STAGES, type Stage, type Usage } from "../lib/events";
import { loadConfig } from "../lib/config";
import { jobId, parseJob, parseJobs, sourceFor } from "../lib/sources";
import { parseJobId, SOURCE_SHAPES } from "../lib/sources/shapes";
import type { Job, JobDraft, JobId, JobSource, SourceAdapter } from "../lib/sources/types";
import type { IngestResult } from "../lib/ingest";
import { canTransition, runnerEventId } from "../lib/stages";
import { branchSpend } from "../lib/spend";
import { readTranscript, subagentTranscripts, sumUsage, transcriptPathFor } from "../lib/transcript";
import { checkoutRepo, cleanupRepo, cleanupSubagentWorktrees } from "../lib/worktrees";
import { github } from "../lib/github/pulls";
import { claimConflict, conflictMessage, unclaimedRunsWithPr } from "../lib/conflicts";
import { attemptBranch } from "../lib/factory";
import { nudgeMessage, watch, type ThreadState } from "../lib/watchdog";
import { isTracked } from "../lib/harness";
import { readHarnesses } from "../lib/t3-state";
import { readSettings, resolveHarness, type HarnessChoice } from "../lib/settings";
import { forbidInTest } from "../lib/test-mode";
import { runWithInput } from "../lib/exec";
import { bindingOf, canReclaimSql, isStopped, PENDING, stopDeliverableSql } from "./binding";
import { thisMachine } from "./heartbeat";
import { claimReplies, qaBlock, resumeMessage } from "../lib/resume";


// The factory's deterministic work. The runner calls these from webhook intents, its timer and
// its startup reconcile; every one of them is idempotent, so calling one twice changes nothing.
// Each acts only on this machine's jobs: another machine's thread, worktree and transcripts are
// out of reach here, so its own runner watches, bills, writes back and stops them.

export const config = loadConfig();

const mine = async () => eq(jobs.machine_id, (await thisMachine()).id);

/** Stages where a thread is working; waiting, pr, merged and failed free the slot. */
export const IN_FLIGHT: Stage[] = ["queued", "triage", "investigating", "implementing", "verifying"];
const STOPPABLE = STAGES.filter((stage) => canTransition(stage, "failed", "stop"));

const run = promisify(execFile);
// The LaunchAgent sets T3CODE_CLI_PATH; otherwise t3 must be on PATH.
const T3 = process.env.T3CODE_CLI_PATH ?? "t3";

/**
 * Follows every factory PR: a merged one moves its job to merged, and one that conflicts with
 * main while its job sits in pr sends the thread back to merge main. The conflict is handled
 * once per PR head, so a pass never repeats the request while the thread works on it. Each PR is
 * checked on its own: one that fails (an uninstalled repo, a bad URL, a GitHub hiccup) is reported
 * and the next timer pass retries it, while the rest of this pass goes on. A job no machine holds,
 * such as a resume waiting for a fresh thread, has no thread to send back, but its merge counts.
 */
export async function checkPullRequests() {
  const open = parseJobs(
    await db
      .select()
      .from(jobs)
      .where(and(or(await mine(), isNull(jobs.machine_id)), isNotNull(jobs.pr_url), ne(jobs.stage, "merged")))
      .orderBy(asc(jobs.key)),
  );
  const conflicts: string[] = [];
  const errors: { key: string; prUrl: string; error: string }[] = [];
  const each = async (key: string, prUrl: string, step: () => Promise<void>) =>
    step().catch((error: unknown) => void errors.push({ key, prUrl, error: error instanceof Error ? error.message : String(error) }));

  for (const job of open) {
    await each(job.key, job.pr_url!, async () => {
      const pr = await github.pullRequest(job.pr_url!);
      if (pr.state === "open" && pr.mergeable === "conflicting" && job.stage === "pr" && job.machine_id !== null) {
        if (await sendBackForConflict(job, pr.headSha)) conflicts.push(job.key);
        return;
      }
      if (pr.state === "merged") await postMerged(job.key, job.pr_url!, job.session_id ?? runnerEventId("merged", job.external_id));
    });
  }

  for (const run of await unclaimedRunsWithPr(db)) {
    await each(run.job_key!, run.pr_url!, async () => {
      if ((await github.pullRequest(run.pr_url!)).state === "merged") await postMerged(run.job_key!, run.pr_url!, run.session_id);
    });
  }
  return { conflicts, errors };
}

/** A merge goes in as a stage event, so the run, the job, the timeline and the write-back all follow it. */
async function postMerged(jobKey: string, prUrl: string, sessionId: string) {
  await postEvent({
    eventId: runnerEventId("merged", prUrl, sessionId),
    sessionId,
    at: Date.now(),
    kind: "stage",
    stage: "merged",
    summary: `Merged ${prUrl}`,
    prUrl,
    jobKey,
  });
}

async function sendBackForConflict(job: Job, head: string) {
  // Ask T3 first: a CLI error then fails this PR's check before anything is claimed.
  const thread = await threads.state(job.t3_thread_id);
  if (!(await claimConflict(db, job.id, head))) return false;
  const release = () => db.update(jobs).set({ conflict_head: job.conflict_head }).where(eq(jobs.id, job.id));

  const now = Date.now();
  const eventId = runnerEventId("conflict", job.external_id, head);
  const sessionId = job.session_id ?? runnerEventId("conflict", job.external_id);
  try {
    if (thread === "gone") {
      await postEvent({
        eventId,
        sessionId,
        at: now,
        kind: "stage",
        stage: "failed",
        summary: `${job.pr_url} conflicts with main and its T3 thread is gone.`,
        jobKey: job.key,
      });
      return true;
    }
    await threads.send(job.t3_thread_id!, conflictMessage(job.key, job.pr_url!));
  } catch (error) {
    await release();
    throw error;
  }
  // The thread has the message now; if this event fails, its own reports still move the board.
  await postEvent({
    eventId,
    sessionId,
    at: now,
    kind: "stage",
    stage: "implementing",
    summary: `${job.pr_url} conflicts with main; the thread is merging main into the branch.`,
    jobKey: job.key,
  });
  return true;
}

async function postEvent(event: Record<string, unknown>) {
  forbidInTest("the deployed ingest function");
  const res = await fetch(config.ingestUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ingest answered ${res.status}: ${await res.text()}`);
  const { refused } = (await res.json()) as Pick<IngestResult, "refused">;
  for (const refusal of refused) console.log(JSON.stringify({ at: new Date().toISOString(), event: "stage refused", ...refusal }));
}

/** Gone means T3 no longer has the thread, it is archived, or its worktree left the disk. */
async function showThread(threadId: string | null): Promise<ThreadState> {
  forbidInTest("t3 thread show");
  if (!threadId) return "gone";
  // A launch in progress; the runner records the real id or clears the marker.
  if (bindingOf(threadId) === "pending") return "running";
  let stdout: string;
  try {
    ({ stdout } = await run(T3, ["thread", "show", threadId, "--json"], { timeout: 20_000 }));
  } catch (error) {
    // Only T3 saying the thread is gone counts as gone; a timeout or crash must not start a second thread.
    const output = String((error as { stdout?: string }).stdout ?? "") + String((error as { stderr?: string }).stderr ?? "");
    if (output.includes("no longer available")) return "gone";
    throw error;
  }
  const { thread } = z
    .object({
      thread: z.object({
        archived: z.boolean(),
        worktreePath: z.string().nullable(),
        activeRunId: z.string().nullable(),
      }),
    })
    .parse(JSON.parse(stdout));
  if (thread.archived || (thread.worktreePath !== null && !existsSync(thread.worktreePath))) return "gone";
  return thread.activeRunId ? "running" : "stopped";
}

export const threads = {
  state: showThread,
  async send(threadId: string, message: string) {
    forbidInTest("t3 thread send");
    await runWithInput(T3, ["thread", "send", threadId, "-"], message, 30_000);
  },
};

const threadAlive = async (threadId: string | null) => (await threads.state(threadId)) !== "gone";

/**
 * Hands answers to waiting questions back to the run that asked. The reply ids are claimed in
 * the database before anything is sent, so a replayed or concurrent pass never delivers twice.
 */
export async function resumeAnswered() {
  const waiting = parseJobs(await db.select().from(jobs).where(and(await mine(), eq(jobs.stage, "waiting"))));
  const resumed: string[] = [];
  for (const job of waiting) {
    const source = sourceFor(job.source);
    const plan = await source.replies(job);
    if (plan.kind === "wait") continue;

    const now = new Date();
    if (plan.kind === "close") {
      const closed = runnerEventId("closed", plan.state);
      await db
        .update(jobs)
        .set({
          stage: "failed",
          stage_at: now,
          stage_summary: `Moved to ${plan.state} in ${SOURCE_SHAPES[job.source].label} while waiting; not resumed.`,
          question: null,
          resume_context: null,
          stage_event_id: closed,
          synced_event_id: closed,
          updated_at: now,
        })
        .where(and(eq(jobs.id, job.id), eq(jobs.stage, "waiting")));
      resumed.push(`${job.key}:closed`);
      continue;
    }

    const replyIds = plan.replies.map((r) => r.id);
    const alive = await threadAlive(job.t3_thread_id);
    // A dead thread is unlinked in the same update that claims the replies, so the relaunch
    // cannot be lost to a later failure in this pass.
    const relaunch = alive ? undefined : qaBlock(plan.question, plan.answer);
    if (!(await claimReplies(db, job.id, replyIds, plan.answer, now, relaunch))) continue;

    if (alive) {
      try {
        await threads.send(job.t3_thread_id!, await withLocalImages(job.source, job.key, resumeMessage(source.describe(job), plan.question, plan.answer)));
      } catch (error) {
        await db
          .update(jobs)
          .set({ delivered_reply_ids: job.delivered_reply_ids, answered_at: job.answered_at, answer: job.answer })
          .where(eq(jobs.id, job.id));
        throw error;
      }
    }

    const summary = alive
      ? "Answer received; the thread resumes from triage."
      : "Answer received; a fresh thread will pick it up.";
    await postEvent({
      eventId: runnerEventId("resume", job.external_id, replyIds.join(",")),
      sessionId: job.session_id ?? runnerEventId("resume", job.external_id),
      at: now.getTime(),
      kind: "stage",
      stage: "queued",
      summary,
      answer: plan.answer.slice(0, 4000),
      jobKey: job.key,
    });
    await source.acknowledgeReplies(job, replyIds);
    resumed.push(`${job.key}:${alive ? "sent" : "relaunch"}`);
  }
  return resumed;
}

/** Nudges stuck runs once, then fails them; see lib/watchdog.ts for when a run counts as stuck. */
export async function watchdog() {
  const working = await db
    .select({
      job: jobs,
      // Only the current attempt's runs: an earlier attempt's thread must not keep a retry looking alive.
      lastEventAt: sql<Date | null>`(select max(${runs.last_event_at}) from ${runs} where ${runs.job_key} = ${jobs.key} and ${runs.branch} = case when ${jobs.attempt} > 1 then 'factory/' || ${jobs.key} || '-a' || ${jobs.attempt} else 'factory/' || ${jobs.key} end)`.mapWith(
        (v: string | null) => (v ? new Date(v) : null),
      ),
    })
    .from(jobs)
    .where(and(await mine(), inArray(jobs.stage, IN_FLIGHT), or(isNotNull(jobs.t3_thread_id), isNotNull(jobs.session_id))));
  const actions: string[] = [];
  // Tracking depends on the driver, not the instance id: a renamed Claude Code instance still reports.
  let drivers = new Map<string, string>();
  try {
    drivers = new Map(readHarnesses().map((h) => [h.id, h.driver]));
  } catch {
    // Unknown instances fall back to their id, which equals the driver for T3's default instances.
  }
  for (const { job, lastEventAt } of working) {
    const now = new Date();
    const action = watch(
      {
        stage: job.stage,
        lastEventAt: lastEventAt ?? job.updated_at,
        nudgedAt: job.nudged_at,
        nudgedStage: job.nudged_stage,
        thread: await threads.state(job.t3_thread_id),
        tracked: isTracked(drivers.get(job.provider ?? config.factory.provider) ?? job.provider ?? config.factory.provider),
        now,
      },
      config.factory,
    );
    if (action.kind === "ok") continue;
    if (action.kind === "reset") {
      await db.update(jobs).set({ nudged_at: null, nudged_stage: null }).where(eq(jobs.id, job.id));
      continue;
    }
    if (action.kind === "nudge") {
      const claimed = await db
        .update(jobs)
        .set({ nudged_at: now, nudged_stage: job.stage, updated_at: now })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.stage, job.stage),
            or(isNull(jobs.nudged_stage), ne(jobs.nudged_stage, job.stage)),
          ),
        )
        .returning({ key: jobs.key });
      if (claimed.length === 0) continue;
      try {
        await threads.send(job.t3_thread_id!, nudgeMessage(job.key, job.stage, action.idleMinutes));
      } catch (error) {
        await db
          .update(jobs)
          .set({ nudged_at: job.nudged_at, nudged_stage: job.nudged_stage })
          .where(eq(jobs.id, job.id));
        throw error;
      }
      actions.push(`${job.key}:nudged`);
      continue;
    }
    // Fail only the stage this pass looked at: a report that landed since then wins.
    const eventId = runnerEventId("watchdog", job.external_id, job.attempt, job.stage_event_id ?? job.stage);
    const summary = `Watchdog stopped this run: ${action.reason}.`;
    const failed = await db
      .update(jobs)
      .set({ stage: "failed", stage_at: now, stage_summary: summary, question: null, stage_event_id: eventId, updated_at: now })
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.stage, job.stage),
          sql`${jobs.stage_event_id} is not distinct from ${job.stage_event_id}`,
        ),
      )
      .returning({ key: jobs.key });
    if (failed.length === 0) continue;
    await postEvent({
      eventId,
      sessionId: job.session_id ?? runnerEventId("watchdog", job.external_id),
      at: now.getTime(),
      kind: "stage",
      stage: "failed",
      summary,
      jobKey: job.key,
    });
    actions.push(`${job.key}:failed`);
  }
  return actions;
}

/**
 * Rebuilds usage from transcripts for factory runs whose numbers fell behind, such as a run
 * interrupted before its Stop hook. It goes through the same greatest() projection as every
 * usage event, keyed on the totals, so replays and live updates cannot double count.
 */
export async function reconcileUsage() {
  const recent = await db
    .select()
    .from(runs)
    .where(and(isNotNull(runs.job_key), gt(runs.last_event_at, new Date(Date.now() - 7 * 86_400_000))));
  const fixed: string[] = [];
  for (const run of recent) {
    const path = transcriptPathFor(run);
    if (!path || !existsSync(path)) continue;
    const usage = sumUsage(readTranscript(path));
    if (usage.model === "unknown") continue;
    const subagents = subagentTranscripts(path, run.session_id);
    const rows = await db.select().from(agents).where(eq(agents.session_id, run.session_id));
    const lags = (u: Usage, row: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number } | undefined) =>
      !row ||
      u.input > row.input_tokens ||
      u.output > row.output_tokens ||
      u.cacheRead > row.cache_read_tokens ||
      u.cacheWrite > row.cache_write_tokens;
    const behind = lags(usage, run) || subagents.some((s) => lags(s.usage, rows.find((r) => r.agent_id === s.agentId)));
    if (!behind) continue;
    const fingerprint = [usage, ...subagents.map((s) => s.usage)]
      .map((u) => `${u.input}.${u.output}.${u.cacheRead}.${u.cacheWrite}`)
      .join(":");
    await postEvent({
      eventId: `reconcile:${run.session_id}:${fingerprint}`,
      sessionId: run.session_id,
      // The transcript's own last write, so the watchdog never mistakes a reconcile for activity.
      at: Math.min(Math.floor(statSync(path).mtimeMs), run.last_event_at.getTime()),
      kind: "usage",
      usage,
      agents: subagents,
      transcriptPath: path,
    });
    fixed.push(run.job_key!);
  }
  return fixed;
}

/** Backstop for the budget hook: a working job over its attempt's cap fails even if its thread never reports it. */
export async function enforceBudget() {
  const working = await db.select().from(jobs).where(and(await mine(), inArray(jobs.stage, IN_FLIGHT)));
  const spend = await branchSpend(db, working.map((j) => attemptBranch(j.key, j.attempt)));
  const over: string[] = [];
  for (const job of working) {
    const usd = spend[attemptBranch(job.key, job.attempt)] ?? 0;
    if (usd < job.budget_usd) continue;
    await postEvent({
      // Keyed on the stage it fails, so a run that reports again after this still gets failed again.
      eventId: runnerEventId("budget", job.external_id, job.attempt, job.stage_event_id ?? job.stage),
      sessionId: job.session_id ?? runnerEventId("budget", job.external_id),
      at: Date.now(),
      kind: "stage",
      stage: "failed",
      summary: `budget exceeded ($${usd.toFixed(2)} of $${job.budget_usd.toFixed(2)})`,
      jobKey: job.key,
    });
    over.push(job.key);
  }
  return over;
}

/**
 * Reports each job's new stage to its source. A job no machine holds can still move, as when its PR
 * merges, so every machine writes it back; source writes are keyed on the stage event, so two
 * machines writing the same one converge.
 */
export async function writeBack() {
  const pending = parseJobs(
    await db
      .select()
      .from(jobs)
      .where(
        and(
          or(await mine(), isNull(jobs.machine_id)),
          isNotNull(jobs.stage_event_id),
          or(isNull(jobs.synced_event_id), ne(jobs.synced_event_id, jobs.stage_event_id)),
        ),
      ),
  );
  const synced: string[] = [];
  await eachJob(pending, "write back", async (job) => {
    const written = await sourceFor(job.source).writeBack(job, { stage: job.stage, eventId: job.stage_event_id! });
    // Only this event counts as synced; a newer one that landed meanwhile goes next pass.
    await db
      .update(jobs)
      .set({ synced_event_id: job.stage_event_id })
      .where(and(eq(jobs.id, job.id), eq(jobs.stage_event_id, job.stage_event_id!)));
    if (written) synced.push(`${job.key}:${job.stage}`);
  });
  return synced;
}

/**
 * Runs a source step for each job on its own, so one issue the source refuses (deleted, no access,
 * a malformed state) does not hold back the rest. The failures are thrown together at the end, so
 * an intent is retried and the timer reports them; the jobs that went through are not redone.
 */
async function eachJob(list: readonly Job[], what: string, step: (job: Job) => Promise<void>) {
  const failed: string[] = [];
  for (const job of list) {
    await step(job).catch((error: unknown) => void failed.push(`${job.key}: ${error instanceof Error ? error.message : String(error)}`));
  }
  if (failed.length > 0) throw new Error(`could not ${what} ${failed.join("; ")}`);
}

/** This machine's factory checkouts, keyed by the GitHub repo each one tracks. */
export async function factoryCheckouts() {
  const checkouts = new Map<string, string>();
  for (const path of config.factory.repos) checkouts.set(await checkoutRepo(path), path);
  return checkouts;
}

const factoryRepos = async () => [...(await factoryCheckouts()).keys()];

/**
 * Claims ready jobs this machine has room for: its own working jobs plus the queued jobs no
 * machine holds yet in its repos stay under maxInFlight, so each machine queues only what it could
 * launch and the rest waits for one with room. The row insert is the claim; the advisory lock
 * serializes claimers. A source names no repo yet, so a new job goes to this machine's first one.
 */
export async function claim({
  source = sourceFor("linear"),
  repos = factoryRepos,
}: { source?: SourceAdapter<JobSource>; repos?: () => Promise<string[]> } = {}) {
  const ready: JobDraft[] = await source.ready();
  if (ready.length === 0) return { claimed: [], inFlight: 0 };
  const targets = await repos();
  const target = targets[0];
  if (!target) throw new Error("factory.repos is empty, so there is no repository to claim work for");
  const me = await mine();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('marshal-factory linear-poll'))`);
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(
        or(
          and(me, inArray(jobs.stage, IN_FLIGHT)),
          and(isNull(jobs.machine_id), eq(jobs.stage, "queued"), inArray(jobs.repo, targets)),
        ),
      );
    let inFlight = count;
    const claimed: string[] = [];
    for (const draft of ready) {
      if (inFlight >= config.factory.maxInFlight) break;
      const now = new Date();
      const inserted = await tx
        .insert(jobs)
        .values({
          id: jobId(source.source, draft.externalId),
          source: source.source,
          external_id: draft.externalId,
          key: draft.key,
          title: draft.title,
          url: draft.url,
          description: draft.description,
          repo: target,
          writeback: draft.writeback,
          source_state: draft.sourceState,
          budget_usd: config.factory.budgetUsd,
          claimed_at: now,
          updated_at: now,
        })
        // A failed job that got its label back is retried as a fresh attempt on a new branch.
        .onConflictDoUpdate({
          target: jobs.id,
          set: {
            attempt: sql`${jobs.attempt} + 1`,
            previous_failure: sql`${jobs.stage_summary}`,
            stage: "queued",
            stage_at: null,
            stage_summary: null,
            question: null,
            pr_url: null,
            stage_event_id: null,
            synced_event_id: null,
            t3_thread_id: null,
            machine_id: null,
            provider: null,
            model: null,
            session_id: null,
            nudged_at: null,
            nudged_stage: null,
            conflict_head: null,
            resume_context: null,
            stop_sent_to: null,
            stop_event_id: null,
            answered_at: null,
            answer: null,
            title: draft.title,
            url: draft.url,
            description: draft.description,
            repo: target,
            writeback: draft.writeback,
            source_state: sql`${jobs.source_state} || excluded.source_state`,
            budget_usd: config.factory.budgetUsd,
            claimed_at: now,
            updated_at: now,
          },
          // No new attempt while a launch is pending or a stop is owed; see runner/binding.ts.
          setWhere: canReclaimSql,
        })
        .returning({ key: jobs.key });
      if (inserted.length === 0) continue;
      inFlight++;
      claimed.push(draft.key);
    }
    return { claimed, inFlight };
  });
}

/** Tells each queued job's source it was picked up; the adapter skips jobs it already announced. */
export async function announceClaims() {
  const queued = await db
    .select()
    .from(jobs)
    .where(and(await mine(), eq(jobs.stage, "queued")))
    .orderBy(asc(jobs.claimed_at), asc(jobs.key));
  await eachJob(parseJobs(queued), "announce", (job) => sourceFor(job.source).announceClaim(job));
}

function launchMessage(job: Job) {
  return [
    `Work ${sourceFor(job.source).describe(job)}: ${job.title}`,
    job.url,
    "",
    "This is an unattended marshal-factory run. Follow the factory playbook in .agents/playbooks/factory.md. Report every stage with the report_stage tool, never ask in this thread, never merge.",
    "",
    "## Issue",
    "",
    job.description?.trim() || "(The issue has no description.)",
    ...(job.previous_failure
      ? [
          "",
          `This is attempt ${job.attempt}. The previous attempt failed: ${job.previous_failure} Start fresh from main on this branch.`,
        ]
      : []),
    ...(job.resume_context
      ? [
          "",
          "An earlier run on this branch stopped with a question, and the reporter answered it. Treat the answer as the spec.",
          "",
          job.resume_context,
        ]
      : []),
  ].join("\n");
}

/**
 * The text a thread gets, with the source's private images saved on this machine and listed. A
 * failure here keeps the original text: the agent can still work, and a launch is never blocked.
 */
export async function withLocalImages(source: JobSource, key: string, text: string) {
  try {
    return (await sourceFor(source).localizeImages?.({ key }, text)) ?? text;
  } catch (error) {
    console.log(JSON.stringify({ at: new Date().toISOString(), event: "images:error", key, error: error instanceof Error ? error.message : String(error) }));
    return text;
  }
}

export async function toLaunch() {
  const rows = await db
    .select()
    .from(jobs)
    .where(
      and(
        // A waiting job whose thread died and whose question was answered relaunches too.
        or(eq(jobs.stage, "queued"), and(eq(jobs.stage, "waiting"), isNotNull(jobs.resume_context))),
        isNull(jobs.t3_thread_id),
        isNull(jobs.session_id),
        isNull(jobs.machine_id),
      ),
    )
    .orderBy(asc(jobs.claimed_at), asc(jobs.key));
  return parseJobs(rows).map((job) => ({
    key: job.key,
    source: job.source,
    repo: job.repo,
    branch: attemptBranch(job.key, job.attempt),
    threadTitle: `${job.key} ${job.title}`,
    message: launchMessage(job),
  }));
}

export async function cleanup(dryRun = false) {
  const all = await db.select().from(jobs);
  const byKey = new Map(all.map((j) => [j.key, j]));
  // One after the other: both edit the same repo's worktree list and refs, and git locks them.
  // Each on its own, so a repo GitHub or T3 cannot answer for still gets its subagent worktrees cleaned.
  const reports = [];
  const errors: { repo: string; step: string; error: string }[] = [];
  const steps = [
    ["factory", (repo: string) => cleanupRepo(repo, byKey, config.factory.cleanupGraceDays, { dryRun })],
    ["subagents", (repo: string) => cleanupSubagentWorktrees(repo, config.factory.subagentIdleHours, { dryRun })],
  ] as const;
  for (const repo of config.factory.repos) {
    for (const [step, clean] of steps) {
      try {
        reports.push(await clean(repo));
      } catch (error) {
        errors.push({ repo, step, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return {
    removed: reports.flatMap((r) => r.removed),
    held: reports.flatMap((r) => r.held),
    archive: reports.flatMap((r) => r.archive),
    errors,
  };
}

/**
 * The one way the runner binds a thread to a job. It delivers an owed stop right after, so a
 * stop recorded while the launch was pending reaches the thread however the binding happened.
 */
export async function bindThread(key: string, threadId: string) {
  const [bound] = await db
    .update(jobs)
    .set({ t3_thread_id: threadId, updated_at: new Date() })
    .where(eq(jobs.key, key))
    .returning({ id: jobs.id });
  if (!bound) throw new Error(`No claimed job ${key}`);
  const stopped = await deliverStops(bound.id);
  return { bound: key, threadId, stopped: stopped.length > 0 };
}

/** True when GitHub has finished computing mergeability for every open factory PR. */
export async function pullRequestsSettled() {
  const open = await db.select().from(jobs).where(and(await mine(), eq(jobs.stage, "pr"), isNotNull(jobs.pr_url)));
  for (const job of open) {
    if ((await github.pullRequest(job.pr_url!)).mergeable === "unknown") return false;
  }
  return true;
}

/**
 * The source took the job away: the factory label came off, or the issue was canceled or
 * deleted. A run still in flight or waiting is told to stop and marked failed; the source already
 * says what the human wants, so nothing is written back.
 */
export async function stopJob(id: JobId, detail: string) {
  const { source, externalId } = parseJobId(id);
  // A stop intent can come from an unrelated label change; act only if the source really took the job away.
  const check = await sourceFor(source).confirmStop(externalId, detail);
  if (!check.stop) return "still labeled";
  const reopen = check.reopen;

  // A stage report can land between the read and the claim; read again and retry the claim.
  for (let tries = 0; tries < 3; tries++) {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    if (!row) return "not claimed";
    const job = parseJob(row);
    // Stopped already, perhaps by a retry whose side effects failed: finish them, they are idempotent.
    // A stopped job that merged since is done; only a stop still owed to its thread is left to send.
    if (isStopped(job)) {
      if (job.stage === "failed") return finishStop(job, reopen);
      await deliverStops(job.id);
      return "stopped";
    }
    if (!canTransition(job.stage, "failed", "stop")) return "not running";

    const eventId = runnerEventId("stop", job.external_id, job.attempt, job.stage_event_id ?? job.stage);
    const now = new Date();
    const [stopped] = await db
      .update(jobs)
      .set({ stage: "failed", stage_at: now, stage_summary: `Stopped: ${detail}.`, question: null, stage_event_id: eventId, synced_event_id: eventId, stop_event_id: eventId, updated_at: now })
      .where(and(eq(jobs.id, id), eq(jobs.stage, job.stage), sql`${jobs.stage_event_id} is not distinct from ${job.stage_event_id}`))
      .returning();
    if (!stopped) continue;
    return finishStop(parseJob(stopped), reopen);
  }
  throw new Error("the stage kept changing; the stop is retried");
}

/**
 * The stop is recorded on the job, so it survives whatever happens to the thread binding. The
 * message goes to whichever thread the job is bound to, once per thread: now if it is known,
 * or when a launch, its recovery or the thread's own session start records it.
 */
async function finishStop(job: Job, reopen: boolean) {
  await deliverStops(job.id);
  await postEvent({
    eventId: job.stage_event_id,
    sessionId: job.session_id ?? runnerEventId("stop", job.external_id),
    at: job.stage_at!.getTime(),
    kind: "stage",
    stage: "failed",
    summary: job.stage_summary,
    jobKey: job.key,
  });
  // Back to the not-started state, so adding the label again retries it as a new attempt, as for any failure.
  if (reopen) await sourceFor(job.source).reopen(job);
  return "stopped";
}

export type LaunchSlot = { id: string; repos: readonly string[]; maxInFlight: number };

/** The harness new threads start on: the panel's saved settings, else this runner's config. */
export async function effectiveHarness() {
  return resolveHarness(await readSettings(db), config.factory);
}

/**
 * Marks a queued job as being launched by this machine, as one compare-and-set: false when another
 * launch or machine holds the job, the machine has no checkout of its repo, or the machine is full.
 * The capacity count is read in the same statement, which holds because one machine runs one
 * runner and its launches run one at a time. The harness is recorded with the marker, so a launch
 * that launch recovery binds later still says what it ran on.
 */
export async function claimLaunch(key: string, marker: string, machine: LaunchSlot, harness?: HarnessChoice) {
  if (machine.repos.length === 0) return false;
  const working = sql.join(IN_FLIGHT.map((stage) => sql`${stage}`), sql`, `);
  const claimed = await db
    .update(jobs)
    .set({ t3_thread_id: marker, machine_id: machine.id, ...(harness && { provider: harness.provider, model: harness.model }) })
    .where(
      and(
        eq(jobs.key, key),
        isNull(jobs.t3_thread_id),
        isNull(jobs.session_id),
        isNull(jobs.machine_id),
        inArray(jobs.repo, [...machine.repos]),
        sql`(select count(*) from jobs held where held.machine_id = ${machine.id} and held.stage in (${working})) < ${machine.maxInFlight}`,
      ),
    )
    .returning({ key: jobs.key });
  return claimed.length > 0;
}

export async function releaseLaunch(key: string, marker: string) {
  await db
    .update(jobs)
    .set({ t3_thread_id: null, machine_id: null, provider: null, model: null })
    .where(and(eq(jobs.key, key), eq(jobs.t3_thread_id, marker)));
}

export async function machineInFlight(machineId: string) {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.machine_id, machineId), inArray(jobs.stage, IN_FLIGHT)));
  return count;
}

export async function pendingLaunches() {
  const rows = await db
    .select()
    .from(jobs)
    .where(and(await mine(), sql`${jobs.t3_thread_id} like ${`${PENDING}%`}`));
  return rows.map((i) => ({ key: i.key, repo: i.repo, marker: i.t3_thread_id!, branch: attemptBranch(i.key, i.attempt), stage: i.stage }));
}


/** Sends the stop message to every stopped job's thread that has not had it; claimed per thread. */
export async function deliverStops(id?: JobId) {
  const due = await db
    .select()
    .from(jobs)
    .where(and(await mine(), stopDeliverableSql, id ? eq(jobs.id, id) : undefined));
  const delivered: string[] = [];
  for (const job of due) {
    const threadId = job.t3_thread_id!;
    const [claimed] = await db
      .update(jobs)
      .set({ stop_sent_to: threadId })
      .where(and(eq(jobs.id, job.id), eq(jobs.t3_thread_id, threadId), sql`${jobs.stop_sent_to} is distinct from ${threadId}`))
      .returning({ key: jobs.key });
    if (!claimed) continue;
    try {
      if ((await threads.state(threadId)) !== "gone") {
        await threads.send(
          threadId,
          `Stop working on ${job.key}. ${job.stage === "failed" ? job.stage_summary : "The factory stopped this run."} Do not push, do not open or update a PR. End the turn now.`,
        );
      }
    } catch (error) {
      await db
        .update(jobs)
        .set({ stop_sent_to: job.stop_sent_to })
        .where(and(eq(jobs.id, job.id), eq(jobs.stop_sent_to, threadId)));
      throw error;
    }
    delivered.push(job.key);
  }
  return delivered;
}

/**
 * A missed stop webhook must not leave a run going. Each tick reads every claimed, unfinished
 * job from its source in one query and records a stop through stopJob, the webhook's own path,
 * for any that lost the label, was closed, or is gone. A failed fetch decides nothing.
 */
export async function reconcileStops({
  source = sourceFor("linear"),
  stop = stopJob,
  only,
}: {
  source?: SourceAdapter<JobSource>;
  stop?: (id: JobId, detail: string) => Promise<string>;
  /** Restricts the check to these jobs; the regression script uses it to stay off live ones. */
  only?: JobId[];
} = {}) {
  // A job no machine holds yet has no thread, so any machine may record its stop.
  const unfinished = and(eq(jobs.source, source.source), inArray(jobs.stage, STOPPABLE), or(await mine(), isNull(jobs.machine_id)));
  const open = parseJobs(await db.select().from(jobs).where(only ? and(unfinished, inArray(jobs.id, only)) : unfinished));
  if (open.length === 0) return [];
  let wanted: Awaited<ReturnType<typeof source.stopWanted>>;
  try {
    wanted = await source.stopWanted(open);
  } catch (error) {
    return { unknown: error instanceof Error ? error.message : String(error) };
  }
  const stopped = [];
  for (const { job, reason } of wanted) {
    stopped.push({ key: job.key, reason, result: await stop(job.id, reason) });
  }
  return stopped;
}
