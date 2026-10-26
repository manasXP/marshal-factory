import "./test-guard";
import assert from "node:assert/strict";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Harness } from "../lib/harness";

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;

const { db } = await import("../db/client");
const { jobs, settings } = await import("../db/schema");
const { DEFAULT_MODEL, DEFAULT_PROVIDER } = await import("../lib/harness");
const { reportedHarnesses } = await import("../lib/machine");
const { readSettings, saveSettings, SETTINGS_ID, writeSettings } = await import("../lib/settings");
const { readHarnesses } = await import("../lib/t3-state");
const { claimLaunch, effectiveHarness, releaseLaunch } = await import("../runner/ops");
const { linearJob } = await import("./fixtures");

const fixtures = join(import.meta.dirname, "fixtures/harness");

assert.deepEqual(
  readHarnesses(join(fixtures, "full")),
  [
    { id: "cursor", driver: "cursor", name: "Cursor", enabled: false, models: [] },
    {
      id: "claudeAgent",
      driver: "claudeAgent",
      name: "Claude Code",
      enabled: true,
      models: [
        { slug: "model-a", name: "Model A" },
        { slug: "model-b", name: "Model B" },
      ],
    },
    {
      id: "codex",
      driver: "codex",
      name: "Codex",
      enabled: true,
      models: [
        { slug: "codex-one", name: "Codex One" },
        { slug: "codex-unnamed", name: "codex-unnamed" },
      ],
    },
    { id: "work-claude", driver: "claudeAgent", name: "Claude (work)", enabled: true, models: [{ slug: "model-a", name: "Model A" }, { slug: "model-b", name: "Model B" }] },
    { id: "antigravity", driver: "antigravity", name: "Gravity", enabled: true, models: [{ slug: "grav-1", name: "Gravity One" }] },
    { id: "mystery", driver: "mystery-cli", name: "mystery", enabled: true, models: [] },
  ],
  "each provider instance gets its driver's current models, named from the manifest, the slug when it has no name",
);
assert.deepEqual(
  readHarnesses(join(fixtures, "no-manifest")),
  [{ id: "codex", driver: "codex", name: "Codex", enabled: true, models: [] }],
  "without a manifest the harnesses still show, with no models",
);
assert.throws(() => readHarnesses(join(fixtures, "broken")), "a settings file of the wrong shape throws, so the inventory says unknown");
assert.throws(() => readHarnesses(join(fixtures, "missing")), "a missing settings file throws");

const harness = (id: string, enabled = true, models = ["m1"]): Harness => ({
  id,
  driver: id,
  name: id,
  enabled,
  models: models.map((slug) => ({ slug, name: slug })),
});
const now = Date.parse("2026-10-26T12:00:00Z");
const online = new Date(now - 60_000);
const offline = new Date(now - 3_600_000);
const inventory = (harnesses: Harness[] | "unknown" | undefined) => ({
  runnerSha: "unknown",
  t3: "unknown",
  connect: "unknown",
  projects: { source: "unknown" },
  repos: [],
  ...(harnesses !== undefined && { harnesses }),
});
assert.equal(reportedHarnesses([], now), null, "no machines, no harnesses");
assert.equal(
  reportedHarnesses([{ last_seen_at: online, inventory: inventory(undefined) }, { last_seen_at: online, inventory: inventory("unknown") }], now),
  null,
  "an inventory from before harnesses, or one that could not read them, reports none",
);
assert.deepEqual(
  reportedHarnesses(
    [
      { last_seen_at: offline, inventory: inventory([harness("codex", true, ["old"]), harness("cursor")]) },
      { last_seen_at: online, inventory: inventory([harness("codex", true, ["new"]), harness("claudeAgent", false)]) },
      { last_seen_at: online, inventory: inventory([harness("claudeAgent", true)]) },
    ],
    now,
  ),
  [harness("claudeAgent", true), harness("codex", true, ["new"]), harness("cursor")],
  "one harness per id, from an online machine first and an enabled entry over a disabled one",
);

const owner = { email: OWNER, emailVerified: true };
const reported = [harness("claudeAgent", true, ["model-a"]), harness("codex", true, ["codex-one"]), harness("cursor", false)];
const choices: { provider: string; model: string; by: string }[] = [];
const deps = (user: { email: string; emailVerified: boolean } | null, harnesses: Harness[] | null = reported) => ({
  user: async () => user,
  harnesses: async () => harnesses,
  save: async (choice: { provider: string; model: string }, by: string) => void choices.push({ ...choice, by }),
});

