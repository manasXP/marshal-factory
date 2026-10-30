import "./test-guard";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { ExecError } from "../lib/exec";
import { fake, fakeModal, FakeSandbox, sandboxes, type Reply } from "./fake-modal";

const { db } = await import("../db/client");
const { jobs, settings } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { HostGoneError, hosts, localHost } = await import("../lib/host");
const { modal, modalHost, realModal, sandboxName } = await import("../lib/modal-host");
const { enabledPstack, imageProblem, parseVersion, browserServer, pinnedVersions, PSTACK_PLUGIN, REPO_DIR } = await import("../lib/sandbox");
const { config, launchSettings, threads } = await import("../runner/ops");
const { launchInSandboxes, maybeStarted, recoverPending } = await import("../runner/launch");
const { sandboxRuntime } = await import("../runner/sandbox");
const { readSettings, SETTINGS_ID, writeSettings } = await import("../lib/settings");

modal.api = fakeModal;

const spec = { name: "x", tags: {}, imageId: "im", secrets: {}, env: {}, encryptedPorts: [], limits: config.factory.sandbox };
await assert.rejects(realModal.create(spec), /Modal was called during a regression run/, "the real Modal client refuses to run in a regression");
await assert.rejects(realModal.fromId("sb-real"), /Modal was called during a regression run/);

// ModalHost: run, files and error shapes.
const box = new FakeSandbox("sb-host");
sandboxes.set(box.sandboxId, box);
const host = modalHost(box.sandboxId);
fake.answer = (_sandbox, argv) => {
  const [command, ...args] = argv;
  if (command === "echo") return { stdout: args.join(" "), stderr: "warn" };
  if (command === "fail") return { code: 3, stdout: "partial", stderr: "boom" };
  if (command === "hang") return { hang: true };
  if (command === "test") return { code: args[1] === "/there" ? 0 : args[1] === "/broken" ? 2 : 1 };
  if (command === "stat") return { stdout: "1700000000\n" };
  if (command === "ls") return { stdout: "a\n.b\n" };
  return {};
};
assert.equal(host.t3, "t3");
assert.deepEqual(await host.run("echo", ["hi"], { input: "in", cwd: "/w", timeoutMs: 1_000 }), { stdout: "hi", stderr: "warn" });
assert.deepEqual(box.execs.at(-1), { argv: ["echo", "hi"], params: { workdir: "/w", timeoutMs: 1_000 }, input: "in", closed: true }, "argv, workdir, timeout, and stdin written then closed");
await host.run("echo", []);
assert.deepEqual([box.execs.at(-1)!.params, box.execs.at(-1)!.closed], [{}, true], "stdin is closed even without input");
const failed = (await host.run("fail", ["x"]).catch((error: unknown) => error)) as ExecError;
assert.deepEqual([failed.code, failed.stdout, failed.stderr, failed.killed], [3, "partial", "boom", false], "a non-zero exit rejects like execFile");
assert.equal(maybeStarted(failed), false, "and is a clear failure");
const hung = (await host.run("hang", [], { timeoutMs: 50 }).catch((error: unknown) => error)) as ExecError;
assert.equal(hung.killed, true, "a timeout is marked killed");
assert.equal(maybeStarted(hung), true, "and counts as maybe started");
assert.equal(await host.exists("/there"), true);
assert.equal(await host.exists("/missing"), false);
await assert.rejects(host.exists("/broken"), "an exists that cannot tell throws");
assert.equal(await host.mtimeMs("/f"), 1_700_000_000_000);
assert.deepEqual(await host.list("/d"), ["a", ".b"]);
assert.equal(await host.readFile("/nope"), null, "a missing file reads as null");
await host.writeFile("/root/x.txt", "text");
assert.equal(await host.readFile("/root/x.txt"), "text");
await host.remove("/tmp/x");
assert.deepEqual(box.execs.at(-1)!.argv, ["rm", "-rf", "/tmp/x"]);

