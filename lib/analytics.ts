import type { AgentRow, JobRow, RunRow } from "../db/schema";
import { attemptBranch, parseBranch } from "./factory";
import { harnessLabel, type Harness } from "./harness";
import { inboxKind } from "./inbox";
import { blockedReason, mergeDecisionSchema, REVIEW_LABEL } from "./merge-decision";
import { hasTokens, knownCostUsd } from "./pricing";
import type { BranchCost } from "./spend";

// The analytics page: what the factory finished, what it cost, how long it took and how often it
// merged on its own. The server turns rows into facts (plain numbers, so they reach the browser);
// the browser summarizes them for the chosen range in its own time zone, so a day is the owner's
// day. Pure, so the page and the regressions share it. The definitions are in docs/operations.md.

export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];
export const DEFAULT_RANGE: RangeDays = 30;

export const parseRange = (raw: unknown): RangeDays => RANGES.find((days) => String(days) === raw) ?? DEFAULT_RANGE;

/** Where a job stands now, for the jobs claimed in the range. Its current attempt decides. */
export const OUTCOMES = ["merged_factory", "merged_owner", "handed_over", "reverted", "stopped", "failed", "in_progress"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const OUTCOME_LABELS: Record<Outcome, string> = {
  merged_factory: "Merged by the factory",
  merged_owner: "Merged by you",
  handed_over: "Handed over",
  reverted: "Reverted after merge",
  stopped: "Stopped",
  failed: "Failed",
  in_progress: "In progress",
};

/** factory: the timer's own merge. approval: the factory merged it on your approval in the inbox or run detail. github: merged outside the factory. */
export type MergedBy = "factory" | "approval" | "github";

const parseDecision = (value: unknown) => mergeDecisionSchema.safeParse(value).data ?? null;

type OutcomeJob = Pick<JobRow, "key" | "stage" | "stage_at" | "updated_at" | "pr_url" | "merge_decision" | "dismissed_at" | "stop" | "execution">;

/** `mergedBy` is set for every merge, a reverted one too. */
export function jobOutcome(job: OutcomeJob): { outcome: Outcome; mergedBy: MergedBy | null } {
  const decision = parseDecision(job.merge_decision);
  switch (job.stage) {
    case "merged": {
      const merged = decision?.merged;
      // A merge recorded before `via` was kept is the owner's when an approval is on the decision.
      const via = merged && (merged.via ?? (decision.approvedBy ? "inbox" : "auto"));
      const mergedBy: MergedBy = !via ? "github" : via === "auto" ? "factory" : "approval";
      // Main went red after the merge: the watch reverted it, or tried to.
      const state = decision?.watch?.state;
      if (merged && (state === "reverted" || state === "revert_failed")) return { outcome: "reverted", mergedBy };
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
  /** Every attempt's spend, as lib/spend.ts's branchCosts prices it; unpriced tokens count 0. */
  usd: number;
  /** Every attempt that recorded runs has a known cost, and at least one did. */
  costKnown: boolean;
  /** The current attempt's first pr report, and its last one before the merge. */
  firstPrAt: number | null;
  lastPrAt: number | null;
  mergedAt: number | null;
  /** The current attempt's spells waiting on an answer; `end` is null while still unanswered. */
  waits: { start: number; end: number | null }[];
};

/** A stage report, from events: the job it moved, when, and to which stage. */
export type StageReport = { job_key: string; at: Date; stage: string };

function groupInto<T>(rows: readonly T[], key: (row: T) => string | null) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/** A job's spend over its attempts' branches, from branchCosts; an attempt without runs adds nothing. */
export function jobCost(job: Pick<JobRow, "key" | "attempt">, costs: Readonly<Record<string, BranchCost>>) {
  const spent = Array.from({ length: job.attempt }, (_, i) => costs[attemptBranch(job.key, i + 1)]).filter((c) => c !== undefined);
  return { usd: spent.reduce((sum, c) => sum + c.usd, 0), known: spent.length > 0 && spent.every((c) => c.known) };
}

/**
 * Spells in waiting. One ends when the answer reached the thread (jobs.answered_at, set as the
 * runner delivers it), else at the next report of another stage. Only the latest answer is kept,
 * so an earlier spell ends at that report, the first sign the thread had its answer. A question
 * reported after the answer starts a new spell; one reported again before it continues the spell.
 */
export function waitSpells(reports: readonly StageReport[], answeredAt: number | null, stillWaiting: boolean): JobFact["waits"] {
  const waits: JobFact["waits"] = [];
  const answered = (start: number, by: number) => answeredAt !== null && answeredAt >= start && answeredAt <= by;
  let start: number | null = null;
  for (const report of reports) {
    const at = report.at.getTime();
    if (report.stage === "waiting") {
      if (start !== null && answered(start, at)) {
        waits.push({ start, end: answeredAt });
        start = at;
      } else start ??= at;
    } else if (start !== null) {
      waits.push({ start, end: answered(start, at) ? answeredAt : at });
      start = null;
    }
  }
  if (start !== null && answeredAt !== null && answeredAt >= start) waits.push({ start, end: answeredAt });
  else if (start !== null && stillWaiting) waits.push({ start, end: null });
  return waits;
}

/** `stages` are the jobs' stage reports that ingest didn't refuse; `costs` is branchCosts over every attempt's branch. */
export function jobFacts(jobs: readonly JobRow[], stages: readonly StageReport[], costs: Readonly<Record<string, BranchCost>>): JobFact[] {
  const reportsByJob = groupInto(stages, (r) => r.job_key);
  return jobs.map((job) => {
    const { outcome, mergedBy } = jobOutcome(job);
    const claimedAt = job.claimed_at.getTime();
    // A retry's claim moves claimed_at, so reports from before it belong to an earlier attempt.
    const reports = (reportsByJob.get(job.key) ?? []).filter((r) => r.at.getTime() >= claimedAt).sort((a, b) => a.at.getTime() - b.at.getTime());
    const merged = parseDecision(job.merge_decision)?.merged;
    const mergedAt = job.stage !== "merged" ? null : merged ? Date.parse(merged.at) : (job.stage_at?.getTime() ?? null);
    const prs = reports.filter((r) => r.stage === "pr").map((r) => r.at.getTime());
    const prsBeforeMerge = mergedAt === null ? prs : prs.filter((at) => at <= mergedAt);
    const answeredAt = job.answered_at && job.answered_at.getTime() >= claimedAt ? job.answered_at.getTime() : null;
    const cost = jobCost(job, costs);
    return {
      key: job.key,
      title: job.title,
      repo: job.repo,
      sessionId: job.session_id,
      outcome,
      mergedBy,
      claimedAt,
      usd: cost.usd,
      costKnown: cost.known,
      firstPrAt: prs[0] ?? null,
      lastPrAt: prsBeforeMerge.at(-1) ?? null,
      mergedAt,
      waits: waitSpells(reports, answeredAt, job.stage === "waiting"),
    };
  });
}

/** One run or subagent with tokens: when its run started, on which harness and model, and its cost; null when its model has no price. */
export type SpendFact = { jobKey: string; repo: string; at: number; harness: string; model: string; usd: number | null };

/** Jobs keep the provider of their current attempt only, so an earlier attempt's harness is unknown. */
export const UNKNOWN_HARNESS = "Unknown harness";

/** The name the rest of the panel gives a provider: the machines' reported name, else the driver's label. */
export const harnessName = (provider: string, harnesses: readonly Harness[]) => harnesses.find((h) => h.id === provider)?.name ?? harnessLabel(provider);

/** owner/name from a GitHub pull request URL. */
export const prRepo = (url: string | null) => (url && /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/.exec(url)?.[1]) || null;

/**
 * `attemptRepos` maps `<key>:<attempt>` to the repo an attempt's evidence named. A run's repo is its
 * PR's, else its attempt's evidence's, else the job's: runs.repo is only the checkout's folder name,
 * and a retry may move the job to another repo.
 */
export function spendFacts(
  jobs: readonly JobRow[],
  runs: readonly RunRow[],
  agents: readonly AgentRow[],
  harnesses: readonly Harness[] = [],
  attemptRepos: ReadonlyMap<string, string> = new Map(),
): SpendFact[] {
  const bySession = groupInto(agents, (a) => a.session_id);
  const jobOf = new Map(jobs.map((job) => [job.key, job]));
  return runs.flatMap((run) => {
    const job = run.job_key ? jobOf.get(run.job_key) : undefined;
    if (!job) return [];
    const branch = parseBranch(run.branch ?? undefined);
    const attempt = branch?.key === job.key ? branch.attempt : null;
    const harness = attempt === job.attempt && job.provider ? harnessName(job.provider, harnesses) : UNKNOWN_HARNESS;
    const repo = prRepo(run.pr_url) ?? (attempt === null ? undefined : attemptRepos.get(`${job.key}:${attempt}`)) ?? job.repo;
    const rows: (RunRow | AgentRow)[] = [run, ...(bySession.get(run.session_id) ?? [])];
    return rows.filter(hasTokens).map((row) => ({
      jobKey: job.key,
      repo,
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
 * Reads a merge_decided audit row's detail, as runner/merge-service.ts writes it: the outcome, then
 * the reasons joined with " · ". `body` is everything after the outcome, unsplit, since a reason
 * may contain " · " itself. Null for the rows that end a post-merge watch.
 */
export function parseDecisionDetail(detail: string | null): { verdict: Verdict | "pending"; body: string } | null {
  if (!detail) return null;
  const sep = detail.indexOf(" · ");
  const [head, body] = sep < 0 ? [detail, ""] : [detail.slice(0, sep), detail.slice(sep + 3)];
  if (head === "Merging (auto)") return { verdict: "merge", body };
  if (head.startsWith("Would merge (")) return { verdict: "would_merge", body };
  if (head === "Pending") return { verdict: "pending", body };
  // Off decides nothing, so it hands over with no reason; trial and auto always give one.
  if (head === "Hand over") return { verdict: body === "" ? "off" : "handover", body };
  return null;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The handover reasons lib/merge-decision.ts, lib/trusted-checks.ts and the merge service give, by how each begins. */
const REASON_KINDS: readonly [string, string][] = [
  ["The agent isn't confident", "The agent isn't confident"],
  ["The agent didn't report an assessment", "No assessment from the agent"],
  [escape(`The issue has the "${REVIEW_LABEL}" label`), `The issue has the ${REVIEW_LABEL} label`],
  ["A check failed on the latest commit", "A check failed on the PR"],
  ["The pull request conflicts", "Conflicts with its base branch"],
  ["Bugbot didn't complete", "Bugbot didn't complete its review"],
  ["Bugbot has \\d+ unresolved", "Unresolved Bugbot findings"],
  ["The pull request changes UI files", "UI change without screenshots"],
  ["The pull request edits (?:the recipe|CI workflows|package\\.json|the check scripts)", "Edits what the checks trust"],
  ["No checks defined", "No checks defined for the repo"],
  ["Checks failed at ", "The factory's checks failed"],
  ["Not verified at ", "Not verified at the PR head"],
  ["[^·]*? didn't finish within \\d+ minutes\\.", "Timed out waiting on checks"],
  [escape(blockedReason("")), "GitHub refused the merge"],
];
const AT_START = REASON_KINDS.map(([pattern, kind]) => [new RegExp(`^${pattern}`), kind] as const);
const IN_DETAIL = REASON_KINDS.map(([pattern, kind]) => [new RegExp(`(?:^| · )${pattern}`), kind] as const);

export const reasonKind = (reason: string) => AT_START.find(([re]) => re.test(reason))?.[1] ?? "Other";

/** The kinds of one decision's reasons, each once. */
export const reasonKinds = (reasons: readonly string[]) => [...new Set(reasons.map(reasonKind))];

/** The kinds in an audit detail's reasons, each once, matched where a reason begins; Other when it names none. */
export function detailKinds(body: string) {
  const kinds = IN_DETAIL.filter(([re]) => re.test(body)).map(([, kind]) => kind);
  return kinds.length > 0 ? kinds : body ? ["Other"] : [];
}

/** A factory decision about one job's PR: the last that wasn't pending, as the audit log has it. */
export type DecisionFact = { jobKey: string; repo: string; pr: string; at: number; verdict: Verdict; kinds: string[] };

/** A merge_decided row, with the job it is about. */
export type DecisionRow = { at: Date; head_sha: string; target: string; detail: string | null; job: Pick<JobRow, "key" | "repo" | "pr_url" | "merge_decision"> };

/**
 * The factory's decisions from merge_decided rows; the caller leaves out the handovers an
 * approval's refused merge wrote. The reasons come from the job's stored decision when the row is
 * that decision (same PR, head and time, no approval), else from the detail's text.
 */
export function decisionFacts(rows: readonly DecisionRow[]): DecisionFact[] {
  return rows.flatMap(({ at, head_sha, target, detail, job }) => {
    const parsed = parseDecisionDetail(detail);
    if (!parsed || parsed.verdict === "pending") return [];
    const stored = parseDecision(job.merge_decision);
    const same = stored && !stored.approvedBy && job.pr_url === target && (stored.headSha ?? "") === head_sha && Date.parse(stored.evaluatedAt) === at.getTime();
    const kinds = parsed.verdict !== "handover" ? [] : same ? reasonKinds(stored.reasons) : detailKinds(parsed.body);
    return [{ jobKey: job.key, repo: prRepo(target) ?? job.repo, pr: target, at: at.getTime(), verdict: parsed.verdict, kinds }];
  });
}

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

/** The range's days and whether a time falls on one of them. */
export function rangeOf({ now, days: count, timeZone }: Omit<Scope, "repo">) {
  const days = rangeDays(now, count, timeZone);
  const keyOf = dayKeyer(timeZone);
  const [first, last] = [days[0]!, days.at(-1)!];
  return { days, keyOf, inRange: (ms: number) => keyOf(ms) >= first && keyOf(ms) <= last };
}

/** Every repo with a job claimed, a run started or a decision made in the range, and how many jobs it claimed. */
export function rangeRepos(facts: AnalyticsFacts, scope: Omit<Scope, "repo">) {
  const { inRange } = rangeOf(scope);
  const jobs = new Map<string, number>();
  for (const j of facts.jobs) if (inRange(j.claimedAt)) jobs.set(j.repo, (jobs.get(j.repo) ?? 0) + 1);
  for (const s of facts.spend) if (inRange(s.at)) jobs.set(s.repo, jobs.get(s.repo) ?? 0);
  for (const d of facts.decisions) if (inRange(d.at)) jobs.set(d.repo, jobs.get(d.repo) ?? 0);
  return jobs;
}

export const TOP_JOBS = 10;
export const TOP_REASONS = 8;

const isMerged = (j: JobFact) => j.outcome === "merged_factory" || j.outcome === "merged_owner";

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
    if (isMerged(job)) mergedBy[job.mergedBy!]++;
  }
  // A reverted merge ended, but not in success.
  const merged = totals.merged_factory + totals.merged_owner;
  const ended = merged + totals.reverted + totals.failed + totals.stopped;

  // Spend: every run with tokens that started in the range, on the day it started.
  const spendRows = facts.spend.filter((s) => inRepo(s.repo) && inRange(s.at));
  const byDay = new Map(days.map((day) => [day, { day, usd: 0, unpriced: 0 }]));
  for (const row of spendRows) {
    const day = byDay.get(keyOf(row.at))!;
    if (row.usd === null) day.unpriced++;
    else day.usd += row.usd;
  }
  const mergedJobs = jobs.filter(isMerged);
  const pricedMerged = mergedJobs.filter((j) => j.costKnown);

  // Speed: the same jobs as outcomes; a reverted merge still took its time to merge.
  const span = (from: number | null, to: number | null) => (from !== null && to !== null && to >= from ? [to - from] : []);
  const everMerged = jobs.filter((j) => j.mergedAt !== null);
  const prToMerge = (only: (j: JobFact) => boolean) => durations(everMerged.filter(only).flatMap((j) => span(j.firstPrAt, j.mergedAt)));
  const waits = jobs.flatMap((j) => j.waits);

  // Autonomy: per job and PR, the last decision the factory made in the range.
  const lastPerPr = new Map<string, DecisionFact>();
  for (const d of facts.decisions) {
    if (!inRepo(d.repo) || !inRange(d.at)) continue;
    const id = `${d.jobKey}\n${d.pr}`;
    const seen = lastPerPr.get(id);
    if (!seen || d.at >= seen.at) lastPerPr.set(id, d);
  }
  const decisions = [...lastPerPr.values()];
  const verdicts = Object.fromEntries(VERDICTS.map((v) => [v, decisions.filter((d) => d.verdict === v).length])) as Record<Verdict, number>;
  const handovers = decisions.filter((d) => d.verdict === "handover");
  const reasonCounts = new Map<string, number>();
  for (const d of handovers) for (const kind of d.kinds) reasonCounts.set(kind, (reasonCounts.get(kind) ?? 0) + 1);

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
        ...durations(everMerged.filter((j) => j.mergedBy !== "factory").flatMap((j) => span(j.lastPrAt, j.mergedAt))),
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
