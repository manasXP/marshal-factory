import "./test-guard";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { eq, inArray, like, or } from "drizzle-orm";
import type { FactoryEvent } from "../lib/events";
import { fake, fakeModal, sandboxes, type FakeSandbox } from "./fake-modal";
import { serve } from "./serve";

const { db } = await import("../db/client");
const { events, jobs, runs } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { ingestBodySchema } = await import("../lib/events");
const { ingest } = await import("../lib/ingest");
const { REPORT_STAGE_TOOL } = await import("../lib/factory");
const { appendEvent, flushOutbox, localFs, outboxDir, readIngestTarget, rejectedDir } = await import("../lib/outbox");
const { mcpIdentity, mcpPosts } = await import("../lib/report-identity");
const { modal, modalHost } = await import("../lib/modal-host");
const { boardCards, harnessLine } = await import("../components/panel/cards");
const { config } = await import("../runner/ops");
const { hibernateIdle, teardownFinished, wakeJob } = await import("../runner/lifecycle");
const { flushSandboxOutbox, outboxClient, SANDBOX_STATE_DIR } = await import("../runner/outbox");
const { sandboxRuntime } = await import("../runner/sandbox");

modal.api = fakeModal;

const stamp = Date.now() % 1_000_000;
const key = (name: string) => `OB${name}-${stamp}`;
const keys: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "outbox-regress-"));
const row = async (k: string) => (await db.select().from(jobs).where(eq(jobs.key, k)))[0]!;
const hourAgo = new Date(Date.now() - 3_600_000);
const pending = (state: string) => (existsSync(outboxDir(state)) ? readdirSync(outboxDir(state)).filter((n) => n.endsWith(".json")).sort() : []);

async function insert(name: string, over: Partial<typeof jobs.$inferInsert>) {
  const k = key(name);
  keys.push(k);
  await db.insert(jobs).values(linearJob(`outbox-regress-${k}`, k, { machine_id: TEST_MACHINE_ID, stage: "queued", provider: "codex", t3_thread_id: `thread-${k}`, updated_at: hourAgo, ...over }));
  return k;
}

const stageEvent = (k: string, eventId: string, over: Record<string, unknown> = {}) =>
  ({ eventId, sessionId: `mcp:factory/${k}`, at: Date.now(), kind: "stage", stage: "implementing", summary: "Building it.", jobKey: k, branch: `factory/${k}`, ...over }) as FactoryEvent;

// A local stand-in for the deployed ingest function: same auth, same body schema, same projection.
const SECRET = "test-secret";
let ingestDown = false;
const received: string[][] = [];
const server = await serve(0, async (request) => {
  if (request.headers.get("authorization") !== `Bearer ${SECRET}`) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (ingestDown) return Response.json({ error: "down" }, { status: 503 });
  const parsed = ingestBodySchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: "invalid body" }, { status: 400 });
  received.push(parsed.data.map((e) => e.eventId));
  return Response.json(await ingest(db, parsed.data));
});
const configPath = join(dir, "config.json");
writeFileSync(configPath, JSON.stringify({ ingestUrl: `http://localhost:${server.port}/ingest`, secret: SECRET }));
const state = join(dir, "state");
const childEnv = (over: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, HOME: dir, MARSHAL_FACTORY_CONFIG: configPath, FACTORY_STATE_DIR: state, ...over };
  for (const name of ["CLAUDECODE", "FACTORY_REPORTER", "FACTORY_JOB_KEY", "FACTORY_ATTEMPT", "FACTORY_SESSION_ID"]) if (!(name in over)) delete env[name];
  return env as NodeJS.ProcessEnv & Record<string, string>;
};

