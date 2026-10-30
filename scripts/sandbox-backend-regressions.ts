import "./test-guard";
import assert from "node:assert/strict";

const { CLOUD_EXECUTIONS, EXECUTIONS, isCloud } = await import("../lib/execution");
const { backendFor, backendOf, modalBackend, runningSandboxes } = await import("../runner/sandbox-backend");
const { modal } = await import("../lib/modal-host");

assert.equal(isCloud("modal"), true);
assert.equal(isCloud("local"), false);
assert.equal(isCloud(null), false, "a launch recorded before the column was kept is not known to be in the cloud");
assert.equal(isCloud(undefined), false);
assert.ok(CLOUD_EXECUTIONS.every((e) => (EXECUTIONS as readonly string[]).includes(e)), "every cloud execution is an execution");
for (const execution of CLOUD_EXECUTIONS) assert.equal(backendFor(execution).kind, execution, `${execution} has its backend`);

assert.equal(backendOf("sb-01ABC"), modalBackend, "a Modal sandbox id");
assert.equal(backendOf("im-01ABC"), modalBackend, "a Modal snapshot");

// Listing goes through the swappable Modal API, so the fakes regressions install still apply.
const real = modal.api;
modal.api = { ...real, list: async () => [{ sandboxId: "sb-fake", tags: { job: "FAC-1" } }] };
try {
  assert.deepEqual(await runningSandboxes(), [{ sandboxId: "sb-fake", tags: { job: "FAC-1" } }]);
} finally {
  modal.api = real;
}

console.log("sandbox backend regressions passed");
