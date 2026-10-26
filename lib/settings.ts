import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import * as schema from "@/db/schema";
import { settings, type SettingsRow } from "@/db/schema";
import { isOwner, type SessionUser } from "@/lib/auth/owner";
import type { Harness } from "@/lib/harness";

// The panel's factory settings: which T3 provider instance and model new threads start on. The
// runner reads them on every launch pass and falls back to its config when none are saved.

export const SETTINGS_ID = "factory";

type Db = NodePgDatabase<typeof schema>;

export const settingsInputSchema = z.object({
  provider: z.string().trim().min(1, "Pick a harness."),
  model: z.string().trim().min(1, "Pick a model."),
});
export type SettingsInput = z.infer<typeof settingsInputSchema>;

export type HarnessChoice = { provider: string; model: string };
export type EffectiveHarness = HarnessChoice & { from: "settings" | "config" };

export async function readSettings(database: Db): Promise<SettingsRow | null> {
  const [row] = await database.select().from(settings).where(eq(settings.id, SETTINGS_ID));
  return row ?? null;
}

export async function writeSettings(database: Db, choice: HarnessChoice, by: string, at: Date) {
  const values = { provider: choice.provider, model: choice.model, updated_at: at, updated_by: by };
  await database
    .insert(settings)
    .values({ id: SETTINGS_ID, ...values })
    .onConflictDoUpdate({ target: settings.id, set: values });
}

export const resolveHarness = (saved: SettingsRow | null, fallback: HarnessChoice): EffectiveHarness =>
  saved ? { provider: saved.provider, model: saved.model, from: "settings" } : { provider: fallback.provider, model: fallback.model, from: "config" };

export type SettingsDeps = {
  user: () => Promise<SessionUser | null | undefined>;
  /** What the machines report; null when none has reported its harnesses yet. */
  harnesses: () => Promise<Harness[] | null>;
  save: (choice: HarnessChoice, by: string) => Promise<void>;
};

export type SettingsOutcome = { ok: true } | { ok: false; status: 400 | 403 | 502; message: string };

export async function saveSettings(deps: SettingsDeps, input: unknown): Promise<SettingsOutcome> {
  const user = await deps.user();
  if (!user || !isOwner(user)) return { ok: false, status: 403, message: "Only the factory owner can change settings." };
  const parsed = settingsInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, message: parsed.error.issues[0]?.message ?? "The settings are not valid." };
  const { provider, model } = parsed.data;
  const harnesses = await deps.harnesses();
  if (harnesses) {
    const harness = harnesses.find((h) => h.id === provider && h.enabled);
    if (!harness) return { ok: false, status: 400, message: `No machine reports an enabled harness ${provider}.` };
    if (!harness.models.some((m) => m.slug === model)) return { ok: false, status: 400, message: `${harness.name} has no model ${model}.` };
  }
  try {
    await deps.save({ provider, model }, user.email);
    return { ok: true };
  } catch (error) {
    return { ok: false, status: 502, message: `Could not save the settings: ${error instanceof Error ? error.message : String(error)}` };
  }
}
