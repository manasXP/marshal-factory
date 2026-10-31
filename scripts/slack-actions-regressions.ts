import "./test-guard";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { JobRow } from "../db/schema";
import type { MergeDecision } from "../lib/merge-decision";
import type { Job } from "../lib/sources/types";

// Acting from Slack: signed requests straight into the interactivity handler, a fake Slack Web API
// and response_url on localhost, and the panel's own inbox actions behind them.

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;
const TOKEN = "xoxb-regression-token-0123456789";
const SIGNING = "regression-signing-secret-abcdef";
const OWNER_SLACK = "U0OWNER";

const { db } = await import("../db/client");
const { auditLog, intents, jobs, slackMessages } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { approveDetailSchema, feedbackDetailSchema } = await import("../lib/inbox");
const inbox = await import("../lib/inbox-actions");
const { notifyEvents, renderMessage, SLACK_ACTION_IDS, SLACK_LINK_ACTION_IDS } = await import("../lib/slack");
const { postResponse, slackClient } = await import("../lib/slack-api");
const { ALREADY_RESOLVED, handleInteraction, LOADING, MAX_SKEW_SECONDS, NOT_OWNER, ownerFromAllowlist, slackRequestId, TEXT_BLOCK } = await import("../lib/slack-interactions");
const { serve } = await import("./serve");

// --- the fake Slack: Web API calls under /api/, response_url posts under /response/
type Call = { method: string; params: Record<string, string> };
const calls: Call[] = [];
/** Slack calls and the handler's database reads, in the order they happened. */
const timeline: string[] = [];
const responses: { path: string; body: { text?: string; response_type?: string; replace_original?: boolean } }[] = [];
const server = await serve(0, async (request) => {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/response/")) {
    responses.push({ path, body: await request.json() });
    return new Response("ok");
  }
  const method = path.replace(/^\/api\//, "");
  const params = Object.fromEntries(new URLSearchParams(await request.text()));
  calls.push({ method, params });
  timeline.push(method);
  if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ ok: false, error: "invalid_auth" });
  if (method === "views.open") return Response.json({ ok: true, view: { id: `V${calls.length}`, hash: `hash-${calls.length}` } });
  if (method === "views.update") return Response.json({ ok: true, view: { id: params.view_id, hash: `hash-${calls.length}` } });
  return Response.json({ ok: true, channel: params.channel, ts: params.ts });
});
const trackedDb = new Proxy(db, {
  get(target, key, receiver) {
    if (key === "select") timeline.push("db");
    return Reflect.get(target, key, receiver);
  },
});
const base = `http://localhost:${server.port}`;

const prefix = `SLA${Date.now() % 1_000_000}`;
const created: string[] = [];
const replies: { job: Job; requestId: string; body: string }[] = [];
let replyFails: string | null = null;
const filed: string[] = [];

const tasks: Promise<void>[] = [];
const drain = async () => {
  while (tasks.length > 0) await Promise.all(tasks.splice(0));
};
const owner = async () => ownerFromAllowlist();
const deps = {
  signingSecret: SIGNING,
  ownerSlackId: OWNER_SLACK,
  slack: slackClient({ token: TOKEN, baseUrl: `${base}/api/`, minGapMs: 0 }),
  respond: postResponse,
  inbox: {
    db: trackedDb,
    user: owner,
    reply: async (job: Job, requestId: string, body: string) => {
      if (replyFails) throw new Error(replyFails);
      replies.push({ job, requestId, body });
    },
    newJob: {
      user: owner,
      file: async (draft: { title: string }) => {
        filed.push(draft.title);
        return { id: "issue-1", identifier: "FAC-999", url: "https://linear.app/x/issue/FAC-999" };
      },
      harnesses: async () => null,
      registry: async () => [],
      recordFiling: async () => {},
    },
  },
  panelUrl: "https://panel.test",
  secrets: [TOKEN, SIGNING],
  after: (task: () => Promise<void>) => void tasks.push(task()),
  pollMs: 20,
  followMs: 400,
} as unknown as Parameters<typeof handleInteraction>[1];

