import { connection } from "next/server";
import { Suspense } from "react";
import { Machines } from "@/components/panel/machines";
import { RealtimeRoot } from "@/components/panel/realtime-root";
import { load, machinesQuery } from "@/lib/live-queries";

async function Panel() {
  // Without a search param to make the page dynamic, Next would try to prerender it and log the cookie read as an error.
  await connection();
  const machines = await load(machinesQuery());
  return (
    <RealtimeRoot>
      <Machines machines={machines} />
    </RealtimeRoot>
  );
}

export default function MachinesPage() {
  return (
    <Suspense fallback={<div className="h-full" />}>
      <Panel />
    </Suspense>
  );
}
