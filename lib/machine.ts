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

/** What a sandbox image holds that the config pins; any difference means rebuilding it. */
export const IMAGE_COMPONENTS = ["t3", "claudeCode", "codex", "playwrightMcp", "pstack", "playbooks"] as const;
export type ImageComponent = (typeof IMAGE_COMPONENTS)[number];
export const imageVersionsSchema = z.object({ t3: z.string(), claudeCode: z.string(), codex: z.string(), playwrightMcp: z.string(), pstack: z.string(), playbooks: z.string() }).partial();
export type ImageVersions = z.infer<typeof imageVersionsSchema>;

export function componentName(component: ImageComponent) {
  switch (component) {
    case "t3":
      return "T3";
    case "claudeCode":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "playwrightMcp":
      return "Playwright MCP";
    case "pstack":
      return "PStack";
    case "playbooks":
      return "Factory playbooks";
    default: {
      const unknown: never = component;
      throw new Error(`unknown image component ${String(unknown)}`);
    }
  }
}

export type ImageDrift = { component: ImageComponent; built: string | undefined; pinned: string };

/** Each pinned component the image holds another version of, or none at all. */
export const imageDrift = (built: ImageVersions, pinned: ImageVersions): ImageDrift[] =>
  IMAGE_COMPONENTS.flatMap((component) => {
    const want = pinned[component];
    return want !== undefined && built[component] !== want ? [{ component, built: built[component], pinned: want }] : [];
  });

export const rebuildText = (drift: readonly ImageDrift[], what = "the sandbox image") =>
  `Rebuild ${what}: ${drift.map((d) => `${componentName(d.component)} ${d.built ?? "missing"} → ${d.pinned}`).join(", ")}`;

/** The runner's own rebuild of the base image: one in flight, or the last one that failed. */
export const baseImageBuildSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("building"), reason: z.string(), startedAt: z.string() }),
  z.object({ state: z.literal("failed"), reason: z.string(), error: z.string(), at: z.string() }),
]);
export type BaseImageBuild = z.infer<typeof baseImageBuildSchema>;

/** Whether a runner could launch jobs on Modal; booleans and a count, never the credentials. */
export const sandboxReadinessSchema = z.object({
  modal: z.boolean(),
  claude: z.boolean(),
  /** Slots with a login that is not marked unusable. */
  codexSlots: z.number().int().nonnegative(),
  /** Slots whose login failed in a sandbox and has not changed since; optional for older inventories. */
  codexSlotsUnusable: z.number().int().nonnegative().optional(),
  image: z.boolean(),
  /** What the built image holds; the rest are optional for older inventories too. */
  imageInfo: z
    .object({ t3Version: z.string(), builtAt: z.string(), factoryCommit: z.string(), versions: imageVersionsSchema.optional() })
    .nullable()
    .optional(),
  /** The T3 version the runner's config pins; an image with another one launches nothing. */
  pinnedT3Version: z.string().optional(),
  /** Every component version the runner pins; older runners report only pinnedT3Version. */
  pinnedVersions: imageVersionsSchema.optional(),
  maxParallel: z.number().int().positive().optional(),
  /** Absent when no rebuild runs and none failed; older runners never report one. */
  imageBuild: baseImageBuildSchema.optional(),
  /** Upstash Box: whether the runner has its API key, and what its base snapshot holds. Absent while Upstash is not set up. */
  upstash: z.boolean().optional(),
  upstashImageInfo: z
    .object({ t3Version: z.string(), builtAt: z.string(), factoryCommit: z.string(), versions: imageVersionsSchema.optional() })
    .nullable()
    .optional(),
});
export type SandboxReadiness = z.infer<typeof sandboxReadinessSchema>;

/** Whether a runner can send Slack notifications (lib/slack.ts): booleans, never the token. */
export const slackReadinessSchema = z.object({ configured: z.boolean(), owner: z.boolean() });
export type SlackReadiness = z.infer<typeof slackReadinessSchema>;

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
  /** Optional for the same reason. */
  sandbox: known(sandboxReadinessSchema).optional(),
  /** Whether the runner's env has SLACK_BOT_TOKEN and SLACK_OWNER_USER_ID; never their values. Optional for the same reason. */
  slack: known(slackReadinessSchema).optional(),
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

/** The pinned components the reported image differs on; an image with any launches nothing. */
export const reportedDrift = ({ imageInfo, pinnedT3Version, pinnedVersions }: SandboxReadiness) =>
  imageInfo ? imageDrift({ t3: imageInfo.t3Version, ...imageInfo.versions }, { ...(pinnedT3Version && { t3: pinnedT3Version }), ...pinnedVersions }) : [];

export const imageOutdated = (readiness: SandboxReadiness) => reportedDrift(readiness).length > 0;

/** Some harness can log in to a sandbox: Claude Code with the runner's token, or Codex with a usable slot. */
export const sandboxLogin = (readiness: SandboxReadiness) => readiness.claude || readiness.codexSlots > 0;

/** The most ready sandbox report among online machines; null when none reports one. */
export function reportedSandbox(machines: readonly { last_seen_at: Date; inventory: unknown }[], now: number): SandboxReadiness | null {
  const reports = machines.flatMap((m) => {
    const sandbox = parseInventory(m.inventory)?.sandbox;
    return isOnline(m.last_seen_at, now) && sandbox && sandbox !== UNKNOWN ? [sandbox] : [];
  });
  const score = (r: SandboxReadiness) =>
    Number(r.modal) + Number(sandboxLogin(r)) + Number(r.image && !imageOutdated(r)) + (Number(r.claude) + Number(r.codexSlots > 0)) / 4;
  return reports.sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** Slack as the online machines report it: configured when any has a token. Null when none reports it. */
export function reportedSlack(machines: readonly { last_seen_at: Date; inventory: unknown }[], now: number): SlackReadiness | null {
  const reports = machines.flatMap((m) => {
    const slack = parseInventory(m.inventory)?.slack;
    return isOnline(m.last_seen_at, now) && slack && slack !== UNKNOWN ? [slack] : [];
  });
  if (reports.length === 0) return null;
  const configured = reports.filter((r) => r.configured);
  return { configured: configured.length > 0, owner: configured.some((r) => r.owner) };
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
