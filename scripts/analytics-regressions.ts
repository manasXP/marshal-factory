import "./test-guard";
import assert from "node:assert/strict";
import { inArray, like } from "drizzle-orm";
import type { AgentRow, JobRow, RunRow } from "../db/schema";
import type { MergeDecision } from "../lib/merge-decision";

const { db } = await import("../db/client");
const { agents, auditLog, events, jobs, runs } = await import("../db/schema");
const { jobId } = await import("../lib/sources/shapes");
const { attemptBranch } = await import("../lib/factory");
const { blockedReason } = await import("../lib/merge-decision");
const { knownCostUsd } = await import("../lib/pricing");
const { dayKeyer, durations, jobFacts, jobOutcome, parseDecisionDetail, parseRange, rangeDays, reasonKind, spendFacts, summarize, UNKNOWN_HARNESS } = await import("../lib/analytics");
const { readAnalytics } = await import("../lib/analytics-data");
const { linearJob } = await import("./fixtures");

const T = (minutes: number) => new Date(Date.UTC(2026, 9, 20, 12) + minutes * 60_000);
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
const merged = (via?: "auto" | "inbox" | "run_detail") => ({ sha: "m", method: "squash" as const, at: T(90).toISOString(), base: "main", title: "t", commits: 1, ...(via && { via }) });
const job = (key: string, over: Partial<JobRow> = {}) =>
  ({
    ...linearJob(key.toLowerCase(), key),
    stage: "implementing",
    stage_at: T(0),
    stage_summary: null,
    question: null,
    pr_url: null,
    merge_decision: null,
    dismissed_at: null,
    stop: null,
    execution: null,
    attempt: 1,
    provider: null,
    session_id: null,
    claimed_at: T(0),
    updated_at: T(0),
    ...over,
  }) as JobRow;
const PR = "https://github.com/o/r/pull/1";

// --- Outcomes: who merged, handed over exactly when the inbox offers it, a stop apart from a failure

const outcome = (over: Partial<JobRow>) => jobOutcome(job("X-1", over));
assert.deepEqual(outcome({ stage: "merged", merge_decision: decision({ merged: merged("auto") }) }), { outcome: "merged_factory", mergedBy: "factory" });
assert.deepEqual(outcome({ stage: "merged", merge_decision: decision({ merged: merged("inbox") }) }), { outcome: "merged_owner", mergedBy: "approval" });
assert.deepEqual(outcome({ stage: "merged", merge_decision: decision({ merged: merged("run_detail") }) }), { outcome: "merged_owner", mergedBy: "approval" });
assert.deepEqual(outcome({ stage: "merged", merge_decision: decision({ merged: merged(), approvedBy: "o@x" }) }), { outcome: "merged_owner", mergedBy: "approval" }, "a merge from before `via` with an approval is the owner's");
assert.deepEqual(outcome({ stage: "merged", merge_decision: decision({ merged: merged() }) }), { outcome: "merged_factory", mergedBy: "factory" }, "a merge from before `via` without one is the factory's");
assert.deepEqual(outcome({ stage: "merged", merge_decision: decision({}) }), { outcome: "merged_owner", mergedBy: "github" }, "merged with no factory merge recorded: merged on GitHub");
assert.deepEqual(outcome({ stage: "merged" }), { outcome: "merged_owner", mergedBy: "github" });
assert.equal(outcome({ stage: "failed" }).outcome, "failed");
assert.equal(outcome({ stage: "failed", stop: { state: "confirmed" } as JobRow["stop"] }).outcome, "stopped");
assert.equal(outcome({ stage: "pr", pr_url: PR, merge_decision: decision({ autonomy: "off" }) }).outcome, "handed_over");
assert.equal(outcome({ stage: "pr", pr_url: PR, merge_decision: decision({ outcome: "merge", autonomy: "trial" }) }).outcome, "handed_over", "trial's would merge waits for review");
assert.equal(outcome({ stage: "pr", pr_url: PR, merge_decision: decision({ outcome: "pending" }) }).outcome, "in_progress", "a pending decision is still the factory's");
assert.equal(outcome({ stage: "pr", pr_url: PR, merge_decision: decision({ outcome: "merge", merging: { headSha: "h", method: "squash", at: T(0).toISOString() } }) }).outcome, "in_progress");
assert.equal(outcome({ stage: "waiting" }).outcome, "in_progress");

