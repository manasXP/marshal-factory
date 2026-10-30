import type { JobHost } from "../lib/host";
import { flushOutbox, HIGH_WATER, httpSend, localFs, stateDir, type FlushResult, type OutboxFs, type Send } from "../lib/outbox";
import { SANDBOX_HOME } from "../lib/sandbox";
import { forbidInTest } from "../lib/test-mode";
import { config } from "./config";
import { sandboxRuntime } from "./sandbox";

// The runner delivers what hooks and MCP calls left in an outbox: this machine's on every tick, and
// a sandbox's before it hibernates or ends and right after it wakes, so a snapshot or a terminated
// sandbox never takes undelivered events with it. A flush never fails the step that called it.

const LOCAL_BUDGET_MS = 30_000;
const SANDBOX_BUDGET_MS = 60_000;

/** The outbox state dir inside a Modal sandbox, where the hooks and the MCP server run as root; a host's own home names it elsewhere. */
export const SANDBOX_STATE_DIR = stateDir(SANDBOX_HOME, {});

/** How the runner posts an outbox; regressions swap `send` for the ingest projection. */
export const outboxClient: { send: Send } = {
  send: (events, timeoutMs) => {
    forbidInTest("the deployed ingest function");
    return httpSend(config.ingestUrl, config.secret)(events, timeoutMs);
  },
};

const summary = (result: FlushResult) => ({
  delivered: result.delivered,
  left: result.left,
  rejected: result.rejected,
  ...(result.stuck.length > 0 && { stuck: result.stuck }),
  ...(result.error && { error: result.error }),
});

async function flush(fs: OutboxFs, state: string, budgetMs: number, detail: Record<string, unknown>) {
  try {
    const result = await flushOutbox(fs, state, outboxClient.send, { budgetMs });
    if (result.delivered > 0 || result.rejected.length > 0 || result.stuck.length > 0 || result.error) sandboxRuntime.log("outbox:flushed", { ...detail, ...summary(result) });
    if (result.left > HIGH_WATER) sandboxRuntime.log("outbox:backlog", { ...detail, left: result.left });
    return result;
  } catch (error) {
    sandboxRuntime.log("outbox:flush-failed", { ...detail, error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    return undefined;
  }
}

/** This machine's outbox, which local Claude Code hooks and MCP servers write. */
export async function flushLocalOutbox() {
  const result = await flush(localFs, stateDir(), LOCAL_BUDGET_MS, { where: "local" });
  return result && summary(result);
}

/** A job sandbox's outbox, read and cleared through its host; a sandbox already gone is logged and skipped. */
export const flushSandboxOutbox = (key: string, host: JobHost) => flush(host, host.home ? stateDir(host.home, {}) : SANDBOX_STATE_DIR, SANDBOX_BUDGET_MS, { where: "sandbox", key });
