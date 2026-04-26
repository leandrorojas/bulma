import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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

// Vercel CLI auth.json locations (env-paths convention).
// The CLI session token is a separate value from a personal access token,
// but both work as Bearer tokens against api.vercel.com.
function vercelCliAuthPaths(): string[] {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "com.vercel.cli", "auth.json")];
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [path.join(localAppData, "com.vercel.cli", "Data", "auth.json")];
  }
  const xdgData = process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  return [path.join(xdgData, "com.vercel.cli", "auth.json")];
}

async function readVercelAuthFile(): Promise<string> {
  let lastErr: unknown;
  for (const p of vercelCliAuthPaths()) {
    try {
      return await fs.readFile(p, "utf8");
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("no vercel auth file found");
}

export interface ResolveVercelTokenDeps {
  getEnv?: (name: string) => string | undefined;
  readVercelAuthFile?: () => Promise<string>;
}

export async function resolveVercelToken(
  deps: ResolveVercelTokenDeps = {}
): Promise<string> {
  const getEnv = deps.getEnv ?? ((name: string) => process.env[name]);
  const readFile = deps.readVercelAuthFile ?? readVercelAuthFile;

  const envToken = getEnv("VERCEL_TOKEN");
  if (envToken && envToken.length > 0) {
    return envToken;
  }

  try {
    const raw = await readFile();
    const parsed = JSON.parse(raw) as { token?: unknown };
    if (typeof parsed.token === "string" && parsed.token.length > 0) {
      return parsed.token;
    }
    throw new Error("vercel auth file missing 'token' field");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      "No Vercel token available. Set VERCEL_TOKEN env var or run `vercel login`. " +
        `(fallback failed: ${reason})`
    );
  }
}

export interface GetVercelTeamIdDeps {
  getEnv?: (name: string) => string | undefined;
}

export function getVercelTeamId(deps: GetVercelTeamIdDeps = {}): string | undefined {
  const getEnv = deps.getEnv ?? ((name: string) => process.env[name]);
  const value = getEnv("VERCEL_TEAM_ID");
  return value && value.length > 0 ? value : undefined;
}
