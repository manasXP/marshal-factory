import { cookies } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import { Analytics } from "@/components/panel/analytics";
import { AnalyticsSkeleton, PageSkeleton } from "@/components/panel/skeletons";
import { db } from "@/db/client";
import { parseRange } from "@/lib/analytics";
import { readRange } from "@/lib/analytics-data";
import { assertOwner } from "@/lib/auth/server";
import { REPO_FILTER_COOKIE, repoFilter } from "@/lib/repo-filter";
import { readRegistry } from "@/lib/repositories";

async function Panel({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  // Not a live page, so no load() to check the owner first.
  await assertOwner();
  const [{ days: rawDays, repo }, jar] = await Promise.all([searchParams, cookies()]);
  const days = parseRange(rawDays);
  const [{ now, facts }, registry] = await Promise.all([readRange(db, days), readRegistry(db)]);
  return (
    <Analytics
      facts={facts}
      days={days}
      now={now}
      repo={repoFilter(repo, jar.get(REPO_FILTER_COOKIE)?.value)}
      registry={registry.map((r) => ({ repo: r.repo, display_name: r.display_name }))}
    />
  );
}

export default function AnalyticsPage(props: PageProps<"/analytics">) {
  return (
    <Suspense fallback={<PageSkeleton title="Analytics"><AnalyticsSkeleton /></PageSkeleton>}>
      <Panel searchParams={props.searchParams} />
    </Suspense>
  );
}
