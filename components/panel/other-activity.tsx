import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import type { AgentRow, RunRow } from "@/db/schema";
import { RunCard } from "./run-card";

/** Claude Code sessions that report no factory stage: hand-started work in a factory repo, or anything else the hooks see. */
export function OtherActivity({
  runs,
  agentsBySession,
  selected,
}: {
  runs: readonly RunRow[];
  agentsBySession: Map<string, AgentRow[]>;
  selected: string | undefined;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      {runs.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No other sessions</EmptyTitle>
            <EmptyDescription>
              Claude Code sessions that never report a stage appear here as soon as the reporter hook sends their first event.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-2.5">
          {runs.map((run) => (
            <RunCard key={run.session_id} run={run} agents={agentsBySession.get(run.session_id) ?? []} selected={run.session_id === selected} />
          ))}
        </div>
      )}
    </div>
  );
}
