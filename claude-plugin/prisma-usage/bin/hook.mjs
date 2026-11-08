#!/usr/bin/env node
import { runHook } from "../lib/hook.mjs";

// Claude Code pipes the hook payload on stdin. Whatever happens, exit 0 with no output: this plugin only
// observes, so it must never block a tool, add context, or fail a session.
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  runHook(process.argv[2] ?? "", data);
  process.exit(0);
});
setTimeout(() => process.exit(0), 8000).unref();
