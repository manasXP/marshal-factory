"use client";

import { EllipsisIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLinkItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { AgentRow, AuditRow, EventRow, JobEvidenceRow, JobRow, MachineRow, RunRow } from "@/db/schema";
import { sandboxState } from "@/lib/execution";
import { harnessLabel, type Harness } from "@/lib/harness";
import { parseInventory, t3ThreadLink, UNKNOWN } from "@/lib/machine";
import { sourceLink } from "@/lib/sources/shapes";
import { parseStop, stopLine, stopView } from "@/lib/stop";
import { runFeedPath } from "@/lib/run-links";
import { RUNS_ON_LABELS, ticketRecordSchema } from "@/lib/ticket-overrides";
import { runsOn, whereLine } from "./cards";
import { AgentTree } from "./agent-tree";
import { useArchiveAction, type ArchiveAction } from "./archive-action";
import { EventFeed } from "./event-feed";
import { FullViewToggle, type FullView } from "./full-view";
import { EvidenceSection } from "./evidence";
import { AuditLog } from "./audit-log";
import { formatUsd, runCost, runTitle, shortId } from "./format";
import { MergeButton } from "./merge-button";
import { MergeDecisionSection } from "./merge-decision";
import { ModelChip } from "./model-chip";
import { OpenSandboxT3, useSandboxT3 } from "./open-sandbox-t3";
import { SandboxSection } from "./sandbox-section";
import { useFeed, type Feed } from "./sealed";
import { StageTimeline } from "./stage-timeline";
import { Time } from "./time";
import { STAGE_META } from "./stages";

/** The job's audit feed, read once for both the sandbox's last login check and the audit log. */
function JobRecords({ feed, path, job }: { feed: Feed<AuditRow>; path: string; job: JobRow | undefined }) {
  const { rows } = useFeed(feed, path);
  return (
    <>
      {job && <SandboxSection job={job} audit={rows} />}
      <AuditLog rows={rows} />
    </>
  );
}

/** What the ticket's override labels chose for this attempt, and what the runner did instead where it could not. */
function TicketOverrides({ job, harnesses }: { job: JobRow; harnesses: readonly Harness[] }) {
  const ticket = ticketRecordSchema.safeParse(job.ticket_overrides).data;
  if (!ticket) return null;
  const provider = ticket.provider;
  const chosen = [
    provider && `Harness ${harnesses.find((h) => h.id === provider)?.name ?? harnessLabel(provider)}`,
    ticket.execution && `Runs on ${RUNS_ON_LABELS[ticket.execution]}`,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-1 text-xs">
      {chosen.length > 0 && <p className="text-muted-foreground">From the ticket: {chosen.join(" · ")}</p>}
      {ticket.notes.map((note) => (
        <p key={note} className="text-warning">
          {note}
        </p>
      ))}
    </div>
  );
}

type MenuLink = { label: string; href: string };

/** The run's links and the job's archive, out of the header's way. */
function ActionsMenu({
  source,
  t3,
  archive,
}: {
  source: MenuLink | null;
  /** A local thread's link, or what opens a sandbox's pairing dialog. */
  t3: MenuLink | { label: string; open: () => void } | null;
  archive: ArchiveAction | null;
}) {
  if (!source && !t3 && !archive) return null;
  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" size="icon-sm" aria-label="More actions" />}>
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        {source && (
          <MenuLinkItem render={<a href={source.href} target="_blank" rel="noreferrer" />}>
            <ExternalLinkIcon />
            Open in {source.label}
          </MenuLinkItem>
        )}
        {t3 &&
          ("href" in t3 ? (
            <MenuLinkItem render={<a href={t3.href} />}>
              <ExternalLinkIcon />
              {t3.label}
            </MenuLinkItem>
          ) : (
            <MenuItem onClick={t3.open}>
              <ExternalLinkIcon />
              {t3.label}
            </MenuItem>
          ))}
        {archive && (
          <>
            {(source || t3) && <MenuSeparator />}
            <MenuItem onClick={archive.act} disabled={archive.pending}>
              <archive.Icon />
              {archive.label}
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

/** A job's menu: its sandbox pairs with T3 through a dialog that outlives the menu. */
function JobActions({ job, source, sandboxed, t3Link }: { job: JobRow; source: MenuLink | null; sandboxed: boolean; t3Link: MenuLink | null }) {
  const pairing = useSandboxT3(job.id);
  const archive = useArchiveAction(job);
  return (
    <>
      <ActionsMenu source={source} t3={sandboxed ? { label: "Open in T3", open: pairing.open } : t3Link} archive={archive} />
      {sandboxed && pairing.dialog}
    </>
  );
}

const STOP_BOX = {
  stopping: { box: "border-warning/40 bg-warning/10", title: "text-warning" },
  confirmed: { box: "border-border bg-muted/40", title: "text-foreground" },
  unconfirmed: { box: "border-destructive/40 bg-destructive/10", title: "text-destructive" },
} as const;

/** Where the job's stop is: what the runner last did, why it counts as stopped, or why it could not tell. */
function StopBanner({ job, t3Href }: { job: JobRow; t3Href: string | null }) {
  const sandboxed = runsOn(job)?.kind === "cloud";
  const view = stopView(job.stop, sandboxed);
  const stop = parseStop(job.stop);
  if (!view || !stop) return null;
  const detail = view.kind === "stopping" ? stop.step : view.kind === "confirmed" ? view.evidence : view.reason;
  return (
    <div className={cn("mx-4.5 mb-3.5 flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-xs", STOP_BOX[view.kind].box)}>
      <div className={cn("font-semibold", STOP_BOX[view.kind].title)}>{stopLine(view)}</div>
      {detail && <p className="text-muted-foreground">{detail}</p>}
      <p className="text-muted-foreground">
        Stop asked by {stop.by} <Time date={new Date(stop.requestedAt)} />
        {stop.retries > 0 && ` · retried ${stop.retries}×`}
        {view.kind === "stopping" && " · the job keeps its slot until the stop is confirmed"}
      </p>
      {view.kind === "unconfirmed" && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {sandboxed ? (
            <OpenSandboxT3 jobId={job.id} />
          ) : (
            t3Href && (
              <Button render={<a href={t3Href} />} variant="outline" size="sm">
                Open in T3
                <ExternalLinkIcon data-icon="inline-end" />
              </Button>
            )
          )}
          <span className="text-muted-foreground">Retry stop or dismiss it in the inbox once the thread has stopped.</span>
        </div>
      )}
    </div>
  );
}

export function RunDetail({
  run,
  agents,
  events,
  stages,
  stagesPath,
  audit,
  evidence,
  job,
  machine,
  harnesses,
  jobSpend,
  closeHref,
  fullView,
}: {
  harnesses: readonly Harness[];
  /** Where the close button goes: the page the run opened on. */
  closeHref: string;
  /** Whether the run fills the page, and the link back to the side panel or out to full view. */
  fullView: FullView;
  audit: { feed: Feed<AuditRow>; path: string } | undefined;
  evidence: { feed: Feed<JobEvidenceRow>; path: string } | undefined;
  jobSpend: { usd: number; attempt: number; limit: number } | undefined;
  stagesPath: string;
  job: JobRow | undefined;
  machine: MachineRow | undefined;
  run: RunRow;
  agents: Feed<AgentRow>;
  events: Feed<EventRow>;
  stages: Feed<EventRow>;
}) {
  const { rows: agentRows } = useFeed(agents, runFeedPath("agents", run.session_id));
  const { rows: eventRows } = useFeed(events, runFeedPath("events", run.session_id));
  const { rows: stageRows } = useFeed(stages, stagesPath);
  const stage = job?.stage ?? run.stage;
  const link = job && sourceLink(job);
  const machineName = machine?.name ?? job?.machine_id ?? null;
  const t3 = machine && parseInventory(machine.inventory)?.t3;
  const environmentId = t3 && t3 !== UNKNOWN ? t3.environmentId : null;
  const sandboxed = job ? sandboxState(job) !== null : false;
  const where = job && runsOn(job);
  const stopThread = job && (parseStop(job.stop)?.thread ?? job.t3_thread_id);

  const place = machineName && (where?.kind === "cloud" ? `${whereLine(where, machineName)} via ${machineName}` : `Local · ${machineName}`);
  const spend = jobSpend ? (
    <span title={`${jobSpend.attempt > 1 ? "Spend of this attempt" : "Spend"}, and its spend limit`}>
      {jobSpend.attempt > 1 && `attempt ${jobSpend.attempt} · `}
      {formatUsd(jobSpend.usd)} of {formatUsd(jobSpend.limit)}
    </span>
  ) : (
    formatUsd(runCost(run, agentRows))
  );
  const t3Link =
    !sandboxed && run.t3_thread_id
      ? { label: machineName ? `Open in T3 on ${machineName}` : "Open in T3", href: t3ThreadLink(run.t3_thread_id, environmentId) }
      : null;

  const summary = (
    <>
      <div className="flex flex-col gap-2.5 px-4.5 py-4">
        <div className="flex items-center justify-between gap-2 font-mono text-xs text-faint">
          <span className="min-w-0 truncate">
            {run.job_key ?? shortId(run.session_id)}
            {run.branch ? ` · ${run.branch}` : ""}
          </span>
          <span className="flex shrink-0 items-center gap-0.5">
            <FullViewToggle {...fullView} />
            <Button render={<Link href={closeHref} scroll={false} />} variant="ghost" size="icon-sm" aria-label="Close run">
              <XIcon />
            </Button>
          </span>
        </div>
        <h2 className="text-base font-semibold text-pretty">{job?.title ?? runTitle(run)}</h2>
        <div className="flex flex-wrap items-center gap-2">
          {stage && (
            <Badge variant="outline" className="gap-1.5 rounded-md font-normal">
              <span className={`size-1.5 rounded-full ${STAGE_META[stage].dot}`} />
              {STAGE_META[stage].label}
            </Badge>
          )}
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {run.status === "active" && <Spinner className="size-3" />}
            {run.status}
          </span>
          <span className="ms-auto flex items-center gap-1.5">
            {job?.stage === "pr" && job.pr_url && <MergeButton key={job.pr_url} jobId={job.id} jobKey={job.key} />}
            {run.pr_url && (
              <Button render={<a href={run.pr_url} target="_blank" rel="noreferrer" />} variant="outline" size="sm">
                Pull request
                <ExternalLinkIcon data-icon="inline-end" />
              </Button>
            )}
            {job ? (
              <JobActions job={job} source={link ?? null} sandboxed={sandboxed} t3Link={t3Link} />
            ) : (
              <ActionsMenu source={null} t3={t3Link} archive={null} />
            )}
          </span>
        </div>
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground [&>*+*]:before:me-2 [&>*+*]:before:text-faint [&>*+*]:before:content-['·']">
          {run.model && (
            <span className="flex items-center">
              <ModelChip model={run.model} />
            </span>
          )}
          {run.repo && <span className="min-w-0 truncate">{run.repo}</span>}
          {place && <span>{place}</span>}
          <span className="font-mono">{spend}</span>
        </p>
        {job && <TicketOverrides job={job} harnesses={harnesses} />}
      </div>
      {job && <StopBanner job={job} t3Href={stopThread ? t3ThreadLink(stopThread, environmentId) : null} />}
      {job?.nudged_at && job.nudged_stage === job.stage && (
        <div className="mx-4.5 mb-3.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs">
          <span className="font-semibold text-warning">Stuck</span> · the
          watchdog nudged this run at <Time date={job.nudged_at} /> in{" "}
          {STAGE_META[job.stage].label}. It fails if nothing moves.
        </div>
      )}
      {job?.answered_at && job.answer && job.stage !== "waiting" && (
        <div className="mx-4.5 mb-3.5 rounded-lg border border-success/40 bg-success/10 px-3 py-2.5">
          <div className="text-xs font-semibold text-success">
            Answer received <Time date={job.answered_at} />
          </div>
          <p className="mt-1 whitespace-pre-wrap">{job.answer}</p>
        </div>
      )}
      {job?.stage === "waiting" && job.question ? (
        <div className="mx-4.5 mb-3.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
          <div className="text-xs font-semibold text-warning">
            Question for you
          </div>
          <p className="mt-1 whitespace-pre-wrap">{job.question}</p>
        </div>
      ) : null}
      {!job && run.stage === "waiting" && run.question && (
        <div className="mx-4.5 mb-3.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
          <div className="text-xs font-semibold text-warning">
            Question for you
          </div>
          <p className="mt-1 whitespace-pre-wrap">{run.question}</p>
        </div>
      )}
      {job && <MergeDecisionSection job={job} />}
      {job && evidence && <EvidenceSection feed={evidence.feed} path={evidence.path} job={job} />}
    </>
  );
  const timeline = (
    <section className="flex flex-col gap-2.5 px-4.5 py-3.5">
      <h3 className="text-sm font-medium text-muted-foreground">
        Timeline
      </h3>
      <StageTimeline events={stageRows} />
    </section>
  );
  const records = audit ? <JobRecords feed={audit.feed} path={audit.path} job={job} /> : job && <SandboxSection job={job} audit={[]} />;
  const activity = (
    <>
      <Separator />
      <section className="flex flex-col gap-2.5 px-4.5 py-3.5">
        <h3 className="text-sm font-medium text-muted-foreground">
          Agents · {agentRows.length}
        </h3>
        <AgentTree run={run} agents={agentRows} />
      </section>
      <Separator />
      <section className="flex flex-col gap-2.5 px-4.5 py-3.5">
        <h3 className="text-sm font-medium text-muted-foreground">
          Live events
        </h3>
        <EventFeed events={eventRows} />
      </section>
    </>
  );

  if (fullView.full) {
    return (
      <aside aria-label="Run details" className="flex min-h-0 min-w-0 flex-col bg-card">
        <div className="min-h-0 flex-1 max-lg:overflow-y-auto lg:grid lg:grid-cols-2 lg:grid-rows-1 lg:divide-x">
          <ScrollArea className="max-lg:h-auto">
            <div className="mx-auto w-full max-w-3xl">
              {summary}
              {records}
            </div>
          </ScrollArea>
          <ScrollArea className="max-lg:h-auto">
            <div className="mx-auto w-full max-w-3xl">
              <Separator className="lg:hidden" />
              {timeline}
              {activity}
            </div>
          </ScrollArea>
        </div>
      </aside>
    );
  }

  return (
    <aside aria-label="Run details" className="flex min-h-0 flex-col border-l bg-card">
      <ScrollArea className="min-h-0 flex-1">
        {summary}
        <Separator />
        {timeline}
        {records}
        {activity}
      </ScrollArea>
    </aside>
  );
}
