import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { GITHUB_APP_PATH } from "../lib/config";
import { serve } from "./serve";
import { GITHUB_API, appFileSchema, appJwt, githubRequest, readAppFile, type AppFile } from "../lib/github/app";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "3456" },
    "no-open": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    name: { type: "string" },
    url: { type: "string" },
  },
});
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const GITHUB = process.env.GITHUB_URL ?? "https://github.com";
const ingestBase = process.env.NEON_FUNCTION_INGEST_BASE_URL?.replace(/\/$/, "");
if (!ingestBase) throw new Error("NEON_FUNCTION_INGEST_BASE_URL is not set; it names the main ingest Function");

/** owner/name of this checkout's origin, which names the App unless --name and --url do. */
function originRepo() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: import.meta.dirname, encoding: "utf8" });
    return /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.slice(1).join("/");
  } catch {
    return undefined;
  }
}
const origin = args.name && args.url ? undefined : originRepo();
if (!args.name && !origin) throw new Error("can't read this checkout's origin; pass --name for the GitHub App, such as marshal-factory-<you>");
// GitHub App names are unique across GitHub, so the default carries the fork's owner.
const appName = args.name ?? `marshal-factory-${origin!.split("/")[0]!.toLowerCase()}`;
const appUrl = args.url ?? (origin ? `${GITHUB}/${origin}` : GITHUB);

const base = `http://localhost:${args.port}`;
let state: string | undefined = randomBytes(16).toString("hex");

const manifest = {
  name: appName,
  url: appUrl,
  hook_attributes: { url: `${ingestBase}/webhooks/github`, active: true },
  redirect_url: `${base}/callback`,
  setup_url: `${base}/installed`,
  public: false,
  default_permissions: { metadata: "read", contents: "write", pull_requests: "write", checks: "write", issues: "write", statuses: "read" },
  default_events: ["pull_request", "pull_request_review", "push", "issues"],
};

const stored = () => (existsSync(GITHUB_APP_PATH) ? readAppFile() : undefined);

/** A fresh mode-600 file renamed over the old one, so the key is never readable or half written. */
function store(app: AppFile) {
  const dir = dirname(GITHUB_APP_PATH);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${basename(GITHUB_APP_PATH)}.${process.pid}.${randomBytes(4).toString("hex")}`);
  writeFileSync(temp, `${JSON.stringify(app, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temp, GITHUB_APP_PATH);
}

const installUrl = (app: AppFile) => `${GITHUB}/apps/${app.slug}/installations/new`;

const existing = args.force ? undefined : stored();
if (existing?.installation_id) {
  console.log(`GitHub App ${existing.slug} (id ${existing.id}) is set up with installation ${existing.installation_id}; pass --force to register a new one`);
  process.exit(0);
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const html = (body: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>marshal-factory GitHub App</title>${body}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const manifestPage = () =>
  html(`<form id="manifest" method="post" action="${escapeHtml(`${GITHUB}/settings/apps/new?state=${state}`)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<p>Sending the app manifest to GitHub. Click <b>Create GitHub App</b> there, then <b>Install</b>.</p>
<button>Continue to GitHub</button></form>
<script>document.getElementById("manifest").submit()</script>`);

const conversionSchema = appFileSchema.omit({ installation_id: true });

async function callback(url: URL) {
  if (!state || url.searchParams.get("state") !== state) return new Response("state does not match", { status: 400 });
  const code = url.searchParams.get("code");
  if (!code) return new Response("missing code", { status: 400 });
  state = undefined;
  const res = await fetch(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "marshal-factory" },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status !== 201) {
    console.log(`manifest conversion failed with ${res.status}; GitHub may have created the app anyway: delete it under ${GITHUB}/settings/apps, then run this script again`);
    return new Response(`GitHub answered ${res.status} to the manifest conversion`, { status: 502 });
  }
  const parsed = conversionSchema.safeParse(await res.json());
  if (!parsed.success) {
    console.log(`the manifest conversion returned an unexpected shape; delete the new app under ${GITHUB}/settings/apps, then run this script again`);
    return new Response("unexpected conversion response", { status: 502 });
  }
  const app = parsed.data;
  store(app);
  console.log(`stored GitHub App ${app.slug} (id ${app.id}) in ${GITHUB_APP_PATH}`);
  return Response.redirect(installUrl(app), 302);
}

async function installed(url: URL) {
  const app = stored();
  const id = Number(url.searchParams.get("installation_id"));
  if (!app) return new Response("no app registered yet", { status: 409 });
  if (!Number.isInteger(id) || id <= 0) return new Response("missing installation_id", { status: 400 });
  const { json } = await githubRequest(GITHUB_API, appJwt(app), "GET", `/app/installations/${id}`);
  const installation = z.object({ app_id: z.number(), account: z.object({ login: z.string() }) }).parse(json);
  if (installation.app_id !== app.id) return new Response("that installation belongs to another app", { status: 400 });
  store({ ...app, installation_id: id });
  console.log(`recorded installation ${id} on ${installation.account.login}`);
  console.log("next: deploy the ingest Function with the app's webhook secret, then reinstall the runner (README, GitHub App)");
  setTimeout(() => process.exit(0), 100);
  return html("<p>Installed. You can close this tab.</p>");
}

await serve(Number(args.port), async (request) => {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/") {
      const app = args.force ? undefined : stored();
      return app ? Response.redirect(installUrl(app), 302) : manifestPage();
    }
    if (url.pathname === "/callback") return await callback(url);
    if (url.pathname === "/installed") return await installed(url);
    return new Response("not found", { status: 404 });
  } catch (error) {
    console.log(`request to ${url.pathname} failed: ${(error as Error).message}`);
    return new Response("setup failed; see the terminal", { status: 500 });
  }
});

console.log(`open ${base}/ to create the GitHub App`);
if (!args["no-open"]) execFile("open", [`${base}/`]);
