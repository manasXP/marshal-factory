import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import type { Job } from "../lib/sources/types";

const { db } = await import("../db/client");
const { auditLog, jobs } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { jobId, parseJob } = await import("../lib/sources");
const { createLinearAdapter, linearFiler, linearOverrides } = await import("../lib/sources/linear");
const { factorySchema, TEST_MACHINE_ID } = await import("../lib/config");
const { desiredLabelGroups, ticketOverrides } = await import("../lib/ticket-overrides");
const { announceFallbacks, fallbackComment, overrideRuntime, planLaunch, splitByExecution, syncOverrideLabels } = await import("../runner/overrides");
const { claimLaunch, releaseLaunch } = await import("../runner/ops");
const { createJob } = await import("../lib/new-job");
const { boardCards, harnessLine, runsOn, whereLine } = await import("../components/panel/cards");

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;

const harness = (id: string, name: string, driver: string, models: string[], enabled = true) => ({
  id,
  driver,
  name,
  enabled,
  models: models.map((slug) => ({ slug, name: slug })),
});
const harnesses = [
  harness("claudeAgent", "Claude Code", "claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"]),
  harness("codex", "Codex", "codex", ["gpt-6-astra", "gpt-6"]),
  harness("cursor", "Cursor", "cursor", ["composer-2"]),
  harness("antigravity", "Antigravity", "antigravity", ["grav-1"], false),
  harness("codexNoModels", "Codex Lab", "codex", []),
];
const L = (name: string, group: string | null = null) => ({ name, group });
// The Linear adapter turns label groups into the normalized overrides the runner reads.
const asked = (labels: ReturnType<typeof L>[]) =>
  linearOverrides({ state: "Todo", labels: labels.map((l) => l.name), labelGroups: labels.flatMap((l) => (l.group ? [{ name: l.name, group: l.group }] : [])) });

// ticketOverrides: groups and children by name, case-insensitive; labels outside the groups are not overrides.
const table: { name: string; labels: ReturnType<typeof L>[]; want: ReturnType<typeof ticketOverrides> }[] = [
  { name: "no labels", labels: [], want: { problems: [] } },
  { name: "labels outside the groups", labels: [L("factory"), L("bug"), L("Codex"), L("Cloud")], want: { problems: [] } },
  { name: "a harness", labels: [L("factory"), L("Codex", "Harness")], want: { provider: "codex", problems: [] } },
  { name: "case does not matter", labels: [L("cLAUDE code", "harness"), L("cLOUD", "RUNS ON")], want: { provider: "claudeAgent", execution: "modal", problems: [] } },
  { name: "both groups", labels: [L("Cursor", "Harness"), L("Local", "Runs on")], want: { provider: "cursor", execution: "local", problems: [] } },
  { name: "a child of another group", labels: [L("Codex", "Team")], want: { problems: [] } },
  {
    name: "an unknown harness",
    labels: [L("Gemini", "Harness")],
    want: { problems: ['The Harness label "Gemini" matches no harness a runner reports, so it runs on the Settings harness.'] },
  },
  {
    name: "a disabled harness",
    labels: [L("Antigravity", "Harness")],
    want: { problems: ['The Harness label "Antigravity" names a harness that is disabled in T3, so it runs on the Settings harness.'] },
  },
  {
    name: "two children of one group",
    labels: [L("Codex", "Harness"), L("Cursor", "Harness"), L("Cloud", "Runs on")],
    want: { execution: "modal", problems: ['The issue has more than one Harness label ("Codex", "Cursor"), so it runs on the Settings harness.'] },
  },
  {
    name: "an unknown place",
    labels: [L("Sky", "Runs on")],
    want: { problems: ['The Runs on label "Sky" is neither Local nor Cloud nor Upstash, so it runs where Settings say.'] },
  },
];
for (const c of table) assert.deepEqual(ticketOverrides(asked(c.labels), harnesses), c.want, c.name);
assert.deepEqual(ticketOverrides(asked([L("Modal", "Runs on")]), harnesses), { execution: "modal", problems: [] }, "a ticket still labeled with the old Modal name runs in the cloud");
assert.deepEqual(ticketOverrides(asked([L("Codex", "Harness")]), null).problems.length, 1, "with no reported harnesses a Harness label cannot apply");

