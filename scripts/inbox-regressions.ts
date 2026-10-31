import "./test-guard";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import type { JobRow } from "../db/schema";
import type { AssessmentInput } from "../lib/assessment";
import type { Harness } from "../lib/harness";
import type { MergeDecision } from "../lib/merge-decision";
import type { FileDraft } from "../lib/sources/types";

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;
const SECRET = "inbox-webhook-secret";
process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;

const { db } = await import("../db/client");
const { auditLog, events, intents, jobs, repoSettings, webhookDeliveries } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { SOURCES } = await import("../lib/sources");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { eventSchema } = await import("../lib/events");
const { ingest } = await import("../lib/ingest");
const { hosts, localHost } = await import("../lib/host");
const { github, pullsClient } = await import("../lib/github/pulls");
const { writeRepoAutonomy } = await import("../lib/settings");
const { allows, approveDetailSchema, changesMessage, feedbackDetailSchema, followUpHint, followUpIssue, inboxItems, inboxKind, isDismissed } = await import("../lib/inbox");
const { approvalBlockers, reviewSummary } = await import("../lib/merge-decision");
const { githubIntent } = await import("../lib/webhooks");
const inbox = await import("../lib/inbox-actions");
const { approveMerge } = await import("../runner/merge-decision");
const { closeJob, forwardReview, REVIEW_WAIT_MS, requestChanges } = await import("../runner/inbox");
const { ingestClient, threads } = await import("../runner/ops");
const { INTENT_ROUTES } = await import("../runner/intents");
const { serve } = await import("./serve");

// --- the inbox's rules, pure
const T = (minutes: number) => new Date(1_800_000_000_000 + minutes * 60_000);
const decision = (over: Partial<MergeDecision>): MergeDecision => ({
  outcome: "handover",
  reasons: [],
  autonomy: "auto",
  evaluatedAt: T(0).toISOString(),
  headSha: "h",
  headSeenAt: null,
  stageEventId: null,
  ...over,
});
const fake = (key: string, over: Partial<JobRow>) =>
  ({ key, stage: "implementing", stage_at: T(0), updated_at: T(0), pr_url: null, merge_decision: null, dismissed_at: null, question: null, stage_summary: null, ...over }) as JobRow;
const merged = { sha: "m", method: "squash" as const, at: T(0).toISOString(), base: "main", title: "t", commits: 1 };
const watch = (state: "watching" | "green" | "revert_failed") => ({ state, until: T(60).toISOString(), failed: ["ci"], revertPr: null, reason: state === "revert_failed" ? "git revert failed" : null });
const pool = [
  fake("Q-OLD", { stage: "waiting", stage_at: T(1), question: "Which one?" }),
  fake("Q-NEW", { stage: "waiting", stage_at: T(9) }),
  fake("REVERT", { stage: "merged", stage_at: T(5), merge_decision: decision({ merged, watch: watch("revert_failed") }) }),
  fake("GREEN", { stage: "merged", stage_at: T(6), merge_decision: decision({ merged, watch: watch("green") }) }),
  fake("OFF", { stage: "pr", stage_at: T(3), pr_url: "https://github.com/o/r/pull/1", merge_decision: decision({ autonomy: "off" }) }),
  fake("UNDECIDED", { stage: "pr", stage_at: T(4), pr_url: "https://github.com/o/r/pull/2" }),
  fake("HANDOVER", { stage: "pr", stage_at: T(2), pr_url: "https://github.com/o/r/pull/3", merge_decision: decision({ reasons: ["A check failed."] }) }),
  fake("TRIAL", { stage: "pr", stage_at: T(1), pr_url: "https://github.com/o/r/pull/4", merge_decision: decision({ outcome: "merge", autonomy: "trial" }) }),
  fake("PENDING", { stage: "pr", stage_at: T(8), pr_url: "https://github.com/o/r/pull/5", merge_decision: decision({ outcome: "pending" }) }),
  fake("AUTO", { stage: "pr", stage_at: T(8), pr_url: "https://github.com/o/r/pull/6", merge_decision: decision({ outcome: "merge" }) }),
  fake("MERGING", { stage: "pr", stage_at: T(8), pr_url: "https://github.com/o/r/pull/7", merge_decision: decision({ merging: { headSha: "h", method: "squash", at: T(8).toISOString() } }) }),
  fake("NOPR", { stage: "pr", stage_at: T(8) }),
  fake("FAILED", { stage: "failed", stage_at: T(7) }),
  fake("FAILED-OLD", { stage: "failed", stage_at: T(2) }),
  fake("DISMISSED", { stage: "failed", stage_at: T(3), dismissed_at: T(4) }),
  fake("FAILED-AGAIN", { stage: "failed", stage_at: T(5), dismissed_at: T(4) }),
  fake("REVERT-DISMISSED", { stage: "merged", stage_at: T(5), dismissed_at: T(6), merge_decision: decision({ merged, watch: watch("revert_failed") }) }),
  fake("WORKING", { stage: "implementing", stage_at: T(9) }),
];
assert.deepEqual(
  inboxItems(pool).map((i) => `${i.kind}:${i.job.key}`),
  [
    "question:Q-NEW",
    "revert_failed:REVERT",
    "question:Q-OLD",
    "handover:UNDECIDED",
    "handover:OFF",
    "handover:HANDOVER",
    "handover:TRIAL",
    "failed:FAILED",
    "failed:FAILED-AGAIN",
    "failed:FAILED-OLD",
  ],
  "questions and failed reverts, then handovers, then failures; newest first within; the factory's own work stays out",
);
assert.equal(isDismissed(pool.find((j) => j.key === "DISMISSED")!), true);
assert.equal(isDismissed(pool.find((j) => j.key === "FAILED-AGAIN")!), false, "a failure after the dismissal shows again");
assert.ok(allows("handover", "approve") && allows("handover", "request_changes") && allows("handover", "close"));
assert.ok(allows("revert_failed", "follow_up") && allows("revert_failed", "dismiss") && !allows("revert_failed", "approve"));
assert.ok(!allows("revert_failed", "request_changes"), "the merged attempt's worktree is gone, so a failed revert takes a follow-up job instead");
assert.ok(!allows("handover", "follow_up") && !allows("failed", "follow_up"));
assert.ok(allows("failed", "dismiss") && allows("failed", "close") && !allows("failed", "request_changes"));
assert.ok(allows("failed", "retry") && !allows("handover", "retry") && !allows("stop_unconfirmed", "retry") && !allows(null, "retry"), "only a failed job offers Retry");
assert.ok(allows("question", "answer") && !allows("question", "approve") && !allows(null, "dismiss"));

