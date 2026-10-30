/** Managed sessions run under a Bun descendant supervisor, including SDK grandchildren. */
export const MANAGED_PROVIDER_GRACE_MS = 5_000;
export const MANAGED_PROVIDER_ABORT_TIMEOUT_MS = 8_000;

// Static source works from both the compiled swarm executable and the source CLI.
// --no-orphans is applied to THIS process; its normal exit kills every descendant,
// including detached grandchildren left behind by a prematurely exiting SDK runner.
export const MANAGED_PROVIDER_SUPERVISOR = `
const grace = Number(process.argv[1]);
const argv = process.argv.slice(2);
if (!Number.isFinite(grace) || grace < 1 || !argv.length) process.exit(78);
const child = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env, cwd: process.cwd() });
let stopping = false;
let deadline;
const stop = () => {
  if (stopping) return;
  stopping = true;
  try { child.kill("SIGTERM"); } catch {}
  deadline = setTimeout(() => process.exit(137), grace);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.exited.then(code => { clearTimeout(deadline); process.exit(code); });
`;

export function managedProviderCommand(
  argv: readonly string[],
  managed: boolean,
  opts: { platform?: NodeJS.Platform; bunPath?: string | null; graceMs?: number } = {},
): string[] {
  if (!managed) return [...argv];
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error("Managed provider process-tree supervision requires Linux or macOS");
  }
  const bunPath = opts.bunPath ?? Bun.which("bun");
  if (!bunPath)
    throw new Error("Managed provider supervisor requires the installed Bun executable");
  return [
    bunPath,
    "--no-orphans",
    "--eval",
    MANAGED_PROVIDER_SUPERVISOR,
    "--",
    String(opts.graceMs ?? MANAGED_PROVIDER_GRACE_MS),
    ...argv,
  ];
}

export interface ProviderProcess {
  readonly exited: Promise<number>;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): void;
}

function unprovenProviderStop(): never {
  console.error(
    "[account-capacity] provider tree stop is unproven; restarting supervised worker for Docker stop recovery",
  );
  process.exit(75);
}

/** Begin watching immediately, before stream drains which orphan pipe holders could stall. */
export async function verifiedProviderExit(
  proc: ProviderProcess,
  managed: boolean,
): Promise<number> {
  let code: number;
  try {
    code = await proc.exited;
  } catch (error) {
    if (managed) return unprovenProviderStop();
    throw error;
  }
  // A signal-killed supervisor may not have executed Bun's descendant cleanup.
  // Its normal numeric exit (including our forced deadline's 137) is the proof.
  if (managed && proc.signalCode !== null) return unprovenProviderStop();
  return code;
}

/** TERM is forwarded by the supervisor, whose deadline guarantees normal tree-cleaning exit. */
export async function abortProviderProcess(
  proc: ProviderProcess,
  managed: boolean,
  exit: Promise<number>,
  timeoutMs = MANAGED_PROVIDER_ABORT_TIMEOUT_MS,
): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    /* It may already have exited. */
  }
  if (!managed) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    exit.then(
      () => true,
      () => false,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (!stopped) unprovenProviderStop();
}