assert.deepEqual(
  linearOverrides({ state: null, labels: ["factory", "Codex", "Modal"] }),
  { harness: [], runsOn: [], repository: [] },
  "a row stored before groups were read has no groups, so it has no overrides",
);
assert.deepEqual(
  linearOverrides({ state: null, labels: ["factory", "Codex", "shop"], labelGroups: [{ name: "Codex", group: "harness" }, { name: "shop", group: "Repository" }, { name: "x", group: "Team" }] }),
  { harness: ["Codex"], runsOn: [], repository: ["shop"] },
  "each group's children by name, case-insensitive; other groups are not overrides",
);

assert.deepEqual(desiredLabelGroups([...harnesses, harness("codex2", "codex", "codex", [])]), [
  { group: "Harness", children: ["Claude Code", "Codex", "Cursor", "Codex Lab"] },
  { group: "Runs on", children: ["Local", "Cloud", "Upstash"] },
], "one child per enabled harness name, disabled ones left out");

// planLaunch: overrides field by field over Settings, the model, and each fallback.
const settings = { harness: { provider: "claudeAgent", model: "claude-sonnet-5-5", from: "settings" as const }, execution: "local" as const };
const can = { local: true, checkout: true, modal: null as string | null, claude: true, codexSlot: true, driverOf: (p: string) => harnesses.find((h) => h.id === p)?.driver ?? p, codexModel: "gpt-6-astra" };
// Upstash cannot launch here unless a case says so, so these cases read as they did with Modal alone.
const NO_UPSTASH = "there is no Upstash Box API key";
const plan = (
  labels: ReturnType<typeof L>[],
  over: Partial<typeof can> & { upstash?: string | null } = {},
  s: typeof settings | (Omit<typeof settings, "execution"> & { execution: "modal" | "upstash" }) = settings,
) => {
  const { modal, upstash, ...rest } = { ...can, upstash: NO_UPSTASH, ...over };
  return planLaunch(asked(labels), s, harnesses, { ...rest, cloud: { modal, upstash } });
};

