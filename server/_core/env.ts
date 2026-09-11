export const ENV = {
  appId: process.env.VITE_APP_ID || process.env.APP_ID || "futureme",
  cookieSecret: process.env.JWT_SECRET || "development-only-change-me",
  databaseUrl: process.env.DATABASE_URL || "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL || "",
  ownerOpenId: process.env.OWNER_OPEN_ID || "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL || "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY || "",
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  appUrl: process.env.APP_URL || process.env.VITE_APP_URL || "",
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openRouterModel: process.env.OPENROUTER_MODEL || "openrouter/free",
  /**
   * Comma-separated fallback models, tried in order when the primary is
   * unavailable. Deliberately not hardcoded in source: provider catalogues
   * change and a stale model name silently breaks every agent.
   */
  openRouterModels: process.env.OPENROUTER_MODELS || "",
  openRouterSiteUrl: process.env.OPENROUTER_SITE_URL || "",
  openRouterSiteName: process.env.OPENROUTER_SITE_NAME || "FutureMe",
};
