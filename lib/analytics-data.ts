import { and, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { agents, auditLog, events, jobs, runs } from "../db/schema";
import { jobFacts, parseDecisionDetail, readSince, spendFacts, type AnalyticsFacts, type DecisionFact, type RangeDays } from "./analytics";

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
  const [runRows, stages, audit] = await Promise.all([
    keys.length ? db.select().from(runs).where(inArray(runs.job_key, keys)) : [],
    keys.length
      ? db
          .select({ job_key: sql<string>`${events.job_key}`, at: events.at, stage: sql<string>`${events.payload}->>'stage'` })
          .from(events)
          .where(and(eq(events.kind, "stage"), isNull(events.refusal), inArray(events.job_key, keys)))
      : [],
    db
      .select({ jobKey: jobs.key, repo: jobs.repo, at: auditLog.at, head: auditLog.head_sha, detail: auditLog.detail })
      .from(auditLog)
      .innerJoin(jobs, eq(jobs.id, auditLog.job_id))
      .where(and(eq(auditLog.action, "merge_decided"), gte(auditLog.at, since))),
  ]);
  const sessions = runRows.map((r) => r.session_id);
  const agentRows = sessions.length ? await db.select().from(agents).where(inArray(agents.session_id, sessions)) : [];
  const decisions = audit.flatMap(({ detail, at, ...row }): DecisionFact[] => {
    const parsed = parseDecisionDetail(detail);
    if (!parsed || parsed.verdict === "pending") return [];
    return [{ ...row, at: at.getTime(), verdict: parsed.verdict, reasons: parsed.reasons }];
  });
  return { jobs: jobFacts(jobRows, runRows, agentRows, stages), spend: spendFacts(jobRows, runRows, agentRows), decisions };
}

/** The facts for a range ending now, and that now, which the browser's summary counts back from. */
export async function readRange(db: Reader, days: RangeDays) {
  const now = Date.now();
  return { now, facts: await readAnalytics(db, readSince(now, days)) };
}
