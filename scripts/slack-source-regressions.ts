import "./test-guard";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { FileDraft } from "../lib/sources/types";

// Filing jobs from Slack: signed requests straight into the commands and interactivity handlers, a
// fake Slack Web API and response_url on localhost, and the panel's own createJob behind them with
// a fake source that files one issue per request id, as Linear does.

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;
const TOKEN = "xoxb-regression-token-0123456789";
const SIGNING = "regression-signing-secret-abcdef";
const OWNER_SLACK = "U0OWNER";

const { db } = await import("../db/client");
const { postResponse, slackClient } = await import("../lib/slack-api");
const { handleInteraction, MAX_SKEW_SECONDS, NOT_OWNER, ownerFromAllowlist } = await import("../lib/slack-interactions");
const { handleCommand, LOADING, NEW_JOB_BLOCKS, NEW_JOB_CALLBACK_ID, newJobRequestId, SETTINGS_DEFAULT, USAGE } = await import("../lib/slack-new-job");
const { HARNESS_GROUP, RUNS_ON_GROUP } = await import("../lib/ticket-overrides");
const { REPOSITORY_GROUP } = await import("../lib/repositories");
const { serve } = await import("./serve");

// --- the fake Slack: Web API calls under /api/, response_url posts under /response/
type Call = { method: string; params: Record<string, string> };
const calls: Call[] = [];
/** Slack calls and the reads of repositories and harnesses, in the order they happened. */
const timeline: string[] = [];
const responses: { path: string; body: { text?: string; response_type?: string } }[] = [];
let threadFails = false;
let permalinkDelayMs = 0;
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
  switch (method) {
    case "views.open":
      return Response.json({ ok: true, view: { id: `V${calls.length}`, hash: `hash-${calls.length}` } });
    case "views.update":
      return Response.json({ ok: true, view: { id: params.view_id, hash: `hash-${calls.length}` } });
    case "chat.getPermalink":
      await new Promise((resolve) => setTimeout(resolve, permalinkDelayMs));
      return Response.json({ ok: true, permalink: `https://acme.slack.com/archives/${params.channel}/p${params.message_ts!.replace(".", "")}` });
    case "chat.postMessage":
      if (threadFails && params.thread_ts) return Response.json({ ok: false, error: "not_in_channel" });
      return Response.json({ ok: true, channel: params.channel, ts: "9.0001" });
    case "conversations.open":
      return Response.json({ ok: true, channel: { id: "DOWNER" } });
    default:
      return Response.json({ ok: true });
  }
});
const base = `http://localhost:${server.port}`;

// --- the panel's createJob with a fake source: one issue per request id, as Linear's issue id
const issues = new Map<string, FileDraft & { key: string }>();
let filings = 0;
const tasks: Promise<void>[] = [];
const drain = async () => {
  while (tasks.length > 0) await Promise.all(tasks.splice(0));
};
const owner = async () => ownerFromAllowlist();
const registry = [
  { repo: "acme/shop", display_name: "Shop", enabled: true, is_default: true },
  { repo: "acme/api", display_name: null, enabled: true, is_default: false },
  { repo: "acme/old", display_name: null, enabled: false, is_default: false },
];
const harnesses = [
  { id: "claude-1", name: "Claude Code", enabled: true },
  { id: "codex-off", name: "Codex", enabled: false },
];
const deps = {
  signingSecret: SIGNING,
  ownerSlackId: OWNER_SLACK,
  slack: slackClient({ token: TOKEN, baseUrl: `${base}/api/`, minGapMs: 0 }),
  respond: postResponse,
  inbox: {
    db,
    user: owner,
    reply: async () => undefined,
    newJob: {
      user: owner,
      file: async (draft: FileDraft) => {
        filings++;
        const issue = issues.get(draft.requestId) ?? { ...draft, key: `FAC-${700 + issues.size}` };
        issues.set(draft.requestId, issue);
        return { key: issue.key, url: `https://linear.app/x/issue/${issue.key}` };
      },
      harnesses: async () => (timeline.push("harnesses"), harnesses),
      registry: async () => (timeline.push("registry"), registry),
    },
  },
  panelUrl: "https://panel.test",
  secrets: [TOKEN, SIGNING],
  after: (task: () => Promise<void>) => void tasks.push(task()),
} as unknown as Parameters<typeof handleInteraction>[1];

