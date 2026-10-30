import type { JobRow, MachineRow, RunRow } from "@/db/schema";
import { splitArchived } from "@/lib/archive";
import type { Stage } from "@/lib/events";
import { cloudOfSandbox, isCloud, sandboxState, type CloudExecution, type SandboxState } from "@/lib/execution";
import { evidenceLine, parseSummary, type EvidenceLine } from "@/lib/evidence";
import { attemptBranch, isMcpSession } from "@/lib/factory";
import { harnessLabel, isTracked, type Harness, type Tracking } from "@/lib/harness";
import { parseInventory, UNKNOWN } from "@/lib/machine";
import { costKnown } from "@/lib/pricing";
import { mergeDecisionSchema, type MergeDecision } from "@/lib/merge-decision";
import { sourceLink, type JobId } from "@/lib/sources/shapes";
import { parseStop, stopView, type StopView } from "@/lib/stop";
import { groupBy } from "./format";

/** One board card: a claimed job, or a staged run whose job the factory never claimed. */
export type BoardCard = {
  id: string;
  /** The claimed job's id; null for a run the factory never claimed. */
  jobId: JobId | null;
  jobKey: string | null;
  title: string;
  /** The GitHub repo the job runs in; for a run the factory never claimed, whatever the run reported. */
  repo: string | null;
  stage: Stage;
  summary: string | null;
  question: string | null;
  prUrl: string | null;
  sourceLink: { label: string; href: string } | null;
  machineId: string | null;
  answeredAt: Date | null;
  attempt: number;
  /** The runs of the current attempt; the card's spend counts only these. */
  attemptRuns: RunRow[];
  /** Set while the watchdog's nudge for the current stage is outstanding. */
  nudgedAt: Date | null;
  /** The run the card opens; null while a claimed job has no session yet. */
  latest: RunRow | null;
  runs: RunRow[];
  /** The harness the current attempt launched on; null before a launch. */
  harness: CardHarness | null;
  /** Where the current attempt runs; null before a launch. */
  runsOn: RunsOn | null;
  /** The runner's merge decision while the job is in pr, or once the factory merged it. */
  mergeDecision: MergeDecision | null;
  /** What was verified at which commit, apart from the stage the agent reported; null when there is nothing to say. */
  evidence: EvidenceLine | null;
  /** Where the attempt's stop is, and the thread it went to; null for a job never stopped. */
  stop: { view: StopView; thread: string | null } | null;
  /** The newest change to the job or any of its runs. */
  updatedAt: Date;
};

/** The T3 environment a machine's inventory names, for links into its T3; null when unknown. */
export function t3EnvironmentId(machine: Pick<MachineRow, "inventory"> | undefined) {
  const t3 = machine && parseInventory(machine.inventory)?.t3;
  return t3 && t3 !== UNKNOWN ? t3.environmentId : null;
}

/** What the card can show of the harness's run: a Codex job whose report server posted has stages, and its cost once the runner read a priced usage. */
export type CardHarness = { name: string; tracking: Tracking };

export type RunsOn = { kind: "cloud"; cloud: CloudExecution; sandbox: SandboxState | null } | { kind: "local"; machineId: string };

const CLOUD_LABELS: Record<CloudExecution, string> = { modal: "Cloud sandbox", upstash: "Upstash Box" };

export function runsOn(job: Pick<JobRow, "execution" | "machine_id" | "sandbox_id" | "sandbox_snapshot">): RunsOn | null {
  const sandbox = sandboxState(job);
  const id = job.sandbox_id ?? job.sandbox_snapshot;
  // A launch records its execution; a sandbox whose job predates that names its cloud by its id.
  const cloud = isCloud(job.execution) ? job.execution : id ? cloudOfSandbox(id) : null;
  if (cloud) return { kind: "cloud", cloud, sandbox };
  return job.machine_id ? { kind: "local", machineId: job.machine_id } : null;
}

export function whereLine(where: RunsOn, machineName: string | null) {
  switch (where.kind) {
    case "cloud":
      return CLOUD_LABELS[where.cloud];
    case "local":
      return `Local · ${machineName ?? where.machineId}`;
    default: {
      const never: never = where;
      throw new Error(`unknown place ${String(never)}`);
    }
  }
}

export function harnessLine(harness: CardHarness) {
  switch (harness.tracking) {
    case "full":
      return harness.name;
    case "stages":
      return `${harness.name} · cost unknown`;
    case "none":
      return `${harness.name} · not tracked`;
    default: {
      const never: never = harness.tracking;
      throw new Error(`unknown tracking ${String(never)}`);
    }
  }
}

