"use client";

import { TableIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// The analytics page's charts, in plain HTML: thin columns and bars from one baseline, a 2px gap
// between touching marks, hairline grid, text in text colors with the series color only on the mark
// beside it. Every chart has a table view, and every column a tooltip on hover and focus.

/** A series: its label and the Tailwind background class of its color (globals.css --viz-*). */
export type Series = { key: string; label: string; color: string };

/** "2026-10-31" as "31 Oct". Keys are calendar days, so the date is read in UTC. */
export const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** The smallest 1, 2 or 5 times a power of ten at or above n; an empty axis still reads 0 to 1. */
function niceMax(n: number) {
  if (n <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(n));
  return [1, 2, 5, 10].map((f) => f * magnitude).find((v) => v >= n)!;
}

export function Swatch({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-[3px]", color, className)} />;
}

export function Legend({ series, values }: { series: readonly Series[]; values?: Record<string, ReactNode> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <Swatch color={s.color} />
          {s.label}
          {values && <span className="text-foreground tabular-nums">{values[s.key]}</span>}
        </li>
      ))}
    </ul>
  );
}

/** A chart in a card: its title and note, a switch to its table, and the chart or the table. */
export function ChartCard({ title, note, legend, table, children }: { title: string; note?: ReactNode; legend?: ReactNode; table: ReactNode; children: ReactNode }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <figure className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card px-4 py-3.5">
      <figcaption className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{title}</span>
          {note && <span className="text-xs text-muted-foreground">{note}</span>}
        </span>
        <Button variant={showTable ? "secondary" : "ghost"} size="xs" aria-pressed={showTable} onClick={() => setShowTable((t) => !t)} className={showTable ? undefined : "text-muted-foreground"}>
          <TableIcon data-icon="inline-start" />
          Table
        </Button>
      </figcaption>
      {legend}
      {showTable ? <div className="max-h-80 overflow-auto">{table}</div> : children}
    </figure>
  );
}