assert.deepEqual(approvalBlockers({ checks: "success", mergeable: "mergeable" }), [], "green and clean: nothing blocks");
assert.deepEqual(approvalBlockers({ checks: "failure", mergeable: "conflicting" }), ["A check failed on the latest commit.", "The pull request conflicts with its base branch."]);
assert.deepEqual(approvalBlockers({ checks: "pending", mergeable: "unknown" }).length, 2, "running checks and unknown mergeability are facts too");
assert.deepEqual(approvalBlockers({ checks: "none", mergeable: "mergeable" }), [], "a repo without CI has no checks to wait for");
assert.deepEqual(
  reviewSummary({
    headSha: "h1",
    files: [{ path: "a.ts", additions: 3, deletions: 1 }],
    bugbot: { review: { state: "reviewed" }, findings: [{ severity: "high", resolved: false }, { severity: "low", resolved: false }, { severity: "medium", resolved: true }] },
  }),
  { headSha: "h1", files: [{ path: "a.ts", additions: 3, deletions: 1 }], fileCount: 1, bugbot: { state: "reviewed", high: 1, medium: 0, low: 1, resolved: 1 } },
  "the summary keeps counts, not patches",
);

// GitHub reviews: a person's request for changes or comments is forwarded, keyed by the review.
const review = (over: Record<string, unknown> = {}, user: { login: string; type: string } | null = { login: "jan", type: "User" }) => ({
  action: "submitted",
  review: { id: 77, state: "changes_requested", body: "Rename the helper.", user, ...over },
  pull_request: { html_url: "https://github.com/o/r/pull/1" },
});
const forwarded = githubIntent("pull_request_review", review());
assert.equal(forwarded?.kind, "request_changes");
assert.equal(forwarded?.key, "review:77", "keyed by the review, not the delivery");
assert.deepEqual(feedbackDetailSchema.parse(JSON.parse(forwarded!.detail!)), { from: "github", id: "review:77", reviewId: 77, reviewer: "jan", state: "changes_requested", body: "Rename the helper." });
assert.equal(githubIntent("pull_request_review", review({ state: "commented", body: null }))?.kind, "request_changes", "inline comments alone are forwarded");
assert.equal(githubIntent("pull_request_review", review({}, { login: "cursor[bot]", type: "Bot" })), null, "Bugbot is not a reviewer");
assert.equal(githubIntent("pull_request_review", review({}, { login: "marshal-factory-ski043[bot]", type: "Bot" })), null, "nor is the factory's App");
assert.equal(githubIntent("pull_request_review", review({ state: "approved" })), null, "an approval asks for nothing");
assert.equal(githubIntent("pull_request_review", { ...review(), action: "edited" }), null, "an edit is not a new review");
const onBranch = githubIntent("pull_request_review", { ...review(), pull_request: { html_url: "https://github.com/o/r/pull/1", head: { ref: "factory/FAC-5" } } });
const branchDetail = feedbackDetailSchema.parse(JSON.parse(onBranch!.detail!));
assert.equal(branchDetail.from === "github" ? branchDetail.branch : null, "factory/FAC-5", "the head branch finds a job that has not recorded its PR yet");

const followUp = followUpIssue(
  { key: "FAC-9", url: "https://linear.app/x/issue/FAC-9", pr_url: "https://github.com/o/r/pull/9" },
  decision({ merged, watch: watch("revert_failed") }),
  " Fix the flaky import. ",
);
assert.equal(followUp.title, "Fix main: revert of FAC-9 failed");
assert.match(followUp.description, /^Fix the flaky import\.\n\n---\n\nMain went red after the factory merged FAC-9 \(https:\/\/github\.com\/o\/r\/pull\/9\), and the automatic revert failed\./);
for (const fact of ["- Failed checks on main: ci", "- Merged pull request: https://github.com/o/r/pull/9", "- Why the revert failed: git revert failed", "- Original issue: https://linear.app/x/issue/FAC-9"]) {
  assert.ok(followUp.description.includes(fact), `the follow-up carries "${fact}"`);
}
assert.equal(followUpHint({ key: "FAC-9" }, decision({ merged, watch: watch("revert_failed") })), "Get main green again after FAC-9: ci failed.");

const framed = changesMessage({ prUrl: "https://github.com/o/r/pull/1", feedback: { from: "panel", id: "panel:1", actor: OWNER, body: "Use the existing hook." } });
assert.match(framed, /^The reviewer requested changes on https:\/\/github\.com\/o\/r\/pull\/1:\n\n> Use the existing hook\.\n\nUpdate the same branch and PR, then report the PR again with a fresh assessment\.$/);

