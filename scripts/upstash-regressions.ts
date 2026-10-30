import "./test-guard";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { BoxCommand, UpstashApi, UpstashBox } from "../lib/upstash-host";

const { db } = await import("../db/client");
const { jobs } = await import("../db/schema");
const { HostGoneError } = await import("../lib/host");
const { cloudOfSandbox } = await import("../lib/execution");
const { pathsOf, UPSTASH_HOME } = await import("../lib/sandbox");
const { commandLine, shellQuote, upstash, upstashHost, isUpstashGone, realUpstash } = await import("../lib/upstash-host");
const { backendOf, modalBackend, upstashBackend } = await import("../runner/sandbox-backend");
const { reap, settleInterrupted } = await import("../runner/lifecycle");
const { linearJob } = await import("./fixtures");
const { TEST_MACHINE_ID } = await import("../lib/config");

// --- The one shell line a command becomes ------------------------------------------------------

assert.equal(shellQuote("it's"), `'it'\\''s'`, "a single quote cannot end the quoting");
assert.equal(commandLine("git", ["log", "--format=%H $(rm -rf /)"], {}), `'git' 'log' '--format=%H $(rm -rf /)' < /dev/null`, "arguments are never shell syntax");
assert.equal(commandLine("ls", [], { cwd: "/work/repo", timeoutMs: 1500 }), `cd '/work/repo' && timeout -k 5 2 'ls' < /dev/null`, "cwd and a timeout rounded up to seconds");
assert.equal(
  commandLine("t3", ["login"], { inputPath: "/tmp/in" }),
  `'t3' 'login' < '/tmp/in'; c=$?; rm -f '/tmp/in'; exit $c`,
  "stdin comes from a file the line removes, keeping the command's exit code",
);
await assert.rejects(realUpstash.get("x"), /Upstash was called during a regression run/, "the real client refuses in a test run");

// --- A fake Upstash -----------------------------------------------------------------------------

type Fake = { box: UpstashBox; files: Map<string, string>; commands: string[]; status: string; answer: (line: string) => Partial<BoxCommand> };
const boxes = new Map<string, Fake>();
const gone = () => new Error("Box has been deleted");
function fakeBox(id: string, answer: Fake["answer"] = () => ({})): Fake {
  const fake = { files: new Map(), commands: [], status: "idle", answer } as unknown as Fake;
  const alive = () => {
    if (fake.status === "deleted") throw gone();
  };
  fake.box = {
    id,
    exec: {
      async command(line) {
        alive();
        if (fake.status === "paused") fake.status = "idle";
        fake.commands.push(line);
        return { exitCode: 0, status: "completed", stdout: "", stderr: "", ...fake.answer(line) };
      },
    },
    files: {
      async read(path, options) {
        alive();
        const text = fake.files.get(path);
        if (text === undefined) throw new Error(`file not found: ${path}`);
        const bytes = Buffer.from(text);
        const slice = bytes.subarray(options?.offset ?? 0, (options?.offset ?? 0) + (options?.length ?? bytes.length));
        return options?.encoding === "base64" ? slice.toString("base64") : slice.toString();
      },
      async write({ path, content }) {
        alive();
        fake.files.set(path, content);
      },
    },
    pause: async () => void (alive(), (fake.status = "paused")),
    resume: async () => void (alive(), (fake.status = "idle")),
    delete: async () => void (alive(), (fake.status = "deleted")),
    getPublicURL: async (port) => ({ url: `https://${id}-${port}.preview.box.upstash.com` }),
    snapshot: async () => ({ id: `snap-${id}` }),
    listSnapshots: async () => [{ id: `snap-${id}`, status: "ready" }],
  };
  boxes.set(id, fake);
  return fake;
}
const api: UpstashApi = {
  async create(spec) {
    const fake = fakeBox(`box-${boxes.size + 1}`);
    fake.files.set("/spec", JSON.stringify(spec));
    return fake.box;
  },
  async get(boxId) {
    const fake = boxes.get(boxId);
    if (!fake || fake.status === "deleted") throw gone();
    return fake.box;
  },
  list: async () => [...boxes.entries()].map(([id, f]) => ({ id, labels: ["mf:factory"], status: f.status })),
};
upstash.api = api;
// The reap lists every backend; this test has no Modal sandboxes.
const { modal } = await import("../lib/modal-host");
modal.api = { ...modal.api, list: async () => [] };

// --- The host -----------------------------------------------------------------------------------

