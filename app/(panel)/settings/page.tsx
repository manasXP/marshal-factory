import { connection } from "next/server";
import { Suspense } from "react";
import { RealtimeRoot } from "@/components/panel/realtime-root";
import { SettingsForm } from "@/components/panel/settings-form";
import { db } from "@/db/client";
import { load, machinesQuery } from "@/lib/live-queries";
import { readSettings } from "@/lib/settings";

async function Panel() {
  // Without a search param to make the page dynamic, Next would try to prerender it and log the cookie read as an error.
  await connection();
  // load checks the owner before anything is read.
  const machines = await load(machinesQuery());
  const saved = await readSettings(db);
  return (
    <RealtimeRoot>
      <SettingsForm machines={machines} saved={saved} />
    </RealtimeRoot>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="h-full" />}>
      <Panel />
    </Suspense>
  );
}
