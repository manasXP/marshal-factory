import { isOwner, type SessionUser } from "@/lib/auth/owner";
import { newJobSchema, type NewJobOutcome } from "@/lib/new-job-schema";
import type { FileDraft, FiledJob } from "@/lib/sources/types";

// A job started from the panel is filed in its source like any other: for Linear, a Todo issue with
// the factory label that the webhook brings to the runner. Questions, stops and write-back then
// work as they do for an issue filed by hand.

export type NewJobDeps = {
  user: () => Promise<SessionUser | null | undefined>;
  file: (draft: FileDraft) => Promise<FiledJob>;
};

export async function createJob(deps: NewJobDeps, input: unknown): Promise<NewJobOutcome> {
  if (!isOwner(await deps.user())) return { ok: false, status: 403, message: "Only the factory owner can start jobs." };
  const parsed = newJobSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, message: parsed.error.issues[0]?.message ?? "The job is not valid." };
  try {
    const filed = await deps.file(parsed.data);
    return { ok: true, identifier: filed.key, url: filed.url };
  } catch (error) {
    return { ok: false, status: 502, message: `Could not file the job: ${error instanceof Error ? error.message : String(error)}` };
  }
}
