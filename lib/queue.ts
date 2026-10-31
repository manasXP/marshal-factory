import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import { auditLog, backlog, intents, jobs, queueControls, queueState, type QueueControlRow } from "@/db/schema";
import { isOwner, type SessionUser } from "@/lib/auth/owner";
import type { JobId, JobSource } from "@/lib/sources/shapes";

// The owner's hold over new work. A pause stops every runner claiming and launching queued jobs;
// jobs already working carry on, answer questions and merge. The queue is what is waiting to start:
// claimed jobs no machine has launched yet, then the backlog of labeled work no runner has claimed,
// which the claim pass records each time it reads a source. The owner can move queued work to the
// front, hold it back, or take it out of the queue by removing its factory label at the source.

export const QUEUE_STATE_ID = "factory";

type Db = NodePgDatabase<typeof schema>;

/** Anything that reads like the database, a transaction included. */
type Reader = Pick<Db, "select">;

export async function readPause(database: Reader) {
  const [row] = await database.select().from(queueState).where(eq(queueState.id, QUEUE_STATE_ID));
  return row?.paused_at ? { at: row.paused_at, by: row.updated_by } : null;
}

export const readQueueControls = (database: Db): Promise<QueueControlRow[]> => database.select().from(queueControls);

export const heldIds = (controls: readonly QueueControlRow[]) => new Set<string>(controls.filter((c) => c.held_at).map((c) => c.job_id));

const frontTimes = (controls: readonly QueueControlRow[]) =>
  new Map<string, number>(controls.flatMap((c) => (c.front_at ? [[c.job_id, c.front_at.getTime()] as const] : [])));

/** Queued work in the order it starts: moved to the front first, the latest move leading, then each in its own order. */
export function inQueueOrder<T>(items: readonly T[], idOf: (item: T) => string, controls: readonly QueueControlRow[]): T[] {
  const front = frontTimes(controls);
  return items
    .map((item, index) => ({ item, index, front: front.get(idOf(item)) ?? -Infinity }))
    .sort((a, b) => (a.front === b.front ? a.index - b.index : b.front - a.front))
    .map((e) => e.item);
}

/**
 * The launch entries to start now, in queue order: a queued job only while nothing is paused and it
 * is not held. An answered job whose thread died relaunches regardless, since it is not new work.
 */
export function launchable<T extends { job: { id: string; stage: string } }>(entries: readonly T[], paused: boolean, controls: readonly QueueControlRow[]): T[] {
  const held = heldIds(controls);
  return inQueueOrder(entries, (e) => e.job.id, controls).filter((e) => e.job.stage !== "queued" || (!paused && !held.has(e.job.id)));
}

/** A claimed job no machine has started yet; only these are held back by a hold or the pause. */
export const unlaunchedSql = and(eq(jobs.stage, "queued"), isNull(jobs.t3_thread_id), isNull(jobs.machine_id));

/** True for a job id the owner holds back; capacity counts leave such a job out, since it will not launch. */
export const heldSql = sql`exists (select 1 from ${queueControls} where ${queueControls.job_id} = ${jobs.id} and ${queueControls.held_at} is not null)`;

/** True while new work is paused; the launch's compare-and-set reads it, so a pause lands mid-pass. */
export const pausedSql = sql`exists (select 1 from ${queueState} where ${queueState.paused_at} is not null)`;

/** A control outlives a source that stops offering its item for a while (Linear lists 50), then goes. */
const STALE_CONTROL_MS = 7 * 86_400_000;

export type BacklogEntry = { id: JobId; source: JobSource; externalId: string; key: string; title: string; url: string; repo: string | null };

/**
 * Replaces the backlog of the sources this pass read with what they offer that no runner can claim
 * yet; the caller leaves out what a runner holds. Each item keeps its place in its own source's
 * order. A source whose read failed keeps its rows, and an unchanged row is not written. Controls go
 * once their job has started or ended, or when nothing has offered or queued their work for a week.
 */
