import { spawn, SpawnOptions } from "node:child_process";

export interface RunGitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunGitDeps {
  spawn?: typeof spawn;
}

// Runs `git <args>`, resolving on exit 0 and rejecting otherwise with the
// full stderr attached so the caller can surface it to the user.
export function runGit(
  args: string[],
  options: RunGitOptions = {},
  deps: RunGitDeps = {}
): Promise<void> {
  const doSpawn = deps.spawn ?? spawn;
  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const child = doSpawn("git", args, spawnOptions);

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`git ${args.join(" ")} failed to start: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = stderr.trim().slice(-500);
        reject(new Error(`git ${args.join(" ")} exited with code ${code}\n${tail}`));
      }
    });
  });
}
