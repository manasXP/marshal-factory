import "./test-guard";
import assert from "node:assert/strict";
import { and, eq, inArray, like } from "drizzle-orm";
import { z } from "zod";

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;

const { db } = await import("../db/client");
const { auditLog, backlog, intents, jobs, queueControls, queueState } = await import("../db/schema");
const { registerSource } = await import("../lib/sources");
const { jobId } = await import("../lib/sources/shapes");
const { jobKey } = await import("../lib/factory");
const { NO_OVERRIDES } = await import("../lib/ticket-overrides");
const { changeQueue, inQueueOrder, launchable, readQueue, setPaused, QUEUE_STATE_ID } = await import("../lib/queue");
const { linearDequeuer } = await import("../lib/sources/linear");
const { createGithubAdapter } = await import("../lib/sources/github");
const ops = await import("../runner/ops");

// The pause, the backlog and the owner's queue controls, through the claim pass and the panel's actions.

const control = (job_id: string, front?: number, held?: boolean) => ({
  job_id: job_id as never,
  front_at: front === undefined ? null : new Date(front),
  held_at: held ? new Date(0) : null,
  updated_at: new Date(0),
  updated_by: OWNER,
});

{
  const order = inQueueOrder(["a", "b", "c", "d"], (x) => x, [control("c", 1), control("d", 2), control("a", undefined, true)]);
  assert.deepEqual(order, ["d", "c", "a", "b"], "moved to the front first, the latest move leading, then each in its own order");
  const entries = [
    { job: { id: "a", stage: "queued" } },
    { job: { id: "b", stage: "queued" } },
    { job: { id: "w", stage: "waiting" } },
  ];
  assert.deepEqual(launchable(entries, false, [control("a", undefined, true)]).map((e) => e.job.id), ["b", "w"], "a held queued job does not launch");
  assert.deepEqual(launchable(entries, true, []).map((e) => e.job.id), ["w"], "while paused only an answered job relaunches");
  assert.deepEqual(launchable(entries, false, [control("b", 5)]).map((e) => e.job.id), ["b", "a", "w"], "in queue order");
}

{
  // The panel takes work out of the queue by removing the factory label, as a person would.
  const sent: { query: string; variables: Record<string, unknown> }[] = [];
  const fetchFake = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    sent.push(body);
    if (body.query.includes("labels {")) return Response.json({ data: { issue: { labels: { nodes: [{ id: "l-f", name: "Factory" }, { id: "l-b", name: "bug" }] } } } });
    return Response.json({ data: { issueUpdate: { success: true } } });
  }) as unknown as typeof fetch;
  await linearDequeuer("key", "factory", { fetch: fetchFake, sleep: async () => {} })("issue-1");
  assert.deepEqual(sent.at(-1)!.variables, { id: "issue-1", input: { removedLabelIds: ["l-f"] } }, "Linear loses only the factory label");

  const removed: unknown[] = [];
  const adapter = createGithubAdapter(() => ({
    client: { removeLabel: async (...args: unknown[]) => void removed.push(args) } as never,
    db: null as never,
    label: "factory",
    appLogin: () => "",
    repos: async () => [],
  }));
  await adapter.dequeue!("acme/web#7");
  assert.deepEqual(removed, [["acme/web", 7, "factory"]], "GitHub loses the factory label");
}

const SOURCE = "queue-source";
const REPO = `test-owner/queue-${Date.now()}`;
const stamp = Date.now() % 100_000;
const draft = (n: number) => ({
  externalId: `q-${stamp}-${n}`,
  key: jobKey("QS", stamp * 10 + n),
  title: `Queued item ${n}`,
  url: `https://fake.example/q/${n}`,
  description: null,
  writeback: { kind: SOURCE },
  sourceState: {},
});
const items = [1, 2, 3, 4].map(draft);
const idOf = (n: number) => jobId(SOURCE as never, items[n - 1]!.externalId);
let ready: ReturnType<typeof draft>[] = items.slice(0, 3);
let down = false;
registerSource(
  { label: "Queue board", writeback: z.object({ kind: z.literal(SOURCE) }), sourceState: z.object({}) },
  {
    source: SOURCE,
    ready: async () => {
      if (down) throw new Error("the board is down");
      return ready as never;
    },
    announceClaim: async () => undefined,
    writeBack: async () => false,
    replies: async () => ({ kind: "wait" }),
    acknowledgeReplies: async () => undefined,
    stopWanted: async () => [],
    confirmStop: async () => ({ stop: false }),
    note: async () => undefined,
    overrides: () => NO_OVERRIDES,
    labels: async () => [],
    reopen: async () => undefined,
    requeue: async () => undefined,
    describe: (job) => `queue item ${job.key}`,
  },
);
const { sourceFor } = await import("../lib/sources");
const claim = () => ops.claim({ sources: [sourceFor(SOURCE as never)], repos: async () => [REPO], registry: async () => [] });
const dequeued: string[] = [];
let dequeueFails = false;
const owner = { email: OWNER, emailVerified: true };
const deps = {
  db,
  user: async () => owner,
  dequeue: async (source: string, externalId: string) => {
    if (dequeueFails) throw new Error("Linear is down");
    dequeued.push(`${source}:${externalId}`);
  },
};
const queueKeys = async () => (await readQueue(db)).items.filter((i) => i.source === (SOURCE as never)).map((i) => [i.key, i.claimed, i.front, i.held]);
const k = (n: number) => items[n - 1]!.key;
const maxInFlight = ops.config.factory.maxInFlight;

