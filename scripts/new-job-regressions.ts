import "./test-guard";
import assert from "node:assert/strict";

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;

const { createJob, uploadJobImage } = await import("../lib/new-job");
const { linearFiler, linearUploader } = await import("../lib/sources/linear");
const { createGithubAdapter } = await import("../lib/sources/github");
type FileDraft = Parameters<Parameters<typeof createJob>[0]["file"]>[0];
type Issue = import("../lib/sources/github").Issue;

const owner = { email: OWNER, emailVerified: true };
const requestId = "6f0c3f8e-1f4b-4a52-9f0e-2d7c5a8b9c10";
const harnesses = async () => null;
const registry = async () => [];
const recordFiling = async () => {};
const draft = { title: "Show the item count", description: "On the weight sort button.", requestId };

{
  const filed: FileDraft[] = [];
  const file = async (d: FileDraft) => (filed.push(d), { key: "FAC-99", url: "https://linear.app/x/issue/FAC-99" });
  for (const user of [null, { email: "someone@example.com", emailVerified: true }, { email: OWNER, emailVerified: false }]) {
    const outcome = await createJob({ user: async () => user, file, harnesses, registry, recordFiling }, draft);
    assert.deepEqual([outcome.ok, !outcome.ok && outcome.status], [false, 403], `a non-owner (${user?.email ?? "signed out"}) cannot start a job`);
  }
  assert.equal(filed.length, 0, "and nothing is filed");

  const tooShort = await createJob({ user: async () => owner, file, harnesses, registry, recordFiling }, { ...draft, title: " a " });
  assert.equal(!tooShort.ok && tooShort.status, 400, "a title under 3 characters is refused");
  const noRequest = await createJob({ user: async () => owner, file, harnesses, registry, recordFiling }, { ...draft, requestId: "not-a-uuid" });
  assert.equal(!noRequest.ok && noRequest.status, 400, "a request without a request id is refused");
  assert.equal(filed.length, 0);

  const ok = await createJob({ user: async () => owner, file, harnesses, registry, recordFiling }, { ...draft, title: "  Show the item count  " });
  assert.deepEqual(ok, { ok: true, identifier: "FAC-99", url: "https://linear.app/x/issue/FAC-99", source: "linear" }, "the owner files a job, in Linear by default");
  assert.equal(filed[0]!.title, "Show the item count", "with the title trimmed");

  const down = await createJob({ user: async () => owner, file: async () => Promise.reject(new Error("Linear is down")), harnesses, registry, recordFiling }, draft);
  assert.equal(!down.ok && down.status, 502, "a Linear failure is reported");
  assert.match(!down.ok ? down.message : "", /in Linear: Linear is down/);

  const filings: [string, string][] = [];
  await createJob({ user: async () => owner, file, harnesses, registry, recordFiling: async (key, email) => void filings.push([key, email]) }, draft);
  assert.deepEqual(filings, [["FAC-99", OWNER]], "the owner who filed the job is recorded under the key the source gave it");
  const unrecorded = await createJob({ user: async () => owner, file, harnesses, registry, recordFiling: async () => Promise.reject(new Error("db down")) }, draft);
  assert.equal(!unrecorded.ok && unrecorded.status, 502, "a filing that could not be recorded is reported");
  assert.match(!unrecorded.ok ? unrecorded.message : "", /^Filed FAC-99, but could not record that you filed it: db down\. Submit again/, "naming the issue, so a resubmit finds it");
}

