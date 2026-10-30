import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";

const { db } = await import("../db/client");
const { auditLog, jobs, repoSettings } = await import("../db/schema");
type RepoRow = typeof repoSettings.$inferSelect;
const { jobId, parseJob } = await import("../lib/sources");
const { createLinearAdapter, linearOverrides } = await import("../lib/sources/linear");
const { factorySchema } = await import("../lib/config");
const repos = await import("../lib/repositories");
const { repoFilter } = await import("../lib/repo-filter");
const { createJob } = await import("../lib/new-job");
const { announceFallbacks, overrideRuntime, planLaunch, syncOverrideLabels } = await import("../runner/overrides");
const ops = await import("../runner/ops");
type Adapter = NonNullable<NonNullable<Parameters<typeof ops.claim>[0]>["sources"]>[number];

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;
const owner = { email: OWNER, emailVerified: true };
const stamp = Date.now();
const OWNER_NS = `test-repos-${stamp}`;
const A = `${OWNER_NS}/factory-demo`;
const B = `${OWNER_NS}/shop`;
const OFF = `${OWNER_NS}/legacy`;

const row = (repo: string, over: Partial<RepoRow> = {}): RepoRow => ({
  repo,
  display_name: null,
  is_default: false,
  enabled: true,
  provider: null,
  execution: null,
  autonomy: "off",
  protected_paths: null,
  max_changed_lines: null,
  require_bugbot: true,
  onboarding_state: null,
  onboarding_detail: null,
  onboarding_started_at: null,
  onboarding_at: null,
  updated_at: new Date(),
  updated_by: "test",
  ...over,
});
const registry = [row(A, { is_default: true }), row(B, { display_name: "Shop app", provider: "codex", execution: "modal" }), row(OFF, { enabled: false })];
const L = (name: string, group: string | null = null) => ({ name, group });
const asked = (labels: ReturnType<typeof L>[]) =>
  linearOverrides({ state: "Todo", labels: labels.map((l) => l.name), labelGroups: labels.flatMap((l) => (l.group ? [{ name: l.name, group: l.group }] : [])) });

// Routing: the Repository label picks the repo, else the default; one that cannot apply goes to the default and says why.
const routes: { name: string; labels: ReturnType<typeof L>[]; want: ReturnType<typeof repos.routeRepo> }[] = [
  { name: "no label", labels: [L("factory")], want: { repo: A } },
  { name: "by display name", labels: [L("shop APP", "Repository")], want: { repo: B } },
  { name: "by the name part", labels: [L("shop", "repository")], want: { repo: B } },
  { name: "by the full name", labels: [L(B, "Repository")], want: { repo: B } },
  { name: "a label outside the group", labels: [L("Shop app")], want: { repo: A } },
  {
    name: "unknown",
    labels: [L("Website", "Repository")],
    want: { repo: A, problem: `The Repository label "Website" names no repository the factory knows, so it runs in the default repository ${A}.` },
  },
  {
    name: "disabled",
    labels: [L("legacy", "Repository")],
    want: { repo: A, problem: `The Repository label "legacy" names ${OFF}, which is disabled, so it runs in the default repository ${A}.` },
  },
  {
    name: "two labels",
    labels: [L("shop", "Repository"), L("factory-demo", "Repository")],
    want: { repo: A, problem: `The issue has more than one Repository label ("shop", "factory-demo"), so it runs in the default repository ${A}.` },
  },
];
for (const c of routes) assert.deepEqual(repos.routeRepo(asked(c.labels), registry), c.want, c.name);
assert.deepEqual(repos.routeRepo(asked([]), []), { repo: null }, "an empty registry routes nowhere; the claim falls back to the first checkout");
assert.deepEqual(repos.desiredRepositoryGroup(registry), { group: "Repository", children: ["factory-demo", "Shop app"] }, "one child per enabled repo, by display name");

