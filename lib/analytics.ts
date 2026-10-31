import type { AgentRow, JobRow, RunRow } from "../db/schema";
import { attemptBranch } from "./factory";
import { harnessLabel } from "./harness";
import { inboxKind } from "./inbox";
import { blockedReason, mergeDecisionSchema, REVIEW_LABEL } from "./merge-decision";
import { costKnown, hasTokens, knownCostUsd } from "./pricing";

// The analytics page: what the factory finished, what it cost, how long it took and how often it
// merged on its own. The server turns rows into facts (plain numbers, so they reach the browser);
// the browser summarizes them for the chosen range in its own time zone, so a day is the owner's
// day. Pure, so the page and the regressions share it. The definitions are in docs/operations.md.

export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];
export const DEFAULT_RANGE: RangeDays = 30;

export const parseRange = (raw: unknown): RangeDays => RANGES.find((days) => String(days) === raw) ?? DEFAULT_RANGE;

/** Where a job stands now, for the jobs claimed in the range. Its current attempt decides. */
export const OUTCOMES = ["merged_factory", "merged_owner", "handed_over", "stopped", "failed", "in_progress"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const OUTCOME_LABELS: Record<Outcome, string> = {
  merged_factory: "Merged by the factory",
  merged_owner: "Merged by you",
  handed_over: "Handed over",
  stopped: "Stopped",
  failed: "Failed",
  in_progress: "In progress",
};

/** factory: the timer's own merge. approval: the factory merged it on your approval in the inbox or run detail. github: merged outside the factory. */
export type MergedBy = "factory" | "approval" | "github";

const parseDecision = (value: unknown) => mergeDecisionSchema.safeParse(value).data ?? null;

type OutcomeJob = Pick<JobRow, "key" | "stage" | "stage_at" | "updated_at" | "pr_url" | "merge_decision" | "dismissed_at" | "stop" | "execution">;

export function jobOutcome(job: OutcomeJob): { outcome: Outcome; mergedBy: MergedBy | null } {
  const decision = parseDecision(job.merge_decision);
  switch (job.stage) {
    case "merged": {
      const merged = decision?.merged;
      // A merge recorded before `via` was kept is the owner's when an approval is on the decision.
      const via = merged && (merged.via ?? (decision.approvedBy ? "inbox" : "auto"));
      const mergedBy: MergedBy = !via ? "github" : via === "auto" ? "factory" : "approval";
      return { outcome: mergedBy === "factory" ? "merged_factory" : "merged_owner", mergedBy };
    }
    case "failed":
      return { outcome: job.stop === null ? "failed" : "stopped", mergedBy: null };
    case "pr":
      // Handed over exactly when the inbox offers it for review; a pending decision is still the factory's.
      return { outcome: inboxKind(job, decision) === "handover" ? "handed_over" : "in_progress", mergedBy: null };
    case "queued":
    case "triage":
    case "investigating":
    case "implementing":
    case "verifying":
    case "waiting":
      return { outcome: "in_progress", mergedBy: null };
    default: {
      const never: never = job.stage;
      throw new Error(`unknown stage ${String(never)}`);
    }
  }
}

/** One job, as of its current attempt; cost covers every attempt. Times are epoch ms. */
export type JobFact = {
  key: string;
  title: string;
  repo: string;
  /** The current attempt's session, which run detail opens; null before a launch. */
  sessionId: string | null;
  outcome: Outcome;
  mergedBy: MergedBy | null;
  claimedAt: number;
  /** Every attempt's runs and subagents, priced; unpriced tokens count 0 and make the cost unknown. */
  usd: number;
  /** costKnown: some usage was recorded and every row with tokens has a price. */
  costKnown: boolean;
  /** The current attempt's first pr report, and its last one before the merge. */
  firstPrAt: number | null;
  lastPrAt: number | null;
  mergedAt: number | null;
  /** The current attempt's spells in waiting; `end` is null while it still waits. */
  waits: { start: number; end: number | null }[];
};

/** A stage report, from events: the job it moved, when, and to which stage. */
export type StageReport = { job_key: string; at: Date; stage: string };

type TokenRow = Parameters<typeof knownCostUsd>[0] & { model: string | null };

const runsByJob = (runs: readonly RunRow[]) => {
  const map = new Map<string, RunRow[]>();
  for (const run of runs) if (run.job_key) map.set(run.job_key, [...(map.get(run.job_key) ?? []), run]);
  return map;
};

const agentsBySession = (agents: readonly AgentRow[]) => {
  const map = new Map<string, AgentRow[]>();
  for (const agent of agents) map.set(agent.session_id, [...(map.get(agent.session_id) ?? []), agent]);
  return map;
};

function waitSpells(reports: readonly StageReport[], stillWaiting: boolean): JobFact["waits"] {
  const waits: JobFact["waits"] = [];
  let start: number | null = null;
  for (const report of reports) {
    if (report.stage === "waiting") start ??= report.at.getTime();
    else if (start !== null) {
      waits.push({ start, end: report.at.getTime() });
      start = null;
    }
  }
  if (start !== null && stillWaiting) waits.push({ start, end: null });
  return waits;
}

/** `stages` are the jobs' stage reports that ingest didn't refuse. */
export function jobFacts(jobs: readonly JobRow[], runs: readonly RunRow[], agents: readonly AgentRow[], stages: readonly StageReport[]): JobFact[] {
  const byJob = runsByJob(runs);
  const bySession = agentsBySession(agents);
  const reportsByJob = new Map<string, StageReport[]>();
  for (const report of stages) reportsByJob.set(report.job_key, [...(reportsByJob.get(report.job_key) ?? []), report]);
  return jobs.map((job) => {
    const { outcome, mergedBy } = jobOutcome(job);
    const rows: TokenRow[] = (byJob.get(job.key) ?? []).flatMap((run) => [run, ...(bySession.get(run.session_id) ?? [])]);
    const claimedAt = job.claimed_at.getTime();
    // A retry's claim moves claimed_at, so reports from before it belong to an earlier attempt.
    const reports = (reportsByJob.get(job.key) ?? []).filter((r) => r.at.getTime() >= claimedAt).sort((a, b) => a.at.getTime() - b.at.getTime());
    const merged = parseDecision(job.merge_decision)?.merged;
    const mergedAt = job.stage !== "merged" ? null : merged ? Date.parse(merged.at) : (job.stage_at?.getTime() ?? null);
    const prs = reports.filter((r) => r.stage === "pr").map((r) => r.at.getTime());
    const prsBeforeMerge = mergedAt === null ? prs : prs.filter((at) => at <= mergedAt);
    return {
      key: job.key,
      title: job.title,
      repo: job.repo,
      sessionId: job.session_id,
      outcome,
      mergedBy,
      claimedAt,
      usd: rows.reduce((sum, row) => sum + (knownCostUsd(row, row.model) ?? 0), 0),
      costKnown: costKnown(rows),
      firstPrAt: prs[0] ?? null,
      lastPrAt: prsBeforeMerge.at(-1) ?? null,
      mergedAt,
      waits: waitSpells(reports, job.stage === "waiting"),
    };
  });
}

/** One run or subagent with tokens: when its run started, on which harness and model, and its cost; null when its model has no price. */
export type SpendFact = { jobKey: string; repo: string; at: number; harness: string; model: string; usd: number | null };

/** Jobs keep the provider of their current attempt only, so an earlier attempt's harness is unknown. */
export const UNKNOWN_HARNESS = "Unknown harness";

export function spendFacts(jobs: readonly JobRow[], runs: readonly RunRow[], agents: readonly AgentRow[]): SpendFact[] {
  const bySession = agentsBySession(agents);
  const jobOf = new Map(jobs.map((job) => [job.key, job]));
  return runs.flatMap((run) => {
    const job = run.job_key ? jobOf.get(run.job_key) : undefined;
    if (!job) return [];
    const current = run.branch === attemptBranch(job.key, job.attempt);
    const harness = current && job.provider ? harnessLabel(job.provider) : UNKNOWN_HARNESS;
    const rows: TokenRow[] = [run, ...(bySession.get(run.session_id) ?? [])];
    return rows.filter(hasTokens).map((row) => ({
      jobKey: job.key,
      repo: job.repo,
      at: run.started_at.getTime(),
      harness,
      model: row.model ?? "unknown model",
      usd: knownCostUsd(row, row.model) ?? null,
    }));
  });
}

/** merge: cleared to merge under auto. would_merge: cleared under trial. off: autonomy off, nothing evaluated. */
export const VERDICTS = ["merge", "would_merge", "handover", "off"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_LABELS: Record<Verdict, string> = {
  merge: "Merge",
  would_merge: "Would merge (trial)",
  handover: "Hand over",
  off: "Not evaluated (off)",
};

/**
 * Reads a merge_decided audit row's detail, as runner/merge-service.ts writes it: the outcome,
 * then each reason, joined with " · ". Null for the rows that end a post-merge watch.
 */
export function parseDecisionDetail(detail: string | null): { verdict: Verdict | "pending"; reasons: string[] } | null {
  if (!detail) return null;
  const [head = "", ...reasons] = detail.split(" · ");
  if (head === "Merging (auto)") return { verdict: "merge", reasons };
  if (head.startsWith("Would merge (")) return { verdict: "would_merge", reasons };
  if (head === "Pending") return { verdict: "pending", reasons };
  // Off decides nothing, so it hands over with no reason; trial and auto always give one.
  if (head === "Hand over") return { verdict: reasons.length === 0 ? "off" : "handover", reasons };
  return null;
}

/** A settled factory decision about one PR head, from the audit log. */
export type DecisionFact = { jobKey: string; repo: string; at: number; head: string; verdict: Verdict; reasons: string[] };

const blocked = blockedReason("");

/** The handover reasons lib/merge-decision.ts, lib/trusted-checks.ts and the merge service give, without their particulars. */
const REASON_KINDS: readonly [(reason: string) => boolean, string][] = [
  [(r) => r.startsWith("The agent isn't confident"), "The agent isn't confident"],
  [(r) => r.startsWith("The agent didn't report an assessment"), "No assessment from the agent"],
  [(r) => r.startsWith(`The issue has the "${REVIEW_LABEL}" label`), `The issue has the ${REVIEW_LABEL} label`],
  [(r) => r.startsWith("A check failed on the latest commit"), "A check failed on the PR"],
  [(r) => r.startsWith("The pull request conflicts"), "Conflicts with its base branch"],
  [(r) => r.startsWith("Bugbot didn't complete"), "Bugbot didn't complete its review"],
  [(r) => /^Bugbot has \d+ unresolved/.test(r), "Unresolved Bugbot findings"],
  [(r) => r.startsWith("The pull request changes UI files"), "UI change without screenshots"],
  [(r) => /^The pull request edits (the recipe|CI workflows|package\.json|the check scripts)/.test(r), "Edits what the checks trust"],
  [(r) => r.startsWith("No checks defined"), "No checks defined for the repo"],
  [(r) => r.startsWith("Checks failed at "), "The factory's checks failed"],
  [(r) => r.startsWith("Not verified at "), "Not verified at the PR head"],
  [(r) => / didn't finish within \d+ minutes\.$/.test(r), "Timed out waiting on checks"],
  [(r) => r.startsWith(blocked), "GitHub refused the merge"],
];

export const reasonKind = (reason: string) => REASON_KINDS.find(([matches]) => matches(reason))?.[1] ?? "Other";

// --- summarizing for a range, in the browser's time zone

export type AnalyticsFacts = { jobs: JobFact[]; spend: SpendFact[]; decisions: DecisionFact[] };
export type Scope = { days: RangeDays; now: number; timeZone: string; repo: string | null };

/** Median and 90th percentile in ms, over `count` values; null with none. */
export type Durations = { median: number | null; p90: number | null; count: number };
export type Share = { label: string; usd: number; unpriced: number };

const DAY_MS = 86_400_000;

/** YYYY-MM-DD in the zone, so keys sort as days do. */
export function dayKeyer(timeZone: string) {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (ms: number) => format.format(ms);
}

/** The range's days, oldest first, ending today in the zone. Calendar arithmetic, so no day is skipped or doubled around a clock change. */
export function rangeDays(now: number, days: number, timeZone: string) {
  const [y, m, d] = dayKeyer(timeZone)(now).split("-").map(Number);
  return Array.from({ length: days }, (_, i) => new Date(Date.UTC(y!, m! - 1, d! - (days - 1 - i))).toISOString().slice(0, 10));
}

/** Linear interpolation between closest ranks. */
function quantile(sorted: readonly number[], q: number) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function durations(values: readonly number[]): Durations {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), count: sorted.length };
}

const zeroOutcomes = () => Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;

function shares(rows: readonly SpendFact[], label: (row: SpendFact) => string): Share[] {
  const map = new Map<string, Share>();
  for (const row of rows) {
    const share = map.get(label(row)) ?? { label: label(row), usd: 0, unpriced: 0 };
    if (row.usd === null) share.unpriced++;
    else share.usd += row.usd;
    map.set(share.label, share);
  }
  return [...map.values()].sort((a, b) => b.usd - a.usd || a.label.localeCompare(b.label));
}

export const TOP_JOBS = 10;
export const TOP_REASONS = 8;

/** The range's days and whether a time falls on one of them. */
export function rangeOf({ now, days: count, timeZone }: Omit<Scope, "repo">) {
  const days = rangeDays(now, count, timeZone);
  const keyOf = dayKeyer(timeZone);
  const [first, last] = [days[0]!, days.at(-1)!];
  return { days, keyOf, inRange: (ms: number) => keyOf(ms) >= first && keyOf(ms) <= last };
}

export function summarize(facts: AnalyticsFacts, scope: Scope) {
  const { days, keyOf, inRange } = rangeOf(scope);
  const inRepo = (repo: string) => scope.repo === null || repo === scope.repo;

  // Outcomes: the jobs claimed in the range, by the day of their current attempt's claim.
  const jobs = facts.jobs.filter((j) => inRepo(j.repo) && inRange(j.claimedAt));
  const perDay = new Map(days.map((day) => [day, zeroOutcomes()]));
  const totals = zeroOutcomes();
  const mergedBy: Record<MergedBy, number> = { factory: 0, approval: 0, github: 0 };
  for (const job of jobs) {
    perDay.get(keyOf(job.claimedAt))![job.outcome]++;
    totals[job.outcome]++;
    if (job.mergedBy) mergedBy[job.mergedBy]++;
  }
  const merged = totals.merged_factory + totals.merged_owner;
  const ended = merged + totals.failed + totals.stopped;

  // Spend: every run with tokens that started in the range, on the day it started.
  const spendRows = facts.spend.filter((s) => inRepo(s.repo) && inRange(s.at));
  const byDay = new Map(days.map((day) => [day, { day, usd: 0, unpriced: 0 }]));
  for (const row of spendRows) {
    const day = byDay.get(keyOf(row.at))!;
    if (row.usd === null) day.unpriced++;
    else day.usd += row.usd;
  }
  const mergedJobs = jobs.filter((j) => j.mergedBy !== null);
  const pricedMerged = mergedJobs.filter((j) => j.costKnown);

  // Speed: the same jobs as outcomes.
  const span = (from: number | null, to: number | null) => (from !== null && to !== null && to >= from ? [to - from] : []);
  const prToMerge = (only: (j: JobFact) => boolean) => durations(mergedJobs.filter(only).flatMap((j) => span(j.firstPrAt, j.mergedAt)));
  const waits = jobs.flatMap((j) => j.waits);

  // Autonomy: per PR head, the last settled decision the factory made in the range.
  const lastPerHead = new Map<string, DecisionFact>();
  for (const d of facts.decisions) {
    if (!inRepo(d.repo) || !inRange(d.at)) continue;
    const id = `${d.jobKey}\n${d.head}`;
    const seen = lastPerHead.get(id);
    if (!seen || d.at >= seen.at) lastPerHead.set(id, d);
  }
  const decisions = [...lastPerHead.values()];
  const verdicts = Object.fromEntries(VERDICTS.map((v) => [v, decisions.filter((d) => d.verdict === v).length])) as Record<Verdict, number>;
  const handovers = decisions.filter((d) => d.verdict === "handover");
  const reasonCounts = new Map<string, number>();
  // A decision counts once per kind, however many of its reasons share it.
  for (const d of handovers) for (const kind of new Set(d.reasons.map(reasonKind))) reasonCounts.set(kind, (reasonCounts.get(kind) ?? 0) + 1);

  return {
    days,
    outcomes: days.map((day) => ({ day, counts: perDay.get(day)! })),
    totals,
    mergedBy,
    claimed: jobs.length,
    success: { merged, ended, rate: ended === 0 ? null : merged / ended },
    spend: {
      total: spendRows.reduce((sum, s) => sum + (s.usd ?? 0), 0),
      unpriced: spendRows.filter((s) => s.usd === null).length,
      byDay: [...byDay.values()],
      byRepo: shares(spendRows, (s) => s.repo),
      byHarness: shares(spendRows, (s) => `${s.harness} · ${s.model}`),
      topJobs: jobs
        .filter((j) => j.usd > 0)
        .sort((a, b) => b.usd - a.usd || a.key.localeCompare(b.key))
        .slice(0, TOP_JOBS),
      unknownJobs: jobs.filter((j) => !j.costKnown).length,
      mergedAverage: {
        usd: pricedMerged.length === 0 ? null : pricedMerged.reduce((sum, j) => sum + j.usd, 0) / pricedMerged.length,
        known: pricedMerged.length,
        merged: mergedJobs.length,
      },
    },
    speed: {
      claimToPr: durations(jobs.flatMap((j) => span(j.claimedAt, j.firstPrAt))),
      prToMerge: prToMerge(() => true),
      prToMergeFactory: prToMerge((j) => j.mergedBy === "factory"),
      prToMergeOwner: prToMerge((j) => j.mergedBy !== "factory"),
      answerWait: { ...durations(waits.flatMap((w) => span(w.start, w.end))), open: waits.filter((w) => w.end === null).length },
      reviewWait: {
        ...durations(mergedJobs.filter((j) => j.mergedBy !== "factory").flatMap((j) => span(j.lastPrAt, j.mergedAt))),
        open: totals.handed_over,
      },
    },
    autonomy: {
      decided: decisions.length,
      verdicts,
      handovers: handovers.length,
      reasons: [...reasonCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
        .slice(0, TOP_REASONS),
    },
  };
}

export type Analytics = ReturnType<typeof summarize>;

/** How far back the server reads for a range: a day more than it spans, so any time zone's first day is whole. */
export const readSince = (now: number, days: RangeDays) => new Date(now - (days + 1) * DAY_MS);
