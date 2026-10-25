import { isOwner, type SessionUser } from "@/lib/auth/owner";
import { JOB_IMAGE_TYPES, MAX_JOB_IMAGE_BYTES, newJobSchema, type ImageUploadOutcome, type NewJobOutcome } from "@/lib/new-job-schema";
import type { FileDraft, FiledJob, ImageFile } from "@/lib/sources/types";

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
