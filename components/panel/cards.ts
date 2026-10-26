import type { JobRow, RunRow } from "@/db/schema";
import type { Stage } from "@/lib/events";
import { attemptBranch } from "@/lib/factory";
import { isTracked } from "@/lib/harness";
import { sourceLink } from "@/lib/sources/shapes";
import { groupBy } from "./format";

/** One board card: a claimed job, or a staged run whose job the factory never claimed. */
export type BoardCard = {
  id: string;
  jobKey: string | null;
  title: string;
  stage: Stage;
  summary: string | null;
  question: string | null;
  prUrl: string | null;
  sourceLink: { label: string; href: string } | null;
  budgetUsd: number | null;
  machineId: string | null;
  answeredAt: Date | null;
  attempt: number;
  /** The runs of the current attempt; spend against the cap counts only these. */
  attemptRuns: RunRow[];
  /** Set while the watchdog's nudge for the current stage is outstanding. */
  nudgedAt: Date | null;
  /** The run the card opens; null while a claimed job has no session yet. */
  latest: RunRow | null;
  runs: RunRow[];
  /** Set when the job runs on a harness that reports no stages or cost, so the card says so. */
  untracked: { provider: string; model: string | null } | null;
};

const stagedAt = (run: RunRow) => run.stage_at?.getTime() ?? 0;

/** `drivers` maps provider instance ids to their driver, so a renamed Claude Code instance stays tracked. */
export function boardCards(
  jobs: readonly JobRow[],
  runs: readonly RunRow[],
  drivers: ReadonlyMap<string, string> = new Map(),
): BoardCard[] {
  const byKey = groupBy(
    runs.filter((r) => r.job_key !== null),
    (r) => r.job_key!,
  );
  const newestFirst = (rows: readonly RunRow[]) =>
    [...rows].sort((a, b) => stagedAt(b) - stagedAt(a));

  const fromJobs = jobs.map((job): BoardCard => {
    const jobRuns = newestFirst(byKey.get(job.key) ?? []);
    const attemptRuns = jobRuns.filter((r) => r.branch === attemptBranch(job.key, job.attempt));
    return {
      id: job.key,
      jobKey: job.key,
      title: job.title,
      stage: job.stage,
      summary: job.stage_summary,
      question: job.question,
      prUrl: job.pr_url,
      sourceLink: sourceLink(job),
      budgetUsd: job.budget_usd,
      machineId: job.machine_id,
      answeredAt: job.answered_at,
      attempt: job.attempt,
      attemptRuns,
      nudgedAt: job.nudged_stage === job.stage ? job.nudged_at : null,
      latest: attemptRuns.find((r) => r.session_id === job.session_id) ?? attemptRuns[0] ?? null,
      runs: jobRuns,
      untracked:
        job.provider && !isTracked(drivers.get(job.provider) ?? job.provider)
          ? { provider: job.provider, model: job.model }
          : null,
    };
  });

  const claimed = new Set(jobs.map((j) => j.key));
  const unclaimed = runs.filter(
    (r): r is RunRow & { stage: Stage } =>
      r.stage !== null && !(r.job_key && claimed.has(r.job_key)),
  );
  const fromRuns = [...groupBy(unclaimed, (r) => r.job_key ?? r.session_id).entries()].map(
    ([id, group]): BoardCard => {
      const sorted = newestFirst(group);
      const latest = sorted[0]! as RunRow & { stage: Stage };
      return {
        id,
        jobKey: latest.job_key,
        title: latest.title ?? latest.job_key ?? "Factory run",
        stage: latest.stage,
        summary: latest.stage_summary,
        question: latest.question,
        prUrl: sorted.find((r) => r.pr_url)?.pr_url ?? null,
        sourceLink: null,
        budgetUsd: null,
        machineId: null,
        answeredAt: null,
        attempt: 1,
        attemptRuns: sorted,
        nudgedAt: null,
        latest,
        runs: sorted,
        untracked: null,
      };
    },
  );
  return [...fromJobs, ...fromRuns];
}