/** A tracked job in pr waits on a merge decision; a merged one shows the factory's watch on main. */
export const showsDecision = (card: Pick<BoardCard, "stage" | "sourceLink" | "mergeDecision">) =>
  (card.stage === "pr" && card.sourceLink !== null) || card.mergeDecision?.merged !== undefined;

/** The decision a job shows: while in pr, and after a merge the factory made, for its watch on main. */
export function shownDecision(job: Pick<JobRow, "stage" | "merge_decision">): MergeDecision | null {
  const decision = mergeDecisionSchema.safeParse(job.merge_decision).data ?? null;
  return job.stage === "pr" || (job.stage === "merged" && decision?.merged) ? decision : null;
}

/** The current attempt's latest evidence, held against the PR head the runner last read. */
export function jobEvidenceLine(job: Pick<JobRow, "evidence" | "attempt" | "stage" | "merge_decision">) {
  const summary = parseSummary(job.evidence);
  return evidenceLine(summary?.attempt === job.attempt ? summary : null, shownDecision(job)?.headSha ?? null, { expected: job.stage === "pr" });
}

const stagedAt = (run: RunRow) => run.stage_at?.getTime() ?? 0;

function cardStop(job: JobRow): BoardCard["stop"] {
  const view = stopView(job.stop, runsOn(job)?.kind === "cloud");
  return view && { view, thread: parseStop(job.stop)?.thread ?? job.t3_thread_id };
}

/** `harnesses` are the ones the machines report, so a renamed Claude Code instance keeps its name and stays tracked. */
export function boardCards(jobs: readonly JobRow[], runs: readonly RunRow[], harnesses: readonly Harness[] = []): BoardCard[] {
  const harnessOf = (provider: string, attemptRuns: readonly RunRow[]): CardHarness => {
    const known = harnesses.find((h) => h.id === provider);
    const name = known?.name ?? harnessLabel(provider);
    if (isTracked(known?.driver ?? provider)) return { name, tracking: "full" };
    if (!attemptRuns.some((r) => isMcpSession(r.session_id))) return { name, tracking: "none" };
    return { name, tracking: costKnown(attemptRuns) ? "full" : "stages" };
  };
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
      jobId: job.id,
      jobKey: job.key,
      title: job.title,
      repo: job.repo,
      stage: job.stage,
      summary: job.stage_summary,
      question: job.question,
      prUrl: job.pr_url,
      sourceLink: sourceLink(job),
      machineId: job.machine_id,
      answeredAt: job.answered_at,
      attempt: job.attempt,
      attemptRuns,
      nudgedAt: job.nudged_stage === job.stage ? job.nudged_at : null,
      latest: attemptRuns.find((r) => r.session_id === job.session_id) ?? attemptRuns[0] ?? null,
      runs: jobRuns,
      harness: job.provider ? harnessOf(job.provider, attemptRuns) : null,
      runsOn: runsOn(job),
      mergeDecision: shownDecision(job),
      evidence: jobEvidenceLine(job),
      stop: cardStop(job),
      updatedAt: new Date(Math.max(job.updated_at.getTime(), ...jobRuns.map((r) => r.last_event_at.getTime()))),
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
        jobId: null,
        jobKey: latest.job_key,
        title: latest.title ?? latest.job_key ?? "Factory run",
        repo: latest.repo,
        stage: latest.stage,
        summary: latest.stage_summary,
        question: latest.question,
        prUrl: sorted.find((r) => r.pr_url)?.pr_url ?? null,
        sourceLink: null,
        machineId: null,
        answeredAt: null,
        attempt: 1,
        attemptRuns: sorted,
        nudgedAt: null,
        latest,
        runs: sorted,
        harness: null,
        runsOn: null,
        mergeDecision: null,
        evidence: null,
        stop: null,
        updatedAt: new Date(Math.max(...sorted.map((r) => r.last_event_at.getTime()))),
      };
    },
  );
  return [...fromJobs, ...fromRuns];
}

/**
 * The cards the board, the list and the inbox show, and the archived ones. Cards come from every
 * job, so an archived job's runs never show up as runs the factory didn't claim.
 */
export function panelCards(jobs: readonly JobRow[], runs: readonly RunRow[], harnesses: readonly Harness[] = []) {
  const archivedIds = new Set(splitArchived(jobs).archived.map((j) => j.id));
  const inArchive = (c: BoardCard) => c.jobId !== null && archivedIds.has(c.jobId);
  const all = boardCards(jobs, runs, harnesses);
  return { live: all.filter((c) => !inArchive(c)), archived: all.filter(inArchive) };
}
