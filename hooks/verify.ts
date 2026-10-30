import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { eventSchema, type FactoryEvent } from "../lib/events";
import { combined, CHECK_TIMEOUT_MS, formatDuration, OUTPUT_KEEP_CHARS, planChecks, runChecks, SECRET_ENV, shortSha, type CheckRunner, type EvidenceCheck } from "../lib/evidence";
import { parseBranch } from "../lib/factory";
import { readIngestTarget, reportEvents } from "../lib/outbox";
import { parseRecipe, RECIPE_PATH, unmergedRecipePath } from "../lib/recipe";
import { mcpIdentity } from "../lib/report-identity";

// factory-verify: runs the repo's checks at the current HEAD and reports what ran as evidence for
// that exact commit, through the outbox, so the merge decision can hold the PR's head to it.
//
//   bun <factory root>/hooks/verify.ts [--json] [--no-post] [--timeout-minutes N]
//
// The checks are the recipe's (.factory/setup.json), else the package.json scripts test, lint,
// typecheck and build. Uncommitted changes, or a HEAD that moves while the checks run, mark the
// evidence dirty: it then proves nothing about the commit. Exits 0 only when the tree is clean and
// every check passed.

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run("git", ["-C", cwd, ...args], { timeout: 30_000 })).stdout.trim();
const FLUSH_BUDGET_MS = 5000;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const timeoutMinutes = Number(args[args.indexOf("--timeout-minutes") + 1]);
const timeoutMs = args.includes("--timeout-minutes") && timeoutMinutes > 0 ? timeoutMinutes * 60_000 : CHECK_TIMEOUT_MS;
const say = (line: string) => process.stderr.write(`factory-verify: ${line}\n`);

/** Runs a command with bash in `cwd`, keeping only the end of its output. */
const localRunner =
  (cwd: string): CheckRunner =>
  (command, ms) =>
    new Promise((resolve) => {
      const child = spawn("bash", ["-c", combined(command)], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const keep = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-OUTPUT_KEEP_CHARS);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, ms);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ exitCode: null, output: `${output}\n${error.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: killed ? null : code, output: killed ? `${output}\ntimed out after ${formatDuration(ms)}` : output });
      });
    });

/** owner/name from the origin remote, else the checkout's folder name. */
async function repoOf(top: string) {
  const url = await git(top, "remote", "get-url", "origin").catch(() => "");
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return match?.[1] ?? basename(top);
}

/** The worktree's recipe, else the one the launcher left in the sandbox while it is only on the onboarding PR. */
function readRecipe(top: string) {
  const unmerged = unmergedRecipePath(homedir());
  const path = [join(top, RECIPE_PATH), unmerged].find((p) => existsSync(p));
  if (!path) return null;
  if (path === unmerged) say(`the worktree has no ${RECIPE_PATH}; using the recipe from the onboarding PR`);
  const parsed = parseRecipe(readFileSync(path, "utf8"));
  if (parsed.ok) return parsed.recipe;
  say(`${parsed.error} Falling back to package.json scripts.`);
  return null;
}

function printResults(checks: readonly EvidenceCheck[]) {
  for (const check of checks) say(`${check.passed ? "passed" : "failed"} ${check.name} · ${check.command} · ${formatDuration(check.durationMs)}${check.passed ? "" : ` · exit ${check.exitCode ?? "none"}`}`);
  for (const check of checks.filter((c) => !c.passed)) process.stderr.write(`\n--- ${check.name}: ${check.command}\n${check.outputTail}\n`);
}

async function main() {
  const cwd = process.cwd();
  const top = await git(cwd, "rev-parse", "--show-toplevel").catch(() => undefined);
  if (!top) {
    say("not inside a git repository");
    return 2;
  }
  const sha = await git(top, "rev-parse", "HEAD");
  const dirty = (await git(top, "status", "--porcelain")) !== "";
  const plan = planChecks({ recipe: readRecipe(top), packageJson: existsSync(join(top, "package.json")) ? readFileSync(join(top, "package.json"), "utf8") : null, files: readdirSync(top) });
  if (dirty) say("the tree has uncommitted changes, so this run can't prove the commit; commit first and run again");
  if (plan.checks.length === 0) say(`no checks defined: ${RECIPE_PATH} names none and package.json has no test, lint, typecheck or build script`);
  else say(`running ${plan.checks.length} check${plan.checks.length === 1 ? "" : "s"} from the ${plan.source === "recipe" ? "recipe" : "package.json scripts"} at ${shortSha(sha)}`);

  const secrets = [...plan.envNames, ...SECRET_ENV].map((name) => process.env[name] ?? "").concat(readIngestTarget()?.secret ?? "");
  const checks = await runChecks({ checks: plan.checks, envNames: plan.envNames }, localRunner(top), { secrets, timeoutMs });
  const moved = (await git(top, "rev-parse", "HEAD")) !== sha;
  if (moved) say("HEAD moved while the checks ran, so they prove neither commit");
  const clean = !dirty && !moved;
  printResults(checks);
  const passed = checks.filter((c) => c.passed).length;
  const ok = clean && checks.length > 0 && passed === checks.length;
  say(ok ? `verified at ${shortSha(sha)} · ${passed}/${checks.length} checks` : `not verified at ${shortSha(sha)} · ${passed}/${checks.length} checks passed${clean ? "" : " · uncommitted changes"}`);

  const identity = mcpIdentity(process.env, top);
  const attempt = parseBranch(identity?.branch)?.attempt;
  if (!identity || !attempt) {
    say("this checkout is on no factory branch, so nothing was reported");
    return ok ? 0 : 1;
  }
  const at = Date.now();
  const event: FactoryEvent = eventSchema.parse({
    eventId: createHash("sha256").update(`evidence\nagent\n${identity.jobKey}\n${sha}\n${at}`).digest("hex"),
    sessionId: process.env.FACTORY_SESSION_ID || `evidence:${identity.branch}`,
    at,
    kind: "evidence",
    jobKey: identity.jobKey,
    attempt,
    repo: await repoOf(top),
    sha,
    clean,
    producer: "agent",
    source: plan.source,
    checks,
  });
  if (flag("--json")) process.stdout.write(`${JSON.stringify(event)}\n`);
  if (!flag("--no-post")) {
    const flushed = await reportEvents([event], FLUSH_BUDGET_MS);
    if (!flushed) say("this machine has no factory ingest config, so nothing was reported");
    else if (flushed.error) say("ingest did not answer; the evidence is queued and will be delivered later");
    else say(`reported for ${identity.jobKey} at ${shortSha(sha)}`);
  }
  return ok ? 0 : 1;
}

process.exit(
  await main().catch((error: unknown) => {
    say(error instanceof Error ? error.message : String(error));
    return 2;
  }),
);
