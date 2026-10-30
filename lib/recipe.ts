import { z } from "zod";
import { matchesAny } from "./globs";

// A repo's setup recipe, committed at RECIPE_PATH: what a sandbox installs and runs so the repo's
// checks pass. The factory builds a warm image from it, so a job's sandbox starts with the system
// packages, runtimes and dependency caches in place. Secrets are named here, never valued.

export const RECIPE_PATH = ".factory/setup.json";

/**
 * Where a job's sandbox holds the recipe while it is only on the onboarding PR, so main, and the
 * job's worktree, have none; factory-verify reads it when the worktree has no RECIPE_PATH. It is
 * under the sandbox's home, which the launcher and factory-verify (as $HOME) agree on.
 */
export const unmergedRecipePath = (home: string) => `${home}/.config/marshal-factory/recipe.json`;
/** Modal's, whose sandboxes run as root. */
export const UNMERGED_RECIPE_PATH = unmergedRecipePath("/root");

/** Changes to these invalidate a warm image when the recipe names no warmKey of its own. */
export const DEFAULT_WARM_KEY = [
  "**/bun.lock",
  "**/bun.lockb",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/requirements*.txt",
  "**/poetry.lock",
  "**/uv.lock",
  "**/Pipfile.lock",
  "**/Gemfile.lock",
  "**/go.sum",
  "**/Cargo.lock",
] as const;

const command = z.string().trim().min(1, "A command can't be empty.").max(2000);
const version = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+){0,2}$/, "Pin a runtime as a version number such as 22 or 1.4.4.");

export const CHECKS = ["test", "lint", "typecheck", "build"] as const;
export type CheckName = (typeof CHECKS)[number];

export const envVarSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Name an env var with letters, digits and underscores."),
  purpose: z.string().trim().max(300),
  required: z.boolean(),
});
export type EnvVar = z.infer<typeof envVarSchema>;

export const recipeSchema = z
  .object({
    /** apt packages. */
    system: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9+.-]*$/, "Name apt packages by their package name."))
      .max(100)
      .optional(),
    /** Installed only when the sandbox lacks them or has another version. */
    runtimes: z.object({ node: version.optional(), bun: version.optional(), python: version.optional() }).strict().optional(),
    setup: z.array(command).max(50),
    checks: z.object({ test: command.optional(), lint: command.optional(), typecheck: command.optional(), build: command.optional() }).strict(),
    env: z.array(envVarSchema).max(50).optional(),
    warmKey: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  })
  .strict();
export type Recipe = z.infer<typeof recipeSchema>;

export type RecipeParse = { ok: true; recipe: Recipe } | { ok: false; error: string };

/** The recipe in a setup.json's text, or why it is not one. Services are not supported yet. */
export function parseRecipe(text: string): RecipeParse {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: `${RECIPE_PATH} is not valid JSON.` };
  }
  if (json && typeof json === "object" && "services" in json) {
    return { ok: false, error: `${RECIPE_PATH} lists services, which the factory does not run yet; drop them and start them in setup if a check needs one.` };
  }
  const parsed = recipeSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${RECIPE_PATH}: ${issue?.path.join(".") || "recipe"}: ${issue?.message ?? "invalid"}` };
  }
  return { ok: true, recipe: parsed.data };
}

export const warmKeyOf = (recipe: Recipe) => [...(recipe.warmKey ?? DEFAULT_WARM_KEY), RECIPE_PATH];

/** Whether a push touching these files makes the warm image stale. */
export const warmKeyTouched = (recipe: Recipe | undefined, files: readonly string[]) =>
  files.some((file) => file === RECIPE_PATH || matchesAny(file, recipe ? warmKeyOf(recipe) : DEFAULT_WARM_KEY));

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
      : value;

/** The same text for recipes that mean the same, whatever their key order; lib/recipe-hash.ts hashes it. */
export const canonicalRecipe = (recipe: Recipe) => JSON.stringify(canonical(recipe));

export const requiredEnv = (recipe: Recipe | undefined) => (recipe?.env ?? []).filter((e) => e.required).map((e) => e.name);

/** The required env names no secret has been saved for yet. */
export const missingEnv = (recipe: Recipe | undefined, set: readonly string[]) => requiredEnv(recipe).filter((name) => !set.includes(name));

const b64 = (text: string) => Buffer.from(text).toString("base64");
const run = (text: string) => `bash -c "$(echo ${b64(text)} | base64 -d)"`;

function runtimeSteps(runtimes: Recipe["runtimes"]) {
  const steps: string[] = [];
  if (runtimes?.node) {
    const major = runtimes.node.split(".")[0]!;
    steps.push(
      `if ! node --version 2>/dev/null | grep -q '^v${major}\\.'; then curl -fsSL https://deb.nodesource.com/setup_${major}.x | bash - && apt-get install -y --no-install-recommends nodejs || exit 11; fi`,
    );
  }
  if (runtimes?.bun) {
    steps.push(`if ! bun --version 2>/dev/null | grep -q '^${runtimes.bun.replaceAll(".", "\\.")}'; then curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s bun-v${runtimes.bun} || exit 12; fi`);
  }
  if (runtimes?.python) {
    const pin = runtimes.python;
    const uv = `UV_PYTHON_INSTALL_DIR=${UV_PYTHON_DIR} UV_PYTHON_PREFERENCE=only-managed uv`;
    steps.push(
      `if ! python3 --version 2>/dev/null | ${pythonIs(pin)}; then { command -v uv > /dev/null || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh; } && ${uv} python install ${pin} && ln -sf "$(${uv} python find ${pin})" /usr/local/bin/python3 && ln -sf /usr/local/bin/python3 /usr/local/bin/python && hash -r || exit 13; fi`,
      pythonPinCheck(pin),
    );
  }
  return steps;
}

