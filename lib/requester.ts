import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { jobFilings, jobs } from "../db/schema";
import type { JobDraft } from "./sources/types";

// Who a job is for. A source's assignee says it best; a job filed from the panel was created with
// the factory's own Linear key or GitHub App, so for those the panel's record of the signed-in
// owner stands in for the issue's creator; any other issue falls back to whoever opened it. The
// claim works this out every time, so a reassigned issue's next attempt goes to its new assignee.

type Db = NodePgDatabase<typeof schema>;

/** jobs.requested_by for a claim, in the claim's transaction: the assignee, else the panel's filer, else the creator. */
export const requestedBySql = (draft: Pick<JobDraft, "key" | "requester">) =>
  sql<string | null>`coalesce(${draft.requester?.assignee ?? null}::text, (select ${jobFilings.filed_by} from ${jobFilings} where ${jobFilings.key} = ${draft.key}), ${draft.requester?.creator ?? null}::text)`;

/**
 * Records the owner who filed a job from the panel. A claim that read the source before this landed
 * named the factory's own account, so a job already claimed under the key takes the filer too; a
 * job filed a moment ago has no assignee yet for it to override.
 */
export async function recordFiling(database: Db, key: string, email: string, now = new Date()) {
  await database.transaction(async (tx) => {
    await tx.insert(jobFilings).values({ key, filed_by: email, filed_at: now }).onConflictDoUpdate({ target: jobFilings.key, set: { filed_by: email, filed_at: now } });
    await tx.update(jobs).set({ requested_by: email }).where(eq(jobs.key, key));
  });
}
