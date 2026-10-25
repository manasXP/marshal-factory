import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../../db/schema";
import { jobs } from "../../db/schema";
import { loadConfig, type FactoryLimits } from "../config";
import type { Stage } from "../events";
import { attemptBranch } from "../factory";
import { commentId, linearClient, type LinearClient, type LinearOptions } from "../linear";
import { hmacHex, sameHex, type IntentDraft, type Verdict } from "../webhooks";
import { jobId } from "./shapes";
import type { Job as AnyJob, FileDraft, FiledJob, Reply, ResumePlan, SourceAdapter, SourceWebhook } from "./types";

type Job = AnyJob<"linear">;

/** Linear asks receivers to reject a webhookTimestamp more than a minute away from now. */
const LINEAR_MAX_SKEW_MS = 60_000;

/** The stop detail for a deleted issue; there is nothing left in Linear to double-check. */
const DELETED = "the issue was deleted in Linear";

/** `Linear-Signature` is the hex HMAC-SHA256 of the raw body; the timestamp check comes after it. */
function verifyLinear(rawBody: string, signature: string | null, secret: string, now = Date.now()): Verdict {
  if (!signature || !sameHex(signature, hmacHex(secret, rawBody))) return { ok: false, reason: "bad signature" };
  const sent = (JSON.parse(rawBody) as { webhookTimestamp?: number }).webhookTimestamp;
  if (typeof sent !== "number" || Math.abs(now - sent) > LINEAR_MAX_SKEW_MS) {
    return { ok: false, reason: "stale webhookTimestamp" };
  }
  return { ok: true };
}

const linearIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  team: z.object({ key: z.string() }).optional(),
  labels: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  labelIds: z.array(z.string()).default([]),
  state: z.object({ type: z.string(), name: z.string() }).optional(),
});

const linearPayloadSchema = z.object({
  action: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
  updatedFrom: z.record(z.string(), z.unknown()).optional(),
});

/**
 * What a Linear delivery means for the factory. A label or state change can arrive as one
 * delivery, so the current labels and state decide, with updatedFrom telling a removal apart.
 */
function linearIntent(body: unknown, opts: { teamKey: string; label: string }): IntentDraft | null {
  const payload = linearPayloadSchema.parse(body);
  if (payload.type === "Comment" && payload.action === "create") {
    const issueId = z.string().optional().parse(payload.data.issueId);
    return issueId ? { kind: "answer", jobId: jobId("linear", issueId) } : null;
  }
  if (payload.type !== "Issue") return null;
  const issue = linearIssueSchema.parse(payload.data);
  if (issue.team && issue.team.key !== opts.teamKey) return null;
  if (!issue.identifier.startsWith(`${opts.teamKey}-`)) return null;
  const base = { jobId: jobId("linear", issue.id) };
  const factoryLabel = issue.labels.find((l) => l.name.toLowerCase() === opts.label.toLowerCase());

  if (payload.action === "remove") return { kind: "stop", ...base, detail: DELETED };
  if (issue.state?.type === "canceled" && payload.updatedFrom && "stateId" in payload.updatedFrom) {
    return { kind: "stop", ...base, detail: `issue moved to ${issue.state.name} in Linear` };
  }
  const labelsBefore = z.array(z.string()).optional().parse(payload.updatedFrom?.labelIds);
  if (labelsBefore && !factoryLabel) {
    // The labels changed and factory is not among them now. The payload names only the current
    // labels, so a swap looks the same as a removal; the runner checks whether it was running.
    return { kind: "stop", ...base, detail: `the ${opts.label} label was removed in Linear` };
  }
  if (factoryLabel && issue.state?.type === "unstarted") return { kind: "claim", ...base };
  return null;
}

const webhook: SourceWebhook = {
  secretEnv: "LINEAR_WEBHOOK_SECRET",
  deliveryHeader: "Linear-Delivery",
  eventHeader: "Linear-Event",
  verify: (raw, headers, secret, now) => verifyLinear(raw, headers.get("linear-signature"), secret, now),
  intent: linearIntent,
};

