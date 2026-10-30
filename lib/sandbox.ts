import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { CONFIG_PATH, SANDBOX_IMAGE_PATH, UPSTASH_IMAGE_PATH, type SandboxLimits } from "./config";
import { imageDrift, imageVersionsSchema, rebuildText, type ImageComponent, type ImageVersions, type SandboxReadiness } from "./machine";
import { SCREENSHOT_DIR } from "./screenshots";

// Fixed paths inside a job's sandbox. The image puts the factory's hook and MCP bundles and its
// playbooks under FACTORY_ROOT; each launch clones the job's repo into REPO_DIR.

export const FACTORY_ROOT = "/opt/marshal-factory";
export const SANDBOX_PLAYBOOKS = `${FACTORY_ROOT}/playbooks`;
export const REPO_DIR = "/work/repo";
export const SANDBOX_HOME = "/root";
export const GITHUB_TOKEN_PATH = `${SANDBOX_HOME}/.config/marshal-factory/github-token`;
export const INGEST_CONFIG_PATH = `${SANDBOX_HOME}/.config/marshal-factory/config.json`;
export const T3_USERDATA = `${SANDBOX_HOME}/.t3/userdata`;
export const CODEX_HOME = `${SANDBOX_HOME}/.codex`;
export const CODEX_AUTH = `${CODEX_HOME}/auth.json`;
export const T3_PORT = 3773;

/** An Upstash box's home. Its /root is a noexec tmpfs, emptied at every container start, so the tools live here instead. */
export const UPSTASH_HOME = "/home/boxuser";

/** The paths under a sandbox's home: root's in Modal, boxuser's in Upstash. The constants above are Modal's. */
export const sandboxPaths = (home: string = SANDBOX_HOME) => ({
  home,
  githubToken: `${home}/.config/marshal-factory/github-token`,
  ingestConfig: `${home}/.config/marshal-factory/config.json`,
  t3Userdata: `${home}/.t3/userdata`,
  codexHome: `${home}/.codex`,
  codexAuth: `${home}/.codex/auth.json`,
});
export const pathsOf = (host: { home?: string }) => sandboxPaths(host.home);

/**
 * Headless browser for the agent. The output dir sits outside REPO_DIR so screenshots never land in its worktree.
 * Every request but loopback goes to a proxy nothing listens on, so a page off the web, which could carry
 * instructions, never reaches an agent that holds a GitHub token. Chromium applies it to redirects and
 * subresources too, which --allowed-origins does not.
 */
export const BROWSER_SERVER = "playwright";
export const browserServer = {
  command: "playwright-mcp",
  args: ["--headless", "--isolated", "--browser", "chromium", "--no-sandbox", "--output-dir", SCREENSHOT_DIR, "--proxy-server", "http://127.0.0.1:9", "--proxy-bypass", "localhost,127.0.0.1,[::1]"],
};

/**
 * The factory's entry points the image bundles under FACTORY_ROOT, by path in this checkout.
 * hooks/budget.ts is a no-op kept for repos wired before the budget cap was removed.
 */
export const IMAGE_BUNDLES = ["hooks/report.ts", "hooks/budget.ts", "hooks/verify.ts", "mcp/factory-report.ts"] as const;

/** PStack's marketplace, cloned at the pinned commit, and the plugin both CLIs install from it. */
export const PSTACK_DIR = "/opt/pstack";
export const PSTACK_PLUGIN = "pstack@pstack-claude";

export const sandboxImageSchema = z.object({
  imageId: z.string().min(1),
  t3Version: z.string(),
  /** Optional so an image built before the other pins reads as outdated, not as missing. */
  versions: imageVersionsSchema.optional(),
  factoryCommit: z.string(),
  builtAt: z.string(),
});
export type SandboxImage = z.infer<typeof sandboxImageSchema>;

type Pins = Pick<SandboxLimits, "t3Version" | "claudeCodeVersion" | "codexVersion" | "playwrightMcpVersion" | "pstack">;

/** The playbooks the factory ships with its image, by file name under playbooks/. */
export const PLAYBOOK_FILES = ["factory.md", "onboarding.md"] as const;