// Precedence: ticket label > repo default > Settings, field by field.
const harness = (id: string, name: string, models: string[], enabled = true) => ({ id, driver: id, name, enabled, models: models.map((slug) => ({ slug, name: slug })) });
const harnesses = [harness("claudeAgent", "Claude Code", ["claude-opus-5-5"]), harness("codex", "Codex", ["gpt-6-astra"]), harness("cursor", "Cursor", ["composer-2"]), harness("off", "Off", ["x"], false)];
const settings = { harness: { provider: "claudeAgent", model: "claude-opus-5-5", from: "settings" as const }, execution: "local" as const };
const can = { local: true, checkout: true, modal: null as string | null, claude: true, codexSlot: true, driverOf: (p: string) => p, codexModel: "gpt-6-astra" };
const launch = (labels: ReturnType<typeof L>[], repo: RepoRow | undefined, over: Partial<typeof can> = {}) => {
  const { modal, ...rest } = { ...can, ...over };
  return planLaunch(asked(labels), repos.withRepoDefaults(settings, repo, harnesses).defaults, harnesses, { ...rest, cloud: { modal, upstash: "there is no Upstash Box API key" } });
};
const shop = registry[1]!;
const picked = (p: ReturnType<typeof launch>) => (p.kind === "launch" ? [p.harness.provider, p.execution] : [p.kind]);
assert.deepEqual(picked(launch([], undefined)), ["claudeAgent", "local"], "no repo default: Settings");
assert.deepEqual(picked(launch([], shop)), ["codex", "modal"], "the repo default beats Settings");
assert.deepEqual(picked(launch([L("Cursor", "Harness")], shop)), ["cursor", "modal"], "a Harness label beats the repo default");
assert.deepEqual(picked(launch([L("Local", "Runs on")], shop)), ["codex", "local"], "a Runs on label beats the repo default");
assert.deepEqual(picked(launch([], row(B, { execution: "local" }))), ["claudeAgent", "local"], "a repo default for one field leaves the other to Settings");
assert.equal(repos.withRepoDefaults(settings, row(B, { provider: "codex" }), harnesses).defaults.harness.model, "gpt-6-astra", "a repo default harness starts on its first model");
const skipped = repos.withRepoDefaults(settings, row(B, { provider: "off" }), harnesses);
assert.deepEqual([skipped.defaults.harness.provider, skipped.problems.length], ["claudeAgent", 1], "a disabled default harness falls back to Settings, with a problem to log");

// A local launch needs a checkout of the repo; without one the job runs on Modal if it can, else waits.
assert.deepEqual(picked(launch([], undefined, { checkout: false })), ["claudeAgent", "modal"], "no checkout: Modal, without a note");
const silent = launch([], undefined, { checkout: false });
assert.equal(silent.kind === "launch" && silent.ticket, null, "nothing on the ticket asked, so nothing is commented");
assert.equal(launch([], undefined, { checkout: false, modal: "no sandbox image is built" }).kind, "wait", "and waits queued when Modal cannot launch");
assert.deepEqual(
  launch([L("Local", "Runs on")], undefined, { checkout: false }),
  {
    kind: "launch",
    execution: "modal",
    harness: { provider: "claudeAgent", model: "claude-opus-5-5" },
    ticket: { notes: ["This runner has no checkout of the repo, so it runs in a cloud sandbox."] },
  },
  "a Local label without a checkout runs on Modal and says so",
);
assert.equal(launch([L("Cloud", "Runs on")], undefined, { checkout: false, modal: "no cloud sandbox token" }).kind, "wait", "Modal that cannot launch never falls back to a repo without a checkout");

// Filter: an explicit ?repo wins over the cookie; anything else shows every repo.
assert.equal(repoFilter(B, A), B, "the param wins");
assert.equal(repoFilter(undefined, A), A, "the cookie is remembered");
assert.equal(repoFilter("all", A), null, "all overrides a remembered repo");
assert.equal(repoFilter(undefined, "all"), null);
assert.equal(repoFilter("not a repo", A), A, "an invalid param falls back to the cookie");
assert.equal(repoFilter(["a/b", "c/d"], undefined), null, "a repeated param is ignored");
assert.equal(repoFilter(undefined, undefined), null);

