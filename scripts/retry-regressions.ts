import "./test-guard";
import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;

const { db } = await import("../db/client");
const { intents, jobs } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { config } = await import("../runner/config");
const { SOURCES, parseJob } = await import("../lib/sources");
const { allows, inboxItems, inboxKind, INBOX_ACTIONS, MAX_RETRY_NOTE_CHARS } = await import("../lib/inbox");
const inbox = await import("../lib/inbox-actions");
const { retryJob } = await import("../runner/inbox");
const { claim, launchMessage } = await import("../runner/ops");
const { INTENT_ROUTES, INTENT_ATTEMPTS } = await import("../runner/intents");

const stamp = Date.now() % 1_000_000;
const REPO = "ski043/factory-demo";
const owner = { email: OWNER, emailVerified: true };
const deps = (user: typeof owner | null = owner) => ({
  db,
  user: async () => user,
  reply: async () => {},
  newJob: { user: async () => user, harnesses: async () => [], registry: async () => [], file: async () => ({ key: "x", url: "u" }), recordFiling: async () => {} },
});

const row = async (key: string) => (await db.select().from(jobs).where(eq(jobs.key, key)))[0]!;
const intentsOf = (id: string) => db.select().from(intents).where(eq(intents.job_id, id as never));

// The label is the source's: until requeue puts it back, the source offers nothing.
const offered = new Set<string>();
const requeued: string[] = [];
const comments: { key: string; noteKey: string; body: string }[] = [];
SOURCES.linear.requeue = async (job) => void (requeued.push(job.key), offered.add(job.key));
SOURCES.linear.note = async (job, noteKey, body) => void comments.push({ key: job.key, noteKey, body });
const source = {
  ...SOURCES.linear,
  ready: async () =>
    [...offered].map((key) => ({
      externalId: key,
      key,
      title: "t",
      url: "u",
      description: "Fix the list.",
      writeback: { kind: "linear" as const, issueId: key },
      sourceState: { state: "Todo", labels: ["factory"], labelGroups: [] },
    })),
};
const claimReady = () => claim({ sources: [source], repos: async () => [REPO], registry: async () => [] });
const maxInFlight = config.factory.maxInFlight;
config.factory.maxInFlight = 1000;

async function failed(name: string, over: Partial<typeof jobs.$inferInsert> = {}) {
  const key = `RTY-${name}-${stamp}`;
  await db.insert(jobs).values(linearJob(key, key, { stage: "failed", stage_at: new Date(), stage_summary: "The tests never passed.", stage_event_id: `e-${key}`, synced_event_id: `e-${key}`, machine_id: TEST_MACHINE_ID, ...over }));
  return key;
}

