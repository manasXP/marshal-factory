import "./test-guard";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { z } from "zod";

const { db } = await import("../db/client");
const { jobs, runs } = await import("../db/schema");
const { allSources, isJobSource, parseJob, registerSource, SOURCES, sourceFor } = await import("../lib/sources");
const { jobId, parseJobId, sourceLink } = await import("../lib/sources/shapes");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { eventSchema } = await import("../lib/events");
const { ingest } = await import("../lib/ingest");
const { attemptBranch, jobKey, parseBranch } = await import("../lib/factory");
const { github } = await import("../lib/github/pulls");
const { NO_OVERRIDES } = await import("../lib/ticket-overrides");
const ops = await import("../runner/ops");
const { launchEntries } = await import("../runner/launch");
const { announceFallbacks, planLaunch } = await import("../runner/overrides");

// A second source that exists only here. It goes through claim, launch, stage reports on its
// branch, a pull request, the merge and every write-back without a line of runner code knowing
// it, and the Linear adapter is never reached: the runner has no Linear assumptions left.

const SOURCE = "test-source";
const REPO = "ski043/factory-demo";
const stamp = Date.now() % 1_000_000;
const externalId = `item-${stamp}`;
const key = jobKey("TS", stamp, "Fake Board");
const branch = attemptBranch(key, 1);

const calls: unknown[][] = [];
const call = (name: string, ...args: unknown[]) => void calls.push([name, ...args]);
type Fake = { key: string; external_id: string; stage: string; writeback: unknown; source_state: unknown };
const draft = {
  externalId,
  key,
  title: "Fake item",
  url: `https://fake.example/items/${stamp}`,
  description: "Fix the fake thing.",
  writeback: { kind: SOURCE, ref: externalId },
  sourceState: { status: "open", asks: { runsOn: ["Modal"] } },
};
let ready = [draft];
registerSource(
  {
    label: "Fake board",
    writeback: z.object({ kind: z.literal(SOURCE), ref: z.string() }),
    sourceState: z.object({ status: z.string(), asks: z.object({ runsOn: z.array(z.string()).default([]) }) }),
  },
  {
    source: SOURCE,
    ready: async () => (call("ready"), ready as never),
    announceClaim: async (job) => call("announce", (job as Fake).key, (job as Fake).writeback),
    writeBack: async (job, t) => (call("writeBack", (job as Fake).key, t.stage), t.stage !== "triage"),
    replies: async () => ({ kind: "wait" }),
    acknowledgeReplies: async () => undefined,
    stopWanted: async (open) => (call("stopWanted", open.map((j) => j.key)), []),
    confirmStop: async (id, detail) => (call("confirmStop", id, detail), { stop: false }),
    note: async (job, noteKey, body) => call("note", job.key, noteKey, body),
    overrides: (state) => ({ ...NO_OVERRIDES, runsOn: (state as unknown as typeof draft.sourceState).asks.runsOn }),
    labels: async () => [],
    reopen: async (job) => call("reopen", job.key),
    requeue: async (job) => call("requeue", job.key),
    describe: (job) => `fake item ${job.key}`,
  },
);

// Every Linear call but an empty ready list fails the script.
const linearReached: string[] = [];
// The test branch copies production, whose enabled repos the GitHub source would list for real.
SOURCES.github = { ...SOURCES.github, ready: async () => [] };
SOURCES.linear = new Proxy({ source: "linear", ready: async () => [] } as unknown as typeof SOURCES.linear, {
  get: (target, prop) =>
    prop in target
      ? Reflect.get(target, prop)
      : () => {
          linearReached.push(String(prop));
          throw new Error(`the Linear adapter's ${String(prop)} was reached`);
        },
});

ops.ingestClient.post = async (event) => ingest(db, [eventSchema.parse(event)]);
const realPullRequest = github.pullRequest;
const id = jobId(SOURCE as never, externalId);
const row = async () => parseJob((await db.select().from(jobs).where(eq(jobs.id, id)))[0]!);
const at = Date.now();
const sessionId = `fake-source-${stamp}`;
const report = (n: number, stage: string, extra: Record<string, unknown> = {}) =>
  eventSchema.parse({ eventId: `${sessionId}-${n}`, sessionId, at: at + n, kind: "stage", stage, summary: `${stage} it`, jobKey: parseBranch(branch)?.key, branch, ...extra });

