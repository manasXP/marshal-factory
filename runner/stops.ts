import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/client";
import { jobs, type JobRow } from "../db/schema";
import { isCloud } from "../lib/execution";
import { hosts } from "../lib/host";
import { parseJob, sourceFor } from "../lib/sources";
import type { JobId } from "../lib/sources/shapes";
import { parseStop, stopSchema, type StopRecord, type StopTimings } from "../lib/stop";
import { bindingOf, stoppingSql } from "./binding";
import { config } from "./config";
import { thisMachine } from "./heartbeat";
import { ACTIVE_RUN_STATUSES, threads, type InterruptOutcome, type SubagentThread, type ThreadActivity } from "./threads";

// Drives a recorded stop to a verified end; the states are in lib/stop.ts. Every step is a
// compare-and-set on the stop record, so a replayed tick, a restart or a second pass changes
// nothing twice. Only the job's own thread, its subagent threads and its sandbox are touched.
//
//   local thread    the stop message goes first (ops.deliverStops). Each tick then reads the
//                   thread and its subagent threads; after interruptAfter, whatever still runs is
//                   interrupted through T3; once nothing has run for settle, the stop is confirmed;
//                   still running, or unreadable, after giveUpAfter, it is unconfirmed
//   Modal sandbox   teardown ends the sandbox and checks Modal no longer answers for it, which
//                   confirms the stop (runner/lifecycle.ts)
//   no thread       nothing ran; confirmed at once

export const stopTimings = (): StopTimings => ({
  checkMs: config.factory.stop.checkSeconds * 1000,
  settleMs: config.factory.stop.settleSeconds * 1000,
  interruptAfterMs: config.factory.stop.interruptAfterSeconds * 1000,
  giveUpAfterMs: config.factory.stop.giveUpAfterMinutes * 60_000,
});

const ms = (iso: string) => new Date(iso).getTime();
const message = (error: unknown) => (error instanceof Error ? error.message.split("\n")[0]! : String(error)).slice(0, 300);

/** Writes `next` if the stored record is still `from`; false when another pass moved it first. */
async function advance(id: JobId, from: StopRecord, next: StopRecord) {
  const moved = await db
    .update(jobs)
    .set({ stop: stopSchema.parse(next) })
    .where(
      and(
        eq(jobs.id, id),
        sql`${jobs.stop}->>'state' = ${from.state}`,
        sql`${jobs.stop}->>'requestedAt' = ${from.requestedAt}`,
        sql`${jobs.stop}->>'checkedAt' is not distinct from ${from.checkedAt}`,
        sql`${jobs.stop}->>'thread' is not distinct from ${from.thread}`,
        sql`coalesce((${jobs.stop}->>'retries')::int, 0) = ${from.retries}`,
      ),
    )
    .returning({ key: jobs.key });
  return moved.length > 0;
}

/**
 * Ends the stop. The source is reopened first, so a failure there leaves the stop pending and the
 * next tick retries both; reopen is idempotent. After this the job's capacity is free and its
 * failure is written back.
 */
async function settle(row: JobRow, stop: StopRecord, state: "confirmed" | "unconfirmed", evidence: string, now: number) {
  if (stop.reopen) await sourceFor(row.source).reopen(parseJob(row));
  const iso = new Date(now).toISOString();
  return advance(row.id, stop, { ...stop, state, reopen: false, checkedAt: iso, settledAt: iso, evidence, step: evidence });
}

