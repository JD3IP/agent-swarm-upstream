/** No models or credentials: Linux process-tree QA for the actual managed launcher. */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abortProviderProcess,
  managedProviderCommand,
  verifiedProviderExit,
} from "../src/utils/managed-provider-process";

if (process.platform !== "linux") throw new Error("This process-tree QA requires Linux /proc");
if (process.argv[2] === "worker-proof") {
  const root = process.argv[3]!;
  const proc = Bun.spawn(
    managedProviderCommand([process.execPath, join(root, "fixture.ts"), "hang", root], true, {
      graceMs: 150,
    }),
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: process.env.PATH || "", HOME: root },
    },
  );
  await Bun.write(join(root, "supervisor.pid"), String(proc.pid));
  await verifiedProviderExit(proc, true);
  console.log("UNSAFE_RELEASE");
  process.exit(0);
}
if (process.argv[2] === "timeout-proof") {
  const exited = new Promise<number>(() => {});
  await abortProviderProcess({ exited, signalCode: null, kill() {} }, true, exited, 50);
  console.log("UNSAFE_RELEASE");
  process.exit(0);
}
const qaRoot = process.env.SWARM_STOP_QA_ROOT || (await mkdtemp(join(tmpdir(), "swarm-stop-qa-")));
const suppliedRoot = Boolean(process.env.SWARM_STOP_QA_ROOT);
const childSource = `
const [mode, root] = process.argv.slice(2);
await Bun.write(root + "/" + (mode === "grandchild" ? "grandchild" : "child") + ".pid", String(process.pid));
process.on("SIGTERM", () => {});
if (mode === "grandchild") { setInterval(() => {}, 1000); }
else {
  Bun.spawn([process.execPath, process.argv[1], "grandchild", root], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  while (!await Bun.file(root + "/grandchild.pid").exists()) await Bun.sleep(5);
  console.log(JSON.stringify({ kind: "event", event: { type: "message", content: "ready" } }));
  if (mode === "complete") { console.log(JSON.stringify({kind:"result",result:{exitCode:0,isError:false}})); process.exit(0); }
  else setInterval(() => {}, 1000);
}
`;

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function pidAt(root: string, name: string) {
  for (let i = 0; i < 200; i++) {
    try {
      return Number(await readFile(join(root, `${name}.pid`), "utf8"));
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error(`Missing owned ${name} pid`);
}
async function running(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch {
    return false;
  }
}
async function cleanupOwned(root: string) {
  for (const name of ["supervisor", "child", "grandchild"]) {
    try {
      const pid = Number(await readFile(join(root, `${name}.pid`), "utf8"));
      const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (cmd.includes(root)) process.kill(pid, "SIGKILL");
    } catch {
      /* Already stopped or never spawned. */
    }
  }
}

const results: unknown[] = [];
try {
  for (const mode of ["hang", "complete"]) {
    const root = join(qaRoot, mode);
    await mkdir(root, { recursive: true });
    const childFile = join(root, "fixture.ts");
    await Bun.write(childFile, childSource);
    const proc = Bun.spawn(
      managedProviderCommand([process.execPath, childFile, mode, root], true, { graceMs: 150 }),
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH || "", HOME: root },
      },
    );
    await Bun.write(join(root, "supervisor.pid"), String(proc.pid));
    const proof = verifiedProviderExit(proc, true);
    const child = await pidAt(root, "child");
    const grandchild = await pidAt(root, "grandchild");
    const started = Date.now();
    if (mode === "hang") await abortProviderProcess(proc, true, proof, 2000);
    const code = await proof;
    const elapsedMs = Date.now() - started;
    assert(elapsedMs < 2000, "Managed termination exceeded its bounded deadline");
    assert(!(await running(child)), "Child remains active after supervisor completion");
    assert(!(await running(grandchild)), "Grandchild remains active after supervisor completion");
    const frames = (await new Response(proc.stdout).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(frames[0]?.kind === "event", "Supervisor corrupted provider JSON frames");
    if (mode === "complete")
      assert(
        code === 0 && frames[1]?.kind === "result",
        "Normal completion lost result/exit status",
      );
    results.push({
      mode,
      code,
      elapsedMs,
      childStopped: true,
      grandchildStopped: true,
      frames: frames.length,
    });
    await cleanupOwned(root);
  }
  for (const code of [0, 7]) {
    const proc = Bun.spawn(
      managedProviderCommand(
        [
          process.execPath,
          "-e",
          `const input=await Bun.stdin.text();console.log(JSON.stringify({kind:"result",result:{exitCode:${code},input}}));process.exit(${code})`,
        ],
        true,
      ),
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const stdin = proc.stdin as { write(value: string): unknown; end(): unknown };
    stdin.write("test-json-payload");
    stdin.end();
    assert(
      (await verifiedProviderExit(proc, true)) === code,
      "Supervisor changed provider exit status",
    );
    const frame = JSON.parse((await new Response(proc.stdout).text()).trim());
    assert(
      frame.kind === "result" && frame.result.input === "test-json-payload",
      "JSON result framing was changed",
    );
    results.push({ mode: "stdio-exit", code });
  }
  const ambiguousRoot = join(qaRoot, "ambiguous");
  await mkdir(ambiguousRoot, { recursive: true });
  await Bun.write(join(ambiguousRoot, "fixture.ts"), childSource);
  const worker = Bun.spawn([process.execPath, process.argv[1]!, "worker-proof", ambiguousRoot], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await Bun.write(join(ambiguousRoot, "worker.pid"), String(worker.pid));
  const supervisor = await pidAt(ambiguousRoot, "supervisor");
  await pidAt(ambiguousRoot, "child");
  await pidAt(ambiguousRoot, "grandchild");
  process.kill(supervisor, "SIGKILL");
  assert((await worker.exited) === 75, "Ambiguous supervisor death did not fail closed");
  assert(
    !(await new Response(worker.stdout).text()).includes("UNSAFE_RELEASE"),
    "Lease was released without stop proof",
  );
  assert(
    (await new Response(worker.stderr).text()).includes("stop is unproven"),
    "Docker stop recovery was not requested",
  );
  await cleanupOwned(ambiguousRoot);
  results.push({ mode: "ambiguous-supervisor-kill", workerExit: 75, leaseReleased: false });
  const timeout = Bun.spawn([process.execPath, process.argv[1]!, "timeout-proof"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await Bun.write(join(qaRoot, "timeout.pid"), String(timeout.pid));
  assert((await timeout.exited) === 75, "Unresponsive exit monitor did not fail closed");
  assert(
    !(await new Response(timeout.stdout).text()).includes("UNSAFE_RELEASE"),
    "Timeout incorrectly acknowledged stop",
  );
  results.push({ mode: "unavailable-stop-proof", workerExit: 75, leaseReleased: false });
  console.log(JSON.stringify({ ok: true, bun: Bun.version, results }));
} finally {
  await cleanupOwned(join(qaRoot, "hang"));
  await cleanupOwned(join(qaRoot, "complete"));
  await cleanupOwned(join(qaRoot, "ambiguous"));
  if (!suppliedRoot) await rm(qaRoot, { recursive: true, force: true });
}
