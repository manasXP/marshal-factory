"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useTransition, type ReactNode } from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import type { RepoSettingsRow } from "@/db/schema";
import {
  OUTCOME_LABELS,
  OUTCOMES,
  RANGES,
  rangeRepos,
  summarize,
  VERDICT_LABELS,
  VERDICTS,
  type AnalyticsFacts,
  type Durations,
  type Outcome,
  type RangeDays,
  type Share,
  type Verdict,
} from "@/lib/analytics";
import { repoName } from "@/lib/repo-name";
import { cn } from "@/lib/utils";
import { BarList, ChartCard, ColumnChart, DataTable, dayLabel, Legend, SplitBar, Swatch, type Series } from "./analytics-charts";
import { formatUsd } from "./format";
import { PanelFooter, PanelHeader } from "./panel-header";
import { RepoSelect, repoOptions, useRepoFilter } from "./repo-filter";
import { useAfterHydration } from "./time";

// Stacked in this order; neighbours are checked apart for color vision deficiency (globals.css).
const OUTCOME_COLORS: Record<Outcome, string> = {
  merged_factory: "bg-viz-blue",
  merged_owner: "bg-viz-aqua",
  handed_over: "bg-viz-yellow",
  reverted: "bg-viz-magenta",
  stopped: "bg-viz-violet",
  failed: "bg-viz-red",
  in_progress: "bg-viz-gray",
};
const OUTCOME_SERIES: Series[] = OUTCOMES.map((key) => ({ key, label: OUTCOME_LABELS[key], color: OUTCOME_COLORS[key] }));

const VERDICT_COLORS: Record<Verdict, string> = { merge: "bg-viz-blue", would_merge: "bg-viz-magenta", handover: "bg-viz-yellow", off: "bg-viz-gray" };

const SPEND_SERIES: Series[] = [{ key: "usd", label: "Spend", color: "bg-viz-blue" }];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const JOBS: [string, string] = ["job", "jobs"];
const percent = (n: number) => `${Math.round(n * 100)}%`;