const sign = (body: string, ts = Math.floor(Date.now() / 1000), secret = SIGNING) => ({
  "x-slack-request-timestamp": String(ts),
  "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`,
});
let urls = 0;
const command = (text: string, user = OWNER_SLACK, headers?: (body: string) => Record<string, string>) => {
  const response_url = `${base}/response/${++urls}`;
  const body = new URLSearchParams({ command: "/factory", text, user_id: user, channel_id: "C0GENERAL", trigger_id: `trigger-${urls}`, response_url }).toString();
  const sent = handleCommand(
    new Request("http://localhost/api/slack/commands", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(headers ?? sign)(body) }, body }),
    deps,
  );
  return { response_url, trigger: `trigger-${urls}`, sent };
};
const interact = (payload: object) => {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  return handleInteraction(new Request("http://localhost/api/slack/interactions", { method: "POST", headers: sign(body), body }), deps);
};
const shortcut = (message: { ts: string; text: string; thread_ts?: string }, user = OWNER_SLACK) => {
  const response_url = `${base}/response/${++urls}`;
  const sent = interact({
    type: "message_action",
    callback_id: "send_to_factory",
    user: { id: user },
    trigger_id: `trigger-${urls}`,
    response_url,
    channel: { id: "C0GENERAL" },
    message,
  });
  return { response_url, trigger: `trigger-${urls}`, sent };
};

type Option = { value: string; text: { text: string } };
type Block = { type: string; block_id?: string; optional?: boolean; element?: { initial_value?: string; options?: Option[]; initial_option?: Option } };
type View = { callback_id: string; private_metadata: string; blocks: Block[] };
/** The form the request's loading view was filled in with. */
const lastView = (trigger: string) => {
  const open = calls.findLast((c) => c.method === "views.open");
  assert.equal(open?.params.trigger_id, trigger, "the request's trigger opens the modal");
  const id = `V${calls.indexOf(open!) + 1}`;
  const update = calls.findLast((c) => c.method === "views.update" && c.params.view_id === id);
  assert.ok(update, "the opened view is filled in");
  assert.equal(update.params.hash, `hash-${calls.indexOf(open!) + 1}`, "with the hash views.open returned");
  return JSON.parse(update.params.view!) as View;
};
/** What a request did before its ack: the loading view, and nothing read before it. */
const openedFirst = (from: number) => {
  assert.equal(timeline[from], "views.open", `the loading view opens first, not after ${timeline.slice(from).join(", ")}`);
  const loading = JSON.parse(calls.findLast((c) => c.method === "views.open")!.params.view!) as { submit?: unknown; callback_id: string };
  assert.match(JSON.stringify(loading), new RegExp(LOADING));
  assert.equal(loading.submit, undefined, "with nothing to submit");
  assert.equal(loading.callback_id, NEW_JOB_CALLBACK_ID);
};
const block = (view: View, id: string) => view.blocks.find((b) => b.block_id === id);
const repliesTo = (url: string) => responses.filter((r) => url.endsWith(r.path)).map((r) => r.body.text ?? "");
const opens = () => calls.filter((c) => c.method === "views.open").length;

type Values = { title: string; description?: string; repo?: string; harness?: string; runsOn?: string };
const submit = (viewId: string, view: View, values: Values, user = OWNER_SLACK) => {
  const select = (value: string | undefined) => ({ type: "static_select", selected_option: value ? { value } : null });
  return interact({
    type: "view_submission",
    user: { id: user },
    view: {
      id: viewId,
      callback_id: view.callback_id,
      private_metadata: view.private_metadata,
      state: {
        values: {
          [NEW_JOB_BLOCKS.title]: { value: { type: "plain_text_input", value: values.title } },
          [NEW_JOB_BLOCKS.description]: { value: { type: "plain_text_input", value: values.description ?? null } },
          [NEW_JOB_BLOCKS.repo]: { value: select(values.repo) },
          [NEW_JOB_BLOCKS.harness]: { value: select(values.harness ?? SETTINGS_DEFAULT) },
          [NEW_JOB_BLOCKS.runsOn]: { value: select(values.runsOn ?? SETTINGS_DEFAULT) },
        },
      },
    },
  });
};

