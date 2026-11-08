/**
 * A short class for a tool failure, so the dashboard can group them. Only the class is ever reported:
 * the message itself may contain paths, commands or output and never leaves the PC.
 */
export function classifyError(message) {
  const t = String(message ?? "").toLowerCase();
  if (!t) return "unknown";
  if (t.includes("no such tool")) return "no_such_tool";
  if (t.includes("interrupt") || t.includes("aborted") || t.includes("cancel")) return "interrupted";
  if (t.includes("timed out") || t.includes("timeout")) return "timeout";
  if (t.includes("permission") || t.includes("denied") || t.includes("not allowed") || t.includes("user rejected") || t.includes("doesn't want to proceed")) return "denied";
  if (t.includes("too large") || t.includes("exceeds") || t.includes("too many tokens")) return "too_large";
  if (t.includes("not found") || t.includes("no such file") || t.includes("enoent")) return "not_found";
  if (t.includes("old_string") || t.includes("string to replace") || t.includes("not unique")) return "edit_mismatch";
  if (t.includes("exit code") || t.includes("command failed")) return "command_failed";
  if (t.includes("econn") || t.includes("network") || t.includes("fetch failed") || t.includes("enotfound")) return "network";
  if (t.includes("invalid") || t.includes("validation") || t.includes("schema")) return "bad_input";
  return "other";
}
