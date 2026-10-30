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
await upstashBackend.release(created.sandboxId);
assert.equal(boxOf(created.sandboxId).status, "paused", "release pauses, keeping disk and processes");
const woken = await upstashBackend.wake(ref, { key: "FAC-9", attempt: 2, label: "factory", machineId: TEST_MACHINE_ID, limits: {} as never, claudeToken: "tok" });
assert.equal(woken.sandboxId, ref, "a wake resumes the same box");
assert.equal(boxOf(ref).status, "idle");
assert.deepEqual(await upstashBackend.tunnel(ref, 3773), { kind: "url", url: `https://${ref.slice(8)}-3773.preview.box.upstash.com` });
await upstashBackend.terminate(ref);
assert.equal(boxOf(ref).status, "deleted");
await upstashBackend.terminate(ref);
await upstashBackend.discard(ref);
await upstashBackend.release(ref);

// --- The lifecycle never ends a box that is its own ref -----------------------------------------

const stamp = Date.now();
const asleepBox = fakeBox(`asleep-${stamp}`);
const cutShort = fakeBox(`cut-${stamp}`);
const orphan = fakeBox(`orphan-${stamp}`);
const asleepId = `upstash:asleep-${stamp}`;
const cutId = `upstash:cut-${stamp}`;
const keyA = `UPS-${stamp % 100000}1`;
const keyB = `UPS-${stamp % 100000}2`;
await db.insert(jobs).values([
  // A hibernated job whose box a request resumed.
  linearJob(`ups-a-${stamp}`, keyA, { stage: "waiting", machine_id: TEST_MACHINE_ID, sandbox_snapshot: asleepId, execution: "upstash", t3_thread_id: "t-a" }),
  // A hibernate cut short between recording the ref and pausing.
  linearJob(`ups-b-${stamp}`, keyB, { stage: "pr", machine_id: TEST_MACHINE_ID, sandbox_id: cutId, sandbox_snapshot: cutId, execution: "upstash", t3_thread_id: "t-b" }),
]);
asleepBox.status = "idle";
await settleInterrupted();
assert.equal(cutShort.status, "paused", "a cut-short hibernate pauses its box rather than ending its only copy");
const [settled] = await db.select().from(jobs).where(eq(jobs.key, keyB));
assert.deepEqual([settled!.sandbox_id, settled!.sandbox_snapshot], [null, cutId], "and the job is hibernated on it");

await reap();
const second = await reap();
assert.equal(asleepBox.status, "paused", "the reap pauses a hibernated job's box that runs again");
assert.equal(orphan.status, "deleted", "and ends a box no job knows, on its second sighting");
assert.ok(!("terminated" in second && second.terminated.includes(asleepId)), "never the hibernated one");

await db.delete(jobs).where(eq(jobs.key, keyA));
await db.delete(jobs).where(eq(jobs.key, keyB));
console.log("upstash regressions passed");
