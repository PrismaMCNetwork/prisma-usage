import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The plugin home is read at import time: point it at a temp dir first.
const HOME = mkdtempSync(join(tmpdir(), "prisma-usage-"));
process.env.PRISMA_USAGE_HOME = HOME;
process.env.PRISMA_USAGE_NO_DEFAULTS = "1"; // never report test events to the real server
delete process.env.PRISMA_USAGE_URL;
delete process.env.PRISMA_USAGE_TOKEN;
const { extractCalls } = await import("../lib/transcript.mjs");
const { classifyError } = await import("../lib/classify.mjs");
const { handleHook } = await import("../lib/hook.mjs");
const { flush } = await import("../lib/sender.mjs");
const { saveConfig } = await import("../lib/config.mjs");
const { report } = await import("../lib/report.mjs");

const SPOOL = join(HOME, "spool.jsonl");
const PARTIAL = '{"type":"assistant","mess';
let t0 = Date.now() - 60_000;
const stamp = () => new Date((t0 += 500)).toISOString();
const usage = (o = {}) => ({ input_tokens: 3, output_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100, ...o });
const asst = (id, content, over = {}) =>
  JSON.stringify({ type: "assistant", sessionId: "sess-1", cwd: "D:\\Projects\\Demo", timestamp: stamp(), isSidechain: false, message: { id, model: "claude-opus-5-5", usage: usage(), stop_reason: null, content, ...over.message }, ...over.line });
const user = () => JSON.stringify({ type: "user", sessionId: "sess-1", timestamp: stamp(), message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } });
const toolUse = (id) => ({ type: "tool_use", id, name: "Bash", input: {} });
const buf = (...lines) => Buffer.from(lines.join("\n") + "\n");
const spooled = () => (existsSync(SPOOL) ? readFileSync(SPOOL, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("one call per message id, even though every content block repeats its usage", () => {
  const { calls, toolMap } = extractCalls(buf(asst("m1", [{ type: "text", text: "hi" }]), asst("m1", [toolUse("tu1")], { message: { stop_reason: "tool_use", usage: usage({ output_tokens: 80 }) } }), user()));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].output, 80, "keeps the largest figure");
  assert.equal(calls[0].toolUses, 1);
  assert.equal(calls[0].cacheRead, 4000);
  assert.equal(calls[0].project, "Demo");
  assert.equal(toolMap.tu1, "m1");
});

test("a call still being written at the end of the chunk is held back, then sent whole", () => {
  const first = buf(asst("m1", [{ type: "text", text: "a" }], { message: { stop_reason: "end_turn" } }), asst("m2", [{ type: "text", text: "b" }]));
  const r1 = extractCalls(first);
  assert.deepEqual(r1.calls.map((c) => c.id), ["m1"]);
  assert.ok(r1.consumed < first.length, "m2 is not consumed");
  const done = Buffer.concat([first.subarray(r1.consumed), buf(asst("m2", [toolUse("tu2")], { message: { stop_reason: "tool_use" } }))]);
  assert.deepEqual(extractCalls(done).calls.map((c) => c.id), ["m2"]);
});

test("synthetic messages and a trailing partial line are ignored", () => {
  const whole = buf(asst("s1", [], { message: { model: "<synthetic>", stop_reason: "stop_sequence" } }));
  const r = extractCalls(Buffer.concat([whole, Buffer.from(PARTIAL)]));
  assert.equal(r.calls.length, 0);
  assert.equal(r.consumed, whole.length);
});

test("sidechain flag comes from the subagent transcript", () => {
  const r = extractCalls(buf(asst("a1", [], { message: { stop_reason: "end_turn" } })), { sidechain: true });
  assert.equal(r.calls[0].sidechain, true);
});

test("classifyError groups failures by class and never keeps the text", () => {
  assert.equal(classifyError("Error: No such tool available: grep_repo"), "no_such_tool");
  assert.equal(classifyError("Command timed out after 120s"), "timeout");
  assert.equal(classifyError("Permission to use Bash has been denied"), "denied");
  assert.equal(classifyError("File content exceeds maximum allowed tokens"), "too_large");
  assert.equal(classifyError("No such file or directory"), "not_found");
  assert.equal(classifyError(""), "unknown");
});

