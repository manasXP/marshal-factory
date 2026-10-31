import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { CONFIG_PATH, DEFAULT_CONFIG_PATH, secretsFromEnv } from "./config";
import { MAX_BATCH, type FactoryEvent } from "./events";
import { inTestMode } from "./test-mode";

// Every event a hook or the factory-report MCP server sends is written here before it is posted,
// one JSON file per event named so that names sort oldest first. A 2xx removes the file; anything
// else leaves it for the next flush: the next hook or MCP call, or the runner, which reaches the
// local outbox on each tick and a sandbox's before it hibernates or ends and when it wakes. Ingest
// stores each eventId once, so delivering an event twice changes nothing.

/** `$FACTORY_STATE_DIR`, else ~/.local/state/marshal-factory; in a sandbox that is under /root, which snapshots keep. */
export const stateDir = (home = homedir(), env: Readonly<Record<string, string | undefined>> = process.env) => env.FACTORY_STATE_DIR || join(home, ".local/state/marshal-factory");
export const outboxDir = (state: string) => join(state, "outbox");
/** Events ingest refused as invalid; a retry would be refused again, so they wait here for a human. */
export const rejectedDir = (state: string) => join(state, "outbox-rejected");
const droppedLog = (state: string) => join(state, "outbox-dropped.log");

/** A batch stops growing past this much JSON, so a few screenshots never make one request too large; one event always goes. */
export const MAX_BATCH_CHARS = 4_000_000;

/** Past this many undelivered events every append warns. */
export const HIGH_WATER = 1_000;
/** Past this many the oldest are dropped, each one logged with its id and kind. */
export const HARD_CAP = 10_000;

export type OutboxFs = {
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
};

/** This machine's files; a JobHost is an OutboxFs too, so the runner flushes a sandbox's outbox the same way. */
export const localFs: OutboxFs = {
  exists: async (path) => stat(path).then(() => true, () => false),
  list: (dir) => readdir(dir),
  readFile: (path) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error))),
  writeFile: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  },
  remove: (path) => rm(path, { force: true }),
};

let appended = 0;
const pending = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".json")).sort();

export type AppendResult = { file: string; pending: number; dropped: string[] };

/**
 * Writes the event to the outbox before anyone posts it. The write is a rename, so a flush in
 * another process never reads half an event.
 */
export function appendEvent(
  state: string,
  event: FactoryEvent,
  { warn = (m) => process.stderr.write(`${m}\n`), highWater = HIGH_WATER, hardCap = HARD_CAP }: { warn?: (message: string) => void; highWater?: number; hardCap?: number } = {},
): AppendResult {
  const dir = outboxDir(state);
  mkdirSync(dir, { recursive: true });
  const name = `${String(Date.now()).padStart(15, "0")}-${process.pid}-${String(appended++).padStart(6, "0")}.json`;
  const temp = join(dir, `.${name}.tmp`);
  writeFileSync(temp, JSON.stringify(event));
  renameSync(temp, join(dir, name));
  const names = pending(dir);
  const dropped: string[] = [];
  if (names.length > hardCap) {
    for (const old of names.slice(0, names.length - hardCap)) {
      let text: string;
      try {
        text = readFileSync(join(dir, old), "utf8");
      } catch {
        // A flush delivered it meanwhile.
        continue;
      }
      const { eventId, kind } = JSON.parse(text) as FactoryEvent;
      dropped.push(eventId);
      appendFileSync(droppedLog(state), `${new Date().toISOString()} dropped ${kind} ${eventId} (outbox over ${hardCap})\n`);
      rmSync(join(dir, old), { force: true });
    }
    warn(`marshal-factory outbox: dropped ${dropped.length} undelivered events past ${hardCap}; see ${droppedLog(state)}`);
  } else if (names.length > highWater) {
    warn(`marshal-factory outbox: ${names.length} undelivered events in ${dir}; ingest has not answered for a while`);
  }
  return { file: name, pending: names.length - dropped.length, dropped };
}

export type Delivery = { kind: "delivered"; spend?: Record<string, number> } | { kind: "rejected"; reason: string } | { kind: "failed"; reason: string };
export type Send = (events: FactoryEvent[], timeoutMs: number) => Promise<Delivery>;

const TEST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Posts a batch to ingest. A 400 is a body ingest will never take; anything else may pass later. */
export const httpSend =
  (ingestUrl: string, secret: string): Send =>
  async (events, timeoutMs) => {
    if (inTestMode() && !TEST_HOSTS.has(new URL(ingestUrl).hostname)) throw new Error("the deployed ingest URL was called during a regression run");
    try {
      const res = await fetch(ingestUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify(events),
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      });
      if (res.ok) return { kind: "delivered", spend: ((await res.json()) as { spend?: Record<string, number> }).spend };
      const reason = `ingest answered ${res.status}`;
      return res.status === 400 ? { kind: "rejected", reason } : { kind: "failed", reason };
    } catch (error) {
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  };

