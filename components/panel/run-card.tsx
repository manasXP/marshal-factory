import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import type { AgentRow, RunRow } from "@/db/schema";
import { cn } from "@/lib/utils";
import type { BoardCard } from "./cards";
import { formatUsd, runCost, runTitle, shortId } from "./format";
import { ModelChip } from "./model-chip";
import { Time } from "./time";

const cardClass = (selected: boolean) =>
  cn(
    "relative flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-left text-sm transition-colors hover:border-input",
    selected && "border-primary ring-1 ring-primary",
  );

function AgentsAndCost({
  runs,
  agents,
  budgetUsd,
  allRuns,
}: {
  runs: readonly RunRow[];
  agents: readonly AgentRow[];
  budgetUsd?: number;
  /** Every attempt's runs, when they differ from the runs the cap counts. */
  allRuns?: readonly RunRow[];
}) {
  const running = agents.filter((a) => a.status === "running").length;
  const costOf = (list: readonly RunRow[]) =>
    list.reduce((sum, run) => sum + runCost(run, agents.filter((a) => a.session_id === run.session_id)), 0);
  const cost = costOf(runs);
  const total = allRuns && allRuns.length !== runs.length ? costOf(allRuns) : undefined;
  return (
    <>
      {agents.length > 0 && (
        <span>
          {running > 0 ? `${running}/${agents.length}` : agents.length} agents
        </span>
      )}
      <span
        className={cn("font-mono", budgetUsd !== undefined && cost >= budgetUsd && "text-destructive")}
        title={budgetUsd !== undefined ? "spend of this attempt / cap per attempt" : undefined}
      >
        {formatUsd(cost)}
        {budgetUsd !== undefined && ` / ${formatUsd(budgetUsd)}`}
      </span>
      {total !== undefined && <span className="font-mono text-faint">all attempts {formatUsd(total)}</span>}
    </>
  );
}

const prLabel = (url: string) => {
  const number = url.match(/\/pull\/(\d+)/)?.[1];
  return number ? `PR #${number}` : "PR";
};

export function StageCard({
  card,
  agents,
  selected,
  machineName,
}: {
  card: BoardCard;
  agents: readonly AgentRow[];
  selected: boolean;
  machineName: string | null;
}) {
  const { latest } = card;
  return (
    <div data-card={card.id} className={cardClass(selected)}>
      {latest && (
        <Link
          href={`/?run=${latest.session_id}`}
          scroll={false}
          aria-label={`Open ${card.jobKey ?? card.title}`}
          className="absolute inset-0 rounded-lg"
        />
      )}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {latest?.status === "active" && <Spinner className="size-2.5" />}
        <span className="font-mono">{card.jobKey ?? card.id.slice(0, 8)}</span>
        <span className="ml-auto flex items-center gap-2.5">
          {card.sourceLink && (
            <a href={card.sourceLink.href} target="_blank" rel="noreferrer" className="relative underline-offset-2 hover:text-foreground hover:underline">
              {card.sourceLink.label}
            </a>
          )}
          {card.prUrl && (
            <a href={card.prUrl} target="_blank" rel="noreferrer" className="relative font-mono underline-offset-2 hover:text-foreground hover:underline">
              {prLabel(card.prUrl)}
            </a>
          )}
        </span>
      </div>
      <div className="line-clamp-2 font-medium leading-snug">{card.title}</div>
      {card.nudgedAt && (
        <p className="text-xs text-warning">
          Stuck · nudged <Time date={card.nudgedAt} />
        </p>
      )}
      {card.answeredAt && card.stage !== "waiting" && (
        <p className="text-xs text-success">
          Answer received <Time date={card.answeredAt} />
        </p>
      )}
      {card.stage === "waiting" && card.question ? (
        <p className="line-clamp-2 text-xs text-warning">{card.question}</p>
      ) : (
        card.summary && <p className="line-clamp-2 text-xs text-muted-foreground">{card.summary}</p>
      )}
      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        {latest && <ModelChip model={latest.model} />}
        {card.attempt > 1 && <span>attempt {card.attempt}</span>}
        <AgentsAndCost runs={card.attemptRuns} allRuns={card.runs} agents={agents} budgetUsd={card.budgetUsd ?? undefined} />
        {machineName && <span className="ml-auto min-w-0 truncate">{machineName}</span>}
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
      href={`/activity?run=${run.session_id}`}
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
