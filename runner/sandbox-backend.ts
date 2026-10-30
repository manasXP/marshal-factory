import { createHash } from "node:crypto";
import type { CloudExecution } from "../lib/execution";
import type { JobHost } from "../lib/host";
import { deleteSnapshot, isModalGone, modal, modalHost, sandboxName, snapshotSandbox, terminateSandbox, tunnelUrl, type ListedSandbox, type Tunnel } from "../lib/modal-host";
import { boxIdOf, forgetBox, isUpstashGone, isUpstashId, realUpstash, rememberBox, upstash, upstashHost, upstashId } from "../lib/upstash-host";
import { config } from "./config";
import { thisMachine } from "./heartbeat";
import { createJobSandbox, sandboxSecrets } from "./sandbox";

/** What a job's sandbox is created from: the image, or its hibernation ref on a wake. */
export type JobSandboxSpec = Parameters<typeof createJobSandbox>[0];

/**
 * A cloud a job's sandbox runs in, as the job's lifecycle (runner/lifecycle.ts) and launch use it.
 * A hibernation ref is what `sandbox_snapshot` keeps while the job sleeps; how a backend makes one
 * and wakes from it is its own (Modal snapshots the filesystem and starts a new sandbox from it).
 */
export type SandboxBackend = {
  readonly kind: CloudExecution;
  /** Whether a sandbox id or hibernation ref is this backend's. */
  owns(id: string): boolean;
  host(sandboxId: string): JobHost;
  create(spec: JobSandboxSpec): Promise<{ sandboxId: string; host: JobHost }>;
  /** Ends the sandbox; ending one already gone is not an error. */
  terminate(sandboxId: string): Promise<void>;
  /** The sandboxes of the factory's label that still run, with their tags. */
  listRunning(): Promise<ListedSandbox[]>;
  /** Keeps a settled sandbox's state as a ref, for at least `ttlMs`; the sandbox still runs until `release`. */
  hibernate(sandboxId: string, ttlMs: number): Promise<string>;
  /** Gives up the running sandbox once its ref is recorded. */
  release(sandboxId: string): Promise<void>;
  /** Wakes a hibernated job: a running sandbox from its ref, which the caller records before using it. */
  wake(ref: string, spec: Omit<JobSandboxSpec, "imageId">): Promise<{ sandboxId: string; host: JobHost }>;
  /** Called once a woken sandbox serves; whatever the ref held that the sandbox no longer needs goes. */
  afterWake(ref: string): Promise<void>;
  /** Gives up a ref for good. */
  discard(ref: string): Promise<void>;
  /** Whether an error from this backend means the sandbox or ref no longer exists. */
  isGone(error: unknown): boolean;
  tunnel(sandboxId: string, port: number): Promise<Tunnel>;
};

export const modalBackend: SandboxBackend = {
  kind: "modal",
  // Ids from before any other backend existed carry no mark of their own.
  owns: (id) => !isUpstashId(id),
  host: modalHost,
  create: (spec) => createJobSandbox(spec),
  terminate: terminateSandbox,
  listRunning: () => modal.api.list(config.factory.sandbox.appName, { label: config.factory.label }),
  hibernate: snapshotSandbox,
  release: terminateSandbox,
  wake: (ref, spec) => createJobSandbox({ ...spec, imageId: ref }),
  afterWake: deleteSnapshot,
  discard: deleteSnapshot,
  isGone: isModalGone,
  tunnel: tunnelUrl,
};

/** Upstash box labels hold at most 20 characters, so the machine is a short hash of its id. */
const machineLabel = (machineId: string) => `m:${createHash("sha256").update(machineId).digest("hex").slice(0, 12)}`;
const factoryLabel = () => `mf:${config.factory.label}`.slice(0, 20);
/** Boxes stop only on a delete; the paused ones are hibernated jobs, which listRunning leaves out. */
const LIVE_STATUSES = new Set(["creating", "idle", "running"]);

