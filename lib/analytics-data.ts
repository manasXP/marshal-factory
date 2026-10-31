import { and, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { agents, auditLog, events, jobEvidence, jobs, machines, runs } from "../db/schema";
import { decisionFacts, jobFacts, readSince, spendFacts, type AnalyticsFacts, type RangeDays } from "./analytics";
import { attemptBranch } from "./factory";
import { reportedHarnesses } from "./machine";
import { REPO_NAME } from "./repo-name";
import { branchCosts } from "./spend";

type Reader = Pick<NodePgDatabase<typeof schema>, "select" | "selectDistinct">;

/**
 * The facts the analytics page summarizes, from `since` on: every job claimed since or with a run
 * started since, with all its runs and their subagents (so a job's cost covers every attempt) and
 * the stage reports ingest didn't refuse, and every merge decision the factory made since. Every
 * repo, since the repo filter's counts need them all.
 */
export async function readAnalytics(db: Reader, since: Date): Promise<AnalyticsFacts> {
  const recent = db.selectDistinct({ key: runs.job_key }).from(runs).where(and(gte(runs.started_at, since), isNotNull(runs.job_key)));
  const jobRows = await db.select().from(jobs).where(or(gte(jobs.claimed_at, since), inArray(jobs.key, recent)));
  const keys = jobRows.map((j) => j.key);
  const branches = jobRows.flatMap((j) => Array.from({ length: j.attempt }, (_, i) => attemptBranch(j.key, i + 1)));
  const [runRows, stages, evidence, decisions, machineRows, costs] = await Promise.all([
    keys.length ? db.select().from(runs).where(inArray(runs.job_key, keys)) : [],
    keys.length
      ? db
          .select({ job_key: sql<string>`${events.job_key}`, at: events.at, stage: sql<string>`${events.payload}->>'stage'` })
          .from(events)
          .where(and(eq(events.kind, "stage"), isNull(events.refusal), inArray(events.job_key, keys)))
      : [],
    keys.length ? db.selectDistinct({ key: jobEvidence.job_key, attempt: jobEvidence.attempt, repo: jobEvidence.repo }).from(jobEvidence).where(inArray(jobEvidence.job_key, keys)) : [],
    db
      .select({ at: auditLog.at, head_sha: auditLog.head_sha, target: auditLog.target, detail: auditLog.detail, job: { key: jobs.key, repo: jobs.repo, pr_url: jobs.pr_url, merge_decision: jobs.merge_decision } })
      .from(auditLog)
      .innerJoin(jobs, eq(jobs.id, auditLog.job_id))
      .where(
        and(
          eq(auditLog.action, "merge_decided"),
          gte(auditLog.at, since),
          // An approval GitHub refused stores a handover at the approval's own time, right after its
          // merge_requested row (runner/merge-decision.ts approveMerge); that is the owner's, not the factory's.
          sql`not exists (select 1 from ${auditLog} as requested where requested.action = 'merge_requested' and requested.job_id = ${auditLog.job_id} and requested.head_sha = ${auditLog.head_sha} and requested.at = ${auditLog.at})`,
        ),
      ),
    db.select({ last_seen_at: machines.last_seen_at, inventory: machines.inventory }).from(machines),
    branchCosts(db, branches),
  ]);
  const sessions = runRows.map((r) => r.session_id);
  const agentRows = sessions.length ? await db.select().from(agents).where(inArray(agents.session_id, sessions)) : [];
  // Evidence names owner/name from the checkout's origin, or only its folder when it couldn't read one.
  const attemptRepos = new Map(evidence.filter((e) => REPO_NAME.test(e.repo)).map((e) => [`${e.key}:${e.attempt}`, e.repo]));
  return {
    jobs: jobFacts(jobRows, stages, costs),
    spend: spendFacts(jobRows, runRows, agentRows, reportedHarnesses(machineRows, 0) ?? [], attemptRepos),
    decisions: decisionFacts(decisions),
  };
}

/** The facts for a range ending now, and that now, which the browser's summary counts back from. */
export async function readRange(db: Reader, days: RangeDays) {
  const now = Date.now();
  return { now: now, facts: await readAnalytics(db, readSince(now, days)) };
}
