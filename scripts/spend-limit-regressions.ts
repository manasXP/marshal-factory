import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";

const { db } = await import("../db/client");
const { events, jobs, runs } = await import("../db/schema");
const { jobId, SOURCES } = await import("../lib/sources");
const { eventSchema } = await import("../lib/events");
const { ingest } = await import("../lib/ingest");
const { attemptBranch } = await import("../lib/factory");
const { branchSpend } = await import("../lib/spend");
const { decideStage, runnerEventId } = await import("../lib/stages");
const { answeredAmount, isSpendPause, pauseQuestion, raisedLimit, spendResumeMessage } = await import("../lib/spend-limit");
const { settingsInputSchema } = await import("../lib/settings");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { linearJob, usageRun } = await import("./fixtures");
const ops = await import("../runner/ops");
const { threads } = await import("../runner/threads");

// --- What an answer asks for -------------------------------------------------------------------

assert.equal(answeredAmount("$25"), 25);
assert.equal(answeredAmount("Sure, raise it to $ 17.50 please"), 17.5);
assert.equal(answeredAmount("go to 30 USD"), 30);
assert.equal(answeredAmount("40 dollars"), 40);
assert.equal(answeredAmount(" 12 "), 12, "a bare number as the whole answer");
assert.equal(answeredAmount("continue, but fix item 3 first"), null, "a number in prose is not an amount");
assert.equal(answeredAmount("continue"), null);
assert.equal(raisedLimit("$25", 10.4, 10, 10), 25, "an amount above the spend is the new limit");
assert.equal(raisedLimit("continue", 10.4, 10, 10), 20.4, "no amount adds the increment to what was spent");
assert.equal(raisedLimit("$8", 10.4, 10, 10), 20.4, "an amount below the spend would pause at once, so it adds the increment");
assert.equal(raisedLimit("continue", 3, 10, 10), 20, "the old limit counts when it is above the spend");
assert.match(pauseQuestion(10.42, 10, 10), /spent \$10\.42, reaching its \$10\.00 spend limit.*"\$20".*raises the limit by \$10\.00.*remove the factory label/);
assert.match(spendResumeMessage("Linear issue FAC-1", 10.42, 25, "playbook.md"), /raised the limit to \$25\.00[\s\S]*Continue exactly where you stopped[\s\S]*Do not start over from Triage/);

assert.equal(settingsInputSchema.parse({ provider: "p", model: "m" }).spendLimitUsd, 10, "Settings default to $10");
assert.equal(settingsInputSchema.parse({ provider: "p", model: "m", spendLimitUsd: "25" }).spendLimitUsd, 25, "the form's text is a number");
assert.equal(settingsInputSchema.safeParse({ provider: "p", model: "m", spendLimitUsd: 0 }).success, false, "a limit must be above $0");

// --- Which stage moves a pause allows ----------------------------------------------------------

// Relative to now: ingest skips a move older than the job's current stage as stale.
const at = new Date(Date.now() - 3_600_000);
const later = new Date(Date.now() - 1_800_000);
const working = { key: "FAC-1", stage: "implementing" as const, stage_at: at, attempt: 1, stage_event_id: "report-1" };
const pauseId = runnerEventId("budget", "x", 1, "report-1");
assert.deepEqual(decideStage(working, { stage: "waiting", at: later, eventId: pauseId }), { outcome: "apply", cause: "budget" }, "the runner may pause working jobs");
const paused = { ...working, stage: "waiting" as const, stage_event_id: pauseId };
assert.equal(isSpendPause(paused), true);
assert.equal(isSpendPause({ stage: "waiting", stage_event_id: "report-2" }), false, "the agent's own question is not a spend pause");
assert.equal(decideStage(paused, { stage: "implementing", at: later, eventId: "report-2" }).outcome, "refuse", "the interrupted thread cannot report its way out");
assert.equal(decideStage(paused, { stage: "failed", at: later, eventId: "report-3" }).outcome, "refuse", "nor fail the job on its way out");
assert.deepEqual(decideStage(paused, { stage: "queued", at: later, eventId: runnerEventId("resume", "x", "r1") }), { outcome: "apply", cause: "resume" }, "an answer resumes it");
assert.equal(decideStage({ ...paused, stage_event_id: "report-1" }, { stage: "implementing", at: later, eventId: "report-2" }).outcome, "apply", "a waiting job that asked a question still takes reports");

// --- The runner pauses, interrupts, and resumes under a raised limit ---------------------------

