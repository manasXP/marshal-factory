// The panel's production URL, for links back to it and for the origins Neon trusts. FACTORY_PANEL_URL
// names it; on Vercel the project's production domain is the fallback, so the panel needs no setting.
export const panelUrl = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  (
    env.FACTORY_PANEL_URL ||
    (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "https://marshal-factory.vercel.app")
  ).replace(/\/+$/, "");
