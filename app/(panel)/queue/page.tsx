import { connection } from "next/server";
import { Suspense } from "react";
import { Queue } from "@/components/panel/queue";
import { PageSkeleton, RowsSkeleton } from "@/components/panel/skeletons";
import { db } from "@/db/client";
import { jobsQuery, load } from "@/lib/live-queries";
import { readQueue } from "@/lib/queue";
import { readRegistry } from "@/lib/repositories";

async function Panel() {
  await connection();
  // load checks the owner before anything is read.
  const jobs = await load(jobsQuery());
  const [{ pause, items }, registry] = await Promise.all([readQueue(db), readRegistry(db)]);
  return <Queue jobs={jobs} pause={pause} items={items} registry={registry.map((r) => ({ repo: r.repo, display_name: r.display_name }))} />;
}

export default function QueuePage() {
  return (
    <Suspense fallback={<PageSkeleton title="Queue"><RowsSkeleton /></PageSkeleton>}>
      <Panel />
    </Suspense>
  );
}