const sign = (body: string, ts = Math.floor(Date.now() / 1000), secret = SIGNING) => ({
  "x-slack-request-timestamp": String(ts),
  "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`,
});
const send = (payload: object, headers?: Record<string, string>) => {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  return handleInteraction(
    new Request("http://localhost/api/slack/interactions", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(headers ?? sign(body)) }, body }),
    deps,
  );
};
let urls = 0;
const click = (eventId: string, actionId: string, user = OWNER_SLACK) => {
  const response_url = `${base}/response/${++urls}`;
  return { response_url, sent: send({ type: "block_actions", user: { id: user }, trigger_id: `trigger-${urls}`, response_url, actions: [{ action_id: actionId, block_id: `item:${eventId}` }] }) };
};
const submit = (view: { callback_id: string; private_metadata: string }, text: string, user = OWNER_SLACK) =>
  send({ type: "view_submission", user: { id: user }, view: { ...view, state: { values: { [TEXT_BLOCK]: { text: { type: "plain_text_input", value: text } } } } } });
/** The modal as the last views.update left it. */
const modalView = () =>
  JSON.parse(calls.filter((c) => c.method === "views.update").at(-1)!.params.view!) as { callback_id: string; private_metadata: string; submit?: unknown; blocks: { type: string; optional?: boolean }[] };
const repliesTo = (url: string) => responses.filter((r) => url.endsWith(r.path)).map((r) => r.body.text);

const decision = (over: Partial<MergeDecision> = {}): MergeDecision => ({
  outcome: "handover",
  reasons: ["The agent isn't confident: the migration is untested."],
  autonomy: "auto",
  evaluatedAt: new Date().toISOString(),
  headSha: "h1",
  headSeenAt: null,
  stageEventId: null,
  ...over,
});

/** A job with its open Slack message, as the notifier leaves it. */
async function item(n: string, over: Partial<typeof jobs.$inferInsert>) {
  const row = linearJob(`${prefix}-${n}`, `${prefix}-${n}`, { title: `Job ${n}`, url: `https://linear.app/x/issue/${prefix}-${n}`, stage_at: new Date(), ...over });
  await db.insert(jobs).values(row);
  created.push(row.id!);
  const [job] = await db.select().from(jobs).where(eq(jobs.id, row.id!));
  const [event] = notifyEvents([job!]).filter((e) => e.open);
  assert.ok(event, `job ${n} is an inbox item`);
  const now = new Date();
  await db.insert(slackMessages).values({ id: event.id, job_id: job!.id, kind: event.kind, state: "open", channel: "DU0OWNER", ts: `${n}.0001`, created_at: now, updated_at: now });
  return { id: job!.id, eventId: event.id, ts: `${n}.0001` };
}
const intentsFor = (id: string) => db.select().from(intents).where(eq(intents.job_id, id as JobRow["id"]));
const updatesOf = (ts: string) => calls.filter((c) => c.method === "chat.update" && c.params.ts === ts);
const actionIds = (blocks: string) => (JSON.parse(blocks) as { type: string; elements?: { action_id: string }[] }[]).flatMap((b) => (b.type === "actions" ? b.elements!.map((e) => e.action_id) : []));
const INBOX_IDS = Object.values(SLACK_ACTION_IDS) as string[];

