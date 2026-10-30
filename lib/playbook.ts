import { join } from "node:path";
import { cloudOfSandbox, type Execution } from "./execution";
import type { JobHost } from "./host";
import { checkoutPlaybooks, SANDBOX_PLAYBOOKS } from "./sandbox";

// The factory playbook ships with the factory, not with the target repo: a sandbox image holds it
// under SANDBOX_PLAYBOOKS, and a local thread runs on the runner's machine next to its checkout.

/** Where a repo may keep its own copy, as scripts/install-target.ts writes it. */
export const REPO_PLAYBOOK = ".agents/playbooks/factory.md";

/** The factory playbook's absolute path on the machine a job's thread runs on. */
export function factoryPlaybook(execution: Execution) {
  switch (execution) {
    case "modal":
    case "upstash":
      return `${SANDBOX_PLAYBOOKS}/factory.md`;
    case "local":
      return join(checkoutPlaybooks(), "factory.md");
    default: {
      const never: never = execution;
      throw new Error(`unknown execution ${String(never)}`);
    }
  }
}

/** Where a claimed job's thread runs: its recorded execution, else where its sandbox fields put it. */
export const jobExecution = (job: { execution: Execution | null; sandbox_id: string | null; sandbox_snapshot: string | null }): Execution =>
  job.execution ?? (job.sandbox_id || job.sandbox_snapshot ? cloudOfSandbox((job.sandbox_id ?? job.sandbox_snapshot)!) : "local");

/** Whether the repo's main has its own copy; any failure to tell counts as none. */
export async function repoHasPlaybook(host: JobHost, checkout: string) {
  try {
    await host.run("git", ["-C", checkout, "cat-file", "-e", `origin/main:${REPO_PLAYBOOK}`], { timeoutMs: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** The launch message's last section: which playbook to follow, and how a repo copy ranks against it. */
export function playbookSection(execution: Execution, repoCopy: boolean) {
  const path = factoryPlaybook(execution);
  return [
    "## Factory playbook",
    "",
    `The factory playbook is ${path}. Read it before anything else and follow it. It lives outside this repository and extends PStack's bundled playbooks the way a project playbook under .agents/playbooks/ does: copy the bundled steps, then apply its changes.`,
    ...(repoCopy
      ? [
          "",
          `This repository also has ${REPO_PLAYBOOK}. The factory playbook at ${path} is authoritative: where they differ, follow it. Take the repository copy only for notes specific to this repository.`,
        ]
      : []),
  ].join("\n");
}

/** A launch message with its playbook section, for a thread on this host in this checkout of the repo. */
export async function withPlaybook(message: string, execution: Execution, host: JobHost, checkout: string) {
  return `${message}\n\n${playbookSection(execution, await repoHasPlaybook(host, checkout))}`;
}