assert.deepEqual(plan([L("factory")]), { kind: "launch", execution: "local", harness: { provider: "claudeAgent", model: "claude-sonnet-5-5" }, ticket: null }, "no overrides: Settings");
assert.deepEqual(
  plan([L("Codex", "Harness")]),
  { kind: "launch", execution: "local", harness: { provider: "codex", model: "gpt-6-astra" }, ticket: { provider: "codex", notes: [] } },
  "another harness runs on its first current model",
);
assert.deepEqual(
  plan([L("Claude Code", "Harness")]).kind === "launch" && plan([L("Claude Code", "Harness")]),
  { kind: "launch", execution: "local", harness: { provider: "claudeAgent", model: "claude-sonnet-5-5" }, ticket: { provider: "claudeAgent", notes: [] } },
  "the Settings harness keeps the Settings model",
);
assert.deepEqual(
  plan([L("Codex Lab", "Harness")]),
  {
    kind: "launch",
    execution: "local",
    harness: { provider: "claudeAgent", model: "claude-sonnet-5-5" },
    ticket: { notes: ["Codex Lab reports no current model, so it runs on the Settings harness Claude Code."] },
  },
  "a harness with no current model falls back to Settings",
);
assert.deepEqual(
  plan([L("Gemini", "Harness"), L("Cloud", "Runs on")]),
  {
    kind: "launch",
    execution: "modal",
    harness: { provider: "claudeAgent", model: "claude-sonnet-5-5" },
    ticket: { execution: "modal", notes: ['The Harness label "Gemini" matches no harness a runner reports, so it runs on the Settings harness.'] },
  },
  "an unknown harness falls back while the other field still applies",
);
assert.deepEqual(
  plan([L("Cloud", "Runs on")], { modal: "no sandbox image is built" }),
  {
    kind: "launch",
    execution: "local",
    harness: { provider: "claudeAgent", model: "claude-sonnet-5-5" },
    ticket: { notes: ["Cloud sandboxes cannot launch on this runner (no sandbox image is built), so it runs locally."] },
  },
  "Modal that cannot launch falls back to local when this runner's T3 is up",
);
assert.deepEqual(
  plan([L("Cloud", "Runs on")], { modal: "there is no cloud sandbox token", local: false }),
  { kind: "wait", reason: "Cloud sandboxes cannot launch on this runner (there is no cloud sandbox token) and this runner's T3 is not running" },
  "and waits queued when it is not",
);
assert.deepEqual(
  plan([L("Local", "Runs on")], { local: false }, { ...settings, execution: "modal" }),
  {
    kind: "launch",
    execution: "modal",
    harness: { provider: "claudeAgent", model: "claude-sonnet-5-5" },
    ticket: { notes: ["This runner's T3 is not running, so it runs in a cloud sandbox."] },
  },
  "Local without a T3 runs on Modal when Modal can launch",
);
assert.equal(plan([L("Local", "Runs on")], { local: false, modal: "there is no cloud sandbox token" }).kind, "wait", "and waits when it cannot");
assert.equal(plan([L("Local", "Runs on")], { local: false, codexSlot: false }).kind, "launch", "a Claude Code job needs no Codex login slot to run in the cloud");
assert.deepEqual(
  plan([L("Local", "Runs on"), L("Codex", "Harness")], { local: false, codexSlot: false }),
  { kind: "wait", reason: "this runner's T3 is not running and cloud sandboxes cannot launch here (no Codex login slot is usable)" },
  "a Codex job does",
);
assert.equal(plan([L("Local", "Runs on")], { local: false, codexSlot: false, claude: false }).kind, "wait", "and so does a Claude Code job that falls back to Codex without a Claude token");
assert.deepEqual(
  plan([L("Local", "Runs on")], {}, { ...settings, execution: "modal" }),
  { kind: "launch", execution: "local", harness: { provider: "claudeAgent", model: "claude-sonnet-5-5" }, ticket: { execution: "local", notes: [] } },
  "Local over Modal Settings",
);
assert.deepEqual(
  plan([L("Cursor", "Harness"), L("Cloud", "Runs on")]),
  {
    kind: "launch",
    execution: "modal",
    harness: { provider: "cursor", model: "composer-2" },
    ticket: {
      provider: "cursor",
      execution: "modal",
      notes: ["In a cloud sandbox, cursor / composer-2 cannot run in a sandbox (sandboxes have no cursor harness); launching on codex / gpt-6-astra."],
    },
  },
  "a harness the sandbox lacks is noted, since the sandbox maps it to Codex",
);
assert.equal(plan([L("factory")], { modal: "no image", local: false }, { ...settings, execution: "modal" }).kind, "launch", "Settings alone never fall back: the sandbox path waits as before");
assert.equal(plan([L("Cloud", "Runs on")], { modal: null }).kind, "launch", "busy slots are not a reason to fall back; the sandbox path keeps it queued");

// Upstash Box, the second cloud.
const where = (p: ReturnType<typeof plan>) => (p.kind === "launch" ? p.execution : p.kind);
assert.equal(where(plan([L("Upstash", "Runs on")], { upstash: null })), "upstash", "the Upstash label sends a job to Upstash Box");
assert.equal(where(plan([L("Upstash Box", "Runs on")], { upstash: null })), "upstash", "so does its long name");
const noUpstash = plan([L("Upstash", "Runs on")]);
assert.equal(where(noUpstash), "local", "Upstash that cannot launch falls back to this Mac, never to Modal");
assert.match(noUpstash.kind === "launch" ? noUpstash.ticket!.notes.join(" ") : "", /there is no Upstash Box API key/, "and says why");
assert.equal(where(plan([L("Upstash", "Runs on")], { local: false })), "wait", "nor anywhere else when this Mac cannot run it either");
assert.equal(
  where(plan([L("Local", "Runs on")], { local: false, upstash: null }, { ...settings, execution: "upstash" })),
  "upstash",
  "a job that cannot run locally goes to Settings' own cloud",
);
assert.equal(where(plan([L("Local", "Runs on")], { local: false, upstash: null }, { ...settings, execution: "modal" })), "modal", "Modal when Settings name it");
assert.equal(where(plan([L("factory")], { checkout: false, modal: "no sandbox image is built", upstash: null })), "upstash", "a repo with no checkout reaches whichever cloud can launch");
assert.equal(where(plan([L("factory")], {}, { ...settings, execution: "upstash" })), "upstash", "Settings alone send jobs to Upstash");

