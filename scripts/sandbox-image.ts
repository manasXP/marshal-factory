import { parseArgs } from "node:util";
import { loadLimits, UPSTASH_IMAGE_PATH } from "../lib/config";
import { buildSandboxImage, openUpstashBuildSandbox } from "../lib/sandbox-image-build";

// Builds the image factory sandboxes launch from, and records its id for the runner:
//   bun scripts/sandbox-image.ts                     Modal's image
//   bun scripts/sandbox-image.ts --backend upstash   Upstash Box's base snapshot
// The runner rebuilds Modal's on its own when a pin or a playbook changes; this is for a first build or
// a rebuild by hand. Upstash's is built only from here. lib/sandbox-image-build.ts holds the build and
// the checks it must pass.

const { values: args } = parseArgs({ options: { backend: { type: "string", default: "modal" } } });
if (args.backend !== "modal" && args.backend !== "upstash") throw new Error(`--backend is modal or upstash, not ${args.backend}`);
if (args.backend === "upstash") process.loadEnvFile(".env.local");

const t0 = Date.now();
await buildSandboxImage({
  limits: loadLimits().sandbox,
  log: (message) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${message}`),
  ...(args.backend === "upstash" && { open: openUpstashBuildSandbox, path: UPSTASH_IMAGE_PATH }),
});
