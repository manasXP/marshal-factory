import type { CloudExecution } from "../lib/execution";
import type { JobHost } from "../lib/host";
import { deleteSnapshot, isModalGone, modal, modalHost, snapshotSandbox, terminateSandbox, tunnelUrl, type ListedSandbox, type Tunnel } from "../lib/modal-host";
import { config } from "./config";
import { createJobSandbox } from "./sandbox";

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
  // The first backend: ids from before any other existed carry no mark of their own.
  owns: () => true,
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

const BACKENDS: readonly SandboxBackend[] = [modalBackend];

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

/** The ids every backend still runs, for capacity and the reap. */
export async function runningSandboxes(): Promise<ListedSandbox[]> {
  return (await Promise.all(BACKENDS.map((b) => b.listRunning()))).flat();
}
