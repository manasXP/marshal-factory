import { randomUUID } from "node:crypto";
import { Box } from "@upstash/box";
import type { ExecError, ExecOptions } from "./exec";
import { UPSTASH_PREFIX } from "./execution";
import { HostGoneError, type JobHost } from "./host";
import { UPSTASH_HOME } from "./sandbox";
import { forbidInTest } from "./test-mode";

// Runner only. The slice of the Upstash Box SDK the factory uses, so regressions can hand in a fake.
// A box's id in the factory carries the `upstash:` prefix, so a sandbox id or hibernation ref names
// its backend (runner/sandbox-backend.ts); the SDK gets the bare id.

export type BoxCommand = { exitCode: number | null; status: string; stdout: string; stderr: string };

export type UpstashBox = {
  readonly id: string;
  exec: { command(command: string): Promise<BoxCommand> };
  files: {
    read(path: string, options?: { encoding?: "base64"; offset?: number; length?: number }): Promise<string>;
    write(options: { path: string; content: string }): Promise<void>;
  };
  pause(): Promise<void>;
  resume(): Promise<void>;
  delete(): Promise<void>;
  getPublicURL(port: number): Promise<{ url: string }>;
  snapshot(options?: { name?: string }): Promise<{ id: string }>;
  listSnapshots(): Promise<{ id: string; status: string }[]>;
};

export type UpstashBoxSpec = {
  /** The snapshot to start from; a fresh box from the runtime when absent (image builds). */
  snapshotId?: string;
  name: string;
  /** At most five, each at most 20 characters of letters, digits, `.`, `_`, `-` and `:`. */
  labels: string[];
  env: Record<string, string>;
  size?: "small" | "medium" | "large";
};

export type ListedBox = { id: string; name?: string; labels: string[]; status: string };

export type UpstashApi = {
  create(spec: UpstashBoxSpec): Promise<UpstashBox>;
  get(boxId: string): Promise<UpstashBox>;
  list(label: string): Promise<ListedBox[]>;
};

const asBox = (box: Box): UpstashBox => box as unknown as UpstashBox;

export const realUpstash: UpstashApi = {
  async create({ snapshotId, ...config }) {
    forbidInTest("Upstash");
    const options = { runtime: "node" as const, ...config };
    return asBox(snapshotId ? await Box.fromSnapshot(snapshotId, options) : await Box.create(options));
  },
  async get(boxId) {
    forbidInTest("Upstash");
    return asBox(await Box.get(boxId));
  },
  async list(label) {
    forbidInTest("Upstash");
    return (await Box.list({ label })).map((b) => ({ id: b.id, name: b.name, labels: b.labels ?? [], status: b.status }));
  },
};

/** Regressions swap `api` for a fake. */
export const upstash: { api: UpstashApi } = { api: realUpstash };

export { UPSTASH_PREFIX };
export const isUpstashId = (id: string) => id.startsWith(UPSTASH_PREFIX);
export const upstashId = (boxId: string) => `${UPSTASH_PREFIX}${boxId}`;
export const boxIdOf = (id: string) => (isUpstashId(id) ? id.slice(UPSTASH_PREFIX.length) : id);

/** A box Upstash no longer has. A missing file in a live box is not one. */
export function isUpstashGone(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /box has been deleted|box not found|no such box/i.test(message);
}

const gone = (id: string, error: unknown) => (isUpstashGone(error) ? new HostGoneError(`box ${boxIdOf(id)} is gone: ${(error as Error).message}`) : error);

const handles = new Map<string, Promise<UpstashBox>>();

async function handle(id: string) {
  let box = handles.get(id);
  if (!box) {
    box = upstash.api.get(boxIdOf(id));
    handles.set(id, box);
    box.catch(() => handles.delete(id));
  }
  return box;
}

export const rememberBox = (box: UpstashBox) => void handles.set(upstashId(box.id), Promise.resolve(box));
export const forgetBox = (id: string) => void handles.delete(id);

/** Single-quoted for sh, so no argument is ever read as shell syntax. */
export const shellQuote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;

const EXEC_DIR = "/tmp/marshal-factory-exec";

/**
 * Upstash puts its own claude and codex in /opt/runner/bin, first on PATH, which a box's env cannot
 * change. Every command starts with the image's pinned tools first instead, and whatever it starts,
 * such as `t3 serve` and the agents T3 runs, inherits that.
 */
export const PINNED_TOOLS_FIRST = "PATH=/usr/local/bin:$PATH; export PATH; ";
const TIMEOUT_EXITS = new Set([124, 137]);

