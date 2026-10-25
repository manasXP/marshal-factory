import "./test-guard";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

const { db } = await import("../db/client");
const { jobs } = await import("../db/schema");
const { bindThread, claimLaunch, deliverStops, pendingLaunches, reconcileStops, releaseLaunch, threads } = await import("../runner/ops");
const { jobId, sourceFor } = await import("../lib/sources");
const { linearJob } = await import("./fixtures");
const { createLinearAdapter } = await import("../lib/sources/linear");
const { factorySchema, TEST_MACHINE_ID } = await import("../lib/config");
const { canReclaim, canReclaimSql, stopDeliverable, stopDeliverableSql } = await import("../runner/binding");
const { and, sql } = await import("drizzle-orm");
const { launchEntries, maybeStarted, MaybeStartedError, parseThreadId } = await import("../runner/launch");
const { runWithInput } = await import("../lib/exec");
const { everyAtMost, serialQueue } = await import("../runner/queue");
const { recheckScheduler } = await import("../runner/recheck");

const slot = { id: TEST_MACHINE_ID, repos: ["ski043/factory-demo"], maxInFlight: 2 };
const sent: { threadId: string; message: string }[] = [];
threads.state = async () => "running";
threads.send = async (threadId, message) => void sent.push({ threadId, message });

await assert.rejects(sourceFor("linear").ready(), /Linear API was called during a regression run/, "the real Linear client refuses to run in a regression");

