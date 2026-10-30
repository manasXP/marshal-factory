import { z } from "zod";

/** Where a runner starts new factory threads: in its own T3, or in a Modal sandbox per job. */
export const EXECUTIONS = ["local", "modal"] as const;
export const executionSchema = z.enum(EXECUTIONS);
export type Execution = z.infer<typeof executionSchema>;

export const DEFAULT_EXECUTION: Execution = "local";

/** The executions that run each job in its own cloud sandbox, one per sandbox backend (runner/sandbox-backend.ts). */
export const CLOUD_EXECUTIONS = ["modal"] as const satisfies readonly Execution[];
export type CloudExecution = (typeof CLOUD_EXECUTIONS)[number];
export const isCloud = (execution: string | null | undefined): execution is CloudExecution =>
  (CLOUD_EXECUTIONS as readonly (string | null | undefined)[]).includes(execution);

/**
 * Where a claimed job's sandbox is: running while sandbox_id is set, hibernated while only its
 * snapshot is left, null for a job that never ran in one or gave it back.
 */
export type SandboxState = "running" | "hibernated";

export function sandboxState(job: { sandbox_id: string | null; sandbox_snapshot: string | null }): SandboxState | null {
  if (job.sandbox_id) return "running";
  return job.sandbox_snapshot ? "hibernated" : null;
}
