import { join } from "node:path";

// The factory runner: the only process that touches T3, git and the GitHub API. It reacts to webhook intents
// through Neon Realtime, runs a plain timer for the checks that need no event, and on startup
// reconciles everything it missed while it was down. Every step is idempotent.
//   bun runner/index.ts            run as a daemon (launchd starts it this way)
//   bun runner/index.ts --once     run the startup reconcile once and exit

process.chdir(join(import.meta.dirname, ".."));
process.loadEnvFile(".env.local");

const { createRealtime } = await import("@neon/realtime/server");
const { drizzleAdapter } = await import("@neon/realtime-drizzle");
const { and, asc, eq, getTableColumns, isNull } = await import("drizzle-orm");
const { db } = await import("../db/client");
const { intents, jobs } = await import("../db/schema");
const ops = await import("./ops");
const { createBeat, inventoryCollectors, systemCollectors, thisMachine } = await import("./heartbeat");
const { closeBroadcast, deliveryFor, expirePairings, INTENT_ATTEMPTS, leaseIntent, loggable, receiptIntent, recordReceipt } = await import("./intents");
const { launchQueued } = await import("./launch");
const { openT3, tickSandboxes } = await import("./lifecycle");
const { recheckScheduler } = await import("./recheck");
const { everyAtMost, serialQueue } = await import("./queue");
const { isolated, reconcile } = await import("./reconcile");
const { stopDeliverable } = await import("./binding");
const { inferUntracked } = await import("./untracked");
const { flushLocalOutbox } = await import("./outbox");
const { approveMerge, decideMerges } = await import("./merge-decision");
const { closeJob, forwardReview, requestChanges, retryJob } = await import("./inbox");
const { confirmStops, retryStop } = await import("./stops");
const { approveDetailSchema, closeDetailSchema, feedbackDetailSchema, retryDetailSchema } = await import("../lib/inbox");
const { watchMerges } = await import("./post-merge");
const { syncOverrideLabels } = await import("./overrides");
const { baseImageIdle, rebuildBaseImage, stopBaseImage } = await import("./base-image");
const { advanceOnboarding, onboardRepo, repoPushed, requestRebuild } = await import("./onboarding");
const { repoPushDetailSchema } = await import("../lib/webhooks");
const { notifySlack, sendSlackTest, slackFromEnv } = await import("./slack");
const { keepSubscribed } = await import("./realtime");
type IntentRow = typeof intents.$inferSelect;

const machine = await thisMachine();

const log = (event: string, detail: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));

const logWorktree = (check: Record<string, unknown>) => log("worktree", check);

const queue = serialQueue(log);
// A backstop: a stray rejection is logged instead of taking the daemon down.
process.on("unhandledRejection", (reason) =>
  log("unhandledRejection", { error: reason instanceof Error ? reason.message : String(reason) }),
);
const serial = queue.serial;

/** Launches what this machine has room for, then tells each source about the jobs it now holds. */
/**
 * Write-back for every caller. A job whose source item is gone is logged once and then skipped, and
 * a failing write-back is returned for the log and the timer, never thrown, so the intent or timer
 * pass that asked for it succeeds on its own work.
 */
async function writeBackPass() {
  const result = await ops.writeBack();
  for (const { key, reason } of result.gaveUp) log("writeBack:gave-up", { key, reason });
  return result;
}

async function launchAndAnnounce() {
  const launched = await launchQueued(logWorktree);
  const announced = await isolated(ops.announceClaims);
  return announced ? { launched, announced } : { launched };
}

