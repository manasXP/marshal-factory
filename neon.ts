import { defineConfig } from "@neon/config/v1";
import { readAppFile } from "./lib/github/app";
import { panelUrl } from "./lib/panel-url";

export default defineConfig({
  auth: true,
  // Browsers may only open live feeds from the panel itself; sealed queries are still owner-only.
  preview: { realtime: { allowedOrigins: [panelUrl(), "http://localhost:3007"] } },
  functions: {
    ingest: {
      name: "factory ingest",
      source: "functions/ingest/index.ts",
      env: {
        FACTORY_INGEST_SECRET: process.env.FACTORY_INGEST_SECRET!,
        LINEAR_WEBHOOK_SECRET: process.env.LINEAR_WEBHOOK_SECRET!,
        GITHUB_APP_WEBHOOK_SECRET: process.env.GITHUB_APP_WEBHOOK_SECRET || readAppFile().webhook_secret,
        // Match factory.teamKey and factory.label in the config when they differ from these.
        FACTORY_TEAM_KEY: process.env.FACTORY_TEAM_KEY ?? "FAC",
        FACTORY_LABEL: process.env.FACTORY_LABEL ?? "factory",
      },
    },
  },
});
