import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { auditLog, jobEvidence, jobs, type AuditRow, type RepoSettingsRow } from "../db/schema";
import { parseAssessment } from "../lib/assessment";
import { isCloud } from "../lib/execution";
import { headEvidence, type EvidenceRow, type HeadEvidence, type PlannedCheck } from "../lib/evidence";
import { parseDetail } from "../lib/onboarding";
import { CHECKS, type Recipe } from "../lib/recipe";
import { scriptsOf, trustedEdits } from "../lib/trusted-checks";
import type { ApproveDetail } from "../lib/inbox";
import type { RepoName } from "../lib/github/app";
import { github } from "../lib/github/pulls";
import {
  approvalBlockers,
  blockedReason,
  decideMerge,
  OFF_DECISION,
  type Decision,
  type MergeDecision,
  type PrFacts,
  type RepoPolicy,
  type ReviewSummary,
  reviewSummary,
  type RunnerVerification,
  type RunnerVerificationRecord,
} from "../lib/merge-decision";
import { readRepoSettings, resolvePolicy } from "../lib/settings";
import { parseJob, parseJobs, sourceFor } from "../lib/sources";
import type { Job, JobId } from "../lib/sources/types";
import { thisMachine } from "./heartbeat";
import { mergeNow, recoverMerges, storeDecision, storedDecision, syncComments } from "./merge-service";
import { config } from "./config";
import { ingestClient } from "./ops";
import { runnerVerification, startVerification } from "./verify";

// The timer's pass over this machine's jobs in pr: decides whether each PR merges on its own and
// stores the decision on the job. GitHub and the source only; a hibernated sandbox stays asleep.
// A settled decision is read again when the head, the report or the autonomy changes, or after
// RECHECK_MS; a pending one, and a merge under auto, every pass. The audit log gets a row only
// when the decision changes. Under auto a merge decision merges at once, on facts read in the
// same pass, through runner/merge-service.ts; a refusal hands over and is not retried for that
// head. The owner's approval, from the inbox or run detail, merges through the same service.
// Each pass also reads the attempt's evidence (job_evidence) for the PR head: no merge without
// checks passed at exactly that commit. Under auto, when that is all that is missing, the runner
// verifies the head itself in the job's sandbox (runner/verify.ts) and the decision waits for it.

export const RECHECK_MS = 15 * 60_000;

/** `seenAt` is when the factory first saw this head, so a repo without CI is told from CI that hasn't started. */
async function prFacts(prUrl: string, repo: RepoName, headSha: string, baseRef: string, mergeable: PrFacts["mergeable"], seenAt?: number): Promise<PrFacts> {
  const [files, state, findings] = await Promise.all([
    github.pullFiles(prUrl),
    github.checkState(repo, headSha, { baseRef, seenAt, graceMs: config.factory.noCiGraceMinutes * 60_000 }),
    github.bugbotFindings(prUrl),
  ]);
  return { headSha, mergeable, files, checks: state.checks, bugbot: { review: state.bugbot, findings } };
}

type Evaluated =
  | { decision: Decision; headSha: string | null; headSeenAt: number | null; review?: ReviewSummary; evidence?: HeadEvidence; runner?: RunnerVerification }
  | "unchanged";

/** The checks, with their commands, a repo's recorded recipe requires; null when the factory knows no recipe for it. */
export function requiredChecks(rows: readonly RepoSettingsRow[], repo: string): { recipe: Recipe | null; required: PlannedCheck[] | null } {
  const recipe = parseDetail(rows.find((r) => r.repo === repo)?.onboarding_detail).recipe ?? null;
  return { recipe, required: recipe ? CHECKS.flatMap((name) => (recipe.checks[name] ? [{ name, command: recipe.checks[name] }] : [])) : null };
}

/** This attempt's evidence, one row per commit. */
async function attemptEvidence(job: Job): Promise<EvidenceRow[]> {
  const rows = await db
    .select()
    .from(jobEvidence)
    .where(and(eq(jobEvidence.job_key, job.key), eq(jobEvidence.attempt, job.attempt)));
  return rows.map((r) => ({ sha: r.sha, clean: r.clean, producer: r.producer, source: r.source, checks: r.checks, recordedAt: r.recorded_at }));
}

/** Whether the PR edits what the trusted checks depend on; package.json is read at the base branch and at the head only when the PR touches it. */
async function changedTrust(job: Job, detail: { headSha: string; baseRef: string }, pr: PrFacts, required: PlannedCheck[] | null) {
  const files = pr.files.map((f) => f.path);
  const [base, head] = files.includes("package.json")
    ? await Promise.all([detail.baseRef, detail.headSha].map((ref) => github.fileAt(job.repo as RepoName, "package.json", ref).then(scriptsOf, () => null)))
    : [null, null];
  return trustedEdits({ files, required, base, head });
}

