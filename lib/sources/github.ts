import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../../db/schema";
import { jobs, repoSettings } from "../../db/schema";
import { loadConfig } from "../config";
import type { Stage } from "../events";
import { attemptBranch, jobKey } from "../factory";
import { GITHUB_API, GitHubError, githubRequest, installationTokens, readAppFile, type RepoName, type TokenSource } from "../github/app";
import { OVERRIDE_GROUPS, type SourceOverrides } from "../ticket-overrides";
import type { IntentDraft } from "../webhooks";
import { jobId, type SourceStateDraftOf } from "./shapes";
import type { Job as AnyJob, Reply, ResumePlan, SourceAdapter } from "./types";
import { SourceGoneError } from "./types";

type Job = AnyJob<"github">;

// GitHub issues in the factory's enabled repositories, read and written as the factory's GitHub App.
// An open issue with the factory label is ready work; it runs in the repo it was filed in. GitHub has
// no client-chosen comment ids, so each comment the factory posts carries a hidden marker that makes
// a replay find it, and the App's own comments are told apart from people's by their bot author.

const DELETED = "the issue was deleted on GitHub";
const CLOSED = "the issue was closed on GitHub";
const FAILED_LABEL = "factory-failed";
/** Only people who can push to the repo answer a waiting job; anyone can comment on a public issue. */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const marker = (id: string) => `<!-- marshal-factory:${id} -->`;
const withMarker = (id: string, body: string) => `${body}\n\n${marker(id)}`;
const MARKERS = /\n*<!-- marshal-factory:[^>]* -->/g;
const claimMarker = (attempt: number) => (attempt > 1 ? `claim:${attempt}` : "claim");
const stageMarker = (eventId: string) => `stage:${eventId}`;
const PANEL_ANSWER = "panel-answer:";
const panelJobMarker = (requestId: string) => `panel-job:${requestId}`;
const PANEL_ANSWER_MARKER = "<!-- marshal-factory:panel-answer:";

/** The external id of an issue: `owner/name#number`, so a stop check can reach it from the id alone. */
export const issueExternalId = (repo: string, number: number) => `${repo}#${number}`;

function parseExternalId(externalId: string): { repo: RepoName; number: number } {
  const match = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(externalId);
  if (!match) throw new Error(`not a GitHub issue id: ${externalId}`);
  return { repo: match[1] as RepoName, number: Number(match[2]) };
}

/** GH-owner-name-12, or GH-name-12 when the owner makes the key too long. */
export function issueKey(repo: string, number: number) {
  try {
    return jobKey("GH", number, repo);
  } catch {
    return jobKey("GH", number, repo.split("/")[1]);
  }
}

const userSchema = z.object({ login: z.string(), type: z.string() }).nullable();

const issueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.string(),
  body: z.string().nullable().optional(),
  state: z.enum(["open", "closed"]),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).transform((labels) => labels.map((l) => (typeof l === "string" ? l : l.name))),
  pull_request: z.unknown().optional(),
});
export type Issue = z.infer<typeof issueSchema>;

const commentSchema = z.object({
  id: z.number().int(),
  body: z.string().nullable().optional(),
  created_at: z.string(),
  user: userSchema,
  author_association: z.string().optional(),
});
export type IssueComment = z.infer<typeof commentSchema>;

const PAGES = 10;

