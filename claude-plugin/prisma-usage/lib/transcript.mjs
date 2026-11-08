import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";

const NL = 0x0a;
const SYNTHETIC_MODEL = "<synthetic>";

/** Bytes of `path` from `offset` to EOF, or null when the file is gone or has not grown. */
export function readFrom(path, offset) {
  let fd;
  try {
    const size = statSync(path).size;
    if (size <= offset) return null;
    fd = openSync(path, "r");
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return buf;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Complete lines of a buffer with the byte offset each starts at; a trailing partial line is left out. */
export function completeLines(buf) {
  const lines = [];
  let start = 0;
  for (let i = buf.indexOf(NL); i !== -1; i = buf.indexOf(NL, start)) {
    lines.push({ start, text: buf.toString("utf8", start, i) });
    start = i + 1;
  }
  return { lines, end: start };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function parse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The API calls in a chunk of transcript. Claude Code writes one line per content block and repeats the
 * call's `usage` on each, so lines are grouped by `message.id` and a call is reported once, with the
 * largest figure seen. A group still being written (no stop reason and nothing after it yet) is held back:
 * `consumed` stops before it, so the next read starts there and sends it whole.
 *
 * Also returns tool_use id → message id, which links a tool run to the call that asked for it.
 */
export function extractCalls(buf, { sidechain = false } = {}) {
  const { lines, end } = completeLines(buf);
  const groups = new Map();
  const order = [];
  const toolMap = {};
  let prevTs = null;
  let lastGroupId = null;

  for (const { start, text } of lines) {
    const line = parse(text);
    if (!line) continue;
    const msg = line.message;
    const ts = Date.parse(line.timestamp);
    if (line.type === "assistant" && msg?.id && msg.usage) {
      let g = groups.get(msg.id);
      if (!g) {
        g = { id: msg.id, start, firstTs: ts, prevTs, usage: {}, line, stopReason: null, toolUses: 0, model: msg.model };
        groups.set(msg.id, g);
        order.push(g);
      }
      for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) g.usage[k] = Math.max(num(g.usage[k]), num(msg.usage[k]));
      if (msg.stop_reason) g.stopReason = msg.stop_reason;
      g.lastTs = ts;
      g.line = line;
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b?.type === "tool_use") {
          g.toolUses += 1;
          if (typeof b.id === "string") toolMap[b.id] = msg.id;
        }
      }
      lastGroupId = msg.id;
    } else if (Number.isFinite(ts)) {
      prevTs = ts;
      lastGroupId = null;
    }
  }

  let consumed = end;
  const calls = [];
  for (const g of order) {
    // Only the group at the very end of the chunk can still be growing.
    if (g.id === lastGroupId && !g.stopReason) {
      consumed = g.start;
      continue;
    }
    if (g.model === SYNTHETIC_MODEL || !g.model) continue;
    const u = g.usage;
    const l = g.line;
    calls.push({
      kind: "call",
      id: g.id,
      ts: Number.isFinite(g.lastTs) ? g.lastTs : Date.now(),
      sessionId: String(l.sessionId ?? l.session_id ?? ""),
      project: l.cwd ? basename(String(l.cwd)) : null,
      model: String(g.model),
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      stopReason: g.stopReason,
      toolUses: g.toolUses,
      sidechain: sidechain || l.isSidechain === true,
      ms: Number.isFinite(g.firstTs) && Number.isFinite(g.prevTs) && g.firstTs >= g.prevTs ? g.firstTs - g.prevTs : null,
    });
  }
  return { calls, toolMap, consumed };
}