// --- fake GitHub
type Pull = { repo: string; number: number; head: string; state: "open" | "closed"; merged: string | null; mergeable: boolean; behind: number; checks: string; files: { filename: string; additions: number; deletions: number; patch?: string }[]; merge: { status: number; body: unknown } };
const pulls = new Map<string, Pull>();
const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
const keyOf = (repo: string, n: number) => `${repo}#${n}`;
const server = await serve(0, async (request) => {
  const path = new URL(request.url).pathname;
  const body = request.method === "GET" ? {} : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
  if (request.method !== "GET") writes.push({ method: request.method, path, body });
  let m: RegExpExecArray | null;
  if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return Response.json({ permissions: { push: true } });
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)(\/files|\/merge|\/reviews\/\d+\/comments)?$/.exec(path))) {
    const p = pulls.get(keyOf(m[1]!, Number(m[2])));
    if (!p) return Response.json({ message: "Not Found" }, { status: 404 });
    if (m[3] === "/files") return Response.json(p.files);
    if (m[3]?.startsWith("/reviews")) return Response.json([{ path: "src/a.ts", line: 12, body: "This name is unclear." }]);
    if (m[3] === "/merge") {
      if (p.merge.status === 200) Object.assign(p, { state: "closed", merged: `merge-${p.number}` });
      return Response.json(p.merge.status === 200 ? { sha: `merge-${p.number}` } : p.merge.body, { status: p.merge.status });
    }
    if (request.method === "PATCH") p.state = body.state === "closed" ? "closed" : p.state;
    return Response.json({
      state: p.state,
      merged_at: p.merged ? T(0).toISOString() : null,
      closed_at: p.state === "closed" ? T(0).toISOString() : null,
      head: { sha: p.head },
      base: { ref: "main" },
      mergeable: p.mergeable,
      title: `Title ${p.number}`,
      commits: 1,
      merge_commit_sha: p.merged,
      merged_by: p.merged ? { login: "marshal-factory[bot]", type: "Bot" } : null,
    });
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/compare\/main\.\.\.(.+)$/.exec(path))) {
    const p = [...pulls.values()].find((x) => x.head === m![2]);
    return Response.json({ behind_by: p?.behind ?? 0 });
  }
  if ((m = /\/commits\/([^/]+)\/(check-runs|status)$/.exec(path))) {
    const p = [...pulls.values()].find((x) => x.head === m![1]);
    const runs = p?.checks === "none" ? [] : [{ name: "ci", status: "completed", conclusion: p?.checks ?? "success" }, { name: "Cursor Bugbot", status: "completed", conclusion: "neutral" }];
    if (m[2] === "check-runs") return Response.json({ total_count: runs.length, check_runs: runs });
    return Response.json({ state: "success", total_count: 0, statuses: [] });
  }
  // A repo without CI: its commits are old, and the App may read neither branch protection nor rulesets.
  if (/^\/repos\/[^/]+\/[^/]+\/git\/commits\/[^/]+$/.test(path)) return Response.json({ committer: { date: "2026-01-01T00:00:00Z" } });
  if (/^\/repos\/[^/]+\/[^/]+\/branches\/main$/.test(path)) return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
  if (/^\/repos\/[^/]+\/[^/]+\/rules\/branches\/main$/.test(path)) return Response.json({ message: "Not Found" }, { status: 404 });
  if (path === "/graphql") {
    const finding = { isResolved: false, comments: { nodes: [{ author: { login: "cursor" }, body: "**High Severity** bug" }] } };
    return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [finding] } } } } });
  }
  if (/\/issues\/\d+\/comments$/.test(path)) return request.method === "GET" ? Response.json([]) : Response.json({}, { status: 201 });
  return Response.json({ message: `no fake for ${request.method} ${path}` }, { status: 500 });
});
Object.assign(github, pullsClient({ api: `http://localhost:${server.port}`, tokens: { get: async () => "ghs_inbox_stub", evict: () => {} } }));

// --- threads, hosts and the source
const sent: { thread: string; message: string }[] = [];
let threadState: "running" | "stopped" | "gone" = "stopped";
let failSend = false;
threads.state = async () => threadState;
threads.send = async (thread, message) => {
  if (failSend) throw new Error("t3 thread send failed");
  sent.push({ thread, message });
};
const woken: string[] = [];
let failWake = false;
hosts.wake = async (job) => {
  if (failWake) throw new Error("the sandbox did not wake");
  woken.push(job.key);
  return localHost;
};
ingestClient.post = async (event) => ingest(db, [eventSchema.parse(event)]);
SOURCES.linear.labels = async () => ["factory"];
SOURCES.linear.note = async () => {};

// --- database
const stamp = Date.now() % 1_000_000;
const REPO = `regress/inbox-${stamp}`;
const keys: string[] = [];
// A row stored before the six checks were dropped still reads.
const assessment: AssessmentInput = {
  recommendation: "handover",
  interpretation: "Rename the list.",
  assumptions: ["Nobody imports the old name."],
  checks: {
    interpretation: { ok: true, note: "fine" },
    proven: { ok: false, note: "No test covers the rename." },
    contained: { ok: true, note: "fine" },
    reversible: { ok: true, note: "fine" },
    noTasteCalls: { ok: true, note: "fine" },
    noSurprises: { ok: true, note: "fine" },
  },
  reviewFocus: "The rename",
};
const row = async (k: string) => (await db.select().from(jobs).where(eq(jobs.key, k)))[0]!;
const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`;
async function job(name: string, over: Partial<typeof jobs.$inferInsert>, pull?: Partial<Pull> & { number: number }) {
  const k = `INB${name}-${stamp}`;
  keys.push(k);
  if (pull) {
    pulls.set(keyOf(REPO, pull.number), { repo: REPO, head: `h${pull.number}`, state: "open", merged: null, mergeable: true, behind: 0, checks: "success", files: [{ filename: "src/list.tsx", additions: 5, deletions: 1 }], merge: { status: 200, body: {} }, ...pull });
  }
  await db.insert(jobs).values(
    linearJob(`inbox-regress-${k}`, k, {
      machine_id: TEST_MACHINE_ID,
      repo: REPO,
      provider: "claudeAgent",
      t3_thread_id: `thread-${k}`,
      session_id: `session-${k}`,
      stage_event_id: `inbox-regress-stage-${k}`,
      stage_at: new Date(),
      ...(pull && { stage: "pr" as const, pr_url: prUrl(pull.number), merge_assessment: assessment }),
      ...over,
    }),
  );
  return k;
}
const owner = { email: OWNER, emailVerified: true };
const stranger = { email: "someone@example.com", emailVerified: true };
const replies: { key: string; requestId: string; body: string }[] = [];
const filed: FileDraft[] = [];
const harnesses: Harness[] = [{ id: "claudeAgent", driver: "claudeAgent", name: "Claude Code", enabled: true, models: [] }];
const deps = (user: typeof owner | null = owner) => ({
  db,
  user: async () => user,
  reply: async (j: { key: string }, requestId: string, body: string) => void replies.push({ key: j.key, requestId, body }),
  newJob: {
    user: async () => user,
    harnesses: async () => harnesses,
    registry: async () => [],
    file: async (draft: FileDraft) => (filed.push(draft), { key: `FAC-${filed.length}`, url: `https://linear.app/x/issue/FAC-${filed.length}` }),
    recordFiling: async () => {},
  },
});
const intentRows = (k: string) => db.select().from(intents).where(eq(intents.job_id, jobId("linear", `inbox-regress-${k}`)));
const putsTo = (n: number) => writes.filter((w) => w.method === "PUT" && w.path === `/repos/${REPO}/pulls/${n}/merge`);