const answers = fakeBox("host-1", (line) => {
  if (line.includes("'false'")) return { exitCode: 3, status: "failed", stdout: "partial", stderr: "boom" };
  if (line.includes("'sleep'")) return { exitCode: 124, status: "failed" };
  if (line.includes("'test' '-e' '/missing'")) return { exitCode: 1, status: "failed" };
  if (line.includes("'ls'")) return { stdout: "a\n.b\n" };
  return { stdout: "out", stderr: "err" };
});
const host = upstashHost("upstash:host-1");
assert.equal(host.home, UPSTASH_HOME, "a box's tools live in boxuser's home, since /root is a noexec tmpfs");
assert.equal(pathsOf(host).codexAuth, `${UPSTASH_HOME}/.codex/auth.json`);
assert.deepEqual(await host.run("echo", ["hi"]), { stdout: "out", stderr: "err" });
await assert.rejects(host.run("false", []), (e: Error & { code?: number; stdout?: string; stderr?: string; killed?: boolean }) => e.code === 3 && e.stdout === "partial" && e.stderr === "boom" && e.killed === false, "a failure keeps its exit code and output");
await assert.rejects(host.run("sleep", ["99"], { timeoutMs: 1000 }), (e: Error & { killed?: boolean }) => e.killed === true, "timeout's exit reads as killed");
await host.run("t3", ["pair"], { input: "secret-token" });
const line = answers.commands.at(-1)!;
assert.ok(!line.includes("secret-token"), "input never appears in the command line");
assert.ok(line.startsWith("PATH=/usr/local/bin:$PATH; export PATH; "), "the image's pinned tools come before Upstash's own claude and codex");
assert.equal([...answers.files.values()].includes("secret-token"), true, "it goes through a file");
assert.equal(await host.exists("/missing"), false);
assert.deepEqual(await host.list("/x"), ["a", ".b"]);
assert.equal(await host.readFile("/nope"), null, "a missing file is null, not a gone box");
const big = "é".repeat(4 * 1024 * 1024);
answers.files.set("/big", big);
assert.equal(await host.readFile("/big"), big, "a file larger than one read comes back whole, split mid-character or not");

const dying = fakeBox("host-2");
const dead = upstashHost("upstash:host-2");
dying.status = "deleted";
await assert.rejects(dead.run("echo", []), HostGoneError, "a deleted box is gone");
await assert.rejects(dead.readFile("/x"), HostGoneError, "for reads too");
assert.equal(isUpstashGone(new Error("file not found: /x")), false);

// --- The backend --------------------------------------------------------------------------------

assert.equal(backendOf("upstash:box-9"), upstashBackend);
assert.equal(backendOf("sb-01ABC"), modalBackend, "an unmarked id is Modal's, as every id was before");
assert.equal(cloudOfSandbox("upstash:box-9"), "upstash");
assert.equal(cloudOfSandbox("im-1"), "modal");