ops.ingestClient.post = async (event) => ingest(db, [eventSchema.parse(event)]);
const interrupts: string[] = [];
const sent: string[] = [];
threads.activity = async () => ({ state: "running", activeRunId: "run-1", projectId: "proj" });
threads.subagents = async () => [
  { threadId: "sub-running", status: "running", latestRunId: "run-s1" },
  { threadId: "sub-done", status: "completed", latestRunId: "run-s2" },
] as never;
threads.interrupt = async (threadId, requestId) => {
  interrupts.push(`${threadId}|${requestId}`);
  return { kind: "requested" };
};
threads.state = async () => "running";
threads.send = async (_threadId, message) => {
  sent.push(message);
};

const stamp = Date.now();
const overKey = `SPL-${stamp % 100000}1`;
const underKey = `SPL-${stamp % 100000}2`;
const overExt = `spend-over-${stamp}`;
const underExt = `spend-under-${stamp}`;
await db.insert(jobs).values([
  linearJob(overExt, overKey, { stage: "implementing", stage_at: at, stage_event_id: "report-1", machine_id: TEST_MACHINE_ID, t3_thread_id: "thread-over", budget_usd: 0.01 }),
  linearJob(underExt, underKey, { stage: "implementing", stage_at: at, stage_event_id: "report-1", machine_id: TEST_MACHINE_ID, t3_thread_id: "thread-under", budget_usd: 1000 }),
]);
await db.insert(runs).values([{ ...usageRun(overKey), job_key: overKey }, { ...usageRun(underKey), job_key: underKey }]);
const row = async (ext: string) => (await db.select().from(jobs).where(eq(jobs.id, jobId("linear", ext))))[0]!;
const spent = (await branchSpend(db, [attemptBranch(overKey, 1)]))[attemptBranch(overKey, 1)]!;
assert.ok(spent > 0.01, "the fixture spends more than the tiny limit");

const first = await ops.enforceSpendLimits();
assert.deepEqual(first, [`${overKey}:interrupted 2`], "only the job over its limit pauses; its thread and running subagent are interrupted");
const pausedRow = await row(overExt);
assert.equal(pausedRow.stage, "waiting");
assert.ok(isSpendPause(pausedRow));
assert.match(pausedRow.question ?? "", /reaching its \$0\.01 spend limit/);
assert.equal((await row(underExt)).stage, "implementing", "a job under its limit keeps working");
assert.deepEqual(interrupts.map((i) => i.split("|")[0]), ["thread-over", "sub-running"]);

await ops.enforceSpendLimits();
assert.equal((await row(overExt)).stage_event_id, pausedRow.stage_event_id, "a paused job is not paused twice");
assert.equal(interrupts.length, 4, "but a thread that still runs is asked again");
assert.equal(interrupts[2], interrupts[0], "with the same request id, which T3 treats as a repeat");

const late = { eventId: `late-${stamp}`, sessionId: `s-${stamp}`, at: Date.now(), kind: "stage", stage: "implementing", summary: "Still going.", jobKey: overKey, branch: attemptBranch(overKey, 1) };
await ingest(db, [eventSchema.parse(late)]);
assert.equal((await row(overExt)).stage, "waiting", "a late report from the interrupted thread is refused");
assert.match((await db.select().from(events).where(eq(events.event_id, late.eventId)))[0]!.refusal ?? "", /spend limit/);

const realLinear = SOURCES.linear;
const acknowledged: string[][] = [];
SOURCES.linear = {
  ...realLinear,
  replies: async (job) =>
    job.external_id === overExt
      ? { kind: "resume", question: job.question ?? "", replies: [{ id: `r-${stamp}`, body: "$25", createdAt: later.toISOString() }], answer: "$25" }
      : { kind: "wait" },
  acknowledgeReplies: async (_job, ids) => {
    acknowledged.push([...ids]);
  },
};
try {
  assert.deepEqual(await ops.resumeAnswered(), [`${overKey}:sent`]);
} finally {
  SOURCES.linear = realLinear;
}
const resumed = await row(overExt);
assert.equal(resumed.budget_usd, 25, "the answer's amount is the new limit");
assert.equal(resumed.stage, "queued", "and the job is working again");
assert.match(sent.at(-1)!, /raised the limit to \$25\.00[\s\S]*Continue exactly where you stopped/, "the thread carries on rather than starting over");
assert.deepEqual(acknowledged, [[`r-${stamp}`]]);
assert.deepEqual(await ops.enforceSpendLimits(), [], "under the raised limit it keeps working");

await db.delete(runs).where(inArray(runs.job_key, [overKey, underKey]));
await db.delete(jobs).where(inArray(jobs.key, [overKey, underKey]));

console.log("spend limit regressions passed");