// --- Decision audit rows, as runner/merge-service.ts writes them

assert.deepEqual(parseDecisionDetail("Merging (auto)"), { verdict: "merge", reasons: [] });
assert.deepEqual(parseDecisionDetail("Merging (auto) · No CI on this repo; relying on the factory's own checks at abc1234."), { verdict: "merge", reasons: ["No CI on this repo; relying on the factory's own checks at abc1234."] });
assert.deepEqual(parseDecisionDetail("Would merge (trial)"), { verdict: "would_merge", reasons: [] });
assert.deepEqual(parseDecisionDetail("Hand over"), { verdict: "off", reasons: [] }, "off hands over without a reason");
assert.deepEqual(parseDecisionDetail("Hand over · A check failed on the latest commit. · The pull request conflicts with its base branch."), {
  verdict: "handover",
  reasons: ["A check failed on the latest commit.", "The pull request conflicts with its base branch."],
});
assert.equal(parseDecisionDetail("Pending · Waiting for checks.")?.verdict, "pending");
assert.equal(parseDecisionDetail("Main stayed green after the factory's merge"), null, "a watch's end is no decision");
assert.equal(parseDecisionDetail(null), null);

assert.equal(reasonKind("The agent isn't confident: the issue is vague."), "The agent isn't confident");
assert.equal(reasonKind("The agent didn't report an assessment."), "No assessment from the agent");
assert.equal(reasonKind('The issue has the "review" label.'), "The issue has the review label");
assert.equal(reasonKind("Bugbot has 2 unresolved medium or high findings."), "Unresolved Bugbot findings");
assert.equal(reasonKind("Bugbot didn't complete its review (cancelled)."), "Bugbot didn't complete its review");
assert.equal(reasonKind("The pull request edits CI workflows (.github/workflows/ci.yml)."), "Edits what the checks trust");
assert.equal(reasonKind("The pull request edits the check scripts the factory trusts: package.json scripts.test."), "Edits what the checks trust");
assert.equal(reasonKind("Checks failed at abc1234: test, build."), "The factory's checks failed");
assert.equal(reasonKind("Not verified at abc1234: no evidence; the job has no sandbox."), "Not verified at the PR head");
assert.equal(reasonKind("Checks, Bugbot didn't finish within 60 minutes."), "Timed out waiting on checks");
assert.equal(reasonKind(blockedReason("Resource not accessible by integration")), "GitHub refused the merge");
assert.equal(reasonKind("The pull request changes UI files (app/page.tsx), but the agent attached no screenshots."), "UI change without screenshots");
assert.equal(reasonKind("Something new."), "Other");

// --- Ranges and days