export async function recordBacklog(database: Db, read: readonly JobSource[], waiting: readonly BacklogEntry[], at: Date) {
  await database.transaction(async (tx) => {
    const rows = read.flatMap((source) =>
      waiting
        .filter((w) => w.source === source)
        .map(({ externalId, ...w }, position) => ({ ...w, external_id: externalId, position, first_seen_at: at })),
    );
    if (rows.length > 0) {
      const changed = sql`(${backlog.key}, ${backlog.title}, ${backlog.url}, ${backlog.repo}, ${backlog.position}) is distinct from (excluded.key, excluded.title, excluded.url, excluded.repo, excluded.position)`;
      await tx
        .insert(backlog)
        .values(rows)
        .onConflictDoUpdate({
          target: backlog.id,
          set: { key: sql`excluded.key`, title: sql`excluded.title`, url: sql`excluded.url`, repo: sql`excluded.repo`, position: sql`excluded.position` },
          setWhere: changed,
        });
    }
    const ids = rows.map((r) => r.id);
    if (read.length > 0) await tx.delete(backlog).where(and(inArray(backlog.source, [...read]), ids.length > 0 ? notInArray(backlog.id, ids) : undefined));
    const queued = tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.stage, "queued"));
    await tx
      .delete(queueControls)
      .where(
        or(
          inArray(queueControls.job_id, tx.select({ id: jobs.id }).from(jobs).where(notInArray(jobs.stage, ["queued", "failed"]))),
          and(
            lt(queueControls.updated_at, new Date(at.getTime() - STALE_CONTROL_MS)),
            notInArray(queueControls.job_id, tx.select({ id: backlog.id }).from(backlog)),
            notInArray(queueControls.job_id, queued),
          ),
        ),
      );
  });
}

export type QueueItem = {
  id: JobId;
  source: JobSource;
  key: string;
  title: string;
  url: string;
  repo: string | null;
  /** Claimed jobs start before any backlog item is claimed. */
  claimed: boolean;
  /** When it was claimed, or first seen in the backlog. */
  since: Date;
  front: boolean;
  held: boolean;
};

/** The pause and the queue in the order work starts: claimed jobs first, then the backlog, by source in the order claims read them. */
export async function readQueue(database: Db, sourceOrder: readonly JobSource[]) {
  const [pause, controls, claimed, waiting] = await Promise.all([
    readPause(database),
    readQueueControls(database),
    database
      .select({ id: jobs.id, source: jobs.source, key: jobs.key, title: jobs.title, url: jobs.url, repo: jobs.repo, since: jobs.claimed_at })
      .from(jobs)
      .where(unlaunchedSql)
      .orderBy(asc(jobs.claimed_at), asc(jobs.key)),
    database.select().from(backlog).orderBy(asc(backlog.position), asc(backlog.key)),
  ]);
  const held = heldIds(controls);
  const front = frontTimes(controls);
  const rank = (source: string) => (sourceOrder.includes(source as JobSource) ? sourceOrder.indexOf(source as JobSource) : sourceOrder.length);
  waiting.sort((a, b) => rank(a.source) - rank(b.source));
  const item = (claimedJob: boolean) => (r: Omit<QueueItem, "claimed" | "front" | "held">): QueueItem => ({
    ...r,
    claimed: claimedJob,
    front: front.has(r.id),
    held: held.has(r.id),
  });
  const byId = (i: QueueItem) => i.id;
  return {
    pause,
    items: [
      ...inQueueOrder(claimed.map((r) => item(true)({ ...r, id: r.id as JobId, source: r.source as JobSource })), byId, controls),
      ...inQueueOrder(
        waiting.map((r) => item(false)({ id: r.id, source: r.source, key: r.key, title: r.title, url: r.url, repo: r.repo, since: r.first_seen_at })),
        byId,
        controls,
      ),
    ],
  };
}

export type QueueDeps = {
  db: Db;
  user: () => Promise<SessionUser | null | undefined>;
  /** Removes the factory label at the item's source; see SourceAdapter.dequeue. */
  dequeue: (source: JobSource, externalId: string) => Promise<void>;
  now?: () => Date;
};

export type QueueOutcome = { ok: true } | { ok: false; message: string };

const OWNER_ONLY = "Only the factory owner can change the queue.";