try {
  const stranger = await setPaused({ ...deps, user: async () => ({ email: "someone@example.com", emailVerified: true }) }, true);
  assert.equal(stranger.ok, false, "only the owner pauses");
  assert.equal((await changeQueue({ ...deps, user: async () => null }, idOf(1), "front")).ok, false, "only the owner changes the queue");

  assert.deepEqual(await setPaused(deps, true), { ok: true });
  const [{ paused_at: first }] = await db.select().from(queueState).where(eq(queueState.id, QUEUE_STATE_ID));
  await setPaused(deps, true);
  const [{ paused_at: again }] = await db.select().from(queueState).where(eq(queueState.id, QUEUE_STATE_ID));
  assert.deepEqual(again, first, "pausing again keeps the first pause's time");

  const paused = await claim();
  assert.deepEqual([paused.claimed, "paused" in paused && paused.paused], [[], true], "a paused claim pass claims nothing");
  assert.deepEqual(
    await queueKeys(),
    [1, 2, 3].map((n) => [k(n), false, false, false]),
    "and records what the source offers as the backlog, in the source's order",
  );
  assert.equal((await readQueue(db)).pause?.by, OWNER, "the queue says who paused");

  const gone = await changeQueue(deps, `${SOURCE}:nope`, "front");
  assert.match(gone.ok ? "" : gone.message, /no longer queued/, "work that is not queued can't be changed");
  assert.deepEqual(await changeQueue(deps, idOf(3), "front"), { ok: true });
  assert.deepEqual(await changeQueue(deps, idOf(1), "hold"), { ok: true });
  assert.deepEqual(
    await queueKeys(),
    [
      [k(3), false, true, false],
      [k(1), false, false, true],
      [k(2), false, false, false],
    ],
    "the front item leads and the held one keeps its place",
  );
  const audit = await db.select().from(auditLog).where(inArray(auditLog.job_id, [idOf(1), idOf(3)]));
  assert.deepEqual(audit.map((a) => [a.action, a.actor, a.detail]).sort(), [
    ["queue_changed", OWNER, "Held in the queue."],
    ["queue_changed", OWNER, "Moved to the front of the queue."],
  ]);

  const openClaims = async () => (await db.select().from(intents).where(and(like(intents.id, "panel:claim:%"), eq(intents.kind, "claim")))).length;
  const before = await openClaims();
  assert.deepEqual(await setPaused(deps, false), { ok: true });
  assert.equal((await readQueue(db)).pause, null, "resumed");
  assert.equal(await openClaims(), before + 1, "a resume asks the runners for a claim pass at once");

  ops.config.factory.maxInFlight = 2;
  const first2 = await claim();
  assert.deepEqual(first2.claimed, [k(3), k(2)], "the front item is claimed first, and the held one not at all");
  assert.deepEqual(
    await queueKeys(),
    [
      [k(3), true, true, false],
      [k(2), true, false, false],
      [k(1), false, false, true],
    ],
    "claimed jobs lead the queue, the backlog keeps the rest",
  );

  // A held claimed job will not launch, so it does not take a claim's room.
  await changeQueue(deps, idOf(1), "release");
  await changeQueue(deps, idOf(2), "hold");
  assert.deepEqual((await claim()).claimed, [k(1)], "holding a claimed job frees its room");

  // A launched job has left the queue; its control goes with the next pass.
  await db.update(jobs).set({ t3_thread_id: "thread-x", machine_id: "test-machine" }).where(eq(jobs.id, idOf(3)));
  await claim();
  const controls = await db.select().from(queueControls).where(inArray(queueControls.job_id, [idOf(1), idOf(2), idOf(3)]));
  assert.deepEqual(controls.map((c) => c.job_id).sort(), [idOf(1), idOf(2)], "the launched job's control is gone, the queued ones' stay");

  // A source whose read fails keeps its backlog.
  ready = [...items];
  ops.config.factory.maxInFlight = 0;
  await claim();
  assert.deepEqual((await queueKeys()).map((r) => r[0]), [k(2), k(1), k(4)], "a new item joins the backlog behind the claimed jobs, which keep their claim order");
  down = true;
  await assert.rejects(claim(), /the board is down/);
  assert.equal((await db.select().from(backlog).where(eq(backlog.id, idOf(4)))).length, 1, "and a failed read keeps the source's backlog");
  down = false;

  dequeueFails = true;
  const failed = await changeQueue(deps, idOf(4), "remove");
  assert.match(failed.ok ? "" : failed.message, /Could not remove the factory label: Linear is down/);
  assert.equal((await db.select().from(backlog).where(eq(backlog.id, idOf(4)))).length, 1, "a failed removal changes nothing");
  dequeueFails = false;
  assert.deepEqual(await changeQueue(deps, idOf(4), "remove"), { ok: true });
  assert.deepEqual(await changeQueue(deps, idOf(2), "remove"), { ok: true }, "a claimed job can be removed too");
  assert.deepEqual(dequeued, [`${SOURCE}:${items[3]!.externalId}`, `${SOURCE}:${items[1]!.externalId}`], "each removed at its source");
  assert.equal((await db.select().from(backlog).where(eq(backlog.id, idOf(4)))).length, 0, "and out of the backlog at once");
  assert.equal((await db.select().from(queueControls).where(eq(queueControls.job_id, idOf(2)))).length, 0, "with its control");

  console.log("queue regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  ops.config.factory.maxInFlight = maxInFlight;
  const ids = [1, 2, 3, 4].map(idOf);
  await db.delete(queueState).where(eq(queueState.id, QUEUE_STATE_ID));
  await db.delete(queueControls).where(inArray(queueControls.job_id, ids));
  await db.delete(backlog).where(inArray(backlog.id, ids));
  await db.delete(auditLog).where(inArray(auditLog.job_id, ids));
  await db.delete(jobs).where(inArray(jobs.id, ids));
  process.exit(process.exitCode ?? 0);
}