async function handle(intent: IntentRow) {
  // Each step reaches a source only where it needs one, so a source outage does not block the rest.
  switch (intent.kind) {
    case "claim":
      return { claimed: await ops.claim(), ...(await launchAndAnnounce()) };
    case "stop":
      return { stop: await ops.stopJob(intent.job_id!, intent.detail ?? "stopped in its source") };
    case "answer":
      return {
        resumed: await ops.resumeAnswered(),
        ...(await launchAndAnnounce()),
        synced: await writeBackPass(),
      };
    case "merged":
      return { merged: await ops.checkPullRequests(), synced: await writeBackPass() };
    case "recheck_conflicts":
      return { recheck: recheck.request() };
    case "open_t3":
      return openT3(intent.job_id!);
    case "approve_merge":
      return { approval: await approveMerge(intent.job_id!, approveDetailSchema.parse(JSON.parse(intent.detail ?? "null"))), synced: await writeBackPass() };
    case "request_changes": {
      const feedback = feedbackDetailSchema.parse(JSON.parse(intent.detail ?? "null"));
      if (feedback.from === "panel") return { changes: await requestChanges(intent.job_id, feedback) };
      // A review its job can't take yet fails this try, so the intent stays open for the retry.
      const changes = await forwardReview(intent, feedback, machine.id);
      return "waiting" in changes ? { error: `waiting: ${changes.waiting}` } : { changes };
    }
    case "close_job":
      return { close: await closeJob(intent.job_id!, closeDetailSchema.parse(JSON.parse(intent.detail ?? "null"))), synced: await writeBackPass() };
    case "onboard_repo":
      return { onboarding: await onboardRepo(intent.detail!) };
    case "rebuild_repo_image":
      return { rebuild: await requestRebuild(intent.detail!, "the owner asked for a rebuild") };
    case "repo_push":
      return { push: await repoPushed(repoPushDetailSchema.parse(JSON.parse(intent.detail ?? "null"))) };
    case "retry_stop":
      return { retry: await retryStop(intent.job_id!), synced: await writeBackPass() };
    case "retry_job": {
      const attempt = await retryJob(intent.job_id!, retryDetailSchema.parse(JSON.parse(intent.detail ?? "null")));
      return { attempt, ...("started" in attempt ? await launchAndAnnounce() : {}) };
    }
    case "slack_test":
      return sendSlackTest(JSON.parse(intent.detail ?? "null"));
    default: {
      const unhandled: never = intent.kind;
      throw new Error(`no handler for intent ${String(unhandled)}`);
    }
  }
}

const recheck = recheckScheduler({
  settled: ops.pullRequestsSettled,
  check: ops.checkPullRequests,
  enqueue: (name, step) => void serial(name, step),
  schedule: (run, ms) => void setTimeout(run, ms),
  now: Date.now,
});

const inProgress = new Set<string>();
type OpenIntent = { intent: IntentRow; owner: string | null };

function takeIntents(rows: readonly OpenIntent[]) {
  for (const { intent, owner } of rows) {
    if (intent.handled_at || inProgress.has(intent.id)) continue;
    // Every later snapshot repeats the open intents; a failed one waits for its retry time.
    if (intent.retry_at && intent.retry_at.getTime() > Date.now()) continue;
    const delivery = deliveryFor(intent.kind, owner, machine.id, slackFromEnv() !== null);
    if (delivery === "skip") continue;
    // The lease decides; this only spares a queue step while a lease is live.
    if (delivery === "lease" && intent.lease_until && intent.lease_until.getTime() > Date.now()) continue;
    inProgress.add(intent.id);
    const step: () => Promise<unknown> = delivery === "receipt" ? () => runBroadcast(intent) : () => runIntent(intent);
    // Cleared once the queue is done with the step, even if the step timed out and still runs.
    void serial(`intent:${intent.kind}`, step).finally(() => inProgress.delete(intent.id));
  }
}

async function runIntent(intent: IntentRow) {
  if (!(await leaseIntent(intent.id, machine.id))) return { id: intent.id, skipped: "leased by another machine" };
  const latencyMs = Date.now() - intent.created_at.getTime();
  const result = await handle(intent).catch((error: unknown) => ({ error: String(error) }));
  // A failed intent stays open and the timer retries it, so a source or T3 hiccup cannot eat a
  // stop. After its kind's INTENT_ATTEMPTS it is closed with the error kept in result.
  const failed = "error" in result;
  const attempts = intent.attempts + 1;
  await db
    .update(intents)
    .set({
      attempts,
      handled_at: failed && attempts < INTENT_ATTEMPTS[intent.kind] ? null : new Date(),
      // 30 s, 1 min, 2 min, ... then every 30 min: about a day of retries before it gives up.
      retry_at: failed ? new Date(Date.now() + Math.min(30_000 * 2 ** (attempts - 1), 1_800_000)) : null,
      result: JSON.stringify(result).slice(0, 2000),
      // A retry may go to any machine the route allows; a handled intent keeps the one that handled it.
      leased_by: failed ? null : machine.id,
      lease_until: null,
    })
    .where(and(eq(intents.id, intent.id), eq(intents.leased_by, machine.id)));
  return { id: intent.id, job: intent.job_id, latencyMs, attempts, ...loggable(intent.kind, result) };
}

