import { ConflictError, ModalClient, NotFoundError, SandboxFilesystemNotFoundError, SandboxTimeoutError } from "modal";
import type { SandboxLimits } from "./config";
import type { ExecError, ExecOptions } from "./exec";
import { HostGoneError, type JobHost } from "./host";
import { SANDBOX_HOME } from "./sandbox";
import { forbidInTest } from "./test-mode";

// Runner only. The slice of the Modal SDK the factory uses, so regressions can hand in a fake.

export type SandboxProcess = {
  stdin: { writeText(text: string): Promise<void>; close(): Promise<void> };
  stdout: { readText(): Promise<string> };
  stderr: { readText(): Promise<string> };
  wait(): Promise<number>;
};

export type SandboxHandle = {
  readonly sandboxId: string;
  exec(command: string[], params?: { workdir?: string; timeoutMs?: number }): Promise<SandboxProcess>;
  filesystem: { readText(path: string): Promise<string>; writeText(data: string, path: string): Promise<void> };
  terminate(): Promise<unknown>;
  snapshotFilesystem(params?: { timeoutMs?: number; ttlMs?: number | null }): Promise<{ imageId: string }>;
  tunnels(timeoutMs?: number): Promise<Record<number, { url: string }>>;
};

export type ListedSandbox = { sandboxId: string; tags: Record<string, string> };

export type SandboxSpec = {
  name: string;
  tags: Record<string, string>;
  imageId: string;
  /** Injected as environment variables through a Modal secret, so they never show in the sandbox's spec. */
  secrets: Record<string, string>;
  /** Named Modal secrets to attach as well, such as a repo's mf-repo-* secret; their values never pass through the runner. */
  namedSecrets?: string[];
  env: Record<string, string>;
  /** Ports Modal exposes through a TLS tunnel; anything listening there is reachable from the internet. */
  encryptedPorts: number[];
  limits: Pick<SandboxLimits, "appName" | "cpu" | "cpuLimit" | "memoryMiB" | "memoryLimitMiB" | "timeoutMs">;
};

export type ModalApi = {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  fromId(sandboxId: string): Promise<SandboxHandle>;
  /** The running sandboxes in the app that carry every one of these tags. */
  list(appName: string, tags: Record<string, string>): Promise<ListedSandbox[]>;
  deleteImage(imageId: string): Promise<void>;
};

let client: ModalClient | undefined;
const modalClient = () => {
  forbidInTest("Modal");
  return (client ??= new ModalClient());
};

export const realModal: ModalApi = {
  async create({ name, tags, imageId, secrets, namedSecrets = [], env, encryptedPorts, limits }) {
    const modal = modalClient();
    const app = await modal.apps.fromName(limits.appName, { createIfMissing: true });
    const image = await modal.images.fromId(imageId);
    return modal.sandboxes.create(app, image, {
      name,
      tags,
      cpu: limits.cpu,
      cpuLimit: limits.cpuLimit,
      memoryMiB: limits.memoryMiB,
      memoryLimitMiB: limits.memoryLimitMiB,
      timeoutMs: limits.timeoutMs,
      runtime: "gvisor",
      command: ["sleep", "infinity"],
      secrets: [
        ...(Object.keys(secrets).length > 0 ? [await modal.secrets.fromObject(secrets)] : []),
        ...(await Promise.all(namedSecrets.map((secret) => modal.secrets.fromName(secret)))),
      ],
      env,
      encryptedPorts,
    });
  },
  fromId: async (sandboxId) => modalClient().sandboxes.fromId(sandboxId),
  async list(appName, tags) {
    const modal = modalClient();
    let appId: string;
    try {
      appId = (await modal.apps.fromName(appName)).appId;
    } catch (error) {
      if (error instanceof NotFoundError) return [];
      throw error;
    }
    const listed: ListedSandbox[] = [];
    for await (const sandbox of modal.sandboxes.list({ appId, tags })) listed.push({ sandboxId: sandbox.sandboxId, tags: await sandbox.getTags() });
    return listed;
  },
  deleteImage: async (imageId) => modalClient().images.delete(imageId),
};

