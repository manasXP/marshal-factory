import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { askHidden } from "./prompt";

// Moves the runner to another machine, a Mac or the runner container, and keeps its identity. The
// new machine runs under the old one's machine id, so jobs that wait in a Modal sandbox or Upstash
// box (in pr or waiting) carry on from it.
//   bun scripts/move.ts pack <bundle> [--home <dir>]
//     On the old machine, in the live checkout. Refuses while this machine has work that only it can
//     finish, pins factory.machineId, stops the runner and removes its LaunchAgent, then writes the
//     files the factory needs to <bundle>, encrypted with a passphrase you choose. --home names the
//     runner home of a runner container to take the configs from; stop that container first.
//   bun scripts/move.ts unpack <bundle> [--home <dir>] [--force]
//     On the new machine, in its clone of the live checkout. Puts each file back, under --home for
//     the files that live in your home directory (a container's runner home, for example).
//     Refuses to overwrite a file that exists unless --force.
// docs/moving.md has the whole move.

const root = join(import.meta.dirname, "..");
process.chdir(root);
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { home: { type: "string" }, force: { type: "boolean", default: false } },
});
const [command, bundleArg] = positionals;
if (!["pack", "unpack"].includes(command ?? "") || !bundleArg) {
  console.error("Usage: bun scripts/move.ts pack <bundle> | unpack <bundle> [--home <dir>] [--force]");
  process.exit(2);
}
const bundle = resolve(bundleArg);
const home = resolve(args.home ?? homedir());
const LABEL = "com.marshal-factory.runner";
const PLIST = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);

class MoveError extends Error {}
process.on("uncaughtException", (error) => {
  console.error(error instanceof MoveError ? `stopped: ${error.message}` : error);
  process.exit(1);
});

function run(commandName: string, commandArgs: string[], env?: Record<string, string>) {
  const result = spawnSync(commandName, commandArgs, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) throw new MoveError(`${commandName} ${commandArgs[0]} exited ${result.status ?? result.signal}`);
}
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));