const id = `launch-regress-${Date.now()}`;
const jid = jobId("linear", id);
await db.insert(jobs).values(linearJob(id, id));
try {
  assert.equal(await claimLaunch(id, "pending:1", slot), true, "the first launch claims the job");
  assert.equal(await claimLaunch(id, "pending:2", slot), false, "a second launch, after a crash or timeout, does not");
  assert.deepEqual((await pendingLaunches()).find((p) => p.key === id), { key: id, repo: "ski043/factory-demo", marker: "pending:1", branch: `factory/${id}`, stage: "queued" });
  await releaseLaunch(id, "pending:2");
  assert.equal((await db.select().from(jobs).where(eq(jobs.key, id)))[0]!.t3_thread_id, "pending:1", "only the holder's marker is released");
  await releaseLaunch(id, "pending:1");
  assert.equal(await claimLaunch(id, "pending:3", slot), true, "a released job can launch again");
  // The binding × stop state space (runner/binding.ts). Each cell checks the predicate, its SQL
  // twin, what deliverStops does, and whether a retry claim may start a new attempt.
  const stop = { stage: "failed" as const, stage_event_id: `stop:${id}:1:x`, stop_event_id: `stop:${id}:1:x`, stage_summary: "Stopped: test." };
  const watchdogFail = { stage: "failed" as const, stage_event_id: `watchdog:${id}:1:x`, stop_event_id: null, stage_summary: "Watchdog." };
  const mergedAfterStop = { stage: "merged" as const, stage_event_id: `merged:${id}:x`, stop_event_id: `stop:${id}:1:x`, stage_summary: "Merged." };
  const cells = [
    { name: "none, not stopped", row: { ...watchdogFail, t3_thread_id: null, stop_sent_to: null }, delivers: false, reclaim: true },
    { name: "none, stopped", row: { ...stop, t3_thread_id: null, stop_sent_to: null }, delivers: false, reclaim: true },
    { name: "pending, not stopped", row: { ...watchdogFail, t3_thread_id: "pending:5", stop_sent_to: null }, delivers: false, reclaim: false },
    { name: "pending, stopped (owed)", row: { ...stop, t3_thread_id: "pending:5", stop_sent_to: null }, delivers: false, reclaim: false },
    { name: "bound, not stopped", row: { ...watchdogFail, t3_thread_id: "mcp:regress-a", stop_sent_to: null }, delivers: false, reclaim: true },
    { name: "bound, stopped, not sent", row: { ...stop, t3_thread_id: "mcp:regress-a", stop_sent_to: null }, delivers: true, reclaim: false },
    { name: "bound, stopped, sent", row: { ...stop, t3_thread_id: "mcp:regress-a", stop_sent_to: "mcp:regress-a" }, delivers: false, reclaim: true },
    { name: "bound, stopped, sent to an older thread", row: { ...stop, t3_thread_id: "mcp:regress-b", stop_sent_to: "mcp:regress-a" }, delivers: true, reclaim: false },
    { name: "bound, still working", row: { stage: "implementing" as const, stage_event_id: "e", stop_event_id: null, stage_summary: "s", t3_thread_id: "mcp:regress-a", stop_sent_to: null }, delivers: false, reclaim: false },
    { name: "bound, stopped, merged before the stop was sent", row: { ...mergedAfterStop, t3_thread_id: "mcp:regress-a", stop_sent_to: null }, delivers: true, reclaim: false },
    { name: "pending, stopped, merged before the thread was known", row: { ...mergedAfterStop, t3_thread_id: "pending:6", stop_sent_to: null }, delivers: false, reclaim: false },
    { name: "bound, stopped, merged, sent", row: { ...mergedAfterStop, t3_thread_id: "mcp:regress-a", stop_sent_to: "mcp:regress-a" }, delivers: false, reclaim: false },
  ];
  const sqlSays = async (condition: ReturnType<typeof sql> | undefined) =>
    (await db.select({ key: jobs.key }).from(jobs).where(and(eq(jobs.id, jid), condition))).length > 0;
  for (const cell of cells) {
    await db.update(jobs).set(cell.row).where(eq(jobs.id, jid));
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jid));
    assert.equal(stopDeliverable(row!), cell.delivers, `${cell.name}: stop deliverable`);
    assert.equal(await sqlSays(stopDeliverableSql), cell.delivers, `${cell.name}: SQL agrees on deliverable`);
    assert.equal(canReclaim(row!), cell.reclaim, `${cell.name}: retry claim allowed`);
    assert.equal(await sqlSays(sql`coalesce(${canReclaimSql}, false)`), cell.reclaim, `${cell.name}: SQL agrees on retry claim`);
    sent.length = 0;
    assert.deepEqual(await deliverStops(jid), cell.delivers ? [id] : [], `${cell.name}: deliverStops`);
    assert.deepEqual(await deliverStops(jid), [], `${cell.name}: a second deliverStops sends nothing`);
    assert.deepEqual(
      sent.map((m) => m.threadId),
      cell.delivers ? [cell.row.t3_thread_id] : [],
      `${cell.name}: the stop message reaches the bound thread once`,
    );
  }

  // The guard as the retry claim uses it, inside ON CONFLICT DO UPDATE.
  const retryClaim = () =>
    db
      .insert(jobs)
      .values(linearJob(id, id))
      .onConflictDoUpdate({ target: jobs.id, set: { attempt: sql`${jobs.attempt} + 1` }, setWhere: canReclaimSql })
      .returning({ attempt: jobs.attempt });
  await db.update(jobs).set({ ...stop, t3_thread_id: "pending:8", stop_sent_to: null }).where(eq(jobs.id, jid));
  assert.deepEqual(await retryClaim(), [], "a retry claim is refused while a stopped launch is pending");
  await db.update(jobs).set({ ...stop, t3_thread_id: "mcp:regress-a", stop_sent_to: "mcp:regress-a" }).where(eq(jobs.id, jid));
  assert.equal((await retryClaim()).length, 1, "and allowed once the stop reached the thread");

  // Transitions out of "pending, stopped": the thread appears, or recovery finds none.
  await db.update(jobs).set({ ...stop, t3_thread_id: "pending:6", stop_sent_to: null }).where(eq(jobs.id, jid));
  sent.length = 0;
  assert.deepEqual(await bindThread(id, "mcp:regress-late"), { bound: id, threadId: "mcp:regress-late", stopped: true }, "binding delivers the owed stop at once");
  assert.deepEqual(sent.map((m) => m.threadId), ["mcp:regress-late"], "to the thread it just bound");
  assert.equal(canReclaim((await db.select().from(jobs).where(eq(jobs.id, jid)))[0]!), true, "and then a retry may claim");
  await db.update(jobs).set({ ...stop, t3_thread_id: "pending:9", stop_sent_to: null }).where(eq(jobs.id, jid));
  await db.update(jobs).set({ stage: "merged", stage_event_id: `merged:${id}:late`, stage_summary: "Merged." }).where(eq(jobs.id, jid));
  sent.length = 0;
  assert.equal((await bindThread(id, "mcp:regress-merged")).stopped, true, "a PR that merged before the stop reached its thread still gets the stop");
  assert.deepEqual(sent.map((m) => m.threadId), ["mcp:regress-merged"]);
  assert.match(sent[0]!.message, /^Stop working on .+\. The factory stopped this run\./, "and the message does not quote the merge as the reason");
  await db.update(jobs).set({ ...stop, t3_thread_id: "pending:7", stop_sent_to: null }).where(eq(jobs.id, jid));
  await releaseLaunch(id, "pending:7");
  const [cleared] = await db.select().from(jobs).where(eq(jobs.id, jid));
  assert.equal(stopDeliverable(cleared!), false, "recovery that finds no thread leaves nothing to deliver");
  assert.equal(canReclaim(cleared!), true, "and a retry may claim");
  assert.deepEqual(await deliverStops(jid), []);

  // Missed stop webhooks: each tick asks Linear about claimed jobs and stops the ones it took away.
  const node = (over: Record<string, unknown> = {}) => ({
    id,
    archivedAt: null,
    trashed: null,
    state: { type: "started", name: "In Progress" },
    labels: { nodes: [{ name: "factory" }] },
    ...over,
  });
  const sourceReading = (issuesByIds: () => Promise<unknown[]>) =>
    createLinearAdapter(() => ({ client: { issuesByIds } as never, db, limits: factorySchema.parse({}) }));
  const stops: string[] = [];
  const recordStop = async (stopped: string, detail: string) => {
    // Never touch a live job, whatever the scoping above does.
    assert.equal(stopped, jid, "the regression only stops its own job");
    stops.push(detail);
    await db.update(jobs).set({ stage: "failed", stage_event_id: `stop:${id}:x` }).where(eq(jobs.id, jid));
    return "stopped";
  };
  const working = () => db.update(jobs).set({ stage: "implementing", stage_event_id: "e" }).where(eq(jobs.id, jid));
  const cases = [
    { name: "still labeled and open", fetch: async () => [node()], stop: undefined },
    { name: "label removed", fetch: async () => [node({ labels: { nodes: [{ name: "bug" }] } })], stop: "the factory label was removed in Linear" },
    { name: "canceled", fetch: async () => [node({ state: { type: "canceled", name: "Canceled" } })], stop: "issue moved to Canceled in Linear" },
    { name: "archived", fetch: async () => [node({ archivedAt: "2026-10-24T00:00:00Z" })], stop: "the issue was archived or deleted in Linear" },
    { name: "deleted (not returned)", fetch: async () => [], stop: "the issue was deleted in Linear" },
  ];
  for (const c of cases) {
    await working();
    stops.length = 0;
    const result = await reconcileStops({ source: sourceReading(c.fetch), stop: recordStop, only: [jid] });
    assert.deepEqual(stops, c.stop ? [c.stop] : [], `${c.name}: ${JSON.stringify(result)}`);
    if (c.stop) {
      await reconcileStops({ source: sourceReading(c.fetch), stop: recordStop, only: [jid] });
      assert.equal(stops.length, 1, `${c.name}: a repeat tick records no second stop`);
    }
  }
  await working();
  stops.length = 0;
  const linearDown = await reconcileStops({
    source: sourceReading(async () => {
      throw new Error("Linear is down");
    }),
    stop: recordStop,
    only: [jid],
  });
  assert.deepEqual(linearDown, { unknown: "Linear is down" });
  assert.deepEqual(stops, [], "a failed Linear fetch stops nothing");

  // One failed start does not stop the batch; a clear failure frees its marker, a timeout keeps it.
  const markers = new Map<string, string>();
  const released: string[] = [];
  const entry = (key: string) => ({ key, source: "linear" as const, repo: "ski043/factory-demo", branch: `factory/${key}`, threadTitle: key, message: "m" });
  const results = await launchEntries([entry("A"), entry("B"), entry("C")], {
    claim: async (key, marker) => (markers.set(key, marker), true),
    start: async ({ key }) => {
      if (key === "A") throw new Error("t3: project not found");
      if (key === "B") throw Object.assign(new Error("timed out"), { killed: true });
      return `thread-${key}`;
    },
    bind: async () => undefined,
    release: async (key) => void released.push(key),
    now: () => 1,
  });
  assert.deepEqual(results.map((r) => [r.key, r.threadId ?? r.retry]), [
    ["A", "next pass"],
    ["B", "after launch recovery"],
    ["C", "thread-C"],
  ], "every entry is tried");
  assert.deepEqual(released, ["A"], "only the clearly failed start releases its marker");

  // A recheck answers at once and runs the check on later queued steps, once GitHub settles.
  const timers: (() => void)[] = [];
  const queue: (() => Promise<unknown>)[] = [];
  let clock = 0;
  let unknown = 2;
  let checks = 0;
  const scheduler = recheckScheduler(
    {
      settled: async () => unknown-- <= 0,
      check: async () => ++checks,
      enqueue: (_name, step) => void queue.push(step),
      schedule: (run) => void timers.push(run),
      now: () => clock,
    },
    { waitMs: 100, pollMs: 10 },
  );
  assert.equal(scheduler.request(), "scheduled", "the intent returns without waiting");
  assert.equal(scheduler.request(), "already scheduled", "a second push joins the pending recheck");
  const drain = async () => {
    while (timers.length || queue.length) {
      timers.splice(0).forEach((run) => run());
      for (const step of queue.splice(0)) await step();
      clock += 10;
    }
  };
  await drain();
  assert.equal(checks, 1, "the check runs once, after GitHub settled");
  unknown = 1_000;
  scheduler.request();
  await drain();
  assert.equal(checks, 2, "a recheck that never settles still checks at its deadline");

  // A throwing GitHub round is retried and falls through to the check at the deadline; a throwing
  // check still frees the scheduler for the next request.
  let throwingChecks = 0;
  let failFinal = true;
  const flaky = recheckScheduler(
    {
      settled: async () => {
        throw new Error("the GitHub read failed");
      },
      check: async () => {
        throwingChecks++;
        if (failFinal) throw new Error("check failed");
        return "checked";
      },
      enqueue: (_name, step) => void queue.push(async () => step().catch(() => "step failed")),
      schedule: (run) => void timers.push(run),
      now: () => clock,
    },
    { waitMs: 50, pollMs: 10 },
  );
  flaky.request();
  await drain();
  assert.equal(throwingChecks, 1, "a settled() that keeps throwing still reaches the check at the deadline");
  failFinal = false;
  assert.equal(flaky.request(), "scheduled", "a check that threw leaves the scheduler free for the next request");
  await drain();
  assert.equal(throwingChecks, 2, "and that next recheck runs");

  // Child processes always settle, and output is parsed after awaiting it.
  assert.equal(await runWithInput("cat", [], "hello", 5_000), "hello", "stdin reaches the command");
  await assert.rejects(runWithInput("/nonexistent/t3", [], "x", 5_000), "a missing binary rejects");
  await assert.rejects(runWithInput("sh", ["-c", "exit 3"], "x", 5_000), "a failed exit rejects");
  await assert.rejects(
    runWithInput("sleep", ["5"], "x", 200).catch((error: { killed?: boolean }) => {
      assert.equal(error.killed, true, "a timeout is marked killed");
      throw error;
    }),
  );
  // A broken stdin pipe settles nothing by itself; the exit decides, and the failure says it happened.
  const big = "x".repeat(4 * 1024 * 1024);
  assert.equal(await runWithInput("sh", ["-c", "echo ok"], big, 5_000), "ok\n", "an exit 0 after EPIPE still succeeds with its output");
  const brokenPipe = await runWithInput("sh", ["-c", "exit 3"], big, 5_000).catch((error: unknown) => error);
  assert.ok((brokenPipe as { stdinError?: Error }).stdinError, "a failure after EPIPE carries the stdin error");
  assert.equal(maybeStarted(brokenPipe), true, "and counts as maybe started, so the marker is kept");
  const cleanFail = await runWithInput("sh", ["-c", "cat >/dev/null; exit 3"], big, 5_000).catch((error: unknown) => error);
  assert.equal(maybeStarted(cleanFail), false, "a non-zero exit that read all its input is a clear failure");
  const missing = await runWithInput("/nonexistent/t3", [], "x", 5_000).catch((error: unknown) => error);
  assert.equal(maybeStarted(missing), false, "a binary that never ran is a clear failure");
  const timedOut = await runWithInput("sleep", ["5"], "x", 200).catch((error: unknown) => error);
  assert.equal(maybeStarted(timedOut), true, "a timeout is maybe started");
  assert.equal(parseThreadId('{"threadId":"mcp:1"}'), "mcp:1");
  assert.throws(() => parseThreadId("not json"), MaybeStartedError, "unparsable output rejects as maybe-started");
  const unparsed = await launchEntries([entry("D")], {
    claim: async () => true,
    start: async () => parseThreadId("garbage"),
    bind: async () => undefined,
    release: async (key) => void released.push(key),
    now: () => 1,
  });
  assert.equal(unparsed[0]!.retry, "after launch recovery", "unparsable start output keeps the marker for recovery");
  assert.ok(!released.includes("D"));

  // No step can stall the queue: a hung step times out, a throwing one is caught, the next runs.
  const events: string[] = [];
  const q = serialQueue((event) => void events.push(event), 50);
  void q.serial("hang", () => new Promise(() => {}));
  void q.serial("throw", async () => {
    throw new Error("boom");
  });
  const after = await q.serial("after", async () => "ran");
  assert.equal(after, "ran", "the step after a hung and a throwing one still runs");
  assert.deepEqual(events, ["hang:error", "throw:error", "after"]);

  // A step that rejects after its timeout is logged, not left as an unhandled rejection.
  let unhandled = 0;
  const count = () => void unhandled++;
  process.on("unhandledRejection", count);
  const lateEvents: string[] = [];
  const late = serialQueue((event) => void lateEvents.push(event), 20);
  await late.serial("late", () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 60)));
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.off("unhandledRejection", count);
  assert.deepEqual(lateEvents, ["late:error", "late:late-error"]);
  assert.equal(unhandled, 0, "no unhandled rejection");

  // The hourly cleanup advances its clock only on success and never overlaps itself.
  let t = 0;
  let runs = 0;
  let fail = true;
  let release: () => void = () => {};
  const hourly = everyAtMost(100, async () => {
    runs++;
    if (fail) throw new Error("cleanup failed");
    await new Promise<void>((resolve) => (release = resolve));
    return "cleaned";
  }, () => t);
  assert.equal(await hourly(), undefined, "not due before the interval");
  t = 100;
  assert.deepEqual(await hourly(), { error: "cleanup failed" });
  assert.equal(runs, 1);
  fail = false;
  const slow = hourly();
  assert.equal(await hourly(), undefined, "a failed run is retried, but never while one is still going");
  release();
  assert.equal(await slow, "cleaned");
  assert.equal(runs, 2, "the failed hour was retried at the next chance");
  t = 150;
  assert.equal(await hourly(), undefined, "after a success the clock waits a full interval again");

  console.log("launch regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(jobs).where(eq(jobs.id, jid));
  process.exit(process.exitCode ?? 0);
}
