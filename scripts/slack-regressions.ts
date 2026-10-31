import "./test-guard";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import type { JobRow } from "../db/schema";
import type { MergeDecision } from "../lib/merge-decision";

// Slack notifications against a fake Slack Web API: no request leaves this machine.

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;
const TOKEN = "xoxb-regression-token-0123456789";
const SIGNING = "regression-signing-secret-abcdef";
process.env.SLACK_SIGNING_SECRET = SIGNING;

const { db } = await import("../db/client");
const { intents, jobs, notificationSettings, runs, slackMessages } = await import("../db/schema");
const { linearJob, usageRun } = await import("./fixtures");
const { inQuietHours, notificationConfigSchema, NOTIFICATIONS_ID, parseNotificationConfig, requestSlackTest, saveNotifications, slackTestOutcome, DEFAULT_NOTIFICATIONS } = await import("../lib/notifications");
const { eventId, NOTIFY_WINDOW_MS, notifyEvents, panelUrl, redact, renderMessage, resolution, SLACK_ACTION_IDS } = await import("../lib/slack");
const { slackClient } = await import("../lib/slack-api");
const { notifySlack, POSTING_STALE_MS, sendSlackTest, slackFromEnv } = await import("../runner/slack");
const { deliveryFor, INTENT_ATTEMPTS, INTENT_ROUTES } = await import("../runner/intents");
const { requestedStop } = await import("../lib/stop");
const { reportedSlack } = await import("../lib/machine");
const { serve } = await import("./serve");

// --- the fake Slack Web API
type Call = { method: string; params: Record<string, string>; auth: string | null; at: number };
const calls: Call[] = [];
const forced: { method: string; status: number; headers?: Record<string, string>; body?: object }[] = [];
let inFlight = 0;
let maxInFlight = 0;
let nextTs = 1000;
const server = await serve(0, async (request) => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    const method = new URL(request.url).pathname.replace(/^\/api\//, "");
    const params = Object.fromEntries(new URLSearchParams(await request.text()));
    calls.push({ method, params, auth: request.headers.get("authorization"), at: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const force = forced.findIndex((f) => f.method === method);
    if (force >= 0) {
      const [f] = forced.splice(force, 1);
      return Response.json(f!.body ?? {}, { status: f!.status, headers: f!.headers });
    }
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ ok: false, error: "invalid_auth" });
    switch (method) {
      case "conversations.open":
        return Response.json({ ok: true, channel: { id: `D${params.users}` } });
      case "chat.postMessage":
        return params.channel === "C0GONE00" ? Response.json({ ok: false, error: "channel_not_found" }) : Response.json({ ok: true, channel: params.channel, ts: `${nextTs++}.000100` });
      case "chat.update":
        return Response.json({ ok: true, channel: params.channel, ts: params.ts });
      default:
        return Response.json({ ok: false, error: "unknown_method" });
    }
  } finally {
    inFlight--;
  }
});
const baseUrl = `http://localhost:${server.port}/api/`;
const fresh = () => ({ client: slackClient({ token: TOKEN, baseUrl, minGapMs: 0 }), owner: "U0OWNER", secrets: [TOKEN, SIGNING] });
let slack = fresh();

const prefix = `SLK${Date.now() % 1_000_000}`;
const key = (n: string) => `${prefix}-${n}`;
const mine = (call: Call) => (call.params.text ?? "").includes(prefix);
const since = (mark: number, method?: string) => calls.slice(mark).filter((c) => (!method || c.method === method) && (c.method.startsWith("conversations") || mine(c)));
const insert = async (n: string, over: Partial<typeof jobs.$inferInsert>) => {
  const row = linearJob(`${prefix}-${n}`, key(n), { title: `Job ${n}`, url: `https://linear.app/x/issue/${key(n)}`, provider: "claudeAgent", ...over });
  await db.insert(jobs).values(row);
  return row.id!;
};
const setJob = (id: string, set: Partial<typeof jobs.$inferInsert>) => db.update(jobs).set({ updated_at: new Date(), ...set }).where(eq(jobs.id, id as JobRow["id"]));
const rowsFor = (id: string) => db.select().from(slackMessages).where(eq(slackMessages.job_id, id as JobRow["id"]));
const writeConfig = (config: object) =>
  db
    .insert(notificationSettings)
    .values({ id: NOTIFICATIONS_ID, config: notificationConfigSchema.parse(config), updated_at: new Date(), updated_by: OWNER })
    .onConflictDoUpdate({ target: notificationSettings.id, set: { config: notificationConfigSchema.parse(config) } });
