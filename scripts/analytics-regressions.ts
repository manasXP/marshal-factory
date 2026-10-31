import "./test-guard";
import assert from "node:assert/strict";
import { inArray, like } from "drizzle-orm";
import type { AgentRow, JobRow, RunRow } from "../db/schema";
import type { Harness } from "../lib/harness";
import type { MergeDecision } from "../lib/merge-decision";

const { db } = await import("../db/client");
const { agents, auditLog, events, jobEvidence, jobs, runs } = await import("../db/schema");
const { jobId } = await import("../lib/sources/shapes");
const { attemptBranch } = await import("../lib/factory");
const { blockedReason } = await import("../lib/merge-decision");
const { branchCosts } = await import("../lib/spend");
const {
  dayKeyer,
  decisionFacts,
  detailKinds,
  durations,
  jobCost,
  jobFacts,
  jobOutcome,
  parseDecisionDetail,
  parseRange,
  rangeDays,
  rangeRepos,
  reasonKind,
  spendFacts,
  summarize,
  UNKNOWN_HARNESS,
  waitSpells,
} = await import("../lib/analytics");
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
const watch = (state: "watching" | "green" | "reverted" | "revert_failed") => ({ state, until: T(150).toISOString(), failed: [], revertPr: null, reason: null });
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
    answered_at: null,
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
// Main went red after the merge: no success, whoever merged it.
assert.deepEqual(outcome({ stage: "merged", merge_decision: decision({ merged: merged("auto"), watch: watch("reverted") }) }), { outcome: "reverted", mergedBy: "factory" });
assert.deepEqual(outcome({ stage: "merged", merge_decision: decision({ merged: merged("inbox"), watch: watch("revert_failed") }) }), { outcome: "reverted", mergedBy: "approval" });
assert.equal(outcome({ stage: "merged", merge_decision: decision({ merged: merged("auto"), watch: watch("green") }) }).outcome, "merged_factory");
assert.equal(outcome({ stage: "merged", merge_decision: decision({ merged: merged("auto"), watch: watch("watching") }) }).outcome, "merged_factory");
assert.equal(outcome({ stage: "failed" }).outcome, "failed");
assert.equal(outcome({ stage: "failed", stop: { state: "confirmed" } as JobRow["stop"] }).outcome, "stopped");
assert.equal(outcome({ stage: "pr", pr_url: PR, merge_decision: decision({ autonomy: "off" }) }).outcome, "handed_over");
assert.equal(outcome({ stage: "pr", pr_url: PR, merge_decision: decision({ outcome: "merge", autonomy: "trial" }) }).outcome, "handed_over", "trial's would merge waits for review");
assert.equal(outcome({ stage: "pr", pr_url: PR, merge_decision: decision({ outcome: "pending" }) }).outcome, "in_progress", "a pending decision is still the factory's");
assert.equal(outcome({ stage: "pr", pr_url: PR, merge_decision: decision({ outcome: "merge", merging: { headSha: "h", method: "squash", at: T(0).toISOString() } }) }).outcome, "in_progress");
assert.equal(outcome({ stage: "waiting" }).outcome, "in_progress");

// --- Decision audit rows, as runner/merge-service.ts writes them