for (const user of [null, { email: "someone@example.com", emailVerified: true }, { email: OWNER, emailVerified: false }]) {
  const outcome = await saveSettings(deps(user), { provider: "codex", model: "codex-one" });
  assert.equal(!outcome.ok && outcome.status, 403, `a non-owner (${user?.email ?? "signed out"}) cannot change settings`);
}
for (const [input, why] of [
  [{ provider: " ", model: "codex-one" }, "an empty harness"],
  [{ provider: "codex", model: "" }, "an empty model"],
  [{ provider: "codex" }, "a missing model"],
  [{ provider: "nope", model: "codex-one" }, "a harness no machine reports"],
  [{ provider: "cursor", model: "m1" }, "a disabled harness"],
  [{ provider: "codex", model: "model-a" }, "another harness's model"],
] as const) {
  const outcome = await saveSettings(deps(owner), input);
  assert.equal(!outcome.ok && outcome.status, 400, `${why} is refused`);
}
assert.deepEqual(choices, [], "and nothing is saved");
assert.deepEqual(await saveSettings(deps(owner), { provider: " codex ", model: "codex-one" }), { ok: true }, "the owner saves a reported pair");
assert.deepEqual(await saveSettings(deps(owner, null), { provider: "anything", model: "goes" }), { ok: true }, "before any machine reports harnesses, any pair is taken");
assert.deepEqual(
  choices,
  [
    { provider: "codex", model: "codex-one", by: OWNER },
    { provider: "anything", model: "goes", by: OWNER },
  ],
  "trimmed, and recorded under the owner's email",
);
const failing = await saveSettings({ ...deps(owner), save: async () => Promise.reject(new Error("db down")) }, { provider: "codex", model: "codex-one" });
assert.equal(!failing.ok && failing.status, 502, "a failed write is reported");

const original = await readSettings(db);
const key = `SETTINGS-${Date.now()}`;
const externalId = `settings-regress-${Date.now()}`;
try {
  await db.delete(settings).where(eq(settings.id, SETTINGS_ID));
  assert.deepEqual(
    await effectiveHarness(),
    { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, from: "config" },
    "with nothing saved the runner uses its config",
  );

  const first = new Date("2026-10-26T10:00:00Z");
  await writeSettings(db, { provider: "codex", model: "codex-one" }, OWNER, first);
  await writeSettings(db, { provider: "antigravity", model: "grav-1" }, "second@example.com", new Date("2026-10-26T11:00:00Z"));
  const rows = await db.select().from(settings);
  assert.equal(rows.length, 1, "saving again updates the one row");
  assert.deepEqual(
    { ...rows[0]!, updated_at: rows[0]!.updated_at.toISOString() },
    { id: SETTINGS_ID, provider: "antigravity", model: "grav-1", updated_by: "second@example.com", updated_at: "2026-10-26T11:00:00.000Z" },
  );
  assert.deepEqual(await effectiveHarness(), { provider: "antigravity", model: "grav-1", from: "settings" }, "a saved choice wins over the config");

  await db.insert(jobs).values(linearJob(externalId, key));
  const slot = { id: "test-machine", repos: ["ski043/factory-demo"], maxInFlight: 1000 };
  assert.equal(await claimLaunch(key, "pending:1", slot, { provider: "antigravity", model: "grav-1" }), true);
  const [claimed] = await db.select().from(jobs).where(eq(jobs.key, key));
  assert.deepEqual([claimed!.provider, claimed!.model], ["antigravity", "grav-1"], "a launch records its harness with the pending marker");
  await releaseLaunch(key, "pending:1");
  const [released] = await db.select().from(jobs).where(eq(jobs.key, key));
  assert.deepEqual([released!.t3_thread_id, released!.provider, released!.model], [null, null, null], "a released launch clears it again");
} finally {
  await db.delete(jobs).where(eq(jobs.key, key));
  await db.delete(settings).where(eq(settings.id, SETTINGS_ID));
  if (original) await db.insert(settings).values(original);
}

console.log("settings regressions passed");