{
  const filed: { draft: FileDraft; source: string }[] = [];
  const file = async (draft: FileDraft, source: string) => (filed.push({ draft, source }), { key: "GH-acme-web-5", url: "https://github.com/acme/web/issues/5" });
  const repos = async () => [
    { repo: "acme/web", display_name: null, enabled: true, is_default: true },
    { repo: "acme/api", display_name: null, enabled: true, is_default: false },
    { repo: "acme/old", display_name: null, enabled: false, is_default: false },
  ] as never;
  const deps = { user: async () => owner, file, harnesses, registry: repos, recordFiling };

  const ok = await createJob(deps, { ...draft, source: "github", repo: "acme/api", execution: "upstash" });
  assert.deepEqual([ok.ok, ok.ok && ok.source], [true, "github"], "the owner files a job on GitHub");
  assert.equal(filed[0]!.source, "github", "through the GitHub source");
  assert.equal(filed[0]!.draft.repo, "acme/api", "in the chosen repo");
  assert.deepEqual(filed[0]!.draft.labels, [{ group: "Repository", name: "api" }, { group: "Runs on", name: "Upstash" }], "with the same override labels Linear gets");
  await createJob(deps, { ...draft, source: "github" });
  assert.equal(filed[1]!.draft.repo, "acme/web", "without a repo, in the default repo");
  await createJob(deps, draft);
  assert.deepEqual([filed[2]!.source, filed[2]!.draft.repo], ["linear", "acme/web"], "Linear gets the repo too, and ignores it");

  const disabled = await createJob(deps, { ...draft, source: "github", repo: "acme/old" });
  assert.equal(!disabled.ok && disabled.status, 400, "a disabled repo is refused");
  const none = await createJob({ ...deps, registry }, { ...draft, source: "github" });
  assert.deepEqual([none.ok, !none.ok && none.status], [false, 400], "with no repository registered, a GitHub job has nowhere to go");
  const bad = await createJob(deps, { ...draft, source: "slack" });
  assert.equal(!bad.ok && bad.status, 400, "a source the panel cannot file in is refused");
  assert.equal(filed.length, 3, "and none of those is filed");
  const down = await createJob({ ...deps, file: async () => Promise.reject(new Error("API rate limit exceeded")) }, { ...draft, source: "github" });
  assert.match(!down.ok ? down.message : "", /in GitHub Issues: API rate limit exceeded/, "a GitHub failure names GitHub");
}

{
  // The GitHub adapter files an issue as the App, findable again by the request's marker.
  const issues: Issue[] = [];
  const ensured: string[] = [];
  let refuse: string | null = null;
  const client = {
    recentIssues: async () => [...issues].reverse(),
    ensureLabel: async (_repo: string, name: string) => {
      if (name === refuse) throw new Error(`GitHub refused the label "${name}"`);
      ensured.push(name);
    },
    createIssue: async (_repo: string, title: string, body: string, labels: readonly string[]) => {
      const issue: Issue = { number: issues.length + 1, title, body, html_url: `https://github.com/acme/web/issues/${issues.length + 1}`, state: "open", labels: [...labels] };
      issues.push(issue);
      return issue;
    },
  };
  const adapter = createGithubAdapter(() => ({ client: client as never, db: null as never, label: "factory", appLogin: () => "", repos: async () => [] }));
  const file = adapter.file!;
  const labels = [{ group: "Repository", name: "web" }, { group: "Harness", name: "Codex" }, { group: "Runs on", name: "Cloud" }];

  await assert.rejects(file({ ...draft }), /needs the repository/, "an issue needs its repo");
  assert.deepEqual(await file({ ...draft, repo: "acme/web", labels }), { key: "GH-acme-web-1", url: "https://github.com/acme/web/issues/1" }, "the issue is filed");
  assert.equal(issues[0]!.title, draft.title);
  assert.match(issues[0]!.body!, new RegExp(`^${draft.description}\\n\\n<!-- marshal-factory:panel-job:${requestId} -->$`), "with the request's marker under the description");
  assert.deepEqual(issues[0]!.labels, ["factory", "Harness: Codex", "Runs on: Cloud"], "already labeled, with GitHub-style overrides and no Repository label");
  assert.deepEqual(ensured, issues[0]!.labels, "each label made sure of before the issue exists");

  issues[0]!.labels = ["Harness: Codex", "Runs on: Cloud"];
  assert.deepEqual(await file({ ...draft, repo: "acme/web", labels }), { key: "GH-acme-web-1", url: "https://github.com/acme/web/issues/1" }, "a second submit finds the first issue");
  assert.equal(issues.length, 1, "and files nothing new");
  assert.deepEqual(issues[0]!.labels, ["Harness: Codex", "Runs on: Cloud"], "nor puts back a factory label the owner removed to stop it");

  refuse = "Harness: Codex";
  await assert.rejects(file({ ...draft, requestId: "0b9d2f71-3c55-4e1a-8f6b-7a2c9e4d1f00", repo: "acme/web", labels }), /refused the label/, "a label GitHub refuses is reported");
  assert.equal(issues.length, 1, "before any issue is filed");
}

