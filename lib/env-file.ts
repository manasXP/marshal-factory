/**
 * Line numbers in a .env file that are not NAME=value. A pasted token that wrapped onto a second
 * line leaves one, and parsers then drop the rest of the value without a word.
 */
export const wrappedLines = (text: string) =>
  text.split("\n").flatMap((line, i) => (line.trim() && !line.trim().startsWith("#") && !/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line) ? [i + 1] : []));

/** What the panel's Vercel project needs for Production (README step 8); GITHUB_APP_* come from github-app.json. */
export const PANEL_ENV = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "NEON_AUTH_BASE_URL",
  "NEON_AUTH_COOKIE_SECRET",
  "NEON_REALTIME_URL",
  "NEXT_PUBLIC_NEON_REALTIME_URL",
  "NEON_REALTIME_SECRET",
  "FACTORY_OWNER_EMAILS",
  "LINEAR_API_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
];
/** Also needed in Vercel once Slack is connected. */
export const SLACK_ENV = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_OWNER_USER_ID"];
