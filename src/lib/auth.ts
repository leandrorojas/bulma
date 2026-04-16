import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Internal seam — replaced in tests. Deliberately not exported to keep
// the public surface small; tests import via `__test_only__` below.
async function ghAuthToken(): Promise<string> {
  const { stdout } = await execFileAsync("gh", ["auth", "token"]);
  return stdout.trim();
}

export interface ResolveTokenDeps {
  getEnv?: (name: string) => string | undefined;
  readGhToken?: () => Promise<string>;
}

export async function resolveToken(deps: ResolveTokenDeps = {}): Promise<string> {
  const getEnv = deps.getEnv ?? ((name: string) => process.env[name]);
  const readGh = deps.readGhToken ?? ghAuthToken;

  const fromEnv = getEnv("GITHUB_TOKEN") ?? getEnv("GH_TOKEN");
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }

  try {
    const token = await readGh();
    if (token.length === 0) {
      throw new Error("gh auth token returned empty");
    }
    return token;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      "No GitHub token available. Set GITHUB_TOKEN env var or run `gh auth login`. " +
        `(fallback failed: ${reason})`
    );
  }
}
