import { existsSync, readFileSync } from "node:fs";
import { loadConfig, saveConfig } from "./config.mjs";
import { accountEmail, getIdentity } from "./identity.mjs";
import { PATHS } from "./paths.mjs";

const DAY_MS = 86_400_000;
/** Rough price weights relative to one fresh input token (cache read 0.1x, cache write 1.25x, output 5x). */
const WEIGHT = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 };

const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const pad = (s, n) => String(s).padEnd(n);
const weighted = (c) => c.input * WEIGHT.input + c.cacheRead * WEIGHT.cacheRead + c.cacheWrite * WEIGHT.cacheWrite + c.output * WEIGHT.output;

export function readEvents(since) {
  const out = [];
  for (const f of [`${PATHS.events}.1`, PATHS.events]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.ts >= since) out.push(e);
      } catch {
        /* torn line */
      }
    }
  }
  return out;
}

/** Calls and tools are logged once per hook that saw them; keep the first of each id. */
function unique(events) {
  const seen = new Set();
  return events.filter((e) => {
    const k = `${e.kind}:${e.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function sum(calls) {
  const t = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, maxContext: 0 };
  for (const c of calls) {
    t.calls += 1;
    t.input += c.input;
    t.output += c.output;
    t.cacheRead += c.cacheRead;
    t.cacheWrite += c.cacheWrite;
    t.maxContext = Math.max(t.maxContext, c.input + c.cacheRead + c.cacheWrite);
  }
  return t;
}

function groupBy(items, key) {
  const m = new Map();
  for (const it of items) m.set(key(it), [...(m.get(key(it)) ?? []), it]);
  return m;
}

function overview(calls, label) {
  const t = sum(calls);
  const lines = [`${label}: ${t.calls} API calls · input ${fmt(t.input)} · output ${fmt(t.output)} · cache read ${fmt(t.cacheRead)} · cache write ${fmt(t.cacheWrite)} · biggest context ${fmt(t.maxContext)}`];
  for (const [model, cs] of [...groupBy(calls, (c) => c.model)].sort((a, b) => weighted(sum(b[1])) - weighted(sum(a[1])))) {
    const s = sum(cs);
    lines.push(`  ${pad(model, 24)} ${pad(`${s.calls} calls`, 12)} ~${fmt(weighted(s))} input-equivalent`);
  }
  return lines;
}

function sessions(calls, limit = 8) {
  const rows = [...groupBy(calls, (c) => c.sessionId)].map(([id, cs]) => ({ id, project: cs[0].project ?? "-", s: sum(cs) })).sort((a, b) => weighted(b.s) - weighted(a.s));
  return ["Sessions that burn the most (input-equivalent):", ...rows.slice(0, limit).map((r) => `  ${pad(r.id.slice(0, 8), 9)} ${pad(r.project, 22)} ${pad(`${r.s.calls} calls`, 11)} avg context ${pad(fmt((r.s.input + r.s.cacheRead + r.s.cacheWrite) / r.s.calls), 8)} ~${fmt(weighted(r.s))}`)];
}

function tools(toolEvents, limit = 12) {
  const rows = [...groupBy(toolEvents, (t) => t.tool)]
    .map(([name, ts]) => ({ name, runs: ts.length, errors: ts.filter((t) => !t.ok).length, ms: ts.reduce((a, t) => a + (t.ms ?? 0), 0), bytes: ts.reduce((a, t) => a + (t.resultBytes ?? 0), 0), maxBytes: Math.max(...ts.map((t) => t.resultBytes ?? 0)) }))
    .sort((a, b) => b.bytes - a.bytes);
  return ["Tools by result size (what they feed back into the context):", ...rows.slice(0, limit).map((r) => `  ${pad(r.name, 30)} ${pad(`${r.runs} runs`, 10)} ${pad(`${r.errors} err`, 7)} avg ${pad(`${Math.round(r.ms / r.runs)}ms`, 8)} results ${pad(fmt(r.bytes) + "B", 9)} max ${fmt(r.maxBytes)}B`)];
}

function errors(toolEvents, limit = 15) {
  const failed = toolEvents.filter((t) => !t.ok);
  const rows = [...groupBy(failed, (t) => `${t.tool} · ${t.errorKind ?? "unknown"}`)].sort((a, b) => b[1].length - a[1].length);
  return [`Tool failures: ${failed.length} of ${toolEvents.length} runs`, ...rows.slice(0, limit).map(([k, v]) => `  ${pad(k, 44)} ${v.length}x`)];
}

function status() {
  const cfg = loadConfig();
  const id = getIdentity();
  let queued = 0;
  try {
    queued = readFileSync(PATHS.spool, "utf8").split("\n").filter(Boolean).length;
  } catch {
    /* empty queue */
  }
  return [
    `Reporting to: ${cfg ? cfg.url : "NOT CONFIGURED (events are only kept locally) — run: /prisma-usage setup <url> <token>"}`,
    `Queued, not yet delivered: ${queued}`,
    `This PC: ${id.host} (${id.user}), device ${id.deviceId}, account ${id.account ?? accountEmail() ?? "unknown"}`,
    `Local files: ${PATHS.home}`,
  ];
}

const WHAT_IS_SENT = [
  "Sent to the server: your PC name, OS user, a hash of the machine id, git user name/email, the Claude account email,",
  "and per API call: model, token counts (input/output/cache), stop reason, number of tools asked, session id, project folder name;",
  "per tool run: tool name, duration, ok/failed, a short failure class (timeout, denied…), size in bytes of the result.",
  "NEVER sent: prompts, responses, file contents, commands, tool inputs/outputs or error messages.",
  `The same events are kept in ${PATHS.events} so you can check.`,
];

/** Output of `/prisma-usage <args>` as text. */
export function report(args, now = Date.now()) {
  const [cmd = "today", a, b] = args;
  if (cmd === "setup") {
    if (!a || !b) return ["usage: /prisma-usage setup <url> <token>   e.g. https://prismamc.net/api/public/claude-usage <token>"];
    saveConfig(a, b);
    return [`Saved. Events will be reported to ${a}.`, ...status()];
  }
  if (cmd === "status") return status();
  if (cmd === "what-is-sent") return WHAT_IS_SENT;

  const since = cmd === "week" ? now - 7 * DAY_MS : now - DAY_MS;
  const events = unique(readEvents(since));
  const calls = events.filter((e) => e.kind === "call");
  const toolEvents = events.filter((e) => e.kind === "tool");
  if (!calls.length && !toolEvents.length) return ["No usage recorded in that period yet.", ...status()];
  const label = cmd === "week" ? "Last 7 days" : "Last 24 hours";
  if (cmd === "tools") return tools(toolEvents);
  if (cmd === "errors") return errors(toolEvents);
  if (cmd === "sessions") return sessions(calls);
  return [...overview(calls, label), "", ...sessions(calls, 5), "", ...tools(toolEvents, 6), "", ...errors(toolEvents, 6)];
}
