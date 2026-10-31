import { CloudIcon, ExternalLinkIcon, MonitorIcon } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import type { AgentRow, RunRow } from "@/db/schema";
import type { SandboxState } from "@/lib/execution";
import type { Tracking } from "@/lib/harness";
import type { MergeDecision } from "@/lib/merge-decision";
import { activityHref } from "@/lib/run-links";
import { stopLine, type StopView } from "@/lib/stop";
import { cn } from "@/lib/utils";
import { showsDecision, whereLine, type BoardCard } from "./cards";
import { EvidenceLine } from "./evidence";
import { formatUsd, runCost, runTitle, shortId } from "./format";
import { jobsHref } from "./job-view";
import { decisionLine } from "./merge-decision";
import { ModelChip } from "./model-chip";
import { Time } from "./time";

const cardClass = (selected: boolean) =>
  cn(
    "relative flex flex-col gap-1 rounded-lg border bg-card p-2.5 text-left text-sm transition-colors hover:border-input",
    selected && "border-primary ring-1 ring-primary",
  );

/** What the given runs cost, their subagents included. */
const attemptCost = (runs: readonly RunRow[], agents: readonly AgentRow[]) =>
  runs.reduce((sum, run) => sum + runCost(run, agents.filter((a) => a.session_id === run.session_id)), 0);

function AgentsAndCost({
  runs,
  agents,
  allRuns,
}: {
  runs: readonly RunRow[];
  agents: readonly AgentRow[];
  /** Every attempt's runs, when they differ from the current attempt's. */
  allRuns?: readonly RunRow[];
}) {
  const running = agents.filter((a) => a.status === "running").length;
  const costOf = (list: readonly RunRow[]) => attemptCost(list, agents);
  const cost = costOf(runs);
  const total = allRuns && allRuns.length !== runs.length ? costOf(allRuns) : undefined;
  return (
    <>
      {agents.length > 0 && (
        <span>
          {running > 0 ? `${running}/${agents.length}` : agents.length} agents
        </span>
      )}
      <span className="font-mono" title={total !== undefined ? "spend of this attempt" : undefined}>
        {formatUsd(cost)}
      </span>
      {total !== undefined && <span className="font-mono text-faint">all attempts {formatUsd(total)}</span>}
    </>
  );
}

const TRACKING_HINT: Record<Tracking, string | undefined> = {
  full: undefined,
  stages: "The runner reads this harness's cost from its session logs; it shows once usage is read and the model has a price.",
  none: "This harness reports no stages, agents or cost; check the run in T3.",
};

const SANDBOX_HINT: Record<SandboxState, string> = {
  running: "Runs in its own cloud sandbox",
  hibernated: "The sandbox is snapshotted while the job waits; it wakes when the job needs it",
};

/** Where a sandboxed job's sandbox is: running, or hibernated as a snapshot. `bare` drops the word sandbox for a line that says it already. */
export function SandboxBadge({ state, bare = false }: { state: SandboxState; bare?: boolean }) {
  return (
    <Badge variant="outline" className="gap-1.5 rounded-md font-normal text-muted-foreground" title={SANDBOX_HINT[state]}>
      <span className={cn("size-1.5 rounded-full", state === "running" ? "bg-success" : "bg-muted-foreground/50")} />
      {bare ? state : `Sandbox · ${state}`}
    </Badge>
  );
}

function MergeLine({ decision }: { decision: MergeDecision | null }) {
  const line = decisionLine(decision);
  return (
    <p className={cn("line-clamp-2 text-xs", line.tone)}>
      {line.text}
      {line.link && (
        <>
          {" · "}
          <a href={line.link.href} target="_blank" rel="noreferrer" className="relative underline underline-offset-2">
            {line.link.label}
          </a>
        </>
      )}
    </p>
  );
}

const STOP_TONE: Record<StopView["kind"], string> = {
  stopping: "text-warning",
  confirmed: "text-muted-foreground",
  unconfirmed: "text-destructive",
};

/** Where the job's stop is; an unconfirmed one links to its thread in T3 when the card knows the link. */
export function StopLine({ view, t3Href }: { view: StopView; t3Href?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-1.5 text-xs", STOP_TONE[view.kind])} title={view.kind === "stopping" ? undefined : view.kind === "confirmed" ? view.evidence : view.reason}>
      {view.kind === "stopping" && <Spinner className="size-2.5" />}
      {stopLine(view)}
      {view.kind === "unconfirmed" && t3Href && (
        <a href={t3Href} className="relative inline-flex items-center gap-0.5 underline underline-offset-2">
          Open in T3
          <ExternalLinkIcon className="size-3" />
        </a>
      )}
    </p>
  );
}