/**
 * A broadcast runs once per machine; the receipt is taken first, so a replay on this machine only
 * tries to close it. It stays open until every online machine has a receipt, or it expires.
 */
async function runBroadcast(intent: IntentRow) {
  const fresh = await receiptIntent(intent.id, machine.id);
  const result = fresh ? await handle(intent).catch((error: unknown) => ({ error: String(error) })) : undefined;
  if (fresh) await recordReceipt(intent.id, machine.id, result);
  await closeBroadcast(intent.id);
  return { id: intent.id, receipt: fresh ? "taken" : "already taken", ...result };
}

async function openIntents(): Promise<OpenIntent[]> {
  return db
    .select({ intent: intents, owner: jobs.machine_id })
    .from(intents)
    .leftJoin(jobs, eq(jobs.id, intents.job_id))
    .where(isNull(intents.handled_at))
    .orderBy(asc(intents.created_at));
}

const startupReconcile = () => reconcile({ tick, cleanup: () => ops.cleanup(), launch: launchAndAnnounce });

/**
 * The checks that need no event, every tickSeconds. Claiming is here too because a slot frees up
 * without any webhook, and the PR check catches a conflict GitHub settled after a push's recheck.
 */
async function tick() {
  // Each check on its own: one failing (a source or GitHub down) must not skip the others this tick.
  return {
    // First, so stage reports a hook or MCP call could not deliver reach the board before anything reads it.
    outbox: await isolated(flushLocalOutbox),
    claimed: await isolated(() => ops.claim()),
    // An answer can land before its question reached the source, and its intent then finds nothing.
    resumed: await isolated(ops.resumeAnswered),
    // Stops whose webhook never arrived; before deliverStops, so a new stop is messaged this tick.
    stopsReconciled: await isolated(() => ops.reconcileStops()),
    stopsDelivered: await isolated(() => ops.deliverStops()),
    pullRequests: await isolated(ops.checkPullRequests),
    // Before the merge decisions, so a run that just opened its PR is decided on its latest cost.
    reconciled: await isolated(ops.reconcileUsage),
    // After the usage reconcile, so the spend it compares with each limit is this tick's.
    spendLimits: await isolated(() => ops.enforceSpendLimits()),
    // After the PR check, so a merged or conflicting PR has already left pr.
    mergeDecisions: await isolated(() => decideMerges()),
    mainWatched: await isolated(() => watchMerges()),
    // Harnesses without hooks report no stage or PR; read them from GitHub and the thread instead.
    untracked: await isolated(() => inferUntracked()),
    watched: await isolated(ops.watchdog),
    // After the stops and the PR check, so a finished job gives its slot back before this tick's launches.
    sandboxes: await isolated(tickSandboxes),
    // After teardown, which records a stopped sandbox's end; a confirmed stop frees its capacity before this tick's launches.
    stopsConfirmed: await isolated(() => confirmStops()),
    pairingsExpired: await isolated(expirePairings),
    synced: await isolated(writeBackPass),
    // Starts a rebuild when the pins drifted and returns; the build runs beside the queue.
    baseImage: await isolated(async () =>
      rebuildBaseImage({
        changed: () => void beat({ fresh: true }),
        // Queued Modal jobs would otherwise wait for the next tick.
        landed: () => void serial("launch", launchAndAnnounce),
      }),
    ),
  };
}

const beat = createBeat({
  machine,
  heartbeatCollectors: systemCollectors(async () => ({
    max: ops.config.factory.maxInFlight,
    inFlight: await ops.machineInFlight(machine.id),
  })),
  inventoryCollectors: inventoryCollectors(),
  inventoryMs: ops.config.factory.inventoryMinutes * 60_000,
  log,
});