/**
 * The one shell line a command runs as. stdin comes from a file the runner wrote first, since a
 * box command takes no input; `timeout` ends a command past its deadline, as execFile's would.
 */
export function commandLine(command: string, args: readonly string[], { cwd, timeoutMs, inputPath }: { cwd?: string; timeoutMs?: number; inputPath?: string }) {
  const argv = [command, ...args].map(shellQuote).join(" ");
  const limited = timeoutMs !== undefined ? `timeout -k 5 ${Math.max(1, Math.ceil(timeoutMs / 1000))} ${argv}` : argv;
  const run = `${limited} < ${inputPath ? shellQuote(inputPath) : "/dev/null"}`;
  const inDir = cwd !== undefined ? `cd ${shellQuote(cwd)} && ${run}` : run;
  return inputPath ? `${inDir}; c=$?; rm -f ${shellQuote(inputPath)}; exit $c` : inDir;
}

const READ_CHUNK = 6 * 1024 * 1024;

/**
 * A JobHost whose commands run in an Upstash box. `run` settles like the local host: it resolves
 * on a zero exit and rejects with an ExecError carrying the exit code, the output, and `killed` on a
 * timeout. A box that no longer exists rejects with HostGoneError.
 */
export function upstashHost(id: string): JobHost {
  async function run(command: string, args: string[], { input, cwd, timeoutMs }: ExecOptions = {}) {
    const line = `${command} ${args.join(" ")}`;
    let result: BoxCommand;
    try {
      const box = await handle(id);
      let inputPath: string | undefined;
      if (input !== undefined) {
        inputPath = `${EXEC_DIR}/${randomUUID()}`;
        await box.files.write({ path: inputPath, content: input });
      }
      const pending = box.exec.command(PINNED_TOOLS_FIRST + commandLine(command, args, { cwd, timeoutMs, inputPath }));
      // The box's own deadline is `timeout` above; this one covers a box that never answers.
      const deadline = timeoutMs === undefined ? null : new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs + 15_000).unref?.());
      const settled = deadline ? await Promise.race([pending, deadline]) : await pending;
      if (settled === "timeout") {
        pending.catch(() => {});
        throw Object.assign(new Error(`Command timed out: ${line}`), { killed: true, stdout: "", stderr: "" } satisfies Partial<ExecError>);
      }
      result = settled;
    } catch (error) {
      throw gone(id, error);
    }
    const code = result.exitCode ?? (result.status === "completed" ? 0 : 1);
    if (code === 0) return { stdout: result.stdout, stderr: result.stderr };
    const killed = timeoutMs !== undefined && TIMEOUT_EXITS.has(code);
    throw Object.assign(new Error(`Command failed: ${line}\n${result.stderr}`), { code, stdout: result.stdout, stderr: result.stderr, killed } satisfies Partial<ExecError>);
  }

  const succeeds = async (command: string, args: string[]) => {
    try {
      await run(command, args, { timeoutMs: 30_000 });
      return true;
    } catch (error) {
      if ((error as ExecError).code === 1) return false;
      throw error;
    }
  };

  return {
    t3: "t3",
    home: UPSTASH_HOME,
    run,
    async readFile(path) {
      try {
        const box = await handle(id);
        // Base64 chunks, so a large file comes back byte for byte however its text splits.
        const chunks: Buffer[] = [];
        for (let offset = 0; ; offset += READ_CHUNK) {
          const chunk = Buffer.from(await box.files.read(path, { encoding: "base64", offset, length: READ_CHUNK }), "base64");
          chunks.push(chunk);
          if (chunk.byteLength < READ_CHUNK) break;
        }
        return Buffer.concat(chunks).toString("utf8");
      } catch (error) {
        if (!isUpstashGone(error) && /file not found|no such file/i.test(error instanceof Error ? error.message : String(error))) return null;
        throw gone(id, error);
      }
    },
    async writeFile(path, text) {
      try {
        // Upstash creates the parent directories.
        await (await handle(id)).files.write({ path, content: text });
      } catch (error) {
        throw gone(id, error);
      }
    },
    exists: (path) => succeeds("test", ["-e", path]),
    list: async (dir) => (await run("ls", ["-1A", dir], { timeoutMs: 30_000 })).stdout.split("\n").filter(Boolean),
    mtimeMs: async (path) => Number((await run("stat", ["-c", "%Y", path], { timeoutMs: 30_000 })).stdout.trim()) * 1000,
    remove: async (path) => void (await run("rm", ["-rf", path], { timeoutMs: 60_000 })),
  };
}