const split = splitByExecution([
  { key: "a", execution: "local" as const },
  { key: "b", execution: "modal" as const },
  { key: "c", execution: "local" as const },
]);
assert.deepEqual([split.local.map((e) => e.key), split.modal.map((e) => e.key)], [["a", "c"], ["b"]], "queued jobs split by their own execution");

// Card text: where the job runs, and the harness without the model.
const machine = (over: Partial<Parameters<typeof runsOn>[0]>) => ({ execution: null, machine_id: null, sandbox_id: null, sandbox_snapshot: null, ...over });
assert.equal(runsOn(machine({})), null, "not launched: nothing to say");
assert.equal(whereLine(runsOn(machine({ execution: "local", machine_id: "m1" }))!, "Mac mini"), "Local · Mac mini");
assert.equal(whereLine(runsOn(machine({ machine_id: "m1" }))!, null), "Local · m1", "a launch recorded before execution was kept, without a sandbox, ran locally");
assert.deepEqual(runsOn(machine({ execution: "modal", machine_id: "m1", sandbox_id: "sb" })), { kind: "modal", sandbox: "running" });
assert.deepEqual(runsOn(machine({ machine_id: "m1", sandbox_snapshot: "im" })), { kind: "modal", sandbox: "hibernated" });
assert.equal(whereLine({ kind: "modal", sandbox: null }, "Mac mini"), "Cloud sandbox");
const stamp = Date.now();
const cardJob = { ...linearJob(`card-${stamp}`, `CARD-${stamp}`), stage: "implementing" as const, provider: "codex", model: "gpt-6-astra", execution: "modal" as const, machine_id: "m1", sandbox_id: "sb" };
const [card] = boardCards([cardJob as never], [], harnesses);
assert.equal(harnessLine(card!.harness!), "Codex · not tracked", "an untracked harness says so, without its model");
const mcpRun = { session_id: `mcp:factory/${cardJob.key}`, job_key: cardJob.key, branch: `factory/${cardJob.key}`, stage: "implementing", stage_at: new Date(), last_event_at: new Date() };
const tokens = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
assert.equal(harnessLine(boardCards([cardJob as never], [{ ...mcpRun, ...tokens } as never], harnesses)[0]!.harness!), "Codex · cost unknown", "a Codex job whose report server posted shows stages, and no cost until usage is read");
const pricedRun = { ...mcpRun, ...tokens, model: "gpt-6.1-sol", input_tokens: 1_000, output_tokens: 200 };
const priced = boardCards([cardJob as never], [pricedRun as never], harnesses)[0]!.harness!;
assert.deepEqual([harnessLine(priced), priced.tracking], ["Codex", "full"], "with priced usage recorded it shows its cost like Claude");
assert.equal(harnessLine(boardCards([cardJob as never], [{ ...pricedRun, model: "gpt-9-nova" } as never], harnesses)[0]!.harness!), "Codex · cost unknown", "a model with no price leaves the cost unknown");
assert.equal(harnessLine(boardCards([{ ...cardJob, provider: "claudeAgent" } as never], [], harnesses)[0]!.harness!), "Claude Code");

// New job: the chosen harness and place go on the issue as the group labels.
const owner = { email: OWNER, emailVerified: true };
const requestId = "6f0c3f8e-1f4b-4a52-9f0e-2d7c5a8b9c11";
const filed: unknown[] = [];
const fileDeps = { user: async () => owner, file: async (d: unknown) => (filed.push(d), { key: "FAC-1", url: "u" }), harnesses: async () => harnesses, registry: async () => [] };
await createJob(fileDeps, { title: "Title", description: "", requestId });
assert.equal((filed[0] as { labels?: unknown }).labels, undefined, "Settings default files no override label");
await createJob(fileDeps, { title: "Title", description: "", requestId, provider: "codex", execution: "modal" });
assert.deepEqual((filed[1] as { labels: unknown }).labels, [{ group: "Harness", name: "Codex" }, { group: "Runs on", name: "Cloud" }]);
const disabled = await createJob(fileDeps, { title: "Title", description: "", requestId, provider: "antigravity" });
assert.equal(!disabled.ok && disabled.status, 400, "a disabled harness is refused");
assert.equal((await createJob(fileDeps, { title: "Title", description: "", requestId, execution: "cloud" })).ok, false);