/** This checkout's playbooks directory. */
export const checkoutPlaybooks = () => resolve(import.meta.dirname, "../playbooks");

/** The playbooks by a content hash prefix, so any edit to one of them reads as another version. */
export function playbooksVersion(read: (file: (typeof PLAYBOOK_FILES)[number]) => string = (file) => readFileSync(join(checkoutPlaybooks(), file), "utf8")) {
  const hash = createHash("sha256");
  for (const file of PLAYBOOK_FILES) hash.update(`${file}\0${read(file)}\0`);
  return hash.digest("hex").slice(0, 12);
}

/**
 * Copies this checkout's playbooks into an image under SANDBOX_PLAYBOOKS and returns the version of
 * what the image then holds, read back, so a failed or partial copy can never match the pin.
 */
export async function installPlaybooks(fs: { writeText(text: string, path: string): Promise<void>; readText(path: string): Promise<string> }) {
  const copied = new Map<string, string>();
  for (const file of PLAYBOOK_FILES) {
    const path = `${SANDBOX_PLAYBOOKS}/${file}`;
    await fs.writeText(readFileSync(join(checkoutPlaybooks(), file), "utf8"), path);
    copied.set(file, await fs.readText(path));
  }
  return playbooksVersion((file) => copied.get(file)!);
}

/** PStack by its version and a commit prefix, so a moved pin at the same version still differs. */
export const pstackVersion = (pstack: Pins["pstack"]) => `${pstack.version}@${pstack.commit.slice(0, 12)}`;

export const pinnedVersions = (limits: Pins): Required<ImageVersions> => ({
  t3: limits.t3Version,
  claudeCode: limits.claudeCodeVersion,
  codex: limits.codexVersion,
  playwrightMcp: limits.playwrightMcpVersion,
  pstack: pstackVersion(limits.pstack),
  playbooks: playbooksVersion(),
});

export const builtVersions = (image: SandboxImage): ImageVersions => ({ t3: image.t3Version, ...image.versions });

/** The version a CLI's --version output names, or null when it names none. */
export function parseVersion(component: Exclude<ImageComponent, "pstack" | "playbooks">, output: string) {
  const pattern = (() => {
    switch (component) {
      case "t3":
        return /^t3 v(\S+)$/m;
      case "claudeCode":
        return /^(\S+) \(Claude Code\)$/m;
      case "codex":
        return /^codex-cli (\S+)$/m;
      case "playwrightMcp":
        return /^Version (\S+)$/m;
      default: {
        const unknown: never = component;
        throw new Error(`no version format for ${String(unknown)}`);
      }
    }
  })();
  return pattern.exec(output.trim())?.[1] ?? null;
}

const pluginListSchema = z.array(z.object({ id: z.string(), version: z.string().optional(), enabled: z.boolean().optional(), installPath: z.string().optional() }));

/** PStack's entry in `claude plugin list --json` when it is installed and enabled, else null. */
export function enabledPstack(output: string) {
  try {
    const plugin = pluginListSchema.parse(JSON.parse(output)).find((p) => p.id === PSTACK_PLUGIN);
    return plugin?.enabled ? plugin : null;
  } catch {
    return null;
  }
}

