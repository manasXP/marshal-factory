import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ExecOptions } from "./exec";
import { localHost, type JobHost } from "./host";
import { pathsOf } from "./sandbox";
import { forbidInTest } from "./test-mode";

// The factory's one way into a job's T3, on whichever host runs it. Starting, messaging, showing
// and listing threads go through the `t3 thread` CLI. What the CLI does not offer (subagent
// threads, interrupting a run) goes to T3's documented MCP endpoint on the same host
// (127.0.0.1:<port>/mcp), signed in with a host-issued bearer session: minimal scopes, a short
// TTL, revoked after use. The token travels on stdin, never in argv, and is never logged. The MCP
// calls run on the host itself (this machine, or inside the job's Modal sandbox) through `host.run`.

const LIST_SUBAGENTS_PAGES = 20;
const CLI = { timeoutMs: 60_000, maxBuffer: 16 * 1024 * 1024 };

/** A tool T3 answered with its failure, such as runtime_mode_escalation_denied; carries T3's message. */
export class T3ToolError extends Error {}

export type SubagentThread = { threadId: string; status: string; latestRunId: string | null };
export type InterruptOutcome = { kind: "requested" } | { kind: "idle" } | { kind: "refused"; reason: string };
type Scope = "orchestration:read" | "orchestration:operate";

export async function startThread(
  host: JobHost,
  { project, message, worktree, branch, title, provider, model }: { project: string; message: string; worktree: string; branch: string; title: string; provider: string; model: string },
) {
  const args = ["thread", "start", project, "-", "--worktree", worktree, "--branch", branch, "--title", title, "--provider", provider, "--model", model, "--json"];
  return (await host.run(host.t3, args, { input: message, ...CLI })).stdout;
}

/** T3 queues a message behind a busy thread's turn; nothing is interrupted. */
export async function sendMessage(host: JobHost, threadId: string, message: string) {
  await host.run(host.t3, ["thread", "send", threadId, "-"], { input: message, timeoutMs: 30_000, maxBuffer: CLI.maxBuffer });
}

/** `t3 thread show --json`, parsed; a thread T3 no longer has fails with "no longer available" in its output. */
export async function showThread(host: JobHost, threadId: string, options: ExecOptions = { timeoutMs: 20_000 }): Promise<unknown> {
  return JSON.parse((await host.run(host.t3, ["thread", "show", threadId, "--json"], options)).stdout);
}

/** `t3 thread list --json` for a project id or a path inside it; the CLI leaves subagent threads out. */
export async function listThreads(host: JobHost, project: string, options: ExecOptions = CLI): Promise<unknown> {
  return JSON.parse((await host.run(host.t3, ["thread", "list", "--project", project, "--json"], options)).stdout);
}

// Runs on the host with node (in a sandbox) or the runner's own bun (on this machine): one MCP
// session over T3's streamable HTTP endpoint, one tool call, then the session ends. It reads
// {origin, token, tool, args} from stdin and prints the tool's result as JSON.
const CALL_SCRIPT = `
const input = JSON.parse(require("fs").readFileSync(0, "utf8"));
const endpoint = new URL("/mcp", input.origin).href;
let session = null;
let id = 0;
async function rpc(method, params, notify) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + input.token };
  if (session) headers["mcp-session-id"] = session;
  const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params };
  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  session = res.headers.get("mcp-session-id") || session;
  const text = await res.text();
  if (!res.ok) throw new Error("T3 MCP " + method + " answered HTTP " + res.status);
  if (notify) return null;
  const payloads = (res.headers.get("content-type") || "").includes("event-stream")
    ? text.split("\\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)))
    : [JSON.parse(text)];
  const reply = payloads.find((p) => p.id === body.id);
  if (!reply || reply.error) throw new Error("T3 MCP " + method + " failed" + (reply && reply.error ? ": " + JSON.stringify(reply.error).slice(0, 300) : ""));
  return reply.result;
}
(async () => {
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "marshal-factory", version: "1.0.0" } });
    await rpc("notifications/initialized", {}, true);
    const result = await rpc("tools/call", { name: input.tool, arguments: input.args });
    process.stdout.write(JSON.stringify(result));
  } finally {
    if (session) await fetch(endpoint, { method: "DELETE", headers: { authorization: "Bearer " + input.token, "mcp-session-id": session } }).catch(() => {});
  }
})().catch((error) => { process.stderr.write(String(error && error.message || error)); process.exit(1); });
`;

