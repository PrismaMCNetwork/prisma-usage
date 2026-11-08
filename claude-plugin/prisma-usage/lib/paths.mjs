import { homedir } from "node:os";
import { join } from "node:path";

/** Everything the plugin writes lives here, independent of CLAUDE_CONFIG_DIR. */
export const HOME = process.env.PRISMA_USAGE_HOME || join(homedir(), ".prisma-usage");

export const PATHS = {
  home: HOME,
  config: join(HOME, "config.json"),
  identity: join(HOME, "identity.json"),
  state: join(HOME, "state"),
  pending: join(HOME, "pending"),
  spool: join(HOME, "spool.jsonl"),
  events: join(HOME, "events.jsonl"),
  errors: join(HOME, "errors.log"),
  lock: join(HOME, "flush.lock"),
  spawnMark: join(HOME, "flush.mark"),
};
