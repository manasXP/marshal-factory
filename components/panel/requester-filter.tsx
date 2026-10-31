"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { startTransition, useEffect, useMemo, useOptimistic } from "react";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { JobRow } from "@/db/schema";
import { EVERYONE, isRequestedBy, MINE, REQUESTER_FILTER_COOKIE } from "@/lib/requester-filter";

const remember = (mine: boolean) => {
  document.cookie = `${REQUESTER_FILTER_COOKIE}=${mine ? MINE : EVERYONE}; path=/; max-age=${60 * 60 * 24 * 365}`;
};

/**
 * Whether the jobs page and the inbox show only the viewer's jobs. A pick is remembered in the
 * cookie and written to `?by`, and the page stays mounted, so the live feeds stay subscribed.
 */
export function useRequesterFilter(current: boolean) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [mine, setOptimistic] = useOptimistic(current);
  useEffect(() => remember(current), [current]);
  const pick = (next: boolean) => {
    remember(next);
    const params = new URLSearchParams(searchParams);
    if (next) params.set("by", MINE);
    else params.delete("by");
    const query = params.toString();
    startTransition(() => {
      setOptimistic(next);
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  };
  return [mine, pick] as const;
}

/** Whether cards and rows name who each job is for: only while more than one person has jobs. */
export function useShowsRequester(jobs: readonly Pick<JobRow, "requested_by">[]) {
  return useMemo(() => new Set(jobs.flatMap((j) => (j.requested_by ? [j.requested_by.toLowerCase()] : []))).size > 1, [jobs]);
}

export function RequesterSelect({ jobs, viewer, mine, onChange }: { jobs: readonly Pick<JobRow, "requested_by">[]; viewer: string; mine: boolean; onChange: (mine: boolean) => void }) {
  const items = [
    { value: EVERYONE, label: "Everyone", jobs: jobs.length },
    { value: MINE, label: "Mine", jobs: jobs.filter((j) => isRequestedBy(j, viewer)).length },
  ];
  return (
    <Select items={items} value={mine ? MINE : EVERYONE} onValueChange={(next) => next !== null && onChange(next === MINE)}>
      <SelectTrigger size="sm" aria-label="Requested by" className="w-auto shrink-0">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            <span className="flex w-full items-center justify-between gap-3">
              {item.label}
              <span className="text-xs text-muted-foreground tabular-nums">{item.jobs}</span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
