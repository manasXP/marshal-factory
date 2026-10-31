import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db/client";
import { agents, jobs, runs, type JobRow, type RunRow } from "../db/schema";
import { STAGES, type Stage, type Usage } from "../lib/events";
import { allSources, jobId, parseJob, parseJobs, sourceFor } from "../lib/sources";
import { parseJobId, SOURCE_SHAPES } from "../lib/sources/shapes";
import { SourceGoneError, type Job, type JobDraft, type JobId, type JobSource, type SourceAdapter } from "../lib/sources/types";
import { canTransition, runnerEventId } from "../lib/stages";
import { subagentTranscripts, sumUsage, transcriptPathFor } from "../lib/transcript";
import { checkoutRepo, cleanupRepo, cleanupSubagentWorktrees } from "../lib/worktrees";
import { github } from "../lib/github/pulls";
import { claimConflict, conflictMessage, unclaimedRunsWithPr } from "../lib/conflicts";
import { attemptBranch, isJobKey, isMcpSession } from "../lib/factory";
import { ownerNoteSection } from "../lib/inbox";
import { attemptBranchSql } from "../lib/branch-sql";
import { nudgeMessage, watch } from "../lib/watchdog";
import { factoryPlaybook, jobExecution } from "../lib/playbook";
import { isTracked } from "../lib/harness";
import { readHarnesses } from "../lib/t3-state";
import { readSettings, resolveExecution, resolveHarness, type HarnessChoice } from "../lib/settings";
import type { Execution } from "../lib/execution";
import type { TicketRecord } from "../lib/ticket-overrides";
import { readRegistry, registerRepos, routeRepo, type Registry } from "../lib/repositories";
import { heldIds, heldSql, inQueueOrder, pausedSql, readPause, readQueueControls, recordBacklog } from "../lib/queue";
import { ensureAwake, HostGoneError, hosts, isHibernated, WakeDeferredError, type JobHost } from "../lib/host";
import { requestedStop } from "../lib/stop";
import { bindingOf, canReclaimSql, heldStoppingSql, isStopped, PENDING, stopDeliverableSql, stoppingSql } from "./binding";
import { config } from "./config";
import { thisMachine } from "./heartbeat";
import { leaseSlot, teardownSandbox } from "./lifecycle";
import { backendOf } from "./sandbox-backend";
import { confirmStops, stopDelivered } from "./stops";
import { postEvent } from "./ingest-client";
import { recordCodexUsage } from "./codex-usage";

export { ingestClient, postEvent } from "./ingest-client";
import { ACTIVE_RUN_STATUSES, threads } from "./threads";
import { claimReplies, qaBlock, resumeMessage } from "../lib/resume";
import { branchSpend } from "../lib/spend";
import { isSpendPause, money, pauseQuestion, raisedLimit, spendResumeMessage } from "../lib/spend-limit";

// The factory's deterministic work. The runner calls these from webhook intents, its timer and
// its startup reconcile; every one of them is idempotent, so calling one twice changes nothing.
// Each acts only on this machine's jobs: another machine's thread, worktree and transcripts are
// out of reach here, so its own runner watches, bills, writes back and stops them.

export { config, threads };

hosts.sandbox = (sandboxId) => backendOf(sandboxId).host(sandboxId);

const mine = async () => eq(jobs.machine_id, (await thisMachine()).id);

/** Stages where a thread is working; waiting, pr, merged and failed free the slot. */
export const IN_FLIGHT: Stage[] = ["queued", "triage", "investigating", "implementing", "verifying"];
const STOPPABLE = STAGES.filter((stage) => canTransition(stage, "failed", "stop"));

/**
 * Follows every factory PR: a merged one moves its job to merged, and one that conflicts with
 * main while its job sits in pr sends the thread back to merge main. The conflict is handled
 * once per PR head, so a pass never repeats the request while the thread works on it. Each PR is
 * checked on its own: one that fails (an uninstalled repo, a bad URL, a GitHub hiccup) is reported
 * and the next timer pass retries it, while the rest of this pass goes on. A job no machine holds,
 * such as a resume waiting for a fresh thread, has no thread to send back, but its merge counts.
 */
