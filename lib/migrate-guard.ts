import { endpointOf } from "./test-mode";

/** Names the production branch's compute endpoints (`ep-…`, comma separated); a non-production build refuses without it. */
export const PRODUCTION_ENDPOINTS_ENV = "FACTORY_PRODUCTION_ENDPOINTS";

const DB_VARS = ["DATABASE_URL", "DATABASE_URL_UNPOOLED"] as const;

/** The production endpoints the env names, lowercased like endpointOf; empty when it names none. */
export function productionEndpoints(env: Record<string, string | undefined>) {
  return new Set((env[PRODUCTION_ENDPOINTS_ENV] ?? "").split(",").map((id) => id.trim().toLowerCase()).filter(Boolean));
}

/** Why a Vercel build must not migrate, or null when it may. Only a production build may touch production. */
export function migrateRefusal(env: Record<string, string | undefined>): string | null {
  if (env.VERCEL_ENV === "production") return null;
  const target = env.VERCEL_ENV ?? "non-production";
  // Without the list a production URL would pass unnoticed, so its absence refuses.
  const production = productionEndpoints(env);
  if (production.size === 0) return `${PRODUCTION_ENDPOINTS_ENV} is not set, so a ${target} build can't tell the production branch apart`;
  for (const name of DB_VARS) {
    const url = env[name];
    if (!url) return `${name} is not set`;
    let endpoint: string;
    try {
      endpoint = endpointOf(url);
    } catch (error) {
      return `${name} ${(error as Error).message}`;
    }
    if (production.has(endpoint)) return `${name} points at the production branch (${endpoint}) in a ${target} build`;
  }
  return null;
}
