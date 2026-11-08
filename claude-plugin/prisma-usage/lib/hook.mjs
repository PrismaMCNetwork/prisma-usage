import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyError } from "./classify.mjs";
import { logError } from "./log.mjs";
import { PATHS } from "./paths.mjs";
import { record } from "./spool.mjs";
import { loadState, saveState, syncTranscript } from "./state.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FLUSH_THROTTLE_MS = 1500;
const STALE_PENDING_MS = 3600_000;
/** Events after which the queue is sent at once, whatever the throttle says. */
const FORCE_FLUSH = new Set(["Stop", "SubagentStop", "SessionEnd", "PreCompact"]);

const pendingFile = (toolUseId) => join(PATHS.pending, String(toolUseId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80));

function markToolStart(input) {
  if (!input.tool_use_id) return;
  mkdirSync(PATHS.pending, { recursive: true });
  writeFileSync(pendingFile(input.tool_use_id), String(Date.now()));
  // Tools that never finished (Claude closed mid-run) must not pile up.
  for (const f of readdirSync(PATHS.pending)) {
    const p = join(PATHS.pending, f);
    if (Date.now() - statSync(p).mtimeMs > STALE_PENDING_MS) unlinkSync(p);
  }
}

/** Milliseconds since PreToolUse for this tool run, or null when the start was not seen. */
function toolDuration(toolUseId) {
  if (!toolUseId) return null;
  const file = pendingFile(toolUseId);
  try {
    const ms = Date.now() - Number(readFileSync(file, "utf8"));
    unlinkSync(file);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  } catch {
    return null;
  }
}

/** Size of what the tool handed back to the model, in bytes (the content itself is never read out). */
function resultBytes(value) {
  if (value === undefined || value === null) return null;
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
}

export function toolEvent(input, state, event, ms) {
  const failed = event === "PostToolUseFailure";
  const text = failed ? input.error : undefined;
  return {
    kind: "tool",
    id: String(input.tool_use_id ?? ""),
    callId: state.tools[input.tool_use_id] ?? null,
    ts: Date.now(),
    sessionId: String(input.session_id ?? ""),
    tool: String(input.tool_name ?? "unknown"),
    ms,
    ok: !failed,
    errorKind: failed ? (input.is_interrupt ? "interrupted" : classifyError(text)) : null,
    resultBytes: resultBytes(failed ? text : input.tool_response),
  };
}

/** Subagent transcripts live next to the session's own (`<session>/subagents/*.jsonl`). */
function subagentFiles(transcriptPath, sessionId) {
  try {
    const dir = join(dirname(transcriptPath), sessionId, "subagents");
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function spawnFlush(force) {
  try {
    let last = 0;
    try {
      last = statSync(PATHS.spawnMark).mtimeMs;
    } catch {
      writeFileSync(PATHS.spawnMark, "");
    }
    if (!force && Date.now() - last < FLUSH_THROTTLE_MS) return;
    utimesSync(PATHS.spawnMark, new Date(), new Date());
    // Detached, so the hook returns at once and delivery (a network call) never delays the session.
    spawn(process.execPath, [join(PLUGIN_ROOT, "bin", "flush.mjs")], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch (err) {
    logError("spawnFlush", err);
  }
}

/** One hook invocation: capture what changed, queue it, and kick the delivery. Never throws, never prints. */
export function handleHook(event, input) {
  if (event === "PreToolUse") {
    markToolStart(input);
    return;
  }
  const sessionId = String(input.session_id ?? "");
  if (!sessionId) return;
  const state = loadState(sessionId);
  const events = [];

  events.push(...syncTranscript(state, input.transcript_path));
  if (input.agent_transcript_path) events.push(...syncTranscript(state, input.agent_transcript_path, { sidechain: true }));
  if (input.transcript_path && (FORCE_FLUSH.has(event) || event === "SessionStart")) {
    for (const f of subagentFiles(input.transcript_path, sessionId)) events.push(...syncTranscript(state, f, { sidechain: true }));
  }
  if (event === "PostToolUse" || event === "PostToolUseFailure") {
    events.push(toolEvent(input, state, event, toolDuration(input.tool_use_id)));
  }

  saveState(sessionId, state);
  record(events);
  spawnFlush(FORCE_FLUSH.has(event));
}

export function runHook(event, stdinText) {
  try {
    handleHook(event, JSON.parse(stdinText || "{}"));
  } catch (err) {
    logError(`hook ${event}`, err);
  }
}