{
  const filed: FileDraft[] = [];
  const deps = {
    user: async () => owner,
    file: async (d: FileDraft) => (filed.push(d), { key: "GH-acme-web-1", url: "u" }),
    harnesses,
    registry: async () => [{ repo: "acme/web", display_name: null, enabled: true, is_default: true }] as never,
    recordFiling,
  };
  const withImage = { ...draft, description: "See ![screen.png](https://uploads.linear.app/org/abc/screen.png)" };
  const refused = await createJob(deps, { ...withImage, source: "github" });
  assert.deepEqual([refused.ok, !refused.ok && refused.status], [false, 400], "a GitHub job refuses images uploaded to Linear");
  assert.equal((await createJob(deps, withImage)).ok, true, "which a Linear job keeps");
  assert.equal(filed.length, 1);
}

{
  const sent: { query: string; variables: Record<string, unknown> }[] = [];
  let created = false;
  const fetchFake = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    sent.push({ query, variables });
    if (query.includes("teams(")) {
      return Response.json({
        data: { teams: { nodes: [{ id: "team-1", key: "FAC", states: { nodes: [{ id: "s-backlog", name: "Backlog", type: "backlog" }, { id: "s-todo", name: "Todo", type: "unstarted" }] } }] } },
      });
    }
    if (query.includes("issueLabels(")) return Response.json({ data: { issueLabels: { nodes: [{ id: "label-factory", team: { id: "team-1" } }] } } });
    if (query.includes("issueCreate")) {
      if (created) return Response.json({ errors: [{ message: "conflict on insert of issue" }] });
      created = true;
      return Response.json({ data: { issueCreate: { issue: { identifier: "FAC-77", url: "https://linear.app/x/issue/FAC-77" } } } });
    }
    if (query.includes("issue(id:")) return Response.json({ data: { issue: { identifier: "FAC-77", url: "https://linear.app/x/issue/FAC-77" } } });
    throw new Error(`unexpected query ${query.slice(0, 60)}`);
  }) as unknown as typeof fetch;
  const file = linearFiler("key", "FAC", "factory", { fetch: fetchFake, sleep: async () => {} });

  assert.deepEqual(await file(draft), { key: "FAC-77", url: "https://linear.app/x/issue/FAC-77" }, "the issue is filed");
  const creates = () => sent.filter((r) => r.query.includes("issueCreate")).map((r) => r.variables.input as Record<string, unknown>);
  const { id, ...rest } = creates()[0]!;
  assert.deepEqual(
    rest,
    { teamId: "team-1", stateId: "s-todo", labelIds: ["label-factory"], title: draft.title, description: draft.description },
    "in Todo, with the factory label",
  );
  assert.match(String(id), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "under an id Linear accepts");
  assert.deepEqual(await file(draft), { key: "FAC-77", url: "https://linear.app/x/issue/FAC-77" }, "a second submit of the same request finds the first issue");
  assert.equal(creates()[1]!.id, id, "because it asks for the same id, which Linear refuses to create twice");
  created = false;
  await file({ ...draft, requestId: "0b9d2f71-3c55-4e1a-8f6b-7a2c9e4d1f00" });
  assert.notEqual(creates()[2]!.id, id, "a new request gets a new issue");
  created = false;
  await file({ ...draft, requestId: "3e1a7c52-9d04-4b6f-a1c8-5f2e8b7d0a19", tags: ["review"] });
  assert.deepEqual(creates()[3]!.labelIds, ["label-factory", "label-factory"], "a tag is looked up by name and goes on the issue at creation");
  assert.equal(sent.filter((r) => r.query.includes("issueLabels(")).at(-1)!.variables.name, "review");
}

