import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { appendRotating } from "./log.mjs";
import { PATHS } from "./paths.mjs";

const MAX_SPOOL_LINES = 100_000;

/** Queue events for delivery AND keep them in the local log that /prisma-usage reads. */
export function record(events) {
  if (!events.length) return;
  mkdirSync(PATHS.home, { recursive: true });
  const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  appendFileSync(PATHS.spool, text);
  appendRotating(PATHS.events, text);
}

/** Atomically takes the queue (new events go to a fresh file meanwhile). Returns its events and a way to give back what was not sent. */
export function takeSpool() {
  if (!existsSync(PATHS.spool)) return { events: [], file: null };
  const file = `${PATHS.spool}.${process.pid}`;
  renameSync(PATHS.spool, file);
  const events = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* a torn line: drop it */
    }
  }
  return { events, file };
}

/** Puts unsent events back at the queue's head (capped), and removes the taken file. */
export function giveBack(file, unsent) {
  if (unsent.length) {
    const keep = unsent.slice(-MAX_SPOOL_LINES);
    const back = `${PATHS.spool}.back`;
    appendFileSync(back, keep.map((e) => JSON.stringify(e)).join("\n") + "\n");
    // Older events first: whatever arrived meanwhile stays after them.
    const current = existsSync(PATHS.spool) ? readFileSync(PATHS.spool, "utf8") : "";
    appendFileSync(back, current);
    renameSync(back, PATHS.spool);
  }
  if (file && existsSync(file)) unlinkSync(file);
}