/** The stored image, or null when none was built or it is unreadable. */
export function readSandboxImage(path = SANDBOX_IMAGE_PATH): SandboxImage | null {
  if (!existsSync(path)) return null;
  try {
    return sandboxImageSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** How an outdated image gets rebuilt: runner/base-image.ts does it on the tick. */
export const REBUILDS_ITSELF = "the runner rebuilds it on its tick, or run bun scripts/sandbox-image.ts";

/** Why this image cannot launch jobs under these limits, or undefined when it can. */
export function imageProblem(image: SandboxImage | null, limits: Pins) {
  if (!image) return "no sandbox image is built; run bun scripts/sandbox-image.ts";
  const drift = imageDrift(builtVersions(image), pinnedVersions(limits));
  return drift.length > 0 ? `${rebuildText(drift)}; ${REBUILDS_ITSELF}` : undefined;
}

/** The command that builds the Upstash base snapshot; the runner does not rebuild it on its own. */
export const UPSTASH_IMAGE_BUILD = "bun scripts/sandbox-image.ts --backend upstash";

/** Why the Upstash base snapshot cannot launch jobs under these limits, or undefined when it can. */
export function upstashImageProblem(image: SandboxImage | null, limits: Pins) {
  if (!image) return `no Upstash base snapshot is built; run ${UPSTASH_IMAGE_BUILD}`;
  const drift = imageDrift(builtVersions(image), pinnedVersions(limits));
  return drift.length > 0 ? `${rebuildText(drift, "the Upstash base snapshot")}; run ${UPSTASH_IMAGE_BUILD}` : undefined;
}

export const slotAuthPath = (slot: string) => join(slot, "auth.json");

/**
 * Login slots whose login failed in a sandbox, kept next to the config. An entry holds while the
 * slot's auth.json keeps the modification time it had then; logging in again rewrites the file and
 * clears it. No credentials are stored, only the slot path, the reason and times.
 */
export const SLOT_HEALTH_PATH = join(dirname(CONFIG_PATH), "codex-slots.json");

export const slotHealthSchema = z.array(
  z.object({ slot: z.string(), status: z.literal("unusable"), reason: z.string(), at: z.string(), authMtimeMs: z.number() }),
);
export type SlotHealth = z.infer<typeof slotHealthSchema>;

export function readSlotHealth(path = SLOT_HEALTH_PATH): SlotHealth {
  if (!existsSync(path)) return [];
  try {
    return slotHealthSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
}

/** The auth.json modification time, or null when the slot has no login. */
export function slotAuthMtime(slot: string) {
  try {
    return statSync(slotAuthPath(slot)).mtimeMs;
  } catch {
    return null;
  }
}

export const slotUnusable = (health: SlotHealth, slot: string, authMtimeMs: number | null) =>
  health.some((h) => h.slot === slot && h.authMtimeMs === authMtimeMs);

/** Booleans and counts only: whether this runner could launch on Modal, never the credentials themselves. */
export function sandboxReadiness(
  limits: Pick<SandboxLimits, "codexSlots"> & Partial<Pins & Pick<SandboxLimits, "maxParallel">>,
  env: NodeJS.ProcessEnv = process.env,
  health = readSlotHealth(),
  image = readSandboxImage(),
  upstashImage = readSandboxImage(UPSTASH_IMAGE_PATH),
): SandboxReadiness {
  const loggedIn = limits.codexSlots.filter((slot) => existsSync(slotAuthPath(slot)));
  const unusable = loggedIn.filter((slot) => slotUnusable(health, slot, slotAuthMtime(slot))).length;
  const { t3Version, claudeCodeVersion, codexVersion, playwrightMcpVersion, pstack } = limits;
  return {
    modal: Boolean(env.MODAL_TOKEN_ID) || existsSync(join(homedir(), ".modal.toml")),
    claude: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN),
    codexSlots: loggedIn.length - unusable,
    codexSlotsUnusable: unusable,
    image: image !== null,
    // The image id stays on the runner; its version, build time and commit say nothing secret.
    imageInfo: image && { t3Version: image.t3Version, builtAt: image.builtAt, factoryCommit: image.factoryCommit, versions: builtVersions(image) },
    ...(limits.t3Version && { pinnedT3Version: limits.t3Version }),
    ...(t3Version && claudeCodeVersion && codexVersion && playwrightMcpVersion && pstack && { pinnedVersions: pinnedVersions({ t3Version, claudeCodeVersion, codexVersion, playwrightMcpVersion, pstack }) }),
    ...(limits.maxParallel && { maxParallel: limits.maxParallel }),
    ...((env.UPSTASH_BOX_API_KEY || upstashImage) && {
      upstash: Boolean(env.UPSTASH_BOX_API_KEY),
      upstashImageInfo: upstashImage && { t3Version: upstashImage.t3Version, builtAt: upstashImage.builtAt, factoryCommit: upstashImage.factoryCommit, versions: builtVersions(upstashImage) },
    }),
  };
}
