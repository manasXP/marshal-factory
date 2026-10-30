"use client";

import { ExternalLinkIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import type { JobRow } from "@/db/schema";
import { parseAssessment } from "@/lib/assessment";
import { INBOX_LABELS, inboxItems, inboxReason, type InboxItem, type InboxKind } from "@/lib/inbox";
import { stopLine, stopView } from "@/lib/stop";
import { AUTONOMY_LABELS, type ReviewSummary } from "@/lib/merge-decision";
import { sourceLink } from "@/lib/sources/shapes";
import { cn } from "@/lib/utils";
import { isCloud } from "@/lib/execution";
import type { BoardCard } from "./cards";
import { Screenshots } from "./screenshots";
import { EvidenceSummaryList } from "./evidence";
import { InboxActions } from "./inbox-actions";
import { FullViewToggle, useEscapeToSidePanel, type FullView } from "./full-view";
import { jobsHref } from "./job-view";
import { Confidence } from "./merge-decision";
import { useRowKeys } from "./row-keys";
import { ShortTime } from "./time";

const KIND_DOT: Record<InboxKind, string> = {
  question: "bg-warning",
  revert_failed: "bg-destructive",
  handover: "bg-primary",
  failed: "bg-destructive",
  stop_unconfirmed: "bg-warning",
};

const itemHref = (key: string) => `/inbox?job=${encodeURIComponent(key)}`;

type Item = InboxItem<JobRow>;

function Row({
  item,
  open,
  cursor,
  onFocus,
  repoLabels,
}: {
  item: Item;
  open: boolean;
  cursor: boolean;
  onFocus: () => void;
  repoLabels: ReadonlyMap<string, string> | undefined;
}) {
  const { job, kind } = item;
  return (
    <Link
      href={itemHref(job.key)}
      scroll={false}
      data-row={job.key}
      onFocus={onFocus}
      aria-current={open ? "true" : undefined}
      className={cn(
        "relative flex h-9 w-full items-center gap-3 px-4 text-left outline-none transition-colors duration-150 hover:bg-accent/60 focus-visible:bg-accent @3xl:px-5",
        open ? "bg-accent" : cursor && "bg-accent/60",
      )}
    >
      {cursor && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-foreground" />}
      <span className={cn("size-2 shrink-0 rounded-full", KIND_DOT[kind])} />
      <span className="hidden w-24 shrink-0 truncate font-mono text-xs text-muted-foreground @lg:block">{job.key}</span>
      <span className="min-w-0 flex-1 truncate">{job.title}</span>
      {repoLabels && <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground @2xl:block">{repoLabels.get(job.repo)}</span>}
      <span className="hidden w-32 shrink-0 truncate text-xs text-muted-foreground @sm:block @xl:w-56 @3xl:w-72">{inboxReason(item)}</span>
      <span className="hidden w-36 shrink-0 truncate text-xs text-muted-foreground @2xl:block">{INBOX_LABELS[kind]}</span>
      <span className="hidden w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums @md:block">
        <ShortTime date={item.at} />
      </span>
    </Link>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <Separator />
      <section className="flex flex-col gap-2 px-4.5 py-3.5">
        <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
        {children}
      </section>
    </>
  );
}

function Why({ item }: { item: Item }) {
  const { kind, job, decision } = item;
  switch (kind) {
    case "question":
      return <p className="whitespace-pre-wrap">{job.question ?? job.stage_summary}</p>;
    case "failed": {
      const stop = stopView(job.stop, isCloud(job.execution));
      return (
        <div className="flex flex-col gap-1">
          <p className="whitespace-pre-wrap">{job.stage_summary ?? "The job failed without a summary."}</p>
          {stop?.kind === "stopping" && <p className="text-xs text-muted-foreground">{stopLine(stop)}</p>}
        </div>
      );
    }
    case "stop_unconfirmed":
      return (
        <Alert variant="warning">
          <AlertTitle>Stop not confirmed — check the thread in T3</AlertTitle>
          <AlertDescription className="flex flex-col gap-1">
            <span>{inboxReason(item)}</span>
            <span>
              Open the run, then Open in T3, and stop the thread there if it still works; then dismiss this. Retry stop asks T3 to interrupt it again. The label
              can&apos;t retry the job until this is dismissed.
            </span>
          </AlertDescription>
        </Alert>
      );
    case "revert_failed": {
      const watch = decision?.watch;
      return (
        <Alert variant="error">
          <AlertTitle>Main went red after the factory merged this, and the revert failed</AlertTitle>
          <AlertDescription className="flex flex-col gap-1">
            {watch?.reason && <span>{watch.reason}</span>}
            {watch && watch.failed.length > 0 && <span>Failed on {decision?.merged?.base ?? "main"}: {watch.failed.join(", ")}</span>}
            {watch?.revertPr && (
              <a href={watch.revertPr} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                Revert PR
              </a>
            )}
          </AlertDescription>
        </Alert>
      );
    }
    case "handover": {
      if (!decision) return <p className="text-muted-foreground">The runner hasn&apos;t looked at this pull request yet.</p>;
      if (decision.autonomy === "off") return <p className="text-muted-foreground">Merging is off for {job.repo}, so every pull request waits for your review.</p>;
      if (decision.outcome === "merge") return <p className="text-muted-foreground">Trial would merge it; under trial the factory never merges on its own.</p>;
      return (
        <div className="flex flex-col gap-1">
          <ul className="list-disc pl-4">
            {decision.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          <p className="text-xs text-faint">{AUTONOMY_LABELS[decision.autonomy]} · approving overrules the agent&apos;s and the policy&apos;s reasons</p>
        </div>
      );
    }
    default: {
      const never: never = kind;
      throw new Error(`unknown inbox kind ${String(never)}`);
    }
  }
}

function Assessment({ job }: { job: JobRow }) {
  const assessment = parseAssessment(job.merge_assessment);
  if (!assessment) return null;
  return (
    <>
      <Section title="Confidence">
        <Confidence assessment={assessment} />
      </Section>
      {assessment.screenshots?.length ? (
        <Section title="Screenshots">
          <Screenshots job={job} assessment={assessment} />
        </Section>
      ) : null}
      {assessment.notes && (
        <Section title="Notes">
          <p className="whitespace-pre-wrap">{assessment.notes}</p>
        </Section>
      )}
      {assessment.assumptions.length > 0 && (
        <Section title="Assumptions">
          <ul className="list-disc pl-4">
            {assessment.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

type Loaded = { kind: "loading" } | { kind: "ready"; review: ReviewSummary | null } | { kind: "failed"; message: string };

/** The PR's files and Bugbot's findings, read on the server so the browser never calls GitHub. */
function useReview(job: JobRow, wanted: boolean) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const head = job.stage_event_id;
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    fetch(`/api/jobs/${encodeURIComponent(job.key)}/review`, { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { review?: ReviewSummary | null; error?: string };
        setLoaded(res.ok ? { kind: "ready", review: body.review ?? null } : { kind: "failed", message: body.error ?? `The panel answered ${res.status}.` });
      })
      .catch((error: unknown) => controller.signal.aborted || setLoaded({ kind: "failed", message: String(error) }));
    return () => controller.abort();
  }, [job.key, head, wanted]);
  return loaded;
}

function bugbotLine(bugbot: ReviewSummary["bugbot"]) {
  switch (bugbot.state) {
    case "pending":
      return { text: "Bugbot hasn't finished its review.", tone: "text-muted-foreground" };
    case "failed":
      return { text: "Bugbot didn't complete its review.", tone: "text-warning" };
    case "reviewed": {
      const open = [
        bugbot.high && `${bugbot.high} high`,
        bugbot.medium && `${bugbot.medium} medium`,
        bugbot.low && `${bugbot.low} low`,
      ].filter(Boolean);
      const resolved = bugbot.resolved ? ` · ${bugbot.resolved} resolved` : "";
      if (open.length === 0) return { text: `No open findings${resolved}`, tone: "text-success" };
      return { text: `${open.join(", ")} unresolved${resolved}`, tone: bugbot.high || bugbot.medium ? "text-destructive" : "text-muted-foreground" };
    }
    default: {
      const never: never = bugbot.state;
      throw new Error(`unknown Bugbot state ${String(never)}`);
    }
  }
}

function Review({ loaded, prUrl }: { loaded: Loaded; prUrl: string }) {
  if (loaded.kind === "loading") {
    return (
      <Section title="Changes">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      </Section>
    );
  }
  if (loaded.kind === "failed") {
    return (
      <Section title="Changes">
        <p className="text-muted-foreground">{loaded.message}</p>
      </Section>
    );
  }
  const review = loaded.review;
  if (!review) return null;
  const bugbot = bugbotLine(review.bugbot);
  const added = review.files.reduce((sum, f) => sum + f.additions, 0);
  const removed = review.files.reduce((sum, f) => sum + f.deletions, 0);
  const files = `${prUrl}/files`;
  return (
    <>
      <Section title="Bugbot">
        <p className={bugbot.tone}>{bugbot.text}</p>
      </Section>
      <Section title={`Changed files · ${review.fileCount}`}>
        <p className="text-xs text-muted-foreground">
          <span className="text-success">+{added}</span> <span className="text-destructive">−{removed}</span> at{" "}
          <span className="font-mono">{review.headSha.slice(0, 7)}</span>
        </p>
        <ul className="flex flex-col">
          {review.files.map((f) => (
            <li key={f.path}>
              <a href={files} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-sm py-0.5 font-mono text-xs hover:bg-accent/60">
                <span className="min-w-0 flex-1 truncate" title={f.path}>
                  {f.path}
                </span>
                <span className="shrink-0 tabular-nums text-success">+{f.additions}</span>
                <span className="w-10 shrink-0 text-right tabular-nums text-destructive">−{f.deletions}</span>
              </a>
            </li>
          ))}
        </ul>
        {review.fileCount > review.files.length && (
          <a href={files} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline underline-offset-2">
            and {review.fileCount - review.files.length} more on GitHub
          </a>
        )}
      </Section>
    </>
  );
}

function Detail({ item, card, fullView }: { item: Item; card: BoardCard | undefined; fullView: FullView }) {
  const { job, kind } = item;
  useEscapeToSidePanel(fullView);
  const link = sourceLink(job);
  const wantsReview = kind !== "question" && job.pr_url !== null;
  const loaded = useReview(job, wantsReview);
  const review = loaded.kind === "ready" ? loaded.review : null;
  return (
    <aside aria-label={`${job.key} details`} className={cn("flex min-h-0 min-w-0 flex-col bg-card", !fullView.full && "border-l")}>
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn(fullView.full && "mx-auto w-full max-w-3xl")}>
          <div className="flex flex-col gap-2 px-4.5 py-4">
            <div className="flex items-center justify-between font-mono text-xs text-faint">
              <span>{job.key}</span>
              <span className="flex items-center gap-0.5">
                <FullViewToggle {...fullView} />
                <Button render={<Link href="/inbox" scroll={false} />} variant="ghost" size="icon-sm" aria-label="Close">
                  <XIcon />
                </Button>
              </span>
            </div>
            <h2 className="text-base font-semibold">{job.title}</h2>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="gap-1.5 rounded-md font-normal">
                <span className={cn("size-1.5 rounded-full", KIND_DOT[kind])} />
                {INBOX_LABELS[kind]}
              </Badge>
              <span className="text-muted-foreground">{job.repo}</span>
              <span className="ml-auto flex flex-wrap gap-2">
                {card?.latest && (
                  <Button render={<Link href={jobsHref("list", card.latest.session_id)} scroll={false} />} variant="ghost" size="sm">
                    Run
                  </Button>
                )}
                <Button render={<a href={link.href} target="_blank" rel="noreferrer" />} variant="outline" size="sm">
                  {link.label}
                  <ExternalLinkIcon data-icon="inline-end" />
                </Button>
                {job.pr_url && (
                  <Button render={<a href={job.pr_url} target="_blank" rel="noreferrer" />} variant="outline" size="sm">
                    Pull request
                    <ExternalLinkIcon data-icon="inline-end" />
                  </Button>
                )}
              </span>
            </div>
          </div>
          <Section title="Why it's here">
            <Why item={item} />
          </Section>
          {kind === "handover" && job.stage === "pr" && (
            <Section title="Evidence">
              <EvidenceSummaryList job={job} />
            </Section>
          )}
          <Assessment job={job} />
          {wantsReview && job.pr_url && <Review loaded={loaded} prUrl={job.pr_url} />}
        </div>
      </ScrollArea>
      <div className="shrink-0 border-t">
        <div className={cn("px-4.5 py-3.5", fullView.full && "mx-auto w-full max-w-3xl")}>
          <InboxActions job={job} kind={kind} decision={item.decision} headSha={review?.headSha ?? null} reviewReady={!wantsReview || loaded.kind !== "loading"} />
        </div>
      </div>
    </aside>
  );
}

/** Everything waiting on the owner as one dense list; Enter opens an item's detail and actions on the right. */
export function Inbox({
  jobs,
  cards,
  selected,
  repoLabels,
  fullView,
}: {
  jobs: readonly JobRow[];
  cards: readonly BoardCard[];
  selected: string | undefined;
  /** Whether the open item fills the page instead of sitting beside the list. */
  fullView: FullView;
  /** Each repo's short name, while more than one repo has jobs; undefined shows no repo. */
  repoLabels?: ReadonlyMap<string, string>;
}) {
  const items = useMemo(() => inboxItems(jobs), [jobs]);
  const listRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<string | null>(selected ?? null);
  const open = items.find((i) => i.job.key === selected);
  const full = fullView.full && open !== undefined;
  // In full view the list is hidden and Esc goes back to the side panel, which the detail handles.
  useRowKeys(listRef, { cursor, setCursor, hrefOf: itemHref, closeHref: selected ? "/inbox" : null, enabled: !full });

  if (items.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Nothing needs you right now.</EmptyTitle>
            <EmptyDescription>Questions, pull requests ready for your review and failures land here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className={cn("grid min-h-0 flex-1", open && !full ? "grid-cols-[minmax(0,1fr)_440px] xl:grid-cols-[minmax(0,1fr)_520px]" : "grid-cols-1")}>
      {!full && (
        <div ref={listRef} className="@container min-h-0 min-w-0 overflow-y-auto">
          <ul aria-label="Needs you">
            {items.map((item) => (
              <li key={item.job.key} className="border-b">
                <Row item={item} open={item === open} cursor={cursor === item.job.key} onFocus={() => setCursor(item.job.key)} repoLabels={repoLabels} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {open && <Detail key={open.job.key} item={open} card={cards.find((c) => c.id === open.job.key)} fullView={fullView} />}
    </div>
  );
}