// The filer and the label sync against a fake Linear: groups and children are created once, in the team, and reused.
type Label = { id: string; name: string; isGroup: boolean; team: { id: string } | null; parent: { id: string } | null };
const labels: Label[] = [{ id: "ws-bug", name: "Bug", isGroup: false, team: null, parent: null }];
const creates: Record<string, unknown>[] = [];
const issues: Record<string, unknown>[] = [];
const fetchFake = (async (_url: string, init: RequestInit) => {
  const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: { input: Record<string, unknown>; teamId?: string } };
  if (query.includes("teams(")) return Response.json({ data: { teams: { nodes: [{ id: "team-1", key: "FAC", states: { nodes: [{ id: "s-todo", name: "Todo", type: "unstarted" }] } }] } } });
  if (query.includes("issueLabelCreate")) {
    const input = variables.input as { id: string; name: string; teamId: string; isGroup?: boolean; parentId?: string };
    creates.push(input);
    if (labels.some((l) => l.id === input.id)) return Response.json({ errors: [{ message: "conflict on insert of label" }] });
    labels.push({ id: input.id, name: input.name, isGroup: Boolean(input.isGroup), team: { id: input.teamId }, parent: input.parentId ? { id: input.parentId } : null });
    return Response.json({ data: { issueLabelCreate: { success: true } } });
  }
  if (query.includes("isGroup")) return Response.json({ data: { issueLabels: { nodes: labels } } });
  if (query.includes("issueLabels(")) return Response.json({ data: { issueLabels: { nodes: [{ id: "label-factory", team: { id: "team-1" } }] } } });
  if (query.includes("issueCreate")) {
    issues.push(variables.input);
    return Response.json({ data: { issueCreate: { issue: { identifier: "FAC-2", url: "u" } } } });
  }
  throw new Error(`unexpected query ${query.slice(0, 60)}`);
}) as unknown as typeof fetch;
const file = linearFiler("key", "FAC", "factory", { fetch: fetchFake, sleep: async () => {} });
await file({ requestId, title: "t", description: "d", labels: [{ group: "Harness", name: "Codex" }, { group: "Runs on", name: "Cloud" }] });
const idOf = (name: string) => labels.find((l) => l.name === name)!.id;
assert.deepEqual(issues[0]!.labelIds, ["label-factory", idOf("Codex"), idOf("Cloud")], "the issue carries the factory label and both overrides");
assert.equal(labels.find((l) => l.name === "Codex")!.parent!.id, idOf("Harness"), "Codex sits in the Harness group");
assert.ok(labels.find((l) => l.name === "Harness")!.isGroup);
const made = creates.length;
await file({ requestId, title: "t", description: "d", labels: [{ group: "harness", name: "codex" }] });
assert.equal(creates.length, made, "a second job finds the labels instead of creating them");
assert.deepEqual(issues[1]!.labelIds, ["label-factory", idOf("Codex")]);

labels.push({ id: "ws-local", name: "Local", isGroup: false, team: { id: "team-1" }, parent: null });
const labelClient = {
  team: async () => ({ id: "team-1", states: [] }),
  teamLabels: async () => labels.map((l) => ({ ...l })),
  createLabel: async (input: { id: string; name: string; teamId: string; isGroup?: boolean; parentId?: string }) => {
    creates.push(input);
    if (labels.some((l) => l.id === input.id)) return false;
    labels.push({ id: input.id, name: input.name, isGroup: Boolean(input.isGroup), team: { id: input.teamId }, parent: input.parentId ? { id: input.parentId } : null });
    return true;
  },
};
const syncer = createLinearAdapter(() => ({ client: labelClient as never, db, limits: factorySchema.parse({}) }));
const realHarnesses = overrideRuntime.harnesses;
const realRegistry = overrideRuntime.registry;
overrideRuntime.harnesses = async () => harnesses;
overrideRuntime.registry = async () => [];
const result = await syncOverrideLabels([syncer]);
const synced = result.synced?.linear;
assert.deepEqual(synced, {
  team: "FAC",
  created: ["Harness / Claude Code", "Harness / Cursor", "Harness / Codex Lab", "Runs on / Upstash"],
  problems: ['A label named "Local" exists outside the Runs on group; move it into the group in Linear.'],
}, "the sync adds what is missing, reports a name taken elsewhere, and never renames or moves it");
assert.deepEqual(await syncOverrideLabels([syncer]), { synced: { linear: { team: "FAC", created: [], problems: synced!.problems } } }, "a second sync creates nothing");
assert.ok(creates.every((c) => c.teamId === "team-1"), "every label is created in the configured team");
overrideRuntime.harnesses = async () => null;
assert.deepEqual(await syncOverrideLabels([syncer]), { skipped: "no machine reports its harnesses yet" });
overrideRuntime.harnesses = realHarnesses;
overrideRuntime.registry = realRegistry;