// Owner-only saves with validation.
const saved: unknown[] = [];
const deps = (user: typeof owner | null = owner) => ({
  user: async () => user,
  registry: async () => registry,
  harnesses: async () => harnesses,
  save: async (choice: unknown) => void saved.push(choice),
});
const input = { repo: B, displayName: "Shop app", enabled: true, provider: "codex", execution: "modal", autonomy: "trial", requireBugbot: true };
for (const user of [null, { email: "x@example.com", emailVerified: true }, { email: OWNER, emailVerified: false }]) {
  assert.equal((await repos.saveRepository(deps(user), input)).ok, false, `${user?.email ?? "signed out"} cannot save`);
  assert.deepEqual(await repos.makeDefaultRepo({ ...deps(user), save: async () => void saved.push("default") }, { repo: B }), {
    ok: false,
    status: 403,
    message: "Only the factory owner can change repositories.",
  });
}
assert.equal(saved.length, 0, "and nothing is saved");
const refused = async (over: Record<string, unknown>) => {
  const outcome = await repos.saveRepository(deps(), { ...input, ...over });
  return outcome.ok ? "saved" : `${outcome.status} ${outcome.message}`;
};
assert.equal(await refused({ repo: "nope" }), "400 Name the repo as owner/name.");
assert.equal(await refused({ repo: `${OWNER_NS}/unknown` }), `400 ${OWNER_NS}/unknown is not a registered repository.`);
assert.equal(await refused({ repo: A, displayName: "factory-demo", enabled: false }), "400 The default repository can't be disabled. Make another one the default first.");
assert.equal(await refused({ displayName: "Factory-Demo" }), `400 ${A} is already named Factory-Demo.`, "display names stay unique, since labels match by them");
assert.equal(await refused({ displayName: "a, b" }), "400 The name can't contain commas or line breaks.");
assert.equal(await refused({ provider: "off" }), "400 No machine reports an enabled harness off.");
for (const bad of [{ execution: "cloud" }, { autonomy: "always" }, { enabled: "yes" }]) assert.match(await refused(bad), /^400 /, `${JSON.stringify(bad)} is refused`);
assert.equal(await refused({ requireBugbot: "no" }), "400 Say whether pull requests wait for Bugbot.", "Require Bugbot review is a yes or no");
assert.equal(await refused({ requireBugbot: undefined }), "400 Say whether pull requests wait for Bugbot.", "and must be sent");
assert.equal(saved.length, 0);
const kept = { ...deps(), registry: async () => registry.map((r) => (r.repo === B ? { ...r, provider: "gone" } : r)) };
assert.equal((await repos.saveRepository(kept, { ...input, provider: "gone", displayName: "Shop renamed" })).ok, true, "a stored harness no machine reports any more does not block other edits");
assert.equal((await repos.saveRepository(kept, { ...input, provider: "off" })).ok, false, "but changing to an unreported harness is still refused");
saved.length = 0;
assert.equal(await refused({}), "saved");
assert.equal(await refused({ provider: null, execution: null }), "saved", "null means Settings");
assert.equal(await refused({ protectedPaths: [" "], maxChangedLines: 0 }), "saved", "a form from before protected paths and the size limit went away still saves");
assert.ok(!("protectedPaths" in (saved.at(-1) as object)) && !("maxChangedLines" in (saved.at(-1) as object)), "without them");
assert.equal(await refused({ requireBugbot: false }), "saved");
assert.equal((saved.at(-1) as { requireBugbot: boolean }).requireBugbot, false, "a repo without Bugbot saves as such");
assert.equal((await repos.makeDefaultRepo({ ...deps(), save: async () => {} }, { repo: OFF })).ok, false, "a disabled repo cannot become the default");
assert.equal((await repos.makeDefaultRepo({ ...deps(), save: async () => {} }, { repo: B })).ok, true);

