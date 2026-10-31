import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";

const { db } = await import("../db/client");
const { jobs } = await import("../db/schema");
const { jobId } = await import("../lib/sources");
const { linearJob } = await import("./fixtures");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { claimConflict, unclaimedRunsWithPr } = await import("../lib/conflicts");
const { runs } = await import("../db/schema");
const { checkPullRequests, pullRequestsSettled, threads } = await import("../runner/ops");
const { github } = await import("../lib/github/pulls");
type PullRequest = Awaited<ReturnType<typeof github.pullRequest>>;

const id = `conflict-regress-${Date.now()}`;
const jid = jobId("linear", id);
// Its key sorts first, so the pass meets the bad PR before the conflicting one.
const bad = { id: jobId("linear", `${id}-bad`), url: "not a pull request url" };
await db.insert(jobs).values(linearJob(id, id, { stage: "pr", machine_id: TEST_MACHINE_ID }));
try {
  assert.equal(await claimConflict(db, jid, "head-1"), true, "a new conflicting head is sent back");
  assert.equal(await claimConflict(db, jid, "head-1"), false, "the same head is never sent back twice");
  await db.update(jobs).set({ stage: "implementing" }).where(eq(jobs.id, jid));
  assert.equal(await claimConflict(db, jid, "head-2"), false, "a job that left pr is not sent back");
  await db.update(jobs).set({ stage: "pr" }).where(eq(jobs.id, jid));
  assert.equal(await claimConflict(db, jid, "head-2"), true, "a later head that conflicts again is sent back");
  const at = new Date();
  const loose = { session_id: `${id}-loose`, job_key: `${id}-LOOSE`, pr_url: "https://x/pull/1", stage: "pr" as const, started_at: at, last_event_at: at };
  await db.insert(runs).values([loose, { ...loose, session_id: `${id}-claimed`, job_key: id }]);
  const picked = (await unclaimedRunsWithPr(db)).map((r) => r.session_id);
  assert.ok(picked.includes(`${id}-loose`), "a hand-started run with a PR is checked for a merge");
  assert.ok(!picked.includes(`${id}-claimed`), "a claimed job's run is left to the job path");

  const prUrl = `https://github.com/ski043/factory-demo/pull/${Date.now()}`;
  await db.update(jobs).set({ stage: "pr", pr_url: prUrl, conflict_head: null, t3_thread_id: "thread-1" }).where(eq(jobs.id, jid));
  let ours: PullRequest = { state: "open", mergeable: "unknown", headSha: "head-3", title: "t" };
  github.pullRequest = async (url) => {
    if (url === bad.url) throw new Error(`${url} is not a GitHub pull request URL`);
    if (url === loose.pr_url) return { state: "merged", mergeable: "unknown", headSha: "loose", title: "t" };
    return url === prUrl ? ours : { state: "open", mergeable: "mergeable", headSha: "other", title: "t" };
  };
  const sent: string[] = [];
  threads.state = async () => "running";
  threads.send = async (threadId) => void sent.push(threadId);
  assert.equal(await pullRequestsSettled(), false, "an unknown mergeable keeps a recheck waiting");
  ours = { ...ours, mergeable: "conflicting" };
  assert.equal(await pullRequestsSettled(), true, "a computed mergeable settles it");

  await db.insert(jobs).values(linearJob(`${id}-bad`, `bad-${id}`, { stage: "pr", pr_url: bad.url, machine_id: TEST_MACHINE_ID }));

  const first = await checkPullRequests({ only: [id, `bad-${id}`, `${id}-LOOSE`] });
  assert.deepEqual(sent, ["thread-1"], "a bad PR earlier in the pass does not stop the conflicting one from being sent back");
  assert.equal((await db.select().from(jobs).where(eq(jobs.id, jid)))[0]!.conflict_head, "head-3", "the head is claimed");
  const errorFor = (result: typeof first, key: string) => result.errors.find((e) => e.key === key)?.error;
  assert.match(errorFor(first, `bad-${id}`) ?? "", /not a GitHub pull request URL/, "the bad PR is reported with its error");
  assert.match(errorFor(first, id) ?? "", /deployed ingest function/, "the sent-back PR then posts implementing");
  assert.match(errorFor(first, loose.job_key) ?? "", /deployed ingest function/, "and the hand-started runs are still checked for a merge");

  const second = await checkPullRequests({ only: [id, `bad-${id}`, `${id}-LOOSE`] });
  assert.deepEqual(second.conflicts, [], "a second pass over the same head does nothing");
  assert.equal(errorFor(second, id), undefined, "and has nothing to post for it");
  assert.deepEqual(sent, ["thread-1"], "and sends nothing");

  // A failed job's closed PR is fetched once, then left alone until a merge webhook looks again.
  const closedUrl = `https://github.com/ski043/factory-demo/pull/${Date.now() + 1}`;
  await db.insert(jobs).values(linearJob(`${id}-closed`, `closed-${id}`, { stage: "failed", pr_url: closedUrl, machine_id: TEST_MACHINE_ID }));
  let closedFetches = 0;
  github.pullRequest = async (url) => {
    if (url === closedUrl) closedFetches++;
    return { state: "closed", mergeable: "unknown", headSha: "closed", title: "t" };
  };
  await checkPullRequests({ only: [`closed-${id}`] });
  await checkPullRequests({ only: [`closed-${id}`] });
  assert.equal(closedFetches, 1, "a closed PR is not fetched again on the next pass");
  await checkPullRequests({ only: [`closed-${id}`], recheckClosed: true });
  assert.equal(closedFetches, 2, "a merge webhook's pass looks at closed PRs again");
  console.log("conflict regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(jobs).where(inArray(jobs.id, [jid, bad.id, jobId("linear", `${id}-closed`)]));
  await db.delete(runs).where(inArray(runs.session_id, [`${id}-loose`, `${id}-claimed`]));
  process.exit(process.exitCode ?? 0);
}
