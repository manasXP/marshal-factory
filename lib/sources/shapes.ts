import { z } from "zod";

export type SourceShape = { label: string; writeback: z.ZodType; sourceState: z.ZodType };

const labelGroupSchema = z.object({ name: z.string(), group: z.string() });

const linear = {
  label: "Linear",
  writeback: z.object({ kind: z.literal("linear"), issueId: z.string().min(1) }),
  sourceState: z.object({
    state: z.string().nullable(),
    labels: z.array(z.string()),
    /** The labels that sit in a Linear label group, with the group's name; rows stored before groups were read have none. */
    labelGroups: z.array(labelGroupSchema).default([]),
    /** Every comment the factory posted on the issue; anything else on it is a human. */
    factoryCommentIds: z.array(z.string()).default([]),
  }),
};

const github = {
  label: "GitHub",
  writeback: z.object({ kind: z.literal("github"), repo: z.custom<`${string}/${string}`>((v) => typeof v === "string" && /^[^/\s]+\/[^/\s]+$/.test(v)), number: z.number().int().positive() }),
  sourceState: z.object({
    /** owner/name of the repo the issue lives in; the job always runs there. */
    repo: z.string(),
    labels: z.array(z.string()),
    /** The attempt the claim comment was posted for; a claim draft never carries it, so a reclaim announces again. */
    announcedAttempt: z.number().int().default(0),
  }),
};

const SHIPPED = { linear, github } satisfies Record<string, SourceShape>;

/** The sources the factory ships. Regressions register a fake one beside them (registerSource in ./index). */
export type JobSource = keyof typeof SHIPPED;

export const SOURCE_SHAPES: { [S in JobSource]: (typeof SHIPPED)[S] } = SHIPPED;

export const isRegisteredSource = (name: string): name is JobSource => Object.hasOwn(SOURCE_SHAPES, name);

export type WritebackOf<S extends JobSource> = z.infer<(typeof SOURCE_SHAPES)[S]["writeback"]>;
export type SourceStateOf<S extends JobSource> = z.output<(typeof SOURCE_SHAPES)[S]["sourceState"]>;
export type SourceStateDraftOf<S extends JobSource> = z.input<(typeof SOURCE_SHAPES)[S]["sourceState"]>;

export type JobId<S extends JobSource = JobSource> = `${S}:${string}`;

export const jobId = <S extends JobSource>(source: S, externalId: string): JobId<S> => `${source}:${externalId}`;

export function parseJobId(value: string): { id: JobId; source: JobSource; externalId: string } {
  const colon = value.indexOf(":");
  const source = value.slice(0, colon);
  if (colon < 1 || !isRegisteredSource(source)) throw new Error(`not a job id: ${value}`);
  return { id: value as JobId, source, externalId: value.slice(colon + 1) };
}

export const sourceLink = (job: { source: JobSource; url: string }) => ({ label: SOURCE_SHAPES[job.source].label, href: job.url });