async function deleteBox(id: string) {
  try {
    await (await upstash.api.get(boxIdOf(id))).delete();
  } catch (error) {
    if (!isUpstashGone(error)) throw error;
  } finally {
    forgetBox(id);
  }
}

/**
 * Upstash Box. A box pauses with its disk and processes intact and resumes as the same box, so a
 * hibernated job's ref is its box itself: hibernate keeps the id, release pauses it, wake resumes
 * it. Repo secrets and warm repo images are Modal's only, for now.
 */
export const upstashBackend: SandboxBackend = {
  kind: "upstash",
  owns: isUpstashId,
  host: upstashHost,
  async create({ key, attempt, machineId, imageId, claudeToken, namedSecrets = [] }) {
    if (namedSecrets.length > 0) throw new Error("repo secrets are not supported on Upstash Box yet; run this repo on Modal");
    const box = await upstash.api.create({
      snapshotId: imageId,
      name: sandboxName(key, attempt),
      labels: [factoryLabel(), machineLabel(machineId)],
      // Claude Code refuses full access as root unless told it is in a sandbox; a box runs as boxuser, but the image is shared.
      env: { IS_SANDBOX: "1", ...sandboxSecrets(claudeToken) },
      size: config.factory.upstash.size,
    });
    rememberBox(box);
    return { sandboxId: upstashId(box.id), host: upstashHost(upstashId(box.id)) };
  },
  terminate: deleteBox,
  async listRunning() {
    const machineId = (await thisMachine()).id;
    const me = machineLabel(machineId);
    return (await upstash.api.list(factoryLabel()))
      .filter((b) => LIVE_STATUSES.has(b.status))
      .map((b) => {
        const label = b.labels.find((l) => l.startsWith("m:"));
        return { sandboxId: upstashId(b.id), tags: { ...(label && { machine: label === me ? machineId : label }) } };
      });
  },
  hibernate: async (sandboxId) => sandboxId,
  async release(sandboxId) {
    try {
      await (await upstash.api.get(boxIdOf(sandboxId))).pause();
    } catch (error) {
      if (!isUpstashGone(error)) throw error;
    }
  },
  async wake(ref) {
    const box = await upstash.api.get(boxIdOf(ref));
    await box.resume();
    rememberBox(box);
    return { sandboxId: ref, host: upstashHost(ref) };
  },
  afterWake: async () => {},
  discard: deleteBox,
  isGone: isUpstashGone,
  async tunnel(sandboxId, port) {
    return { kind: "url", url: (await (await upstash.api.get(boxIdOf(sandboxId))).getPublicURL(port)).url };
  },
};

// Modal is last: it owns every id without another backend's mark, as all ids were before.
const BACKENDS: readonly SandboxBackend[] = [upstashBackend, modalBackend];

/** The backend that owns a sandbox id or a hibernation ref. */
export function backendOf(id: string): SandboxBackend {
  const backend = BACKENDS.find((b) => b.owns(id));
  if (!backend) throw new Error(`no sandbox backend owns ${id}`);
  return backend;
}

export function backendFor(execution: CloudExecution): SandboxBackend {
  const backend = BACKENDS.find((b) => b.kind === execution);
  if (!backend) throw new Error(`no sandbox backend for ${execution}`);
  return backend;
}

/** The ids every backend in use still runs, for capacity and the reap. A backend this runner has no token for is skipped. */
export async function runningSandboxes(): Promise<ListedSandbox[]> {
  return (await Promise.all(BACKENDS.filter((b) => backendInUse(b.kind)).map((b) => b.listRunning()))).flat();
}

/** Upstash is reached only with its key; Modal keeps its old behaviour of always being listed. */
export const backendInUse = (kind: CloudExecution) => kind !== "upstash" || Boolean(process.env.UPSTASH_BOX_API_KEY) || upstash.api !== realUpstash;