const goneHost = modalHost("sb-never-existed");
await assert.rejects(goneHost.run("echo", []), HostGoneError, "a sandbox Modal does not know is gone");
await assert.rejects(goneHost.readFile("/x"), HostGoneError);
assert.equal(await threads.state("thread-1", goneHost), "gone", "its threads are gone");
const finished = new FakeSandbox("sb-finished");
finished.terminated = true;
sandboxes.set(finished.sandboxId, finished);
await assert.rejects(modalHost(finished.sandboxId).run("echo", []), HostGoneError, "so is one that already finished");
const shutDown = new FakeSandbox("sb-shut-down");
shutDown.exec = async () => {
  throw Object.assign(new Error("TaskExecStart NOT_FOUND: Modal Sandbox with container ID ta-1 not found."), { name: "ClientError", code: 5 });
};
sandboxes.set(shutDown.sandboxId, shutDown);
await assert.rejects(modalHost(shutDown.sandboxId).run("echo", []), HostGoneError, "and one whose exec gets gRPC's NOT_FOUND");
const flaky = new FakeSandbox("sb-flaky");
flaky.exec = async () => {
  throw Object.assign(new Error("UNAVAILABLE"), { name: "ClientError", code: 14 });
};
sandboxes.set(flaky.sandboxId, flaky);
await assert.rejects(modalHost(flaky.sandboxId).run("echo", []), (error: unknown) => !(error instanceof HostGoneError), "an unavailable Modal is not gone");
assert.equal(await threads.state("thread-1", modalHost(finished.sandboxId)), "gone");

assert.equal(hosts.forJob({ key: "K", sandbox_id: null }), localHost, "a job without a sandbox runs here");
await hosts.forJob({ key: "K", sandbox_id: box.sandboxId }).run("echo", ["routed"]);
assert.deepEqual(box.execs.at(-1)!.argv, ["echo", "routed"], "a job with a sandbox runs there");
assert.equal(sandboxName("FAC-12", 3, 1_000_000), `job-FAC-12-a3-${(1_000_000).toString(36)}`);
assert.notEqual(sandboxName("FAC-12", 3, 1), sandboxName("FAC-12", 3, 2), "a retry after a timed-out create gets a name of its own");
assert.equal(sandboxName("weird key/ü".repeat(10), 1).length, 63);
assert.match(sandboxName("weird key/ü".repeat(10), 1), /-[0-9a-z]+$/, "the suffix survives the length limit");
assert.match(sandboxName("weird key/ü", 1), /^[A-Za-z0-9._-]+$/);

// The launch path.
const stamp = Date.now();
const keys = ["A", "B", "C", "D", "E", "F"].map((k) => `SBX${k}-${stamp % 100000}`);
const slotA = `/tmp/slot-a-${stamp}`;
const slot = { id: TEST_MACHINE_ID, repos: ["ski043/factory-demo"], maxInFlight: 1000 };
const events: { event: string; detail: Record<string, unknown> }[] = [];
const pins = config.factory.sandbox;
const image = { imageId: "im-test", t3Version: pins.t3Version, versions: pinnedVersions(pins), factoryCommit: "abc", builtAt: "now" };