export function StageCard({
  card,
  agents,
  selected,
  machineName,
  repoLabel,
  requester,
  t3Href,
}: {
  card: BoardCard;
  agents: readonly AgentRow[];
  selected: boolean;
  machineName: string | null;
  /** Shown only while more than one repo has jobs. */
  repoLabel?: string;
  /** Who the job is for; shown only while more than one person has jobs. */
  requester?: string;
  /** The job's thread in its machine's T3, for a stop that couldn't be confirmed. */
  t3Href?: string;
}) {
  const { latest } = card;
  const where = card.runsOn && whereLine(card.runsOn, machineName);
  const sandbox = card.runsOn?.kind === "cloud" ? card.runsOn.sandbox : null;
  return (
    <div data-card={card.id} className={cn(cardClass(selected), "gap-1.5")}>
      {latest && (
        <Link
          href={jobsHref("board", latest.session_id)}
          scroll={false}
          aria-label={`Open ${card.jobKey ?? card.title}`}
          className="absolute inset-0 rounded-lg"
        />
      )}
      <div className="line-clamp-2 font-medium leading-snug text-pretty">{card.title}</div>
      {showsDecision(card) && <MergeLine decision={card.mergeDecision} />}
      {card.evidence && <EvidenceLine line={card.evidence} />}
      {card.stop && <StopLine view={card.stop.view} t3Href={t3Href} />}
      {card.nudgedAt && (
        <p className="text-xs text-warning">
          Stuck · nudged <Time date={card.nudgedAt} />
        </p>
      )}
      {card.stage === "waiting" && card.question && <p className="line-clamp-2 text-xs text-warning">{card.question}</p>}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {latest?.status === "active" && <Spinner className="size-2.5 shrink-0" aria-label="Working" />}
        <span className="shrink-0 font-mono">{card.jobKey ?? card.id.slice(0, 8)}</span>
        {repoLabel && <span className="min-w-0 truncate">{repoLabel}</span>}
        {requester && <span className="min-w-0 truncate" title="Requested by">{requester}</span>}
        <span className="ms-auto flex shrink-0 items-center gap-2">
          {card.attempt > 1 && <span>attempt {card.attempt}</span>}
          {!card.harness || card.harness.tracking === "full" ? (
            <span className="font-mono" title="Spend of this attempt">
              {formatUsd(attemptCost(card.attemptRuns, agents))}
            </span>
          ) : (
            <span title={TRACKING_HINT[card.harness.tracking]}>{card.harness.tracking === "stages" ? "cost unknown" : "not tracked"}</span>
          )}
          {where && (
            <span title={sandbox ? `${where} · ${sandbox}` : where} className="flex items-center gap-1">
              {card.runsOn?.kind === "cloud" ? <CloudIcon className="size-3.5" aria-label={where} /> : <MonitorIcon className="size-3.5" aria-label={where} />}
              {sandbox === "hibernated" && <span className="size-1.5 rounded-full bg-muted-foreground/50" aria-label="hibernated" />}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

export function RunCard({
  run,
  agents,
  selected,
}: {
  run: RunRow;
  agents: readonly AgentRow[];
  selected: boolean;
}) {
  return (
    <Link
      href={activityHref(run.session_id)}
      scroll={false}
      className={cn(cardClass(selected), run.status === "ended" && "opacity-60")}
    >
      <div className="flex items-center gap-1.5 font-mono text-xs text-faint">
        {run.status === "active" && <Spinner className="size-2.5" />}
        {run.job_key ?? shortId(run.session_id)}
      </div>
      <div className="line-clamp-2 font-medium">{runTitle(run)}</div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Badge variant="outline" className="rounded-md font-normal">
          {run.status}
        </Badge>
        <ModelChip model={run.model} />
        <AgentsAndCost runs={[run]} agents={agents} />
      </div>
      {run.repo && (
        <div className="truncate font-mono text-xs text-faint">
          {run.repo}
          {run.branch ? ` · ${run.branch}` : ""}
        </div>
      )}
    </Link>
  );
}
