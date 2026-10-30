import "./test-guard";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { migrateRefusal } from "../lib/migrate-guard";
import { endpointOf } from "../lib/test-mode";

const PRODUCTION = "postgresql://u:p@ep-odd-field-b95xpf9v.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const PRODUCTION_POOLED = "postgresql://u:p@ep-odd-field-b95xpf9v-pooler.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const PREVIEW = "postgresql://u:p@ep-preview-branch-a1b2c3d4.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const PREVIEW_POOLED = "postgresql://u:p@ep-preview-branch-a1b2c3d4-pooler.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const ENDPOINTS = { FACTORY_PRODUCTION_ENDPOINTS: "ep-other-endpoint-z9y8x7w6, EP-ODD-FIELD-B95XPF9V" };
const preview = { VERCEL_ENV: "preview", DATABASE_URL: PREVIEW_POOLED, DATABASE_URL_UNPOOLED: PREVIEW, ...ENDPOINTS };
assert.equal(migrateRefusal(preview), null, "a preview migrates its own branch");
assert.match(migrateRefusal({ ...preview, FACTORY_PRODUCTION_ENDPOINTS: undefined }) ?? "", /FACTORY_PRODUCTION_ENDPOINTS is not set/, "a build that can't name production refuses");
assert.match(migrateRefusal({ ...preview, FACTORY_PRODUCTION_ENDPOINTS: " , " }) ?? "", /FACTORY_PRODUCTION_ENDPOINTS is not set/, "so does a list of blanks");
assert.match(migrateRefusal({ ...preview, DATABASE_URL_UNPOOLED: PRODUCTION }) ?? "", /DATABASE_URL_UNPOOLED points at the production branch/);
assert.match(migrateRefusal({ ...preview, DATABASE_URL: PRODUCTION_POOLED }) ?? "", /DATABASE_URL points at the production branch/, "the pooled host counts as production");
assert.match(migrateRefusal({ ...preview, DATABASE_URL_UNPOOLED: undefined }) ?? "", /DATABASE_URL_UNPOOLED is not set/, "a missing URL refuses");
assert.match(migrateRefusal({ ...preview, DATABASE_URL: "not a url" }) ?? "", /not a valid URL/, "an unparsable URL refuses");
assert.match(
  migrateRefusal({ DATABASE_URL: PRODUCTION_POOLED, DATABASE_URL_UNPOOLED: PRODUCTION, ...ENDPOINTS }) ?? "",
  /in a non-production build/,
  "a build that names no environment is not production",
);
assert.match(migrateRefusal({ ...preview, VERCEL_ENV: "development", DATABASE_URL_UNPOOLED: PRODUCTION }) ?? "", /development build/);
assert.equal(
  migrateRefusal({ VERCEL_ENV: "production", DATABASE_URL: PRODUCTION_POOLED, DATABASE_URL_UNPOOLED: PRODUCTION }),
  null,
  "a production build migrates production",
);
assert.equal(migrateRefusal({ VERCEL_ENV: "production", DATABASE_URL: PRODUCTION_POOLED, DATABASE_URL_UNPOOLED: PRODUCTION }), null, "and needs no endpoint list");

const PRODUCTION_HOST = "ep-odd-field-b95xpf9v.c-2.eu-central-1.aws.neon.tech";
const GENERIC = "postgresql://u:p@c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const viaPreview = (url: string) => ({ ...preview, DATABASE_URL_UNPOOLED: url });
const refusesProduction = (url: string, message: string) =>
  assert.match(migrateRefusal(viaPreview(url)) ?? "", /DATABASE_URL_UNPOOLED (points at the production branch|names more than one endpoint)/, message);

refusesProduction(PRODUCTION.replace("ep-odd-field-b95xpf9v", "EP-ODD-FIELD-B95XPF9V"), "an uppercase production host counts as production");
refusesProduction(`${PREVIEW}&host=${PRODUCTION_HOST}`, "a host parameter that overrides the URL host counts");
refusesProduction(`${PREVIEW}&host=${PRODUCTION_HOST.toUpperCase()}`, "an uppercase host parameter counts");
refusesProduction(`${GENERIC}&options=endpoint%3Dep-odd-field-b95xpf9v`, "an endpoint option on a generic host counts");
refusesProduction(`${GENERIC}&options=-c%20search_path%3Dpublic%20endpoint%3DEP-ODD-FIELD-B95XPF9V`, "an endpoint among other options counts");
refusesProduction(`${PREVIEW}&options=endpoint%3Dep-odd-field-b95xpf9v`, "an endpoint option that disagrees with the host refuses");
refusesProduction(GENERIC.replace("u:p@", "u:endpoint%3Dep-odd-field-b95xpf9v%3Bp@"), "an endpoint in the password counts");
assert.match(migrateRefusal(viaPreview(`${PREVIEW}&hostaddr=192.0.2.1`)) ?? "", /hostaddr/, "a hostaddr hides the endpoint, so it refuses");
assert.match(migrateRefusal(viaPreview("postgresql://u:p@/neondb?sslmode=require")) ?? "", /names no host/, "an empty host would fall back to PGHOST, so it refuses");
assert.match(migrateRefusal(viaPreview(`${PREVIEW}&host=a.neon.tech,${PRODUCTION_HOST}`)) ?? "", /names more than one endpoint/, "a host list refuses");

assert.equal(endpointOf(PREVIEW.replace("ep-preview-branch-a1b2c3d4", "EP-PREVIEW-BRANCH-A1B2C3D4")), "ep-preview-branch-a1b2c3d4", "endpoints compare in lowercase");
assert.equal(endpointOf(`${GENERIC}&options=endpoint%3Dep-preview-branch-a1b2c3d4`), "ep-preview-branch-a1b2c3d4");
assert.equal(migrateRefusal(viaPreview(`${GENERIC}&options=endpoint%3Dep-preview-branch-a1b2c3d4`)), null, "a preview may select its own endpoint by option");
assert.equal(migrateRefusal(viaPreview(`${PREVIEW}&options=endpoint%3Dep-preview-branch-a1b2c3d4`)), null, "an option that agrees with the host is fine");

function guard(env: Record<string, string | undefined>) {
  try {
    execFileSync("bun", ["scripts/migrate-guard.ts"], { env: { ...process.env, ...env }, stdio: "pipe" });
    return { code: 0, stderr: "" };
  } catch (error) {
    const failed = error as { status: number; stderr: Buffer };
    return { code: failed.status, stderr: failed.stderr.toString() };
  }
}
const refused = guard({ ...preview, DATABASE_URL_UNPOOLED: PRODUCTION });
assert.equal(refused.code, 1, "the build command stops before drizzle-kit runs");
assert.match(refused.stderr, /Refusing to migrate/);
assert.doesNotMatch(refused.stderr, /u:p@/, "the refusal never prints a connection string");
assert.equal(guard(preview).code, 0);
assert.equal(guard({ ...preview, FACTORY_PRODUCTION_ENDPOINTS: "" }).code, 1, "the build command stops without the endpoint list");

const { buildCommand } = JSON.parse(readFileSync("vercel.json", "utf8")) as { buildCommand: string };
assert.ok(buildCommand.startsWith("bun scripts/migrate-guard.ts && bun run db:migrate"), "the Vercel build checks before it migrates");

console.log("migrate guard regressions passed");
