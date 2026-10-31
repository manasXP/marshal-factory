import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { z } from "zod";
import { panelUrl } from "../lib/panel-url";
import { ask, askHidden } from "./prompt";

// Creates the panel's owner account from the terminal, with sign-up left off. Neon Auth's API creates
// the user without a password; the code Neon Auth then emails for a password reset sets the password,
// and a verification code proves the address when the reset didn't. Running it again for an account
// that is already set up changes nothing.
//   bun scripts/create-owner.ts [--email <address>] [--branch main]
// The address must be in FACTORY_OWNER_EMAILS; without --email the first one is used.

const root = join(import.meta.dirname, "..");
process.chdir(root);
process.loadEnvFile(".env.local");
const { values: args } = parseArgs({ options: { email: { type: "string" }, branch: { type: "string", default: "main" } } });

const owners = (process.env.FACTORY_OWNER_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const email = (args.email ?? owners[0])?.toLowerCase();
if (!email) throw new Error("FACTORY_OWNER_EMAILS in .env.local is empty; add your address there first");
if (!owners.includes(email)) throw new Error(`${email} is not in FACTORY_OWNER_EMAILS, so the panel would refuse it`);

const projectId = z.object({ projectId: z.string() }).parse(JSON.parse(readFileSync(".neon", "utf8"))).projectId;
const where = ["--branch", args.branch, "--project-id", projectId];
const neon = (...neonArgs: string[]) => execFileSync("neon", [...neonArgs, ...where], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const neonJson = (...neonArgs: string[]) => JSON.parse(neon(...neonArgs, "--output", "json")) as unknown;

// Neon Auth answers a reset only from an origin it trusts, which the panel's must be for sign-in anyway.
const origin = panelUrl();
const domains = z.array(z.object({ domain: z.string() })).parse(neonJson("neon-auth", "domain", "list"));
if (!domains.some((d) => d.domain.replace(/\/+$/, "") === origin)) {
  neon("neon-auth", "domain", "add", origin);
  console.log(`Neon Auth now trusts ${origin}`);
}
const authBase = z.object({ base_url: z.string() }).parse(neonJson("neon-auth", "status")).base_url.replace(/\/+$/, "");

const db = new Client({ connectionString: neon("connection-string").trim().replace("sslmode=require", "sslmode=verify-full") });
await db.connect();
async function account() {
  const { rows } = await db.query<{ verified: boolean; has_password: boolean }>(
    `select u."emailVerified" as verified,
       exists (select 1 from neon_auth.account a where a."userId" = u.id and a."providerId" = 'credential' and a.password is not null) as has_password
     from neon_auth."user" u where lower(u.email) = $1`,
    [email],
  );
  return rows[0];
}

async function auth(path: string, body: object) {
  const res = await fetch(`${authBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(`Neon Auth answered ${res.status} to ${path}${json.message ? `: ${json.message}` : ""}`);
}

const code = async (why: string) => {
  for (;;) {
    const otp = await ask(`The 6-digit code from the ${why} email (sender auth@mail.myneon.app, valid 5 minutes): `);
    if (/^\d{6}$/.test(otp)) return otp;
    console.log("That is not a 6-digit code.");
  }
};

async function newPassword() {
  for (;;) {
    const password = await askHidden("New password for the panel (at least 8 characters, hidden): ");
    if (password.length < 8) {
      console.log("Use at least 8 characters.");
      continue;
    }
    if ((await askHidden("Same password again: ")) === password) return password;
    console.log("The two passwords differ.");
  }
}

let current = await account();
if (current?.verified && current.has_password) {
  console.log(`${email} is already set up; sign in at ${origin}/auth/sign-in`);
} else {
  if (!current) {
    neon("neon-auth", "user", "create", "--email", email);
    console.log(`created ${email} in Neon Auth on ${args.branch}`);
  }
  if (!current?.has_password) {
    await auth("/email-otp/request-password-reset", { email });
    console.log(`Neon Auth emailed a password reset code to ${email}.`);
    const otp = await code("password reset");
    await auth("/email-otp/reset-password", { email, otp, password: await newPassword() });
    console.log("password set");
  }
  current = await account();
  if (!current?.verified) {
    await auth("/email-otp/send-verification-otp", { email, type: "email-verification" });
    console.log(`Neon Auth emailed a verification code to ${email}.`);
    await auth("/email-otp/verify-email", { email, otp: await code("verification") });
    current = await account();
  }
  if (!current?.verified || !current.has_password) throw new Error(`${email} is still not verified with a password; run this again`);
  console.log(`${email} is the owner; sign in at ${origin}/auth/sign-in`);
}
await db.end();
process.exit(0);
