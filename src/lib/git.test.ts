import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { runGit } from "./git";

interface FakeChild extends EventEmitter {
  stderr: EventEmitter;
}

function makeFakeSpawn(
  behavior:
    | { type: "success" }
    | { type: "exit"; code: number; stderr?: string }
    | { type: "error"; message: string }
): { spawn: typeof import("node:child_process").spawn; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fakeSpawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child = new EventEmitter() as FakeChild;
    child.stderr = new EventEmitter();

    process.nextTick(() => {
      if (behavior.type === "error") {
        child.emit("error", new Error(behavior.message));
      } else if (behavior.type === "success") {
        child.emit("close", 0);
      } else {
        if (behavior.stderr) {
          child.stderr.emit("data", Buffer.from(behavior.stderr));
        }
        child.emit("close", behavior.code);
      }
    });

    return child as unknown as ChildProcess;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn: fakeSpawn, calls };
}

describe("runGit", () => {
  it("resolves when git exits 0", async () => {
    const { spawn: fake, calls } = makeFakeSpawn({ type: "success" });
    await expect(runGit(["status"], {}, { spawn: fake })).resolves.toBeUndefined();
    expect(calls).toEqual([{ cmd: "git", args: ["status"] }]);
  });

  it("rejects with exit code and stderr tail when git exits non-zero", async () => {
    const { spawn: fake } = makeFakeSpawn({
      type: "exit",
      code: 128,
      stderr: "fatal: not a git repository",
    });
    await expect(runGit(["log"], {}, { spawn: fake })).rejects.toThrow(
      /git log exited with code 128[\s\S]*not a git repository/
    );
  });

  it("rejects when git fails to spawn", async () => {
    const { spawn: fake } = makeFakeSpawn({ type: "error", message: "ENOENT" });
    await expect(runGit(["status"], {}, { spawn: fake })).rejects.toThrow(
      /git status failed to start: ENOENT/
    );
  });

  it("redacts secrets from error messages on non-zero exit", async () => {
    const { spawn: fake } = makeFakeSpawn({
      type: "exit",
      code: 1,
      stderr: "remote: Invalid username or password for https://x-access-token:ghp_secret123@github.com",
    });
    const err = runGit(
      ["-c", "http.extraheader=Authorization: Basic c2VjcmV0", "push"],
      { redact: ["ghp_secret123", "c2VjcmV0"] },
      { spawn: fake }
    );
    await expect(err).rejects.toThrow(/\*\*\*/);
    try {
      await err;
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain("ghp_secret123");
      expect(msg).not.toContain("c2VjcmV0");
    }
  });
});