assert.deepEqual(parseDecisionDetail("Merging (auto)"), { verdict: "merge", body: "" });
assert.deepEqual(parseDecisionDetail("Would merge (trial)"), { verdict: "would_merge", body: "" });
assert.deepEqual(parseDecisionDetail("Hand over"), { verdict: "off", body: "" }, "off hands over without a reason");
assert.deepEqual(parseDecisionDetail("Hand over · The agent isn't confident: tests · docs · A check failed on the latest commit."), {
  verdict: "handover",
  body: "The agent isn't confident: tests · docs · A check failed on the latest commit.",
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

// A reason with " · " in it: the detail is matched where reasons begin, never split blindly.
assert.deepEqual(detailKinds("The agent isn't confident: tests · docs missing · A check failed on the latest commit."), ["The agent isn't confident", "A check failed on the PR"]);
assert.deepEqual(detailKinds("Checks, Bugbot didn't finish within 60 minutes."), ["Timed out waiting on checks"]);
assert.deepEqual(detailKinds("Something new · and more"), ["Other"]);
assert.deepEqual(detailKinds(""), []);

{
  const at = T(10);
  const stored = decision({ evaluatedAt: at.toISOString(), headSha: "h1", reasons: ["The agent isn't confident: x · Bugbot has 2 unresolved findings in my opinion"] });
  const row = (over: Partial<Parameters<typeof decisionFacts>[0][number]> = {}) => ({
    at,
    head_sha: "h1",
    target: "https://github.com/o/web/pull/7",
    detail: "Hand over · The agent isn't confident: x · Bugbot has 2 unresolved findings in my opinion",
    job: { key: "D-1", repo: "o/moved", pr_url: "https://github.com/o/web/pull/7", merge_decision: stored },
    ...over,
  });
  const [structured] = decisionFacts([row()]);
  assert.deepEqual(structured!.kinds, ["The agent isn't confident"], "the stored decision's reasons win over the detail's text");
  assert.equal(structured!.repo, "o/web", "the PR's repo, not the job's");
  assert.equal(structured!.pr, "https://github.com/o/web/pull/7");
  const [older] = decisionFacts([row({ at: T(5) })]);
  assert.deepEqual(older!.kinds, ["The agent isn't confident", "Unresolved Bugbot findings"], "an older row is read from its detail");
  const [approved] = decisionFacts([row({ job: { key: "D-1", repo: "o/web", pr_url: "https://github.com/o/web/pull/7", merge_decision: { ...stored, approvedBy: "o@x" } } })]);
  assert.equal(approved!.kinds.length, 2, "an approval rewrote the stored decision, so the detail is read");
  assert.deepEqual(decisionFacts([row({ detail: "Pending · Waiting for checks." }), row({ detail: "Main stayed green after the factory's merge" })]), []);
  assert.deepEqual(decisionFacts([row({ detail: "Merging (auto)" })])[0]!.kinds, []);
}

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

// --- Waits on an answer end when the answer reached the thread

const report = (key: string, minutes: number, stage: string) => ({ job_key: key, at: T(minutes), stage });
{
  const ms = (minutes: number) => T(minutes).getTime();
  const w = (...stages: [number, string][]) => stages.map(([m, s]) => report("W-1", m, s));
  assert.deepEqual(waitSpells(w([10, "waiting"], [100, "implementing"]), ms(40), false), [{ start: ms(10), end: ms(40) }], "the answer ends it, not the agent's next report");
  assert.deepEqual(waitSpells(w([10, "waiting"]), ms(40), true), [{ start: ms(10), end: ms(40) }], "answered while the job still shows waiting is not waiting now");
  assert.deepEqual(waitSpells(w([10, "waiting"]), null, true), [{ start: ms(10), end: null }], "unanswered");
  assert.deepEqual(waitSpells(w([10, "waiting"], [20, "waiting"], [100, "implementing"]), ms(50), false), [{ start: ms(10), end: ms(50) }], "a question reported again before the answer is the same wait");
  assert.deepEqual(
    waitSpells(w([10, "waiting"], [60, "waiting"]), ms(40), true),
    [
      { start: ms(10), end: ms(40) },
      { start: ms(60), end: null },
    ],
    "a question after the answer is a new wait",
  );
  assert.deepEqual(
    waitSpells(w([10, "waiting"], [30, "triage"], [50, "waiting"], [100, "pr"]), ms(70), false),
    [
      { start: ms(10), end: ms(30) },
      { start: ms(50), end: ms(70) },
    ],
    "only the latest answer is kept, so an earlier wait ends at the next report",
  );
}

// --- Facts from rows: cost from branchCosts over every attempt, the current attempt's reports

const run = (key: string, attempt: number, over: Partial<RunRow> = {}) =>
  ({
    session_id: `${key}-a${attempt}`,
    branch: attemptBranch(key, attempt),
    job_key: key,
    model: "claude-opus-5-5",
    started_at: T(0),
    last_event_at: T(0),
    pr_url: null,
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    ...over,
  }) as RunRow;
const agent = (sessionId: string, model: string | null, input: number) =>
  ({ tool_use_id: `${sessionId}-${model}`, session_id: sessionId, model, input_tokens: input, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }) as AgentRow;

assert.deepEqual(jobCost({ key: "C-1", attempt: 3 }, { "factory/C-1": { usd: 2, known: true }, "factory/C-1-a3": { usd: 1, known: true } }), { usd: 3, known: true }, "an attempt that never ran adds nothing");
assert.deepEqual(jobCost({ key: "C-1", attempt: 2 }, { "factory/C-1": { usd: 2, known: true }, "factory/C-1-a2": { usd: 1, known: false } }), { usd: 3, known: false });
assert.deepEqual(jobCost({ key: "C-1", attempt: 1 }, {}), { usd: 0, known: false }, "no usage recorded is unknown, not $0");

{
  // Attempt 1 failed after a pr report; attempt 2, claimed at T(100), asked a question, then merged on approval.
  const twice = job("TWICE-1", {
    attempt: 2,
    claimed_at: T(100),
    stage: "merged",
    stage_at: T(400),
    answered_at: T(180),
    provider: "claudeAgent",
    session_id: "TWICE-1-a2",
    repo: "o/new",
    merge_decision: decision({ merged: { ...merged("inbox"), at: T(400).toISOString() } }),
  });
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
  const costs = { "factory/TWICE-1": { usd: 4, known: true }, "factory/TWICE-1-a2": { usd: 4.1, known: true } };
  const [fact] = jobFacts([twice], reports, costs);
  assert.equal(fact!.outcome, "merged_owner");
  assert.equal(fact!.usd, 8.1, "both attempts' branches");
  assert.equal(fact!.costKnown, true);
  assert.equal(fact!.firstPrAt, T(300).getTime(), "the earlier attempt's pr report doesn't count");
  assert.equal(fact!.lastPrAt, T(350).getTime());
  assert.equal(fact!.mergedAt, T(400).getTime());
  assert.deepEqual(fact!.waits, [{ start: T(150).getTime(), end: T(180).getTime() }]);
  const stale = jobFacts([{ ...twice, answered_at: T(20) }], reports, costs)[0]!;
  assert.deepEqual(stale.waits, [{ start: T(150).getTime(), end: T(210).getTime() }], "an answer from before this attempt's claim is ignored");

  const rows = [run("TWICE-1", 1, { pr_url: "https://github.com/o/old/pull/3" }), run("TWICE-1", 2, { started_at: T(110) })];
  const subagents = [agent("TWICE-1-a2", "claude-haiku-5-5", 1_000_000)];
  const reported: Harness[] = [{ id: "claudeAgent", driver: "claudeAgent", name: "Claude (work)", enabled: true, models: [] }];
  const spend = spendFacts([twice], rows, subagents, reported);
  assert.deepEqual(
    spend.map((s) => [s.harness, s.model, s.usd, s.repo]),
    [
      [UNKNOWN_HARNESS, "claude-opus-5-5", 4, "o/old"],
      ["Claude (work)", "claude-opus-5-5", 4, "o/new"],
      ["Claude (work)", "claude-haiku-5-5", 0.1, "o/new"],
    ],
    "the machines' name for the harness; a run's repo from its PR, not the job's current one",
  );
  assert.equal(spendFacts([twice], rows.slice(1), [])[0]!.harness, "Claude Code", "the driver's label when no machine reports the harness");
  const fromEvidence = spendFacts([twice], [run("TWICE-1", 1)], [], [], new Map([["TWICE-1:1", "o/evidence"]]));
  assert.equal(fromEvidence[0]!.repo, "o/evidence", "an earlier attempt without a PR takes its evidence's repo");
  assert.equal(spendFacts([twice], [run("TWICE-1", 1)], [])[0]!.repo, "o/new", "else the job's");
  assert.equal(spendFacts([job("ODD-1")], [run("ODD-1", 1, { model: "gpt-9-nova" })], [])[0]!.usd, null);
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
  const decided = (jobKey: string, at: number, pr: string, verdict: "merge" | "would_merge" | "handover" | "off", kinds: string[] = [], repo = "o/web") => ({ jobKey, repo, pr, at, verdict, kinds });
  const facts = {
    jobs: [
      fact("A-1", { outcome: "merged_factory", mergedBy: "factory", claimedAt: day(1), firstPrAt: day(1) + H, lastPrAt: day(1) + H, mergedAt: day(1) + 2 * H, usd: 2, costKnown: true }),
      fact("A-2", { outcome: "merged_owner", mergedBy: "github", claimedAt: day(1), firstPrAt: day(1) + 3 * H, lastPrAt: day(1) + 5 * H, mergedAt: day(1) + 9 * H, usd: 4, costKnown: true }),
      fact("A-3", { outcome: "merged_owner", mergedBy: "approval", claimedAt: day(2), usd: 1, costKnown: false }),
      fact("A-4", { outcome: "failed", claimedAt: day(2), waits: [{ start: day(2) + H, end: day(2) + 3 * H }] }),
      fact("A-5", { outcome: "stopped", claimedAt: day(0) }),
      fact("A-6", { outcome: "handed_over", claimedAt: day(0), waits: [{ start: day(0) + H, end: null }] }),
      fact("A-7", { outcome: "reverted", mergedBy: "factory", claimedAt: day(3), firstPrAt: day(3), lastPrAt: day(3), mergedAt: day(3) + 3 * H, usd: 3, costKnown: true }),
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
      // A job claimed before the range whose earlier attempt ran in another repo.
      { jobKey: "OLD-2", repo: "o/docs", at: day(1), harness: UNKNOWN_HARNESS, model: "claude-opus-5-5", usd: 1 },
    ],
    decisions: [
      decided("A-1", day(1), "pr/1", "handover", ["Timed out waiting on checks"]),
      decided("A-1", day(1) + H, "pr/1", "merge"),
      decided("A-2", day(1), "pr/2", "handover", ["The agent isn't confident", "A check failed on the PR"]),
      decided("A-2", day(1) + H, "pr/2", "handover", ["The factory's checks failed"]),
      decided("A-3", day(2), "pr/3", "would_merge"),
      decided("A-6", day(0), "pr/6", "off"),
      decided("OLD-1", day(9), "pr/9", "handover", ["The agent isn't confident"]),
      decided("OLD-3", day(2), "pr/10", "handover", ["Conflicts with its base branch"], "o/infra"),
    ],
  };
  const a = summarize(facts, { days: 7, now: NOW, timeZone: "UTC", repo: null });
  assert.equal(a.days.length, 7);
  assert.equal(a.claimed, 9, "OLD-1 was claimed before the range");
  assert.deepEqual(a.totals, { merged_factory: 2, merged_owner: 2, handed_over: 1, reverted: 1, stopped: 1, failed: 2, in_progress: 0 });
  assert.deepEqual(a.mergedBy, { factory: 2, approval: 1, github: 1 }, "a reverted merge isn't counted as merged");
  assert.deepEqual(a.success, { merged: 4, ended: 8, rate: 4 / 8 }, "a reverted merge ended, but not in success; handed over is not ended");
  assert.deepEqual(a.outcomes.at(-1)!.counts, { merged_factory: 1, merged_owner: 0, handed_over: 1, reverted: 0, stopped: 1, failed: 0, in_progress: 0 });

  assert.equal(a.spend.total, 18, "OLD-1's run started before the range; the unpriced run counts 0");
  assert.equal(a.spend.unpriced, 1);
  assert.deepEqual(a.spend.byDay.at(-2), { day: "2026-10-30", usd: 7, unpriced: 0 });
  assert.deepEqual(a.spend.byRepo, [
    { label: "o/api", usd: 10, unpriced: 0 },
    { label: "o/web", usd: 7, unpriced: 1 },
    { label: "o/docs", usd: 1, unpriced: 0 },
  ]);
  assert.deepEqual(a.spend.byHarness.map((s) => s.label), ["Claude Code · claude-opus-5-5", "Codex · gpt-6.1-sol", `${UNKNOWN_HARNESS} · claude-opus-5-5`, "Codex · gpt-9-nova"]);
  assert.deepEqual(a.spend.mergedAverage, { usd: (2 + 4 + 10) / 3, known: 3, merged: 4 }, "A-3's partial cost and the reverted A-7 stay out of the average");
  assert.deepEqual(a.spend.topJobs.map((j) => j.key), ["B-1", "A-2", "A-7", "A-1", "A-3"]);
  assert.equal(a.spend.unknownJobs, 5);

  assert.deepEqual(a.speed.claimToPr, { median: 1 * H, p90: 2.6 * H, count: 3 });
  assert.equal(a.speed.prToMerge.count, 3, "a reverted merge still took its time to merge");
  assert.equal(a.speed.prToMergeFactory.median, 2 * H);
  assert.equal(a.speed.prToMergeOwner.median, 6 * H, "from the first pr report");
  assert.deepEqual(a.speed.reviewWait, { median: 4 * H, p90: 4 * H, count: 1, open: 1 }, "from the last pr report; the factory's merges don't count");
  assert.deepEqual(a.speed.answerWait, { median: 2 * H, p90: 2 * H, count: 1, open: 1 });

  assert.equal(a.autonomy.decided, 5, "one decision per job and PR: its last; OLD-1's came before the range");
  assert.deepEqual(a.autonomy.verdicts, { merge: 1, would_merge: 1, handover: 2, off: 1 });
  assert.equal(a.autonomy.handovers, 2);
  assert.deepEqual(a.autonomy.reasons, [
    { reason: "Conflicts with its base branch", count: 1 },
    { reason: "The factory's checks failed", count: 1 },
  ], "A-2's earlier handover on the same PR was replaced by its last; A-1's by its merge");

  const api = summarize(facts, { days: 7, now: NOW, timeZone: "UTC", repo: "o/api" });
  assert.equal(api.claimed, 1);
  assert.equal(api.spend.total, 10);
  assert.equal(api.autonomy.decided, 0);

  // The filter offers a repo with spend or a decision in the range though no job was claimed there.
  assert.deepEqual(
    [...rangeRepos(facts, { days: 7, now: NOW, timeZone: "UTC" })].sort(),
    [
      ["o/api", 1],
      ["o/docs", 0],
      ["o/infra", 0],
      ["o/web", 8],
    ],
  );
  assert.equal(summarize(facts, { days: 7, now: NOW, timeZone: "UTC", repo: "o/docs" }).spend.total, 1);

  assert.equal(summarize(facts, { days: 7, now: NOW, timeZone: "UTC", repo: null }).outcomes[0]!.day, "2026-10-25");
  assert.deepEqual(summarize(facts, { days: 7, now: Date.UTC(2026, 9, 30, 23, 30), timeZone: "Asia/Kolkata", repo: null }).days.at(-1), "2026-10-31");
  const india = summarize({ ...facts, jobs: facts.jobs.filter((j) => j.key === "LATE-1") }, { days: 7, now: NOW, timeZone: "Asia/Kolkata", repo: null });
  assert.equal(india.outcomes.at(-1)!.counts.failed, 1, "the day is the owner's");
  const utc = summarize({ ...facts, jobs: facts.jobs.filter((j) => j.key === "LATE-1") }, { days: 7, now: NOW, timeZone: "UTC", repo: null });
  assert.equal(utc.outcomes.at(-2)!.counts.failed, 1);
}

// --- Reading the facts from the database

const PREFIX = "analytics-regress-";
const KEYS = { merged: "ANLX-1", retried: "ANLX-2", old: "ANLX-3", off: "ANLX-4" };
const PR_OF = (n: number) => `https://github.com/o/r/pull/${900 + n}`;
try {
  const now = Date.now();
  const at = (minutes: number) => new Date(now + minutes * 60_000);
  await db.insert(jobs).values([
    linearJob(`${PREFIX}1`, KEYS.merged, {
      stage: "merged",
      stage_at: at(-10),
      claimed_at: at(-120),
      pr_url: PR_OF(1),
      provider: "claudeAgent",
      session_id: `${PREFIX}s1`,
      merge_decision: decision({ merged: { ...merged("auto"), at: at(-10).toISOString() } }),
    }),
    linearJob(`${PREFIX}2`, KEYS.retried, { stage: "pr", attempt: 2, claimed_at: at(-60), pr_url: PR_OF(2), provider: "codex" }),
    // Claimed long before the range, but a run started in it: its spend counts.
    linearJob(`${PREFIX}3`, KEYS.old, { stage: "implementing", claimed_at: at(-60 * 24 * 200) }),
    // Autonomy off; the owner's approval then failed at GitHub.
    linearJob(`${PREFIX}4`, KEYS.off, { stage: "pr", claimed_at: at(-60), pr_url: PR_OF(4), merge_decision: decision({ autonomy: "off", headSha: null, evaluatedAt: at(-40).toISOString() }) }),
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
  await db.insert(jobEvidence).values({
    job_key: KEYS.old,
    sha: `${PREFIX}sha`,
    attempt: 1,
    repo: "o/evidence",
    clean: true,
    producer: "agent",
    source: "recipe",
    checks: [],
    event_id: `${PREFIX}ev`,
    recorded_at: at(-4),
  });
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
  const audit = (id: string, n: number, minutes: number, head: string, detail: string, action: "merge_decided" | "merge_requested" = "merge_decided", actor = "factory") => ({
    id: `${PREFIX}${id}`,
    at: at(minutes),
    actor,
    action,
    job_id: jobId("linear", `${PREFIX}${n}`),
    target: PR_OF(n),
    head_sha: head,
    detail,
  });
  await db.insert(auditLog).values([
    audit("a1", 1, -80, "h1", "Pending · Waiting for checks."),
    audit("a2", 1, -20, "h1", "Merging (auto)"),
    audit("a3", 1, -5, "m", "Main stayed green after the factory's merge"),
    audit("a4", 2, -25, "h2", "Hand over · The agent isn't confident: unsure · maybe"),
    audit("a5", 2, -60 * 24 * 100, "h0", "Hand over · A check failed on the latest commit."),
    // Off decides at no head; the approval's refused merge is audited at the real head, at the approval's time.
    audit("a6", 4, -40, "", "Hand over"),
    audit("a7", 4, -15, "h4", "Approved in the inbox · via inbox", "merge_requested", "owner@example.com"),
    audit("a8", 4, -15, "h4", `Hand over · ${blockedReason("Resource not accessible by integration")}`),
  ]);

  const facts = await readAnalytics(db, at(-60 * 24 * 8));
  const mine = facts.jobs.filter((j) => j.key.startsWith("ANLX-"));
  assert.deepEqual(mine.map((j) => j.key).sort(), Object.values(KEYS).sort());
  const costs = await branchCosts(db, [attemptBranch(KEYS.merged, 1), attemptBranch(KEYS.retried, 1), attemptBranch(KEYS.retried, 2)]);
  const m = mine.find((j) => j.key === KEYS.merged)!;
  assert.equal(m.outcome, "merged_factory");
  assert.equal(m.usd, costs[attemptBranch(KEYS.merged, 1)]!.usd, "the cost branchCosts gives, as the cards and the spend limit see it");
  assert.equal(m.usd, 4 + 0.1);
  assert.equal(m.firstPrAt, at(-90).getTime());
  assert.deepEqual(m.waits, [], "a refused report never moved the job");
  const r = mine.find((j) => j.key === KEYS.retried)!;
  assert.equal(r.usd, costs[attemptBranch(KEYS.retried, 1)]!.usd + costs[attemptBranch(KEYS.retried, 2)]!.usd, "an earlier attempt's run from before the range still counts toward the job");
  assert.equal(r.costKnown, true);
  assert.equal(r.firstPrAt, at(-30).getTime());
  const spend = facts.spend.filter((s) => s.jobKey.startsWith("ANLX-"));
  assert.equal(spend.length, 5);
  assert.deepEqual(spend.filter((s) => s.jobKey === KEYS.retried).map((s) => s.harness).sort(), ["Codex", UNKNOWN_HARNESS]);
  assert.equal(spend.find((s) => s.jobKey === KEYS.old)!.repo, "o/evidence", "the attempt's evidence names its repo");
  const decided = facts.decisions.filter((d) => d.jobKey.startsWith("ANLX-"));
  assert.deepEqual(
    decided.map((d) => [d.jobKey, d.verdict, d.kinds.join("|")]).sort(),
    [
      [KEYS.merged, "merge", ""],
      [KEYS.retried, "handover", "The agent isn't confident"],
      [KEYS.off, "off", ""],
    ],
    "pending rows, a watch's end, decisions before `since` and an approval's refused merge are left out",
  );
  const offOnly = summarize(
    { ...facts, decisions: decided.filter((d) => d.jobKey === KEYS.off) },
    { days: 7, now, timeZone: "UTC", repo: null },
  );
  assert.deepEqual(offOnly.autonomy.verdicts, { merge: 0, would_merge: 0, handover: 0, off: 1 }, "the off PR counts once");

  console.log("analytics regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(auditLog).where(like(auditLog.id, `${PREFIX}%`));
  await db.delete(events).where(like(events.event_id, `${PREFIX}%`));
  await db.delete(jobEvidence).where(like(jobEvidence.event_id, `${PREFIX}%`));
  await db.delete(agents).where(like(agents.tool_use_id, `${PREFIX}%`));
  await db.delete(runs).where(like(runs.session_id, `${PREFIX}%`));
  await db.delete(jobs).where(inArray(jobs.key, Object.values(KEYS)));
  process.exit(process.exitCode ?? 0);
}