{
  const uploaded: string[] = [];
  const upload = async (image: { filename: string }) => (uploaded.push(image.filename), `![${image.filename}](https://uploads.linear.app/x/${image.filename})`);
  const png = (name: string, size = 10, type = "image/png") => new File([new Uint8Array(size)], name, { type });

  const stranger = await uploadJobImage({ user: async () => ({ email: "someone@example.com", emailVerified: true }), upload }, png("a.png"));
  assert.equal(!stranger.ok && stranger.status, 403, "a non-owner cannot upload images");
  const pdf = await uploadJobImage({ user: async () => owner, upload }, png("spec.pdf", 10, "application/pdf"));
  assert.equal(!pdf.ok && pdf.status, 400, "a file that is not an image is refused");
  const big = await uploadJobImage({ user: async () => owner, upload }, png("big.png", 4 * 1024 * 1024 + 1));
  assert.equal(!big.ok && big.status, 413, "an image over 4 MB is refused, under Vercel's request limit");
  const none = await uploadJobImage({ user: async () => owner, upload }, null);
  assert.equal(!none.ok && none.status, 400, "a request without a file is refused");
  assert.deepEqual(uploaded, [], "and none of those reaches Linear");
  assert.deepEqual(
    await uploadJobImage({ user: async () => owner, upload }, png("screen.png")),
    { ok: true, markdown: "![screen.png](https://uploads.linear.app/x/screen.png)" },
    "the owner's image comes back as markdown for the description",
  );
}

{
  const asked: Record<string, unknown>[] = [];
  const puts: { url: string; headers: Headers; size: number }[] = [];
  const gqlFake = (async (_url: string, init: RequestInit) => {
    asked.push((JSON.parse(String(init.body)) as { variables: Record<string, unknown> }).variables);
    return Response.json({
      data: { fileUpload: { uploadFile: { uploadUrl: "https://storage.example/put?sig=1", assetUrl: "https://uploads.linear.app/org/abc/screen.png", headers: [{ key: "x-goog-meta", value: "m" }] } } },
    });
  }) as unknown as typeof fetch;
  let storageStatus = 200;
  const putFake = (async (url: string, init: RequestInit) => {
    puts.push({ url, headers: new Headers(init.headers), size: (init.body as Uint8Array).byteLength });
    return new Response(null, { status: storageStatus });
  }) as unknown as typeof fetch;
  const upload = linearUploader("key", { fetch: gqlFake, sleep: async () => {}, put: putFake });
  const bytes = new Uint8Array([1, 2, 3, 4]);

  assert.equal(await upload({ filename: "screen [1].png", contentType: "image/png", bytes }), "![screen  1 .png](https://uploads.linear.app/org/abc/screen.png)", "the markdown points at Linear's copy");
  assert.deepEqual(asked[0], { contentType: "image/png", filename: "screen [1].png", size: 4 }, "Linear is asked for an upload of that type, name and size");
  assert.equal(puts[0]!.url, "https://storage.example/put?sig=1", "the bytes go to the signed URL");
  assert.equal(puts[0]!.size, 4);
  assert.equal(puts[0]!.headers.get("content-type"), "image/png", "with their type");
  assert.equal(puts[0]!.headers.get("x-goog-meta"), "m", "and the headers Linear asked for");
  storageStatus = 403;
  await assert.rejects(upload({ filename: "s.png", contentType: "image/png", bytes }), /storage answered 403/, "a refused upload is reported");
}

console.log("new job regressions passed");
