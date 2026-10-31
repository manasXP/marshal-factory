import { isOwner, type SessionUser } from "@/lib/auth/owner";
import type { Harness } from "@/lib/harness";
import { FILING_SOURCE_LABELS, JOB_IMAGE_TYPES, MAX_JOB_IMAGE_BYTES, newJobSchema, type FilingSource, type ImageUploadOutcome, type NewJobOutcome } from "@/lib/new-job-schema";
import type { FileDraft, FiledJob, ImageFile } from "@/lib/sources/types";
import { defaultRepo, repoLabel, REPOSITORY_GROUP, type Registry } from "@/lib/repositories";
import { HARNESS_GROUP, RUNS_ON_GROUP, RUNS_ON_LABELS } from "@/lib/ticket-overrides";

// A job started from the panel is filed in its source like any other: for Linear, a Todo issue with
// the factory label that the webhook brings to the runner. Questions, stops and write-back then
// work as they do for an issue filed by hand. A harness or execution chosen in the form goes on the
// issue as the same override label a person would add, and so does the repo, default or not. GitHub
// files the issue in the repo itself instead.

const LINEAR_UPLOADS = "https://uploads.linear.app/";

export type NewJobDeps = {
  user: () => Promise<SessionUser | null | undefined>;
  file: (draft: FileDraft, source: FilingSource) => Promise<FiledJob>;
  /** What the machines report; null when none has reported its harnesses yet. */
  harnesses: () => Promise<Harness[] | null>;
  registry: () => Promise<Registry>;
  /** Records the owner who filed the job, since the source names the factory's own account (lib/requester.ts). */
  recordFiling: (key: string, email: string) => Promise<void>;
};

export async function createJob(deps: NewJobDeps, input: unknown): Promise<NewJobOutcome> {
  const user = await deps.user();
  if (!isOwner(user)) return { ok: false, status: 403, message: "Only the factory owner can start jobs." };
  const parsed = newJobSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, message: parsed.error.issues[0]?.message ?? "The job is not valid." };
  const { provider, execution, repo, source = "linear", ...draft } = parsed.data;
  const labels: NonNullable<FileDraft["labels"]> = [];
  const registry = await deps.registry();
  const target = repo ? registry.find((r) => r.repo === repo) : defaultRepo(registry);
  if (repo && !target?.enabled) return { ok: false, status: 400, message: `${repo} is not an enabled repository.` };
  if (source === "github" && !target) return { ok: false, status: 400, message: "Pick the repository to file the GitHub issue in." };
  // Linear's uploads need a Linear login, so neither GitHub's readers nor the agent could open them.
  if (source === "github" && draft.description.includes(LINEAR_UPLOADS)) {
    return { ok: false, status: 400, message: "Images uploaded to Linear can't go on a GitHub issue; remove them or file in Linear." };
  }
  if (target) labels.push({ group: REPOSITORY_GROUP, name: repoLabel(registry, target) });
  if (provider) {
    const harness = (await deps.harnesses())?.find((h) => h.id === provider && h.enabled);
    if (!harness) return { ok: false, status: 400, message: `No machine reports an enabled harness ${provider}.` };
    labels.push({ group: HARNESS_GROUP, name: harness.name });
  }
  if (execution) labels.push({ group: RUNS_ON_GROUP, name: RUNS_ON_LABELS[execution] });
  let filed: FiledJob;
  try {
    filed = await deps.file({ ...draft, ...(target && { repo: target.repo }), ...(labels.length > 0 && { labels }) }, source);
  } catch (error) {
    return { ok: false, status: 502, message: `Could not file the job in ${FILING_SOURCE_LABELS[source]}: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    await deps.recordFiling(filed.key, user!.email);
  } catch (error) {
    // The request id keys the issue, so submitting again finds it and records the filer once more.
    return { ok: false, status: 502, message: `Filed ${filed.key}, but could not record that you filed it: ${error instanceof Error ? error.message : String(error)}. Submit again to retry.` };
  }
  return { ok: true, identifier: filed.key, url: filed.url, source };
}

export type ImageUploadDeps = {
  user: () => Promise<SessionUser | null | undefined>;
  upload: (image: ImageFile) => Promise<string>;
};

/** Stores an image for a job the owner is about to file; the form puts the returned markdown in the description. */
export async function uploadJobImage(deps: ImageUploadDeps, file: File | null): Promise<ImageUploadOutcome> {
  if (!isOwner(await deps.user())) return { ok: false, status: 403, message: "Only the factory owner can add images." };
  if (!file) return { ok: false, status: 400, message: "No image was sent." };
  if (!(JOB_IMAGE_TYPES as readonly string[]).includes(file.type)) return { ok: false, status: 400, message: `${file.name} is not a PNG, JPEG, WebP or GIF image.` };
  if (file.size > MAX_JOB_IMAGE_BYTES) return { ok: false, status: 413, message: `${file.name} is larger than 4 MB.` };
  try {
    const markdown = await deps.upload({ filename: file.name, contentType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
    return { ok: true, markdown };
  } catch (error) {
    return { ok: false, status: 502, message: `Could not upload ${file.name}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
