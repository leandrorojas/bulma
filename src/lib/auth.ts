import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Internal seam — replaced in tests via the deps parameter on resolveToken.
async function ghAuthToken(): Promise<string> {
  const { stdout } = await execFileAsync("gh", ["auth", "token"]);
  return stdout.trim();
}

export interface ResolveTokenDeps {
  getEnv?: (name: string) => string | undefined;
  readGhToken?: () => Promise<string>;
}

const TOKEN_ENV_VARS = ["GITHUB_TOKEN", "GH_TOKEN"] as const;

export async function resolveToken(deps: ResolveTokenDeps = {}): Promise<string> {
  const getEnv = deps.getEnv ?? ((name: string) => process.env[name]);
  const readGh = deps.readGhToken ?? ghAuthToken;

  // Check each env var individually — skip empty strings so that
  // GITHUB_TOKEN="" doesn't shadow a valid GH_TOKEN.
  for (const name of TOKEN_ENV_VARS) {
    const val = getEnv(name);
    if (val && val.length > 0) {
      return val;
    }
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
