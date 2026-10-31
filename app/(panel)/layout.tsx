import { cookies } from "next/headers";
import { Suspense } from "react";
import { InboxCount } from "@/components/panel/inbox-count";
import { COLLAPSED_COOKIE, PanelShell } from "@/components/panel/panel-shell";
import { RealtimeRoot } from "@/components/panel/realtime-root";
import { Badge } from "@/components/ui/badge";
import { db } from "@/db/client";
import { assertOwner } from "@/lib/auth/server";
import { jobsQuery, load } from "@/lib/live-queries";
import { readPause } from "@/lib/queue";

async function LiveInboxCount() {
  return <InboxCount jobs={await load(jobsQuery())} />;
}

/** Marks the Queue entry while new work is paused, so a pause is never forgotten; a dot while the rail is collapsed. */
async function PausedBadge() {
  await assertOwner();
  if (!(await readPause(db))) return null;
  return (
    <>
      <Badge variant="warning" size="sm" className="in-data-collapsed:hidden">
        Paused
      </Badge>
      <span aria-hidden className="absolute top-1.5 left-6 hidden size-1.5 rounded-full bg-warning in-data-collapsed:block" />
    </>
  );
}

export default async function PanelLayout({ children }: LayoutProps<"/">) {
  const collapsed = (await cookies()).get(COLLAPSED_COOKIE)?.value === "false";
  return (
    <RealtimeRoot>
      <PanelShell
        defaultCollapsed={collapsed}
        inboxCount={
          <Suspense fallback={null}>
            <LiveInboxCount />
          </Suspense>
        }
        queueBadge={
          <Suspense fallback={null}>
            <PausedBadge />
          </Suspense>
        }
      >
        {children}
      </PanelShell>
    </RealtimeRoot>
  );
}