try {
  // --- buttons: what each kind offers, the panel's actions; none once pending or resolved
  const facts = { panelUrl: "https://panel.test", spend: null, secrets: [TOKEN] };
  const pureJob = { ...linearJob("pure", "PURE-1", { title: "t", stage: "pr", pr_url: "https://github.com/o/r/pull/7" }), attempt: 1 } as JobRow;
  const buttons = (kind: Parameters<typeof renderMessage>[0]["kind"], resolved: string | null = null, pending: string | null = null) =>
    actionIds(JSON.stringify(renderMessage({ id: "e", kind, job: pureJob, reason: "r" }, facts, resolved, pending).blocks)).filter((id) => INBOX_IDS.includes(id));
  assert.deepEqual(buttons("handover"), [SLACK_ACTION_IDS.approve, SLACK_ACTION_IDS.request_changes, SLACK_ACTION_IDS.close]);
  assert.deepEqual(buttons("question"), [SLACK_ACTION_IDS.answer]);
  assert.deepEqual(buttons("failed"), [SLACK_ACTION_IDS.retry, SLACK_ACTION_IDS.close, SLACK_ACTION_IDS.dismiss]);
  assert.deepEqual(buttons("revert_failed"), [SLACK_ACTION_IDS.follow_up, SLACK_ACTION_IDS.dismiss]);
  assert.deepEqual(buttons("stop_unconfirmed"), [SLACK_ACTION_IDS.retry_stop, SLACK_ACTION_IDS.dismiss]);
  assert.deepEqual(buttons("merged"), [], "an update offers nothing to do");
  assert.deepEqual(buttons("handover", "✅ Merged"), [], "a resolved message has no action buttons");
  assert.deepEqual(buttons("handover", null, "⏳ Merging…"), [], "nor does a pending one");
  const open = renderMessage({ id: "e", kind: "handover", job: pureJob, reason: "r" }, facts);
  const approveButton = (open.blocks.at(-1) as { elements: { action_id: string; confirm?: { title: { text: string } } }[] }).elements[0]!;
  assert.equal(approveButton.confirm?.title.text, "Approve and merge?", "approving asks first");
  assert.ok(actionIds(JSON.stringify(renderMessage({ id: "e", kind: "handover", job: pureJob, reason: "r" }, facts, "✅ Merged").blocks)).includes(SLACK_LINK_ACTION_IDS.panel), "the links stay");
  assert.notEqual(slackRequestId("a", "approve"), slackRequestId("b", "approve"));
  assert.equal(slackRequestId("a", "approve"), slackRequestId("a", "approve"), "one action on one event is one request");

  const hand = await item("H", { stage: "pr", pr_url: "https://github.com/o/r/pull/1", merge_decision: decision() });

  // --- the signature is checked before anything else
  const unsigned = await send({ type: "block_actions" }, {});
  assert.equal(unsigned.status, 401, "no signature");
  const body = new URLSearchParams({ payload: JSON.stringify({ type: "block_actions" }) }).toString();
  assert.equal((await send({ type: "block_actions" }, sign(body, undefined, "wrong-secret"))).status, 401, "a wrong secret");
  assert.equal((await send({ type: "block_actions" }, sign(body))).status, 200, "the same body signed right");
  assert.equal((await send({ type: "block_actions" }, sign(body, Math.floor(Date.now() / 1000) - MAX_SKEW_SECONDS - 5))).status, 401, "a replay older than five minutes");
  const tampered = sign(body);
  assert.equal(
    (await handleInteraction(new Request("http://localhost/", { method: "POST", headers: tampered, body: body.replace("block_actions", "block_actionz") }), deps)).status,
    401,
    "a body changed after signing",
  );
  assert.equal((await handleInteraction(new Request("http://localhost/", { method: "POST", headers: sign(body), body }), { ...deps, signingSecret: undefined })).status, 401, "no signing secret, no actions");

  // --- only the owner acts
  const stranger = click(hand.eventId, SLACK_ACTION_IDS.approve, "U0STRANGER");
  assert.equal((await stranger.sent).status, 200, "acked");
  await drain();
  assert.deepEqual(repliesTo(stranger.response_url), [NOT_OWNER]);
  assert.equal(responses.at(-1)!.body.response_type, "ephemeral");
  assert.equal((await intentsFor(hand.id)).length, 0, "nothing recorded for a stranger");
  assert.equal(updatesOf(hand.ts).length, 0);
  const strangerModal = click(hand.eventId, SLACK_ACTION_IDS.request_changes, "U0STRANGER");
  await strangerModal.sent;
  await drain();
  assert.deepEqual(repliesTo(strangerModal.response_url), [NOT_OWNER]);
  assert.equal(calls.filter((c) => c.method === "views.open").length, 0, "no modal for a stranger");

  // --- link buttons are acked and ignored
  const mark = calls.length;
  assert.equal((await click(hand.eventId, SLACK_LINK_ACTION_IDS.pr).sent).status, 200);
  await drain();
  assert.equal(calls.length, mark);

  // --- approve and merge records the panel's approve_merge intent, once for a double click
  const first = click(hand.eventId, SLACK_ACTION_IDS.approve);
  const second = click(hand.eventId, SLACK_ACTION_IDS.approve);
  await Promise.all([first.sent, second.sent]);
  await drain();
  const approvals = await intentsFor(hand.id);
  assert.equal(approvals.length, 1, "a double click records one intent");
  const requestId = slackRequestId(hand.eventId, "approve");
  assert.equal(approvals[0]!.id, `panel:approve_merge:${requestId}`);
  assert.deepEqual(approveDetailSchema.parse(JSON.parse(approvals[0]!.detail!)), { actor: OWNER, headSha: "h1", via: "inbox" }, "the head the decision read, as the inbox's approval");
  assert.deepEqual(await inbox.approveMerge(deps.inbox, hand.id, requestId, "h1"), { ok: true, intentId: approvals[0]!.id }, "the panel's own action finds the same intent");
  const pendingUpdate = updatesOf(hand.ts)[0]!;
  assert.match(pendingUpdate.params.text!, /⏳ Merging…/, "the message turns pending at once");
  assert.deepEqual(actionIds(pendingUpdate.params.blocks!).filter((id) => INBOX_IDS.includes(id)), [], "with no buttons to click again");
  assert.deepEqual(repliesTo(first.response_url), [], "nothing to say while the runner works");

  // --- the runner refuses: the buttons come back with the reason
  const red = await item("R", { stage: "pr", pr_url: "https://github.com/o/r/pull/2", merge_decision: decision({ headSha: "h2" }) });
  const refused = click(red.eventId, SLACK_ACTION_IDS.approve);
  await refused.sent;
  const runner = (async () => {
    for (let i = 0; i < 50; i++) {
      const [intent] = await intentsFor(red.id);
      if (intent) {
        await db.update(intents).set({ handled_at: new Date(), result: JSON.stringify({ approval: { blocked: "a check is red on h2" } }) }).where(eq(intents.id, intent.id));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  await drain();
  await runner;
  assert.deepEqual(repliesTo(refused.response_url), ["Not merged: a check is red on h2"]);
  const restored = updatesOf(red.ts).at(-1)!;
  assert.deepEqual(actionIds(restored.params.blocks!).filter((id) => INBOX_IDS.includes(id)), [SLACK_ACTION_IDS.approve, SLACK_ACTION_IDS.request_changes, SLACK_ACTION_IDS.close], "the buttons are back");

  // --- after a refusal the action can be tried again, still once per double click
  const refusedId = slackRequestId(red.eventId, "approve");
  const retryId = slackRequestId(red.eventId, "approve", refusedId);
  const retryA = click(red.eventId, SLACK_ACTION_IDS.approve);
  const retryB = click(red.eventId, SLACK_ACTION_IDS.approve);
  await Promise.all([retryA.sent, retryB.sent]);
  const merger = (async () => {
    for (let i = 0; i < 50; i++) {
      const [intent] = await db.select().from(intents).where(eq(intents.id, `panel:approve_merge:${retryId}`));
      if (intent) {
        await db.update(intents).set({ handled_at: new Date(), result: JSON.stringify({ approval: { merged: "abc1234def" } }) }).where(eq(intents.id, intent.id));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  await drain();
  await merger;
  assert.deepEqual(
    (await intentsFor(red.id)).map((i) => i.id).sort(),
    [`panel:approve_merge:${refusedId}`, `panel:approve_merge:${retryId}`].sort(),
    "the second approval is a new intent, and the double click on the restored buttons records it once",
  );
  assert.deepEqual([...repliesTo(retryA.response_url), ...repliesTo(retryB.response_url)], [], "merged: nothing to say, the notifier resolves it");
  assert.match(updatesOf(red.ts).at(-1)!.params.text!, /⏳ Merging…/, "and the message stays pending");

  // --- request changes: a modal, then the panel's request_changes intent
  const changes = await item("C", { stage: "pr", pr_url: "https://github.com/o/r/pull/3", merge_decision: decision() });
  const before = timeline.length;
  const opened = click(changes.eventId, SLACK_ACTION_IDS.request_changes);
  await opened.sent;
  assert.equal(timeline[before], "views.open", "the modal opens before the ack, before anything is read");
  const viewCall = calls.filter((c) => c.method === "views.open").at(-1)!;
  assert.equal(viewCall.params.trigger_id, `trigger-${urls}`, "the click's trigger opens the modal");
  const loading = JSON.parse(viewCall.params.view!) as { submit?: unknown; title: { text: string } };
  assert.match(JSON.stringify(loading), new RegExp(LOADING), "a loading view");
  assert.equal(loading.submit, undefined, "with nothing to submit");
  assert.equal(loading.title.text, "Request changes");
  await drain();
  const updateCall = calls.filter((c) => c.method === "views.update").at(-1)!;
  assert.equal(updateCall.params.view_id, `V${calls.indexOf(viewCall) + 1}`, "the opened view is filled in");
  assert.equal(updateCall.params.hash, `hash-${calls.indexOf(viewCall) + 1}`, "with the hash views.open returned");
  const view = modalView();
  assert.equal(view.callback_id, SLACK_ACTION_IDS.request_changes);
  assert.equal(view.blocks.find((b) => b.type === "input")!.optional, false, "feedback is required");
  assert.equal((await intentsFor(changes.id)).length, 0, "opening the modal records nothing");
  assert.match(JSON.stringify(await (await submit(view, "Rename the flag.", "U0STRANGER")).json()), new RegExp(NOT_OWNER), "a stranger's submission is refused in the modal");
  const accepted = await submit(view, "Rename the flag.");
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), "", "an empty ack closes the modal");
  await drain();
  const [changeIntent] = await intentsFor(changes.id);
  assert.equal(changeIntent!.kind, "request_changes");
  assert.deepEqual(feedbackDetailSchema.parse(JSON.parse(changeIntent!.detail!)), {
    from: "panel",
    id: `panel:${slackRequestId(changes.eventId, "request_changes")}`,
    actor: OWNER,
    body: "Rename the flag.",
  });
  assert.match(updatesOf(changes.ts)[0]!.params.text!, /Sending your changes/);

  // --- answer: a modal, then the answer in the source and the answer intent
  const question = await item("Q", { stage: "waiting", question: "Postgres or SQLite?" });
  const ask = click(question.eventId, SLACK_ACTION_IDS.answer);
  await ask.sent;
  await drain();
  const answerView = modalView();
  assert.equal(answerView.callback_id, SLACK_ACTION_IDS.answer);
  assert.match(JSON.stringify(answerView), /Postgres or SQLite\?/, "the modal shows the question");
  await submit(answerView, "Postgres.");
  await drain();
  assert.deepEqual(replies.map((r) => [r.job.key, r.requestId, r.body]), [[`${prefix}-Q`, slackRequestId(question.eventId, "answer"), "Postgres."]], "posted in the source as the panel does");
  const [answerIntent] = await intentsFor(question.id);
  assert.equal(answerIntent!.id, `panel:answer:${slackRequestId(question.eventId, "answer")}`);
  assert.match(updatesOf(question.ts)[0]!.params.text!, /Answer sent/);

  // --- an error says why, without secrets, and puts the buttons back
  const leaky = await item("L", { stage: "waiting", question: "Which key?" });
  const leakyClick = click(leaky.eventId, SLACK_ACTION_IDS.answer);
  await leakyClick.sent;
  await drain();
  replyFails = `Linear refused ${TOKEN}`;
  await submit(modalView(), "This one.");
  await drain();
  replyFails = null;
  const [leakReply] = repliesTo(leakyClick.response_url);
  assert.match(leakReply!, /Could not post the answer: Linear refused \[redacted\]/);
  assert.ok(!JSON.stringify(responses).includes(TOKEN) && !JSON.stringify(calls).includes(TOKEN), "no secret reaches Slack");
  assert.deepEqual(actionIds(updatesOf(leaky.ts).at(-1)!.params.blocks!).filter((id) => INBOX_IDS.includes(id)), [SLACK_ACTION_IDS.answer]);
  assert.equal((await intentsFor(leaky.id)).length, 0);

  // --- retry: a modal whose note is optional, then the retry_job intent
  const retried = await item("RETRY", { stage: "failed", stage_summary: "Tests failed." });
  const retryClick = click(retried.eventId, SLACK_ACTION_IDS.retry);
  await retryClick.sent;
  await drain();
  const retryView = modalView();
  assert.equal(retryView.callback_id, SLACK_ACTION_IDS.retry);
  assert.equal(retryView.blocks.find((b) => b.type === "input")!.optional, true, "the note is optional");
  assert.equal((await intentsFor(retried.id)).length, 0, "opening the modal records nothing");
  await submit(retryView, "Use the staging key.");
  await drain();
  const [retryIntent] = await intentsFor(retried.id);
  assert.equal(retryIntent!.id, `panel:retry_job:${slackRequestId(retried.eventId, "retry")}`);
  assert.deepEqual([retryIntent!.kind, JSON.parse(retryIntent!.detail!)], ["retry_job", { actor: OWNER, attempt: 1, note: "Use the staging key." }]);
  assert.match(updatesOf(retried.ts)[0]!.params.text!, /Retrying/);

  // --- dismiss acts at once
  const failed = await item("F", { stage: "failed", stage_summary: "Tests failed." });
  const dismiss = click(failed.eventId, SLACK_ACTION_IDS.dismiss);
  await dismiss.sent;
  await drain();
  const [dismissed] = await db.select().from(jobs).where(eq(jobs.id, failed.id as JobRow["id"]));
  assert.ok(dismissed!.dismissed_at, "dismissed through the panel's action");
  assert.match(updatesOf(failed.ts)[0]!.params.text!, /Dismissed/);

  // --- a stale button on a resolved item does nothing
  const again = click(failed.eventId, SLACK_ACTION_IDS.dismiss);
  await again.sent;
  await drain();
  assert.deepEqual(repliesTo(again.response_url), [ALREADY_RESOLVED], "the event left the inbox, so the button is stale");
  await db.update(slackMessages).set({ state: "resolved", resolution: "✅ Merged" }).where(eq(slackMessages.id, hand.eventId));
  const stale = click(hand.eventId, SLACK_ACTION_IDS.request_changes);
  await stale.sent;
  await drain();
  const resolvedView = modalView();
  assert.match(JSON.stringify(resolvedView), new RegExp(ALREADY_RESOLVED), "a resolved message's modal button says so in the modal");
  assert.equal(resolvedView.submit, undefined, "with nothing to submit");
  assert.deepEqual(repliesTo(stale.response_url), []);
  const staleSubmit = await submit({ callback_id: SLACK_ACTION_IDS.request_changes, private_metadata: JSON.stringify({ event: hand.eventId, responseUrl: `${base}/response/stale` }) }, "Too late.");
  assert.match(JSON.stringify(await staleSubmit.json()), /already resolved/, "a modal left open on a resolved item");
  await drain();
  assert.equal((await intentsFor(hand.id)).length, 1, "still only the one approval");
  assert.equal(filed.length, 0);

  console.log("slack actions regressions passed");
} finally {
  if (created.length > 0) {
    const ids = created as JobRow["id"][];
    await db.delete(intents).where(inArray(intents.job_id, ids));
    await db.delete(auditLog).where(inArray(auditLog.job_id, ids));
    await db.delete(slackMessages).where(inArray(slackMessages.job_id, ids));
    await db.delete(jobs).where(inArray(jobs.id, ids));
  }
  await server.close();
}
process.exit(0);