// New job: the issue always gets its Repository label, the default one when none is picked.
const filed: { labels?: { group: string; name: string }[] }[] = [];
const fileDeps = { user: async () => owner, file: async (d: (typeof filed)[number]) => (filed.push(d), { key: "FAC-1", url: "u" }), harnesses: async () => harnesses, registry: async () => registry };
const requestId = "6f0c3f8e-1f4b-4a52-9f0e-2d7c5a8b9c12";
await createJob(fileDeps, { title: "Title", description: "", requestId });
assert.deepEqual(filed[0]!.labels, [{ group: "Repository", name: "factory-demo" }], "the default repo is labeled too");
await createJob(fileDeps, { title: "Title", description: "", requestId, repo: B, execution: "local" });
assert.deepEqual(filed[1]!.labels, [{ group: "Repository", name: "Shop app" }, { group: "Runs on", name: "Local" }]);
assert.equal((await createJob(fileDeps, { title: "Title", description: "", requestId, repo: OFF })).ok, false, "a disabled repo is refused");
assert.equal((await createJob(fileDeps, { title: "Title", description: "", requestId, repo: `${OWNER_NS}/nope` })).ok, false, "an unknown repo is refused");

// Label sync: only adds, in the configured team, one Repository child per enabled repo.
type Label = { id: string; name: string; isGroup: boolean; team: { id: string } | null; parent: { id: string } | null };
const labels: Label[] = [
  { id: "g-repo", name: "Repository", isGroup: true, team: { id: "team-1" }, parent: null },
  { id: "c-old", name: "Old name", isGroup: false, team: { id: "team-1" }, parent: { id: "g-repo" } },
];
const creates: { teamId: string; name: string }[] = [];
const labelClient = {
  team: async (key: string) => {
    assert.equal(key, "FAC", "the sync reads only the configured team");
    return { id: "team-1", states: [] };
  },
  teamLabels: async () => labels.map((l) => ({ ...l })),
  createLabel: async (input: { id: string; name: string; teamId: string; isGroup?: boolean; parentId?: string }) => {
    creates.push(input);
    labels.push({ id: input.id, name: input.name, isGroup: Boolean(input.isGroup), team: { id: input.teamId }, parent: input.parentId ? { id: input.parentId } : null });
    return true;
  },
};
const syncer = createLinearAdapter(() => ({ client: labelClient as never, db, limits: factorySchema.parse({}) }));
const real = { harnesses: overrideRuntime.harnesses, registry: overrideRuntime.registry, note: overrideRuntime.note };
overrideRuntime.harnesses = async () => null;
overrideRuntime.registry = async () => registry;
try {
  assert.deepEqual(await syncOverrideLabels([syncer]), { synced: { linear: { team: "FAC", created: ["Repository / factory-demo", "Repository / Shop app"], problems: [] } } }, "before harnesses are reported, the Repository group still syncs");
  assert.deepEqual(await syncOverrideLabels([syncer]), { synced: { linear: { team: "FAC", created: [], problems: [] } } }, "a second sync creates nothing");
  assert.ok(labels.some((l) => l.name === "Old name"), "a child for a renamed repo stays; nothing is renamed or deleted");
  assert.ok(creates.every((c) => c.teamId === "team-1"));
  overrideRuntime.registry = async () => [];
  assert.deepEqual(await syncOverrideLabels([syncer]), { skipped: "no machine reports its harnesses yet" });
} finally {
  overrideRuntime.harnesses = real.harnesses;
  overrideRuntime.registry = real.registry;
}

