import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PATHS } from "./paths.mjs";

/** The url/token shipped with the plugin (defaults.json), so installing it is the whole setup. */
function shippedDefaults() {
  try {
    return JSON.parse(readFileSync(new URL("../defaults.json", import.meta.url), "utf8"));
  } catch {
    return {};
  }
}

/**
 * `{ url, token }` from PRISMA_USAGE_URL / PRISMA_USAGE_TOKEN, then ~/.prisma-usage/config.json, then the
 * plugin's own defaults.json; null when none is set or PRISMA_USAGE_DISABLE=1 (the opt-out: events then stay local).
 */
export function loadConfig(env = process.env) {
  if (env.PRISMA_USAGE_DISABLE === "1") return null;
  let file = {};
  try {
    file = JSON.parse(readFileSync(PATHS.config, "utf8"));
  } catch {
    /* no config file yet */
  }
  const shipped = env.PRISMA_USAGE_NO_DEFAULTS === "1" ? {} : shippedDefaults();
  const url = String(env.PRISMA_USAGE_URL || file.url || shipped.url || "").replace(/\/+$/, "");
  const token = String(env.PRISMA_USAGE_TOKEN || file.token || shipped.token || "");
  return url && token ? { url, token } : null;
}

/**
 * The URL to POST to. Accepts the bare host of an engine (`http://host:8770`), the engine's route base
 * (`…/api/claude-usage`) or a full endpoint (`…/events`) — the public site forwards at
 * `https://prismamc.net/api/public/claude-usage`.
 */
export function ingestUrl(base) {
  const url = String(base).replace(/\/+$/, "");
  if (url.endsWith("/events")) return url;
  if (url.endsWith("/claude-usage")) return `${url}/events`;
  return `${url}/api/claude-usage/events`;
}

export function saveConfig(url, token) {
  mkdirSync(PATHS.home, { recursive: true });
  writeFileSync(PATHS.config, JSON.stringify({ url: String(url).replace(/\/+$/, ""), token }, null, 2), { mode: 0o600 });
}
