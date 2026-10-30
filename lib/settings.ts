import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import * as schema from "@/db/schema";
import { repoSettings, settings, type RepoSettingsRow, type SettingsRow } from "@/db/schema";
import { isOwner, type SessionUser } from "@/lib/auth/owner";
import { DEFAULT_EXECUTION, executionSchema, type Execution } from "@/lib/execution";
import type { Harness } from "@/lib/harness";
import { autonomySchema, DEFAULT_POLICY, type Autonomy, type RepoPolicy } from "@/lib/merge-decision";
import { DEFAULT_SPEND_LIMIT_USD } from "@/lib/spend-limit";

// The panel's factory settings: which T3 provider instance and model new threads start on, and
// where. The runner reads them on every launch pass and falls back to its config when none are saved.
// Per repo, how far the factory may merge on its own; see lib/merge-decision.ts.

export const SETTINGS_ID = "factory";

type Db = NodePgDatabase<typeof schema>;

export const settingsInputSchema = z.object({
  provider: z.string().trim().min(1, "Pick a harness."),
  model: z.string().trim().min(1, "Pick a model."),
  execution: executionSchema.default(DEFAULT_EXECUTION),
  spendLimitUsd: z.coerce.number({ message: "Enter a spend limit in dollars." }).positive("The spend limit must be more than $0.").max(1000, "The spend limit can be at most $1,000.").default(DEFAULT_SPEND_LIMIT_USD),
});
export type SettingsInput = z.input<typeof settingsInputSchema>;

export type HarnessChoice = { provider: string; model: string };
/** Where the harness came from: the panel's Settings, the runner config, or the job's repo default. */
export type EffectiveHarness = HarnessChoice & { from: "settings" | "config" | "repo" };
export type SettingsChoice = HarnessChoice & { execution?: Execution; spendLimitUsd?: number };

export async function readSettings(database: Db): Promise<SettingsRow | null> {
  const [row] = await database.select().from(settings).where(eq(settings.id, SETTINGS_ID));
  return row ?? null;
}

export async function writeSettings(database: Db, choice: SettingsChoice, by: string, at: Date) {
  const values = {
    provider: choice.provider,
    model: choice.model,
    ...(choice.execution && { execution: choice.execution }),
    ...(choice.spendLimitUsd !== undefined && { spend_limit_usd: choice.spendLimitUsd }),
    updated_at: at,
    updated_by: by,
  };
  await database
    .insert(settings)
    .values({ id: SETTINGS_ID, ...values })
    .onConflictDoUpdate({ target: settings.id, set: values });
}

export const resolveHarness = (saved: SettingsRow | null, fallback: HarnessChoice): EffectiveHarness =>
  saved ? { provider: saved.provider, model: saved.model, from: "settings" } : { provider: fallback.provider, model: fallback.model, from: "config" };

export const resolveExecution = (saved: SettingsRow | null): Execution => saved?.execution ?? DEFAULT_EXECUTION;

export type SettingsDeps = {
  user: () => Promise<SessionUser | null | undefined>;
  /** What the machines report; null when none has reported its harnesses yet. */
  harnesses: () => Promise<Harness[] | null>;
  save: (choice: Required<SettingsChoice>, by: string) => Promise<void>;
};

export type SettingsOutcome = { ok: true } | { ok: false; status: 400 | 403 | 502; message: string };

export const readRepoSettings = (database: Db): Promise<RepoSettingsRow[]> => database.select().from(repoSettings);

/** The repo's merge policy: its saved row over the defaults. */
export function resolvePolicy(rows: readonly RepoSettingsRow[], repo: string): RepoPolicy {
  const row = rows.find((r) => r.repo === repo);
  if (!row) return DEFAULT_POLICY;
  return {
    autonomy: autonomySchema.catch("off").parse(row.autonomy),
    requireBugbot: row.require_bugbot,
  };
}

/** Sets a repo's autonomy, adding its row if it has none; the panel edits it with the rest of the repo in lib/repositories.ts. */
export async function writeRepoAutonomy(database: Db, { repo, autonomy }: { repo: string; autonomy: Autonomy }, by: string, at: Date) {
  await database
    .insert(repoSettings)
    .values({ repo, autonomy, updated_at: at, updated_by: by })
    .onConflictDoUpdate({ target: repoSettings.repo, set: { autonomy, updated_at: at, updated_by: by } });
}

export async function saveSettings(deps: SettingsDeps, input: unknown): Promise<SettingsOutcome> {
  const user = await deps.user();
  if (!user || !isOwner(user)) return { ok: false, status: 403, message: "Only the factory owner can change settings." };
  const parsed = settingsInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, message: parsed.error.issues[0]?.message ?? "The settings are not valid." };
  const { provider, model, execution, spendLimitUsd } = parsed.data;
  const harnesses = await deps.harnesses();
  if (harnesses) {
    const harness = harnesses.find((h) => h.id === provider && h.enabled);
    if (!harness) return { ok: false, status: 400, message: `No machine reports an enabled harness ${provider}.` };
    if (!harness.models.some((m) => m.slug === model)) return { ok: false, status: 400, message: `${harness.name} has no model ${model}.` };
  }
  try {
    await deps.save({ provider, model, execution, spendLimitUsd }, user.email);
    return { ok: true };
  } catch (error) {
    return { ok: false, status: 502, message: `Could not save the settings: ${error instanceof Error ? error.message : String(error)}` };
  }
}
