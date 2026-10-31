"use client";

import { ArrowUpToLineIcon, EllipsisIcon, ExternalLinkIcon, PauseIcon, PlayIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { changeQueue, setPaused } from "@/app/actions/queue";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Menu, MenuItem, MenuLinkItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import type { JobRow, RepoSettingsRow } from "@/db/schema";
import type { QueueChange, QueueItem } from "@/lib/queue";
import { displayName } from "@/lib/repo-name";
import { SOURCE_SHAPES } from "@/lib/sources/shapes";
import { cn } from "@/lib/utils";
import { PanelFooter, PanelHeader } from "./panel-header";
import { useFeed, type Feed } from "./sealed";
import { ShortTime, Time } from "./time";

/** The backlog changes only when a runner's claim pass reads its sources, so the page looks again this often. */
const REFRESH_MS = 20_000;

type Pause = { at: Date; by: string } | null;

/** Refreshes the page when a claim or launch changes the jobs, and every REFRESH_MS for the backlog. */
function useQueueRefresh(jobs: Feed<JobRow>) {
  const router = useRouter();
  const { rows, status } = useFeed(jobs, "/api/live/jobs");
  const signature = rows
    .filter((j) => j.stage === "queued")
    .map((j) => `${j.id}:${j.t3_thread_id ?? ""}`)
    .join(",");
  const seen = useRef(signature);
  useEffect(() => {
    if (seen.current === signature) return;
    seen.current = signature;
    router.refresh();
  }, [signature, router]);
  useEffect(() => {
    const id = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [router]);
  return status;
}

function PauseButton({ pause, onFailure }: { pause: Pause; onFailure: (message: string | null) => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const toggle = () =>
    startTransition(async () => {
      const outcome = await setPaused(!pause);
      onFailure(outcome.ok ? null : outcome.message);
      router.refresh();
    });
  return (
    <Button size="sm" variant={pause ? "default" : "outline"} loading={pending} onClick={toggle}>
      {pause ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
      {pause ? "Resume" : "Pause new work"}
    </Button>
  );
}

function RemoveDialog({ item, open, onOpenChange, onRemove }: { item: QueueItem; open: boolean; onOpenChange: (open: boolean) => void; onRemove: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Take {item.key} out of the queue?</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="flex flex-col gap-1.5">
            <span className="font-medium text-foreground">{item.title}</span>
            <span>
              The factory removes its factory label in {SOURCE_SHAPES[item.source].label}, as you would by hand
              {item.claimed ? ", and stops the claimed job before it starts" : ""}. Add the label again to queue it once more.
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false);
              onRemove();
            }}
          >
            Remove from queue
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function Row({
  item,
  position,
  repoName,
  paused,
  onFailure,
}: {
  item: QueueItem;
  position: number;
  repoName: string | null;
  paused: boolean;
  onFailure: (message: string | null) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [removing, setRemoving] = useState(false);
  const act = (what: QueueChange) =>
    startTransition(async () => {
      const outcome = await changeQueue(item.id, what);
      onFailure(outcome.ok ? null : outcome.message);
      router.refresh();
    });
  return (
    <div className={cn("flex h-10 w-full items-center gap-3 px-4 md:px-5", (item.held || paused) && "text-muted-foreground")}>
      <span className="w-5 shrink-0 text-right text-xs text-faint tabular-nums">{position}</span>
      <span className="shrink-0 font-mono text-xs">{item.key}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate">{item.title}</span>
        {item.claimed && (
          <Badge variant="secondary" size="sm">
            Claimed
          </Badge>
        )}
        {item.front && (
          <Badge variant="info" size="sm">
            Front
          </Badge>
        )}
        {item.held && (
          <Badge variant="warning" size="sm">
            Held
          </Badge>
        )}
      </span>
      {repoName && <span className="hidden max-w-40 shrink-0 truncate text-xs text-muted-foreground md:block">{repoName}</span>}
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:block" title={item.claimed ? "Claimed" : "First seen"}>
        <ShortTime date={item.since} />
      </span>
      <Menu>
        <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${item.key}`} loading={pending} />}>
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem disabled={position === 1} onClick={() => act("front")}>
            <ArrowUpToLineIcon />
            Move to front
          </MenuItem>
          <MenuItem onClick={() => act(item.held ? "release" : "hold")}>
            {item.held ? <PlayIcon /> : <PauseIcon />}
            {item.held ? "Release" : "Hold"}
          </MenuItem>
          <MenuLinkItem render={<a href={item.url} target="_blank" rel="noreferrer" />}>
            <ExternalLinkIcon />
            Open in {SOURCE_SHAPES[item.source].label}
          </MenuLinkItem>
          <MenuItem variant="destructive" onClick={() => setRemoving(true)}>
            <XIcon />
            Remove from queue
          </MenuItem>
        </MenuPopup>
      </Menu>
      <RemoveDialog item={item} open={removing} onOpenChange={setRemoving} onRemove={() => act("remove")} />
    </div>
  );
}

/** What is waiting to start, in the order it starts, with the factory-wide pause. */
export function Queue({
  jobs,
  pause,
  items,
  registry,
}: {
  jobs: Feed<JobRow>;
  pause: Pause;
  items: readonly QueueItem[];
  registry: readonly Pick<RepoSettingsRow, "repo" | "display_name">[];
}) {
  const status = useQueueRefresh(jobs);
  const [failure, setFailure] = useState<string | null>(null);
  const repoName = (repo: string | null) => {
    const row = registry.find((r) => r.repo === repo);
    // Only worth a column once more than one repo is registered.
    return row && registry.length > 1 ? displayName(row) : null;
  };
  const held = items.filter((i) => i.held).length;

  return (
    <>
      <PanelHeader title="Queue" actions={<PauseButton pause={pause} onFailure={setFailure} />} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-6">
          {pause && (
            <Alert variant="warning">
              <PauseIcon />
              <AlertTitle>New work is paused</AlertTitle>
              <AlertDescription>
                <span>
                  Since <Time date={pause.at} />, by {pause.by}. Runners claim and start nothing new; jobs already working carry on, answer questions and merge.
                </span>
              </AlertDescription>
            </Alert>
          )}
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          {items.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>Nothing is queued</EmptyTitle>
                <EmptyDescription>
                  Work waits here when every machine is full or new work is paused: issues with the factory label that no runner has claimed yet, then claimed jobs
                  that have not started.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ol aria-label="Queue" className="divide-y rounded-lg border">
              {items.map((item, index) => (
                <li key={item.id}>
                  <Row item={item} position={index + 1} repoName={repoName(item.repo)} paused={Boolean(pause)} onFailure={setFailure} />
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
      <PanelFooter
        status={status}
        summary={`${items.length} queued${held > 0 ? ` · ${held} held` : ""}${pause ? " · paused" : ""}`}
      />
    </>
  );
}