export type FlushResult = {
  delivered: number;
  /** Event ids ingest refused as invalid, moved to the rejected dir. */
  rejected: string[];
  /** Undelivered events still queued. */
  left: number;
  /** Event ids ingest refused that could not be moved aside; they stay queued and the flush goes on. */
  stuck: string[];
  /** Ingest's spend per branch, merged over the batches. */
  spend: Record<string, number>;
  error?: string;
};

type Queued = { name: string; event: FactoryEvent };

/**
 * Delivers the outbox oldest first, in batches, until it is empty, a delivery fails or `budgetMs`
 * runs out. A failure stops the flush so nothing overtakes an earlier event. A refused batch is
 * retried one event at a time, and only the events ingest refuses on their own are set aside.
 */
export async function flushOutbox(fs: OutboxFs, state: string, send: Send, { budgetMs, batchSize = 50, maxChars = MAX_BATCH_CHARS }: { budgetMs: number; batchSize?: number; maxChars?: number }): Promise<FlushResult> {
  const deadline = Date.now() + budgetMs;
  const dir = outboxDir(state);
  const result: FlushResult = { delivered: 0, rejected: [], left: 0, stuck: [], spend: {} };
  if (!(await fs.exists(dir))) return result;
  const names = (await fs.list(dir)).filter((name) => name.endsWith(".json")).sort();
  result.left = names.length;

  const settle = async (batch: Queued[], delivery: Extract<Delivery, { kind: "delivered" }>) => {
    for (const { name } of batch) await fs.remove(join(dir, name));
    result.delivered += batch.length;
    result.left -= batch.length;
    Object.assign(result.spend, delivery.spend);
  };
  // A refused event never delivers, so one that cannot be moved aside stays queued without holding back the events after it.
  const setAside = async ({ name, event }: Queued) => {
    try {
      await fs.writeFile(join(rejectedDir(state), name), JSON.stringify(event));
    } catch {
      result.stuck.push(event.eventId);
      return;
    }
    await fs.remove(join(dir, name));
    result.rejected.push(event.eventId);
    result.left--;
  };

  const size = Math.min(batchSize, MAX_BATCH);
  for (let at = 0; at < names.length; ) {
    if (Date.now() >= deadline) break;
    const batch: Queued[] = [];
    let chars = 0;
    for (; at < names.length && batch.length < size; at++) {
      const name = names[at]!;
      const text = await fs.readFile(join(dir, name));
      // Another flush delivered it in the meantime.
      if (text === null) {
        result.left--;
        continue;
      }
      if (batch.length > 0 && chars + text.length > maxChars) break;
      chars += text.length;
      batch.push({ name, event: JSON.parse(text) as FactoryEvent });
    }
    if (batch.length === 0) continue;
    const delivery = await send(batch.map((q) => q.event), deadline - Date.now());
    switch (delivery.kind) {
      case "delivered":
        await settle(batch, delivery);
        break;
      case "rejected":
        if (batch.length === 1) {
          await setAside(batch[0]!);
          break;
        }
        for (const one of batch) {
          const alone = await send([one.event], deadline - Date.now());
          if (alone.kind === "delivered") await settle([one], alone);
          else if (alone.kind === "rejected") await setAside(one);
          else return { ...result, error: alone.reason };
        }
        break;
      case "failed":
        return { ...result, error: delivery.reason };
      default: {
        const never: never = delivery;
        throw new Error(`unknown delivery ${String(never)}`);
      }
    }
  }
  return result;
}

/** The live checkout's .env.local, which the hooks run from on the runner's Mac; a sandbox's bundles have none beside them. */
const CHECKOUT_ENV_PATH = join(import.meta.dirname, "../.env.local");

/**
 * Where the hooks and the MCP server report: the factory config, as a sandbox's runner-written one says,
 * else the live checkout's .env.local, parsed and never loaded, so a check command can't inherit its
 * secrets. Only the default config falls back, so a test's own config never reports to production.
 * Undefined when neither names somewhere.
 */
export function readIngestTarget(path = CONFIG_PATH, envPath = path === DEFAULT_CONFIG_PATH && !inTestMode() ? CHECKOUT_ENV_PATH : undefined) {
  const config = (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}) as { ingestUrl?: string; secret?: string };
  const fromEnv: { ingestUrl?: string; secret?: string } = envPath && existsSync(envPath) ? secretsFromEnv(parseEnv(readFileSync(envPath, "utf8"))) : {};
  const ingestUrl = config.ingestUrl ?? fromEnv.ingestUrl;
  const secret = config.secret ?? fromEnv.secret;
  return ingestUrl && secret ? { ingestUrl, secret } : undefined;
}

/**
 * What a hook or MCP call does: queue its events, then flush the whole outbox, oldest first, within
 * `budgetMs`. Undefined when this machine has no ingest config, as in a sandbox for onboarding.
 */
export async function reportEvents(events: readonly FactoryEvent[], budgetMs: number) {
  const target = readIngestTarget();
  if (!target) return undefined;
  const state = stateDir();
  for (const event of events) appendEvent(state, event);
  return flushOutbox(localFs, state, httpSend(target.ingestUrl, target.secret), { budgetMs });
}
