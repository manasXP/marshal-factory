import { z } from "zod";

// Shared by the new-job form and the server action; kept apart from lib/new-job.ts so the form
// does not bundle the Linear client.

export const newJobSchema = z.object({
  title: z.string().trim().min(3, "Give the job a title of at least 3 characters.").max(200, "Keep the title under 200 characters."),
  description: z.string().trim().max(10_000, "Keep the description under 10,000 characters."),
  /** Chosen when the form opens, so a double submit or a retried request creates one issue. */
  requestId: z.uuid(),
});
export type NewJob = z.infer<typeof newJobSchema>;

export type NewJobOutcome =
  | { ok: true; identifier: string; url: string }
  | { ok: false; status: 400 | 403 | 502; message: string };

/** Images a job can carry. Vercel takes at most 4.5 MB per request, so one upload stays under it. */
export const JOB_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const MAX_JOB_IMAGE_BYTES = 4 * 1024 * 1024;

export type ImageUploadOutcome = { ok: true; markdown: string } | { ok: false; status: 400 | 403 | 413 | 502; message: string };
