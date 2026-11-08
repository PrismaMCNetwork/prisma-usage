import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "./paths.mjs";
import { extractCalls, readFrom } from "./transcript.mjs";

const MAX_TOOL_LINKS = 600;
const safe = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);

export function loadState(sessionId) {
  try {
    return JSON.parse(readFileSync(join(PATHS.state, `${safe(sessionId)}.json`), "utf8"));
  } catch {
    return { files: {}, tools: {} };
  }
}

export function saveState(sessionId, state) {
  const keys = Object.keys(state.tools);
  if (keys.length > MAX_TOOL_LINKS) for (const k of keys.slice(0, keys.length - MAX_TOOL_LINKS)) delete state.tools[k];
  mkdirSync(PATHS.state, { recursive: true });
  writeFileSync(join(PATHS.state, `${safe(sessionId)}.json`), JSON.stringify(state));
}

/**
 * Reads what a transcript gained since the last hook and returns its finished API calls. The byte offset
 * and the tool→call links persist per session, so every hook only ever parses the new lines.
 */
export function syncTranscript(state, path, opts = {}) {
  if (!path) return [];
  const from = state.files[path] ?? 0;
  const buf = readFrom(path, from);
  if (!buf) return [];
  const { calls, toolMap, consumed } = extractCalls(buf, opts);
  state.files[path] = from + consumed;
  Object.assign(state.tools, toolMap);
  return calls;
}
