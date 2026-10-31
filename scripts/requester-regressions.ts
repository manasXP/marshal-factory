import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";

const { db } = await import("../db/client");
const { jobFilings, jobs } = await import("../db/schema");
const ops = await import("../runner/ops");
const { config } = await import("../runner/config");
const { jobId, SOURCES } = await import("../lib/sources");
const { createLinearAdapter } = await import("../lib/sources/linear");
const { issueRequester } = await import("../lib/sources/github");
const { factorySchema } = await import("../lib/config");
const { recordFiling } = await import("../lib/requester");
const { isRequestedBy, mineOnly, requesterName } = await import("../lib/requester-filter");

// Who a job is for: the claim takes the source's assignee, else the owner who filed it from the
// panel, else the issue's creator, and works it out again on every claim.

const REPO = "ski043/factory-demo";
const stamp = Date.now() % 1_000_000;
const KEY = (n: number) => `REQ-${stamp * 10 + n}`;
const node = (n: number, people: { assignee?: string; creator?: string }) => ({
  id: `req-${stamp}-${n}`,
  identifier: KEY(n),
  title: `requester ${n}`,
  url: `https://linear.app/${KEY(n)}`,
  description: null,
  createdAt: `2026-10-31T00:00:0${n}Z`,
  state: { name: "Todo", type: "unstarted" },
  labels: { nodes: [{ name: "factory" }] },
  assignee: people.assignee ? { email: people.assignee } : null,
  creator: people.creator ? { email: people.creator } : null,
});
const FACTORY = "factory-key-owner@example.com";
let readyNodes = [
  node(1, { assignee: "Asha@Example.com", creator: "creator@example.com" }),
  node(2, { creator: FACTORY }),
  node(3, { creator: "creator@example.com" }),
  node(4, {}),
];
const ids = [1, 2, 3, 4].map((n) => jobId("linear", `req-${stamp}-${n}`));
const fakeClient = {
  readyIssues: async () => readyNodes,
  team: async () => ({ id: "T1", states: [] }),
};
SOURCES.linear = createLinearAdapter(() => ({ client: fakeClient as never, db, limits: factorySchema.parse({}) }));
// The test branch copies production, whose enabled repos the GitHub source would list for real.
SOURCES.github = { ...SOURCES.github, ready: async () => [] };
config.factory.maxInFlight = 100;

const requestedBy = async (n: number) => (await db.select({ requested_by: jobs.requested_by }).from(jobs).where(eq(jobs.id, ids[n - 1]!)))[0]?.requested_by;

try {
  // GitHub has logins, not emails, and the App's own issues leave the creator to job_filings.
  const app = "marshal-factory-you[bot]";
  assert.deepEqual(issueRequester({ user: { login: "dev", type: "User" }, assignees: [{ login: "lead" }, { login: "other" }] }, app), { assignee: "lead", creator: "dev" }, "the first assignee, and the author");
  assert.deepEqual(issueRequester({ user: { login: app, type: "Bot" }, assignees: [] }, app), { assignee: null, creator: null }, "an issue the App filed names nobody");
  assert.deepEqual(issueRequester({ user: { login: "dependabot[bot]", type: "Bot" } }, app), { assignee: null, creator: "dependabot[bot]" }, "another bot is still its creator");

  assert.equal(mineOnly("me", "all"), true, "?by wins over the cookie");
  assert.equal(mineOnly(undefined, "me"), true, "the cookie remembers Mine");
  assert.equal(mineOnly("bogus", undefined), false, "everyone's by default");
  assert.equal(isRequestedBy({ requested_by: "Asha@Example.com" }, "asha@example.com"), true, "emails match without case");
  assert.equal(isRequestedBy({ requested_by: null }, "asha@example.com"), false);
  assert.deepEqual([requesterName("asha@example.com"), requesterName("lead")], ["asha", "lead"]);

  // The panel filed REQ-2 with the factory's key before the runner read it.
  await recordFiling(db, KEY(2), "filer@example.com");
  const claimed = await ops.claim({ repos: async () => [REPO], registry: async () => [] });
  for (const n of [1, 2, 3, 4]) assert.ok(claimed.claimed.includes(KEY(n)), `REQ-${n} is claimed`);
  assert.equal(await requestedBy(1), "Asha@Example.com", "the assignee wins over the creator");
  assert.equal(await requestedBy(2), "filer@example.com", "the panel's filer wins over the factory's own account");
  assert.equal(await requestedBy(3), "creator@example.com", "without either, the creator");
  assert.equal(await requestedBy(4), null, "and nobody when the source names nobody");

  // A filing recorded after the claim read the source still lands on the job.
  await recordFiling(db, KEY(3), "late@example.com");
  assert.equal(await requestedBy(3), "late@example.com", "a filing that lands after the claim updates the job");

  // A retry is a new claim: a reassigned issue's next attempt goes to its new assignee.
  await db.update(jobs).set({ stage: "failed" }).where(eq(jobs.id, ids[0]!));
  readyNodes = [node(1, { assignee: "bo@example.com", creator: "creator@example.com" })];
  await ops.claim({ repos: async () => [REPO], registry: async () => [] });
  const [retried] = await db.select({ attempt: jobs.attempt, requested_by: jobs.requested_by }).from(jobs).where(eq(jobs.id, ids[0]!));
  assert.deepEqual(retried, { attempt: 2, requested_by: "bo@example.com" }, "the retry takes the new assignee");
  console.log("requester regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(jobs).where(inArray(jobs.id, ids));
  await db.delete(jobFilings).where(inArray(jobFilings.key, [1, 2, 3, 4].map(KEY)));
  process.exit(process.exitCode ?? 0);
}
