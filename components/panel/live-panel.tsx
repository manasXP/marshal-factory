"use client";

import { useMemo } from "react";
import type { AgentRow, AuditRow, EventRow, JobRow, MachineRow, RunRow } from "@/db/schema";
import { Board } from "./board";
import { boardCards } from "./cards";
import { attemptBranch } from "@/lib/factory";
import { reportedHarnesses } from "@/lib/machine";
import { groupBy, spendOf } from "./format";
import { NewJobButton } from "./new-job-button";
import { OtherActivity } from "./other-activity";
import { RunDetail } from "./run-detail";
import { useFeed, type Feed } from "./sealed";
import { PanelHeader } from "./panel-header";
import { StatsStrip } from "./stats-strip";
import { useAfterHydration } from "./time";

export type DetailProps = {
  sessionId: string;
  agents: Feed<AgentRow>;
  events: Feed<EventRow>;
  stages: Feed<EventRow>;
  stagesPath: string;
  /** Present when the run belongs to a job. */
  audit: { feed: Feed<AuditRow>; path: string } | undefined;
};

export type PanelView = "board" | "activity";

export function LivePanel({
  view,
  jobs,
  runs,
  agents,
  machines,
  detail,
}: {
  view: PanelView;
  jobs: Feed<JobRow>;
  runs: Feed<RunRow>;
  agents: Feed<AgentRow>;
  machines: Feed<MachineRow>;
  detail: DetailProps | undefined;
}) {
  const { rows: jobRows } = useFeed(jobs, "/api/live/jobs");
  const { rows: runRows, status } = useFeed(runs, "/api/live/runs");
  const { rows: agentRows } = useFeed(agents, "/api/live/agents");
  const { rows: machineRows } = useFeed(machines, "/api/live/machines");
  const machineById = useMemo(() => new Map(machineRows.map((m) => [m.id, m])), [machineRows]);

  const agentsBySession = useMemo(
    () => groupBy(agentRows, (a) => a.session_id),
    [agentRows],
  );
  const drivers = useMemo(
    () => new Map((reportedHarnesses(machineRows, 0) ?? []).map((h) => [h.id, h.driver])),
    [machineRows],
  );
  const cards = useMemo(() => boardCards(jobRows, runRows, drivers), [jobRows, runRows, drivers]);
  const unstaged = useMemo(() => {
    const claimed = new Set(jobRows.map((j) => j.key));
    return runRows.filter((r) => r.stage === null && !(r.job_key && claimed.has(r.job_key)));
  }, [jobRows, runRows]);
  const startOfToday = useAfterHydration(() => new Date().setHours(0, 0, 0, 0), 0);
  const selectedRun = detail && runRows.find((r) => r.session_id === detail.sessionId);
  const selectedJob = selectedRun?.job_key
    ? jobRows.find((j) => j.key === selectedRun.job_key)
    : undefined;

  return (
    <>
      <PanelHeader
        title={view === "board" ? "Board" : "Other activity"}
        status={status}
        note={`${runRows.filter((r) => r.status === "active").length} active`}
        actions={view === "board" ? <NewJobButton /> : undefined}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <StatsStrip runs={runRows} agentsBySession={agentsBySession} startOfToday={startOfToday} />
        <div className={`grid min-h-0 flex-1 ${selectedRun ? "grid-cols-[1fr_420px]" : "grid-cols-1"}`}>
          {view === "board" ? (
            <Board cards={cards} agentsBySession={agentsBySession} selected={detail?.sessionId} machines={machineById} />
          ) : (
            <OtherActivity runs={unstaged} agentsBySession={agentsBySession} selected={detail?.sessionId} />
          )}
          {selectedRun && detail && (
            <RunDetail
              key={detail.sessionId}
              run={selectedRun}
              agents={detail.agents}
              events={detail.events}
              stages={detail.stages}
              stagesPath={detail.stagesPath}
              audit={detail.audit}
              job={selectedJob}
              machine={selectedJob?.machine_id ? machineById.get(selectedJob.machine_id) : undefined}
              jobSpend={
                selectedJob
                  ? {
                      usd: spendOf(
                        runRows.filter((r) => r.branch === attemptBranch(selectedJob.key, selectedJob.attempt)),
                        agentsBySession,
                      ),
                      capUsd: selectedJob.budget_usd,
                      attempt: selectedJob.attempt,
                    }
                  : undefined
              }
            />
          )}
        </div>
      </div>
    </>
  );
}