/** The Modal client the runner uses; regressions replace `api` and may shorten `createTimeoutMs`. */
export const modal: { api: ModalApi; createTimeoutMs: number } = { api: realModal, createTimeoutMs: 120_000 };

/**
 * Creates a sandbox, giving up after `modal.createTimeoutMs`: Modal's calls carry no deadline and its
 * create waits up to 21 minutes for scheduling, so a lost reply or a slept machine would hold the
 * runner's queue. A sandbox the abandoned create still returns is ended, since nothing records it.
 */
export async function createSandbox(spec: SandboxSpec) {
  const creating = modal.api.create(spec);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), modal.createTimeoutMs)));
  try {
    const sandbox = await Promise.race([creating, deadline]);
    if (sandbox !== "timeout") return sandbox;
  } finally {
    clearTimeout(timer);
  }
  void creating.then((sandbox) => sandbox.terminate()).catch(() => {});
  throw new Error(`Modal did not create sandbox ${spec.name} within ${modal.createTimeoutMs / 1000} s`);
}

/** Modal names allow [A-Za-z0-9-._] and at most 63 characters. */
/** Unique per create: a create that timed out still holds its name until Modal answers it, so a retry must not reuse it. */
export const sandboxName = (key: string, attempt: number, at = Date.now()) => {
  const suffix = `-${at.toString(36)}`;
  return `${`job-${key}-a${attempt}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 63 - suffix.length)}${suffix}`;
};

/** gRPC's NOT_FOUND, which an exec into a sandbox that shut down, or never existed, gets raw from the SDK. */
const GRPC_NOT_FOUND = 5;

const isGone = (error: unknown) =>
  error instanceof NotFoundError ||
  (error instanceof ConflictError && /already finished/.test(error.message)) ||
  (error instanceof Error && error.name === "ClientError" && (error as { code?: unknown }).code === GRPC_NOT_FOUND);

const gone = (sandboxId: string, error: unknown) =>
  isGone(error) ? new HostGoneError(`sandbox ${sandboxId} is gone: ${(error as Error).message}`) : error;

const handles = new Map<string, Promise<SandboxHandle>>();

/** Caches a handle the runner just created, so its first command needs no lookup. */
export const rememberSandbox = (sandbox: SandboxHandle) => void handles.set(sandbox.sandboxId, Promise.resolve(sandbox));

const handle = (sandboxId: string) => {
  let cached = handles.get(sandboxId);
  if (!cached) {
    cached = modal.api.fromId(sandboxId);
    handles.set(sandboxId, cached);
    cached.catch(() => handles.delete(sandboxId));
  }
  return cached;
};

/** Ends the sandbox and everything in it; one already gone counts as terminated. */
export async function terminateSandbox(sandboxId: string) {
  try {
    await (await handle(sandboxId)).terminate();
  } catch (error) {
    if (!isGone(error)) throw error;
  } finally {
    handles.delete(sandboxId);
  }
}

/** Snapshots the sandbox's filesystem to an image a new sandbox can start from; a sandbox already gone throws HostGoneError. */
export async function snapshotSandbox(sandboxId: string, ttlMs: number) {
  try {
    return (await (await handle(sandboxId)).snapshotFilesystem({ timeoutMs: 120_000, ttlMs })).imageId;
  } catch (error) {
    throw gone(sandboxId, error);
  }
}

export type Tunnel = { kind: "url"; url: string } | { kind: "no port" } | { kind: "not ready" };

/** The public https URL of the sandbox's tunnel to `port`; "no port" when it was created without one, "not ready" while Modal is still opening it. */
export async function tunnelUrl(sandboxId: string, port: number): Promise<Tunnel> {
  try {
    const url = (await (await handle(sandboxId)).tunnels(30_000))[port]?.url;
    return url ? { kind: "url", url } : { kind: "no port" };
  } catch (error) {
    if (error instanceof SandboxTimeoutError) return { kind: "not ready" };
    throw gone(sandboxId, error);
  }
}

/** Deletes a snapshot image; one already deleted or expired counts as deleted. */
export async function deleteSnapshot(imageId: string) {
  try {
    await modal.api.deleteImage(imageId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
}

/** Whether Modal no longer has the sandbox or image an error is about. */
export const isModalGone = isGone;

function execError(message: string, fields: Partial<ExecError>): ExecError {
  return Object.assign(new Error(message), fields);
}

/**
 * A JobHost whose commands run in a Modal sandbox. `run` settles like the local host: it resolves
 * on a zero exit and rejects with an ExecError carrying the exit code, the output, and `killed` on a
 * timeout. A sandbox that no longer exists rejects with HostGoneError.
 */
export function modalHost(sandboxId: string): JobHost {
  async function run(command: string, args: string[], { input, cwd, timeoutMs }: ExecOptions = {}) {
    const started = Date.now();
    let proc: SandboxProcess;
    try {
      const sandbox = await handle(sandboxId);
      proc = await sandbox.exec([command, ...args], { ...(cwd !== undefined && { workdir: cwd }), ...(timeoutMs !== undefined && { timeoutMs }) });
    } catch (error) {
      throw gone(sandboxId, error);
    }
    let stdinError: Error | undefined;
    // Closed even without input, so a command that reads stdin cannot hang on it.
    await (input === undefined ? Promise.resolve() : proc.stdin.writeText(input))
      .then(() => proc.stdin.close())
      .catch((error: unknown) => void (stdinError = error instanceof Error ? error : new Error(String(error))));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]);
    const deadline = new Promise<"timeout">((resolve) => {
      if (timeoutMs !== undefined) timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    let result: Awaited<typeof outcome> | "timeout";
    try {
      result = await Promise.race([outcome, deadline]);
    } catch (error) {
      if (isGone(error)) throw gone(sandboxId, error);
      // The exec's own deadline ends the stream with an error rather than an exit code.
      if (timeoutMs !== undefined && Date.now() - started >= timeoutMs) result = "timeout";
      else throw error;
    } finally {
      clearTimeout(timer);
    }
    const line = `${command} ${args.join(" ")}`;
    if (result === "timeout") {
      outcome.catch(() => {});
      throw execError(`Command timed out: ${line}`, { killed: true, code: undefined, stdout: "", stderr: "", ...(stdinError && { stdinError }) });
    }
    const [stdout, stderr, code] = result;
    if (code === 0) return { stdout, stderr };
    const killed = timeoutMs !== undefined && Date.now() - started >= timeoutMs;
    throw execError(`Command failed: ${line}\n${stderr}`, { code, stdout, stderr, killed, ...(stdinError && { stdinError }) });
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
    home: SANDBOX_HOME,
    run,
    async readFile(path) {
      try {
        return await (await handle(sandboxId)).filesystem.readText(path);
      } catch (error) {
        if (error instanceof SandboxFilesystemNotFoundError) return null;
        throw gone(sandboxId, error);
      }
    },
    async writeFile(path, text) {
      try {
        await (await handle(sandboxId)).filesystem.writeText(text, path);
        return;
      } catch (error) {
        if (isGone(error)) throw gone(sandboxId, error);
      }
      // Modal's writeText creates no directories; most writes land in one that exists, so mkdir only on a miss.
      await run("mkdir", ["-p", path.slice(0, path.lastIndexOf("/")) || "/"], { timeoutMs: 30_000 });
      try {
        await (await handle(sandboxId)).filesystem.writeText(text, path);
      } catch (error) {
        throw gone(sandboxId, error);
      }
    },
    exists: (path) => succeeds("test", ["-e", path]),
    list: async (dir) => (await run("ls", ["-1A", dir], { timeoutMs: 30_000 })).stdout.split("\n").filter(Boolean),
    mtimeMs: async (path) => Number((await run("stat", ["-c", "%Y", path], { timeoutMs: 30_000 })).stdout.trim()) * 1000,
    remove: async (path) => void (await run("rm", ["-rf", path], { timeoutMs: 60_000 })),
  };
}
