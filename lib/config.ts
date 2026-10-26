import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./harness";
import { inTestMode } from "./test-mode";

export const CONFIG_PATH = process.env.MARSHAL_FACTORY_CONFIG ?? join(homedir(), ".config/marshal-factory/config.json");

/** The machine a regression run's runner code acts as, so the jobs a script creates can belong to it. */
export const TEST_MACHINE_ID = "test-machine";

export const GITHUB_APP_PATH = process.env.MARSHAL_FACTORY_GITHUB_APP ?? join(homedir(), ".config/marshal-factory/github-app.json");

/** Every factory limit lives here, with defaults; the config file overrides any of them. */
export const factorySchema = z
  .object({
    teamKey: z.string().default("FAC"),
    label: z.string().default("factory"),
    maxInFlight: z.number().int().positive().default(2),
    /** A working job with no event for this long, or whose thread stopped, gets one nudge. */
    stuckAfterMinutes: z.number().positive().default(30),
    /** A stopped thread counts as stuck only after this much quiet, so a turn that just ended isn't. */
    stoppedGraceMinutes: z.number().nonnegative().default(2),
    /** After a nudge, this much more quiet marks the job failed. */
    failAfterNudgeMinutes: z.number().positive().default(30),
    /** USD one attempt at a job may spend across its runs, main sessions plus subagents; claims copy it onto the job. */
    budgetUsd: z.number().positive().default(5),
    /** Days a failed job keeps its worktree for a human to look at before cleanup removes it. */
    cleanupGraceDays: z.number().nonnegative().default(3),
    /** Hours a Claude Code subagent worktree must sit untouched before cleanup considers it. */
    subagentIdleHours: z.number().nonnegative().default(6),
    /** Target repos the factory works in; the installer adds each one. */
    repos: z.array(z.string()).default([]),
    /** The provider and model for new factory threads when the panel's settings hold none. */
    provider: z.string().default(DEFAULT_PROVIDER),
    model: z.string().default(DEFAULT_MODEL),
    /** How often the runner's timer runs the watchdog, the cost-cap backstop and usage reconcile. */
    tickSeconds: z.number().positive().default(90),
    /** Overrides this Mac's IOPlatformUUID as its id in the machines table, so test runners keep their own row. */
    machineId: z.string().min(1).optional(),
    /** T3's state database, read-only, for the machine inventory. */
    t3StatePath: z.string().optional(),
    /** How often the runner re-collects the slow machine inventory (T3, Connect, projects, repos). */
    inventoryMinutes: z.number().positive().default(10),
    /** Ids of the webhooks scripts/install-webhooks.ts created. It records `linear`; GitHub deliveries come from the GitHub App. */
    webhooks: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  })
  .prefault({});
export type FactoryLimits = z.infer<typeof factorySchema>;

const configSchema = z.object({
  linearApiKey: z.string().min(1),
  ingestUrl: z.url(),
  secret: z.string().min(1),
  factory: factorySchema,
});
export type FactoryConfig = z.infer<typeof configSchema>;

/** Just the limits, for readers that hold no secrets, such as the budget hook. */
export function loadLimits(): FactoryLimits {
  const raw = existsSync(/* turbopackIgnore: true */ CONFIG_PATH) ? JSON.parse(readFileSync(/* turbopackIgnore: true */ CONFIG_PATH, "utf8")).factory : undefined;
  return factorySchema.parse(raw ?? {});
}

export function loadConfig(): FactoryConfig {
  if (inTestMode()) {
    return configSchema.parse({
      linearApiKey: "test-only",
      ingestUrl: "https://ingest.invalid/ingest",
      secret: "test-only",
      factory: { machineId: TEST_MACHINE_ID },
    });
  }
  return configSchema.parse(JSON.parse(readFileSync(/* turbopackIgnore: true */ CONFIG_PATH, "utf8")));
}
