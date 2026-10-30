import { createHash } from "node:crypto";
import type { CloudExecution } from "../lib/execution";
import type { JobHost } from "../lib/host";
import { deleteSnapshot, isModalGone, modal, modalHost, sandboxName, snapshotSandbox, terminateSandbox, tunnelUrl, type ListedSandbox, type Tunnel } from "../lib/modal-host";
import { boxHandle, forgetBox, isUpstashGone, isUpstashId, realUpstash, rememberBox, upstash, upstashHost, upstashId } from "../lib/upstash-host";
import { inTestMode } from "../lib/test-mode";
import { config } from "./config";
import { thisMachine } from "./heartbeat";
import { createJobSandbox, sandboxSecrets } from "./sandbox";

/** What a job's sandbox is created from: the image, or its hibernation ref on a wake. */
export type JobSandboxSpec = Parameters<typeof createJobSandbox>[0];

/**
 * A cloud a job's sandbox runs in, as the job's lifecycle (runner/lifecycle.ts) and launch use it.
 * A hibernation ref is what `sandbox_snapshot` keeps while the job sleeps; how a backend makes one
 * and wakes from it is its own. Modal snapshots the filesystem into an image and starts a new
 * sandbox from it; Upstash pauses the box, which is then its own ref. Every way of ending a sandbox
 * says which ref it must keep, so the backend never ends a hibernated job's only state.
 */
export type SandboxBackend = {
  readonly kind: CloudExecution;
  /** Whether a sandbox id or hibernation ref is this backend's. */
  owns(id: string): boolean;
  host(sandboxId: string): JobHost;
  create(spec: JobSandboxSpec): Promise<{ sandboxId: string; host: JobHost }>;
  /**
   * Ends the sandbox; ending one already gone is not an error. When `keep` names the job's
   * hibernation ref and that ref is this sandbox, it is put to sleep instead of ended.
   */
  terminate(sandboxId: string, keep?: string | null): Promise<void>;
  /** The factory's sandboxes that still exist, asleep or not, with their tags; `status` is set where the backend reports one. */
  listRunning(): Promise<ListedSandbox[]>;
  /** Keeps a settled sandbox's state as a ref, for at least `ttlMs`; `terminate(sandboxId, ref)` then gives the sandbox up. */
  hibernate(sandboxId: string, ttlMs: number): Promise<string>;
  /** Wakes a hibernated job: a running sandbox from its ref, which the caller records before using it. */
  wake(ref: string, spec: Omit<JobSandboxSpec, "imageId">): Promise<{ sandboxId: string; host: JobHost }>;
  /** Called once a woken sandbox serves; whatever the ref held that the sandbox no longer needs goes. */
  afterWake(ref: string): Promise<void>;
  /** Gives up a ref for good, unless `holder`, a sandbox the job still holds, is that ref. */
  discard(ref: string, holder?: string | null): Promise<void>;
  /** Whether the backend ends a ref once its ttl passes; one that does not has the reap expire it. */
  readonly refsExpire: boolean;
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
  // A Modal ref is a filesystem image, never the sandbox, so there is nothing to keep running.
  terminate: (sandboxId) => terminateSandbox(sandboxId),
  listRunning: () => modal.api.list(config.factory.sandbox.appName, { label: config.factory.label }),
  hibernate: snapshotSandbox,
  wake: (ref, spec) => createJobSandbox({ ...spec, imageId: ref }),
  afterWake: deleteSnapshot,
  discard: (ref) => deleteSnapshot(ref),
  refsExpire: true,
  isGone: isModalGone,
  tunnel: tunnelUrl,
};

/** Upstash box labels hold at most 20 characters, so the machine is a short hash of its id. */
const machineLabel = (machineId: string) => `m:${createHash("sha256").update(machineId).digest("hex").slice(0, 12)}`;
const factoryLabel = () => `mf:${config.factory.label}`.slice(0, 20);
/** A deleted box is gone; every other status is a box that still exists and costs storage, asleep or not. */
const GONE_STATUS = "deleted";

/** Runs a step on a box, treating a box Upstash no longer has as done. */
async function onBox(id: string, step: (box: Awaited<ReturnType<typeof boxHandle>>) => Promise<unknown>) {
  try {
    await step(await boxHandle(id));
  } catch (error) {
    if (!isUpstashGone(error)) throw error;
  }
}

async function deleteBox(id: string) {
  try {
    await onBox(id, (box) => box.delete());
  } finally {
    forgetBox(id);
  }
}

/**
 * Upstash Box. A box pauses with its disk and processes intact and resumes as the same box, so a
 * hibernated job's ref is its box itself: hibernate keeps the id, terminating with that ref kept
 * pauses it, a wake resumes it. Repo secrets and warm repo images are Modal's only, for now.
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
  async terminate(sandboxId, keep) {
    if (keep === sandboxId) await onBox(sandboxId, (box) => box.pause());
    else await deleteBox(sandboxId);
  },
  async listRunning() {
    const machineId = (await thisMachine()).id;
    const me = machineLabel(machineId);
    return (await upstash.api.list(factoryLabel()))
      .filter((b) => b.status !== GONE_STATUS)
      .map((b) => {
        const label = b.labels.find((l) => l.startsWith("m:"));
        return { sandboxId: upstashId(b.id), tags: { status: b.status, ...(label && { machine: label === me ? machineId : label }) } };
      });
  },
  hibernate: async (sandboxId) => sandboxId,
  async wake(ref) {
    const box = await boxHandle(ref);
    await box.resume();
    rememberBox(box);
    return { sandboxId: ref, host: upstashHost(ref) };
  },
  afterWake: async () => {},
  async discard(ref, holder) {
    if (ref !== holder) await deleteBox(ref);
  },
  // A paused box lives until it is deleted.
  refsExpire: false,
  isGone: isUpstashGone,
  async tunnel(sandboxId, port) {
    return { kind: "url", url: (await (await boxHandle(sandboxId)).getPublicURL(port)).url };
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

/** The sandboxes every backend in use still has, for capacity and the reap. A backend this runner has no token for is skipped. */
export async function runningSandboxes(): Promise<ListedSandbox[]> {
  return (await Promise.all(BACKENDS.filter((b) => backendInUse(b.kind)).map((b) => b.listRunning()))).flat();
}

/** Whether a listed sandbox is asleep: paused by the factory's hibernate, or by Upstash's own idle pause. */
export const isAsleep = (listed: ListedSandbox) => listed.tags.status === "paused";

/**
 * Upstash is reached only with its key; Modal keeps its old behaviour of always being listed. In a
 * regression run only a test that fakes Upstash reaches it, whatever key the environment holds.
 */
export const backendInUse = (kind: CloudExecution) =>
  kind !== "upstash" || upstash.api !== realUpstash || (Boolean(process.env.UPSTASH_BOX_API_KEY) && !inTestMode());