// The database keeps one default, and it must be enabled; a move happens in one transaction.
const original = await db.select().from(repoSettings);
const originalDefault = original.find((r) => r.is_default)?.repo ?? null;
const code = (error: unknown) => (error as { code?: string; cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
try {
  await db.insert(repoSettings).values([A, B, OFF].map((repo) => ({ repo, updated_at: new Date(), updated_by: "test", enabled: repo !== OFF })));
  await repos.writeDefaultRepo(db, A, "test", new Date());
  const defaults = async () => (await db.select().from(repoSettings).where(eq(repoSettings.is_default, true))).map((r) => r.repo);
  assert.deepEqual(await defaults(), [A], "the default moved");
  await assert.rejects(db.update(repoSettings).set({ is_default: true }).where(eq(repoSettings.repo, B)), (e) => code(e) === "23505", "a second default is refused");
  await assert.rejects(db.update(repoSettings).set({ enabled: false }).where(eq(repoSettings.repo, A)), (e) => code(e) === "23514", "the default cannot be disabled");
  await assert.rejects(repos.writeDefaultRepo(db, OFF, "test", new Date()), /not an enabled repository/);
  assert.deepEqual(await defaults(), [A], "and a refused move leaves the default where it was");
  await repos.writeDefaultRepo(db, B, "test", new Date());
  assert.deepEqual(await defaults(), [B]);

  await repos.registerRepos(db, [`${OWNER_NS}/new`], "runner", new Date());
  assert.deepEqual(await defaults(), [B], "registering a checkout never moves an existing default");
  await db.update(repoSettings).set({ is_default: false }).where(eq(repoSettings.is_default, true));
  await repos.registerRepos(db, [`${OWNER_NS}/fresh`, `${OWNER_NS}/second`], "runner", new Date());
  assert.deepEqual(await defaults(), [`${OWNER_NS}/fresh`], "with no default, the first checkout becomes it");

  // Two checkouts with the same name part: the second registers under its full name, so a label names one repo.
  const dupA = `${OWNER_NS}/dup-${stamp}`;
  const dupB = `${OWNER_NS}-other/dup-${stamp}`;
  await repos.registerRepos(db, [dupA, dupB], "runner", new Date());
  const dupRows = await db.select().from(repoSettings).where(inArray(repoSettings.repo, [dupA, dupB]));
  assert.deepEqual(dupRows.map((r) => [r.repo, r.display_name]).sort(), [[dupA, null], [dupB, dupB]].sort(), "the second repo with a taken name is named by its full name");
  const dupRegistry = await repos.readRegistry(db);
  assert.equal(repos.routeRepo(asked([L(`dup-${stamp}`, "Repository")]), dupRegistry).repo, dupA);
  assert.equal(repos.routeRepo(asked([L(dupB, "Repository")]), dupRegistry).repo, dupB);
  const legacy2 = [row(dupA, { is_default: true }), row(`${OWNER_NS}/web`), row(`${OWNER_NS}-other/web`)];
  const ambiguous = repos.routeRepo(asked([L("web", "Repository")]), legacy2);
  assert.equal(ambiguous.repo, dupA, "a label two repos answer to goes to the default, never to the first match");
  assert.match(ambiguous.problem ?? "", /names more than one repository/);
  assert.deepEqual(repos.desiredRepositoryGroup(legacy2).children, [`dup-${stamp}`, `${OWNER_NS}/web`, `${OWNER_NS}-other/web`], "label sync names a shared display name's repos by full name");
  const dupFiled: { labels?: { group: string; name: string }[] }[] = [];
  await createJob({ ...fileDeps, file: async (d: (typeof dupFiled)[number]) => (dupFiled.push(d), { key: "FAC-2", url: "u" }), registry: async () => legacy2 }, { title: "Title", description: "", requestId, repo: `${OWNER_NS}-other/web` });
  assert.deepEqual(dupFiled[0]!.labels, [{ group: "Repository", name: `${OWNER_NS}-other/web` }], "New Job files the label that names only that repo");

  await repos.writeRepository(db, { repo: B, displayName: "shop", enabled: true, provider: null, execution: "modal", autonomy: "trial", requireBugbot: false }, OWNER, new Date());
  const [shopRow] = await db.select().from(repoSettings).where(eq(repoSettings.repo, B));
  assert.deepEqual([shopRow!.display_name, shopRow!.execution, shopRow!.autonomy, shopRow!.require_bugbot], [null, "modal", "trial", false], "a display name equal to the repo name stores as the default");

  // Claim: each job goes to its labeled repo, else the default; a retry routes again from the labels it has now.
  ops.config.factory.maxInFlight = 1000;
  const known = await repos.readRegistry(db);
  const draft = (id: string, groups: { name: string; group: string }[]) => ({
    externalId: `${OWNER_NS}-${id}`,
    key: `${OWNER_NS}-${id}-1`,
    title: id,
    url: "u",
    description: null,
    writeback: { kind: "linear" as const, issueId: `${OWNER_NS}-${id}` },
    sourceState: { state: "Todo", labels: ["factory", ...groups.map((g) => g.name)], labelGroups: groups },
  });
  let drafts = [draft("plain", []), draft("shop", [{ name: "Shop", group: "Repository" }]), draft("legacy", [{ name: "legacy", group: "Repository" }])];
  const source = { source: "linear", ready: async () => drafts, overrides: linearOverrides } as unknown as Adapter;
  await ops.claim({ sources: [source], repos: async () => [A], registry: async () => known });
  const repoOf = async (id: string) => (await db.select().from(jobs).where(eq(jobs.key, `${OWNER_NS}-${id}-1`)))[0]?.repo;
  assert.deepEqual(
    [await repoOf("plain"), await repoOf("shop"), await repoOf("legacy")],
    [`${OWNER_NS}/fresh`, B, `${OWNER_NS}/fresh`],
    "no label: the default; a label: its repo; a disabled repo's label: the default",
  );
  await db.update(jobs).set({ stage: "failed", stage_summary: "earlier failure" }).where(eq(jobs.key, `${OWNER_NS}-plain-1`));
  drafts = [draft("plain", [{ name: "shop", group: "Repository" }])];
  await ops.claim({ sources: [source], repos: async () => [A], registry: async () => known });
  assert.equal(await repoOf("plain"), B, "a retry routes from the labels the issue has now");
  await ops.claim({ sources: [{ ...source, ready: async () => [draft("empty", [])] }], repos: async () => [A], registry: async () => [] });
  assert.equal(await repoOf("empty"), A, "with an empty registry the job goes to this machine's first checkout");

  // A Repository label that cannot apply is told once per attempt, like any override fallback.
  const comments = new Map<string, string>();
  const noting = createLinearAdapter(() => ({
    client: { comment: async (_issue: string, id: string, body: string) => (comments.has(id) ? false : (comments.set(id, body), true)) } as never,
    db,
    limits: factorySchema.parse({}),
  }));
  overrideRuntime.note = (job, key, body) => noting.note(job as never, key, body);
  const jid = jobId("linear", `${OWNER_NS}-legacy`);
  const legacy = async () => parseJob((await db.select().from(jobs).where(eq(jobs.id, jid)))[0]!);
  const problem = repos.routeRepo(asked([L("legacy", "Repository")]), known).problem!;
  assert.match(problem, /which is disabled, so it runs in the default repository/);
  await announceFallbacks(await legacy(), { notes: [problem] });
  await announceFallbacks(await legacy(), { notes: [problem] });
  assert.equal(comments.size, 1, "one comment however often the launch runs");
  assert.match([...comments.values()][0]!, /names test-repos-\d+\/legacy, which is disabled/);
  assert.equal((await db.select().from(auditLog).where(eq(auditLog.job_id, jid))).length, 1, "and one audit row");

  console.log("repositories regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  overrideRuntime.note = real.note;
  const ours = like(jobs.key, `${OWNER_NS}-%`);
  const ids = (await db.select({ id: jobs.id }).from(jobs).where(ours)).map((j) => j.id);
  if (ids.length > 0) await db.delete(auditLog).where(inArray(auditLog.job_id, ids));
  await db.delete(jobs).where(ours);
  await db.delete(repoSettings).where(like(repoSettings.repo, `${OWNER_NS}%/%`));
  if (originalDefault) await repos.writeDefaultRepo(db, originalDefault, "test", new Date());
  process.exit(process.exitCode ?? 0);
}
