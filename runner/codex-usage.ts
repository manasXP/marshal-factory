import { homedir } from "node:os";
import { join } from "node:path";
import { and, eq, like } from "drizzle-orm";
import { db } from "../db/client";
import { agents, runs, type RunRow } from "../db/schema";
import { codexUsage, readRollouts, ROLLOUT_SLACK_MS } from "../lib/codex-usage";
import type { Usage } from "../lib/events";
import { HostAsleepError, HostGoneError, localHost, type JobHost } from "../lib/host";
import { pathsOf } from "../lib/sandbox";
import { postEvent } from "./ingest-client";

// Codex has no hooks, so its usage is read from its rollout files on the job's host (see
// lib/codex-usage.ts) and posted as the same `usage` event a Claude Code reporter sends: the run's
// newest root thread is the run's usage, every other thread of it a subagent row. Ingest keeps the
// greatest totals, so a replay or an older read never lowers them.

/** Where Codex writes its sessions on the host: the sandbox's CODEX_HOME, or this machine's. */
export const codexHomeOf = (host: JobHost) => (host === localHost ? (process.env.CODEX_HOME ?? join(homedir(), ".codex")) : pathsOf(host).codexHome);

type Row = Pick<RunRow, "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "model">;
const lags = (u: Usage, row: Row | undefined) =>
  !row ||
  u.input > row.input_tokens ||
  u.output > row.output_tokens ||
  u.cacheRead > row.cache_read_tokens ||
  u.cacheWrite > row.cache_write_tokens ||
  u.model !== row.model;

const UNKNOWN_MODEL = "unknown";
/** A rollout read before its first turn_context keeps the model the board has; with none, it waits for one. */
const withModel = (u: Usage, recorded: string | null | undefined): Usage | undefined => {
  const model = u.model !== UNKNOWN_MODEL ? u.model : recorded && recorded !== UNKNOWN_MODEL ? recorded : undefined;
  return model ? { ...u, model } : undefined;
};
const fingerprintOf = (u: Usage) => `${u.input}.${u.output}.${u.cacheRead}.${u.cacheWrite}.${u.model}`;

/**
 * Posts the run's Codex usage when its rollouts are ahead of the board; true when it did. A subagent
 * whose last turn ended, or any subagent once `final`, is settled with an agent_stop, since Codex
 * sends no SubagentStop of its own.
 */
export async function recordCodexUsage(run: RunRow, host: JobHost, { final = false }: { final?: boolean } = {}) {
  const startedAt = run.started_at.getTime();
  const rollouts = await readRollouts(host, codexHomeOf(host), startedAt - ROLLOUT_SLACK_MS);
  const usage = codexUsage(rollouts, { cwd: run.cwd, branch: run.branch, startedAt });
  const main = usage && withModel(usage.main.usage, run.model);
  if (!usage || !main) return false;
  const rows = await db.select().from(agents).where(eq(agents.session_id, run.session_id));
  const others = usage.others.flatMap((r) => {
    const agentId = `codex:${r.threadId}`;
    const row = rows.find((a) => a.agent_id === agentId);
    const u = withModel(r.usage, row?.model);
    if (!u) return [];
    const settle = (final || r.settled) && row?.status !== "completed";
    return [{ agentId, usage: u, behind: lags(u, row) || settle, settle }];
  });
  if (!lags(main, run) && !others.some((o) => o.behind)) return false;
  // Never before the run opened, so a usage read cannot move its start, nor after its last event.
  const at = Math.max(startedAt, Math.min(usage.main.lastUsageAt ?? run.last_event_at.getTime(), run.last_event_at.getTime()));
  const running = others.filter((o) => !o.settle);
  await postEvent({
    eventId: `codex-usage:${run.session_id}:${[main, ...running.map((o) => o.usage)].map(fingerprintOf).join(":")}`,
    sessionId: run.session_id,
    at,
    kind: "usage",
    usage: main,
    agents: running.map(({ agentId, usage: u }) => ({ agentId, usage: u })),
  });
  for (const o of others.filter((x) => x.settle)) {
    await postEvent({
      eventId: `codex-stop:${o.agentId}:${fingerprintOf(o.usage)}`,
      sessionId: run.session_id,
      at,
      kind: "agent_stop",
      agentId: o.agentId,
      status: "completed",
      usage: o.usage,
      model: o.usage.model,
    });
  }
  return true;
}

/**
 * Records the job's Codex usage before its sandbox ends or sleeps, since its rollouts go with it.
 * A failure is logged and never holds up the teardown or the hibernate.
 */
export async function recordJobCodexUsage(key: string, host: JobHost) {
  try {
    const codexRuns = await db.select().from(runs).where(and(eq(runs.job_key, key), like(runs.session_id, "mcp:%")));
    // The thread is settled or about to end, so no subagent of it runs any more.
    for (const run of codexRuns) await recordCodexUsage(run, host, { final: true });
  } catch (error) {
    const reason = error instanceof HostGoneError || error instanceof HostAsleepError ? error.message : String(error);
    console.log(JSON.stringify({ at: new Date().toISOString(), event: "codex-usage:skipped", key, reason }));
  }
}
