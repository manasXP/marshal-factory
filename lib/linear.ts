import { createHash } from "node:crypto";
import { z } from "zod";
import { forbidInTest } from "./test-mode";

const ENDPOINT = "https://api.linear.app/graphql";
const TIMEOUT_MS = 15_000;

const issueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  state: z.object({ name: z.string(), type: z.string() }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
});
export type LinearIssue = z.infer<typeof issueSchema>;

const commentSchema = z.object({ id: z.string(), body: z.string(), createdAt: z.string() });
export type LinearComment = z.infer<typeof commentSchema>;

const stateSchema = z.object({ id: z.string(), name: z.string(), type: z.string() });

export class LinearError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

/** Linear stores a create under the id we pass, so a replayed create fails instead of duplicating. */
export function commentId(...parts: string[]) {
  const hex = createHash("sha256").update(`marshal-factory\n${parts.join("\n")}`).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const ATTEMPTS = 3;
const BACKOFF_MS = 250;

const realFetch: typeof fetch = (input, init) => {
  forbidInTest("the Linear API");
  return fetch(input, init);
};

export type LinearOptions = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> };

// A reset can arrive after Linear applied the write, so every mutation must converge when replayed.
export function linearClient(apiKey: string, { fetch: fetchImpl = realFetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: LinearOptions = {}) {
  async function withRetries(send: () => Promise<Response>) {
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined;
      try {
        res = await send();
      } catch (error) {
        if (attempt === ATTEMPTS) throw error;
      }
      if (res && (attempt === ATTEMPTS || (res.status < 500 && res.status !== 429))) return res;
      await sleep(BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random()));
    }
  }

  async function gql<T>(query: string, variables: Record<string, unknown>, schema: z.ZodType<T>) {
    const body = JSON.stringify({ query, variables });
    const res = await withRetries(() =>
      fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { authorization: apiKey, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );
    const json = (await res.json().catch(() => {
      throw new LinearError(`Linear answered ${res.status}`, undefined);
    })) as {
      data?: unknown;
      errors?: { message: string; extensions?: { userPresentableMessage?: string; code?: string } }[];
    };
    if (json.errors?.length) {
      const [first] = json.errors;
      throw new LinearError(
        first!.extensions?.userPresentableMessage ?? first!.message,
        first!.message.startsWith("conflict on insert") ? "conflict" : first!.extensions?.code,
      );
    }
    return schema.parse(json.data);
  }

  return {
    async team(key: string) {
      const data = await gql(
        `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key states { nodes { id name type } } } } }`,
        { key },
        z.object({
          teams: z.object({
            nodes: z.array(
              z.object({ id: z.string(), key: z.string(), states: z.object({ nodes: z.array(stateSchema) }) }),
            ),
          }),
        }),
      );
      const team = data.teams.nodes[0];
      if (!team) throw new LinearError(`No Linear team with key ${key}`, undefined);
      return { id: team.id, states: team.states.nodes };
    },

    async readyIssues(teamKey: string, label: string) {
      const data = await gql(
        `query($team: String!, $label: String!) {
          issues(first: 50, filter: {
            team: { key: { eq: $team } },
            labels: { some: { name: { eqIgnoreCase: $label } } },
            state: { type: { eq: "unstarted" } }
          }) {
            nodes { id identifier title url description createdAt state { name type } labels { nodes { name } } }
          }
        }`,
        { team: teamKey, label },
        z.object({ issues: z.object({ nodes: z.array(issueSchema) }) }),
      );
      return data.issues.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async issueWithComments(issueId: string) {
      const data = await gql(
        `query($id: String!) {
          issue(id: $id) {
            state { name type }
            comments(first: 100) { nodes { id body createdAt } }
          }
        }`,
        { id: issueId },
        z.object({
          issue: z.object({
            state: z.object({ name: z.string(), type: z.string() }),
            comments: z.object({ nodes: z.array(commentSchema) }),
          }),
        }),
      );
      return { state: data.issue.state, comments: data.issue.comments.nodes };
    },

    /** The issues that still exist, archived and trashed ones included; a deleted id is simply absent. */
    async issuesByIds(ids: string[]) {
      if (ids.length === 0) return [];
      const data = await gql(
        `query($ids: [ID!]) {
          issues(first: 250, filter: { id: { in: $ids } }, includeArchived: true) {
            nodes { id archivedAt trashed state { type name } labels { nodes { name } } }
          }
        }`,
        { ids },
        z.object({
          issues: z.object({
            nodes: z.array(
              z.object({
                id: z.string(),
                archivedAt: z.string().nullable(),
                trashed: z.boolean().nullable(),
                state: z.object({ type: z.string(), name: z.string() }),
                labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
              }),
            ),
          }),
        }),
      );
      return data.issues.nodes;
    },

    async labelsOf(issueId: string) {
      const data = await gql(
        `query($id: String!) { issue(id: $id) { labels { nodes { id name } } } }`,
        { id: issueId },
        z.object({ issue: z.object({ labels: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) }) }) }),
      );
      return data.issue.labels.nodes;
    },

    async setState(issueId: string, stateId: string) {
      await this.update(issueId, { stateId });
    },

    async update(
      issueId: string,
      input: { stateId?: string; addedLabelIds?: string[]; removedLabelIds?: string[] },
    ) {
      await gql(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        { id: issueId, input },
        z.object({ issueUpdate: z.object({ success: z.literal(true) }) }),
      );
    },

    /** The team's label of that name, or a workspace label, created on the team if neither exists. */
    async labelId(teamId: string, name: string) {
      const find = async () => {
        const data = await gql(
          `query($name: String!) { issueLabels(filter: { name: { eqIgnoreCase: $name } }) { nodes { id team { id } } } }`,
          { name },
          z.object({
            issueLabels: z.object({
              nodes: z.array(z.object({ id: z.string(), team: z.object({ id: z.string() }).nullable() })),
            }),
          }),
        );
        return (data.issueLabels.nodes.find((l) => l.team?.id === teamId) ?? data.issueLabels.nodes.find((l) => !l.team))?.id;
      };
      const found = await find();
      if (found) return found;
      const id = commentId("label", teamId, name.toLowerCase());
      try {
        await gql(
          `mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success } }`,
          { input: { id, name, teamId, color: "#eb5757" } },
          z.object({ issueLabelCreate: z.object({ success: z.literal(true) }) }),
        );
        return id;
      } catch (error) {
        if (error instanceof LinearError && error.code === "conflict") {
          const existing = await find();
          if (existing) return existing;
        }
        throw error;
      }
    },

    /** Creates the issue under `id`; a replay finds the issue the first create made. */
    async createIssue(input: { id: string; teamId: string; stateId: string; labelIds: string[]; title: string; description: string }) {
      const created = z.object({ identifier: z.string(), url: z.string() });
      try {
        const data = await gql(
          `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier url } } }`,
          { input },
          z.object({ issueCreate: z.object({ issue: created }) }),
        );
        return data.issueCreate.issue;
      } catch (error) {
        if (!(error instanceof LinearError && error.code === "conflict")) throw error;
        const data = await gql(`query($id: String!) { issue(id: $id) { identifier url } }`, { id: input.id }, z.object({ issue: created }));
        return data.issue;
      }
    },

    /** A signed URL to PUT a file to, the headers that PUT needs, and the URL the file then has. */
    async fileUpload(contentType: string, filename: string, size: number) {
      const data = await gql(
        `mutation($contentType: String!, $filename: String!, $size: Int!) {
          fileUpload(contentType: $contentType, filename: $filename, size: $size) {
            uploadFile { uploadUrl assetUrl headers { key value } }
          }
        }`,
        { contentType, filename, size },
        z.object({
          fileUpload: z.object({
            uploadFile: z.object({ uploadUrl: z.string(), assetUrl: z.string(), headers: z.array(z.object({ key: z.string(), value: z.string() })) }),
          }),
        }),
      );
      return data.fileUpload.uploadFile;
    },

    /** Returns false when a comment with this id already exists. */
    async comment(issueId: string, id: string, body: string) {
      try {
        await gql(
          `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
          { input: { id, issueId, body } },
          z.object({ commentCreate: z.object({ success: z.literal(true) }) }),
        );
        return true;
      } catch (error) {
        if (error instanceof LinearError && error.code === "conflict") return false;
        throw error;
      }
    },
  };
}
export type LinearClient = ReturnType<typeof linearClient>;
