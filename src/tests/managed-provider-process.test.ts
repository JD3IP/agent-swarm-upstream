import { describe, expect, test } from "bun:test";
import {
  abortProviderProcess,
  managedProviderCommand,
  verifiedProviderExit,
} from "../utils/managed-provider-process";

describe("managed provider process supervision", () => {
  test("legacy native argv stays unchanged without requiring a supervisor", () => {
    expect(
      managedProviderCommand(["claude", "-p", "task"], false, { platform: "win32", bunPath: null }),
    ).toEqual(["claude", "-p", "task"]);
  });

  test("managed compiled and native commands use the installed Bun descendant supervisor", () => {
    for (const argv of [
      ["/usr/bin/claude", "-p", "task"],
      ["/usr/local/bin/agent-swarm", "codex-session-runner"],
    ]) {
      const wrapped = managedProviderCommand(argv, true, {
        platform: "linux",
        bunPath: "/usr/local/bin/bun",
        graceMs: 200,
      });
      expect(wrapped.slice(0, 3)).toEqual(["/usr/local/bin/bun", "--no-orphans", "--eval"]);
      expect(wrapped.slice(-argv.length)).toEqual(argv);
      expect(wrapped).toContain("200");
    }
  });

  test("managed unsupported platforms refuse before launching a provider", () => {
    expect(() => managedProviderCommand(["claude"], true, { platform: "win32" })).toThrow(
      "requires Linux or macOS",
    );
  });

  test("managed abort waits for supervisor exit, rather than acknowledging TERM alone", async () => {
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const signals: unknown[] = [];
    const proc = {
      exited,
      signalCode: null,
      kill: (signal: unknown) => {
        signals.push(signal);
      },
    };
    let stopped = false;
    const proof = verifiedProviderExit(proc, true);
    const abort = abortProviderProcess(proc, true, proof, 1000).then(() => {
      stopped = true;
    });
    await Bun.sleep(10);
    expect(stopped).toBe(false);
    expect(signals).toEqual(["SIGTERM"]);
    resolveExit(137);
    await abort;
    expect(stopped).toBe(true);
  });
});