try {
  assert.deepEqual(INBOX_ACTIONS.failed, ["retry", "close", "dismiss"], "a failed item offers Retry first");
  assert.ok(allows("failed", "retry") && !allows("handover", "retry") && !allows("question", "retry") && !allows("stop_unconfirmed", "retry"));
  assert.equal(INTENT_ROUTES.retry_job, "any", "any machine can retry; the claim decides who launches");
  assert.ok(INTENT_ATTEMPTS.retry_job > 0);

  // --- the panel's action: owner checks, validation, one intent per request
  const A = await failed("a");
  const aId = (await row(A)).id;
  assert.equal(inboxKind(await row(A)), "failed");
  assert.deepEqual(inboxItems([await row(A)]).map((i) => i.kind), ["failed"]);
  const rid = crypto.randomUUID();
  assert.deepEqual(await inbox.retryFailed(deps(null), aId, rid, ""), { ok: false, message: "Only the factory owner can act on the inbox." });
  assert.deepEqual(await inbox.retryFailed(deps(), aId, "nope", ""), { ok: false, message: "The request is not valid." });
  assert.deepEqual(await inbox.retryFailed(deps(), aId, rid, "x".repeat(MAX_RETRY_NOTE_CHARS + 1)), { ok: false, message: "The note is too long." });
  assert.equal((await intentsOf(aId)).length, 0, "refusals record nothing");
  const sent = await inbox.retryFailed(deps(), aId, rid, "  Use the staging key.  ");
  assert.deepEqual(sent, { ok: true, intentId: `panel:retry_job:${rid}` });
  assert.deepEqual(await inbox.retryFailed(deps(), aId, rid, "  Use the staging key.  "), sent, "a double submit records one intent");
  const [intent] = await intentsOf(aId);
  assert.deepEqual([intent!.kind, JSON.parse(intent!.detail!)], ["retry_job", { actor: OWNER, attempt: 1, note: "Use the staging key." }]);

  const working = await failed("working", { stage: "implementing" });
  assert.deepEqual(await inbox.retryFailed(deps(), (await row(working)).id, crypto.randomUUID(), ""), { ok: false, message: "Only a failed job can be retried." });
  const dismissedKey = await failed("dismissed", { dismissed_at: new Date(Date.now() + 1000) });
  assert.equal((await inbox.retryFailed(deps(), (await row(dismissedKey)).id, crypto.randomUUID(), "")).ok, false, "a dismissed failure is out of the inbox, so Retry is not offered");

  // --- the runner: one new attempt, the same one the label would start
  const detail = { actor: OWNER, attempt: 1, note: "Use the staging key." };
  const [one, two] = await Promise.all([retryJob(aId, detail, claimReady), retryJob(aId, detail, claimReady)]);
  assert.deepEqual([one, two], [{ started: 2 }, { started: 2 }], "two deliveries at once start one attempt");
  const after = await row(A);
  assert.deepEqual([after.attempt, after.stage, after.previous_failure], [2, "queued", "The tests never passed."]);
  assert.deepEqual(after.attempt_note, { attempt: 2, text: "Use the staging key." });
  assert.ok(comments.every((c) => c.noteKey === "retry-2" && c.key === A), "the source's comment is keyed by attempt, so it posts once");
  assert.match(comments[0]!.body, /Use the staging key\./);

  requeued.length = 0;
  assert.deepEqual(await retryJob(aId, detail, claimReady), { started: 2 }, "a replay after the attempt started finds it");
  assert.deepEqual([requeued, (await row(A)).attempt], [[], 2], "and touches nothing");

  const message = launchMessage(parseJob(await row(A)));
  assert.match(message, /The previous attempt failed: The tests never passed\./);
  assert.match(message, /## Owner's note for this attempt\n\nUse the staging key\./);
  assert.ok(message.indexOf("previous attempt failed") < message.indexOf("Owner's note"), "after the failure it follows up on");

  // --- a failure of attempt 2 is not retried by a delivery meant for attempt 1, and its note is not attempt 3's
  await db.update(jobs).set({ stage: "failed", stage_summary: "Failed again.", stop: null }).where(eq(jobs.key, A));
  assert.deepEqual(await retryJob(aId, detail, claimReady), { started: 2 }, "a stale delivery does nothing");
  assert.equal((await row(A)).stage, "failed");
  assert.deepEqual(await retryJob(aId, { actor: OWNER, attempt: 2, note: "" }, claimReady), { started: 3 });
  const third = await row(A);
  assert.equal(launchMessage(parseJob(third)).includes("Owner's note"), false, "attempt 2's note is not attempt 3's, and an empty note adds none");
  assert.equal(comments.length, comments.filter((c) => c.noteKey === "retry-2").length, "no comment for an empty note");

  // --- a job that is not failed is left alone
  const live = await failed("live", { stage: "implementing" });
  requeued.length = 0;
  const refused = await retryJob((await row(live)).id, { actor: OWNER, attempt: 1, note: "late" }, claimReady);
  assert.deepEqual(refused, { refused: "The job is implementing, not failed; there is nothing to retry." });
  assert.deepEqual([requeued, (await row(live)).attempt, (await row(live)).attempt_note], [[], 1, null]);
  assert.deepEqual(await retryJob(`linear:RTY-gone-${stamp}` as never, detail, claimReady), { refused: `No job linear:RTY-gone-${stamp}.` });

  // --- a failure not yet written back would undo the requeue, so it waits for the write-back
  const unsynced = await failed("unsynced", { synced_event_id: null });
  requeued.length = 0;
  const early = await retryJob((await row(unsynced)).id, { actor: OWNER, attempt: 1, note: "soon" }, claimReady);
  assert.deepEqual(early, { refused: "The failure is still being written back to the issue. Retry again in a minute." });
  assert.deepEqual([requeued, (await row(unsynced)).attempt, (await row(unsynced)).attempt_note], [[], 1, null], "and requeues nothing");

  // --- a failed job whose old attempt still holds a sandbox cannot start yet: said, not silent
  const held = await failed("held", { sandbox_id: "sbx-1" });
  const heldResult = await retryJob((await row(held)).id, { actor: OWNER, attempt: 1, note: "" }, claimReady);
  assert.ok("refused" in heldResult && /can't start another attempt yet/.test(heldResult.refused));
  assert.equal((await row(held)).attempt, 1);

  // --- what the owner reads back
  const done = (raw: object) => inbox.describeOutcome("retry_job", JSON.stringify(raw));
  assert.deepEqual(done({ attempt: { started: 2 } }), { status: "done", message: "Attempt 2 is queued." });
  assert.deepEqual(done({ attempt: { refused: "no" } }), { status: "failed", message: "no" });
  console.log("retry regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  config.factory.maxInFlight = maxInFlight;
  await db.delete(jobs).where(like(jobs.key, `RTY-%-${stamp}`));
  process.exit(process.exitCode ?? 0);
}
