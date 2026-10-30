/** Compare the public bundled application code in two Bun-compiled API executables. */
import { createHash } from "node:crypto";

function apiBundle(binary: Buffer): Buffer {
  const anchor = binary.lastIndexOf(Buffer.from("\n// src/http/poll.ts\n"));
  if (anchor < 0) throw new Error("Compiled API poll module marker is missing");
  const start = binary.lastIndexOf(0, anchor) + 1;
  const end = binary.indexOf(0, anchor);
  if (end <= start) throw new Error("Compiled API application bundle boundary is missing");
  return binary.subarray(start, end);
}

const [livePath, rebuiltPath] = process.argv.slice(2);
if (!livePath || !rebuiltPath)
  throw new Error("Usage: bun scripts/verify-installed-api-bundle.ts LIVE_API REBUILT_API");
const live = apiBundle(Buffer.from(await Bun.file(livePath).arrayBuffer()));
const rebuilt = apiBundle(Buffer.from(await Bun.file(rebuiltPath).arrayBuffer()));
const equal = live.equals(rebuilt);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
console.log(
  JSON.stringify({
    equal,
    liveBytes: live.length,
    rebuiltBytes: rebuilt.length,
    liveSha256: digest(live),
    rebuiltSha256: digest(rebuilt),
  }),
);
if (!equal) process.exit(1);