try {
  // --- the commands route checks the signature first, like the interactivity route
  assert.equal((await command("", OWNER_SLACK, () => ({})).sent).status, 401, "no signature");
  assert.equal((await command("", OWNER_SLACK, (b) => sign(b, undefined, "wrong-secret")).sent).status, 401, "a wrong secret");
  assert.equal((await command("", OWNER_SLACK, (b) => sign(b, Math.floor(Date.now() / 1000) - MAX_SKEW_SECONDS - 5)).sent).status, 401, "a replay older than five minutes");
  const body = new URLSearchParams({ command: "/factory", text: "", user_id: OWNER_SLACK, trigger_id: "t", response_url: `${base}/response/x` }).toString();
  assert.equal((await handleCommand(new Request("http://localhost/", { method: "POST", headers: sign(body), body }), { ...deps, signingSecret: undefined })).status, 401, "no signing secret");
  await drain();
  assert.equal(opens(), 0, "nothing opened for a bad signature");

  // --- only the owner, with an ephemeral refusal
  const stranger = await command("Fix it", "U0STRANGER").sent;
  assert.equal(stranger.status, 200);
  assert.deepEqual(await stranger.json(), { response_type: "ephemeral", replace_original: false, text: NOT_OWNER });
  await drain();
  assert.equal(opens(), 0, "a stranger gets no modal");

  // --- /factory help answers at once
  const help = await command("help").sent;
  assert.equal(((await help.json()) as { text: string }).text, USAGE);
  assert.match(USAGE, /Send to factory/);
  await drain();
  assert.equal(opens(), 0);

  // --- /factory opens the empty modal, the panel's defaults preselected
  const emptyFrom = timeline.length;
  const empty = command("");
  const emptyAck = await empty.sent;
  assert.equal(emptyAck.status, 200);
  assert.equal(await emptyAck.text(), "", "acked with nothing to show");
  openedFirst(emptyFrom);
  await drain();
  assert.ok(timeline.indexOf("registry", emptyFrom) > emptyFrom && timeline.indexOf("views.update", emptyFrom) > timeline.indexOf("registry", emptyFrom), "repositories read after the open, the form after them");
  const blankView = lastView(empty.trigger);
  assert.equal(blankView.callback_id, NEW_JOB_CALLBACK_ID);
  assert.equal(block(blankView, NEW_JOB_BLOCKS.title)!.element!.initial_value, undefined);
  assert.equal(block(blankView, NEW_JOB_BLOCKS.description)!.optional, true, "a description is optional, as in the panel");
  const repo = block(blankView, NEW_JOB_BLOCKS.repo)!.element!;
  assert.deepEqual(repo.options!.map((o) => o.value), ["acme/shop", "acme/api"], "the enabled repositories");
  assert.equal(repo.initial_option?.value, "acme/shop", "the default repository first");
  const harness = block(blankView, NEW_JOB_BLOCKS.harness)!.element!;
  assert.deepEqual(harness.options!.map((o) => o.value), [SETTINGS_DEFAULT, "claude-1"], "Settings default and the enabled harnesses");
  assert.equal(harness.initial_option?.value, SETTINGS_DEFAULT);
  const runsOn = block(blankView, NEW_JOB_BLOCKS.runsOn)!.element!;
  assert.deepEqual(runsOn.options!.map((o) => o.text.text), ["Settings default", "Local", "Cloud", "Upstash"]);
  assert.equal(runsOn.initial_option?.value, SETTINGS_DEFAULT);
  assert.ok(!JSON.stringify(blankView).includes("tracking-") && !/"[A-Z ]{6,}"/.test(JSON.stringify(blankView)), "plain sentence-case labels");

  // --- /factory <text> prefills the title and description
  const prefilled = command("Fix the &lt;Checkout&gt; button\nIt does nothing on Safari.");
  await prefilled.sent;
  await drain();
  const textView = lastView(prefilled.trigger);
  assert.equal(block(textView, NEW_JOB_BLOCKS.title)!.element!.initial_value, "Fix the <Checkout> button");
  assert.equal(block(textView, NEW_JOB_BLOCKS.description)!.element!.initial_value, "Fix the <Checkout> button\nIt does nothing on Safari.");
  const oneLine = command("Bump the node version");
  await oneLine.sent;
  await drain();
  const oneLineView = lastView(oneLine.trigger);
  assert.equal(block(oneLineView, NEW_JOB_BLOCKS.title)!.element!.initial_value, "Bump the node version");
  assert.equal(block(oneLineView, NEW_JOB_BLOCKS.description)!.element!.initial_value, undefined, "a one-line text is the title only");
  const raw = command("Wrap it in a <div>\nOnly when a < b && c > d.");
  await raw.sent;
  await drain();
  const rawView = lastView(raw.trigger);
  assert.equal(block(rawView, NEW_JOB_BLOCKS.title)!.element!.initial_value, "Wrap it in a <div>", "the command's text is not read as Slack markup");
  assert.equal(block(rawView, NEW_JOB_BLOCKS.description)!.element!.initial_value, "Wrap it in a <div>\nOnly when a < b && c > d.");

  // --- the shortcut: a stranger is refused, the owner gets the message and a link back to it
  const opened = opens();
  const strangerShortcut = shortcut({ ts: "1700000000.000100", text: "Do a thing" }, "U0STRANGER");
  assert.equal((await strangerShortcut.sent).status, 200);
  await drain();
  assert.deepEqual(repliesTo(strangerShortcut.response_url), [NOT_OWNER]);
  assert.equal(opens(), opened, "no modal for a stranger's shortcut");

  const sharedFrom = timeline.length;
  const shared = shortcut({ ts: "1700000000.000200", thread_ts: "1700000000.000100", text: "Cart total is wrong &amp; <https://shop.test/cart|the cart page> shows NaN\nSteps: add two items." });
  await shared.sent;
  openedFirst(sharedFrom);
  await drain();
  assert.ok(timeline.indexOf("chat.getPermalink", sharedFrom) > sharedFrom, "the permalink is asked for after the open");
  const permalinkCall = calls.filter((c) => c.method === "chat.getPermalink").at(-1)!;
  assert.deepEqual([permalinkCall.params.channel, permalinkCall.params.message_ts], ["C0GENERAL", "1700000000.000200"]);
  const sharedView = lastView(shared.trigger);
  assert.equal(block(sharedView, NEW_JOB_BLOCKS.title)!.element!.initial_value, "Cart total is wrong & the cart page (https://shop.test/cart) shows NaN");
  const description = block(sharedView, NEW_JOB_BLOCKS.description)!.element!.initial_value!;
  assert.match(description, /^Cart total is wrong & the cart page \(https:\/\/shop\.test\/cart\) shows NaN\nSteps: add two items\./);
  assert.match(description, /From Slack: https:\/\/acme\.slack\.com\/archives\/C0GENERAL\/p1700000000000200$/, "with the permalink");

  // --- a slow permalink doesn't hold the modal past its trigger: it opens at once, and fills in without the link
  permalinkDelayMs = 2_500;
  const slowFrom = timeline.length;
  const slow = shortcut({ ts: "1700000000.000400", text: "Slow permalink" });
  const slowStarted = Date.now();
  await slow.sent;
  const ackMs = Date.now() - slowStarted;
  openedFirst(slowFrom);
  assert.ok(ackMs < 500, `the modal opened and the shortcut was acked after ${ackMs} ms`);
  await drain();
  const slowMs = Date.now() - slowStarted;
  permalinkDelayMs = 0;
  assert.ok(slowMs < 2_000, `the form filled in after ${slowMs} ms`);
  const slowView = lastView(slow.trigger);
  assert.equal(block(slowView, NEW_JOB_BLOCKS.description)!.element!.initial_value, "Slow permalink", "no permalink line");

  // --- an invalid form is refused inline; nothing is filed
  const tooShort = await submit("V0SHORT", sharedView, { title: "ab" });
  assert.deepEqual(await tooShort.json(), { response_action: "errors", errors: { [NEW_JOB_BLOCKS.title]: "Give the job a title of at least 3 characters." } });
  const strangerSubmit = await submit("V0SHORT", sharedView, { title: "A fine title" }, "U0STRANGER");
  assert.deepEqual(await strangerSubmit.json(), { response_action: "errors", errors: { [NEW_JOB_BLOCKS.title]: NOT_OWNER } });
  await drain();
  assert.equal(filings, 0, "nothing filed for a refused form");

  // --- a valid submission files one job through the panel's createJob, a retry the same one
  const values = { title: "Cart total is wrong", description, repo: "acme/api", harness: "claude-1", runsOn: "modal" };
  const accepted = await submit("V0SHARED", sharedView, values);
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), "", "an empty ack closes the modal");
  await drain();
  await submit("V0SHARED", sharedView, values);
  await drain();
  assert.equal(issues.size, 1, "a retried submission is still one job");
  assert.equal(filings, 2, "both reached the source, under one request id");
  const [[requestId, issue]] = [...issues.entries()];
  assert.equal(requestId, newJobRequestId("V0SHARED"), "the request id comes from the view");
  assert.equal(issue!.title, "Cart total is wrong");
  assert.equal(issue!.description, description);
  assert.deepEqual(
    issue!.labels,
    [
      { group: REPOSITORY_GROUP, name: "api" },
      { group: HARNESS_GROUP, name: "Claude Code" },
      { group: RUNS_ON_GROUP, name: "Cloud" },
    ],
    "the panel's override labels",
  );
  const [confirmation] = repliesTo(shared.response_url);
  assert.match(confirmation!, /Filed \*FAC-700\* · Cart total is wrong/);
  assert.match(confirmation!, /<https:\/\/linear\.app\/x\/issue\/FAC-700\|Open the issue> · <https:\/\/panel\.test\/\|Open the board>/);
  assert.equal(responses.find((r) => shared.response_url.endsWith(r.path))!.body.response_type, "ephemeral");
  const threadReplies = calls.filter((c) => c.method === "chat.postMessage" && c.params.thread_ts);
  assert.ok(threadReplies.length >= 1);
  assert.deepEqual([threadReplies[0]!.params.channel, threadReplies[0]!.params.thread_ts], ["C0GENERAL", "1700000000.000100"], "answered in the message's thread");
  assert.match(threadReplies[0]!.params.blocks!, /Filed as <https:\/\/linear\.app\/x\/issue\/FAC-700\|FAC-700>/);

  // --- Settings default adds no override label; a command's job gets no thread reply
  const threadsBefore = calls.filter((c) => c.method === "chat.postMessage").length;
  await submit("V0BLANK", blankView, { title: "Bump the node version", repo: "acme/shop" });
  await drain();
  const plainIssue = issues.get(newJobRequestId("V0BLANK"))!;
  assert.deepEqual(plainIssue.labels, [{ group: REPOSITORY_GROUP, name: "Shop" }], "only the Repository label, as the panel files it");
  assert.match(repliesTo(empty.response_url)[0]!, /Filed \*FAC-701\*/);
  assert.equal(calls.filter((c) => c.method === "chat.postMessage").length, threadsBefore, "no thread to answer in");

  // --- a thread the bot can't post in doesn't fail the filing
  threadFails = true;
  const privateMsg = shortcut({ ts: "1700000000.000300", text: "Private channel request" });
  await privateMsg.sent;
  await drain();
  await submit("V0PRIVATE", lastView(privateMsg.trigger), { title: "Private channel request" });
  await drain();
  threadFails = false;
  assert.ok(issues.has(newJobRequestId("V0PRIVATE")), "filed");
  assert.match(repliesTo(privateMsg.response_url)[0]!, /Filed \*FAC-702\*/, "and confirmed");
  assert.equal(calls.filter((c) => c.method === "chat.postMessage" && c.params.thread_ts === "1700000000.000300").length, 1, "the thread reply was tried once");

  // --- a refusal from createJob is told, not thrown
  const disabled = command("Old repo work");
  await disabled.sent;
  await drain();
  await submit("V0OLD", lastView(disabled.trigger), { title: "Old repo work", repo: "acme/old" });
  await drain();
  assert.deepEqual(repliesTo(disabled.response_url), ["acme/old is not an enabled repository."]);
  assert.ok(!issues.has(newJobRequestId("V0OLD")));

  assert.ok(!JSON.stringify(responses).includes(TOKEN) && !JSON.stringify(calls).includes(SIGNING), "no secret reaches Slack");
  console.log("slack source regressions passed");
} finally {
  await server.close();
}
process.exit(0);