async function mcp(env: Record<string, string>, cwd = dir) {
  const client = new Client({ name: "outbox-regress", version: "0" });
  await client.connect(new StdioClientTransport({ command: "bun", args: [join(import.meta.dirname, "../mcp/factory-report.ts")], env: childEnv(env), cwd, stderr: "ignore" }));
  return {
    report: async (args: Record<string, unknown>) => {
      const result = (await client.callTool({ name: "report_stage", arguments: args })) as { content: { text: string }[] };
      return result.content[0]!.text;
    },
    close: () => client.close(),
  };
}

const hook = join(import.meta.dirname, "../hooks/report.ts");
// Spawned without blocking, since the stand-in ingest answers from this process.
const runHook = (input: Record<string, unknown>) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("bun", [hook], { env: childEnv(), stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`the hook exited ${code}`))));
    child.stdin.end(JSON.stringify(input));
  });

function gitRepo(branch: string) {
  const repo = mkdtempSync(join(dir, "repo-"));
  execFileSync("git", ["init", "-q", "-b", branch, repo]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  return repo;
}

// The six-check shape agents reported before confidence replaced it; ingest still takes it.
const assessment = {
  recommendation: "handover",
  interpretation: "Added the flag.",
  assumptions: [],
  checks: Object.fromEntries(["interpretation", "proven", "contained", "reversible", "noTasteCalls", "noSurprises"].map((c) => [c, { ok: c !== "proven", note: "n" }])),
};

try {
  // Where the reporter reports: the config file, else the live checkout's .env.local, else nowhere.
  {
    const target = join(dir, "target");
    execFileSync("mkdir", ["-p", target]);
    const file = join(target, "config.json");
    const envFile = join(target, ".env.local");
    writeFileSync(envFile, "NEON_FUNCTION_INGEST_BASE_URL=https://env.test/\nFACTORY_INGEST_SECRET=from-env\nDATABASE_URL=postgres://never\n");
    assert.equal(readIngestTarget(file, undefined), undefined, "no config and no .env.local name nowhere");
    assert.deepEqual(readIngestTarget(file, envFile), { ingestUrl: "https://env.test/ingest", secret: "from-env" }, "no config falls back to .env.local");
    writeFileSync(file, JSON.stringify({ factory: { repos: [] } }));
    assert.deepEqual(readIngestTarget(file, envFile), { ingestUrl: "https://env.test/ingest", secret: "from-env" }, "a config with only settings falls back too");
    writeFileSync(file, JSON.stringify({ ingestUrl: "https://file.test/ingest", secret: "from-file" }));
    assert.deepEqual(readIngestTarget(file, envFile), { ingestUrl: "https://file.test/ingest", secret: "from-file" }, "the config file wins, as a sandbox's does");
    assert.equal(process.env.DATABASE_URL === "postgres://never", false, ".env.local is parsed, never loaded");
    assert.equal(readIngestTarget(join(target, "other.json")), undefined, "a config other than the default never falls back");
  }

  // The outbox on its own: ordering, failure, refusal and the cap.
  {
    const unit = join(dir, "unit");
    const sent: string[][] = [];
    let answer: "delivered" | "failed" = "failed";
    const send = async (batch: FactoryEvent[]) => {
      sent.push(batch.map((e) => e.eventId));
      // Every event of the batch is on disk before the POST.
      assert.equal(pending(unit).length >= batch.length, true, "appended before sent");
      if (batch.some((e) => e.eventId === "bad")) return { kind: "rejected" as const, reason: "ingest answered 400" };
      return answer === "delivered" ? { kind: "delivered" as const, spend: { "factory/X-1": 1 } } : { kind: "failed" as const, reason: "ingest answered 503" };
    };
    for (const id of ["e1", "e2", "e3"]) appendEvent(unit, stageEvent("X-1", id));
    const failed = await flushOutbox(localFs, unit, send, { budgetMs: 5_000 });
    assert.deepEqual([failed.delivered, failed.left, failed.error], [0, 3, "ingest answered 503"], "a failed POST keeps every event queued");
    assert.equal(pending(unit).length, 3);
    answer = "delivered";
    appendEvent(unit, stageEvent("X-1", "bad"));
    appendEvent(unit, stageEvent("X-1", "e5"));
    const flushed = await flushOutbox(localFs, unit, send, { budgetMs: 5_000 });
    assert.deepEqual(sent[1], ["e1", "e2", "e3", "bad", "e5"], "oldest first, in append order");
    assert.deepEqual([flushed.delivered, flushed.rejected, flushed.left], [4, ["bad"], 0], "a refused batch is retried one by one; only the refused event is set aside");
    assert.deepEqual(flushed.spend, { "factory/X-1": 1 });
    assert.equal(pending(unit).length, 0, "delivered events leave the outbox");
    assert.equal(readdirSync(rejectedDir(unit)).length, 1, "the refused one waits in outbox-rejected");
    const empty = await flushOutbox(localFs, unit, send, { budgetMs: 0 });
    assert.deepEqual([empty.delivered, empty.left], [0, 0]);

    // A refused event that cannot be set aside stays queued; the events after it still go.
    const jammed = join(dir, "jammed");
    for (const id of ["bad", "j2", "j3"]) appendEvent(jammed, stageEvent("X-1", id));
    const noRejectedDir = { ...localFs, writeFile: async (path: string, text: string) => (path.startsWith(rejectedDir(jammed)) ? Promise.reject(new Error("no such directory")) : localFs.writeFile(path, text)) };
    const sendJammed = async (batch: FactoryEvent[]) =>
      batch.some((e) => e.eventId === "bad") ? { kind: "rejected" as const, reason: "ingest answered 400" } : { kind: "delivered" as const, spend: {} };
    const past = await flushOutbox(noRejectedDir, jammed, sendJammed, { budgetMs: 5_000 });
    assert.deepEqual([past.delivered, past.rejected, past.stuck, past.left, past.error], [2, [], ["bad"], 1, undefined], "the flush goes on past an event it cannot set aside");
    assert.deepEqual(pending(jammed).map((n) => (JSON.parse(readFileSync(join(outboxDir(jammed), n), "utf8")) as FactoryEvent).eventId), ["bad"], "which stays queued for the next flush");

    const capped = join(dir, "capped");
    const warnings: string[] = [];
    for (let i = 1; i <= 5; i++) appendEvent(capped, stageEvent("X-1", `c${i}`), { highWater: 2, hardCap: 3, warn: (m) => void warnings.push(m) });
    assert.equal(pending(capped).length, 3, "the hard cap holds");
    const kept = pending(capped).map((n) => (JSON.parse(readFileSync(join(outboxDir(capped), n), "utf8")) as FactoryEvent).eventId);
    assert.deepEqual(kept, ["c3", "c4", "c5"], "the oldest go first");
    assert.ok(warnings.some((w) => /undelivered events/.test(w)), "past the high-water mark every append warns");
    assert.ok(warnings.some((w) => /dropped 1 undelivered/.test(w)), "and a drop is never silent");
    const droppedLog = readFileSync(join(capped, "outbox-dropped.log"), "utf8");
    assert.ok(/stage c1/.test(droppedLog) && /stage c2/.test(droppedLog), "each dropped event is logged by id and kind");
  }

  // Who the MCP server reports for.
  assert.equal(mcpPosts({ FACTORY_REPORTER: "mcp", CLAUDECODE: "1" }), true);
  assert.equal(mcpPosts({ FACTORY_REPORTER: "hook" }), false);
  assert.equal(mcpPosts({ CLAUDECODE: "1" }), false, "wiring without the variable stays quiet under Claude Code");
  assert.equal(mcpPosts({}), true);
  assert.deepEqual(mcpIdentity({ FACTORY_JOB_KEY: "FAC-5", FACTORY_ATTEMPT: "2" }, "/nowhere"), { jobKey: "FAC-5", branch: "factory/FAC-5-a2", sessionId: "mcp:factory/FAC-5-a2" });
  assert.deepEqual(mcpIdentity({}, "/x", () => "factory/FAC-6"), { jobKey: "FAC-6", branch: "factory/FAC-6", sessionId: "mcp:factory/FAC-6" }, "else the checked-out branch");
  assert.equal(mcpIdentity({}, "/x", () => "main"), undefined, "off a factory branch it reports nothing");
  assert.equal(mcpIdentity({ FACTORY_JOB_KEY: "FAC-5", FACTORY_ATTEMPT: "0" }, "/x"), undefined);

  // Codex: the MCP server posts every stage through the outbox, and the job moves.
  const CODEX = await insert("CODEX", {});
  const codexEnv = { FACTORY_REPORTER: "mcp", FACTORY_JOB_KEY: CODEX, FACTORY_ATTEMPT: "1", FACTORY_REPO: "factory-demo" };
  const session = `mcp:factory/${CODEX}`;
  const first = await mcp(codexEnv);
  ingestDown = true;
  assert.match(await first.report({ stage: "triage", summary: "Reading the issue." }), /queued and will be delivered later/);
  assert.equal(pending(state).length, 2, "the run's opening and the stage wait in the outbox");
  assert.equal((await row(CODEX)).stage, "queued", "nothing reached ingest");
  ingestDown = false;
  received.length = 0;
  assert.equal(await first.report({ stage: "implementing", summary: "Adding the flag." }), "Recorded stage implementing.");
  assert.equal(pending(state).length, 0, "the next call delivered the backlog and its own event");
  assert.equal(received.length, 1, "in one batch");
  assert.deepEqual(received[0]!.slice(0, 1), [`mcp-start:${session}`], "oldest first: the opening, then triage, then implementing");
  let job = await row(CODEX);
  assert.deepEqual([job.stage, job.stage_summary, job.session_id], ["implementing", "Adding the flag.", session], "the job moves and links the server's session");
  const stagesOf = async (k: string) => (await db.select().from(events).where(eq(events.job_key, k))).filter((e) => e.kind === "stage").map((e) => (e.payload as { stage: string }).stage);
  assert.deepEqual((await stagesOf(CODEX)).sort(), ["implementing", "triage"]);
  const [run] = await db.select().from(runs).where(eq(runs.session_id, session));
  assert.deepEqual([run!.job_key, run!.branch, run!.repo, run!.stage], [CODEX, `factory/${CODEX}`, "factory-demo", "implementing"], "a tracked run for the attempt");

  const prUrl = `https://github.com/ski043/factory-demo/pull/${stamp}`;
  const prReply = await first.report({ stage: "pr", summary: "PR is up.", prUrl, assessment });
  assert.match(prReply, /^Recorded stage pr\. Prove the pushed commit with `bun \/\S+\/hooks\/verify\.ts` \(factory-verify\)/, "pr and verifying name this checkout's factory-verify");
  job = await row(CODEX);
  assert.deepEqual([job.stage, job.pr_url, job.merge_assessment?.recommendation], ["pr", prUrl, "handover"], "the PR URL and the merge assessment land like Claude's");
  assert.deepEqual(job.merge_assessment?.confidence, { confident: false, reason: "Proven: n" }, "stored in the current shape");
  const runsOf = await db.select().from(runs).where(eq(runs.job_key, CODEX));
  assert.equal(harnessLine(boardCards([job], runsOf)[0]!.harness!), "Codex · cost unknown", "the card shows stages, and no cost before the runner reads its usage");
  await first.close();

  // A restarted server opens the same run once and goes on.
  const second = await mcp(codexEnv);
  assert.equal(await second.report({ stage: "waiting", summary: "Need a decision.", question: "Which API version?" }), "Recorded stage waiting.");
  await second.close();
  job = await row(CODEX);
  assert.deepEqual([job.stage, job.question], ["waiting", "Which API version?"]);
  const opened = await db.select().from(events).where(eq(events.event_id, `mcp-start:${session}`));
  assert.equal(opened.length, 1, "one opening across server restarts");

  // Redelivering an event ingest already has changes nothing.
  const before = (await db.select().from(events).where(eq(events.job_key, CODEX))).length;
  const [delivered] = await db.select().from(events).where(eq(events.job_key, CODEX));
  appendEvent(state, delivered!.payload as FactoryEvent);
  const again = await flushOutbox(localFs, state, async (batch) => ({ kind: "delivered", spend: (await ingest(db, batch)).spend }), { budgetMs: 5_000 });
  assert.equal(again.delivered, 1);
  assert.equal((await db.select().from(events).where(eq(events.job_key, CODEX))).length, before, "ingest stores each eventId once");
  assert.equal((await row(CODEX)).stage, "waiting");

  // Claude Code: its hooks report, the server only validates, so a stage lands once.
  const CLAUDE = await insert("CLAUDE", { provider: "claudeAgent" });
  const repo = gitRepo(`factory/${CLAUDE}`);
  for (const env of [{ CLAUDECODE: "1" }, { FACTORY_REPORTER: "hook" }] as Record<string, string>[]) {
    const quiet = await mcp(env, repo);
    assert.equal(await quiet.report({ stage: "triage", summary: "Reading." }), "Recorded stage triage.");
    await quiet.close();
  }
  assert.equal(pending(state).length, 0, "the server under Claude Code queues nothing");
  assert.deepEqual(await stagesOf(CLAUDE), [], "and posts nothing");
  const post = { hook_event_name: "PostToolUse", session_id: `claude-${CLAUDE}`, cwd: repo, tool_name: REPORT_STAGE_TOOL, tool_use_id: "tu-1", tool_input: { stage: "triage", summary: "Reading." } };
  await runHook(post);
  await runHook(post);
  assert.deepEqual(await stagesOf(CLAUDE), ["triage"], "the hook's report lands once, however often it fires");
  assert.deepEqual((await db.select().from(runs).where(eq(runs.job_key, CLAUDE))).map((r) => r.session_id), [`claude-${CLAUDE}`], "no second run from the MCP server");

  // The hook queues while ingest is down and the next hook call, even one with no event, delivers it.
  ingestDown = true;
  await runHook({ ...post, tool_use_id: "tu-2", tool_input: { stage: "implementing", summary: "Building." } });
  assert.equal(pending(state).length, 1, "a failed POST leaves the hook's event in the outbox");
  assert.equal((await row(CLAUDE)).stage, "triage");
  ingestDown = false;
  await runHook({ hook_event_name: "PreToolUse", session_id: `claude-${CLAUDE}`, cwd: repo, tool_name: "Bash", tool_input: {} });
  assert.equal(pending(state).length, 0);
  assert.equal((await row(CLAUDE)).stage, "implementing", "delivered by the next hook");

  // The runner flushes a sandbox's outbox through its host before hibernating or ending it, and on wake.
  const sandboxOutbox = `${SANDBOX_STATE_DIR}/outbox`;
  const slot = mkdtempSync(join(dir, "slot-"));
  writeFileSync(join(slot, "auth.json"), `{"slot":"x"}`, { mode: 0o600 });
  const logs: { event: string; detail: Record<string, unknown> }[] = [];
  Object.assign(sandboxRuntime, {
    claudeToken: () => undefined,
    githubToken: async () => "ghs_fake",
    slots: () => [slot],
    slotHealthPath: join(dir, "slot-health.json"),
    log: (event: string, detail: Record<string, unknown>) => void logs.push({ event, detail }),
  });
  fake.answer = (sandbox, argv) => {
    const [command, ...args] = argv;
    const path = args.at(-1)!;
    if (command === "t3" && args[0] === "thread" && args[1] === "show") return { stdout: JSON.stringify({ thread: { archived: false, worktreePath: null, activeRunId: null, branch: null } }) };
    if (command === "test" && path.startsWith(SANDBOX_STATE_DIR)) return { code: [...sandbox.files.keys()].some((f) => f === path || f.startsWith(`${path}/`)) ? 0 : 1 };
    if (command === "ls") return { stdout: [...sandbox.files.keys()].filter((f) => f.startsWith(`${path}/`)).map((f) => f.slice(path.length + 1)).filter((f) => !f.includes("/")).join("\n") };
    if (command === "rm") sandbox.files.delete(path);
    return {};
  };
  let sandboxIngestDown = false;
  outboxClient.send = async (batch) => (sandboxIngestDown ? { kind: "failed", reason: "ingest answered 503" } : { kind: "delivered", spend: (await ingest(db, batch)).spend });
  const sandboxFor = async (k: string) =>
    (await fakeModal.create({ name: `job-${k}-a1`, tags: { job: k, attempt: "1", label: config.factory.label, machine: TEST_MACHINE_ID }, imageId: "im-test", secrets: {}, env: {}, encryptedPorts: [], limits: config.factory.sandbox })) as FakeSandbox;
  const queue = (sandbox: FakeSandbox, event: FactoryEvent, n: number) => sandbox.files.set(`${sandboxOutbox}/${String(n).padStart(15, "0")}-1-000000.json`, JSON.stringify(event));
  const eventIds = async (ids: string[]) => (await db.select({ id: events.event_id }).from(events).where(inArray(events.event_id, ids))).map((e) => e.id);

  const UP = await insert("UP", {});
  const sbUp = await sandboxFor(UP);
  await db.update(jobs).set({ stage: "pr", stage_at: hourAgo, sandbox_id: sbUp.sandboxId, pr_url: `${prUrl}1` }).where(eq(jobs.key, UP));
  queue(sbUp, stageEvent(UP, `abc${stamp}up`, { stage: "pr", summary: "PR is up.", prUrl: `${prUrl}1`, at: Date.now() - 60_000 }), 1);

  const upDone = await hibernateIdle();
  assert.ok((Array.isArray(upDone) ? upDone : upDone.done).includes(`${UP}:hibernated`), JSON.stringify(upDone));
  assert.deepEqual(await eventIds([`abc${stamp}up`]), [`abc${stamp}up`], "delivered before the snapshot");
  const upOps = fake.ops.filter((o) => o.startsWith(`${sbUp.sandboxId}:`));
  assert.ok(upOps.findIndex((o) => o.includes(`rm -rf ${sandboxOutbox}/`)) < upOps.findIndex((o) => o.includes("snapshot")), upOps.join(" | "));
  const upImage = fake.images.get((await row(UP)).sandbox_snapshot!)!;
  assert.ok(![...upImage.keys()].some((f) => f.startsWith(sandboxOutbox)), "the snapshot holds no delivered event");

  const LATE = await insert("LATE", {});
  const sbLate = await sandboxFor(LATE);
  await db.update(jobs).set({ stage: "pr", stage_at: hourAgo, sandbox_id: sbLate.sandboxId, pr_url: `${prUrl}3` }).where(eq(jobs.key, LATE));
  queue(sbLate, stageEvent(LATE, `abc${stamp}late`, { stage: "pr", summary: "PR is up.", prUrl: `${prUrl}3`, at: Date.now() - 60_000 }), 1);
  sandboxIngestDown = true;
  const lateDone = await hibernateIdle();
  assert.ok((Array.isArray(lateDone) ? lateDone : lateDone.done).includes(`${LATE}:hibernated`), "an ingest outage never holds back hibernation");
  assert.deepEqual(await eventIds([`abc${stamp}late`]), [], "not delivered");
  const lateSnapshot = (await row(LATE)).sandbox_snapshot!;
  assert.ok([...fake.images.get(lateSnapshot)!.keys()].some((f) => f.startsWith(sandboxOutbox)), "the undelivered event sleeps in the snapshot");
  assert.ok(logs.some((l) => l.event === "outbox:flushed" && l.detail.key === LATE && l.detail.error === "ingest answered 503"), "and the failed flush is logged");

  sandboxIngestDown = false;
  const host = await wakeJob(await row(LATE));
  assert.ok(host, "woken");
  assert.deepEqual(await eventIds([`abc${stamp}late`]), [`abc${stamp}late`], "the wake delivers what the snapshot kept");
  const woken = sandboxes.get((await row(LATE)).sandbox_id!)!;
  assert.ok(![...woken.files.keys()].some((f) => f.startsWith(sandboxOutbox)), "and clears it");

  // Teardown: a finished job's last events leave before the sandbox ends.
  const END = await insert("END", {});
  const sbEnd = await sandboxFor(END);
  await db.update(jobs).set({ stage: "failed", sandbox_id: sbEnd.sandboxId }).where(eq(jobs.key, END));
  queue(sbEnd, { eventId: `abc${stamp}end`, sessionId: `mcp:factory/${END}`, at: Date.now(), kind: "session_end", reason: "other" }, 1);
  await teardownFinished();
  assert.ok(sbEnd.terminated);
  assert.deepEqual(await eventIds([`abc${stamp}end`]), [`abc${stamp}end`], "delivered before teardown");
  const endOps = fake.ops.filter((o) => o.startsWith(`${sbEnd.sandboxId}:`));
  assert.ok(endOps.findIndex((o) => o.includes(`rm -rf ${sandboxOutbox}/`)) < endOps.findIndex((o) => o.includes("terminated")), endOps.join(" | "));

  // A sandbox's refused event goes to outbox-rejected, a directory Modal's writeText does not create, and the rest are delivered.
  const REFUSED = await insert("REFUSED", {});
  const sbRefused = await sandboxFor(REFUSED);
  await db.update(jobs).set({ stage: "failed", sandbox_id: sbRefused.sandboxId }).where(eq(jobs.key, REFUSED));
  queue(sbRefused, stageEvent(REFUSED, `abc${stamp}refused`, { stage: "pr", summary: "PR is up.", prUrl: `${prUrl}5`, at: Date.now() - 60_000 }), 1);
  queue(sbRefused, { eventId: `abc${stamp}after`, sessionId: `mcp:factory/${REFUSED}`, at: Date.now(), kind: "session_end", reason: "other" }, 2);
  const realSend = outboxClient.send;
  outboxClient.send = async (batch) =>
    batch.some((e) => e.eventId === `abc${stamp}refused`) ? { kind: "rejected", reason: "ingest answered 400" } : { kind: "delivered", spend: (await ingest(db, batch)).spend };
  fake.parentsRequired = true;
  try {
    const refusedFlush = await flushSandboxOutbox(REFUSED, modalHost(sbRefused.sandboxId));
    assert.deepEqual([refusedFlush?.delivered, refusedFlush?.rejected, refusedFlush?.stuck], [1, [`abc${stamp}refused`], []], JSON.stringify(refusedFlush));
  } finally {
    fake.parentsRequired = false;
    outboxClient.send = realSend;
  }
  assert.deepEqual(await eventIds([`abc${stamp}after`]), [`abc${stamp}after`], "the event after the refused one is delivered");
  assert.ok([...sbRefused.files.keys()].some((f) => f.startsWith(`${SANDBOX_STATE_DIR}/outbox-rejected/`)), "and the refused one waits in the sandbox's outbox-rejected");

  console.log("outbox regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await server.close();
  await db.delete(events).where(or(inArray(events.job_key, keys), like(events.session_id, `mcp:factory/OB%-${stamp}`), like(events.session_id, `claude-OB%-${stamp}`)));
  await db.delete(runs).where(or(inArray(runs.job_key, keys), like(runs.session_id, `mcp:factory/OB%-${stamp}`)));
  await db.delete(jobs).where(like(jobs.id, `${jobId("linear", "outbox-regress-")}%`));
  process.exit(process.exitCode ?? 0);
}
