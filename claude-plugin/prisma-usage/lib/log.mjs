import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { PATHS } from "./paths.mjs";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Appends to a file under the plugin home, rotating it once at 5 MB (one `.1` backup kept). */
export function appendRotating(file, text) {
  mkdirSync(PATHS.home, { recursive: true });
  try {
    if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
  } catch {
    /* no file yet */
  }
  appendFileSync(file, text);
}

/** Local error trail for debugging the plugin itself. Never throws: a hook must not fail on its own log. */
export function logError(where, err) {
  try {
    appendRotating(PATHS.errors, `${new Date().toISOString()} ${where}: ${err?.stack || err}\n`);
  } catch {
    /* nothing left to do */
  }
}