/** Linear state types that end an issue; a waiting run on one of them never resumes. */
const CLOSED_STATE_TYPES = new Set(["completed", "canceled", "duplicate"]);

type WaitingJob = Pick<Job, "external_id" | "stage_event_id" | "question" | "source_state" | "delivered_reply_ids">;

export const claimCommentId = (issueId: string, attempt = 1) =>
  attempt > 1 ? commentId(issueId, "claim", String(attempt)) : commentId(issueId, "claim");
export const stageCommentId = (issueId: string, stageEventId: string) =>
  commentId(issueId, stageEventId);
export const resumeCommentId = (issueId: string, replyIds: readonly string[]) =>
  commentId(issueId, "resume", ...replyIds);

/**
 * Decides what a waiting issue needs from what Linear shows. Replies are the comments after the
 * question comment that the factory did not post and no earlier resume delivered. The API key is
 * the operator's own, so authorship cannot tell them apart; the stored comment ids do.
 */
export function planResume(
  issue: WaitingJob,
  linear: { state: { name: string; type: string }; comments: readonly Reply[] },
): ResumePlan {
  if (CLOSED_STATE_TYPES.has(linear.state.type)) return { kind: "close", state: linear.state.name };
  if (!issue.stage_event_id) return { kind: "wait" };

  const questionId = stageCommentId(issue.external_id, issue.stage_event_id);
  const asked = linear.comments.find((c) => c.id === questionId);
  if (!asked) return { kind: "wait" };

  const ours = new Set([
    ...issue.source_state.factoryCommentIds,
    claimCommentId(issue.external_id),
    questionId,
  ]);
  const delivered = new Set(issue.delivered_reply_ids);
  const replies = linear.comments
    .filter((c) => c.createdAt > asked.createdAt && !ours.has(c.id) && !delivered.has(c.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (replies.length === 0) return { kind: "wait" };

  return {
    kind: "resume",
    question: issue.question ?? asked.body,
    replies,
    answer: replies.map((r) => r.body.trim()).join("\n\n"),
  };
}


type IssueNode = Awaited<ReturnType<LinearClient["issuesByIds"]>>[number];

/** Why Linear says a claimed issue should stop, or undefined while it is still the factory's. */
function stopReason(node: IssueNode | undefined, label: string) {
  if (!node) return DELETED;
  if (node.trashed || node.archivedAt) return "the issue was archived or deleted in Linear";
  if (["canceled", "completed"].includes(node.state.type)) return `issue moved to ${node.state.name} in Linear`;
  if (!node.labels.nodes.some((l) => l.name.toLowerCase() === label.toLowerCase())) {
    return `the ${label} label was removed in Linear`;
  }
  return undefined;
}

export type LinearDeps = {
  client: LinearClient;
  db: NodePgDatabase<typeof schema>;
  limits: FactoryLimits;
};

async function runtimeDeps(): Promise<LinearDeps> {
  const config = loadConfig();
  const { db } = await import("../../db/client");
  return { client: linearClient(config.linearApiKey), db, limits: config.factory };
}

type Team = Awaited<ReturnType<LinearClient["team"]>>;

const stateId = (team: Team, teamKey: string, name: string) => {
  const state = team.states.find((s) => s.name === name);
  if (!state) throw new Error(`Linear team ${teamKey} has no state ${name}`);
  return state.id;
};

/** What reaches Linear when an issue enters a stage. Stages without an entry stay in the panel. */
type WriteBack = {
  state?: string;
  labels?: { add?: string[]; remove?: string[] };
  comment?: (issue: Job) => string;
};
const FAILED_LABEL = "factory-failed";

const writeBackTable = (factoryLabel: string): Partial<Record<Stage, WriteBack>> => ({
  pr: {
    state: "In Review",
    comment: (i) => `marshal-factory has a pull request ready for review: ${i.pr_url}\n\n${i.stage_summary ?? ""}`.trim(),
  },
  waiting: {
    comment: (i) =>
      `marshal-factory stopped and needs an answer before it can continue:\n\n${i.question ?? i.stage_summary}`,
  },
  // Back to Todo without the factory label, so the runner does not pick it up again in a loop.
  // Adding the label again retries it as a new attempt.
  failed: {
    state: "Todo",
    labels: { add: [FAILED_LABEL], remove: [factoryLabel] },
    comment: (i) =>
      `marshal-factory gave up on this issue (attempt ${i.attempt}): ${i.stage_summary}\n\nAdd the \`${factoryLabel}\` label again to retry.`,
  },
  merged: { state: "Done" },
});

const commentIds = sql`coalesce(${jobs.source_state}->'factoryCommentIds', '[]'::jsonb)`;

/** Records the id before posting, so a crash in between can never make our own comment look like a reply. */
async function postComment({ db, client }: LinearDeps, job: Job, id: string, body: string) {
  await db
    .update(jobs)
    .set({
      source_state: sql`jsonb_set(${jobs.source_state}, '{factoryCommentIds}', case when ${commentIds} ? ${id} then ${commentIds} else ${commentIds} || jsonb_build_array(${id}::text) end)`,
    })
    .where(eq(jobs.id, job.id));
  await client.comment(job.writeback.issueId, id, body);
}

async function recordState({ db }: LinearDeps, job: Job, state: string, extra: { updated_at?: Date } = {}) {
  await db
    .update(jobs)
    .set({ source_state: sql`jsonb_set(${jobs.source_state}, '{state}', to_jsonb(${state}::text))`, ...extra })
    .where(eq(jobs.id, job.id));
}

const ANNOUNCED = "In Progress";

export function createLinearAdapter(load: () => LinearDeps | Promise<LinearDeps>): SourceAdapter<"linear"> {
  let loaded: LinearDeps | undefined;
  const deps = async () => (loaded ??= await load());
  let team: Team | undefined;
  const teamOf = async ({ client, limits }: LinearDeps) => (team ??= await client.team(limits.teamKey));

  async function labelChangesAgainstIssue(d: LinearDeps, issueId: string, labels: WriteBack["labels"]) {
    if (!labels) return {};
    const current = await d.client.labelsOf(issueId);
    const present = new Set(current.map((l) => l.name.toLowerCase()));
    const drop = new Set((labels.remove ?? []).map((name) => name.toLowerCase()));
    const missing = (labels.add ?? []).filter((name) => !present.has(name.toLowerCase()));
    const { id } = await teamOf(d);
    return {
      addedLabelIds: await Promise.all(missing.map((name) => d.client.labelId(id, name))),
      removedLabelIds: current.filter((l) => drop.has(l.name.toLowerCase())).map((l) => l.id),
    };
  }

  return {
    source: "linear",
    webhook,

    async ready() {
      const { client, limits } = await deps();
      const nodes = await client.readyIssues(limits.teamKey, limits.label);
      return nodes.map((n) => ({
        externalId: n.id,
        key: n.identifier,
        title: n.title,
        url: n.url,
        description: n.description,
        writeback: { kind: "linear" as const, issueId: n.id },
        sourceState: { state: n.state.name, labels: n.labels.nodes.map((l) => l.name) },
      }));
    },

    async announceClaim(job) {
      if (job.source_state.state === ANNOUNCED) return;
      const d = await deps();
      await d.client.update(job.writeback.issueId, {
        stateId: stateId(await teamOf(d), d.limits.teamKey, ANNOUNCED),
        ...(job.attempt > 1 ? await labelChangesAgainstIssue(d, job.writeback.issueId, { remove: [FAILED_LABEL] }) : {}),
      });
      await postComment(
        d,
        job,
        claimCommentId(job.writeback.issueId, job.attempt),
        job.attempt > 1
          ? `Picked up by marshal-factory again (attempt ${job.attempt}, branch ${attemptBranch(job.key, job.attempt)}).`
          : "Picked up by marshal-factory.",
      );
      await recordState(d, job, ANNOUNCED, { updated_at: new Date() });
    },

    async writeBack(job, transition) {
      const d = await deps();
      const action = writeBackTable(d.limits.label)[transition.stage];
      if (!action) return false;
      if (action.state || action.labels) {
        const team = await teamOf(d);
        await d.client.update(job.writeback.issueId, {
          ...(action.state ? { stateId: stateId(team, d.limits.teamKey, action.state) } : {}),
          ...(await labelChangesAgainstIssue(d, job.writeback.issueId, action.labels)),
        });
      }
      if (action.comment) {
        await postComment(d, job, stageCommentId(job.writeback.issueId, transition.eventId), action.comment(job));
      }
      if (action.state) await recordState(d, job, action.state);
      return true;
    },

    async replies(job) {
      const { client } = await deps();
      return planResume(job, await client.issueWithComments(job.external_id));
    },

    async stopWanted(open) {
      const { client, limits } = await deps();
      const nodes = await client.issuesByIds(open.map((j) => j.external_id));
      const wanted = [];
      for (const job of open) {
        const reason = stopReason(nodes.find((n) => n.id === job.external_id), limits.label);
        if (reason) wanted.push({ job, reason });
      }
      return wanted;
    },

    async confirmStop(externalId, detail) {
      if (detail === DELETED) return { stop: true, reopen: false };
      const { client, limits } = await deps();
      const { state } = await client.issueWithComments(externalId);
      const stillLabeled = (await client.labelsOf(externalId)).some((l) => l.name.toLowerCase() === limits.label.toLowerCase());
      if (stillLabeled && !["canceled", "completed"].includes(state.type)) return { stop: false };
      return { stop: true, reopen: state.type === "started" };
    },

    async reopen(job) {
      const d = await deps();
      await d.client.setState(job.writeback.issueId, stateId(await teamOf(d), d.limits.teamKey, "Todo"));
    },

    async acknowledgeReplies(job, replyIds) {
      await postComment(await deps(), job, resumeCommentId(job.writeback.issueId, replyIds), "Answer received, resuming.");
    },

    describe: (job) => `Linear issue ${job.key}`,
  };
}

/**
 * Files a job as a Todo issue with the factory label, under an id derived from the request, so a
 * double submit or a retry finds the first issue. Linear's webhook then brings it to the runner.
 */
export function linearFiler(apiKey: string, teamKey: string, label: string, options?: LinearOptions) {
  const client = linearClient(apiKey, options);
  return async (draft: FileDraft): Promise<FiledJob> => {
    const team = await client.team(teamKey);
    const todo = team.states.find((s) => s.type === "unstarted" && s.name === "Todo") ?? team.states.find((s) => s.type === "unstarted");
    if (!todo) throw new Error(`Linear team ${teamKey} has no Todo state`);
    const issue = await client.createIssue({
      id: commentId("panel-job", draft.requestId),
      teamId: team.id,
      stateId: todo.id,
      labelIds: [await client.labelId(team.id, label)],
      title: draft.title,
      description: draft.description,
    });
    return { key: issue.identifier, url: issue.url };
  };
}

// The panel files jobs from Vercel, which has no config file, so filing reads its key from the env.
const fileFromEnv = (draft: FileDraft) => {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY is not set, so the panel cannot file jobs in Linear");
  return linearFiler(key, process.env.FACTORY_TEAM_KEY ?? "FAC", process.env.FACTORY_LABEL ?? "factory")(draft);
};

export const linear: SourceAdapter<"linear"> = { ...createLinearAdapter(runtimeDeps), file: fileFromEnv };