/** Where uv keeps the Python a recipe pins; /usr/local/bin/python3 links to it. */
const UV_PYTHON_DIR = "/opt/uv-python";

/** A grep that passes for `python3 --version` output of the pin: 3.12 matches 3.12.4, not 3.120. */
const pythonIs = (pin: string) => `grep -q '^Python ${pin.replaceAll(".", "\\.")}\\(\\.\\|$\\)'`;

/** Fails the build when python3 on PATH is not the pinned version, whatever the install did. */
export const pythonPinCheck = (pin: string) =>
  `python3 --version 2>&1 | ${pythonIs(pin)} || { echo "python3 is $(python3 --version 2>&1), not the pinned ${pin}"; exit 13; }`;

/** Where the build script keeps its log, exit code and check results in the sandbox. */
export const BUILD_DIR = "/work/onboarding";
export const BUILD_FILES = { script: `${BUILD_DIR}/build.sh`, log: `${BUILD_DIR}/build.log`, code: `${BUILD_DIR}/build.code`, checks: `${BUILD_DIR}/checks.tsv` } as const;

/** Exit codes the build script uses, so a failure names its step. */
export const BUILD_EXIT: Record<number, string> = {
  10: "installing the system packages failed",
  11: "installing the pinned Node failed",
  12: "installing the pinned Bun failed",
  13: "installing the pinned Python failed",
  20: "a setup command failed",
};

/**
 * The script a build sandbox runs in the repo: system packages, missing runtimes, then each setup
 * command, stopping at the first that fails. With `checks`, every check command runs after and its
 * exit code goes to checks.tsv; a failing check does not fail the build. Commands travel base64
 * encoded, so no quoting in them can break the script.
 */
export function buildScript(recipe: Recipe, repoDir: string, { checks }: { checks: boolean }) {
  const lines = ["#!/bin/bash", "set -uo pipefail", "export DEBIAN_FRONTEND=noninteractive", `cd ${repoDir} || exit 20`];
  if (recipe.system?.length) lines.push(`apt-get update && apt-get install -y --no-install-recommends ${recipe.system.join(" ")} || exit 10`);
  lines.push(...runtimeSteps(recipe.runtimes));
  recipe.setup.forEach((cmd, i) => lines.push(`echo "== setup ${i + 1}: $(echo ${b64(cmd)} | base64 -d)"`, `${run(cmd)} || exit 20`));
  if (checks) {
    lines.push(`: > ${BUILD_FILES.checks}`);
    for (const name of CHECKS) {
      const cmd = recipe.checks[name];
      if (!cmd) continue;
      lines.push(`echo "== check ${name}"`, `${run(cmd)}; printf '%s\\t%s\\n' ${name} $? >> ${BUILD_FILES.checks}`);
    }
  }
  lines.push("exit 0");
  return `${lines.join("\n")}\n`;
}

/** The check results the build script wrote. */
export function parseCheckResults(text: string | null, recipe: Recipe) {
  return (text ?? "")
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts): parts is [CheckName, string] => parts.length === 2 && (CHECKS as readonly string[]).includes(parts[0]!))
    .map(([name, code]) => ({ name, command: recipe.checks[name] ?? "", ok: code.trim() === "0", ...(code.trim() !== "0" && { note: `exited ${code.trim()}` }) }));
}

/**
 * Cuts a log down to an excerpt worth showing, without anything that looks like a credential: a
 * value assigned to a named env var, a bearer or basic token, a URL's userinfo, or a long
 * token-shaped string.
 */
export function redact(text: string, envNames: readonly string[] = [], maxLines = 25) {
  let out = text;
  for (const name of envNames) out = out.replace(new RegExp(`(${name}\\s*[=:]\\s*)("[^"]*"|'[^']*'|\\S+)`, "g"), "$1[redacted]");
  out = out
    .replace(/((?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-|xox[abp]-)[A-Za-z0-9_-]{10,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, "[redacted]");
  return out.trimEnd().split("\n").slice(-maxLines).join("\n");
}
