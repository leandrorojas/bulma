import { spawn, SpawnOptions } from "node:child_process";

export interface RunGitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  // Values to redact from error messages (e.g. tokens, base64-encoded
  // credentials). Each occurrence is replaced with "***".
  redact?: string[];
}

export interface RunGitDeps {
  spawn?: typeof spawn;
}

function redactSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const s of secrets) {
    if (s.length > 0) {
      result = result.replaceAll(s, "***");
    }
  }
  return result;
}

// Runs `git <args>`, resolving on exit 0 and rejecting otherwise with the
// full stderr attached so the caller can surface it to the user.
export function runGit(
  args: string[],
  options: RunGitOptions = {},
  deps: RunGitDeps = {}
): Promise<void> {
  const doSpawn = deps.spawn ?? spawn;
  const secrets = options.redact ?? [];

  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    };
    // NOSONAR(tssecurity:S6350): command is hardcoded ("git"); args are a
    // pre-built array (no shell interpretation). The only user-controlled
    // values reaching this path are siteName (validated in create.ts against
    // /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/) and the hoi-poi clone URL (hardcoded
    // default, overridable only from internal code). Not a command-injection vector.
    const child = doSpawn("git", args, spawnOptions); // NOSONAR

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      const safeArgs = redactSecrets(args.join(" "), secrets);
      reject(new Error(`git ${safeArgs} failed to start: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const safeArgs = redactSecrets(args.join(" "), secrets);
        const safeTail = redactSecrets(stderr.trim().slice(-500), secrets);
        reject(new Error(`git ${safeArgs} exited with code ${code}\n${safeTail}`));
      }
    });
  });
}