assert.equal(parseRange("7"), 7);
assert.equal(parseRange("90"), 90);
assert.equal(parseRange("14"), 30, "an unknown range is the default");
assert.equal(parseRange(undefined), 30);
assert.deepEqual(rangeDays(Date.UTC(2026, 9, 31, 20), 3, "UTC"), ["2026-10-29", "2026-10-30", "2026-10-31"]);
assert.deepEqual(rangeDays(Date.UTC(2026, 9, 31, 20), 3, "Asia/Kolkata"), ["2026-10-30", "2026-10-31", "2026-11-01"], "20:00 UTC is already tomorrow in India");
// New York leaves daylight saving on 1 November 2026: that day has 25 hours, and none is lost or doubled.
assert.deepEqual(rangeDays(Date.UTC(2026, 10, 2, 15), 4, "America/New_York"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
assert.equal(dayKeyer("Asia/Kolkata")(Date.UTC(2026, 9, 30, 18, 29)), "2026-10-30");
assert.equal(dayKeyer("Asia/Kolkata")(Date.UTC(2026, 9, 30, 18, 30)), "2026-10-31");
assert.deepEqual(durations([]), { median: null, p90: null, count: 0 });
assert.deepEqual(durations([30, 10, 20]), { median: 20, p90: 28, count: 3 });

// --- Facts from rows: cost over every attempt, the current attempt's reports, waits

const run = (key: string, attempt: number, over: Partial<RunRow> = {}) =>
  ({
    session_id: `${key}-a${attempt}`,
    branch: attemptBranch(key, attempt),
    job_key: key,
    model: "claude-opus-5-5",
    started_at: T(0),
    last_event_at: T(0),
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    ...over,
  }) as RunRow;
const agent = (sessionId: string, model: string | null, input: number) =>
  ({ tool_use_id: `${sessionId}-${model}`, session_id: sessionId, model, input_tokens: input, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }) as AgentRow;
const report = (key: string, minutes: number, stage: string) => ({ job_key: key, at: T(minutes), stage });

{
  // Attempt 1 failed after a pr report; attempt 2, claimed at T(100), asked a question, then merged on approval.
  const twice = job("TWICE-1", {
    attempt: 2,
    claimed_at: T(100),
    stage: "merged",
    stage_at: T(400),
    provider: "claudeAgent",
    session_id: "TWICE-1-a2",
    merge_decision: decision({ merged: { ...merged("inbox"), at: T(400).toISOString() } }),
  });
  const rows = [run("TWICE-1", 1), run("TWICE-1", 2, { started_at: T(110) })];
  const subagents = [agent("TWICE-1-a2", "claude-haiku-5-5", 1_000_000)];
  const reports = [
    report("TWICE-1", 50, "pr"),
    report("TWICE-1", 120, "implementing"),
    report("TWICE-1", 150, "waiting"),
    report("TWICE-1", 160, "waiting"),
    report("TWICE-1", 210, "queued"),
    report("TWICE-1", 300, "pr"),
    report("TWICE-1", 350, "pr"),
    report("TWICE-1", 400, "merged"),
  ];
  const [fact] = jobFacts([twice], rows, subagents, reports);
  assert.equal(fact!.outcome, "merged_owner");
  assert.equal(fact!.usd, 4 + 4 + 0.1, "both attempts' runs and the subagent, priced on their own models");
  assert.equal(fact!.costKnown, true);
  assert.equal(fact!.firstPrAt, T(300).getTime(), "the earlier attempt's pr report doesn't count");
  assert.equal(fact!.lastPrAt, T(350).getTime());
  assert.equal(fact!.mergedAt, T(400).getTime());
  assert.deepEqual(fact!.waits, [{ start: T(150).getTime(), end: T(210).getTime() }], "a second question in a row continues the same wait");

  const spend = spendFacts([twice], rows, subagents);
  assert.deepEqual(
    spend.map((s) => [s.harness, s.model, s.usd]),
    [
      [UNKNOWN_HARNESS, "claude-opus-5-5", 4],
      ["Claude Code", "claude-opus-5-5", 4],
      ["Claude Code", "claude-haiku-5-5", 0.1],
    ],
    "only the current attempt's harness is known",
  );

  const unpriced = jobFacts([job("ODD-1", { stage: "waiting" })], [run("ODD-1", 1, { model: "gpt-9-nova" })], [], [report("ODD-1", 10, "waiting")])[0]!;
  assert.equal(unpriced.costKnown, false, "a model without a price makes the cost unknown");
  assert.equal(unpriced.usd, 0);
  assert.deepEqual(unpriced.waits, [{ start: T(10).getTime(), end: null }], "still waiting");
  assert.equal(spendFacts([job("ODD-1")], [run("ODD-1", 1, { model: "gpt-9-nova" })], [])[0]!.usd, null);
  assert.equal(jobFacts([job("NONE-1")], [], [], [])[0]!.costKnown, false, "no usage recorded is unknown, not $0");
}

// --- Summaries for a range, in a zone

{
  const NOW = Date.UTC(2026, 9, 31, 12);
  const day = (n: number, hour = 6) => Date.UTC(2026, 9, 31 - n, hour);
  const fact = (key: string, over: Partial<ReturnType<typeof jobFacts>[number]>) => ({
    key,
    title: key,
    repo: "o/web",
    sessionId: null,
    outcome: "in_progress" as const,
    mergedBy: null,
    claimedAt: day(0),
    usd: 0,
    costKnown: false,
    firstPrAt: null,
    lastPrAt: null,
    mergedAt: null,
    waits: [],
    ...over,
  });
  const H = 3_600_000;
  const facts = {
    jobs: [
      fact("A-1", { outcome: "merged_factory", mergedBy: "factory", claimedAt: day(1), firstPrAt: day(1) + H, lastPrAt: day(1) + H, mergedAt: day(1) + 2 * H, usd: 2, costKnown: true }),
      fact("A-2", { outcome: "merged_owner", mergedBy: "github", claimedAt: day(1), firstPrAt: day(1) + 3 * H, lastPrAt: day(1) + 5 * H, mergedAt: day(1) + 9 * H, usd: 4, costKnown: true }),
      fact("A-3", { outcome: "merged_owner", mergedBy: "approval", claimedAt: day(2), usd: 1, costKnown: false }),
      fact("A-4", { outcome: "failed", claimedAt: day(2), waits: [{ start: day(2) + H, end: day(2) + 3 * H }] }),
      fact("A-5", { outcome: "stopped", claimedAt: day(0) }),
      fact("A-6", { outcome: "handed_over", claimedAt: day(0), waits: [{ start: day(0) + H, end: null }] }),
      fact("B-1", { outcome: "merged_factory", mergedBy: "factory", repo: "o/api", claimedAt: day(0), usd: 10, costKnown: true }),
      fact("OLD-1", { outcome: "failed", claimedAt: day(9) }),
      // 23:00 UTC on the 30th is the 31st in India: inside a one-day range there, not in UTC.
      fact("LATE-1", { outcome: "failed", claimedAt: Date.UTC(2026, 9, 30, 23) }),
    ],
    spend: [
      { jobKey: "A-1", repo: "o/web", at: day(1), harness: "Claude Code", model: "claude-opus-5-5", usd: 2 },
      { jobKey: "A-2", repo: "o/web", at: day(1), harness: "Claude Code", model: "claude-opus-5-5", usd: 4 },
      { jobKey: "A-3", repo: "o/web", at: day(2), harness: "Codex", model: "gpt-9-nova", usd: null },
      { jobKey: "A-3", repo: "o/web", at: day(2), harness: "Codex", model: "gpt-6.1-sol", usd: 1 },
      { jobKey: "B-1", repo: "o/api", at: day(0), harness: "Claude Code", model: "claude-opus-5-5", usd: 10 },
      { jobKey: "OLD-1", repo: "o/web", at: day(9), harness: "Claude Code", model: "claude-opus-5-5", usd: 50 },
    ],
    decisions: [
      { jobKey: "A-1", repo: "o/web", at: day(1), head: "h1", verdict: "handover" as const, reasons: ["Checks, Bugbot didn't finish within 60 minutes."] },
      { jobKey: "A-1", repo: "o/web", at: day(1) + H, head: "h1", verdict: "merge" as const, reasons: [] },
      { jobKey: "A-2", repo: "o/web", at: day(1), head: "h2", verdict: "handover" as const, reasons: ["The agent isn't confident: x", "A check failed on the latest commit."] },
      { jobKey: "A-2", repo: "o/web", at: day(1) + H, head: "h3", verdict: "handover" as const, reasons: ["Checks failed at h3: test.", "Checks failed at h3: build."] },
      { jobKey: "A-3", repo: "o/web", at: day(2), head: "h4", verdict: "would_merge" as const, reasons: [] },
      { jobKey: "A-6", repo: "o/web", at: day(0), head: "", verdict: "off" as const, reasons: [] },
      { jobKey: "OLD-1", repo: "o/web", at: day(9), head: "h5", verdict: "handover" as const, reasons: ["The agent isn't confident: y"] },
    ],
  };
  const a = summarize(facts, { days: 7, now: NOW, timeZone: "UTC", repo: null });
  assert.equal(a.days.length, 7);
  assert.equal(a.claimed, 8, "OLD-1 was claimed before the range");
  assert.deepEqual(a.totals, { merged_factory: 2, merged_owner: 2, handed_over: 1, stopped: 1, failed: 2, in_progress: 0 });
  assert.deepEqual(a.mergedBy, { factory: 2, approval: 1, github: 1 });
  assert.deepEqual(a.success, { merged: 4, ended: 7, rate: 4 / 7 }, "handed over is not ended");
  assert.deepEqual(a.outcomes.at(-1)!.counts, { merged_factory: 1, merged_owner: 0, handed_over: 1, stopped: 1, failed: 0, in_progress: 0 });

  assert.equal(a.spend.total, 17, "OLD-1's run started before the range; the unpriced run counts 0");
  assert.equal(a.spend.unpriced, 1);
  assert.deepEqual(a.spend.byDay.at(-2), { day: "2026-10-30", usd: 6, unpriced: 0 });
  assert.deepEqual(a.spend.byRepo, [
    { label: "o/api", usd: 10, unpriced: 0 },
    { label: "o/web", usd: 7, unpriced: 1 },
  ]);
  assert.deepEqual(a.spend.byHarness.map((s) => s.label), ["Claude Code · claude-opus-5-5", "Codex · gpt-6.1-sol", "Codex · gpt-9-nova"]);
  assert.deepEqual(a.spend.mergedAverage, { usd: (2 + 4 + 10) / 3, known: 3, merged: 4 }, "A-3's partial cost stays out of the average");
  assert.deepEqual(a.spend.topJobs.map((j) => j.key), ["B-1", "A-2", "A-1", "A-3"]);
  assert.equal(a.spend.unknownJobs, 5);

  assert.deepEqual(a.speed.claimToPr, { median: 2 * H, p90: 2.8 * H, count: 2 });
  assert.equal(a.speed.prToMerge.count, 2);
  assert.equal(a.speed.prToMergeFactory.median, H);
  assert.equal(a.speed.prToMergeOwner.median, 6 * H, "from the first pr report");
  assert.deepEqual(a.speed.reviewWait, { median: 4 * H, p90: 4 * H, count: 1, open: 1 }, "from the last pr report; the factory's merges don't count");
  assert.deepEqual(a.speed.answerWait, { median: 2 * H, p90: 2 * H, count: 1, open: 1 });

  assert.equal(a.autonomy.decided, 5, "one decision per PR head: its last; OLD-1's came before the range");
  assert.deepEqual(a.autonomy.verdicts, { merge: 1, would_merge: 1, handover: 2, off: 1 });
  assert.equal(a.autonomy.handovers, 2);
  assert.deepEqual(a.autonomy.reasons, [
    { reason: "A check failed on the PR", count: 1 },
    { reason: "The agent isn't confident", count: 1 },
    { reason: "The factory's checks failed", count: 1 },
  ], "two reasons of one kind count once; A-1's timeout was replaced by its merge");

  const api = summarize(facts, { days: 7, now: NOW, timeZone: "UTC", repo: "o/api" });
  assert.equal(api.claimed, 1);
  assert.equal(api.spend.total, 10);
  assert.equal(api.autonomy.decided, 0);

  assert.equal(summarize(facts, { days: 7, now: NOW, timeZone: "UTC", repo: null }).outcomes[0]!.day, "2026-10-25");
  assert.deepEqual(summarize(facts, { days: 7, now: Date.UTC(2026, 9, 30, 23, 30), timeZone: "Asia/Kolkata", repo: null }).days.at(-1), "2026-10-31");
  const india = summarize({ ...facts, jobs: facts.jobs.filter((j) => j.key === "LATE-1") }, { days: 7, now: NOW, timeZone: "Asia/Kolkata", repo: null });
  assert.equal(india.outcomes.at(-1)!.counts.failed, 1, "the day is the owner's");
  const utc = summarize({ ...facts, jobs: facts.jobs.filter((j) => j.key === "LATE-1") }, { days: 7, now: NOW, timeZone: "UTC", repo: null });
  assert.equal(utc.outcomes.at(-2)!.counts.failed, 1);
}

// --- Reading the facts from the database

const PREFIX = "analytics-regress-";
const KEYS = { merged: "ANLX-1", retried: "ANLX-2", old: "ANLX-3" };
try {
  const now = Date.now();
  const at = (minutes: number) => new Date(now + minutes * 60_000);
  await db.insert(jobs).values([
    linearJob(`${PREFIX}1`, KEYS.merged, {
      stage: "merged",
      stage_at: at(-10),
      claimed_at: at(-120),
      pr_url: PR,
      provider: "claudeAgent",
      session_id: `${PREFIX}s1`,
      merge_decision: decision({ merged: { ...merged("auto"), at: at(-10).toISOString() } }),
    }),
    linearJob(`${PREFIX}2`, KEYS.retried, { stage: "pr", attempt: 2, claimed_at: at(-60), pr_url: PR, provider: "codex" }),
    // Claimed long before the range, but a run started in it: its spend counts.
    linearJob(`${PREFIX}3`, KEYS.old, { stage: "implementing", claimed_at: at(-60 * 24 * 200) }),
  ]);
  const runRow = (session: string, key: string, attempt: number, minutes: number, model = "claude-opus-5-5") => ({
    session_id: `${PREFIX}${session}`,
    branch: attemptBranch(key, attempt),
    job_key: key,
    model,
    started_at: at(minutes),
    last_event_at: at(minutes),
    input_tokens: 1_000_000,
  });
  await db.insert(runs).values([
    runRow("s1", KEYS.merged, 1, -110),
    runRow("s2a", KEYS.retried, 1, -60 * 24 * 100),
    runRow("s2", KEYS.retried, 2, -50, "gpt-6.1-sol"),
    runRow("s3", KEYS.old, 1, -5),
  ]);
  await db.insert(agents).values({ tool_use_id: `${PREFIX}t1`, session_id: `${PREFIX}s1`, model: "claude-haiku-5-5", started_at: at(-100), input_tokens: 1_000_000 });
  const stage = (id: string, key: string, minutes: number, stageName: string, refusal: string | null = null) => ({
    event_id: `${PREFIX}${id}`,
    session_id: `${PREFIX}s`,
    kind: "stage",
    at: at(minutes),
    job_key: key,
    payload: { kind: "stage", stage: stageName },
    refusal,
  });
  await db.insert(events).values([
    stage("e1", KEYS.merged, -90, "pr"),
    stage("e2", KEYS.merged, -80, "waiting", "paused at the spend limit"),
    stage("e3", KEYS.merged, -10, "merged"),
    stage("e4", KEYS.retried, -60 * 24 * 100, "pr"),
    stage("e5", KEYS.retried, -30, "pr"),
  ]);
  const audit = (id: string, key: string, minutes: number, head: string, detail: string) => ({
    id: `${PREFIX}${id}`,
    at: at(minutes),
    actor: "factory",
    action: "merge_decided" as const,
    job_id: jobId("linear", `${PREFIX}${key}`),
    target: PR,
    head_sha: head,
    detail,
  });
  await db.insert(auditLog).values([
    audit("a1", "1", -80, "h1", "Pending · Waiting for checks."),
    audit("a2", "1", -20, "h1", "Merging (auto)"),
    audit("a3", "1", -5, "m", "Main stayed green after the factory's merge"),
    audit("a4", "2", -25, "h2", "Hand over · The agent isn't confident: unsure"),
    audit("a5", "2", -60 * 24 * 100, "h0", "Hand over · A check failed on the latest commit."),
  ]);

  const facts = await readAnalytics(db, at(-60 * 24 * 8));
  const mine = facts.jobs.filter((j) => j.key.startsWith("ANLX-"));
  assert.deepEqual(mine.map((j) => j.key).sort(), [KEYS.merged, KEYS.retried, KEYS.old]);
  const m = mine.find((j) => j.key === KEYS.merged)!;
  assert.equal(m.outcome, "merged_factory");
  assert.equal(m.usd, 4 + 0.1);
  assert.equal(m.firstPrAt, at(-90).getTime());
  assert.deepEqual(m.waits, [], "a refused report never moved the job");
  const r = mine.find((j) => j.key === KEYS.retried)!;
  assert.equal(r.usd, 4 + knownCostUsd({ input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, "gpt-6.1-sol")!, "an earlier attempt's run from before the range still counts toward the job");
  assert.equal(r.firstPrAt, at(-30).getTime());
  const spend = facts.spend.filter((s) => s.jobKey.startsWith("ANLX-"));
  assert.equal(spend.length, 5);
  assert.deepEqual(spend.filter((s) => s.jobKey === KEYS.retried).map((s) => s.harness).sort(), ["Codex", UNKNOWN_HARNESS]);
  const decided = facts.decisions.filter((d) => d.jobKey.startsWith("ANLX-"));
  assert.deepEqual(
    decided.map((d) => [d.jobKey, d.head, d.verdict]).sort(),
    [
      [KEYS.merged, "h1", "merge"],
      [KEYS.retried, "h2", "handover"],
    ],
    "pending rows, a watch's end and decisions before `since` are left out",
  );

  console.log("analytics regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(auditLog).where(like(auditLog.id, `${PREFIX}%`));
  await db.delete(events).where(like(events.event_id, `${PREFIX}%`));
  await db.delete(agents).where(like(agents.tool_use_id, `${PREFIX}%`));
  await db.delete(runs).where(like(runs.session_id, `${PREFIX}%`));
  await db.delete(jobs).where(inArray(jobs.key, Object.values(KEYS)));
  process.exit(process.exitCode ?? 0);
}
