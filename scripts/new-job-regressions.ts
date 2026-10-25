import "./test-guard";
import assert from "node:assert/strict";

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;

const { createJob, uploadJobImage } = await import("../lib/new-job");
const { linearFiler, linearUploader } = await import("../lib/sources/linear");
type FileDraft = Parameters<typeof createJob>[0]["file"] extends (d: infer D) => unknown ? D : never;

const owner = { email: OWNER, emailVerified: true };
const requestId = "6f0c3f8e-1f4b-4a52-9f0e-2d7c5a8b9c10";
const draft = { title: "Show the item count", description: "On the weight sort button.", requestId };

{
  const filed: FileDraft[] = [];
  const file = async (d: FileDraft) => (filed.push(d), { key: "FAC-99", url: "https://linear.app/x/issue/FAC-99" });
  for (const user of [null, { email: "someone@example.com", emailVerified: true }, { email: OWNER, emailVerified: false }]) {
    const outcome = await createJob({ user: async () => user, file }, draft);
    assert.deepEqual([outcome.ok, !outcome.ok && outcome.status], [false, 403], `a non-owner (${user?.email ?? "signed out"}) cannot start a job`);
  }
  assert.equal(filed.length, 0, "and nothing is filed");

  const tooShort = await createJob({ user: async () => owner, file }, { ...draft, title: " a " });
  assert.equal(!tooShort.ok && tooShort.status, 400, "a title under 3 characters is refused");
  const noRequest = await createJob({ user: async () => owner, file }, { ...draft, requestId: "not-a-uuid" });
  assert.equal(!noRequest.ok && noRequest.status, 400, "a request without a request id is refused");
  assert.equal(filed.length, 0);

  const ok = await createJob({ user: async () => owner, file }, { ...draft, title: "  Show the item count  " });
  assert.deepEqual(ok, { ok: true, identifier: "FAC-99", url: "https://linear.app/x/issue/FAC-99" }, "the owner files a job");
  assert.equal(filed[0]!.title, "Show the item count", "with the title trimmed");

  const down = await createJob({ user: async () => owner, file: async () => Promise.reject(new Error("Linear is down")) }, draft);
  assert.equal(!down.ok && down.status, 502, "a Linear failure is reported");
  assert.match(!down.ok ? down.message : "", /Linear is down/);
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
