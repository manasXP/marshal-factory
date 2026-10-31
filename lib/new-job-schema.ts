import { z } from "zod";
import { executionSchema } from "./execution";

// Shared by the new-job form and the server action; kept apart from lib/new-job.ts so the form
// does not bundle the Linear client.

/** The sources the panel can file a job in; Linear when the form names none. */
export const FILING_SOURCES = ["linear", "github"] as const;
export const filingSourceSchema = z.enum(FILING_SOURCES);
export type FilingSource = z.infer<typeof filingSourceSchema>;
export const FILING_SOURCE_LABELS: Record<FilingSource, string> = { linear: "Linear", github: "GitHub Issues" };

export const newJobSchema = z.object({
  title: z.string().trim().min(3, "Give the job a title of at least 3 characters.").max(200, "Keep the title under 200 characters."),
  description: z.string().trim().max(10_000, "Keep the description under 10,000 characters."),
  /** Chosen when the form opens, so a double submit or a retried request creates one issue. */
  requestId: z.uuid(),
  /** A harness's provider instance id; unset files the issue without a Harness label, so Settings decide. */
  provider: z.string().trim().min(1).optional(),
  /** Unset files the issue without a Runs on label. */
  execution: executionSchema.optional(),
  /** The repo's full name; unset means the default repo. Either way the issue gets its Repository label. */
  repo: z.string().trim().min(1).optional(),
  /** Unset files in Linear. */
  source: filingSourceSchema.optional(),
});
export type NewJob = z.infer<typeof newJobSchema>;

export type NewJobOutcome =
  | { ok: true; identifier: string; url: string; source: FilingSource }
  | { ok: false; status: 400 | 403 | 502; message: string };

/** Images a job can carry. Vercel takes at most 4.5 MB per request, so one upload stays under it. */
export const JOB_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const MAX_JOB_IMAGE_BYTES = 4 * 1024 * 1024;

export type ImageUploadOutcome = { ok: true; markdown: string } | { ok: false; status: 400 | 403 | 413 | 502; message: string };