// Version pins: what each CLI prints, and what an image built with other versions says.
assert.equal(parseVersion("t3", "t3 v0.1.3-nightly.20261023.3566\n"), "0.1.3-nightly.20261023.3566");
assert.equal(parseVersion("claudeCode", "2.1.310 (Claude Code)"), "2.1.310");
assert.equal(parseVersion("codex", "codex-cli 0.164.0"), "0.164.0");
assert.equal(parseVersion("codex", "error: no such command"), null, "output without a version parses to none");
assert.equal(parseVersion("playwrightMcp", "Version 0.0.83\n"), "0.0.83");
const plugins = (enabled: boolean) => JSON.stringify([{ id: PSTACK_PLUGIN, version: "0.9.69", enabled, installPath: "/root/.claude/plugins/cache/pstack-claude/pstack/0.9.69" }]);
assert.equal(enabledPstack(plugins(true))?.version, "0.9.69");
assert.equal(enabledPstack(plugins(false)), null, "a disabled PStack does not count");
assert.equal(enabledPstack("[]"), null);
assert.equal(enabledPstack("not json"), null);
assert.equal(pinnedVersions(pins).pstack, `${pins.pstack.version}@${pins.pstack.commit.slice(0, 12)}`, "PStack is pinned by version and commit");
assert.equal(imageProblem(image, pins), undefined, "an image built with every pin can launch");
assert.match(imageProblem(null, pins)!, /no sandbox image is built/);
for (const [component, name] of [["t3", "T3"], ["claudeCode", "Claude Code"], ["codex", "Codex"], ["playwrightMcp", "Playwright MCP"], ["pstack", "PStack"]] as const) {
  const stale = { ...image, ...(component === "t3" && { t3Version: "0.0.1" }), versions: { ...image.versions, [component]: "0.0.1" } };
  assert.equal(imageProblem(stale, pins), `Rebuild the sandbox image: ${name} 0.0.1 → ${pinnedVersions(pins)[component]}; the runner rebuilds it on its tick, or run bun scripts/sandbox-image.ts`, `a ${name} mismatch alone makes the image outdated`);
}
const beforePins = { ...image, versions: undefined };
assert.match(imageProblem(beforePins, pins)!, /^Rebuild the sandbox image: Claude Code missing → .+, Codex missing → .+, Playwright MCP missing → .+, PStack missing → .+;/, "an image built before the other pins is outdated");

let claudeToken: string | undefined;
const slots = [slotA];
Object.assign(sandboxRuntime, {
  image: () => image,
  claudeToken: () => claudeToken,
  githubToken: async () => "ghs_fake_installation_token",
  slots: () => slots,
  slotAuth: (s: string) => `{"slot":"${s}"}`,
  driverOf: (provider: string) => provider,
  log: (event: string, detail: Record<string, unknown>) => void events.push({ event, detail }),
  slotHealthPath: join(mkdtempSync(join(tmpdir(), "slot-health-")), "codex-slots.json"),
});
const claudeCode = { provider: "claudeAgent", model: "claude-opus-5-5" };
const entry = (key: string, harness = claudeCode) => ({ key, sandbox_id: null, attempt: 1, source: "linear" as const, repo: "ski043/factory-demo", branch: `factory/${key}`, threadTitle: `${key} t`, message: `Work ${key}`, harness, ticket: null });
const row = async (key: string) => (await db.select().from(jobs).where(eq(jobs.key, key)))[0]!;
const ids = keys.map((k) => `sandbox-regress-${k}`);

const committedWiring = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'bun "/Users/someone/marshal-factory/hooks/report.ts"' }] }] } });
let pstackListed = false;
let start: Reply = { stdout: '{"threadId":"thread-1"}' };
let clone: Reply = {};
const seenAtFirstExec: Record<string, unknown>[] = [];
fake.answer = async (sandbox, argv) => {
  if (sandbox.execs.length === 1) {
    const [job] = await db.select().from(jobs).where(eq(jobs.sandbox_id, sandbox.sandboxId));
    seenAtFirstExec.push({ sandbox_id: job?.sandbox_id, codex_slot: job?.codex_slot });
  }
  if (argv[0] === "git" && argv[1] === "clone") {
    if (!clone.code) sandbox.files.set(`${REPO_DIR}/.claude/settings.json`, committedWiring);
    return clone;
  }
  if (argv[0] === "t3" && argv[1] === "thread" && argv[2] === "start") return start;
  if (argv.join(" ") === "claude plugin list --json") return { stdout: plugins(pstackListed) };
  return {};
};