const created = await upstashBackend.create({ key: "FAC-9", attempt: 2, label: "factory", machineId: TEST_MACHINE_ID, imageId: "snap-base", limits: {} as never, claudeToken: "tok" });
assert.match(created.sandboxId, /^upstash:box-\d+$/);
const spec = JSON.parse(boxes.get(created.sandboxId.slice("upstash:".length))!.files.get("/spec")!);
assert.equal(spec.snapshotId, "snap-base", "it starts from the base snapshot");
assert.deepEqual(spec.env, { IS_SANDBOX: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok" }, "the Claude token reaches the box as env, as Modal's secret does");
assert.ok(spec.labels.every((l: string) => l.length <= 20) && spec.labels.length <= 5, "labels fit Upstash's limits");
await assert.rejects(
  upstashBackend.create({ key: "FAC-9", attempt: 1, label: "factory", machineId: TEST_MACHINE_ID, imageId: "s", limits: {} as never, claudeToken: undefined, namedSecrets: ["mf-repo-x"] }),
  /repo secrets are not supported on Upstash/,
);
const boxOf = (id: string) => boxes.get(id.slice("upstash:".length))!;

const ref = await upstashBackend.hibernate(created.sandboxId, 1000);
assert.equal(ref, created.sandboxId, "the box is its own hibernation ref");
await upstashBackend.terminate(created.sandboxId, ref);
assert.equal(boxOf(created.sandboxId).status, "paused", "ending a box that is the ref to keep pauses it, keeping disk and processes");
await upstashBackend.discard(ref, created.sandboxId);
assert.equal(boxOf(ref).status, "paused", "a ref the job's sandbox still is, is never discarded");
const woken = await upstashBackend.wake(ref, { key: "FAC-9", attempt: 2, label: "factory", machineId: TEST_MACHINE_ID, limits: {} as never, claudeToken: "tok" });
assert.equal(woken.sandboxId, ref, "a wake resumes the same box");
assert.equal(boxOf(ref).status, "idle");
assert.deepEqual(await upstashBackend.tunnel(ref, 3773), { kind: "url", url: `https://${ref.slice(8)}-3773.preview.box.upstash.com` });
await upstashBackend.terminate(ref);
assert.equal(boxOf(ref).status, "deleted", "ending it with nothing to keep deletes it");
await upstashBackend.terminate(ref);
await upstashBackend.discard(ref);
await upstashBackend.terminate(ref, ref);

// --- The stdin file never outlives a command that did not run (it can hold a token) -------------

const flaky = fakeBox("host-3", (line) => {
  if (line.includes("'t3' 'pair'")) throw new Error("socket hang up");
  return {};
});
const flakyBox = flaky.box;
const run = flakyBox.exec.command.bind(flakyBox.exec);
flakyBox.exec.command = async (line) => {
  const rm = /^rm -f '([^']+)'$/.exec(line);
  if (rm) flaky.files.delete(rm[1]!);
  return run(line);
};
await assert.rejects(upstashHost("upstash:host-3").run("t3", ["pair"], { input: "session-token" }), /socket hang up/);
await new Promise((r) => setTimeout(r, 20));
assert.equal([...flaky.files.values()].includes("session-token"), false, "a command whose request failed still has its input file removed");

// --- Paths and commands that differ for a box's unprivileged user -------------------------------

const { asRoot } = await import("../runner/sandbox");
const { unmergedRecipePath, UNMERGED_RECIPE_PATH } = await import("../lib/recipe");
const { modalHost } = await import("../lib/modal-host");
assert.deepEqual(asRoot(host, "mkdir", ["-p", "/Users/me/code"]), ["sudo", ["-n", "mkdir", "-p", "/Users/me/code"]], "a box writes a repo's committed roots through sudo");
assert.deepEqual(asRoot(modalHost("sb-1"), "mkdir", ["-p", "/Users/me/code"]), ["mkdir", ["-p", "/Users/me/code"]], "Modal's root needs none");
assert.equal(unmergedRecipePath(UPSTASH_HOME), "/home/boxuser/.config/marshal-factory/recipe.json", "the unmerged recipe lives in the box's home, not in /root");
assert.equal(UNMERGED_RECIPE_PATH, "/root/.config/marshal-factory/recipe.json", "Modal's path is unchanged");
const { imageProblem } = await import("../lib/sandbox");
assert.match(imageProblem(null, {} as never, "upstash")!, /no Upstash base snapshot is built; run bun scripts\/sandbox-image\.ts --backend upstash/);
assert.match(imageProblem(null, {} as never)!, /no sandbox image is built/, "Modal's wording is unchanged");

// --- A repo Upstash cannot run is known before planning ----------------------------------------

const { upstashRepoProblem } = await import("../runner/launch");
assert.equal(upstashRepoProblem(undefined), null);
assert.equal(upstashRepoProblem({ repo: "acme/web", onboarding_detail: {} } as never), null);
assert.match(upstashRepoProblem({ repo: "acme/web", onboarding_detail: { secretsSet: ["API_KEY"] } } as never)!, /acme\/web has repo secrets/, "so a labelled ticket falls back with a note rather than waiting unseen");

// --- The panel names the cloud ------------------------------------------------------------------

const { runsOn, whereLine } = await import("../components/panel/cards");
const place = (job: { execution: string | null; sandbox_id?: string | null; sandbox_snapshot?: string | null }) => {
  const where = runsOn({ machine_id: "m", sandbox_id: null, sandbox_snapshot: null, ...job } as never);
  return where && [where.kind, whereLine(where, "Mac")];
};
assert.deepEqual(place({ execution: "upstash" }), ["cloud", "Upstash Box"], "an Upstash job with no live box is not shown as local");
assert.deepEqual(place({ execution: null, sandbox_snapshot: "upstash:b" }), ["cloud", "Upstash Box"], "one recorded before its execution names its cloud by its id");
assert.deepEqual(place({ execution: "modal" }), ["cloud", "Cloud sandbox"]);
assert.deepEqual(place({ execution: "local" }), ["local", "Local · Mac"]);