const sameEvidence = (a: HeadEvidence | undefined, b: HeadEvidence) => JSON.stringify(a) === JSON.stringify(b);

async function evaluate(job: Job, policy: RepoPolicy, previous: MergeDecision | null, now: number, required: PlannedCheck[] | null): Promise<Evaluated> {
  const sameReport = previous !== null && previous.autonomy === policy.autonomy && previous.stageEventId === job.stage_event_id;
  if (policy.autonomy === "off") {
    return sameReport ? "unchanged" : { decision: OFF_DECISION, headSha: null, headSeenAt: null };
  }
  const detail = await github.pullDetail(job.pr_url!);
  // A merged or closed PR is checkPullRequests' to follow.
  if (detail.state !== "open") return "unchanged";
  const sameHead = previous?.headSha === detail.headSha;
  const fresh = previous !== null && now - Date.parse(previous.evaluatedAt) < RECHECK_MS;
  const unsettled = previous?.outcome === "pending" || (previous?.outcome === "merge" && previous.autonomy === "auto");
  const evidence = headEvidence(await attemptEvidence(job), detail.headSha, required);
  if (sameReport && sameHead && fresh && !unsettled && sameEvidence(previous.evidence, evidence)) return "unchanged";
  const runner = runnerVerification(job, detail.headSha, policy, previous, now);

  const headSeenAt = sameHead && previous.headSeenAt ? Date.parse(previous.headSeenAt) : now;
  const [pr, labels] = await Promise.all([
    prFacts(job.pr_url!, job.repo as RepoName, detail.headSha, detail.baseRef, detail.mergeable, headSeenAt),
    sourceFor(job.source).labels(job),
  ]);
  const decision = decideMerge({
    policy,
    assessment: parseAssessment(job.merge_assessment),
    labels,
    pr,
    headSeenAt,
    now,
    evidence,
    runner,
    browser: isCloud(job.execution),
    trustEdits: await changedTrust(job, detail, pr, required),
  });
  return { decision, headSha: detail.headSha, headSeenAt, review: reviewSummary(pr), evidence, runner };
}

/** The runner's verification record for this head: failed once it couldn't, running once it started. */
function verificationRecord(job: Job, previous: MergeDecision | null, result: Exclude<Evaluated, "unchanged">, recipe: Recipe | null, now: number): RunnerVerificationRecord | undefined {
  const sha = result.headSha;
  if (!sha) return undefined;
  const kept = previous?.verification?.sha === sha ? previous.verification : undefined;
  if (result.runner?.kind === "failed") return { sha, at: kept?.at ?? new Date(now).toISOString(), state: "failed", reason: result.runner.reason };
  if (result.decision.verify && startVerification(job, sha, recipe, (event) => ingestClient.post(event))) return { sha, at: new Date(now).toISOString(), state: "running" };
  return kept;
}

