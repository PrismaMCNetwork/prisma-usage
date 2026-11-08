import { closeSync, existsSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { ingestUrl, loadConfig } from "./config.mjs";
import { getIdentity } from "./identity.mjs";
import { logError } from "./log.mjs";
import { PATHS } from "./paths.mjs";
import { giveBack, takeSpool } from "./spool.mjs";

const BATCH = 200;
const TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 60_000;

/** One flush at a time per PC: a second process finds the lock and leaves the queue to the first. */
function acquireLock() {
  try {
    if (existsSync(PATHS.lock) && Date.now() - statSync(PATHS.lock).mtimeMs > STALE_LOCK_MS) unlinkSync(PATHS.lock);
    const fd = openSync(PATHS.lock, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * POSTs one batch. "sent" = the server has it (or will never accept it, so it is dropped rather than
 * retried forever); "retry" = keep it queued.
 */
export async function postBatch(cfg, source, events, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(ingestUrl(cfg.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ source, events }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return "sent";
    if (res.status === 400) {
      logError("sender", `server rejected a batch (400): dropped ${events.length} events`);
      return "sent";
    }
    logError("sender", `server answered ${res.status}`);
    return "retry";
  } catch (err) {
    logError("sender", err);
    return "retry";
  }
}

/** Delivers the queue. Returns how many events were sent. Safe to call from anywhere, any time. */
export async function flush(fetchImpl = fetch) {
  const cfg = loadConfig();
  if (!cfg || !acquireLock()) return 0;
  let sent = 0;
  try {
    const { events, file } = takeSpool();
    if (!events.length) return 0;
    const source = getIdentity();
    let i = 0;
    for (; i < events.length; i += BATCH) {
      const batch = events.slice(i, i + BATCH);
      if ((await postBatch(cfg, source, batch, fetchImpl)) !== "sent") break;
      sent += batch.length;
    }
    giveBack(file, events.slice(sent));
  } catch (err) {
    logError("flush", err);
  } finally {
    try {
      unlinkSync(PATHS.lock);
    } catch {
      /* already gone */
    }
  }
  return sent;
}
