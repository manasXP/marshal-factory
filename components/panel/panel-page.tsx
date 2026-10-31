import { cookies } from "next/headers";
import { Suspense } from "react";
import { JOB_VIEW_COOKIE, parseJobView } from "@/components/panel/job-view";
import { LivePanel, type DetailProps, type PanelView } from "@/components/panel/live-panel";
import { PanelPageSkeleton } from "@/components/panel/skeletons";
import { db } from "@/db/client";
import {
  agentsOverviewQuery,
  jobAuditQuery,
  jobEvidenceQuery,
  jobsQuery,
  jobStagesQuery,
  load,
  machinesQuery,
  parseJobKey,
  runJob,
  runsQuery,
  sessionAgentsQuery,
  sessionEventsQuery,
  sessionStagesQuery,
} from "@/lib/live-queries";
import { auth } from "@/lib/auth/server";
import { REPO_FILTER_COOKIE, repoFilter } from "@/lib/repo-filter";
import { mineOnly, REQUESTER_FILTER_COOKIE } from "@/lib/requester-filter";
import { parseSessionId, runFeedPath } from "@/lib/run-links";
import { readRegistry } from "@/lib/repositories";

async function loadDetail(sessionId: string): Promise<DetailProps> {
  const { jobKey, jobId } = await runJob(sessionId);
  const [agents, events, stages, audit, evidence] = await Promise.all([
    load(sessionAgentsQuery(sessionId)),
    load(sessionEventsQuery(sessionId)),
    load(jobKey ? jobStagesQuery(jobKey) : sessionStagesQuery(sessionId)),
    jobId ? load(jobAuditQuery(jobId)) : undefined,
    jobId && jobKey ? load(jobEvidenceQuery(jobKey)) : undefined,
  ]);
  const stagesPath = jobKey
    ? `/api/live/jobs/${encodeURIComponent(jobKey)}/stages`
    : runFeedPath("stages", sessionId);
  const auditFeed = audit && jobKey ? { feed: audit, path: `/api/live/jobs/${encodeURIComponent(jobKey)}/audit` } : undefined;
  const evidenceFeed = evidence && jobKey ? { feed: evidence, path: `/api/live/jobs/${encodeURIComponent(jobKey)}/evidence` } : undefined;
  return { sessionId, agents, events, stages, stagesPath, audit: auditFeed, evidence: evidenceFeed };
}

async function Panel({ view, searchParams }: { view: PanelView; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { run, job, view: rawView, repo, by, archived } = await searchParams;
  const sessionId = parseSessionId(typeof run === "string" ? run : undefined);
  // Not awaited: the page streams while the run's own feeds load, and the side panel waits for them on its own.
  const detail = sessionId ? { sessionId, data: loadDetail(sessionId) } : undefined;
  const [jobs, runs, agents, machines, jar, session] = await Promise.all([
    load(jobsQuery()),
    load(runsQuery()),
    load(agentsOverviewQuery()),
    load(machinesQuery()),
    cookies(),
    auth.getSession(),
  ]);
  const jobView = parseJobView(rawView) ?? parseJobView(jar.get(JOB_VIEW_COOKIE)?.value) ?? "board";
  // After the loads, which check the owner.
  const registry = await readRegistry(db);
  return (
    <LivePanel
      view={view}
      jobView={jobView}
      repo={repoFilter(repo, jar.get(REPO_FILTER_COOKIE)?.value)}
      mine={mineOnly(by, jar.get(REQUESTER_FILTER_COOKIE)?.value)}
      viewer={session.data?.user?.email ?? null}
      archived={view === "jobs" && archived === "1"}
      registry={registry.map((r) => ({ repo: r.repo, display_name: r.display_name, enabled: r.enabled, is_default: r.is_default }))}
      jobs={jobs}
      runs={runs}
      agents={agents}
      machines={machines}
      detail={detail}
      inboxKey={typeof job === "string" ? parseJobKey(job) : undefined}
    />
  );
}

/** The inbox, the jobs page (board or list) and the other-activity page share their data, their live feeds and run detail. */
export function PanelPage({ view, searchParams }: { view: PanelView; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <Suspense fallback={<PanelPageSkeleton view={view} />}>
      <Panel view={view} searchParams={searchParams} />
    </Suspense>
  );
}