try {
  assert.ok(isJobSource(SOURCE) && allSources().some((s) => s.source === SOURCE), "the fake source is registered beside Linear");
  assert.deepEqual(parseJobId(id), { id, source: SOURCE, externalId });
  assert.deepEqual(parseBranch(branch), { key, attempt: 1 }, "its key is a job key and its branch parses back");

  const claimed = await ops.claim({ repos: async () => [REPO], registry: async () => [] });
  assert.ok(claimed.claimed.includes(key), "the claim takes the fake source's ready item");
  let job = await row();
  assert.deepEqual(
    [job.source, job.external_id, job.key, job.repo, job.source_state, sourceLink(job)],
    [SOURCE, externalId, key, REPO, draft.sourceState, { label: "Fake board", href: draft.url }],
  );
  ready = [];

  // Launch: the entry is the job's branch and its message names the job as the source describes it.
  const entry = (await ops.toLaunch()).find((e) => e.key === key)!;
  assert.equal(entry.branch, branch);
  assert.match(entry.message, new RegExp(`^Work fake item ${key}: Fake item\n${draft.url.replaceAll(".", "\\.")}`));
  const settings = { harness: { provider: "claudeAgent", model: "m", from: "settings" as const }, execution: "local" as const };
  const can = { local: true, checkout: true, cloud: { modal: null, upstash: "no key" }, claude: true, codexSlot: true, driverOf: (p: string) => p, codexModel: "c" };
  const plan = planLaunch(sourceFor(job.source).overrides(job.source_state), settings, null, can);
  assert.equal(plan.kind === "launch" && plan.execution, "modal", "the source's normalized Runs on override applies");
  const started: string[] = [];
  const launched = await launchEntries([{ ...entry, harness: settings.harness, ticket: null }], {
    claim: (k, marker) => ops.claimLaunch(k, marker, { id: TEST_MACHINE_ID, repos: [REPO], maxInFlight: 100 }),
    start: async (e) => (started.push(e.branch), `thread-${stamp}`),
    bind: ops.bindThread,
    release: ops.releaseLaunch,
    now: Date.now,
  });
  assert.deepEqual([launched, started], [[{ key, threadId: `thread-${stamp}`, branch, startMs: launched[0]!.startMs }], [branch]]);
  await ops.announceClaims();
  await announceFallbacks(await row(), { notes: ["Runs on fell back."] });

  // The thread reports on its branch; the hook derives the job from the branch alone.
  await ingest(db, [eventSchema.parse({ eventId: `${sessionId}-0`, sessionId, at, kind: "session_start", cwd: "/w", branch, repo: "factory-demo", t3ThreadId: `thread-${stamp}` })]);
  await ingest(db, [report(1, "triage")]);
  assert.deepEqual((await ops.writeBack({ only: [key] })).synced, [], "a stage the source has nothing to say about is synced without a write");
  await ingest(db, [report(2, "implementing"), report(3, "pr", { prUrl: `https://github.com/${REPO}/pull/${stamp}` })]);
  job = await row();
  assert.deepEqual([job.stage, job.session_id, job.pr_url], ["pr", sessionId, `https://github.com/${REPO}/pull/${stamp}`]);
  assert.equal((await db.select().from(runs).where(eq(runs.session_id, sessionId)))[0]!.job_key, key, "the run is linked by its branch");
  assert.deepEqual((await ops.writeBack({ only: [key] })).synced, [`${key}:pr`]);

  assert.deepEqual(await ops.reconcileStops({ only: [id] }), [], "the stop check asks the job's own source");

  github.pullRequest = async (url) => {
    assert.equal(url, job.pr_url);
    return { state: "merged", mergeable: "clean", headSha: "abc" } as unknown as Awaited<ReturnType<typeof realPullRequest>>;
  };
  await ops.checkPullRequests({ only: [key] });
  assert.equal((await row()).stage, "merged", "the merged PR moves the job");
  assert.deepEqual((await ops.writeBack({ only: [key] })).synced, [`${key}:merged`]);

  assert.deepEqual(calls, [
    ["ready"],
    ["announce", key, draft.writeback],
    ["note", key, "ticket-overrides:1", "marshal-factory could not apply this issue's override labels as they are:\n\n- Runs on fell back."],
    ["writeBack", key, "triage"],
    ["writeBack", key, "pr"],
    ["stopWanted", [key]],
    ["writeBack", key, "merged"],
  ]);
  assert.deepEqual(linearReached, [], "nothing reached the Linear adapter");
  console.log("fake source regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  github.pullRequest = realPullRequest;
  await db.delete(runs).where(eq(runs.session_id, sessionId));
  await db.delete(jobs).where(eq(jobs.id, id));
  process.exit(process.exitCode ?? 0);
}
