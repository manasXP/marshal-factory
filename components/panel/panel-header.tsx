"use client";

import { MenuIcon } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import type { JobView } from "./job-view";
import { useShell } from "./panel-shell";
import type { FeedStatus } from "./sealed";

const STATUS: Record<FeedStatus, { dot: string; label: string }> = {
  live: { dot: "animate-pulse bg-success", label: "Live" },
  connecting: { dot: "bg-warning", label: "Connecting" },
  off: { dot: "bg-faint", label: "Live updates off in previews" },
};

const JOB_VIEWS = [
  { view: "board", label: "Board" },
  { view: "list", label: "List" },
] as const satisfies readonly { view: JobView; label: string }[];

type ViewSwitchProps = { current: JobView; onChange: (view: JobView) => void };

function ViewSwitch({ current, onChange }: ViewSwitchProps) {
  return (
    <div role="radiogroup" aria-label="Layout" className="flex shrink-0 items-center rounded-md border p-0.5">
      {JOB_VIEWS.map(({ view, label }) => (
        <button
          key={view}
          type="button"
          onClick={() => view !== current && onChange(view)}
          role="radio"
          aria-checked={view === current}
          className={cn(
            "relative h-6 rounded-[5px] px-2 text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            view === current ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {view === current && (
            <motion.span layoutId="panel-view-marker" transition={{ type: "spring", stiffness: 500, damping: 40 }} className="absolute inset-0 rounded-[5px] bg-accent" />
          )}
          <span className="relative">{label}</span>
        </button>
      ))}
    </div>
  );
}

/** The page's hairline header: the title, the board and list switch on the jobs page, and the page's actions. */
export function PanelHeader({ title, jobView, actions }: { title: string; jobView?: ViewSwitchProps; actions?: ReactNode }) {
  const { openNav } = useShell();
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-2 md:px-3">
      <Button aria-label="Open navigation" className="md:hidden" onClick={openNav} size="icon-sm" variant="ghost">
        <MenuIcon />
      </Button>
      <h1 className="min-w-0 flex-1 truncate ps-1 font-medium">{title}</h1>
      {jobView && <ViewSwitch {...jobView} />}
      {actions}
    </header>
  );
}

/** One key and what it does, for the footer's hints. */
export type KeyHint = { keys: readonly string[]; label: string };

/** The page's hairline footer: a summary on the left, then how fresh the data is (none for a page without a live feed) and the page's keys. */
export function PanelFooter({ status, note, summary, keys = [] }: { status?: FeedStatus; note?: string; summary?: ReactNode; keys?: readonly KeyHint[] }) {
  return (
    <footer className="flex h-10 shrink-0 items-center gap-3 border-t px-4 text-xs text-muted-foreground md:px-5">
      {summary && <span className="min-w-0 truncate tabular-nums">{summary}</span>}
      <span className="ms-auto flex shrink-0 items-center gap-1.5">
        {status && (
          <>
            <span className={cn("size-1.5 shrink-0 rounded-full", STATUS[status].dot)} />
            {STATUS[status].label}
          </>
        )}
        {note && `${status ? " · " : ""}${note}`}
      </span>
      <span className="hidden items-center gap-3 lg:flex">
        {[...keys, { keys: ["["], label: "sidebar" }].map(({ keys: combo, label }) => (
          <span key={label} className="flex items-center gap-1">
            {combo.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
            {label}
          </span>
        ))}
      </span>
    </footer>
  );
}