// The startup beat marks this machine online at once; the slower inventory waits until the reconcile is done.
if (process.argv.includes("--once")) {
  await beat({ inventory: false });
  await serial("registry", ops.registerCheckouts);
  await serial("reconcile", startupReconcile);
  if (slackFromEnv()) await serial("slack", () => notifySlack());
  takeIntents(await openIntents());
  await queue.idle();
  // A rebuild the reconcile started is this run's to finish, with the launch it queues when it lands.
  await baseImageIdle();
  await queue.idle();
  await beat();
  process.exit(0);
}

log("start", { pid: process.pid, tickSeconds: ops.config.factory.tickSeconds, machine });
await beat({ inventory: false });
setInterval(() => void beat(), ops.config.factory.tickSeconds * 1000);
// Before the first claim, so a fresh install has its checkouts registered and a default repo.
await serial("registry", ops.registerCheckouts);
await serial("reconcile", startupReconcile);
void beat();
takeIntents(await openIntents());

const connectRealtime = () =>
  createRealtime({
    url: process.env.NEON_REALTIME_URL!,
    secret: process.env.NEON_REALTIME_SECRET!,
    db: new URL(process.env.DATABASE_URL!).pathname.slice(1),
    adapter: drizzleAdapter(),
    logLevel: "warn",
    logger: (entry) => log("realtime:diagnostic", { diagnostic: entry.event, ...("error" in entry && { error: String(entry.error) }) }),
  });
type Realtime = ReturnType<typeof connectRealtime>;

/**
 * Realtime does not promise every change, so a snapshot is read as the current state: open
 * intents are taken, and this machine's jobs whose stage has not reached their source yet get a
 * write-back. An intent snapshot only says something changed; the intents are read again with
 * their job's owner, which routing needs.
 */
async function subscribe(realtime: Realtime) {
  const intentsLive = await realtime.subscribe(
    db.select(getTableColumns(intents)).from(intents).where(isNull(intents.handled_at)).orderBy(asc(intents.created_at)),
  );
  intentsLive.onChange((snapshot) => {
    if (snapshot.status === "live") void openIntents().then(takeIntents);
  });
  const jobsLive = await realtime.subscribe(db.select(getTableColumns(jobs)).from(jobs).where(eq(jobs.machine_id, machine.id)));
  jobsLive.onChange((snapshot) => {
    if (snapshot.status !== "live") return;
    const rows = snapshot.data ?? [];
    if (rows.some((i) => i.stage_event_id && i.stage_event_id !== i.synced_event_id)) {
      void serial("writeBack", writeBackPass);
    }
    // A thread's own session start can bind it (ingest), outside bindThread; deliver its stop now.
    if (rows.some(stopDeliverable)) void serial("deliverStops", () => ops.deliverStops());
  });
  return [intentsLive, jobsLive];
}
const realtime = keepSubscribed({
  connect: connectRealtime,
  subscribe,
  log: (detail) => log("realtime", detail),
  schedule: (run, ms) => void setTimeout(run, ms),
});
await realtime.start();

const hourlyCleanup = everyAtMost(3_600_000, () => ops.cleanup());
const labelSync = ops.config.factory.syncLinearLabels ? everyAtMost(86_400_000, () => syncOverrideLabels()) : undefined;
if (ops.config.factory.syncLinearLabels) void serial("labelSync", () => syncOverrideLabels());
setInterval(() => {
  void serial("tick", async () => {
    const result = { ...(await tick()), ...(await launchAndAnnounce()) };
    const cleaned = await hourlyCleanup();
    const labels = await labelSync?.();
    return { ...result, ...(cleaned !== undefined && { cleaned }), ...(labels !== undefined && { labels }) };
  });
  // Its own step, so a snapshot that takes minutes never pushes the tick past its timeout.
  void serial("onboarding", () => advanceOnboarding());
  // After the tick's merge decisions and stop checks, so the inbox it reads is this tick's; its own step, so a slow Slack delays nothing.
  if (slackFromEnv()) void serial("slack", () => notifySlack());
  // Intents the subscription may not have delivered.
  void openIntents().then(takeIntents);
}, ops.config.factory.tickSeconds * 1000);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log("stop", { signal });
    realtime.close();
    // A rebuild in flight is ended, not waited for: the next start builds again from the tick.
    void Promise.all([queue.idle(), stopBaseImage()]).finally(() => process.exit(0));
  });
}
