// Whose jobs the jobs page and the inbox show. Client-safe: lib/requester.ts holds the database side.

/** The choice the jobs page and the inbox last showed, so a page without `?by` opens on it. */
export const REQUESTER_FILTER_COOKIE = "jobs_by";

/** `?by=me` shows the viewer's jobs; `?by=all` shows everyone's, even when the cookie remembers mine. */
export const MINE = "me";
export const EVERYONE = "all";

const pick = (raw: unknown) => (raw === MINE || raw === EVERYONE ? raw : undefined);

/** Whether to show only the viewer's jobs: a valid `?by` wins over the cookie; everyone's by default. */
export const mineOnly = (param: unknown, cookie: unknown) => (pick(param) ?? pick(cookie)) === MINE;

/** Whether the job is the viewer's: requested_by is an email, compared without case. */
export const isRequestedBy = (job: { requested_by: string | null }, email: string | null | undefined) =>
  !!email && !!job.requested_by && job.requested_by.toLowerCase() === email.toLowerCase();

/** How the panel names a requester: the part of an email before the @, or a GitHub login as it is. */
export const requesterName = (requestedBy: string) => requestedBy.split("@")[0] || requestedBy;
