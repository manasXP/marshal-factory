"use client";

import { ArchiveIcon, ArchiveRestoreIcon, ChevronRightIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import type React from "react";
import { useMemo, useRef, useState, useTransition } from "react";
import { archiveJobs, unarchiveJobs } from "@/app/actions/archive";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import type { AgentRow, MachineRow } from "@/db/schema";
import { isFinished } from "@/lib/archive";
import { STAGES, type Stage } from "@/lib/events";
import { stopLine } from "@/lib/stop";
import { cn } from "@/lib/utils";
import { harnessLine, showsDecision, whereLine, type BoardCard } from "./cards";
import { EvidenceLine } from "./evidence";
import { formatUsd, spendOf } from "./format";
import { jobsHref } from "./job-view";
import { decisionLine } from "./merge-decision";
import { useRowKeys } from "./row-keys";
import { STAGE_META } from "./stages";
import { ShortTime } from "./time";

const spring = { type: "spring", stiffness: 500, damping: 40 } as const;

const openHref = (card: BoardCard, archived: boolean) => (card.latest ? jobsHref("list", card.latest.session_id, archived) : null);

/** A finished, claimed job whose stop, if any, is confirmed; archiveRefusal has the server's rule. */
const pickable = (card: BoardCard) => card.jobId !== null && isFinished(card.stage) && (!card.stop || card.stop.view.kind === "confirmed");

function Row({
  card,
  href,
  machineName,
  agentsBySession,
  open,
  onFocus,
  repoLabels,
}: {
  card: BoardCard;
  href: string | null;
  machineName: string | null;
  repoLabels: ReadonlyMap<string, string> | undefined;
  agentsBySession: Map<string, AgentRow[]>;
  open: boolean;
  onFocus: () => void;
}) {
  const cost = spendOf(card.attemptRuns, agentsBySession);
  const decision = card.stop
    ? { text: stopLine(card.stop.view), tone: card.stop.view.kind === "unconfirmed" ? "text-destructive" : card.stop.view.kind === "stopping" ? "text-warning" : undefined }
    : showsDecision(card)
      ? decisionLine(card.mergeDecision)
      : null;
  const where = card.runsOn && (card.runsOn.kind === "cloud" && card.runsOn.sandbox ? `${whereLine(card.runsOn, machineName)} · ${card.runsOn.sandbox}` : whereLine(card.runsOn, machineName));
  const className = cn(
    "flex h-9 min-w-0 flex-1 items-center gap-3 ps-1 pe-4 text-left outline-none @3xl:pe-5",
    !href && "cursor-default",
  );
  const content = (
    <>
      <span className={cn("size-2 shrink-0 rounded-full", STAGE_META[card.stage].dot)} title={STAGE_META[card.stage].label} />
      <span className="sr-only">{STAGE_META[card.stage].label}</span>
      <span className="hidden w-24 shrink-0 truncate font-mono text-xs text-muted-foreground @lg:block">{card.jobKey ?? card.id.slice(0, 8)}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate">{card.title}</span>
        {card.latest?.status === "active" && <Spinner className="size-3 shrink-0 text-muted-foreground" />}
      </span>
      {repoLabels && <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground @2xl:block">{card.repo && repoLabels.get(card.repo)}</span>}
      <span className={cn("hidden w-32 shrink-0 truncate text-xs @sm:block @xl:w-56", decision?.tone)}>{decision?.text}</span>
      <span className="hidden w-44 shrink-0 @3xl:block">{card.evidence && <EvidenceLine line={card.evidence} />}</span>
      <span className="hidden w-44 shrink-0 truncate text-xs text-muted-foreground @4xl:block">{where}</span>
      <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground @5xl:block">{card.harness && harnessLine(card.harness)}</span>
      <span className="hidden w-14 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums @3xl:block">{formatUsd(cost)}</span>
      <span className="hidden w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums @md:block">
        <ShortTime date={card.updatedAt} />
      </span>
    </>
  );
  return href ? (
    <Link href={href} scroll={false} data-row={card.id} onFocus={onFocus} aria-current={open ? "true" : undefined} className={className}>
      {content}
    </Link>
  ) : (
    // A claimed job without a session yet has no run to open, but J and K still stop on it.
    <div tabIndex={0} data-row={card.id} onFocus={onFocus} className={className}>
      {content}
    </div>
  );
}

/** The leading cell every row and group header has, so the columns line up whether or not it holds a checkbox. */
function PickCell({ children }: { children?: React.ReactNode }) {
  return <span className="flex h-9 w-9 shrink-0 items-center ps-4 @3xl:w-10 @3xl:ps-5">{children}</span>;
}

/**
 * Every job as one dense row, grouped by stage in the board's order. J and K walk the rows, Enter opens the run, Esc closes it.
 * Finished jobs have a checkbox, and the picked ones are archived together; the archive lists them the same way to restore.
 */
export function JobList({
  cards,
  agentsBySession,
  selected,
  machines,
  repoLabels,
  archived = false,
}: {
  cards: readonly BoardCard[];
  agentsBySession: Map<string, AgentRow[]>;
  selected: string | undefined;
  machines: ReadonlyMap<string, MachineRow>;
  /** Each repo's short name, while more than one repo has jobs; undefined shows no repo. */
  repoLabels?: ReadonlyMap<string, string>;
  /** The archive: its rows are restored instead of archived. */
  archived?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [closed, setClosed] = useState<readonly Stage[]>([]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const isOpen = (card: BoardCard) => card.runs.some((r) => r.session_id === selected);
  const [cursor, setCursor] = useState<string | null>(() => cards.find(isOpen)?.id ?? null);
  useRowKeys(listRef, {
    cursor,
    setCursor,
    hrefOf: (id) => {
      const card = cards.find((c) => c.id === id);
      return card ? openHref(card, archived) : null;
    },
    closeHref: selected ? jobsHref("list", undefined, archived) : null,
  });
  // A job archived elsewhere, or moved on, drops out of the selection with its row.
  const chosen = useMemo(() => cards.filter((c) => pickable(c) && picked.has(c.id)), [cards, picked]);
  const pick = (ids: readonly string[], on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const act = () => {
    const ids = chosen.map((c) => c.jobId!);
    startTransition(async () => {
      const outcome = await (archived ? unarchiveJobs(ids) : archiveJobs(ids)).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
      if (!outcome.ok) {
        toastManager.add({ type: "error", title: outcome.message });
        return;
      }
      toastManager.add({ type: "success", title: outcome.message });
      setPicked(new Set());
    });
  };

  if (cards.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <Empty className="border">
          <EmptyHeader>
            {archived ? (
              <>
                <EmptyTitle>No archived jobs</EmptyTitle>
                <EmptyDescription>Merged and failed jobs you archive from the list wait here until you restore them.</EmptyDescription>
              </>
            ) : (
              <>
                <EmptyTitle>No jobs yet</EmptyTitle>
                <EmptyDescription>Jobs appear here as soon as the factory claims a ticket or a run reports its first stage.</EmptyDescription>
              </>
            )}
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div ref={listRef} className="@container flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex-1">
        {STAGES.map((stage) => {
          const rows = cards.filter((c) => c.stage === stage);
          if (rows.length === 0) return null;
          const open = !closed.includes(stage);
          const pickableIds = rows.filter(pickable).map((c) => c.id);
          const pickedHere = pickableIds.filter((id) => picked.has(id)).length;
          return (
            <section key={stage} aria-label={STAGE_META[stage].label}>
              <div className="sticky top-0 z-10 flex h-9 items-center border-b bg-muted/72 backdrop-blur-sm">
                <PickCell>
                  {pickableIds.length > 0 && (
                    <Checkbox
                      aria-label={`Select all ${STAGE_META[stage].label.toLowerCase()} jobs`}
                      checked={pickedHere === pickableIds.length}
                      indeterminate={pickedHere > 0 && pickedHere < pickableIds.length}
                      onCheckedChange={(on) => pick(pickableIds, on)}
                    />
                  )}
                </PickCell>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setClosed((c) => (open ? [...c, stage] : c.filter((s) => s !== stage)))}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 ps-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <ChevronRightIcon className={cn("size-3.5 text-muted-foreground transition-transform duration-200 ease-out", open && "rotate-90")} />
                  <span className={cn("size-2 rounded-full", STAGE_META[stage].dot)} />
                  <span className="font-medium">{STAGE_META[stage].label}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{rows.length}</span>
                </button>
              </div>
              <AnimatePresence initial={false}>
                {open && (
                  <motion.ul initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} transition={spring} className="overflow-hidden">
                    <AnimatePresence initial={false}>
                      {rows.map((card) => (
                        <motion.li
                          key={card.id}
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                          className={cn(
                            "relative flex items-center border-b transition-colors duration-150 hover:bg-accent/60 has-focus-visible:bg-accent",
                            isOpen(card) ? "bg-accent" : (cursor === card.id || picked.has(card.id)) && "bg-accent/60",
                          )}
                        >
                          {cursor === card.id && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-foreground" />}
                          <PickCell>
                            {pickable(card) && (
                              <Checkbox aria-label={`Select ${card.jobKey}`} checked={picked.has(card.id)} onCheckedChange={(on) => pick([card.id], on)} />
                            )}
                          </PickCell>
                          <Row
                            card={card}
                            href={openHref(card, archived)}
                            machineName={card.machineId && (machines.get(card.machineId)?.name ?? card.machineId)}
                            agentsBySession={agentsBySession}
                            open={isOpen(card)}
                            onFocus={() => setCursor(card.id)}
                            repoLabels={repoLabels}
                          />
                        </motion.li>
                      ))}
                    </AnimatePresence>
                  </motion.ul>
                )}
              </AnimatePresence>
            </section>
          );
        })}
      </div>
      {chosen.length > 0 && (
        <div className="sticky bottom-0 z-10 flex h-12 shrink-0 items-center gap-2 border-t bg-background px-4 @3xl:px-5">
          <Button size="sm" onClick={act} loading={pending}>
            {archived ? <ArchiveRestoreIcon data-icon="inline-start" /> : <ArchiveIcon data-icon="inline-start" />}
            {archived ? "Unarchive" : "Archive"} {chosen.length} {chosen.length === 1 ? "job" : "jobs"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())} disabled={pending}>
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