const original = await readSettings(db);
try {
  await db.insert(jobs).values(ids.map((id, i) => linearJob(id, keys[i]!)));

  // Without the image nothing is claimed and the runner says why.
  sandboxRuntime.image = () => null;
  assert.deepEqual(await launchInSandboxes([entry(keys[0]!)], slot), []);
  assert.equal((await row(keys[0]!)).t3_thread_id, null, "a job stays queued without an image");
  assert.equal(events.at(-1)!.event, "sandbox:no-image");
  sandboxRuntime.image = () => ({ ...image, versions: { ...image.versions, claudeCode: "2.1.309" } });
  assert.deepEqual(await launchInSandboxes([entry(keys[0]!)], slot), []);
  assert.equal((await row(keys[0]!)).t3_thread_id, null, "nor with an outdated one");
  assert.deepEqual(events.at(-1), {
    event: "sandbox:no-image",
    detail: { execution: "modal", queued: [keys[0]], reason: `Rebuild the sandbox image: Claude Code 2.1.309 → ${pins.claudeCodeVersion}; the runner rebuilds it on its tick, or run bun scripts/sandbox-image.ts` },
  });
  sandboxRuntime.image = () => image;
  assert.equal(fake.created, 0, "and no sandbox was created");

  // The image's Codex config holds PStack; the launch adds the report server after it.
  const imageCodexConfig = `[marketplaces.pstack-claude]\nsource_type = "local"\nsource = "/opt/pstack"\n\n[plugins."${PSTACK_PLUGIN}"]\nenabled = true\n`;
  fake.images.set("im-test", new Map([["/root/.codex/config.toml", imageCodexConfig]]));

  // No Claude token: the Claude Code job runs on Codex, recorded on the job.
  const announced: string[] = [];
  const ticket = { execution: "modal" as const, notes: [] };
  const [first] = await launchInSandboxes([{ ...entry(keys[0]!), ticket }], slot, async (e) => void announced.push(e.key));
  assert.equal(first!.threadId, "thread-1", JSON.stringify(first));
  assert.deepEqual(announced, [keys[0]], "a launch that holds its job and slot announces the ticket's fallbacks");
  const a = await row(keys[0]!);
  assert.deepEqual([a.execution, a.ticket_overrides], ["modal", ticket], "the job records where it runs and its ticket's overrides");
  const sbA = sandboxes.get(a.sandbox_id!)!;
  assert.deepEqual([a.t3_thread_id, a.codex_slot, a.provider, a.model], ["thread-1", slotA, "codex", "gpt-6-astra"]);
  assert.ok(events.some((e) => e.event === "sandbox:harness-fallback" && e.detail.key === keys[0]), "the fallback is logged");
  assert.deepEqual(seenAtFirstExec[0], { sandbox_id: sbA.sandboxId, codex_slot: slotA }, "the sandbox and the slot are on the job before anything runs in it");
  assert.deepEqual(sbA.spec!.tags, { job: keys[0], attempt: "1", label: config.factory.label, machine: TEST_MACHINE_ID });
  assert.match(sbA.spec!.name, new RegExp(`^job-${keys[0]}-a1-[0-9a-z]+$`));
  assert.equal(sbA.spec!.imageId, "im-test");
  assert.deepEqual(sbA.spec!.secrets, {}, "no Claude token, no secret");
  const forbidden = /ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY/;
  assert.ok(![...Object.keys(sbA.spec!.secrets), ...Object.keys(sbA.spec!.env)].some((k) => forbidden.test(k)), "no API key reaches the sandbox");
  assert.deepEqual(JSON.parse(sbA.files.get("/root/.t3/userdata/settings.json")!), {
    defaultModelSelection: { instanceId: "codex", model: "gpt-6-astra" },
    textGenerationModelSelection: { instanceId: "codex", model: "gpt-6-astra" },
    defaultRuntimeMode: "full-access",
    providerInstances: {
      codex: { driver: "codex", enabled: true, config: { binaryPath: "codex", homePath: "/root/.codex" } },
      claudeAgent: { driver: "claudeAgent", enabled: false },
    },
  });
  assert.equal(sbA.files.get("/root/.codex/auth.json"), `{"slot":"${slotA}"}`, "the slot's login");
  assert.match(sbA.files.get("/root/.codex/config.toml")!, /\[mcp_servers\.factory-report\]\ncommand = "bun"\nargs = \["\/opt\/marshal-factory\/mcp\/factory-report\.ts"\]/);
  assert.ok(sbA.files.get("/root/.codex/config.toml")!.startsWith(imageCodexConfig), "the image's PStack plugin stays enabled for Codex");
  assert.ok(
    sbA.files.get("/root/.codex/config.toml")!.includes(`env = { FACTORY_REPORTER = "mcp", FACTORY_JOB_KEY = "${keys[0]}", FACTORY_ATTEMPT = "1", FACTORY_REPO = "factory-demo" }`),
    "Codex's report server posts for this job's attempt",
  );
  assert.ok(events.some((e) => e.event === "sandbox:no-pstack" && e.detail.plugin === PSTACK_PLUGIN), "a sandbox whose claude lacks PStack is logged");
  assert.equal(sbA.files.get("/root/.config/marshal-factory/github-token"), "ghs_fake_installation_token");
  assert.deepEqual(JSON.parse(sbA.files.get("/root/.config/marshal-factory/config.json")!), { ingestUrl: config.ingestUrl, secret: config.secret });
  assert.match(sbA.files.get("/root/.claude/settings.json")!, /bun \\"\/opt\/marshal-factory\/hooks\/report\.ts\\"/, "user-level hooks point at the sandbox's factory");
  assert.doesNotMatch(sbA.files.get("/root/.claude/settings.json")!, /hooks\/budget\.ts/, "and wire no budget hook");
  assert.equal(JSON.parse(sbA.files.get("/root/.claude.json")!).mcpServers["factory-report"].args[0], "/opt/marshal-factory/mcp/factory-report.ts");
  assert.deepEqual(JSON.parse(sbA.files.get("/root/.claude.json")!).mcpServers["factory-report"].env, { FACTORY_REPORTER: "hook" }, "Claude Code's hooks report its stages, so its server only validates");
  assert.deepEqual(JSON.parse(sbA.files.get("/root/.claude.json")!).mcpServers.playwright, browserServer, "Claude Code gets the headless browser server");
  assert.ok(sbA.files.get("/root/.codex/config.toml")!.includes(`[mcp_servers.playwright]\ncommand = "playwright-mcp"\nargs = ${JSON.stringify(browserServer.args)}\n`), "Codex gets the headless browser server");
  const argvs = sbA.execs.map((e) => e.argv.join(" "));
  for (const path of ["/root/.codex/auth.json", "/root/.config/marshal-factory/github-token", "/root/.config/marshal-factory/config.json"]) {
    assert.ok(argvs.includes(`chmod 600 ${path}`), `${path} is owner-only`);
  }
  assert.ok(!argvs.some((a) => a.includes("ghs_fake")), "the token never appears in a command line");
  assert.ok(argvs.includes(`git clone --quiet https://github.com/ski043/factory-demo.git ${REPO_DIR}`));
  assert.ok(argvs.includes("ln -sfn /opt/marshal-factory /Users/someone/marshal-factory"), "the committed wiring's factory path links to the sandbox's");
  const order = (needle: string) => argvs.findIndex((a) => a.includes(needle));
  assert.ok(order("git clone") < order("t3 serve") && order("t3 serve") < order("t3 project add") && order("t3 project add") < order("t3 thread start"), "clone, serve, project, then the thread");
  const startExec = sbA.execs.find((e) => e.argv[2] === "start")!;
  assert.deepEqual(startExec.argv, ["t3", "thread", "start", REPO_DIR, "-", "--worktree", "origin/main", "--branch", `factory/${keys[0]}`, "--title", `${keys[0]} t`, "--provider", "codex", "--model", "gpt-6-astra", "--json"]);
  assert.ok(startExec.input.startsWith(`Work ${keys[0]}\n\n## Factory playbook\n`), "the message, then the playbook the image holds");

  // The only slot is held now: the next job stays queued.
  const none = await launchInSandboxes([entry(keys[1]!)], slot, async (e) => void announced.push(e.key));
  assert.deepEqual(announced, [keys[0]], "a launch that found no slot announces nothing");
  assert.deepEqual(none, []);
  assert.deepEqual([(await row(keys[1]!)).t3_thread_id, (await row(keys[1]!)).machine_id], [null, null], "no free slot, so the claim is undone");
  assert.equal(events.at(-1)!.event, "sandbox:no-slot");

  // With a Claude token a Codex job still needs a free slot, and waits for one.
  claudeToken = "sk-ant-oat-fake";
  assert.deepEqual(await launchInSandboxes([entry(keys[1]!, { provider: "codex", model: "gpt-6-astra" })], slot), []);
  assert.deepEqual([(await row(keys[1]!)).t3_thread_id, (await row(keys[1]!)).machine_id], [null, null], "a Codex job with the only slot held stays queued");
  assert.equal(events.at(-1)!.event, "sandbox:no-slot");

  // A Claude Code job keeps its harness and needs no slot, so it launches with the only one held; the token goes in as a secret.
  pstackListed = true;
  const pstackWarnings = () => events.filter((e) => e.event === "sandbox:no-pstack").length;
  const warned = pstackWarnings();
  await launchInSandboxes([entry(keys[1]!)], slot);
  assert.equal(pstackWarnings(), warned, "a sandbox with PStack enabled launches without a warning");
  const b = await row(keys[1]!);
  const sbB = sandboxes.get(b.sandbox_id!)!;
  assert.deepEqual([b.t3_thread_id, b.codex_slot, b.provider, b.model], ["thread-1", null, "claudeAgent", "claude-opus-5-5"], "no slot is leased");
  assert.ok(!sbB.files.has("/root/.codex/auth.json") && !sbB.execs.some((e) => e.argv.join(" ") === "codex login status"), "and no Codex login goes in");
  assert.deepEqual(sbB.spec!.secrets, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-fake" });
  assert.equal(JSON.parse(sbB.files.get("/root/.t3/userdata/settings.json")!).providerInstances.claudeAgent.enabled, true);

  // maxParallel counts working jobs with a sandbox, slot or not.
  const maxParallel = config.factory.sandbox.maxParallel;
  config.factory.sandbox.maxParallel = 2;
  try {
    assert.deepEqual(await launchInSandboxes([entry(keys[2]!)], slot), [], "two working sandboxes fill maxParallel 2");
    assert.equal((await row(keys[2]!)).t3_thread_id, null);
  } finally {
    config.factory.sandbox.maxParallel = maxParallel;
  }

  // A clear setup failure ends the sandbox and frees everything for the next pass.
  clone = { code: 128, stderr: "fatal: repository not found" };
  const [cloneFailed] = await launchInSandboxes([entry(keys[2]!)], slot);
  assert.equal(cloneFailed!.retry, "next pass", JSON.stringify(cloneFailed));
  const c = await row(keys[2]!);
  assert.deepEqual([c.t3_thread_id, c.machine_id, c.sandbox_id, c.codex_slot, c.provider], [null, null, null, null, null]);
  const sbC = [...sandboxes.values()].find((s) => s.spec?.tags.job === keys[2])!;
  assert.equal(sbC.terminated, true, "the sandbox is terminated");
  assert.ok(!sbC.execs.some((e) => e.argv[2] === "start"), "no thread was asked for");
  clone = {};

  // A start that may have made the thread keeps the sandbox for recovery. It is a second Claude Code job launched with the only slot held.
  start = { stdout: "not json" };
  const [maybe] = await launchInSandboxes([entry(keys[3]!)], slot);
  assert.equal(maybe!.retry, "after launch recovery");
  const d = await row(keys[3]!);
  const sbD = sandboxes.get(d.sandbox_id!)!;
  assert.ok(d.t3_thread_id!.startsWith("pending:") && d.codex_slot === null && !sbD.terminated, "marker and sandbox stay");
  start = { stdout: '{"threadId":"thread-1"}' };

  // Recovery asks the sandbox's T3 for the thread on the job's branch.
  await db.update(jobs).set({ t3_thread_id: "pending:1" }).where(eq(jobs.key, keys[3]!));
  fake.answer = (_sandbox, argv) => {
    if (argv.join(" ") === `t3 thread list --project ${REPO_DIR} --json`) return { stdout: '[{"threadId":"thread-late"}]' };
    if (argv.join(" ") === "t3 thread show thread-late --json") return { stdout: JSON.stringify({ thread: { branch: `factory/${keys[3]}` } }) };
    return {};
  };
  const checkouts = new Map([["ski043/factory-demo", "/unused"]]);
  const recovered = await recoverPending(checkouts);
  assert.deepEqual(recovered.find((r) => r.key === keys[3]), { key: keys[3], threadId: "thread-late" });
  assert.deepEqual([(await row(keys[3]!)).t3_thread_id, (await row(keys[3]!)).sandbox_id], ["thread-late", sbD.sandboxId], "bound in place");

  // A stale sandbox launch whose sandbox is gone has no thread: released, slot freed.
  await db.update(jobs).set({ t3_thread_id: "pending:1", machine_id: TEST_MACHINE_ID, sandbox_id: "sb-vanished", codex_slot: `/tmp/slot-e-${stamp}` }).where(eq(jobs.key, keys[4]!));
  const vanished = await recoverPending(checkouts);
  assert.deepEqual(vanished.find((r) => r.key === keys[4]), { key: keys[4], threadId: null });
  const e = await row(keys[4]!);
  assert.deepEqual([e.t3_thread_id, e.machine_id, e.sandbox_id, e.codex_slot], [null, null, null, null]);

  // A sandbox whose T3 cannot answer keeps its marker for a while.
  const sbF = new FakeSandbox("sb-quiet");
  sandboxes.set(sbF.sandboxId, sbF);
  fake.answer = () => ({ code: 1, stderr: "connection refused" });
  const staleMarker = `pending:${Date.now() - 20 * 60_000}`;
  await db.update(jobs).set({ t3_thread_id: staleMarker, machine_id: TEST_MACHINE_ID, sandbox_id: sbF.sandboxId, codex_slot: `/tmp/slot-f-${stamp}` }).where(eq(jobs.key, keys[5]!));
  const quiet = await recoverPending(checkouts);
  assert.equal(quiet.find((r) => r.key === keys[5])?.retry, "next pass");
  assert.equal((await row(keys[5]!)).t3_thread_id, staleMarker);
  assert.equal(sbF.terminated, false);
  // Past the give-up age the sandbox ends, with any thread in it, and the job is free to relaunch.
  await db.update(jobs).set({ t3_thread_id: "pending:1" }).where(eq(jobs.key, keys[5]!));
  const givenUp = await recoverPending(checkouts);
  assert.equal(givenUp.find((r) => r.key === keys[5])?.threadId, null, JSON.stringify(givenUp));
  const f = await row(keys[5]!);
  assert.deepEqual([f.t3_thread_id, f.machine_id, f.sandbox_id, f.codex_slot], [null, null, null, null]);
  assert.equal(sbF.terminated, true);

  // A fresh marker is left alone, whatever its sandbox says.
  await db.update(jobs).set({ t3_thread_id: `pending:${Date.now()}`, machine_id: TEST_MACHINE_ID, sandbox_id: "sb-vanished" }).where(eq(jobs.key, keys[4]!));
  assert.equal((await recoverPending(checkouts)).find((r) => r.key === keys[4]), undefined);
  await db.update(jobs).set({ t3_thread_id: null, machine_id: null, sandbox_id: null }).where(eq(jobs.key, keys[4]!));

  // The execution setting: local unless saved otherwise.
  await db.delete(settings).where(eq(settings.id, SETTINGS_ID));
  assert.equal((await launchSettings()).execution, "local", "with nothing saved jobs run locally");
  await writeSettings(db, { provider: "codex", model: "m" }, "o@example.com", new Date());
  assert.equal((await launchSettings()).execution, "local", "a save without an execution keeps local");
  await writeSettings(db, { provider: "codex", model: "m", execution: "modal" }, "o@example.com", new Date());
  assert.equal((await launchSettings()).execution, "modal");
  await writeSettings(db, { provider: "codex", model: "m" }, "o@example.com", new Date());
  assert.equal((await launchSettings()).execution, "modal", "a harness change keeps the execution");

  console.log("sandbox regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(jobs).where(inArray(jobs.id, ids.map((id) => jobId("linear", id))));
  await db.delete(settings).where(eq(settings.id, SETTINGS_ID));
  if (original) await db.insert(settings).values(original);
  process.exit(process.exitCode ?? 0);
}