const pass = async () => {
  const result = await notifySlack(slack);
  assert.notEqual(result, "disabled");
  return result as Exclude<typeof result, "disabled">;
};
const decision = (over: Partial<MergeDecision>): MergeDecision => ({
  outcome: "handover",
  reasons: ["Bugbot found a high severity issue."],
  autonomy: "auto",
  evaluatedAt: new Date().toISOString(),
  headSha: "h",
  headSeenAt: null,
  stageEventId: null,
  ...over,
});

const created: string[] = [];
const track = async (n: string, over: Partial<typeof jobs.$inferInsert>) => {
  const id = await insert(n, over);
  created.push(id);
  return id;
};

try {
  // --- pure rules
  assert.equal(panelUrl({ FACTORY_PANEL_URL: "https://factory.example.com/", VERCEL_PROJECT_PRODUCTION_URL: "p.vercel.app" }), "https://factory.example.com", "the setting wins, without a trailing slash");
  assert.equal(panelUrl({ VERCEL_PROJECT_PRODUCTION_URL: "p.vercel.app" }), "https://p.vercel.app", "on Vercel, the production domain");
  assert.equal(panelUrl({ FACTORY_PANEL_URL: "" }), "https://marshal-factory.vercel.app", "an empty setting falls back");
  assert.deepEqual(parseNotificationConfig(null), DEFAULT_NOTIFICATIONS, "no row means a DM to the owner about everything");
  assert.equal(DEFAULT_NOTIFICATIONS.target, "owner");
  assert.ok(Object.values(DEFAULT_NOTIFICATIONS.events).every(Boolean));
  assert.equal(notificationConfigSchema.safeParse({ target: "channel" }).success, false, "a channel target needs a channel id");
  assert.equal(notificationConfigSchema.safeParse({ target: "channel", channelId: "general" }).success, false, "a channel name is not an id");
  assert.equal(notificationConfigSchema.safeParse({ quietHours: { start: "22:00", end: "07:00", timeZone: "Mars/Olympus" } }).success, false);
  assert.deepEqual(
    notificationConfigSchema.parse({ quietHours: { start: "22:00:00", end: "07:30:59", timeZone: "UTC" } }).quietHours,
    { start: "22:00", end: "07:30", timeZone: "UTC" },
    "a time input that sends seconds is accepted and trimmed",
  );
  assert.equal(notificationConfigSchema.safeParse({ quietHours: { start: "22:00:60", end: "07:00", timeZone: "UTC" } }).success, false);

  const quiet = { start: "22:00", end: "07:00", timeZone: "Europe/Berlin" };
  assert.equal(inQuietHours(quiet, new Date("2026-10-27T22:30:00Z")), true, "23:30 in Berlin is quiet");
  assert.equal(inQuietHours(quiet, new Date("2026-10-28T05:59:00Z")), true, "06:59 in Berlin is quiet");
  assert.equal(inQuietHours(quiet, new Date("2026-10-28T06:00:00Z")), false, "07:00 in Berlin is not");
  assert.equal(inQuietHours(quiet, new Date("2026-10-27T12:00:00Z")), false);
  assert.equal(inQuietHours({ start: "09:00", end: "17:00", timeZone: "UTC" }, new Date("2026-10-27T12:00:00Z")), true, "a daytime window");
  assert.equal(inQuietHours({ start: "09:00", end: "09:00", timeZone: "UTC" }, new Date("2026-10-27T09:00:00Z")), false, "start equal to end is never");
  assert.equal(inQuietHours(null, new Date()), false);

  assert.equal(redact(`token ${TOKEN} and xoxp-1234567890-abc and ghp_${"a".repeat(30)}`), "token [redacted] and [redacted] and [redacted]");
  assert.equal(redact("value s3cret-value-here", ["s3cret-value-here"]), "value [redacted]");

  const pureJob = {
    ...linearJob("pure", "PURE-1", { title: "Fix <the> & thing", url: "https://linear.app/x/issue/PURE-1", stage: "waiting", stage_at: new Date(0), question: `Use ${TOKEN} for <db> & co?`, provider: "codex" }),
    attempt: 1,
    pr_url: "https://github.com/o/r/pull/7",
  } as JobRow;
  const [pureEvent] = notifyEvents([pureJob]);
  assert.equal(pureEvent!.id, eventId(pureJob, "question", new Date(0).toISOString()), "a question's id is its job, attempt, kind and stage report");
  assert.equal(notifyEvents([{ ...pureJob, updated_at: new Date() }])[0]!.id, pureEvent!.id, "the id does not move with updated_at");
  const message = renderMessage(pureEvent!, { panelUrl: "https://panel.test", spend: { usd: 1.234, known: true }, secrets: [TOKEN] });
  const json = JSON.stringify(message);
  assert.ok(!json.includes(TOKEN), "a token in a question never reaches Slack");
  assert.equal((message.blocks[0] as { text: { text: string } }).text.text, "❓ PURE-1 · Fix <the> & thing");
  assert.match(json, /\*Question:\* Use \[redacted\] for &lt;db&gt; &amp; co\?/, "mrkdwn text is escaped");
  assert.match(json, /claudeAgent|Codex/);
  assert.match(json, /\$1\.23/);
  const actions = message.blocks.find((b) => b.type === "actions") as { block_id: string; elements: { url?: string; action_id: string }[] };
  assert.equal(actions.block_id, `item:${pureEvent!.id}`, "the actions block names the event, for level 2");
  assert.deepEqual(
    actions.elements.flatMap((e) => (e.url ? [e.url] : [])),
    ["https://panel.test/inbox?job=PURE-1", "https://github.com/o/r/pull/7", "https://linear.app/x/issue/PURE-1"],
    "links to the panel, the PR and the issue",
  );
  assert.deepEqual(
    actions.elements.filter((e) => !e.url).map((e) => e.action_id),
    [SLACK_ACTION_IDS.answer],
    "an open question offers the inbox's Answer; the acting buttons are covered by slack-actions-regressions",
  );
  assert.equal(resolution("question", { ...pureJob, stage: "implementing", answered_at: new Date(1) }), "✅ Answered");
  assert.equal(resolution("failed", { ...pureJob, stage: "queued" }), "🔁 Retried");
  assert.equal(resolution("failed", { ...pureJob, stage: "failed", dismissed_at: new Date(1) }), "Dismissed");
  assert.equal(resolution("handover", { ...pureJob, stage: "failed", dismissed_at: new Date(1) }), "Closed");
  assert.equal(resolution("handover", { ...pureJob, stage: "merged", merge_decision: decision({ merged: { sha: "s", method: "squash", at: "x", base: "main", title: "t", commits: 1, via: "inbox" } }) }), "✅ Merged by the factory");
  const settledStop = { ...requestedStop({ at: new Date(0), by: OWNER, reason: "r", reopen: false }), settledAt: new Date(1).toISOString() };
  assert.equal(resolution("stop_unconfirmed", { ...pureJob, stop: { ...settledStop, state: "unconfirmed" } }), "Resolved", "still waiting on the owner");
  assert.equal(resolution("stop_unconfirmed", { ...pureJob, stop: { ...settledStop, state: "escalated", settledAt: null, retries: 1 } }), "🔁 Retrying stop", "a retried stop is not confirmed yet");
  assert.equal(resolution("stop_unconfirmed", { ...pureJob, stop: { ...settledStop, state: "confirmed", retries: 1 } }), "✅ Stop confirmed");
  assert.equal(resolution("stop_unconfirmed", { ...pureJob, stop: { ...settledStop, state: "unconfirmed" }, dismissed_at: new Date(2) }), "Dismissed");
  assert.equal(INTENT_ROUTES.slack_test, "slack");
  assert.equal(deliveryFor("slack_test", null, "a"), "skip", "a runner without a Slack token leaves the test message alone");
  assert.equal(deliveryFor("slack_test", "b", "a", true), "lease", "any runner with a token takes it");
  assert.equal(INTENT_ATTEMPTS.slack_test, 1, "a token runner's error is the answer");

  const now = Date.parse("2026-10-27T12:00:00Z");
  const machine = (report: unknown, seen = now) => ({ last_seen_at: new Date(seen), inventory: { runnerSha: "a", t3: "unknown", connect: "unknown", projects: { source: "unknown" }, repos: [], ...(report !== undefined && { slack: report }) } });
  assert.equal(reportedSlack([machine(undefined)], now), null, "no runner reports Slack yet");
  assert.deepEqual(reportedSlack([machine({ configured: false, owner: false }), machine({ configured: true, owner: true })], now), { configured: true, owner: true });
  assert.equal(reportedSlack([machine({ configured: true, owner: true }, now - 3_600_000)], now), null, "an offline runner does not count");

  // --- disabled without a token
  let mark = calls.length;
  assert.equal(slackFromEnv({}), null);
  assert.equal(await notifySlack(slackFromEnv({ SLACK_OWNER_USER_ID: "U0OWNER" })), "disabled", "no token, no notifier");
  assert.deepEqual(await sendSlackTest({ actor: OWNER }, null), { error: "this runner has no SLACK_BOT_TOKEN" });
  assert.equal(calls.length, mark, "nothing reached Slack");
  const fromEnv = slackFromEnv({ SLACK_BOT_TOKEN: TOKEN, SLACK_API_URL: baseUrl, SLACK_OWNER_USER_ID: "U0OWNER", SLACK_SIGNING_SECRET: SIGNING, PATH: "/bin" });
  assert.ok(fromEnv && fromEnv.owner === "U0OWNER");
  assert.ok(fromEnv.secrets.includes(TOKEN) && fromEnv.secrets.includes(SIGNING) && !fromEnv.secrets.includes("/bin"), "the token and signing secret are kept out of messages");

  // The branch copies the dev database: post whatever its jobs already have, so only this script's jobs change below.
  await db.delete(notificationSettings);
  for (let i = 0; i < 40; i++) {
    const drained = await pass();
    if (drained.posted === 0 && !drained.deferred) break;
  }

  // --- a new question posts one message
  const a = await track("A", { stage: "waiting", stage_at: new Date(), question: "Postgres or SQLite?" });
  await db.insert(runs).values(usageRun(key("A")));
  mark = calls.length;
  let result = await pass();
  const posts = since(mark, "chat.postMessage");
  assert.equal(posts.length, 1, "one message for the new question");
  assert.equal(posts[0]!.params.channel, "DU0OWNER", "the owner's DM, opened with conversations.open");
  assert.equal(calls.filter((c) => c.method === "conversations.open").length, 1, "the DM is opened once and remembered");
  assert.equal(posts[0]!.auth, `Bearer ${TOKEN}`, "the token goes in the header");
  assert.match(posts[0]!.params.text!, new RegExp(`❓ ${key("A")} · Job A: Postgres or SQLite\\?`));
  assert.match(posts[0]!.params.blocks!, /ski043\/factory-demo · Claude Code · \$\d+\.\d\d/, "repo, harness and spend");
  let [row] = await rowsFor(a);
  assert.equal(row!.state, "open");
  assert.equal(row!.channel, "DU0OWNER");
  assert.ok(row!.ts);
  assert.ok(result.posted >= 1);

  // --- no duplicate on a re-tick or a restart
  mark = calls.length;
  await pass();
  slack = fresh();
  await pass();
  assert.equal(since(mark).filter((c) => c.method.startsWith("chat.")).length, 0, "a re-tick and a restart post and edit nothing");

  // --- the question's text changes: the same message is edited
  await setJob(a, { question: "Postgres, SQLite or both?" });
  mark = calls.length;
  await pass();
  assert.deepEqual(
    since(mark).map((c) => [c.method, c.params.ts]),
    [["chat.update", row!.ts]],
    "a changed question edits its message",
  );

  // --- resolved: the same message turns into its resolution
  await setJob(a, { stage: "implementing", stage_at: new Date(), answered_at: new Date(), question: null });
  mark = calls.length;
  await pass();
  const updates = since(mark, "chat.update");
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.params.ts, row!.ts, "the question's own message");
  assert.equal(updates[0]!.params.channel, "DU0OWNER");
  assert.match(updates[0]!.params.text!, /✅ Answered/);
  assert.equal(since(mark, "chat.postMessage").length, 0, "no new message for the answer");
  [row] = await rowsFor(a);
  assert.equal(row!.state, "resolved");
  assert.equal(row!.resolution, "✅ Answered");
  mark = calls.length;
  await pass();
  assert.equal(since(mark).length, 0, "a resolved message is left alone");

  // --- a second question on the same job is a new message
  await setJob(a, { stage: "waiting", stage_at: new Date(Date.now() + 1000), question: "One more thing?" });
  mark = calls.length;
  await pass();
  assert.equal(since(mark, "chat.postMessage").length, 1, "a new question, a new message");
  assert.equal((await rowsFor(a)).length, 2);

  // --- per-event toggles
  await writeConfig({ events: { failures: false } });
  const b = await track("B", { stage: "failed", stage_at: new Date(), stage_summary: "Tests failed." });
  mark = calls.length;
  await pass();
  assert.equal(since(mark, "chat.postMessage").length, 0, "failures are off");
  assert.equal((await rowsFor(b)).length, 0);
  await writeConfig({});
  await pass();
  assert.equal(since(mark, "chat.postMessage").length, 1, "and posted once they are on");
  await db.update(jobs).set({ dismissed_at: new Date(Date.now() + 60_000) }).where(eq(jobs.id, b as JobRow["id"]));
  mark = calls.length;
  await pass();
  assert.match(since(mark, "chat.update")[0]!.params.text!, /Dismissed/, "a dismissed failure says so");

  // --- quiet hours hold back all but the urgent kinds
  const hour = (offset: number) => new Date(Date.now() + offset * 3_600_000).toISOString().slice(11, 16);
  await writeConfig({ quietHours: { start: hour(-1), end: hour(1), timeZone: "UTC" } });
  const c = await track("C", { stage: "waiting", stage_at: new Date(), question: "Night question?" });
  const merged = { sha: "d0d0d0d", method: "squash" as const, at: new Date().toISOString(), base: "main", title: "t", commits: 1, via: "auto" as const };
  const d = await track("D", {
    stage: "merged",
    stage_at: new Date(),
    pr_url: "https://github.com/o/r/pull/9",
    merge_decision: decision({ outcome: "merge", merged, watch: { state: "revert_failed", until: new Date().toISOString(), failed: ["ci"], revertPr: null, reason: "conflict" } }),
  });
  mark = calls.length;
  result = await pass();
  assert.equal((await rowsFor(c)).length, 0, "a question waits out quiet hours");
  assert.ok(result.held >= 1);
  const dRows = await rowsFor(d);
  assert.deepEqual(dRows.map((r) => r.kind), ["revert_failed"], "a failed revert goes out at night; the merge update waits");
  await writeConfig({});
  mark = calls.length;
  await pass();
  assert.equal((await rowsFor(c)).length, 1, "the held question goes out when quiet hours end");
  assert.deepEqual((await rowsFor(d)).map((r) => r.kind).sort(), ["merged", "revert_failed"]);
  const mergedRow = (await rowsFor(d)).find((r) => r.kind === "merged")!;
  assert.equal(mergedRow.state, "resolved", "an update is resolved as it is posted");
  assert.match(since(mark, "chat.postMessage").find((p) => p.params.text!.includes(key("D")))!.params.text!, /✅ .* Merged into main as d0d0d0d/);

  // --- a handover the owner approves turns into a merge
  const e = await track("E", { stage: "pr", stage_at: new Date(), pr_url: "https://github.com/o/r/pull/10", merge_decision: decision({}) });
  await pass();
  const [handover] = await rowsFor(e);
  assert.equal(handover!.kind, "handover");
  await setJob(e, { stage: "merged", stage_at: new Date(), merge_decision: decision({ merged: { ...merged, sha: "e1e1e1e", via: "inbox" } }) });
  mark = calls.length;
  await pass();
  assert.deepEqual(since(mark).map((c) => c.method), ["chat.update"], "an approved merge edits the handover and posts nothing new");
  assert.match(since(mark)[0]!.params.text!, /✅ Merged by the factory/);

  // --- a revert the factory did is an update
  await setJob(d, { merge_decision: decision({ outcome: "merge", merged, watch: { state: "reverted", until: new Date().toISOString(), failed: ["ci"], revertPr: "https://github.com/o/r/pull/11", reason: null } }) });
  mark = calls.length;
  await pass();
  assert.match(since(mark, "chat.postMessage")[0]!.params.text!, /↩️ .*so the factory reverted it/);
  assert.match(since(mark, "chat.update")[0]!.params.text!, /Resolved/, "the failed revert's message resolves");

  // --- an old event is in the panel, not Slack
  const old = new Date(Date.now() - NOTIFY_WINDOW_MS - 60_000);
  const f = await track("F", { stage: "waiting", stage_at: old, question: "Old?" });
  await pass();
  assert.equal((await rowsFor(f)).length, 0);

  // --- a channel target
  await writeConfig({ target: "channel", channelId: "C0FACTORY" });
  await track("G", { stage: "waiting", stage_at: new Date(), question: "Channel?" });
  mark = calls.length;
  await pass();
  assert.equal(since(mark, "chat.postMessage")[0]!.params.channel, "C0FACTORY");

  // --- a channel Slack refuses stops the pass's posts, and the event is tried again later
  await writeConfig({ target: "channel", channelId: "C0GONE00" });
  const h = await track("H", { stage: "waiting", stage_at: new Date(), question: "Gone?" });
  await track("H2", { stage: "waiting", stage_at: new Date(), question: "Gone too?" });
  mark = calls.length;
  result = await pass();
  assert.equal(since(mark, "chat.postMessage").length, 1, "one refused post ends the pass's posting");
  assert.match(result.errors!.join("\n"), /channel_not_found/);
  assert.equal((await rowsFor(h)).length, 0, "a failed post leaves no row behind");
  await writeConfig({ target: "off" });
  mark = calls.length;
  result = await pass();
  assert.equal(since(mark, "chat.postMessage").length, 0, "off posts nothing");
  assert.equal(result.errors, undefined, "and is not an error");
  await writeConfig({});
  await pass();

  // --- Retry-After: a short one is waited out, one call at a time
  const i = await track("I", { stage: "waiting", stage_at: new Date(), question: "Rate limited?" });
  forced.push({ method: "chat.postMessage", status: 429, headers: { "retry-after": "1" } });
  maxInFlight = 0;
  mark = calls.length;
  const started = Date.now();
  await pass();
  const tries = calls.slice(mark).filter((c) => c.method === "chat.postMessage");
  assert.equal(tries.length, 2, "the 429 and its retry");
  assert.ok(tries[1]!.at - tries[0]!.at >= 950, "the retry waited for Retry-After");
  assert.ok(Date.now() - started >= 950);
  assert.equal(maxInFlight, 1, "one call at a time");
  assert.equal((await rowsFor(i))[0]!.state, "open");

  // --- a long one pauses the client, and the event waits for a later pass
  const j = await track("J", { stage: "waiting", stage_at: new Date(), question: "Paused?" });
  forced.push({ method: "chat.postMessage", status: 429, headers: { "retry-after": "120" } });
  mark = calls.length;
  result = await pass();
  assert.ok(result.rateLimitedUntil && Date.parse(result.rateLimitedUntil) > Date.now() + 100_000, "the pass stops and says until when");
  assert.equal((await rowsFor(j)).length, 0, "no row is left posting");
  mark = calls.length;
  await pass();
  assert.equal(calls.length, mark, "while paused nothing reaches Slack");
  slack = fresh();
  await pass();
  assert.equal((await rowsFor(j))[0]!.state, "open", "posted once the pause is over");

  // --- a row a dead runner left posting is posted again
  const k = await track("K", { stage: "waiting", stage_at: new Date(), question: "Crashed?" });
  const kEvent = notifyEvents([(await db.select().from(jobs).where(eq(jobs.id, k as JobRow["id"])))[0]!])[0]!;
  const stale = new Date(Date.now() - POSTING_STALE_MS - 1000);
  await db.insert(slackMessages).values({ id: kEvent.id, job_id: kEvent.job.id, kind: kEvent.kind, state: "posting", created_at: stale, updated_at: stale });
  await pass();
  assert.equal((await rowsFor(k))[0]!.state, "open");

  // --- a save that fails after Slack took the post keeps the row, so the event is never posted twice
  const realUpdate = db.update.bind(db);
  let failSaves = 0;
  db.update = ((table: Parameters<typeof db.update>[0]) => {
    const builder = realUpdate(table);
    if (table !== slackMessages) return builder;
    const set = builder.set.bind(builder);
    builder.set = ((values: Record<string, unknown>) => {
      if (failSaves > 0 && "ts" in values) {
        failSaves--;
        throw new Error("connection reset");
      }
      return set(values as never);
    }) as typeof builder.set;
    return builder;
  }) as typeof db.update;
  try {
    const m = await track("M", { stage: "waiting", stage_at: new Date(), question: "Saved once?" });
    failSaves = 1;
    mark = calls.length;
    result = await pass();
    assert.equal(failSaves, 0, "the first save failed");
    assert.equal(since(mark, "chat.postMessage").length, 1);
    assert.equal(result.errors, undefined, "the retry saved it");
    assert.equal((await rowsFor(m))[0]!.state, "open");

    const n = await track("N", { stage: "waiting", stage_at: new Date(), question: "Never saved?" });
    failSaves = 3;
    mark = calls.length;
    result = await pass();
    assert.equal(since(mark, "chat.postMessage").length, 1);
    assert.match(result.errors!.join("\n"), /save .*connection reset/);
    assert.equal((await rowsFor(n))[0]!.state, "posting", "the row stays rather than being deleted for a repost");
    mark = calls.length;
    await pass();
    assert.equal(since(mark, "chat.postMessage").length, 0, "a later pass does not post it again");
  } finally {
    db.update = realUpdate;
  }

  // --- secrets never reach Slack
  await track("L", { title: `Leak ${TOKEN}`, stage: "failed", stage_at: new Date(), stage_summary: `Failed with SLACK_SIGNING_SECRET=${SIGNING} and xoxb-another-leaked-token-999` });
  await pass();
  for (const call of calls) {
    const body = JSON.stringify(call.params);
    assert.ok(!body.includes(TOKEN) && !body.includes(SIGNING) && !body.includes("xoxb-another"), `${call.method} carries no secret`);
  }

  // --- the test message, from Settings to the runner
  const user = async () => ({ email: OWNER, emailVerified: true });
  const deps = { db, user, slackConfigured: async () => true };
  assert.equal((await requestSlackTest({ ...deps, user: async () => ({ email: "x@example.com", emailVerified: true }) }, randomUUID())).ok, false, "owner only");
  assert.match(JSON.stringify(await requestSlackTest({ ...deps, slackConfigured: async () => false }, randomUUID())), /No online runner has a Slack token/);
  const requested = await requestSlackTest(deps, randomUUID());
  assert.ok(requested.ok);
  const [intent] = await db.select().from(intents).where(eq(intents.id, requested.intentId));
  assert.equal(intent!.kind, "slack_test");
  assert.deepEqual(await slackTestOutcome(deps, requested.intentId), { status: "pending" });
  mark = calls.length;
  const sent = await sendSlackTest(JSON.parse(intent!.detail!), slack);
  assert.deepEqual(sent, { sent: { to: "owner", channel: "DU0OWNER" } });
  assert.match(calls.at(-1)!.params.text!, /Test from the marshal factory, sent by owner@example.com/);
  await db.update(intents).set({ result: JSON.stringify({ error: "a failed try" }) }).where(eq(intents.id, requested.intentId));
  assert.deepEqual(await slackTestOutcome(deps, requested.intentId), { status: "pending" }, "an error on an open intent is not final");
  await db.update(intents).set({ handled_at: new Date(), result: JSON.stringify({ error: "channel_not_found" }) }).where(eq(intents.id, requested.intentId));
  assert.deepEqual(await slackTestOutcome(deps, requested.intentId), { status: "failed", message: "The runner could not send it: channel_not_found" }, "and is once it is closed");
  await db.update(intents).set({ handled_at: new Date(), result: JSON.stringify(sent) }).where(eq(intents.id, requested.intentId));
  assert.deepEqual(await slackTestOutcome(deps, requested.intentId), { status: "done", message: "Sent to your Slack DMs." });
  await writeConfig({ target: "channel", channelId: "C0FACTORY" });
  assert.deepEqual(await sendSlackTest({ actor: OWNER }, slack), { sent: { to: "channel", channel: "C0FACTORY" } });
  await writeConfig({ target: "channel", channelId: "C0GONE00" });
  await assert.rejects(sendSlackTest({ actor: OWNER }, slack), /channel_not_found/, "Slack's refusal is the intent's error");

  // --- saving the settings: only the channel id's shape is checked, without asking Slack
  assert.equal((await saveNotifications({ ...deps, user: async () => null }, {})).ok, false, "owner only");
  mark = calls.length;
  assert.equal((await saveNotifications(deps, { target: "channel", channelId: "general" })).ok, false, "a channel name is refused");
  assert.deepEqual(await saveNotifications(deps, { target: "channel", channelId: "C0FACTORY", events: { merges: false } }), { ok: true });
  assert.equal(calls.length, mark, "saving never calls Slack");
  const saved = await db.select().from(notificationSettings);
  assert.equal(saved[0]!.config.channelId, "C0FACTORY");
  assert.equal(saved[0]!.config.events.merges, false);
  assert.equal(saved[0]!.updated_by, OWNER);
  assert.equal((await saveNotifications(deps, { quietHours: { start: "25:00", end: "07:00", timeZone: "UTC" } })).ok, false);

  console.log("slack regressions passed");
} finally {
  if (created.length > 0) {
    await db.delete(slackMessages).where(inArray(slackMessages.job_id, created as JobRow["id"][]));
    await db.delete(jobs).where(inArray(jobs.id, created as JobRow["id"][]));
  }
  await db.delete(runs).where(like(runs.job_key, `${prefix}-%`));
  await db.delete(intents).where(like(intents.id, "panel:slack_test:%"));
  await db.delete(notificationSettings);
  await server.close();
}
process.exit(0);