/** A plain table for a chart's table view; the first column names the row, the rest are numbers. */
export function DataTable({ head, rows }: { head: readonly string[]; rows: readonly (readonly ReactNode[])[] }) {
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-card text-muted-foreground">
        <tr>
          {head.map((h, i) => (
            <th key={h} scope="col" className={cn("py-1.5 font-normal", i === 0 ? "text-left" : "text-right")}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y tabular-nums">
        {rows.map(([first, ...rest], i) => (
          <tr key={i}>
            <th scope="row" className="py-1.5 text-left font-normal">
              {first}
            </th>
            {rest.map((cell, j) => (
              <td key={j} className="py-1.5 text-right">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const PLOT_HEIGHT = "h-40";

/**
 * Columns over days, one stacked segment per series from the baseline up. `values[i][s]` is day i's
 * value for series s. Columns stay at most 24px wide; the slot around each is its hover target.
 */
export function ColumnChart({
  days,
  series,
  values,
  format,
  formatTick = format,
  integer = false,
  label,
}: {
  days: readonly string[];
  series: readonly Series[];
  values: readonly (readonly number[])[];
  format: (n: number) => string;
  formatTick?: (n: number) => string;
  integer?: boolean;
  label: string;
}) {
  const totals = values.map((v) => v.reduce((sum, n) => sum + n, 0));
  const max = niceMax(Math.max(0, ...totals));
  const ticks = [max, max / 2, 0].filter((t) => !integer || Number.isInteger(t));
  // About six date labels whatever the range, always the last day.
  const every = Math.max(1, Math.round(days.length / 6));
  return (
    <TooltipProvider delay={0}>
      <div role="group" aria-label={label} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <div className={cn("relative w-10", PLOT_HEIGHT)} aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2 text-[11px] text-muted-foreground tabular-nums" style={{ top: `${100 - (t / max) * 100}%` }}>
              {formatTick(t)}
            </span>
          ))}
        </div>
        <div className={cn("relative", PLOT_HEIGHT)}>
          {ticks.map((t) => (
            <div key={t} aria-hidden className={cn("absolute inset-x-0 border-t", t === 0 && "border-muted-foreground/30")} style={{ top: `${100 - (t / max) * 100}%` }} />
          ))}
          <div className="absolute inset-0 flex gap-0.5">
            {days.map((day, i) => {
              const parts = series.map((s, j) => ({ ...s, value: values[i]![j]! })).filter((p) => p.value > 0);
              return (
                <Tooltip key={day}>
                  <TooltipTrigger
                    aria-label={`${dayLabel(day)}: ${parts.map((p) => `${p.label} ${format(p.value)}`).join(", ") || "none"}`}
                    className="group flex min-w-0 flex-1 cursor-default items-end justify-center rounded-sm outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {totals[i]! > 0 && (
                      <div className="flex w-full max-w-6 flex-col-reverse gap-0.5" style={{ height: `${(totals[i]! / max) * 100}%` }}>
                        {parts.map((p, k) => (
                          <div
                            key={p.key}
                            className={cn("min-h-px group-hover:brightness-110", p.color, k === parts.length - 1 && "rounded-t-[4px]")}
                            style={{ flexGrow: p.value, flexBasis: 0 }}
                          />
                        ))}
                      </div>
                    )}
                  </TooltipTrigger>
                  <TooltipPopup className="min-w-36">
                    <div className="flex flex-col gap-1 py-0.5">
                      <span className="text-muted-foreground">{dayLabel(day)}</span>
                      {parts.map((p) => (
                        <span key={p.key} className="flex items-center gap-2">
                          <span aria-hidden className={cn("h-0.5 w-3 shrink-0 rounded-full", p.color)} />
                          <span className="font-medium tabular-nums">{format(p.value)}</span>
                          <span className="text-muted-foreground">{p.label}</span>
                        </span>
                      ))}
                      {parts.length === 0 && <span className="font-medium">None</span>}
                      {parts.length > 1 && <span className="text-muted-foreground">Total {format(totals[i]!)}</span>}
                    </div>
                  </TooltipPopup>
                </Tooltip>
              );
            })}
          </div>
        </div>
        <div />
        <div aria-hidden className="relative mt-1.5 h-4 text-[11px] text-muted-foreground">
          {days.map((day, i) =>
            (days.length - 1 - i) % every === 0 ? (
              <span key={day} className="absolute -translate-x-1/2 whitespace-nowrap last:translate-x-[-100%]" style={{ left: `${((i + 0.5) / days.length) * 100}%` }}>
                {dayLabel(day)}
              </span>
            ) : null,
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

/** Ranked horizontal bars in one color, each value printed beside its bar. */
export function BarList({ rows, format, color = "bg-viz-blue", empty }: { rows: readonly { label: ReactNode; value: number; note?: ReactNode }[]; format: (n: number) => string; color?: string; empty: string }) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value));
  return (
    // One grid for every row, so all bars start on the same baseline.
    <ul className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-x-3 gap-y-2 text-xs">
      {rows.map((row, i) => (
        <li key={i} className="contents">
          <span className="truncate">{row.label}</span>
          <span className="h-2.5">
            {row.value > 0 && <span className={cn("block h-full rounded-r-[4px]", color)} style={{ width: `${Math.max(1, (row.value / (max || 1)) * 100)}%` }} />}
          </span>
          <span className="text-right tabular-nums">
            {format(row.value)}
            {row.note && <span className="ms-1.5 text-muted-foreground">{row.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One whole split into parts: a thin bar with no text, and beside it each part's swatch, name, count and share. */
export function SplitBar({ parts, label }: { parts: readonly (Series & { value: number })[]; label: string }) {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  const share = (n: number) => (total === 0 ? "0%" : `${Math.round((n / total) * 100)}%`);
  return (
    <div className="flex flex-col gap-3">
      <div role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(", ")}`} className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted">
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span key={p.key} className={p.color} style={{ flexGrow: p.value, flexBasis: 0 }} />
          ))}
      </div>
      <ul className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-2">
            <Swatch color={p.color} />
            <span className="min-w-0 flex-1 truncate">{p.label}</span>
            <span className="tabular-nums">{p.value}</span>
            <span className="w-9 text-right text-muted-foreground tabular-nums">{share(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