try {
  await writeRepoAutonomy(db, { repo: REPO, autonomy: "off" }, OWNER, new Date());
  assert.equal(INTENT_ROUTES.approve_merge, "owner", "only the job's machine merges through its App");
  assert.equal(INTENT_ROUTES.request_changes, "owner", "and reaches its thread");

  // --- owner checks on every action
  const HAND = await job("HAND", {}, { number: 1, files: [{ filename: "drizzle/0099_x.sql", additions: 400, deletions: 10 }] });
  const handId = (await row(HAND)).id;
  const id1 = crypto.randomUUID();
  for (const user of [null, stranger, { ...owner, emailVerified: false }]) {
    assert.deepEqual(await inbox.approveMerge(deps(user), handId, id1, "h1"), { ok: false, message: "Only the factory owner can act on the inbox." });
    assert.equal((await inbox.requestChanges(deps(user), handId, id1, "x")).ok, false);
    assert.equal((await inbox.closeJob(deps(user), handId, id1, "")).ok, false);
    assert.equal((await inbox.dismissJob(deps(user), handId)).ok, false);
    assert.equal((await inbox.answerQuestion(deps(user), handId, id1, "x")).ok, false);
    assert.deepEqual(await inbox.intentOutcome(deps(user), `panel:approve_merge:${id1}`), { status: "failed", message: "Only the factory owner can act on the inbox." });
  }
  assert.equal((await intentRows(HAND)).length, 0, "a non-owner records nothing");
  assert.deepEqual(await inbox.approveMerge(deps(), handId, "not-a-uuid", "h1"), { ok: false, message: "The request is not valid." });
  assert.deepEqual(await inbox.requestChanges(deps(), handId, id1, "   "), { ok: false, message: "Write what should change." });
  assert.deepEqual(await inbox.dismissJob(deps(), handId), { ok: false, message: "Only a failed job or a stop that couldn't be confirmed can be dismissed." }, "a handover is not dismissed");
  assert.deepEqual(await inbox.answerQuestion(deps(), handId, id1, "yes"), { ok: false, message: "The job is no longer waiting on an answer." });

  const approval = await inbox.approveMerge(deps(), handId, id1, "h1");
  assert.deepEqual(approval, { ok: true, intentId: `panel:approve_merge:${id1}` });
  assert.deepEqual(await inbox.approveMerge(deps(), handId, id1, "h1"), approval, "a double submit records one intent");
  const [approveIntent] = await intentRows(HAND);
  assert.deepEqual([approveIntent!.kind, JSON.parse(approveIntent!.detail!)], ["approve_merge", { actor: OWNER, headSha: "h1", via: "inbox" }]);
  assert.deepEqual(await inbox.intentOutcome(deps(), approveIntent!.id), { status: "pending" });

  // --- approve: the auto-merge path, blocked only by facts
  const approved = await approveMerge(handId, { actor: OWNER, headSha: "h1", via: "inbox" });
  assert.deepEqual(approved, { merged: "merge-1" }, "the agent's handover and a large migration do not block the owner");
  assert.deepEqual(putsTo(1).map((w) => [w.body.sha, w.body.merge_method]), [["h1", "squash"]], "one merge, pinned to the reviewed head");
  const merged1 = await row(HAND);
  assert.equal(merged1.stage, "merged", "the merge goes in as the usual stage event");
  assert.equal(merged1.merge_decision!.merged!.sha, "merge-1");
  assert.equal(merged1.merge_decision!.watch!.state, "watching", "and the post-merge watch starts");
  assert.equal(merged1.merge_decision!.approvedBy, OWNER);
  const audits = await db.select().from(auditLog).where(eq(auditLog.job_id, handId));
  assert.deepEqual(audits.map((a) => [a.action, a.actor]).sort(), [["merge_requested", OWNER], ["merge_succeeded", OWNER]], "the owner who approved is the merge's actor");
  assert.match(audits.find((a) => a.action === "merge_succeeded")!.detail!, /^Merged by the factory as merge-1 \(squash\) via inbox · Approved in the inbox by owner@example\.com/);
  assert.equal(merged1.merge_decision!.merged!.via, "inbox");
  assert.deepEqual(await approveMerge(handId, { actor: OWNER, headSha: "h1", via: "inbox" }), { merged: "merge-1" }, "a replay finds the merge recorded");
  assert.equal(putsTo(1).length, 1, "and never merges twice");
  await db.update(intents).set({ handled_at: new Date(), result: JSON.stringify({ approval: approved }) }).where(eq(intents.id, approveIntent!.id));
  assert.deepEqual(await inbox.intentOutcome(deps(), approveIntent!.id), { status: "done", message: "Merged as merge-1. The factory now watches main." });

  const NOCI = await job("NOCI", {}, { number: 41, checks: "none" });
  assert.deepEqual(await approveMerge((await row(NOCI)).id, { actor: OWNER, headSha: "h41", via: "run_detail" }), { merged: "merge-41" }, "a repo without CI merges on the owner's approval");

  const BEHIND = await job("BEHIND", {}, { number: 42, behind: 3 });
  assert.deepEqual(await approveMerge((await row(BEHIND)).id, { actor: OWNER, headSha: "h42", via: "inbox" }), { merged: "merge-42" }, "a branch behind its base does not block the owner; GitHub refuses when protection requires it up to date");

  const RED = await job("RED", {}, { number: 2, checks: "failure", behind: 3 });
  assert.deepEqual(await approveMerge((await row(RED)).id, { actor: OWNER, headSha: null, via: "inbox" }), { blocked: "A check failed on the latest commit." });
  assert.equal(putsTo(2).length, 0, "facts block before GitHub is asked to merge");
  const MOVED = await job("MOVED", {}, { number: 3 });
  assert.deepEqual(await approveMerge((await row(MOVED)).id, { actor: OWNER, headSha: "old", via: "inbox" }), {
    refused: "The pull request moved to h3 since you reviewed old. Review the new commit first.",
  });
  assert.equal(putsTo(3).length, 0);
  const DENIED = await job("DENIED", {}, { number: 4, merge: { status: 403, body: { message: "Resource not accessible by integration" } } });
  assert.deepEqual(await approveMerge((await row(DENIED)).id, { actor: OWNER, headSha: "h4", via: "inbox" }), {
    blocked: "The factory's GitHub App can't merge in this repo: Resource not accessible by integration",
  });
  assert.equal((await row(DENIED)).merge_decision!.blocked, "Resource not accessible by integration", "a refusal is recorded like auto-merge's");
  assert.equal((await row(DENIED)).stage, "pr");

  // --- run detail's Merge: the inbox's approve_merge intent, merged by the runner's service
  const mergePuts = () => writes.filter((w) => w.method === "PUT" && w.path.endsWith("/merge")).length;
  const putsBeforePanel = mergePuts();
  const DETAIL = await job("DETAIL", {}, { number: 20, files: [{ filename: "drizzle/0100_y.sql", additions: 500, deletions: 0 }] });
  const detailId = (await row(DETAIL)).id;
  const id5 = crypto.randomUUID();
  for (const user of [null, stranger, { ...owner, emailVerified: false }]) {
    assert.deepEqual(await inbox.approveFromRunDetail(deps(user), detailId, id5, "h20"), { ok: false, message: "Only the factory owner can act on the inbox." });
    assert.equal(await inbox.mergeTarget({ ...deps(user), pulls: github }, detailId), null, "a non-owner gets no merge target");
  }
  assert.equal((await intentRows(DETAIL)).length, 0, "a non-owner records nothing from run detail");
  assert.deepEqual(await inbox.approveFromRunDetail(deps(), detailId, "not-a-uuid", "h20"), { ok: false, message: "The request is not valid." });
  assert.deepEqual(await inbox.approveFromRunDetail(deps(), detailId, id5, ""), { ok: false, message: "The request is not valid." }, "run detail always pins a head");
  assert.deepEqual(await inbox.mergeTarget({ ...deps(), pulls: github }, detailId), { title: "Title 20", headSha: "h20", repo: REPO, mergeable: "mergeable" }, "the dialog gets the head it pins");
  const detailApproval = await inbox.approveFromRunDetail(deps(), detailId, id5, "h20");
  assert.deepEqual(detailApproval, { ok: true, intentId: `panel:approve_merge:${id5}` }, "the same intent kind as the inbox's Approve");
  assert.deepEqual(await inbox.approveFromRunDetail(deps(), detailId, id5, "h20"), detailApproval, "a double submit records one intent");
  const detailIntents = await intentRows(DETAIL);
  assert.equal(detailIntents.length, 1);
  assert.deepEqual([detailIntents[0]!.kind, JSON.parse(detailIntents[0]!.detail!)], ["approve_merge", { actor: OWNER, headSha: "h20", via: "run_detail" }]);
  assert.deepEqual(approveDetailSchema.parse({ actor: OWNER, headSha: null }), { actor: OWNER, headSha: null, via: "inbox" }, "an approval recorded before run detail used it is the inbox's");
  const NOTPR = await job("NOTPR", { stage: "implementing" });
  assert.deepEqual(await inbox.approveFromRunDetail(deps(), (await row(NOTPR)).id, crypto.randomUUID(), "h"), { ok: false, message: "The job is no longer waiting on a pull request." });
  const INFLIGHT = await job("INFLIGHT", { merge_decision: decision({ outcome: "merge", headSha: "h21", merging: { headSha: "h21", method: "squash", at: T(0).toISOString(), via: "auto" } }) }, { number: 21 });
  assert.deepEqual(await inbox.approveFromRunDetail(deps(), (await row(INFLIGHT)).id, crypto.randomUUID(), "h21"), { ok: false, message: "The factory is already merging this pull request." });
  assert.equal(await inbox.mergeTarget({ ...deps(), pulls: github }, (await row(INFLIGHT)).id), null, "nor offers a merge in flight");
  assert.equal(mergePuts(), putsBeforePanel, "the panel's actions never call GitHub's merge endpoint");

  const viaDetail = await approveMerge(detailId, approveDetailSchema.parse(JSON.parse(detailIntents[0]!.detail!)));
  assert.deepEqual(viaDetail, { merged: "merge-20" }, "the runner merges it through the merge service, the agent's limits overruled");
  assert.deepEqual(putsTo(20).map((w) => w.body.sha), ["h20"], "pinned to the head the dialog showed");
  const detailMerged = await row(DETAIL);
  assert.equal(detailMerged.stage, "merged");
  assert.deepEqual([detailMerged.merge_decision!.merged!.via, detailMerged.merge_decision!.watch!.state, detailMerged.merge_decision!.merging], ["run_detail", "watching", undefined], "the post-merge watch starts");
  assert.deepEqual(detailMerged.merge_decision!.reasons, ["Approved in run detail by owner@example.com."]);
  assert.ok(detailMerged.merge_decision!.comments?.pr && detailMerged.merge_decision!.comments.source, "the decision comment and the source note are posted");
  const detailAudits = await db.select().from(auditLog).where(eq(auditLog.job_id, detailId));
  assert.deepEqual(detailAudits.map((a) => [a.action, a.actor]).sort(), [["merge_requested", OWNER], ["merge_succeeded", OWNER]]);
  assert.match(detailAudits.find((a) => a.action === "merge_requested")!.detail!, /^Approved in run detail · via run_detail$/);
  assert.match(detailAudits.find((a) => a.action === "merge_succeeded")!.detail!, /via run_detail/);

  const STALE = await job("STALE", {}, { number: 22 });
  const staleId = (await row(STALE)).id;
  assert.equal((await inbox.approveFromRunDetail(deps(), staleId, crypto.randomUUID(), "seen-earlier")).ok, true);
  assert.deepEqual(await approveMerge(staleId, { actor: OWNER, headSha: "seen-earlier", via: "run_detail" }), {
    refused: "The pull request moved to h22 since you reviewed seen-ea. Review the new commit first.",
  });
  assert.equal(putsTo(22).length, 0, "a push after the dialog opened stops the merge before GitHub is asked");
  const staleAudits = await db.select().from(auditLog).where(eq(auditLog.job_id, staleId));
  assert.deepEqual(staleAudits.map((a) => [a.action, a.actor, a.result, a.head_sha]), [["merge_failed", OWNER, "head_moved", "seen-earlier"]], "and the refusal is audited for the owner");

  // --- request changes: wake, move back, send once
  const CHANGE = await job("CHANGE", { sandbox_snapshot: "im-snapshot" }, { number: 5 });
  const changeId = (await row(CHANGE)).id;
  const id2 = crypto.randomUUID();
  assert.deepEqual(await inbox.requestChanges(deps(), changeId, id2, "Use the existing hook."), { ok: true, intentId: `panel:request_changes:${id2}` });
  const [changeIntent] = await intentRows(CHANGE);
  const feedback = feedbackDetailSchema.parse(JSON.parse(changeIntent!.detail!));
  assert.deepEqual(feedback, { from: "panel", id: `panel:${id2}`, actor: OWNER, body: "Use the existing hook." });

  failSend = true;
  await assert.rejects(requestChanges(changeId, feedback), /t3 thread send failed/);
  assert.deepEqual((await row(CHANGE)).delivered_feedback_ids, [], "a failed send gives the claim back for the retry");
  assert.equal((await row(CHANGE)).stage, "pr");
  failSend = false;
  assert.deepEqual(await requestChanges(changeId, feedback), { sent: CHANGE, moved: true });
  assert.deepEqual(woken, [CHANGE, CHANGE], "a hibernated job is woken for it");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.thread, `thread-${CHANGE}`);
  assert.equal(sent[0]!.message, changesMessage({ prUrl: prUrl(5), feedback }), "framed for the thread");
  const changed = await row(CHANGE);
  assert.equal(changed.stage, "implementing", "the job goes back to implementing");
  assert.match(changed.stage_summary!, /owner@example\.com requested changes on/);
  assert.equal(inboxKind(changed), null, "and leaves the inbox");
  assert.deepEqual(await requestChanges(changeId, feedback), { skipped: "already sent" }, "a replayed intent sends nothing");
  assert.equal(sent.length, 1);
  assert.deepEqual(await inbox.requestChanges(deps(), changeId, crypto.randomUUID(), "More."), { ok: false, message: "The job is no longer waiting on your review." });

  const GONE = await job("GONE", {}, { number: 6 });
  threadState = "gone";
  assert.match(JSON.stringify(await requestChanges((await row(GONE)).id, { ...feedback, id: "panel:gone" })), /thread is gone/);
  assert.deepEqual((await row(GONE)).delivered_feedback_ids, [], "nothing is claimed for a gone thread");
  threadState = "stopped";

  // --- GitHub reviews: recorded once per review, forwarded like the panel's
  const { default: ingestFunction } = await import("../functions/ingest/index");
  const REVIEWED = await job("REVIEWED", {}, { number: 7 });
  const reviewBody = (delivery: string, user = { login: "jan", type: "User" }) => {
    const raw = JSON.stringify({ ...review({ id: 9000 + stamp }, user), pull_request: { html_url: prUrl(7) } });
    return new Request("http://function/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "pull_request_review", "x-github-delivery": delivery, "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}` },
      body: raw,
    });
  };
  const deliveries = [`inbox-regress-${stamp}-1`, `inbox-regress-${stamp}-2`, `inbox-regress-${stamp}-bot`];
  assert.deepEqual(await (await ingestFunction.fetch(reviewBody(deliveries[0]!))).json(), { duplicate: false, intent: "request_changes" });
  assert.deepEqual(await (await ingestFunction.fetch(reviewBody(deliveries[1]!))).json(), { duplicate: false, intent: "request_changes" }, "a second delivery of the review");
  assert.deepEqual(await (await ingestFunction.fetch(reviewBody(deliveries[2]!, { login: "cursor[bot]", type: "Bot" }))).json(), { duplicate: false, intent: null });
  const reviewIntents = await intentRows(REVIEWED);
  assert.deepEqual(reviewIntents.map((i) => i.id), [`github:review:${9000 + stamp}`], "one intent per review id, tied to the job by its PR");
  const reviewIntent = reviewIntents[0]!;
  const parsedReview = feedbackDetailSchema.parse(JSON.parse(reviewIntent.detail!));
  assert.equal(parsedReview.from, "github");
  const reviewFeedback = parsedReview as Extract<typeof parsedReview, { from: "github" }>;
  const forward = (intent: Parameters<typeof forwardReview>[0], fb = reviewFeedback, now?: number) => forwardReview(intent, fb, TEST_MACHINE_ID, now);
  assert.deepEqual(await forward(reviewIntent), { sent: REVIEWED, moved: true });
  assert.match(sent.at(-1)!.message, /^The reviewer \(@jan on GitHub\) requested changes on .*pull\/7:\n\n> Rename the helper\.\n\nComments on the code:\n\n- src\/a\.ts:12\n  > This name is unclear\./);
  assert.deepEqual(await forward(reviewIntent), { skipped: "already sent" }, "a review already delivered closes its intent");
  const stray = { id: `github:review:stray-${stamp}`, job_id: null, pr_url: "https://github.com/o/r/pull/999", created_at: new Date() };
  assert.deepEqual(await forward(stray), { skipped: "the pull request is not a factory job's" }, "a review on another PR is ignored");
  const before = sent.length;
  const later = { ...reviewFeedback, id: "review:later", reviewId: 1 };
  assert.deepEqual(await forward(reviewIntent, later), { sent: REVIEWED, moved: false }, "a thread already at work only hears it");
  assert.equal(sent.length, before + 1);

  // --- GitHub reviews the job can't take yet stay open; finished jobs and old attempts close them
  const reviewIntentRow = async (name: string, over: { job_id?: ReturnType<typeof jobId> | null; pr_url: string; created_at?: Date }) => {
    const id = `github:review:inbox-regress-${name}-${stamp}`;
    await db.insert(intents).values({ id, kind: "request_changes", job_id: over.job_id ?? null, pr_url: over.pr_url, created_at: over.created_at ?? new Date() });
    return (await db.select().from(intents).where(eq(intents.id, id)))[0]!;
  };
  const EARLY = await job("EARLY", { stage: "implementing" });
  const early = await reviewIntentRow("early", { pr_url: prUrl(9) });
  const earlyFeedback = { ...reviewFeedback, id: "review:early", branch: `factory/${EARLY}` };
  assert.deepEqual(await forward(early, earlyFeedback), { waiting: "the job has no pull request yet" }, "a review before the job records its PR waits");
  assert.equal((await db.select().from(intents).where(eq(intents.id, early.id)))[0]!.job_id, (await row(EARLY)).id, "the branch ties the intent to the job, so it routes to the job's machine");
  assert.deepEqual(await forward({ ...early, job_id: null }, { ...earlyFeedback, branch: `factory/${EARLY}-a2` }), { skipped: "the pull request is not a factory job's" }, "another attempt's branch is not this job's");
  pulls.set(keyOf(REPO, 9), { repo: REPO, number: 9, head: "h9", state: "open", merged: null, mergeable: true, behind: 0, checks: "success", files: [], merge: { status: 200, body: {} } });
  await db.update(jobs).set({ stage: "pr", pr_url: prUrl(9) }).where(eq(jobs.key, EARLY));
  assert.deepEqual(await forward({ ...early, job_id: null }, earlyFeedback), { sent: EARLY, moved: true }, "the retry finds the job by its PR now and forwards it");

  const ASKING = await job("ASKING", { stage: "waiting", pr_url: prUrl(10) });
  const asking = await reviewIntentRow("asking", { job_id: (await row(ASKING)).id, pr_url: prUrl(10) });
  const askingFeedback = { ...reviewFeedback, id: "review:asking" };
  assert.deepEqual(await forward(asking, askingFeedback), { waiting: "the job is waiting" }, "a job waiting on a question takes it after the answer");
  const dropped = await forward(asking, askingFeedback, asking.created_at.getTime() + REVIEW_WAIT_MS + 1);
  assert.deepEqual(dropped, { refused: "@jan's review never reached the agent: after 24 hours the job is waiting." }, "after a day the review is given up");
  const askingAudit = await db.select().from(auditLog).where(eq(auditLog.job_id, (await row(ASKING)).id));
  assert.deepEqual(askingAudit.map((a) => [a.action, a.actor, a.target, a.result]), [["review_dropped", "@jan on GitHub", prUrl(10), "refused"]], "with an audit row");
  await forward(asking, askingFeedback, asking.created_at.getTime() + REVIEW_WAIT_MS + 2);
  assert.equal((await db.select().from(auditLog).where(eq(auditLog.job_id, (await row(ASKING)).id))).length, 1, "a replay adds no second row");

  const ASLEEP = await job("ASLEEP", { sandbox_snapshot: "im-asleep" }, { number: 11 });
  const asleep = await reviewIntentRow("asleep", { job_id: (await row(ASLEEP)).id, pr_url: prUrl(11) });
  failWake = true;
  assert.deepEqual(await forward(asleep, { ...reviewFeedback, id: "review:asleep" }), { waiting: "the sandbox did not wake" }, "a sandbox that fails to wake is tried again");
  failWake = false;
  assert.deepEqual((await row(ASLEEP)).delivered_feedback_ids, [], "and nothing is claimed");

  const ELSEWHERE = await job("ELSEWHERE", { machine_id: "another-machine" }, { number: 12 });
  const elsewhere = await reviewIntentRow("elsewhere", { pr_url: prUrl(12) });
  assert.deepEqual(await forward(elsewhere, { ...reviewFeedback, id: "review:elsewhere" }), { waiting: "the job runs on another machine" });
  assert.equal((await db.select().from(intents).where(eq(intents.id, elsewhere.id)))[0]!.job_id, (await row(ELSEWHERE)).id, "the retry goes to the job's machine");

  const DONE = await job("DONE", { stage: "merged" }, { number: 13 });
  const done = await reviewIntentRow("done", { job_id: (await row(DONE)).id, pr_url: prUrl(13) });
  assert.deepEqual(await forward(done, { ...reviewFeedback, id: "review:done" }), { refused: "The job is merged, so there is no work to change." }, "a finished job closes the intent");
  const RETRIED = await job("RETRIED", { attempt: 2 }, { number: 14 });
  const oldPr = await reviewIntentRow("old-pr", { job_id: (await row(RETRIED)).id, pr_url: prUrl(15) });
  assert.deepEqual(await forward(oldPr, { ...reviewFeedback, id: "review:old-pr" }), { skipped: "the pull request is not a factory job's" }, "a review on an earlier attempt's PR closes");

  // --- answer: the owner's reply in the source, then the usual resume
  const ASKED = await job("ASKED", { stage: "waiting", question: "Which list?" });
  const id3 = crypto.randomUUID();
  assert.deepEqual(await inbox.answerQuestion(deps(), (await row(ASKED)).id, id3, " The sidebar one. "), { ok: true, intentId: `panel:answer:${id3}` });
  assert.deepEqual(replies, [{ key: ASKED, requestId: id3, body: "The sidebar one." }]);
  assert.equal((await intentRows(ASKED))[0]!.kind, "answer", "the runner's answer intent resumes it");

  // --- close and dismiss
  const CLOSE = await job("CLOSE", {}, { number: 8 });
  const closeId = (await row(CLOSE)).id;
  assert.deepEqual(await closeJob(closeId, { actor: OWNER, reason: "Not needed" }), { closed: CLOSE, pr: "closed" });
  assert.deepEqual(writes.filter((w) => w.method === "PATCH" && w.path === `/repos/${REPO}/pulls/8`).map((w) => w.body), [{ state: "closed" }]);
  const closed = await row(CLOSE);
  assert.deepEqual([closed.stage, closed.stage_summary], ["failed", "Closed in the inbox by owner@example.com: Not needed."]);
  assert.ok(closed.stop_event_id, "the thread is told to stop, as for a stop");
  assert.equal(closed.stop_sent_to, `thread-${CLOSE}`);
  assert.match(sent.at(-1)!.message, /^Stop working on INBCLOSE/);
  assert.equal(inboxKind(closed), null, "a closed job does not come back as a failure");
  assert.deepEqual(await closeJob(closeId, { actor: OWNER, reason: "" }), { closed: CLOSE, pr: "already closed" }, "a replay closes nothing twice");

  const FAILED = await job("FAILED", { stage: "failed", stage_summary: "Watchdog stopped this run." });
  const failedId = (await row(FAILED)).id;
  assert.equal(inboxKind(await row(FAILED)), "failed");
  assert.deepEqual(await inbox.dismissJob(deps(), failedId), { ok: true, intentId: null });
  const dismissed = await row(FAILED);
  assert.deepEqual([dismissed.stage, inboxKind(dismissed)], ["failed", null], "dismiss only hides it");
  assert.deepEqual(await inbox.dismissJob(deps(), failedId), { ok: false, message: "Only a failed job or a stop that couldn't be confirmed can be dismissed." });

  // --- a failed revert: a follow-up job, filed like the panel's New job, with the original's overrides
  const revertDecision = decision({ merged, watch: { ...watch("revert_failed"), revertPr: "https://github.com/o/r/pull/90" } });
  const REVERTED = await job("REVERTED", {
    stage: "merged",
    pr_url: prUrl(16),
    url: "https://linear.app/x/issue/REVERTED",
    merge_decision: revertDecision,
    ticket_overrides: { provider: "claudeAgent", execution: "modal", notes: [] },
  });
  const revertedId = (await row(REVERTED)).id;
  assert.equal(inboxKind(await row(REVERTED)), "revert_failed");
  const id4 = crypto.randomUUID();
  for (const user of [null, stranger]) assert.equal((await inbox.fileFollowUp(deps(user), revertedId, id4, "Fix it.")).ok, false);
  assert.deepEqual(await inbox.fileFollowUp(deps(), revertedId, id4, "  "), { ok: false, message: "Write what the follow-up should fix." });
  assert.deepEqual(await inbox.fileFollowUp(deps(), handId, id4, "Fix it."), { ok: false, message: "Only a merge whose revert failed takes a follow-up." });
  assert.equal(filed.length, 0, "nothing is filed for a refused request");
  assert.deepEqual(await inbox.requestChanges(deps(), revertedId, id4, "Fix it."), { ok: false, message: "The job is no longer waiting on your review." }, "the merged attempt takes no changes");

  const followed = await inbox.fileFollowUp(deps(), revertedId, id4, "Pin the import order.");
  assert.deepEqual(followed, { ok: true, intentId: null, message: "Filed FAC-1. The factory picks it up as a new job." });
  assert.equal(filed.length, 1);
  const draft = filed[0]!;
  assert.equal(draft.requestId, id4, "the request id keys the issue, so a retry files it once");
  assert.equal(draft.title, `Fix main: revert of ${REVERTED} failed`);
  for (const fact of ["Pin the import order.", "- Failed checks on main: ci", `- Merged pull request: ${prUrl(16)}`, "- Why the revert failed: git revert failed", "- Revert pull request: https://github.com/o/r/pull/90"]) {
    assert.ok(draft.description.includes(fact), `the issue carries "${fact}"`);
  }
  assert.deepEqual(draft.labels, [{ group: "Harness", name: "Claude Code" }, { group: "Runs on", name: "Cloud" }], "with the original job's overrides");
  assert.equal(inboxKind(await row(REVERTED)), null, "the failed revert leaves the inbox");
  const followAudit = await db.select().from(auditLog).where(eq(auditLog.job_id, revertedId));
  assert.deepEqual(followAudit.map((a) => [a.action, a.actor, a.target, a.head_sha, a.result]), [["follow_up_filed", OWNER, "https://linear.app/x/issue/FAC-1", "m", "ok"]], "the audit log links the new issue");
  assert.equal((await intentRows(REVERTED)).length, 0, "no runner intent: the merged attempt's thread is not involved");

  harnesses[0]!.enabled = false;
  const REVERTED2 = await job("REVERTED2", { stage: "merged", merge_decision: revertDecision, ticket_overrides: { provider: "claudeAgent", notes: [] } });
  assert.equal((await inbox.fileFollowUp(deps(), (await row(REVERTED2)).id, crypto.randomUUID(), "Fix it.")).ok, true);
  assert.equal(filed.at(-1)!.labels, undefined, "a harness turned off since falls back to Settings instead of blocking the fix");
  harnesses[0]!.enabled = true;

  console.log("inbox regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  const ids = (await db.select({ id: jobs.id }).from(jobs).where(like(jobs.id, `${jobId("linear", "inbox-regress-")}%`))).map((j) => j.id);
  if (ids.length > 0) {
    await db.delete(auditLog).where(inArray(auditLog.job_id, ids));
    await db.delete(intents).where(inArray(intents.job_id, ids));
  }
  await db.delete(intents).where(like(intents.id, `github:review:inbox-regress-%-${stamp}`));
  await db.delete(webhookDeliveries).where(like(webhookDeliveries.delivery_id, `github:inbox-regress-${stamp}-%`));
  if (keys.length > 0) await db.delete(events).where(inArray(events.job_key, keys));
  await db.delete(jobs).where(like(jobs.id, `${jobId("linear", "inbox-regress-")}%`));
  await db.delete(repoSettings).where(eq(repoSettings.repo, REPO));
  await server.close();
  process.exit(process.exitCode ?? 0);
}