test("hooks capture calls from the transcript and tool runs with exact timing, once", async () => {
  const transcript = join(HOME, "t.jsonl");
  writeFileSync(transcript, asst("m1", [toolUse("tu1")], { message: { stop_reason: "tool_use" } }) + "\n");
  const base = { session_id: "sess-1", transcript_path: transcript, tool_name: "Bash", tool_use_id: "tu1" };
  handleHook("PreToolUse", base);
  await new Promise((r) => setTimeout(r, 30));
  handleHook("PostToolUse", { ...base, tool_response: { stdout: "x".repeat(100) } });
  appendFileSync(transcript, [user(), asst("m2", [{ type: "text", text: "done" }], { message: { stop_reason: "end_turn" } })].join("\n") + "\n");
  handleHook("Stop", base);
  handleHook("Stop", base); // nothing new: must not duplicate

  const events = spooled();
  assert.deepEqual(events.filter((e) => e.kind === "call").map((e) => e.id), ["m1", "m2"]);
  const tool = events.find((e) => e.kind === "tool");
  assert.equal(tool.tool, "Bash");
  assert.equal(tool.callId, "m1");
  assert.ok(tool.ms >= 25 && tool.ms < 2000, `ms=${tool.ms}`);
  assert.ok(tool.resultBytes > 100);
  assert.equal(tool.ok, true);
  assert.ok(!JSON.stringify(events).includes("xxxx"), "no result content leaks");
});

test("a failed tool is reported with its class, not its message", () => {
  handleHook("PostToolUseFailure", { session_id: "sess-2", tool_name: "mcp__fleet__grep_repo", tool_use_id: "tuX", error: "No such tool available: grep_repo in /secret/path" });
  const failed = spooled().find((e) => e.id === "tuX");
  assert.equal(failed.ok, false);
  assert.equal(failed.errorKind, "no_such_tool");
  assert.ok(!JSON.stringify(failed).includes("/secret/path"));
});

test("flush delivers the queue; a failing server keeps it queued; a 400 drops the poison batch", async () => {
  saveConfig("http://example.invalid", "tok");
  const queued = spooled().length;
  assert.ok(queued > 0);
  assert.equal(await flush(async () => ({ ok: false, status: 503 })), 0);
  assert.equal(spooled().length, queued, "nothing lost while the server is down");

  const bodies = [];
  const up = async (url, init) => {
    bodies.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  assert.equal(await flush(up), queued);
  assert.equal(bodies[0].url, "http://example.invalid/api/claude-usage/events");
  assert.equal(bodies[0].auth, "Bearer tok");
  assert.ok(bodies[0].body.source.deviceId && bodies[0].body.source.host);
  assert.equal(spooled().length, 0);

  handleHook("PostToolUseFailure", { session_id: "sess-3", tool_name: "Bash", tool_use_id: "tuY", error: "boom" });
  assert.equal(await flush(async () => ({ ok: false, status: 400 })), 1, "a rejected batch is dropped, not retried forever");
  assert.equal(spooled().length, 0);
});

test("the local report summarises calls, tools and failures", () => {
  const out = report(["today"]).join("\n");
  assert.match(out, /API calls/);
  assert.match(out, /Bash/);
  assert.match(out, /Tool failures/);
  assert.match(report(["what-is-sent"]).join("\n"), /NEVER sent: prompts/);
});

test("ingestUrl accepts a bare engine host, a route base or a full endpoint", async () => {
  const { ingestUrl } = await import("../lib/config.mjs");
  assert.equal(ingestUrl("http://h:8770/"), "http://h:8770/api/claude-usage/events");
  assert.equal(ingestUrl("https://prismamc.net/api/public/claude-usage"), "https://prismamc.net/api/public/claude-usage/events");
  assert.equal(ingestUrl("https://x.y/api/public/claude-usage/events"), "https://x.y/api/public/claude-usage/events");
});

test("shipped defaults carry only the url (no secret in the public repo); a token enables reporting, the opt-out turns it off", async () => {
  const { loadConfig } = await import("../lib/config.mjs");
  rmSync(join(HOME, "config.json"), { force: true }); // an earlier test saved one
  assert.equal(loadConfig({}), null, "no token shipped: nothing is reported until setup");
  const cfg = loadConfig({ PRISMA_USAGE_TOKEN: "t".repeat(32) });
  assert.ok(cfg?.url.startsWith("https://"), "defaults.json supplies the url");
  assert.equal(loadConfig({ PRISMA_USAGE_DISABLE: "1" }), null);
  assert.equal(loadConfig({ PRISMA_USAGE_URL: "http://x", PRISMA_USAGE_TOKEN: "t" }).url, "http://x", "env wins");
});