const runtimeFile = z.object({ origin: z.string() });
const issued = z.object({ sessionId: z.string(), token: z.string() });
const toolResult = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.object({ text: z.string().optional() })).optional(),
});

function userdataDir(host: JobHost) {
  if (host !== localHost) return pathsOf(host).t3Userdata;
  return join(process.env.T3CODE_HOME ?? join(homedir(), ".t3"), "userdata");
}

/** Signs in to the host's T3 for the length of `work`, then revokes the session. */
async function withMcp<T>(host: JobHost, scopes: readonly Scope[], work: (call: (tool: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<T>) {
  if (host === localHost) forbidInTest("T3's MCP endpoint");
  const runtime = await host.readFile(`${userdataDir(host)}/server-runtime.json`);
  if (runtime === null) throw new Error("T3 is not running on the job's host");
  const { origin } = runtimeFile.parse(JSON.parse(runtime));
  const { stdout } = await host.run(
    host.t3,
    ["auth", "session", "issue", ...scopes.flatMap((scope) => ["--scope", scope]), "--ttl", "5m", "--label", "marshal-factory", "--json"],
    { timeoutMs: 30_000 },
  );
  let session: z.infer<typeof issued>;
  try {
    session = issued.parse(JSON.parse(stdout));
  } catch {
    // A parse error can quote its input, which holds the token.
    throw new Error("`t3 auth session issue --json` printed something other than a session");
  }
  const runner = host === localHost ? process.execPath : "node";
  try {
    return await work(async (tool, args) => {
      const { stdout: out } = await host.run(runner, ["-e", CALL_SCRIPT], { input: JSON.stringify({ origin, token: session.token, tool, args }), ...CLI });
      const result = toolResult.parse(JSON.parse(out));
      if (result.isError) throw new T3ToolError((result.content?.find((part) => part.text)?.text ?? `${tool} failed`).slice(0, 500));
      return result.structuredContent;
    });
  } finally {
    await host.run(host.t3, ["auth", "session", "revoke", session.sessionId], { timeoutMs: 30_000 }).catch(() => undefined);
  }
}

const listed = z.object({
  threads: z.array(
    z.object({
      threadId: z.string(),
      status: z.string(),
      latestRunId: z.string().nullable(),
      parentThreadId: z.string().nullable(),
      relationshipToParent: z.string().nullable(),
    }),
  ),
  nextCursor: z.number().int().nullable(),
});

/** Every subagent thread below `threadId`, at any depth, with its run status; read-only. */
export async function listSubagents(host: JobHost, threadId: string, projectId: string): Promise<SubagentThread[]> {
  return withMcp(host, ["orchestration:read"], async (call) => {
    const all: z.infer<typeof listed>["threads"] = [];
    let cursor: number | null = 0;
    for (let page = 0; cursor !== null && page < LIST_SUBAGENTS_PAGES; page++) {
      const result = listed.parse(await call("t3_thread_list", { projectId, includeSubagents: true, limit: 100, cursor }));
      all.push(...result.threads);
      cursor = result.nextCursor;
    }
    if (cursor !== null) throw new Error(`project ${projectId} has more than ${LIST_SUBAGENTS_PAGES * 100} threads; its subagent threads could not all be read`);
    const below = new Set([threadId]);
    const found: SubagentThread[] = [];
    // Parents can be listed after their children, so repeat until a pass adds nothing.
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of all) {
        if (t.relationshipToParent !== "subagent" || !t.parentThreadId || !below.has(t.parentThreadId) || below.has(t.threadId)) continue;
        below.add(t.threadId);
        found.push({ threadId: t.threadId, status: t.status, latestRunId: t.latestRunId });
        grew = true;
      }
    }
    return found;
  });
}

const interrupted = z.object({ status: z.string() });

/**
 * Asks T3 to interrupt the thread's active run; `requestId` makes a repeat a no-op. T3 refuses a
 * caller whose session allows less than the thread's runtime mode; that refusal is an outcome.
 */
export async function interruptThread(host: JobHost, threadId: string, requestId: string, reason: string): Promise<InterruptOutcome> {
  return withMcp(host, ["orchestration:read", "orchestration:operate"], async (call) => {
    try {
      const { status } = interrupted.parse(await call("t3_thread_interrupt", { threadId, reason: reason.slice(0, 2000), clientRequestId: requestId.slice(0, 256) }));
      return status === "interrupt_requested" ? { kind: "requested" } : { kind: "idle" };
    } catch (error) {
      if (error instanceof T3ToolError) return { kind: "refused", reason: error.message };
      throw error;
    }
  });
}