// --- The lifecycle never ends a box that is its own ref -----------------------------------------

const { sandboxesInFlight } = await import("../runner/lifecycle");
const stamp = Date.now();
const asleepBox = fakeBox(`asleep-${stamp}`);
const sleeping = fakeBox(`sleeping-${stamp}`);
const stale = fakeBox(`stale-${stamp}`);
const cutShort = fakeBox(`cut-${stamp}`);
const orphan = fakeBox(`orphan-${stamp}`);
const pausedOrphan = fakeBox(`porphan-${stamp}`);
const working = fakeBox(`working-${stamp}`);
const id = (name: string) => `upstash:${name}-${stamp}`;
const keys = [1, 2, 3, 4, 5].map((n) => `UPS-${stamp % 100000}${n}`);
const old = new Date(Date.now() - 40 * 86_400_000);
await db.insert(jobs).values([
  // A hibernated job whose box a request resumed.
  linearJob(`ups-a-${stamp}`, keys[0]!, { stage: "waiting", machine_id: TEST_MACHINE_ID, sandbox_snapshot: id("asleep"), execution: "upstash", t3_thread_id: "t-a", stage_at: new Date() }),
  // A hibernate cut short between recording the ref and pausing.
  linearJob(`ups-b-${stamp}`, keys[1]!, { stage: "pr", machine_id: TEST_MACHINE_ID, sandbox_id: id("cut"), sandbox_snapshot: id("cut"), execution: "upstash", t3_thread_id: "t-b" }),
  // A hibernated job whose box sleeps as it should.
  linearJob(`ups-c-${stamp}`, keys[2]!, { stage: "pr", machine_id: TEST_MACHINE_ID, sandbox_snapshot: id("sleeping"), execution: "upstash", t3_thread_id: "t-c", stage_at: new Date() }),
  // One hibernated for longer than snapshotTtlDays: Upstash would keep its box forever.
  linearJob(`ups-d-${stamp}`, keys[3]!, { stage: "waiting", machine_id: TEST_MACHINE_ID, sandbox_snapshot: id("stale"), execution: "upstash", t3_thread_id: "t-d", stage_at: old }),
  // A working Codex job whose box Upstash paused on its own while the runner was away.
  linearJob(`ups-e-${stamp}`, keys[4]!, { stage: "implementing", machine_id: TEST_MACHINE_ID, sandbox_id: id("working"), execution: "upstash", t3_thread_id: "t-e", codex_slot: `/tmp/ups-slot-${stamp}` }),
]);
asleepBox.status = "idle";
sleeping.status = "paused";
stale.status = "paused";
pausedOrphan.status = "paused";
working.status = "paused";
await settleInterrupted();
assert.equal(cutShort.status, "paused", "a cut-short hibernate pauses its box rather than ending its only copy");
const [settled] = await db.select().from(jobs).where(eq(jobs.key, keys[1]!));
assert.deepEqual([settled!.sandbox_id, settled!.sandbox_snapshot], [null, id("cut")], "and the job is hibernated on it");

assert.ok((await sandboxesInFlight(TEST_MACHINE_ID)) >= 1, "a working job's box that Upstash paused still counts against maxParallel");
const commandsBefore = sleeping.commands.length;
const first = await reap();
const second = await reap();
assert.equal(asleepBox.status, "paused", "the reap pauses a hibernated job's box that runs again");
assert.ok(!(first.repaused ?? []).includes(id("sleeping")) && sleeping.commands.length === commandsBefore, "but leaves one that already sleeps alone");
assert.equal(stale.status, "deleted", "a ref older than snapshotTtlDays is discarded, as Modal's snapshots expire");
assert.deepEqual(first.expired, [id("stale")]);
assert.equal(orphan.status, "deleted", "a box no job knows ends on its second sighting");
assert.equal(pausedOrphan.status, "deleted", "asleep or not");
assert.ok(!second.terminated.includes(id("asleep")) && !second.terminated.includes(id("working")), "never a hibernated job's box, nor a working one's");
assert.deepEqual(second.freed, [], "and a working job keeps its Codex slot while Upstash has its box paused");
assert.equal((await db.select().from(jobs).where(eq(jobs.key, keys[4]!)))[0]!.codex_slot, `/tmp/ups-slot-${stamp}`);

for (const key of keys) await db.delete(jobs).where(eq(jobs.key, key));
console.log("upstash regressions passed");
