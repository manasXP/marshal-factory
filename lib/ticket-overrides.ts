import { z } from "zod";
import { EXECUTIONS, executionSchema, type Execution } from "./execution";
import type { Harness } from "./harness";

// A ticket can pick its lead harness, where it runs and its repository. Each source reads these
// from its own representation (Linear: a child label of the Harness, Runs on and Repository label
// groups) into SourceOverrides; everything below works on that and never sees a source.

export const OVERRIDE_GROUPS = { harness: "Harness", runsOn: "Runs on", repository: "Repository" } as const;
export const HARNESS_GROUP = OVERRIDE_GROUPS.harness;
export const RUNS_ON_GROUP = OVERRIDE_GROUPS.runsOn;
export const RUNS_ON_LABELS: Record<Execution, string> = { local: "Local", modal: "Cloud", upstash: "Upstash" };
/** Older Runs on label names tickets may still carry. */
const RUNS_ON_ALIASES: Record<Execution, readonly string[]> = { local: [], modal: ["Modal"], upstash: ["Upstash Box"] };

/** What a ticket asks for, field by field, by the names it shows; more than one value in a field is a conflict. */
export type SourceOverrides = { [F in keyof typeof OVERRIDE_GROUPS]: string[] };
export const NO_OVERRIDES: SourceOverrides = { harness: [], runsOn: [], repository: [] };

export type TicketOverrides = { provider?: string; execution?: Execution; problems: string[] };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const quoted = (names: readonly string[]) => names.map((name) => `"${name}"`).join(", ");

/** What the ticket asks for, by harness and place name; a value that cannot apply is a problem and falls back to Settings. */
export function ticketOverrides(asked: SourceOverrides, harnesses: readonly Harness[] | null): TicketOverrides {
  const problems: string[] = [];
  const result: TicketOverrides = { problems };

  const harnessLabels = asked.harness;
  if (harnessLabels.length > 1) {
    problems.push(`The issue has more than one ${HARNESS_GROUP} label (${quoted(harnessLabels)}), so it runs on the Settings harness.`);
  } else if (harnessLabels.length === 1) {
    const name = harnessLabels[0]!;
    const matches = (harnesses ?? []).filter((h) => same(h.name, name));
    const enabled = matches.find((h) => h.enabled);
    if (enabled) result.provider = enabled.id;
    else if (matches.length > 0) problems.push(`The ${HARNESS_GROUP} label "${name}" names a harness that is disabled in T3, so it runs on the Settings harness.`);
    else problems.push(`The ${HARNESS_GROUP} label "${name}" matches no harness a runner reports, so it runs on the Settings harness.`);
  }

  const runsOnLabels = asked.runsOn;
  if (runsOnLabels.length > 1) {
    problems.push(`The issue has more than one ${RUNS_ON_GROUP} label (${quoted(runsOnLabels)}), so it runs where Settings say.`);
  } else if (runsOnLabels.length === 1) {
    const name = runsOnLabels[0]!;
    const execution = EXECUTIONS.find((e) => [RUNS_ON_LABELS[e], ...RUNS_ON_ALIASES[e]].some((label) => same(label, name)));
    if (execution) result.execution = execution;
    else problems.push(`The ${RUNS_ON_GROUP} label "${name}" is neither ${Object.values(RUNS_ON_LABELS).join(" nor ")}, so it runs where Settings say.`);
  }
  return result;
}

/** The child labels each group should have: one per enabled harness, by display name, and one per execution. */
export function desiredLabelGroups(harnesses: readonly Harness[]) {
  const names: string[] = [];
  for (const h of harnesses) if (h.enabled && !names.some((n) => same(n, h.name))) names.push(h.name);
  return [
    { group: HARNESS_GROUP, children: names },
    { group: RUNS_ON_GROUP, children: EXECUTIONS.map((e) => RUNS_ON_LABELS[e]) },
  ];
}

/** What a job records about its ticket's overrides: what applied, and each fallback the runner took instead. */
export const ticketRecordSchema = z.object({
  provider: z.string().optional(),
  execution: executionSchema.optional(),
  notes: z.array(z.string()),
});
export type TicketRecord = z.infer<typeof ticketRecordSchema>;