// The adapter stores each label's group; an old row has none.
const adapter = createLinearAdapter(() => ({
  client: {
    readyIssues: async () => [
      {
        id: "i1",
        identifier: "FAC-3",
        title: "t",
        url: "u",
        description: null,
        createdAt: "2026-10-26T00:00:00Z",
        state: { name: "Todo", type: "unstarted" },
        labels: { nodes: [{ name: "factory", parent: null }, { name: "Codex", parent: { name: "Harness" } }] },
      },
    ],
  } as never,
  db,
  limits: factorySchema.parse({}),
}));
assert.deepEqual((await adapter.ready())[0]!.sourceState, { state: "Todo", labels: ["factory", "Codex"], labelGroups: [{ name: "Codex", group: "Harness" }] });

// A fallback is announced once per attempt: one comment and one audit row, however often the launch runs.
const id = `override-regress-${stamp}`;
const jid = jobId("linear", id);
const comments = new Map<string, string>();
const noting = createLinearAdapter(() => ({
  client: { comment: async (_issue: string, commentId: string, body: string) => (comments.has(commentId) ? false : (comments.set(commentId, body), true)) } as never,
  db,
  limits: factorySchema.parse({}),
}));
const realNote = overrideRuntime.note;
overrideRuntime.note = (job, key, body) => noting.note(job as never, key, body);
await db.insert(jobs).values(linearJob(id, `OVR-${stamp}`, { url: "https://linear.app/x/issue/OVR" }));
try {
  const row = async () => parseJob((await db.select().from(jobs).where(eq(jobs.id, jid)))[0]!);
  const ticket = { notes: ["Cloud sandboxes cannot launch on this runner (no sandbox image is built), so it runs locally."] };
  await announceFallbacks(await row(), ticket);
  await announceFallbacks(await row(), ticket);
  await announceFallbacks(await row(), { notes: ["something else"] });
  assert.equal(comments.size, 1, "one comment however often the launch runs");
  assert.equal([...comments.values()][0], fallbackComment(ticket.notes));
  assert.equal(((await row()) as Job<"linear">).source_state.factoryCommentIds.length, 1, "recorded as the factory's own, so it is never read as a reply");
  const audits = await db.select().from(auditLog).where(eq(auditLog.job_id, jid));
  assert.deepEqual(audits.map((a) => [a.action, a.detail, a.target]), [["override_fallback", ticket.notes[0], "https://linear.app/x/issue/OVR"]], "and one audit row");
  await announceFallbacks(await row(), { provider: "codex", notes: [] });
  assert.equal(comments.size, 1, "nothing to say without a fallback");
  await db.update(jobs).set({ attempt: 2 }).where(eq(jobs.id, jid));
  await announceFallbacks(await row(), ticket);
  assert.equal(comments.size, 2, "a retry is a new attempt and may say it again");

  // The launch records where it runs and the ticket's overrides; a release clears them.
  const slot = { id: TEST_MACHINE_ID, repos: ["ski043/factory-demo"], maxInFlight: 1000 };
  assert.equal(await claimLaunch(`OVR-${stamp}`, "pending:1", slot, { provider: "codex", model: "gpt-6-astra" }, { execution: "local", ticket }), true);
  const claimed = await row();
  assert.deepEqual([claimed.provider, claimed.model, claimed.execution, claimed.ticket_overrides], ["codex", "gpt-6-astra", "local", ticket]);
  await releaseLaunch(`OVR-${stamp}`, "pending:1");
  const released = await row();
  assert.deepEqual([released.provider, released.execution, released.ticket_overrides], [null, null, null]);

  console.log("overrides regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  overrideRuntime.note = realNote;
  await db.delete(auditLog).where(inArray(auditLog.job_id, [jid]));
  await db.delete(jobs).where(eq(jobs.id, jid));
  process.exit(process.exitCode ?? 0);
}
