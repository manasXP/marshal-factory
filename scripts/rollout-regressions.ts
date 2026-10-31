import "./test-guard";
import assert from "node:assert/strict";
import { startupVerdict, touchedInputs } from "../lib/rollout";

const line = (event: string, detail: Record<string, unknown> = {}) => JSON.stringify({ at: `2026-10-29T21:00:0${event.length % 10}Z`, event, ...detail });
const okTick = line("tick", { result: { outbox: { delivered: 0 }, pullRequests: { conflicts: [], errors: [] } } });

assert.deepEqual(startupVerdict([]), { state: "waiting" }, "nothing logged yet");
assert.deepEqual(startupVerdict([okTick]), { state: "waiting" }, "a tick of the old process before the restart does not count");
assert.deepEqual(startupVerdict([line("start"), line("reconcile", { result: {} })]), { state: "waiting" }, "the startup reconcile alone is not a tick");
assert.equal(startupVerdict([line("stop"), line("start"), "not json", line("reconcile", { result: {} }), okTick]).state, "clean", "the first tick after start, with errors arrays inside steps, is clean");
const timedTick = line("tick", { result: { outbox: { delivered: 0 }, ms: { outbox: 12, claimed: 3400 } } });
assert.equal(startupVerdict([line("start"), timedTick]).state, "clean", "the per-step ms map is not a failed step");

const failedStep = startupVerdict([line("start"), line("tick", { result: { claimed: { error: "Linear is down" }, outbox: {} } })]);
assert.equal(failedStep.state, "failed", "a tick whose step returned an error is not clean");
assert.match(failedStep.state === "failed" ? failedStep.why : "", /failed in claimed/);
assert.equal(startupVerdict([line("start"), line("reconcile", { result: { cleaned: { error: "git" } } }), okTick]).state, "failed", "nor is one after a failed reconcile step");
assert.equal(startupVerdict([line("start"), line("registry:error", { error: "db" }), okTick]).state, "failed", "a step that threw fails it");
assert.equal(startupVerdict([line("start"), line("unhandledRejection", { error: "x" })]).state, "failed");
assert.equal(startupVerdict([line("start"), line("start")]).state, "failed", "a second start is a crash loop");

assert.deepEqual(touchedInputs(["lib/ingest.ts", "README.md", "lib/slack.ts"], ["functions/ingest/index.ts", "lib/ingest.ts"]), ["lib/ingest.ts"], "only the bundle's own inputs count");
assert.deepEqual(touchedInputs(["bun.lock"], ["lib/ingest.ts", "node_modules/pg/esm/index.mjs"]), ["bun.lock"], "a dependency counts through the lockfile");
assert.deepEqual(touchedInputs(["bun.lock"], ["lib/ingest.ts"]), [], "but not for a bundle without dependencies");

console.log("rollout regressions passed");
