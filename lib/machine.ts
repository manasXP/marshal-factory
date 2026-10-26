import { z } from "zod";
import { harnessSchema, type Harness } from "./harness";

export const UNKNOWN = "unknown";
const known = <T extends z.ZodType>(shape: T) => z.union([shape, z.literal(UNKNOWN)]);
export type Known<T> = T | typeof UNKNOWN;

export const heartbeatSchema = z.object({
  cpu: known(z.object({ load1: z.number().nonnegative(), cores: z.number().int().positive() })),
  memory: known(z.object({ usedBytes: z.number().nonnegative(), totalBytes: z.number().positive() })),
  disk: known(z.object({ freeBytes: z.number().nonnegative(), totalBytes: z.number().positive() })),
  capacity: known(z.object({ max: z.number().int().positive(), inFlight: z.number().int().nonnegative() })),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

export const CONNECT_STATES = ["linked", "unlinked", UNKNOWN] as const;
export type ConnectState = (typeof CONNECT_STATES)[number];

export const t3ProjectSchema = z.object({
  /** Null when the project was found by probing the CLI, which reports no id. */
  id: z.string().nullable(),
  title: z.string(),
  path: z.string(),
});
export type T3Project = z.infer<typeof t3ProjectSchema>;

export const projectsSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("sqlite"), items: z.array(t3ProjectSchema) }),
  z.object({ source: z.literal("probe"), items: z.array(t3ProjectSchema) }),
  z.object({ source: z.literal(UNKNOWN) }),
]);
export type Projects = z.infer<typeof projectsSchema>;

export const inventorySchema = z.object({
  runnerSha: known(z.string()),
  t3: known(
    z.object({
      up: z.boolean(),
      version: z.string().nullable(),
      /** The local environment id, the first segment of T3's `t3code://threads/<env>/<thread>` route. */
      environmentId: z.string().nullable(),
    }),
  ),
  connect: z.enum(CONNECT_STATES),
  projects: projectsSchema,
  repos: z.array(z.object({ path: z.string(), origin: known(z.string()) })),
  /** Optional so an inventory stored before harnesses were reported still parses. */
  harnesses: known(z.array(harnessSchema)).optional(),
});
export type Inventory = z.infer<typeof inventorySchema>;

/** Each field on its own, so one bad stat shows as unknown without hiding the others. */
export const parseHeartbeat = (value: unknown): Heartbeat | null => {
  if (typeof value !== "object" || value === null) return null;
  const fields = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(heartbeatSchema.shape).map(([key, schema]) => {
      const parsed = schema.safeParse(fields[key]);
      return [key, parsed.success ? parsed.data : UNKNOWN];
    }),
  ) as Heartbeat;
};

export const parseInventory = (value: unknown): Inventory | null => {
  const parsed = inventorySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export const ONLINE_WINDOW_MS = 270_000;

export const isOnline = (lastSeenAt: Date, now: number) => now - lastSeenAt.getTime() <= ONLINE_WINDOW_MS;

/**
 * Every harness the machines report, one per provider id. Each id takes its entry from an online
 * machine over an offline one, and an enabled entry over a disabled one. Null when no machine has
 * reported its harnesses yet.
 */
export function reportedHarnesses(machines: readonly { last_seen_at: Date; inventory: unknown }[], now: number): Harness[] | null {
  const lists = machines.flatMap((m) => {
    const harnesses = parseInventory(m.inventory)?.harnesses;
    return Array.isArray(harnesses) ? [{ online: isOnline(m.last_seen_at, now), harnesses }] : [];
  });
  if (lists.length === 0) return null;
  const best = new Map<string, { harness: Harness; rank: number }>();
  for (const { online, harnesses } of lists) {
    for (const harness of harnesses) {
      const rank = (online ? 2 : 0) + (harness.enabled ? 1 : 0);
      if ((best.get(harness.id)?.rank ?? -1) < rank) best.set(harness.id, { harness, rank });
    }
  }
  return [...best.values()].map((b) => b.harness).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The deep link that opens a thread in T3 on the Mac that runs it. T3's desktop app maps
 * `t3code://threads/<environmentId>/<threadId>` to its `/$environmentId/$threadId` route; without
 * an environment id `t3code://app` only brings T3 to the front.
 */
export function t3ThreadLink(threadId: string, environmentId: string | null) {
  return environmentId
    ? `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`
    : "t3code://app";
}