export function formatDuration(ms: number) {
  const min = ms / 60_000;
  if (min < 1) return "<1 min";
  if (min < 90) return `${Math.round(min)} min`;
  const h = min / 60;
  return h < 36 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`;
}

/** A spend share's figure: what could be priced, marked when some tokens had no price. */
const spendNote = (unpriced: number) => (unpriced > 0 ? `+ ${plural(unpriced, "unpriced run", "unpriced runs")}` : undefined);

function RangeSwitch({ current, onChange }: { current: RangeDays; onChange: (days: RangeDays) => void }) {
  return (
    <div role="radiogroup" aria-label="Range" className="flex shrink-0 items-center rounded-md border p-0.5">
      {RANGES.map((days) => (
        <button
          key={days}
          type="button"
          onClick={() => days !== current && onChange(days)}
          role="radio"
          aria-checked={days === current}
          className={cn(
            "relative h-6 rounded-[5px] px-2 text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            days === current ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {days === current && <motion.span layoutId="analytics-range-marker" transition={{ type: "spring", stiffness: 500, damping: 40 }} className="absolute inset-0 rounded-[5px] bg-accent" />}
          <span className="relative">{days} days</span>
        </button>
      ))}
    </div>
  );
}

/** One figure: its label, the value, and what it counts. */
function Tile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border bg-card px-3.5 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold">{value}</span>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}

const none = <span className="text-muted-foreground">—</span>;

function DurationTile({ label, d, of, note }: { label: string; d: Durations; of: [string, string]; note?: ReactNode }) {
  return (
    <Tile
      label={label}
      value={d.median === null ? none : formatDuration(d.median)}
      note={
        <>
          {d.median === null ? "none yet" : `median · p90 ${formatDuration(d.p90!)} · ${plural(d.count, ...of)}`}
          {note && <> · {note}</>}
        </>
      }
    />
  );
}

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3 py-6 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-0.5">
        <h2 id={`${id}-title`} className="font-semibold">
          {title}
        </h2>
        <p className="text-sm text-pretty text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

const shareRows = (shares: readonly Share[], label: (s: Share) => ReactNode = (s) => s.label) => shares.map((s) => ({ label: label(s), value: s.usd, note: spendNote(s.unpriced) }));

export function Analytics({
  facts,
  days,
  now,
  repo: currentRepo,
  registry,
}: {
  facts: AnalyticsFacts;
  days: RangeDays;
  now: number;
  repo: string | null;
  registry: readonly Pick<RepoSettingsRow, "repo" | "display_name">[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  // Days are the owner's, so the browser's zone; the server render reads UTC until hydration.
  const timeZone = useAfterHydration(() => Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC");

  // Every registered repo, and any other with a job, a run or a decision in the range; counts are jobs claimed.
  const options = useMemo(() => {
    const counts = rangeRepos(facts, { now, days, timeZone });
    const registered = repoOptions(registry, []).map((o) => ({ ...o, jobs: counts.get(o.repo) ?? 0 }));
    const others = [...counts].filter(([r]) => !registered.some((o) => o.repo === r)).map(([repo, jobs]) => ({ repo, name: repoName(repo), jobs }));
    return [...registered, ...others].sort((x, y) => x.name.localeCompare(y.name));
  }, [registry, facts, now, days, timeZone]);
  const [repoChoice, pickRepo] = useRepoFilter(currentRepo);
  const repo = options.some((o) => o.repo === repoChoice) ? repoChoice : null;
  const a = useMemo(() => summarize(facts, { days, now, timeZone, repo }), [facts, days, now, timeZone, repo]);

  const pickRange = (next: RangeDays) => {
    const params = new URLSearchParams(searchParams);
    params.set("days", String(next));
    startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }));
  };

  const empty = a.claimed === 0 && a.spend.total === 0 && a.spend.unpriced === 0 && a.autonomy.decided === 0;
  const owner = a.mergedBy.approval + a.mergedBy.github;
  const verdictParts = VERDICTS.map((key) => ({ key, label: VERDICT_LABELS[key], color: VERDICT_COLORS[key], value: a.autonomy.verdicts[key] }));
  const repoLabel = (r: string) => options.find((o) => o.repo === r)?.name ?? repoName(r);

  return (
    <>
      <PanelHeader
        title="Analytics"
        actions={
          <>
            <RangeSwitch current={days} onChange={pickRange} />
            {options.length > 0 && <RepoSelect options={options} value={repo} onChange={pickRepo} />}
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* A new range loads on the server; the last one stays, faded, until it arrives. */}
        <div className={cn("mx-auto w-full max-w-6xl p-4 transition-opacity md:p-6", pending && "opacity-60")} aria-busy={pending || undefined}>
          {empty ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>Nothing in the last {days} days</EmptyTitle>
                <EmptyDescription>Figures appear once the factory claims a job{repo ? " in this repository" : ""}.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col divide-y">
              <Section id="outcomes" title="Outcomes" description="Jobs claimed in the range, by the day of their latest attempt's claim, and where each stands now.">
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <Tile label="Claimed" value={a.claimed} note={`${a.totals.in_progress} still in progress`} />
                  <Tile label="Merged" value={a.totals.merged_factory + owner} note={`${a.totals.merged_factory} by the factory · ${owner} by you${a.totals.reverted ? ` · ${a.totals.reverted} more reverted` : ""}`} />
                  <Tile
                    label="Success rate"
                    value={a.success.rate === null ? none : percent(a.success.rate)}
                    note={`${a.success.merged} merged of ${plural(a.success.ended, "ended job", "ended jobs")}`}
                  />
                  <Tile label="Handed over" value={a.totals.handed_over} note={`${a.totals.failed} failed · ${a.totals.stopped} stopped`} />
                </div>
                <ChartCard
                  title="Jobs by outcome"
                  note={`Merged by you: ${a.mergedBy.approval} approved in the panel, ${a.mergedBy.github} merged outside the factory`}
                  legend={<Legend series={OUTCOME_SERIES} values={a.totals} />}
                  table={
                    <DataTable
                      head={["Day", ...OUTCOMES.map((o) => OUTCOME_LABELS[o])]}
                      rows={a.outcomes.map(({ day, counts }) => [dayLabel(day), ...OUTCOMES.map((o) => counts[o])])}
                    />
                  }
                >
                  <ColumnChart
                    label="Jobs claimed per day by outcome"
                    days={a.days}
                    series={OUTCOME_SERIES}
                    values={a.outcomes.map(({ counts }) => OUTCOMES.map((o) => counts[o]))}
                    format={String}
                    integer
                  />
                </ChartCard>
              </Section>

              <Section
                id="spend"
                title="Spend"
                description="What runs on the factory's jobs cost at list prices: per day by when each run started, and per job over all its attempts."
              >
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <Tile label="Spend" value={formatUsd(a.spend.total)} note={spendNote(a.spend.unpriced) ?? "every run priced"} />
                  <Tile
                    label="Average merged job"
                    value={a.spend.mergedAverage.usd === null ? none : formatUsd(a.spend.mergedAverage.usd)}
                    note={`${a.spend.mergedAverage.known} of ${plural(a.spend.mergedAverage.merged, "merged job", "merged jobs")} with a known cost`}
                  />
                  <Tile label="Per day" value={formatUsd(a.spend.total / a.days.length)} note={`average over ${a.days.length} days`} />
                  <Tile label="Cost unknown" value={a.spend.unknownJobs} note={`of ${plural(a.claimed, "job", "jobs")}: no usage recorded, or a model without a price`} />
                </div>
                <ChartCard
                  title="Spend per day"
                  note={a.spend.unpriced > 0 ? "Runs on a model without a price count $0 here" : undefined}
                  table={<DataTable head={["Day", "Spend", "Unpriced runs"]} rows={a.spend.byDay.map((d) => [dayLabel(d.day), formatUsd(d.usd), d.unpriced])} />}
                >
                  <ColumnChart label="Spend per day" days={a.days} series={SPEND_SERIES} values={a.spend.byDay.map((d) => [d.usd])} format={formatUsd} formatTick={(n) => `$${n}`} />
                </ChartCard>
                <div className="grid gap-2 lg:grid-cols-2">
                  <ChartCard title="By repository" table={<DataTable head={["Repository", "Spend", "Unpriced runs"]} rows={a.spend.byRepo.map((s) => [s.label, formatUsd(s.usd), s.unpriced])} />}>
                    <BarList rows={shareRows(a.spend.byRepo, (s) => repoLabel(s.label))} format={formatUsd} empty="No spend recorded." />
                  </ChartCard>
                  <ChartCard
                    title="By harness and model"
                    note="Subagents count on their own model; the harness of an earlier attempt isn't kept"
                    table={<DataTable head={["Harness · model", "Spend", "Unpriced runs"]} rows={a.spend.byHarness.map((s) => [s.label, formatUsd(s.usd), s.unpriced])} />}
                  >
                    <BarList rows={shareRows(a.spend.byHarness)} format={formatUsd} empty="No spend recorded." />
                  </ChartCard>
                </div>
                <div className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card px-4 py-3.5">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">Most expensive jobs</span>
                    <span className="text-xs text-muted-foreground">Claimed in the range, every attempt</span>
                  </span>
                  {a.spend.topJobs.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No job in the range has a recorded cost.</p>
                  ) : (
                    <DataTable
                      head={["Job", "Repository", "Outcome", "Spend"]}
                      rows={a.spend.topJobs.map((j) => [
                        <span key="job" className="flex max-w-md min-w-0 items-baseline gap-2">
                          {j.sessionId ? (
                            <Link href={`/?${new URLSearchParams({ run: j.sessionId })}`} className="shrink-0 font-mono underline-offset-2 hover:underline">
                              {j.key}
                            </Link>
                          ) : (
                            <span className="shrink-0 font-mono">{j.key}</span>
                          )}
                          <span className="truncate text-muted-foreground">{j.title}</span>
                        </span>,
                        repoLabel(j.repo),
                        <span key="outcome" className="inline-flex items-center gap-1.5">
                          <Swatch color={OUTCOME_COLORS[j.outcome]} />
                          {OUTCOME_LABELS[j.outcome]}
                        </span>,
                        <span key="spend">
                          {formatUsd(j.usd)}
                          {!j.costKnown && <span className="ms-1 text-muted-foreground">partial</span>}
                        </span>,
                      ])}
                    />
                  )}
                </div>
              </Section>

              <Section id="speed" title="Speed" description="Medians over the jobs claimed in the range, in their latest attempt.">
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <DurationTile label="Claim to PR" d={a.speed.claimToPr} of={JOBS} />
                  <DurationTile
                    label="PR to merge"
                    d={a.speed.prToMerge}
                    of={JOBS}
                    note={`factory ${a.speed.prToMergeFactory.median === null ? "—" : formatDuration(a.speed.prToMergeFactory.median)} · you ${a.speed.prToMergeOwner.median === null ? "—" : formatDuration(a.speed.prToMergeOwner.median)}`}
                  />
                  <DurationTile label="Waiting on your answer" d={a.speed.answerWait} of={["wait", "waits"]} note={`${a.speed.answerWait.open} waiting now`} />
                  <DurationTile label="Waiting on your review" d={a.speed.reviewWait} of={JOBS} note={`${a.speed.reviewWait.open} open now`} />
                </div>
              </Section>

              <Section id="autonomy" title="Autonomy" description="The factory's last merge decision on each PR head it decided in the range, and why it handed over.">
                <div className="grid gap-2 lg:grid-cols-2">
                  <ChartCard
                    title="Decisions"
                    note={plural(a.autonomy.decided, "PR head decided", "PR heads decided")}
                    table={<DataTable head={["Decision", "PR heads"]} rows={verdictParts.map((p) => [p.label, p.value])} />}
                  >
                    <SplitBar parts={verdictParts} label="Merge decisions" />
                  </ChartCard>
                  <ChartCard
                    title="Why it handed over"
                    note={`Of ${plural(a.autonomy.handovers, "handover", "handovers")} under trial or merge when confident; one can give several reasons`}
                    table={<DataTable head={["Reason", "Handovers"]} rows={a.autonomy.reasons.map((r) => [r.reason, r.count])} />}
                  >
                    <BarList rows={a.autonomy.reasons.map((r) => ({ label: r.reason, value: r.count }))} format={String} color="bg-viz-yellow" empty="No handover with reasons in the range." />
                  </ChartCard>
                </div>
              </Section>
            </div>
          )}
        </div>
      </div>
      <PanelFooter summary={`${plural(a.claimed, "job", "jobs")} claimed in the last ${days} days`} note={`Days in ${timeZone}`} />
    </>
  );
}
