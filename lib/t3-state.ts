import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { harnessLabel, type Harness } from "./harness";
import { UNKNOWN, type ConnectState, type Projects, type T3Project } from "./machine";
import { forbidInTest } from "./test-mode";

// Runner only: bun:sqlite does not exist under Next.

const run = promisify(execFile);
const T3 = () => process.env.T3CODE_CLI_PATH ?? "t3";
const CLI_TIMEOUT_MS = 5_000;

export const t3Home = () => process.env.T3CODE_HOME ?? join(homedir(), ".t3");
export const t3UserdataDir = () => join(t3Home(), "userdata");
export const defaultStatePath = () => join(t3UserdataDir(), "statev2.sqlite");

const projectRow = z.object({ project_id: z.string(), title: z.string(), workspace_root: z.string() });

function readProjectsFromSqlite(statePath: string): T3Project[] {
  const state = new Database(statePath, { readonly: true });
  try {
    const rows = state
      .query("select project_id, title, workspace_root from projection_projects where deleted_at is null order by workspace_root")
      .all();
    return rows.map((row) => {
      const parsed = projectRow.parse(row);
      return { id: parsed.project_id, title: parsed.title, path: parsed.workspace_root };
    });
  } finally {
    state.close();
  }
}

export async function probeProject(path: string) {
  forbidInTest("t3 thread list");
  await run(T3(), ["thread", "list", "--project", path, "--json"], { timeout: CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
}

export async function readProjects({
  statePath = defaultStatePath(),
  repos,
  probe = probeProject,
}: {
  statePath?: string;
  repos: readonly string[];
  probe?: (path: string) => Promise<unknown>;
}): Promise<Projects> {
  try {
    return { source: "sqlite", items: readProjectsFromSqlite(statePath) };
  } catch {
  }
  const items: T3Project[] = [];
  let answered = false;
  for (const path of repos) {
    try {
      await probe(path);
      answered = true;
      items.push({ id: null, title: basename(path), path });
    } catch {
      // The CLI exits non-zero for a repo T3 does not know, so a throw only means this repo is not a project.
    }
  }
  return answered ? { source: "probe", items } : { source: UNKNOWN };
}

const runtimeFile = z.object({ pid: z.number(), serverVersion: z.string() });

const readTrimmed = (path: string) => {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
};

export function readT3Runtime(userdataDir = t3UserdataDir()) {
  const environmentId = readTrimmed(join(userdataDir, "environment-id"));
  let runtime: z.infer<typeof runtimeFile>;
  try {
    runtime = runtimeFile.parse(JSON.parse(readFileSync(join(userdataDir, "server-runtime.json"), "utf8")));
  } catch {
    return { up: false, version: null, environmentId };
  }
  let up = true;
  try {
    process.kill(runtime.pid, 0);
  } catch {
    up = false;
  }
  return { up, version: runtime.serverVersion, environmentId };
}

const settingsFile = z.looseObject({
  providerInstances: z.record(
    z.string(),
    z.looseObject({ driver: z.string(), enabled: z.boolean().default(true), displayName: z.string().nullish() }),
  ),
});

const manifestModel = z.looseObject({ slug: z.string(), name: z.string().optional() });
const manifestFile = z.looseObject({
  manifest: z.looseObject({
    currentModels: z.record(z.string(), z.array(z.string())).catch({}),
    providers: z
      .record(z.string(), z.looseObject({ models: z.union([z.array(manifestModel), z.record(z.string(), manifestModel)]).catch([]) }))
      .catch({}),
  }),
});

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;

/**
 * T3's provider instances with the models its manifest lists as current for each driver. A driver
 * the manifest does not cover, or a missing manifest, gives no models; a missing or unreadable
 * settings file throws.
 */
export function readHarnesses(userdataDir = t3UserdataDir()): Harness[] {
  const { providerInstances } = settingsFile.parse(readJson(join(userdataDir, "settings.json")));
  let manifest: z.infer<typeof manifestFile>["manifest"] = { currentModels: {}, providers: {} };
  try {
    manifest = manifestFile.parse(readJson(join(userdataDir, "model-manifest.json"))).manifest;
  } catch {
    // Harnesses without models still show which providers exist.
  }
  return Object.entries(providerInstances).map(([id, instance]) => {
    const known = Object.values(manifest.providers[instance.driver]?.models ?? []);
    const nameOf = new Map(known.map((m) => [m.slug, m.name]));
    return {
      id,
      driver: instance.driver,
      name: harnessLabel(id, instance.driver, instance.displayName),
      enabled: instance.enabled,
      models: (manifest.currentModels[instance.driver] ?? []).map((slug) => ({ slug, name: nameOf.get(slug) || slug })),
    };
  });
}

const connectJson = z.looseObject({ authenticated: z.boolean() });

/** `authenticated` is the field the CLI's own formatter prints as "Authorization: stored credential|missing". */
export function parseConnectStatus(stdout: string): ConnectState {
  try {
    return connectJson.parse(JSON.parse(stdout)).authenticated ? "linked" : "unlinked";
  } catch {
    return UNKNOWN;
  }
}

export async function connectStatus(): Promise<ConnectState> {
  forbidInTest("t3 connect status");
  const { stdout } = await run(T3(), ["connect", "status", "--json"], { timeout: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  return parseConnectStatus(stdout);
}