export async function checkPullRequests({ only }: { only?: readonly string[] } = {}) {
  const open = parseJobs(
    await db
      .select()
      .from(jobs)
      .where(and(or(await mine(), isNull(jobs.machine_id)), isNotNull(jobs.pr_url), ne(jobs.stage, "merged"), only ? inArray(jobs.key, [...only]) : undefined))
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

  for (const run of (await unclaimedRunsWithPr(db)).filter((r) => !only || only.includes(r.job_key!))) {
    await each(run.job_key!, run.pr_url!, async () => {
      if ((await github.pullRequest(run.pr_url!)).state === "merged") await postMerged(run.job_key!, run.pr_url!, run.session_id);
    });
  }
  return { conflicts, errors };
}

/** A merge goes in as a stage event, so the run, the job, the timeline and the write-back all follow it. */
export async function postMerged(jobKey: string, prUrl: string, sessionId: string) {
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
  // Handled already: checked before a hibernated job is woken for it.
  if (job.conflict_head === head) return false;
  // Ask T3 first: a CLI error then fails this PR's check before anything is claimed.
  const host = await ensureAwake(job).catch((error: unknown) => {
    if (error instanceof WakeDeferredError) return null;
    throw error;
  });
  if (!host) return false;
  const thread = await threads.state(job.t3_thread_id, host);
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
    await threads.send(job.t3_thread_id!, conflictMessage(job.key, job.pr_url!, factoryPlaybook(jobExecution(job))), host);
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

const threadAlive = async (threadId: string | null, host: JobHost) => (await threads.state(threadId, host)) !== "gone";

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
    const host = await ensureAwake(job).catch((error: unknown) => {
      if (error instanceof WakeDeferredError) return null;
      throw error;
    });
    if (!host) {
      resumed.push(`${job.key}:wake-deferred`);
      continue;
    }
    const alive = await threadAlive(job.t3_thread_id, host);
    // A fresh thread launches in a fresh sandbox, so the dead one's sandbox, snapshot and slot go
    // first, as they are now: a wake replaced the snapshot with a sandbox and a slot.
    if (!alive) {
      const [current] = await db.select().from(jobs).where(eq(jobs.id, job.id));
      if (current) await teardownSandbox(current);
    }
    // A dead thread is unlinked in the same update that claims the replies, so the relaunch
    // cannot be lost to a later failure in this pass.
    const relaunch = alive ? undefined : qaBlock(plan.question, plan.answer);
    // A spend pause resumes under the limit the answer sets; the thread carries on instead of starting over.
    const raise = isSpendPause(job) ? await raisedSpendLimit(job, plan.answer) : undefined;
    if (!(await claimReplies(db, job.id, replyIds, plan.answer, now, relaunch))) continue;
    if (raise) await db.update(jobs).set({ budget_usd: raise.limit }).where(eq(jobs.id, job.id));

    if (alive) {
      const message = raise
        ? spendResumeMessage(source.describe(job), raise.spent, raise.limit, factoryPlaybook(jobExecution(job)))
        : resumeMessage(source.describe(job), plan.question, plan.answer, factoryPlaybook(jobExecution(job)));
      try {
        await threads.send(job.t3_thread_id!, await withLocalImages(job.source, job.key, message), host);
      } catch (error) {
        await db
          .update(jobs)
          .set({ delivered_reply_ids: job.delivered_reply_ids, answered_at: job.answered_at, answer: job.answer, budget_usd: job.budget_usd })
          .where(eq(jobs.id, job.id));
        throw error;
      }
    }

    const summary = raise
      ? `Spend limit raised to ${money(raise.limit)}; ${alive ? "the thread continues where it stopped." : "a fresh thread will pick it up."}`
      : alive
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

/** The limit a new attempt gets, and how far an answer without an amount raises a paused one. */
async function currentSpendLimit() {
  return (await readSettings(db))?.spend_limit_usd ?? config.factory.spendLimitUsd;
}

async function attemptSpend(job: Pick<Job, "key" | "attempt">) {
  const branch = attemptBranch(job.key, job.attempt);
  return (await branchSpend(db, [branch], config.factory.pricing))[branch] ?? 0;
}

async function raisedSpendLimit(job: Job, answer: string) {
  const spent = await attemptSpend(job);
  return { spent, limit: raisedLimit(answer, spent, job.budget_usd, await currentSpendLimit()) };
}

/**
 * Asks T3 to interrupt the job's thread and its running subagent threads. A request id per pause
 * and run makes a repeat on a later tick a no-op for T3. Best effort: what it could not reach is
 * returned for the log, and the next tick asks again while the job stays paused.
 */
async function interruptForSpend(job: Job, pauseEventId: string) {
  const threadId = job.t3_thread_id;
  if (!threadId || bindingOf(threadId) === "pending" || isHibernated(job)) return "nothing to interrupt";
  try {
    const host = hosts.forJob(job);
    const parent = await threads.activity(threadId, host);
    if (parent.state === "gone") return "thread gone";
    const subagents = parent.projectId ? await threads.subagents(threadId, parent.projectId, host) : [];
    const targets = [
      ...(parent.state === "running" ? [{ threadId, runId: parent.activeRunId }] : []),
      ...subagents.filter((s) => ACTIVE_RUN_STATUSES.includes(s.status)).map((s) => ({ threadId: s.threadId, runId: s.latestRunId })),
    ];
    for (const target of targets) {
      await threads.interrupt(target.threadId, `marshal-factory:spend:${job.id}:${pauseEventId}:${target.threadId}:${target.runId ?? "latest"}`, `marshal-factory paused ${job.key} at its spend limit`, host);
    }
    return targets.length > 0 ? `interrupted ${targets.length}` : "idle";
  } catch (error) {
    return `could not interrupt: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
}

/**
 * Pauses every working attempt of this machine whose spend reached its limit: the job waits with
 * a question asking for a new limit, and its thread is interrupted. A paused job whose thread still
 * runs is interrupted again. Spend is read after reconcileUsage, so it is at most a tick old.
 */
export async function enforceSpendLimits() {
  const rows = parseJobs(await db.select().from(jobs).where(and(await mine(), inArray(jobs.stage, [...IN_FLIGHT, "waiting"]))));
  const working = rows.filter((j) => j.stage !== "waiting" || isSpendPause(j));
  if (working.length === 0) return [];
  const spend = await branchSpend(db, working.map((j) => attemptBranch(j.key, j.attempt)), config.factory.pricing);
  const increment = await currentSpendLimit();
  const paused: string[] = [];
  for (const job of working) {
    if (isSpendPause(job)) {
      const outcome = await interruptForSpend(job, job.stage_event_id!);
      if (outcome.startsWith("interrupted") || outcome.startsWith("could not")) paused.push(`${job.key}:${outcome}`);
      continue;
    }
    const spent = spend[attemptBranch(job.key, job.attempt)] ?? 0;
    if (spent < job.budget_usd) continue;
    // Keyed on the stage it pauses, so a resumed attempt that reaches a raised limit pauses again.
    const eventId = runnerEventId("budget", job.external_id, job.attempt, job.stage_event_id ?? job.stage);
    await postEvent({
      eventId,
      sessionId: job.session_id ?? runnerEventId("budget", job.external_id),
      at: Date.now(),
      kind: "stage",
      stage: "waiting",
      summary: `Paused at the spend limit: ${money(spent)} of ${money(job.budget_usd)}.`,
      question: pauseQuestion(spent, job.budget_usd, increment),
      jobKey: job.key,
    });
    paused.push(`${job.key}:${await interruptForSpend(job, eventId)}`);
  }
  return paused;
}

/** Nudges stuck runs once, then fails them; see lib/watchdog.ts for when a run counts as stuck. */
export async function watchdog() {
  const working = await db
    .select({
      job: jobs,
      // Only the current attempt's runs: an earlier attempt's thread must not keep a retry looking alive.
      lastEventAt: sql<Date | null>`(select max(${runs.last_event_at}) from ${runs} where ${runs.job_key} = ${jobs.key} and ${runs.branch} = ${attemptBranchSql})`.mapWith(
        (v: string | null) => (v ? new Date(v) : null),
      ),
    })
    .from(jobs)
    .where(and(await mine(), inArray(jobs.stage, IN_FLIGHT), or(isNotNull(jobs.t3_thread_id), isNotNull(jobs.session_id))));
  const actions: string[] = [];
  const drivers = harnessDrivers();
  for (const { job, lastEventAt } of working) {
    // Only pr and waiting jobs hibernate; looking must never wake one.
    if (isHibernated(job)) continue;
    const now = new Date();
    const host = hosts.forJob(job);
    const action = watch(
      {
        stage: job.stage,
        lastEventAt: lastEventAt ?? job.updated_at,
        nudgedAt: job.nudged_at,
        nudgedStage: job.nudged_stage,
        thread: await threads.state(job.t3_thread_id, host),
        tracked: jobTracked(job, drivers),
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
        await threads.send(job.t3_thread_id!, nudgeMessage(job.key, job.stage, action.idleMinutes, factoryPlaybook(jobExecution(job))), host);
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
    if (await watchdogFail(job, action.reason, now)) actions.push(`${job.key}:failed`);
  }
  return actions;
}

/** Each harness instance's driver. Tracking depends on the driver, not the instance id: a renamed Claude Code instance still reports. */
export function harnessDrivers() {
  try {
    return new Map(readHarnesses().map((h) => [h.id, h.driver]));
  } catch {
    // Unknown instances fall back to their id, which equals the driver for T3's default instances.
    return new Map<string, string>();
  }
}

export const jobTracked = (job: Pick<JobRow, "provider">, drivers: ReadonlyMap<string, string>) =>
  isTracked(drivers.get(job.provider ?? config.factory.provider) ?? job.provider ?? config.factory.provider);

/** Fails the stage this pass looked at, so a report that landed since then wins; false when one did. */
export async function watchdogFail(job: Pick<JobRow, "id" | "key" | "external_id" | "attempt" | "stage" | "stage_event_id" | "session_id">, reason: string, now = new Date()) {
  const eventId = runnerEventId("watchdog", job.external_id, job.attempt, job.stage_event_id ?? job.stage);
  const summary = `Watchdog stopped this run: ${reason}.`;
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
  if (failed.length === 0) return false;
  await postEvent({
    eventId,
    sessionId: job.session_id ?? runnerEventId("watchdog", job.external_id),
    at: now.getTime(),
    kind: "stage",
    stage: "failed",
    summary,
    jobKey: job.key,
  });
  return true;
}

/**
 * Rebuilds usage from transcripts for factory runs whose numbers fell behind, such as a run
 * interrupted before its Stop hook. It goes through the same greatest() projection as every
 * usage event, keyed on the totals, so replays and live updates cannot double count. A Codex run
 * (`mcp:` session) is read from its rollouts instead, every pass, since nothing else reports it. A
 * run whose sandbox is gone has no transcripts left to read; it is skipped and the rest go on.
 */
export async function reconcileUsage({ only }: { only?: string[] } = {}) {
  const recent = await db
    .select({ run: runs, sandbox_id: jobs.sandbox_id, sandbox_snapshot: jobs.sandbox_snapshot, stage: jobs.stage })
    .from(runs)
    .leftJoin(jobs, eq(jobs.key, runs.job_key))
    .where(
      and(
        isNotNull(runs.job_key),
        gt(runs.last_event_at, new Date(Date.now() - 7 * 86_400_000)),
        only ? inArray(runs.job_key, only) : undefined,
      ),
    );
  const fixed: string[] = [];
  for (const { run, sandbox_id, sandbox_snapshot, stage } of recent) {
    // A hibernated job's transcripts are in its snapshot; its thread is settled, so nothing is behind.
    if (isHibernated({ key: run.job_key!, sandbox_id, sandbox_snapshot })) continue;
    try {
      const host = hosts.forJob({ key: run.job_key!, sandbox_id });
      // A merged or failed job's thread is done, so its subagents are settled.
      const final = stage === "merged" || stage === "failed";
      if (await (isMcpSession(run.session_id) ? recordCodexUsage(run, host, { final }) : reconcileRun(run, host))) fixed.push(run.job_key!);
    } catch (error) {
      if (!(error instanceof HostGoneError)) throw error;
      console.log(JSON.stringify({ at: new Date().toISOString(), event: "reconcile:skipped", key: run.job_key, session: run.session_id, reason: error.message }));
    }
  }
  return fixed;
}

/** Posts the run's usage when its transcripts are ahead of the board; true when it did. */
async function reconcileRun(run: RunRow, host: JobHost) {
  const path = transcriptPathFor(run);
  const transcript = path ? await host.readFile(path) : null;
  if (!path || transcript === null) return false;
  const usage = sumUsage(transcript);
  if (usage.model === "unknown") return false;
  const subagents = await subagentTranscripts(path, run.session_id, host);
  const rows = await db.select().from(agents).where(eq(agents.session_id, run.session_id));
  const lags = (u: Usage, row: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number } | undefined) =>
    !row ||
    u.input > row.input_tokens ||
    u.output > row.output_tokens ||
    u.cacheRead > row.cache_read_tokens ||
    u.cacheWrite > row.cache_write_tokens;
  const behind = lags(usage, run) || subagents.some((s) => lags(s.usage, rows.find((r) => r.agent_id === s.agentId)));
  if (!behind) return false;
  const fingerprint = [usage, ...subagents.map((s) => s.usage)]
    .map((u) => `${u.input}.${u.output}.${u.cacheRead}.${u.cacheWrite}`)
    .join(":");
  await postEvent({
    eventId: `reconcile:${run.session_id}:${fingerprint}`,
    sessionId: run.session_id,
    // The transcript's own last write, so the watchdog never mistakes a reconcile for activity.
    at: Math.min(Math.floor(await host.mtimeMs(path)), run.last_event_at.getTime()),
    kind: "usage",
    usage,
    agents: subagents,
    transcriptPath: path,
  });
  return true;
}

/**
 * Reports each job's new stage to its source. A job no machine holds can still move, as when its PR
 * merges, so every machine writes it back; source writes are keyed on the stage event, so two
 * machines writing the same one converge.
 */
export async function writeBack({ only }: { only?: readonly string[] } = {}) {
  const pending = parseJobs(
    await db
      .select()
      .from(jobs)
      .where(
        and(
          or(await mine(), isNull(jobs.machine_id)),
          isNotNull(jobs.stage_event_id),
          or(isNull(jobs.synced_event_id), ne(jobs.synced_event_id, jobs.stage_event_id)),
          // A stop is written back once it is confirmed or marked unconfirmed, not while it is on its way.
          sql`not ${stoppingSql}`,
          only ? inArray(jobs.key, [...only]) : undefined,
        ),
      )
      .orderBy(asc(jobs.key)),
  );
  const synced: string[] = [];
  const gaveUp: { key: string; reason: string }[] = [];
  const failures = await eachJob(pending, async (job) => {
    const eventId = job.stage_event_id!;
    const settle = () =>
      // Only this event counts as synced; a newer one that landed meanwhile goes next pass.
      db
        .update(jobs)
        .set({ synced_event_id: eventId })
        .where(and(eq(jobs.id, job.id), eq(jobs.stage_event_id, eventId)));
    try {
      const written = await sourceFor(job.source).writeBack(job, { stage: job.stage, eventId });
      await settle();
      if (written) synced.push(`${job.key}:${job.stage}`);
    } catch (error) {
      if (!(error instanceof SourceGoneError)) throw error;
      // Marking the event synced is the give-up record: no column needed, and a later stage event is tried afresh.
      await settle();
      gaveUp.push({ key: job.key, reason: error.message });
    }
  });
  return { synced, gaveUp, errors: failures };
}

/**
 * Runs a source step for each job on its own, so one issue the source refuses (a malformed state, an
 * outage) does not hold back the rest. Returns the failures instead of throwing, so a caller that
 * must not fail on them can report them; the jobs that went through are not redone.
 */
async function eachJob(list: readonly Job[], step: (job: Job) => Promise<void>) {
  const failed: string[] = [];
  for (const job of list) {
    await step(job).catch((error: unknown) => void failed.push(`${job.key}: ${error instanceof Error ? error.message : String(error)}`));
  }
  return failed;
}

/** This machine's factory checkouts, keyed by the GitHub repo each one tracks. */
export async function factoryCheckouts() {
  const checkouts = new Map<string, string>();
  for (const path of config.factory.repos) checkouts.set(await checkoutRepo(path), path);
  return checkouts;
}

const factoryRepos = async () => [...(await factoryCheckouts()).keys()];

/** Adds this machine's checkouts to the repository registry; the first becomes the default when none is. */
export async function registerCheckouts() {
  const repos = await factoryRepos();
  await registerRepos(db, repos, `runner ${(await thisMachine()).name}`, new Date());
  return repos;
}

/**
 * Claims ready jobs this machine has room for: its own working jobs plus the queued jobs no
 * machine holds yet in the repos it can launch stay under maxInFlight, so each machine queues only
 * what it could launch and the rest waits for one with room. The row insert is the claim; the
 * advisory lock serializes claimers. Each job goes to the repo its Repository label names, else to
 * the default repo (see lib/repositories.ts); with an empty registry, to this machine's first checkout.
 * A retry routes again from the labels the issue has now. Work the owner moved to the front is claimed
 * first, held work and everything while the factory is paused is not, and what is left unclaimed is
 * recorded as the backlog the panel's Queue page shows (lib/queue.ts).
 */
export async function claim({
  sources = allSources(),
  repos = factoryRepos,
  registry = () => readRegistry(db),
}: { sources?: readonly SourceAdapter<JobSource>[]; repos?: () => Promise<string[]>; registry?: () => Promise<Registry> } = {}) {
  const ready: { source: SourceAdapter<JobSource>; draft: JobDraft }[] = [];
  const read: JobSource[] = [];
  const failed: string[] = [];
  // One source down must not hold back the others; its error is thrown once they are claimed.
  for (const source of sources) {
    try {
      for (const draft of await source.ready()) {
        if (isJobKey(draft.key)) ready.push({ source, draft });
        else failed.push(`${source.source} offered ${draft.key}, which is not a job key (see lib/factory.ts)`);
      }
      read.push(source.source);
    } catch (error) {
      failed.push(`${source.source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const [paused, controls] = await Promise.all([readPause(db), readQueueControls(db)]);
  const held = heldIds(controls);
  const idOf = ({ source, draft }: (typeof ready)[number]) => jobId(source.source, draft.externalId);
  const claimable = paused ? [] : inQueueOrder(ready, idOf, controls).filter((r) => !held.has(idOf(r)));
  const known = await registry();
  const claimed = paused
    ? { claimed: [] as string[], inFlight: 0, paused: true }
    : claimable.length === 0
      ? { claimed: [] as string[], inFlight: 0 }
      : await claimDrafts(claimable, repos, known);
  // What a runner holds, or a failed job the claim can't take back yet, is not waiting to be claimed.
  const ids = ready.map(idOf);
  const holding = ids.length === 0 ? [] : await db.select({ id: jobs.id }).from(jobs).where(and(inArray(jobs.id, ids), sql`not ${canReclaimSql}`));
  const taken = new Set<string>(holding.map((j) => j.id));
  await recordBacklog(
    db,
    read,
    ready.filter((r) => !taken.has(idOf(r))).map(({ source, draft }) => ({
      id: jobId(source.source, draft.externalId),
      source: source.source,
      externalId: draft.externalId,
      key: draft.key,
      title: draft.title,
      url: draft.url,
      repo: routeRepo(source.overrides(draft.sourceState), known).repo ?? null,
    })),
    new Date(),
  );
  if (failed.length > 0) throw new Error(`could not read ready work from ${failed.join("; ")} (claimed ${claimed.claimed.join(", ") || "nothing"})`);
  return claimed;
}

async function claimDrafts(ready: readonly { source: SourceAdapter<JobSource>; draft: JobDraft }[], repos: () => Promise<string[]>, known: Registry) {
  const checkouts = await repos();
  const targets = [...new Set([...checkouts, ...known.filter((r) => r.enabled).map((r) => r.repo)])];
  if (targets.length === 0) throw new Error("no repository is registered and factory.repos is empty, so there is no repository to claim work for");
  const targetOf = (source: SourceAdapter<JobSource>, draft: JobDraft) => routeRepo(source.overrides(draft.sourceState), known).repo ?? checkouts[0] ?? targets[0]!;
  const me = await mine();
  // Every attempt claimed now, first or retried, gets the limit Settings name now.
  const spendLimit = await currentSpendLimit();
  return db.transaction(async (tx) => {
    // The lock's name predates other sources; runners on older code take the same one.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('marshal-factory linear-poll'))`);
    // A pause that landed since the claim pass read it is honored here, under the lock.
    if (await readPause(tx)) return { claimed: [] as string[], inFlight: 0, paused: true };
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(
        or(
          and(me, or(inArray(jobs.stage, IN_FLIGHT), stoppingSql)),
          // A held job will not launch, so it leaves its room to work that will.
          and(isNull(jobs.machine_id), eq(jobs.stage, "queued"), inArray(jobs.repo, targets), sql`not ${heldSql}`),
        ),
      );
    let inFlight = count;
    const claimed: string[] = [];
    for (const { source, draft } of ready) {
      if (inFlight >= config.factory.maxInFlight) break;
      const now = new Date();
      const target = targetOf(source, draft);
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
          budget_usd: spendLimit,
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
            execution: null,
            ticket_overrides: null,
            session_id: null,
            nudged_at: null,
            nudged_stage: null,
            conflict_head: null,
            resume_context: null,
            stop_sent_to: null,
            stop_event_id: null,
            stop: null,
            answered_at: null,
            answer: null,
            merge_assessment: null,
            merge_decision: null,
            title: draft.title,
            url: draft.url,
            description: draft.description,
            repo: target,
            writeback: draft.writeback,
            source_state: sql`${jobs.source_state} || excluded.source_state`,
            budget_usd: spendLimit,
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
  const failed = await eachJob(parseJobs(queued), (job) => sourceFor(job.source).announceClaim(job));
  // Thrown so the intent is retried and the timer reports it.
  if (failed.length > 0) throw new Error(`could not announce ${failed.join("; ")}`);
}

export function launchMessage(job: Job) {
  const ownerNote = ownerNoteSection(job);
  return [
    `Work ${sourceFor(job.source).describe(job)}: ${job.title}`,
    job.url,
    "",
    "This is an unattended marshal-factory run. Follow the factory playbook named under Factory playbook at the end of this message. Report every stage with the report_stage tool, never ask in this thread, never merge yourself: end with a merge assessment and the factory decides. Before you report pr, run factory-verify on the commit you pushed (the report_stage reply for verifying names the command); the factory merges only a head whose checks passed there.",
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
    ...(ownerNote ? ["", ownerNote] : []),
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
        // An earlier attempt's sandbox still holds its login until teardown hands it back.
        isNull(jobs.sandbox_id),
        isNull(jobs.sandbox_snapshot),
        isNull(jobs.codex_slot),
      ),
    )
    .orderBy(asc(jobs.claimed_at), asc(jobs.key));
  return parseJobs(rows).map((job) => ({
    job,
    key: job.key,
    sandbox_id: null,
    attempt: job.attempt,
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
 * says what the human wants, so nothing is written back. The stop is recorded on the job and
 * driven to a confirmed end by runner/stops.ts; the job keeps its capacity until then.
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
      if (job.stage === "failed") return finishStop(job);
      await deliverStops(job.id);
      return "stopped";
    }
    if (!canTransition(job.stage, "failed", "stop")) return "not running";

    const eventId = runnerEventId("stop", job.external_id, job.attempt, job.stage_event_id ?? job.stage);
    const now = new Date();
    const [stopped] = await db
      .update(jobs)
      .set({
        stage: "failed",
        stage_at: now,
        stage_summary: `Stopped: ${detail}.`,
        question: null,
        stage_event_id: eventId,
        synced_event_id: eventId,
        stop_event_id: eventId,
        stop: requestedStop({ at: now, by: SOURCE_SHAPES[job.source].label, reason: detail, reopen }),
        updated_at: now,
      })
      .where(and(eq(jobs.id, id), eq(jobs.stage, job.stage), sql`${jobs.stage_event_id} is not distinct from ${job.stage_event_id}`))
      .returning();
    if (!stopped) continue;
    return finishStop(parseJob(stopped));
  }
  throw new Error("the stage kept changing; the stop is retried");
}

/**
 * The stop is recorded on the job, so it survives whatever happens to the thread binding. The
 * message goes to whichever thread the job is bound to, once per thread: now if it is known,
 * or when a launch, its recovery or the thread's own session start records it. A first look at
 * the thread follows at once, so a job that never had one settles now; the source is reopened
 * when the stop settles (runner/stops.ts).
 */
export async function finishStop(job: Job) {
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
  await confirmStops({ only: [job.id] });
  return "stopped";
}

export type LaunchSlot = { id: string; repos: readonly string[]; maxInFlight: number };

/** The harness new threads start on: the panel's saved settings, else this runner's config. */
export async function effectiveHarness() {
  return resolveHarness(await readSettings(db), config.factory);
}

/** One read of the settings for a launch pass: the harness, and where threads start. */
export async function launchSettings() {
  const saved = await readSettings(db);
  return { harness: resolveHarness(saved, config.factory), execution: resolveExecution(saved) };
}

/**
 * Marks a queued job as being launched by this machine, as one compare-and-set: false when another
 * launch or machine holds the job, the machine has no checkout of its repo, the machine is full, or
 * the owner held the queued job or paused new work.
 * The capacity count is read in the same statement, which holds because one machine runs one
 * runner and its launches run one at a time. The harness, where it runs and the ticket's overrides
 * are recorded with the marker, so a launch that launch recovery binds later still says what it ran on.
 */
export async function claimLaunch(
  key: string,
  marker: string,
  machine: LaunchSlot,
  harness?: HarnessChoice,
  where?: { execution: Execution; ticket: TicketRecord | null },
) {
  if (machine.repos.length === 0) return false;
  const working = sql.join(IN_FLIGHT.map((stage) => sql`${stage}`), sql`, `);
  const claimed = await db
    .update(jobs)
    .set({
      t3_thread_id: marker,
      machine_id: machine.id,
      ...(harness && { provider: harness.provider, model: harness.model }),
      ...(where && { execution: where.execution, ticket_overrides: where.ticket }),
    })
    .where(
      and(
        eq(jobs.key, key),
        isNull(jobs.t3_thread_id),
        isNull(jobs.session_id),
        isNull(jobs.machine_id),
        inArray(jobs.repo, [...machine.repos]),
        sql`(select count(*) from jobs held where held.machine_id = ${machine.id} and (held.stage in (${working}) or ${heldStoppingSql})) < ${machine.maxInFlight}`,
        // A hold or a pause set while this pass ran still stops a queued job; an answered job relaunches regardless.
        sql`(${jobs.stage} <> 'queued' or not (${heldSql} or ${pausedSql}))`,
      ),
    )
    .returning({ key: jobs.key });
  return claimed.length > 0;
}

/** Clears a launch that made no thread, with any sandbox and login slot it held; the caller ends the sandbox first. */
export async function releaseLaunch(key: string, marker: string) {
  await db
    .update(jobs)
    .set({ t3_thread_id: null, machine_id: null, provider: null, model: null, execution: null, ticket_overrides: null, sandbox_id: null, codex_slot: null })
    .where(and(eq(jobs.key, key), eq(jobs.t3_thread_id, marker)));
}

/** Leases a free login slot to a launch that holds its marker; undefined when every slot is held. */
export const leaseCodexSlot = (key: string, marker: string, slots: readonly string[]) =>
  leaseSlot(and(eq(jobs.key, key), eq(jobs.t3_thread_id, marker)), slots);

/** Records the harness a launch fell back to after its sandbox refused the one it was claimed with. */
export async function recordHarness(key: string, marker: string, { provider, model }: HarnessChoice) {
  await db.update(jobs).set({ provider, model }).where(and(eq(jobs.key, key), eq(jobs.t3_thread_id, marker)));
}

export async function recordSandbox(key: string, marker: string, sandboxId: string) {
  const recorded = await db
    .update(jobs)
    .set({ sandbox_id: sandboxId })
    .where(and(eq(jobs.key, key), eq(jobs.t3_thread_id, marker)))
    .returning({ key: jobs.key });
  if (recorded.length === 0) throw new Error(`${key} no longer holds launch ${marker}`);
}

export async function machineInFlight(machineId: string) {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.machine_id, machineId), or(inArray(jobs.stage, IN_FLIGHT), stoppingSql)));
  return count;
}

export async function pendingLaunches() {
  const rows = await db
    .select()
    .from(jobs)
    .where(and(await mine(), sql`${jobs.t3_thread_id} like ${`${PENDING}%`}`));
  return rows.map((i) => ({
    key: i.key,
    repo: i.repo,
    marker: i.t3_thread_id!,
    branch: attemptBranch(i.key, i.attempt),
    stage: i.stage,
    execution: i.execution,
    sandbox_id: i.sandbox_id,
    codex_slot: i.codex_slot,
  }));
}


/**
 * Sends the stop message to every stopped job's thread that has not had it; claimed per thread.
 * T3 queues it behind a busy thread's turn, so it only asks: runner/stops.ts confirms the work
 * ended and interrupts what does not.
 */
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
    // A hibernated thread settled before its sandbox was snapshotted, and teardown discards it: nothing to stop.
    if (isHibernated(job)) {
      await stopDelivered(job.id, threadId);
      delivered.push(job.key);
      continue;
    }
    const host = hosts.forJob(job);
    try {
      if ((await threads.state(threadId, host)) !== "gone") {
        await threads.send(
          threadId,
          `Stop working on ${job.key}. ${job.stage === "failed" ? job.stage_summary : "The factory stopped this run."} Do not push, do not open or update a PR. End the turn now.`,
          host,
        );
      }
    } catch (error) {
      await db
        .update(jobs)
        .set({ stop_sent_to: job.stop_sent_to })
        .where(and(eq(jobs.id, job.id), eq(jobs.stop_sent_to, threadId)));
      throw error;
    }
    await stopDelivered(job.id, threadId);
    delivered.push(job.key);
  }
  return delivered;
}

/**
 * A missed stop webhook must not leave a run going. Each tick reads every claimed, unfinished
 * job from its source, one query per source, and records a stop through stopJob, the webhook's own
 * path, for any that lost the label, was closed, or is gone. A failed fetch decides nothing for
 * that source's jobs; the other sources still go.
 */
export async function reconcileStops({
  sources = allSources(),
  stop = stopJob,
  only,
}: {
  sources?: readonly SourceAdapter<JobSource>[];
  stop?: (id: JobId, detail: string) => Promise<string>;
  /** Restricts the check to these jobs; the regression script uses it to stay off live ones. */
  only?: JobId[];
} = {}) {
  const stopped: { key: string; reason: string; result: string }[] = [];
  const unknown: string[] = [];
  for (const source of sources) {
    // A job no machine holds yet has no thread, so any machine may record its stop.
    const unfinished = and(eq(jobs.source, source.source), inArray(jobs.stage, STOPPABLE), or(await mine(), isNull(jobs.machine_id)));
    const open = parseJobs(await db.select().from(jobs).where(only ? and(unfinished, inArray(jobs.id, only)) : unfinished));
    if (open.length === 0) continue;
    let wanted: Awaited<ReturnType<typeof source.stopWanted>>;
    try {
      wanted = await source.stopWanted(open);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      unknown.push(sources.length > 1 ? `${source.source}: ${message}` : message);
      continue;
    }
    for (const { job, reason } of wanted) {
      stopped.push({ key: job.key, reason, result: await stop(job.id, reason) });
    }
  }
  return unknown.length === 0 ? stopped : { unknown: unknown.join("; "), ...(stopped.length > 0 && { stopped }) };
}
