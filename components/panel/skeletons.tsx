import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { STAGES } from "@/lib/events";
import { cn } from "@/lib/utils";
import type { PanelView } from "./live-panel";
import { PanelFooter, PanelHeader } from "./panel-header";
import { STAGE_META } from "./stages";

/** A page while its data streams in: the real header and footer, and a skeleton of the page in between. */
export function PageSkeleton({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <PanelHeader title={title} />
      <div aria-busy="true" aria-label={`Loading ${title.toLowerCase()}`} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
      <PanelFooter status="connecting" />
    </>
  );
}

function StatsSkeleton() {
  return (
    <div className="grid grid-cols-5 gap-px border-b bg-border">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 bg-background px-4 py-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-6 w-10" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-2.5">
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-3 w-2/5" />
    </div>
  );
}

/** The board's real columns, each with a card or two still loading. */
export function BoardSkeleton() {
  return (
    <>
      <StatsSkeleton />
      <div className="flex min-h-0 flex-1 divide-x overflow-hidden">
        {STAGES.filter((stage) => stage !== "failed").map((stage, i) => (
          <section key={stage} className="flex h-full w-80 shrink-0 flex-col last:border-e">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/72 px-3 font-medium">
              <span className={cn("size-2 rounded-full", STAGE_META[stage].dot)} />
              {STAGE_META[stage].label}
            </div>
            <div className="flex flex-col gap-1.5 p-2">
              {Array.from({ length: i % 3 === 0 ? 2 : 1 }, (_, j) => (
                <CardSkeleton key={j} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

/** Rows of a list, for the inbox, other activity and the machines page. */
export function RowsSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col divide-y", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3 md:px-5">
          <Skeleton className="size-2 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className={cn("h-4", i % 2 ? "w-1/2" : "w-2/3")} />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-3 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** Labelled sections of fields, for the settings page. */
export function FormSkeleton({ sections = 3 }: { sections?: number }) {
  return (
    <div className="flex flex-col gap-8 p-4 md:p-6">
      {Array.from({ length: sections }, (_, i) => (
        <div key={i} className="flex flex-col gap-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-72 max-w-full" />
          <Skeleton className="h-9 w-full max-w-md" />
          <Skeleton className="h-9 w-full max-w-md" />
        </div>
      ))}
    </div>
  );
}

/** The analytics page's figures and a chart, while its range loads. */
export function AnalyticsSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-4 md:p-6">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-3 w-80 max-w-full" />
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border px-3.5 py-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-12" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </div>
      <Skeleton className="h-56 w-full rounded-lg" />
    </div>
  );
}

const PANEL_TITLES: Record<PanelView, string> = { inbox: "Inbox", jobs: "Jobs", activity: "Other activity" };

/** The inbox, jobs and other-activity pages while their feeds load. */
export function PanelPageSkeleton({ view }: { view: PanelView }) {
  return (
    <PageSkeleton title={PANEL_TITLES[view]}>
      {view === "jobs" ? (
        <BoardSkeleton />
      ) : (
        <>
          <StatsSkeleton />
          <RowsSkeleton />
        </>
      )}
    </PageSkeleton>
  );
}

/** The run detail side panel while its agents, events and timeline load; `controls` keep full view and close working meanwhile. */
export function RunDetailSkeleton({ controls }: { controls?: ReactNode }) {
  return (
    <div aria-busy="true" aria-label="Loading run" className="flex min-h-0 flex-col gap-6 border-l bg-card px-4.5 py-4">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-3 w-40" />
          {controls && <span className="flex shrink-0 items-center gap-0.5">{controls}</span>}
        </div>
        <Skeleton className="h-5 w-4/5" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-24" />
        </div>
      </div>
      {[4, 3, 5].map((rows, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          {Array.from({ length: rows }, (_, j) => (
            <Skeleton key={j} className={cn("h-3", j % 2 ? "w-3/4" : "w-full")} />
          ))}
        </div>
      ))}
    </div>
  );
}