async function passphrase(confirm: boolean) {
  const value = await askHidden("Bundle passphrase (hidden): ");
  if (value.length < 8) throw new MoveError("use a passphrase of at least 8 characters");
  if (confirm && (await askHidden("Same passphrase again: ")) !== value) throw new MoveError("the two passphrases differ");
  return value;
}
// openssl reads the passphrase from its environment, so it never shows in the process list.
const openssl = (mode: "-e" | "-d", input: string, output: string, pass: string) =>
  run("openssl", ["enc", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-salt", mode, "-in", input, "-out", output, "-pass", "env:FACTORY_BUNDLE_PASSPHRASE"], { FACTORY_BUNDLE_PASSPHRASE: pass });

if (command === "pack") {
  process.loadEnvFile(".env.local");
  // lib/config reads these when it loads, so a runner home's configs are the ones it finds.
  if (args.home) {
    process.env.MARSHAL_FACTORY_CONFIG = join(home, ".config/marshal-factory/config.json");
    process.env.MARSHAL_FACTORY_GITHUB_APP = join(home, ".config/marshal-factory/github-app.json");
  }
  const { CONFIG_PATH, GITHUB_APP_PATH, SANDBOX_IMAGE_PATH, UPSTASH_IMAGE_PATH, loadConfig } = await import("../lib/config");
  const { ROLLOUT_PATH } = await import("../lib/rollout");
  const { slotAuthPath } = await import("../lib/sandbox");
  const { identify } = await import("../runner/heartbeat");
  const { machineInFlight } = await import("../runner/ops");
  const { db } = await import("../db/client");
  const { sql } = await import("drizzle-orm");
  if (existsSync(bundle)) throw new MoveError(`${bundle} exists; pick another path`);
  const config = loadConfig();
  // This process runs outside the container, so it can only learn the container's id from its config.
  if (args.home && !config.factory.machineId) throw new MoveError(`${CONFIG_PATH} has no factory.machineId, so this can't tell which machine the container is`);
  const machine = await identify(config.factory.machineId);

  // What only this machine can finish: running threads, local threads that wait for an answer or a
  // review (their worktrees stay here), and merges whose post-merge watch hasn't ended.
  async function blockers() {
    const { rows } = await db.execute<{ waiting_local: number; watching: number }>(sql`
      select count(*) filter (where execution = 'local' and stage in ('pr', 'waiting'))::int as waiting_local,
             count(*) filter (where merge_decision->'watch'->>'state' = 'watching')::int as watching
      from jobs where machine_id = ${machine.id}`);
    const counts = { "in flight": await machineInFlight(machine.id), "waiting on this Mac's T3": rows[0]!.waiting_local, "in a post-merge watch": rows[0]!.watching };
    return Object.entries(counts).flatMap(([what, count]) => (count > 0 ? [`${count} ${what}`] : []));
  }
  const refuse = (found: string[]) =>
    new MoveError(`${machine.name} still has jobs only it can finish (${found.join(", ")}). Pause new work on the panel's Queue page, let them finish, then run this again`);
  const before = await blockers();
  if (before.length > 0) throw refuse(before);

  // Stop the runner first and count again, so a job claimed in between isn't left behind. A container's
  // runner is yours to stop (docker compose down) before this runs.
  const loaded = !args.home && spawnSync("/bin/launchctl", ["print", `gui/${process.getuid!()}/${LABEL}`], { stdio: "ignore" }).status === 0;
  if (loaded) run("bun", ["scripts/install-runner.ts", "--uninstall"]);
  const after = await blockers();
  if (after.length > 0) {
    if (loaded) run("bun", ["scripts/install-runner.ts"]);
    throw refuse(after);
  }

  // The new machine has another hardware id; pinning this one makes it the same machine to the factory.
  if (!config.factory.machineId) {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { factory?: Record<string, unknown> };
    raw.factory = { ...raw.factory, machineId: machine.id };
    writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    console.log(`pinned factory.machineId to ${machine.id}`);
  }

  const inHome = (path: string) => {
    const rel = relative(home, path);
    if (rel.startsWith("..")) throw new MoveError(`${path} is outside your home directory; move it by hand`);
    return join("home", rel);
  };
  const wanted: [from: string, to: string, required: boolean][] = [
    [join(root, ".env.local"), "checkout/.env.local", true],
    [join(root, ".neon"), "checkout/.neon", true],
    [join(root, ".vercel/project.json"), "checkout/.vercel/project.json", false],
    [CONFIG_PATH, inHome(CONFIG_PATH), true],
    [GITHUB_APP_PATH, inHome(GITHUB_APP_PATH), true],
    [SANDBOX_IMAGE_PATH, inHome(SANDBOX_IMAGE_PATH), false],
    [UPSTASH_IMAGE_PATH, inHome(UPSTASH_IMAGE_PATH), false],
    [ROLLOUT_PATH, inHome(ROLLOUT_PATH), false],
    [join(home, ".modal.toml"), inHome(join(home, ".modal.toml")), false],
    // A Codex slot is its login; the sessions in it stay behind. The config names slots under this user's home.
    ...config.factory.sandbox.codexSlots
      .map((slot) => join(home, relative(homedir(), slot)))
      .flatMap((slot) => [slotAuthPath(slot), join(slot, "config.toml")].map((path): [string, string, boolean] => [path, inHome(path), false])),
  ];
  const missing = wanted.filter(([from, , required]) => required && !existsSync(from)).map(([from]) => from);
  if (missing.length > 0) throw new MoveError(`missing ${missing.join(", ")}; this doesn't look like a set-up live checkout`);

  const pass = await passphrase(true);
  const staging = mkdtempSync(join(tmpdir(), "factory-move-"));
  try {
    for (const [from, to] of wanted.filter(([from]) => existsSync(from))) {
      mkdirSync(dirname(join(staging, "files", to)), { recursive: true });
      copyFileSync(from, join(staging, "files", to));
      console.log(`packed ${to}`);
    }
    run("tar", ["-czf", join(staging, "bundle.tgz"), "-C", join(staging, "files"), "."]);
    openssl("-e", join(staging, "bundle.tgz"), bundle, pass);
    chmodSync(bundle, 0o600);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  // launchd loads every plist in LaunchAgents at login, so the old runner would come back with the same id.
  if (loaded && existsSync(PLIST)) unlinkSync(PLIST);
  console.log(`
wrote ${bundle}
${loaded ? `The runner on ${machine.name} is stopped and won't start at login.` : "No LaunchAgent runner was running here; make sure the runner this came from is stopped."} Don't start it
again: two runners with one machine id would both act for its jobs. Copy the bundle to the new machine,
then run bun scripts/move.ts unpack <bundle> in its clone of the live checkout (docs/moving.md).`);
  process.exit(0);
}

// --- unpack
if (!existsSync(bundle)) throw new MoveError(`no bundle at ${bundle}`);
const staging = mkdtempSync(join(tmpdir(), "factory-move-"));
try {
  openssl("-d", bundle, join(staging, "bundle.tgz"), await passphrase(false));
  mkdirSync(join(staging, "files"));
  run("tar", ["-xzf", join(staging, "bundle.tgz"), "-C", join(staging, "files")]);
  const placed = files(join(staging, "files")).map((path) => {
    const rel = relative(join(staging, "files"), path);
    const [top, ...rest] = rel.split("/");
    if ((top !== "home" && top !== "checkout") || rest.includes("..")) throw new MoveError(`the bundle holds an unexpected path, ${rel}`);
    return { path, to: join(top === "home" ? home : root, ...rest) };
  });
  const taken = placed.filter(({ to }) => existsSync(to)).map(({ to }) => to);
  if (taken.length > 0 && !args.force) throw new MoveError(`these exist already: ${taken.join(", ")}. Move them aside, or pass --force to overwrite them`);
  for (const { path, to } of placed) {
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(path, to);
    chmodSync(to, 0o600);
    console.log(`restored ${to}`);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log(`
Next, as docs/moving.md says: sign in to gh, neon and vercel, run bun install, then
${args.home ? "start the container (docs/runner-container.md)" : "bun scripts/install-runner.ts"} and bun scripts/doctor.ts, and resume new work on the panel's Queue page.`);
process.exit(0);