export async function decideMerges({ now = Date.now(), only }: { now?: number; only?: string[] } = {}) {
  const machine = await thisMachine();
  const changed: string[] = [];
  const errors: { key: string; error: string }[] = [];
  await recoverMerges(machine.id, only, now, changed, errors);
  const rows = parseJobs(
    await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.machine_id, machine.id), eq(jobs.stage, "pr"), isNotNull(jobs.pr_url), only ? inArray(jobs.key, only) : undefined)),
  );
  if (rows.length === 0) return errors.length > 0 ? { changed, errors } : changed;
  const policies = await readRepoSettings(db);
  for (const job of rows) {
    try {
      const policy = resolvePolicy(policies, job.repo);
      const previous = storedDecision(job);
      const { recipe, required } = requiredChecks(policies, job.repo);
      const result = await evaluate(job, policy, previous, now, required);
      if (result === "unchanged") {
        if (previous) await syncComments(job, previous);
        continue;
      }
      // GitHub refused this head before; asking again would only be refused again.
      const blocked = previous?.blocked && previous.headSha === result.headSha ? previous.blocked : undefined;
      const decided = { outcome: result.decision.outcome, reasons: result.decision.reasons };
      const decision = blocked && decided.outcome === "merge" && policy.autonomy === "auto" ? { outcome: "handover" as const, reasons: [blockedReason(blocked)] } : decided;
      const verification = verificationRecord(job, previous, result, recipe, now);
      const next: MergeDecision = {
        ...decision,
        autonomy: policy.autonomy,
        evaluatedAt: new Date(now).toISOString(),
        headSha: result.headSha,
        headSeenAt: result.headSeenAt === null ? null : new Date(result.headSeenAt).toISOString(),
        stageEventId: job.stage_event_id,
        ...(blocked && { blocked }),
        ...(previous?.comments && { comments: previous.comments }),
        ...(result.review && { review: result.review }),
        ...(result.evidence && { evidence: result.evidence }),
        ...(verification && { verification }),
      };
      const stored = await storeDecision(job, previous, next);
      if (stored === "gone") continue;
      if (stored === "changed") changed.push(`${job.key}:${next.outcome}`);
      let current = next;
      if (next.outcome === "merge" && next.autonomy === "auto") {
        const merged = await mergeNow(job, next, "auto", now);
        if (merged) {
          current = merged;
          changed.push(`${job.key}:${merged.merged ? "merged" : merged.outcome}`);
        }
      }
      await syncComments(job, current);
    } catch (error) {
      errors.push({ key: job.key, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return errors.length > 0 ? { changed, errors } : changed;
}

export type Approval = { merged: string } | { blocked: string } | { refused: string };

const APPROVED_IN = { inbox: "the inbox", run_detail: "run detail" } as const satisfies Record<ApproveDetail["via"], string>;

/**
 * Merges a PR the owner approved in the inbox or in run detail, through the merge service like
 * auto. The agent's and the policy's reasons are the owner's to overrule; facts about the PR still
 * stop it. Every attempt on a job's PR is audited for the owner: merge_requested before GitHub is
 * asked, merge_failed when it stops. A replay after the merge finds it recorded and changes nothing.
 */
export async function approveMerge(id: JobId, { actor, headSha, via }: ApproveDetail, now = Date.now()): Promise<Approval> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!row) return { refused: `No job ${id}.` };
  const job = parseJob(row);
  const audit = (action: AuditRow["action"], result: AuditRow["result"], head: string, detail: string) =>
    db.insert(auditLog).values({ id: randomUUID(), at: new Date(now), actor, action, job_id: job.id, target: job.pr_url ?? job.url, head_sha: head, result, detail: `${detail} · via ${via}`.slice(0, 2000) });
  const stop = async (result: Exclude<AuditRow["result"], "ok" | null>, head: string, outcome: Approval & ({ blocked: string } | { refused: string })) => {
    await audit("merge_failed", result, head, "blocked" in outcome ? outcome.blocked : outcome.refused);
    return outcome;
  };

  const previous = storedDecision(job);
  if (previous?.merged) return { merged: previous.merged.sha };
  if (job.stage !== "pr" || !job.pr_url) return stop("refused", headSha ?? "", { refused: `The job is in ${job.stage}, not waiting on a pull request.` });
  const detail = await github.pullDetail(job.pr_url);
  if (detail.state !== "open") return stop("refused", detail.headSha, { refused: `The pull request is already ${detail.state}.` });
  if (headSha && detail.headSha !== headSha) {
    return stop("head_moved", headSha, { refused: `The pull request moved to ${detail.headSha.slice(0, 7)} since you reviewed ${headSha.slice(0, 7)}. Review the new commit first.` });
  }
  const seenAt = previous?.headSha === detail.headSha && previous.headSeenAt ? Date.parse(previous.headSeenAt) : undefined;
  const pr = await prFacts(job.pr_url, job.repo as RepoName, detail.headSha, detail.baseRef, detail.mergeable, seenAt);
  const blockers = approvalBlockers(pr);
  if (blockers.length > 0) return stop("not_mergeable", detail.headSha, { blocked: blockers.join(" ") });
  const policy = resolvePolicy(await readRepoSettings(db), job.repo);
  const iso = new Date(now).toISOString();
  const approved: MergeDecision = {
    ...previous,
    outcome: "merge",
    reasons: [`Approved in ${APPROVED_IN[via]} by ${actor}.`],
    autonomy: policy.autonomy,
    evaluatedAt: iso,
    headSha: detail.headSha,
    headSeenAt: previous?.headSha === detail.headSha ? previous.headSeenAt : iso,
    stageEventId: job.stage_event_id,
    review: reviewSummary(pr),
    approvedBy: actor,
    blocked: undefined,
    merging: undefined,
  };
  await audit("merge_requested", null, detail.headSha, `Approved in ${APPROVED_IN[via]}`);
  const merged = await mergeNow(job, approved, via, now);
  if (merged?.merged) return { merged: merged.merged.sha };
  if (merged) return stop("refused", detail.headSha, { blocked: merged.reasons.join(" ") });
  // The timer's own pass may have merged this head first.
  const [after] = await db.select().from(jobs).where(eq(jobs.id, id));
  const recorded = after && storedDecision(parseJob(after))?.merged;
  if (recorded) return { merged: recorded.sha };
  return stop("head_moved", detail.headSha, { refused: "The pull request changed while it was merging. Review it again." });
}