/** The REST calls the adapter makes, so regressions can drive it with a fake. */
export function issuesClient({ api, tokens }: { api: string; tokens: Pick<TokenSource, "get" | "evict"> }) {
  // A token GitHub stops accepting is dropped and minted again once, as the PR client does.
  async function request(repo: RepoName, method: string, path: string, options?: Parameters<typeof githubRequest>[4]) {
    const token = await tokens.get(repo);
    try {
      return await githubRequest(api, token, method, path, options);
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 401)) throw error;
      tokens.evict(repo, token);
      return githubRequest(api, await tokens.get(repo), method, path, options);
    }
  }

  async function pages<T>(repo: RepoName, path: string, parse: (json: unknown) => T[]) {
    const items: T[] = [];
    for (let page = 1; page <= PAGES; page++) {
      const batch = parse((await request(repo, "GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)).json);
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  }

  return {
    /** Open issues with the label; GitHub lists pull requests as issues too, and those are left out. */
    async readyIssues(repo: RepoName, label: string): Promise<Issue[]> {
      const issues = await pages(repo, `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`, (json) => z.array(issueSchema).parse(json));
      return issues.filter((i) => i.pull_request === undefined);
    },
    /** The issue, or null when it is gone (deleted, transferred away, or out of the App's reach). */
    async issue(repo: RepoName, number: number): Promise<Issue | null> {
      const { status, json } = await request(repo, "GET", `/repos/${repo}/issues/${number}`, { allow: [404, 410] });
      return status === 404 || status === 410 ? null : issueSchema.parse(json);
    },
    comments: (repo: RepoName, number: number) => pages(repo, `/repos/${repo}/issues/${number}/comments`, (json) => z.array(commentSchema).parse(json)),
    async comment(repo: RepoName, number: number, body: string) {
      await request(repo, "POST", `/repos/${repo}/issues/${number}/comments`, { body: { body } });
    },
    /** Adds labels, creating any the repo does not have yet. */
    async addLabels(repo: RepoName, number: number, labels: readonly string[]) {
      if (labels.length > 0) await request(repo, "POST", `/repos/${repo}/issues/${number}/labels`, { body: { labels } });
    },
    async removeLabel(repo: RepoName, number: number, label: string) {
      await request(repo, "DELETE", `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, { allow: [404] });
    },
    async createIssue(repo: RepoName, title: string, body: string): Promise<Issue> {
      return issueSchema.parse((await request(repo, "POST", `/repos/${repo}/issues`, { body: { title, body } })).json);
    },
    /** The repo's newest issues, open or closed: where a request that was filed moments ago is. */
    async recentIssues(repo: RepoName): Promise<Issue[]> {
      const { json } = await request(repo, "GET", `/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=100`);
      return z.array(issueSchema).parse(json).filter((i) => i.pull_request === undefined);
    },
    async close(repo: RepoName, number: number) {
      await request(repo, "PATCH", `/repos/${repo}/issues/${number}`, { body: { state: "closed", state_reason: "completed" } });
    },
  };
}
export type IssuesClient = ReturnType<typeof issuesClient>;

/**
 * A comment from someone who can push to the repo, or an answer the owner sent from the panel. Panel
 * answers are posted as the App, so only the App's own login makes the marker count.
 */
const isReply = (c: IssueComment, appLogin: string) =>
  c.user?.type === "Bot"
    ? same(c.user.login, appLogin) && (c.body ?? "").includes(PANEL_ANSWER_MARKER)
    : TRUSTED_ASSOCIATIONS.has(c.author_association ?? "");

type WaitingJob = Pick<Job, "stage_event_id" | "question" | "delivered_reply_ids">;

/** What a waiting issue needs: the replies are trusted comments after the factory's question that no earlier resume delivered. */
export function planResume(job: WaitingJob, issue: Issue | null, comments: readonly IssueComment[], appLogin: string): ResumePlan {
  if (!issue) return { kind: "close", state: "deleted" };
  if (issue.state === "closed") return { kind: "close", state: "closed" };
  if (!job.stage_event_id) return { kind: "wait" };
  const asked = comments.find((c) => (c.body ?? "").includes(marker(stageMarker(job.stage_event_id!))));
  if (!asked) return { kind: "wait" };
  const delivered = new Set(job.delivered_reply_ids);
  const replies: Reply[] = comments
    .filter((c) => c.created_at > asked.created_at && isReply(c, appLogin) && !delivered.has(String(c.id)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((c) => ({ id: String(c.id), body: (c.body ?? "").replace(MARKERS, ""), createdAt: c.created_at }));
  if (replies.length === 0) return { kind: "wait" };
  return {
    kind: "resume",
    question: job.question ?? (asked.body ?? "").replace(MARKERS, ""),
    replies,
    answer: replies.map((r) => r.body.trim()).join("\n\n"),
  };
}

/** Why GitHub says a claimed issue should stop, or undefined while it is still the factory's. */
function stopReason(issue: Issue | null, label: string) {
  if (!issue) return DELETED;
  if (issue.state === "closed") return CLOSED;
  if (!issue.labels.some((l) => same(l, label))) return `the ${label} label was removed on GitHub`;
  return undefined;
}

/**
 * GitHub labels have no groups, so an override is a label named `<Group>: <child>`, such as
 * `Harness: Codex` or `Runs on: Cloud`. The repository is always the one the issue lives in.
 */
export function githubOverrides(state: SourceStateDraftOf<"github">): SourceOverrides {
  const inGroup = (group: string) =>
    state.labels.flatMap((l) => {
      const colon = l.indexOf(":");
      return colon > 0 && same(l.slice(0, colon).trim(), group) ? [l.slice(colon + 1).trim()] : [];
    }).filter(Boolean);
  return { harness: inGroup(OVERRIDE_GROUPS.harness), runsOn: inGroup(OVERRIDE_GROUPS.runsOn), repository: [state.repo] };
}

const issuesEventSchema = z.object({
  action: z.string(),
  issue: z.object({ number: z.number().int(), state: z.string(), labels: z.array(z.object({ name: z.string() })).default([]), pull_request: z.unknown().optional() }),
  label: z.object({ name: z.string() }).optional(),
  repository: z.object({ full_name: z.string() }),
});
const commentEventSchema = issuesEventSchema.pick({ action: true, issue: true, repository: true }).extend({ comment: commentSchema });

/**
 * What a GitHub App delivery means for issue jobs: a claim pass, a stop, or a comment to look at.
 * Each is only a cue: the runner reads the issue again, and decides there whose comment is a reply.
 */
export function githubIssueIntent(event: string, body: unknown, env: Readonly<Record<string, string | undefined>>): IntentDraft | null {
  const label = env.FACTORY_LABEL ?? "factory";
  if (event === "issue_comment") {
    const parsed = commentEventSchema.safeParse(body);
    if (!parsed.success || parsed.data.action !== "created" || parsed.data.issue.pull_request !== undefined) return null;
    const { issue, repository } = parsed.data;
    return { kind: "answer", jobId: jobId("github", issueExternalId(repository.full_name, issue.number)) };
  }
  if (event !== "issues") return null;
  const parsed = issuesEventSchema.safeParse(body);
  if (!parsed.success || parsed.data.issue.pull_request !== undefined) return null;
  const { action, issue, repository } = parsed.data;
  const base = { jobId: jobId("github", issueExternalId(repository.full_name, issue.number)) };
  const labeled = issue.labels.some((l) => same(l.name, label));
  if (action === "deleted" || action === "transferred") return { kind: "stop", ...base, detail: DELETED };
  if (action === "closed") return { kind: "stop", ...base, detail: CLOSED };
  if (action === "unlabeled" && parsed.data.label && same(parsed.data.label.name, label)) {
    return { kind: "stop", ...base, detail: `the ${label} label was removed on GitHub` };
  }
  if (issue.state === "open" && labeled && (action === "labeled" || action === "reopened" || action === "opened")) return { kind: "claim", ...base };
  return null;
}

export type GithubDeps = {
  client: IssuesClient;
  db: NodePgDatabase<typeof schema>;
  label: string;
  /** The App's bot login, such as marshal-factory-you[bot]; the author of the factory's comments. */
  appLogin: () => string;
  /** The enabled repositories the factory works in; only their issues are claimed. */
  repos: () => Promise<RepoName[]>;
};

async function runtimeDeps(): Promise<GithubDeps> {
  const config = loadConfig();
  const { db } = await import("../../db/client");
  return {
    client: issuesClient({ api: GITHUB_API, tokens: installationTokens }),
    db,
    label: config.factory.label,
    appLogin: () => `${readAppFile().slug}[bot]`,
    repos: async () => (await db.select({ repo: repoSettings.repo }).from(repoSettings).where(eq(repoSettings.enabled, true))).map((r) => r.repo as RepoName),
  };
}

/** What reaches GitHub when an issue enters a stage. Stages without an entry stay in the panel. */
type WriteBack = { labels?: { add?: string[]; remove?: string[] }; close?: true; comment?: (job: Job) => string };

const writeBackTable = (factoryLabel: string): Partial<Record<Stage, WriteBack>> => ({
  pr: {
    comment: (j) =>
      [
        `marshal-factory has a pull request ready for review: ${j.pr_url}`,
        j.stage_summary ?? "",
        j.merge_assessment?.assumptions.length ? `**Assumptions I made**\n\n${j.merge_assessment.assumptions.map((a) => `- ${a}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
  },
  waiting: {
    comment: (j) => `marshal-factory stopped and needs an answer before it can continue:\n\n${j.question ?? j.stage_summary}\n\nReply on this issue to answer.`,
  },
  // Without the factory label, so the runner does not pick it up again in a loop; adding it again retries.
  failed: {
    labels: { add: [FAILED_LABEL], remove: [factoryLabel] },
    comment: (j) => `marshal-factory gave up on this issue (attempt ${j.attempt}): ${j.stage_summary}\n\nAdd the \`${factoryLabel}\` label again to retry.`,
  },
  merged: { close: true },
});

export function createGithubAdapter(load: () => GithubDeps | Promise<GithubDeps>): SourceAdapter<"github"> {
  let loaded: GithubDeps | undefined;
  const deps = async () => (loaded ??= await load());

  /** Posts once per marker: a replay finds the earlier comment and posts nothing. */
  async function postOnce({ client }: GithubDeps, job: Pick<Job, "writeback">, id: string, body: string) {
    const { repo, number } = job.writeback;
    const existing = await client.comments(repo, number);
    if (existing.some((c) => (c.body ?? "").includes(marker(id)))) return;
    await client.comment(repo, number, withMarker(id, body));
  }

  async function changeLabels({ client }: GithubDeps, job: Pick<Job, "writeback">, labels: WriteBack["labels"]) {
    const { repo, number } = job.writeback;
    for (const name of labels?.remove ?? []) await client.removeLabel(repo, number, name);
    await client.addLabels(repo, number, labels?.add ?? []);
  }

  const gone = (error: unknown) => {
    if (error instanceof GitHubError && (error.status === 404 || error.status === 410)) throw new SourceGoneError(error.message);
    throw error;
  };

  return {
    source: "github",

    async ready() {
      const { client, label, repos } = await deps();
      const drafts = [];
      for (const repo of await repos()) {
        for (const issue of await client.readyIssues(repo, label)) {
          drafts.push({
            externalId: issueExternalId(repo, issue.number),
            key: issueKey(repo, issue.number),
            title: issue.title,
            url: issue.html_url,
            description: issue.body?.replace(MARKERS, "") ?? null,
            writeback: { kind: "github" as const, repo, number: issue.number },
            sourceState: { repo, labels: issue.labels },
          });
        }
      }
      return drafts;
    },

    async announceClaim(job) {
      if (job.source_state.announcedAttempt >= job.attempt) return;
      const d = await deps();
      if (job.attempt > 1) await d.client.removeLabel(job.writeback.repo, job.writeback.number, FAILED_LABEL);
      await postOnce(
        d,
        job,
        claimMarker(job.attempt),
        job.attempt > 1 ? `Picked up by marshal-factory again (attempt ${job.attempt}, branch \`${attemptBranch(job.key, job.attempt)}\`).` : "Picked up by marshal-factory.",
      );
      await d.db
        .update(jobs)
        .set({ source_state: sql`jsonb_set(${jobs.source_state}, '{announcedAttempt}', to_jsonb(${job.attempt}::int))`, updated_at: new Date() })
        .where(eq(jobs.id, job.id));
    },

    async writeBack(job, transition) {
      try {
        const d = await deps();
        const action = writeBackTable(d.label)[transition.stage];
        if (!action) return false;
        if (action.labels) await changeLabels(d, job, action.labels);
        if (action.comment) await postOnce(d, job, stageMarker(transition.eventId), action.comment(job));
        if (action.close) {
          const issue = await d.client.issue(job.writeback.repo, job.writeback.number);
          if (!issue) throw new SourceGoneError(`${job.external_id} is gone`);
          if (issue.state === "open") await d.client.close(job.writeback.repo, job.writeback.number);
        }
        return true;
      } catch (error) {
        return gone(error);
      }
    },

    async replies(job) {
      const { client, appLogin } = await deps();
      const { repo, number } = job.writeback;
      const issue = await client.issue(repo, number);
      return planResume(job, issue, issue ? await client.comments(repo, number) : [], appLogin());
    },

    async acknowledgeReplies(job, replyIds) {
      await postOnce(await deps(), job, `resume:${replyIds.join(",")}`, "Answer received, resuming.");
    },

    async stopWanted(open) {
      const { client, label } = await deps();
      const wanted = [];
      for (const job of open) {
        const reason = stopReason(await client.issue(job.writeback.repo, job.writeback.number), label);
        if (reason) wanted.push({ job, reason });
      }
      return wanted;
    },

    async confirmStop(externalId, detail) {
      if (detail === DELETED) return { stop: true, reopen: false };
      const { client, label } = await deps();
      const { repo, number } = parseExternalId(externalId);
      // A stopped issue is already where re-adding the label retries it, so there is nothing to reopen.
      return stopReason(await client.issue(repo, number), label) ? { stop: true, reopen: false } : { stop: false };
    },

    async note(job, key, body) {
      await postOnce(await deps(), job, `note:${key}`, body);
    },

    overrides: githubOverrides,

    async labels(job) {
      const { client } = await deps();
      const issue = await client.issue(job.writeback.repo, job.writeback.number);
      if (!issue) throw new SourceGoneError(`${job.external_id} is gone`);
      return issue.labels;
    },

    async reopen() {},

    async requeue(job) {
      const d = await deps();
      await changeLabels(d, job, { add: [d.label], remove: [FAILED_LABEL] });
    },

    describe: (job) => `GitHub issue ${job.key}`,

    /** Posts the owner's panel answer as the App, marked so the runner reads it as a reply and not as the factory's own. */
    async reply(job, requestId, body) {
      await postOnce(await deps(), job, `${PANEL_ANSWER}${requestId}`, body);
    },

    /**
     * Files the job as an issue in its repo with the factory label, as a person would; the App's
     * delivery or the next poll claims it. GitHub takes no client-chosen id, so the body carries the
     * request's marker and a retry finds the issue among the repo's newest. The labels go on after
     * the issue exists, since adding them creates any the repo is missing; a retry adds them again
     * only while the issue has neither the factory label nor factory-failed.
     */
    async file(draft) {
      const { client, label } = await deps();
      if (!draft.repo) throw new Error("a GitHub issue needs the repository to file it in");
      const repo = draft.repo as RepoName;
      const id = panelJobMarker(draft.requestId);
      const found = (await client.recentIssues(repo)).find((i) => (i.body ?? "").includes(marker(id)));
      const issue = found ?? (await client.createIssue(repo, draft.title, withMarker(id, draft.description)));
      // The repository is the one the issue lives in, so its label would say nothing.
      const overrides = (draft.labels ?? []).filter((l) => l.group !== OVERRIDE_GROUPS.repository).map((l) => `${l.group}: ${l.name}`);
      if (!issue.labels.some((l) => same(l, label) || same(l, FAILED_LABEL))) await client.addLabels(repo, issue.number, [label, ...(draft.tags ?? []), ...overrides]);
      return { key: issueKey(repo, issue.number), url: issue.html_url };
    },

    appEvent: githubIssueIntent,
  };
}

// The panel reaches GitHub from Vercel with GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (appCredentials), and has no config file.
const panelDeps = async (): Promise<GithubDeps> => {
  const { db } = await import("../../db/client");
  return {
    client: issuesClient({ api: GITHUB_API, tokens: installationTokens }),
    db,
    label: process.env.FACTORY_LABEL ?? "factory",
    appLogin: () => "",
    repos: async () => [],
  };
};

const runner = createGithubAdapter(runtimeDeps);
const panel = createGithubAdapter(panelDeps);

export const github: SourceAdapter<"github"> = { ...runner, reply: panel.reply, file: panel.file };