/** Asks any runner for a claim pass, which also launches, so a resume or a release starts work at once. */
const claimIntent = (at: Date) => ({ id: `panel:claim:${randomUUID()}`, kind: "claim" as const, created_at: at });

/** Pauses or resumes new work for every runner; pausing again keeps the first pause's time. */
export async function setPaused(deps: QueueDeps, paused: boolean): Promise<QueueOutcome> {
  const user = await deps.user();
  if (!isOwner(user)) return { ok: false, message: OWNER_ONLY };
  const at = (deps.now ?? (() => new Date()))();
  await deps.db.transaction(async (tx) => {
    await tx
      .insert(queueState)
      .values({ id: QUEUE_STATE_ID, paused_at: paused ? at : null, updated_at: at, updated_by: user!.email })
      .onConflictDoUpdate({
        target: queueState.id,
        set: { paused_at: paused ? sql`coalesce(${queueState.paused_at}, ${at})` : null, updated_at: at, updated_by: user!.email },
      });
    if (!paused) await tx.insert(intents).values(claimIntent(at));
  });
  return { ok: true };
}

export const QUEUE_CHANGES = ["front", "hold", "release", "remove"] as const;
export type QueueChange = (typeof QUEUE_CHANGES)[number];

const CHANGE_DETAIL: Record<QueueChange, string> = {
  front: "Moved to the front of the queue.",
  hold: "Held in the queue.",
  release: "Released in the queue.",
  remove: "Taken out of the queue; the factory label was removed at its source.",
};

/** Moves queued work to the front, holds or releases it, or removes its factory label at the source. */
export async function changeQueue(deps: QueueDeps, jobId: string, change: QueueChange): Promise<QueueOutcome> {
  const user = await deps.user();
  if (!isOwner(user)) return { ok: false, message: OWNER_ONLY };
  if (!(QUEUE_CHANGES as readonly string[]).includes(change)) return { ok: false, message: "That is not a queue change." };
  const [inBacklog] = await deps.db.select().from(backlog).where(eq(backlog.id, jobId as JobId));
  const [claimed] = inBacklog ? [] : await deps.db.select().from(jobs).where(and(eq(jobs.id, jobId as JobId), unlaunchedSql));
  const item = inBacklog ? { id: inBacklog.id, source: inBacklog.source, externalId: inBacklog.external_id, url: inBacklog.url } : claimed && { id: claimed.id as JobId, source: claimed.source as JobSource, externalId: claimed.external_id, url: claimed.url };
  if (!item) return { ok: false, message: "That work is no longer queued." };
  const at = (deps.now ?? (() => new Date()))();
  if (change === "remove") {
    try {
      await deps.dequeue(item.source, item.externalId);
    } catch (error) {
      return { ok: false, message: `Could not remove the factory label: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  await deps.db.transaction(async (tx) => {
    if (change === "remove" && !claimed) {
      await tx.delete(backlog).where(eq(backlog.id, item.id));
      await tx.delete(queueControls).where(eq(queueControls.job_id, item.id));
    } else if (change === "remove") {
      // The stop reaches the runner after this; held meanwhile, the job cannot start before it does.
      const set = { held_at: at };
      await tx
        .insert(queueControls)
        .values({ job_id: item.id, ...set, updated_at: at, updated_by: user!.email })
        .onConflictDoUpdate({ target: queueControls.job_id, set: { ...set, updated_at: at, updated_by: user!.email } });
    } else {
      const set = change === "front" ? { front_at: at } : { held_at: change === "hold" ? at : null };
      await tx
        .insert(queueControls)
        .values({ job_id: item.id, ...set, updated_at: at, updated_by: user!.email })
        .onConflictDoUpdate({ target: queueControls.job_id, set: { ...set, updated_at: at, updated_by: user!.email } });
    }
    if (change === "release") await tx.insert(intents).values(claimIntent(at));
    await tx.insert(auditLog).values({
      id: `queue:${change}:${randomUUID()}`,
      at,
      actor: user!.email,
      action: "queue_changed",
      job_id: item.id,
      target: item.url,
      head_sha: "",
      result: "ok",
      detail: CHANGE_DETAIL[change],
    });
  });
  return { ok: true };
}
