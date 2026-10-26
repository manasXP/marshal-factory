import { z } from "zod";

// A harness is one T3 provider instance: the agent CLI a factory thread runs on, and the models it offers.

export const DEFAULT_PROVIDER = "claudeAgent";
export const DEFAULT_MODEL = "claude-opus-5-5";

export const harnessSchema = z.object({
  /** The provider instance id, which `t3 thread start --provider` takes. */
  id: z.string(),
  driver: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  models: z.array(z.object({ slug: z.string(), name: z.string() })),
});
export type Harness = z.infer<typeof harnessSchema>;

/** Drivers whose sessions run the factory's hooks and MCP reporter, so stages, cost and the budget cap work. */
export const TRACKED_DRIVERS: readonly string[] = ["claudeAgent"];

export const isTracked = (providerOrDriver: string) => TRACKED_DRIVERS.includes(providerOrDriver);

const DRIVER_LABELS: Record<string, string> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "Antigravity",
};

export const harnessLabel = (id: string, driver?: string, displayName?: string | null) =>
  displayName || DRIVER_LABELS[driver ?? id] || DRIVER_LABELS[id] || id;
