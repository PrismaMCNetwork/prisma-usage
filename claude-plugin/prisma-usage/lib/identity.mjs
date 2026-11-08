import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, userInfo } from "node:os";
import { join } from "node:path";
import { PATHS } from "./paths.mjs";

const CACHE_MS = 24 * 3600_000;
const CLIENT = "prisma-usage/0.1.0";

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 2500, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** The OS' own machine id, when it has one. Never sent raw: only a hash of it is. */
function machineId() {
  const os = platform();
  if (os === "win32") return (run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]).match(/MachineGuid\s+REG_SZ\s+(\S+)/) ?? [])[1] ?? "";
  if (os === "darwin") return (run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]).match(/"IOPlatformUUID" = "([^"]+)"/) ?? [])[1] ?? "";
  for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) if (existsSync(f)) return readFileSync(f, "utf8").trim();
  return "";
}

/** The email of the Claude account in use, from the config dir Claude Code runs with. */
export function accountEmail(env = process.env) {
  const dirs = [env.CLAUDE_CONFIG_DIR, join(homedir())].filter(Boolean);
  const files = [...dirs.map((d) => join(d, ".claude.json")), join(homedir(), ".claude.json")];
  for (const f of files) {
    try {
      const email = JSON.parse(readFileSync(f, "utf8"))?.oauthAccount?.emailAddress;
      if (typeof email === "string" && email) return email;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

function stableDeviceId(cached) {
  if (cached?.deviceId) return cached.deviceId;
  const raw = machineId();
  // No OS id (rare): a random one persisted on first run is still stable for this install.
  return createHash("sha256").update(raw ? `${raw}|${userInfo().username}` : randomUUID()).digest("hex").slice(0, 16);
}

/**
 * Who is reporting: this PC, its OS user, git identity and Claude account. Self-declared and cached for a
 * day, because spawning git and reg on every hook would be slow.
 */
export function getIdentity(now = Date.now()) {
  let cached = null;
  try {
    cached = JSON.parse(readFileSync(PATHS.identity, "utf8"));
  } catch {
    /* first run */
  }
  const account = accountEmail();
  if (cached && now - cached.at < CACHE_MS && cached.source?.account === account) return cached.source;
  const source = {
    deviceId: stableDeviceId(cached?.source),
    host: hostname(),
    user: userInfo().username,
    os: `${platform()} ${process.arch}`,
    account,
    gitUser: run("git", ["config", "--global", "user.name"]) || null,
    gitEmail: run("git", ["config", "--global", "user.email"]) || null,
    client: CLIENT,
  };
  try {
    mkdirSync(PATHS.home, { recursive: true });
    writeFileSync(PATHS.identity, JSON.stringify({ at: now, source }));
  } catch {
    /* identity still works uncached */
  }
  return source;
}