/** Records that the stop message reached `threadId`; a new binding starts the clock again. */
export async function stopDelivered(id: JobId, threadId: string, now = Date.now()) {
  const [row] = await db.select({ stop: jobs.stop }).from(jobs).where(eq(jobs.id, id));
  const stop = parseStop(row?.stop);
  if (!stop || (stop.state !== "requested" && stop.thread === threadId)) return false;
  if (stop.state === "confirmed" || stop.state === "unconfirmed") return false;
  const iso = new Date(now).toISOString();
  return advance(id, stop, {
    ...stop,
    state: "delivered",
    thread: threadId,
    how: "message",
    deliveredAt: iso,
    escalatedAt: null,
    quietSince: null,
    checkedAt: null,
    step: "Asked the agent to stop.",
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function stillRunning(parent: ThreadActivity, running: readonly SubagentThread[]) {
  if (parent.state === "running" && running.length > 0) return `the thread and ${plural(running.length, "subagent thread")} still run`;
  if (parent.state === "running") return "the thread still runs";
  return `${plural(running.length, "subagent thread")} still ${running.length === 1 ? "runs" : "run"}`;
}

function interruptStep(results: readonly { threadId: string; outcome: InterruptOutcome | { kind: "error"; reason: string } }[]) {
  const refused = results.find((r) => r.outcome.kind === "refused" || r.outcome.kind === "error");
  const asked = results.filter((r) => r.outcome.kind === "requested").length;
  if (refused && "reason" in refused.outcome) {
    const verb = refused.outcome.kind === "refused" ? "T3 refused to interrupt" : "Could not reach T3 to interrupt";
    return `${verb} ${refused.threadId}: ${refused.outcome.reason}`;
  }
  return asked > 0 ? `Asked T3 to interrupt ${plural(asked, "thread")}.` : "Nothing was left to interrupt.";
}

/** One look at a bound local thread, and the step it calls for. */
async function checkThread(row: JobRow, stop: StopRecord, threadId: string, timings: StopTimings, now: number) {
  const iso = new Date(now).toISOString();
  const deliveredAt = ms(stop.deliveredAt ?? stop.requestedAt);
  const elapsed = now - deliveredAt;
  const giveUp = elapsed >= timings.giveUpAfterMs;
  const host = hosts.forJob(row);
  let parent: ThreadActivity;
  let subagents: SubagentThread[];
  try {
    parent = await threads.activity(threadId, host);
    if (parent.state === "gone") return (await settle(row, stop, "confirmed", "T3 no longer has the thread, so nothing of it runs.", now)) && "confirmed";
    if (!parent.projectId) throw new Error("T3 did not say which project the thread is in, so its subagent threads can't be listed");
    subagents = await threads.subagents(threadId, parent.projectId, host);
  } catch (error) {
    const step = `Could not read the thread: ${message(error)}`;
    if (giveUp) return (await settle(row, stop, "unconfirmed", `${step}. Gave up after ${Math.round(elapsed / 60_000)} min.`, now)) && "unconfirmed";
    return (await advance(row.id, stop, { ...stop, checkedAt: iso, step })) && "unreadable";
  }

  const running = subagents.filter((s) => ACTIVE_RUN_STATUSES.includes(s.status));
  if (parent.state !== "running" && running.length === 0) {
    const quietSince = stop.quietSince ?? iso;
    if (now - ms(quietSince) >= timings.settleMs) {
      const tree = subagents.length > 0 ? `its ${plural(subagents.length, "subagent thread")} ${subagents.length === 1 ? "has" : "have"} settled` : "it has no subagent threads";
      const evidence = `T3 showed the thread with no active run for ${Math.round((now - ms(quietSince)) / 1000)} s, and ${tree}.`;
      return (await settle(row, stop, "confirmed", evidence, now)) && "confirmed";
    }
    return (await advance(row.id, stop, { ...stop, checkedAt: iso, quietSince, step: "No active run; checking that it stays that way." })) && "quiet";
  }

  const what = stillRunning(parent, running);
  if (giveUp) {
    const interrupt = stop.escalatedAt ? ` ${stop.step ?? ""}`.trimEnd() : "";
    const evidence = `${what[0]!.toUpperCase()}${what.slice(1)} ${Math.round(elapsed / 60_000)} min after the stop.${interrupt}`;
    return (await settle(row, stop, "unconfirmed", evidence, now)) && "unconfirmed";
  }
  if (stop.state !== "escalated" && elapsed < timings.interruptAfterMs) {
    return (await advance(row.id, stop, { ...stop, checkedAt: iso, quietSince: null, step: `Asked the agent to stop; ${what}.` })) && "waiting";
  }

  // The thread, then each subagent thread still running. A request id per run and retry makes T3
  // ignore a repeat within one round, while the owner's Retry stop is a new request it acts on.
  const targets = [
    ...(parent.state === "running" ? [{ threadId, runId: parent.activeRunId }] : []),
    ...running.map((s) => ({ threadId: s.threadId, runId: s.latestRunId })),
  ];
  const reason = `marshal-factory stopped ${row.key}: ${stop.reason}`;
  const results = [];
  for (const target of targets) {
    const requestId = `marshal-factory:stop:${row.id}:${stop.requestedAt}:retry-${stop.retries}:${target.threadId}:${target.runId ?? "latest"}`;
    const outcome = await threads.interrupt(target.threadId, requestId, reason, host).catch((error: unknown) => ({ kind: "error" as const, reason: message(error) }));
    results.push({ threadId: target.threadId, outcome });
  }
  const step = interruptStep(results);
  const moved = await advance(row.id, stop, { ...stop, state: "escalated", how: "interrupt", escalatedAt: stop.escalatedAt ?? iso, checkedAt: iso, quietSince: null, step });
  return moved && "interrupting";
}

/** One stop on its way: what this pass did with it, or undefined when it was not due. */
async function step(row: JobRow, me: string, timings: StopTimings, now: number) {
  const stop = parseStop(row.stop);
  if (!stop) return undefined;
  const binding = bindingOf(row.t3_thread_id);
  // A job no machine holds has no thread; any machine may settle it. Anything else is its machine's.
  if (row.machine_id !== me && !(row.machine_id === null && binding === "none")) return undefined;
  if (row.sandbox_id || row.sandbox_snapshot) return undefined; // teardown ends the sandbox and records it
  if (stop.how === "terminate") return (await settle(row, stop, "confirmed", stop.step ?? "Ended the job's sandbox.", now)) && "confirmed";
  if (binding === "none") return (await settle(row, stop, "confirmed", "No thread was started, so nothing ran.", now)) && "confirmed";
  if (binding === "pending") return undefined; // the launch binds it, and bindThread delivers the stop
  if (isCloud(row.execution)) return (await settle(row, stop, "confirmed", "The job's sandbox is gone, and its thread with it.", now)) && "confirmed";
  const threadId = row.t3_thread_id!;
  if (row.stop_sent_to !== threadId) return undefined; // still owed; deliverStops sends it
  if (stop.checkedAt && now - ms(stop.checkedAt) < timings.checkMs) return undefined;
  return checkThread(row, stop, threadId, timings, now);
}

/**
 * The tick's pass over every stop not yet confirmed or unconfirmed. Each job on its own, so one
 * T3 or source failure does not hold back the rest; a failure leaves its stop as it was.
 */
export async function confirmStops({ only, now = Date.now(), timings = stopTimings() }: { only?: JobId[]; now?: number; timings?: StopTimings } = {}) {
  const me = (await thisMachine()).id;
  const rows = await db
    .select()
    .from(jobs)
    .where(and(stoppingSql, or(eq(jobs.machine_id, me), isNull(jobs.machine_id)), only ? inArray(jobs.id, only) : undefined));
  const done: string[] = [];
  const errors: { key: string; error: string }[] = [];
  for (const row of rows) {
    try {
      const outcome = await step(row, me, timings, now);
      if (outcome) done.push(`${row.key}:${outcome}`);
    } catch (error) {
      errors.push({ key: row.key, error: message(error) });
    }
  }
  return errors.length > 0 ? { done, errors } : done;
}

export type RetryStopResult = { retried: string } | { refused: string };

/** The owner's Retry stop on an unconfirmed stop: interrupt again at once and give it a fresh timeout. */
export async function retryStop(id: JobId, now = Date.now()): Promise<RetryStopResult> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!row) return { refused: `No job ${id}.` };
  const stop = parseStop(row.stop);
  if (stop?.state !== "unconfirmed") return { refused: "The stop is not waiting on you." };
  const iso = new Date(now).toISOString();
  const retried = await advance(row.id, stop, {
    ...stop,
    state: "escalated",
    deliveredAt: iso,
    escalatedAt: iso,
    quietSince: null,
    checkedAt: null,
    settledAt: null,
    evidence: null,
    retries: stop.retries + 1,
    step: "The owner asked to retry the stop.",
  });
  if (!retried) return { refused: "The stop changed meanwhile; look again." };
  await confirmStops({ only: [row.id], now });
  return { retried: row.key };
}
