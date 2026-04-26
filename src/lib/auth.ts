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
export function vercelCliAuthPaths(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
  env: Record<string, string | undefined> = process.env
): string[] {
  if (platform === "darwin") {
    return [path.join(homeDir, "Library", "Application Support", "com.vercel.cli", "auth.json")];
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local");
    return [path.join(localAppData, "com.vercel.cli", "Data", "auth.json")];
  }
  const xdgData = env.XDG_DATA_HOME ?? path.join(homeDir, ".local", "share");
  return [path.join(xdgData, "com.vercel.cli", "auth.json")];
}

export async function readVercelAuthFileFromPaths(
  paths: string[],
  readFile: (p: string) => Promise<string> = (p) => fs.readFile(p, "utf8")
): Promise<string> {
  let lastErr: unknown;
  for (const p of paths) {
    try {
      return await readFile(p);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("no vercel auth file found");
}

async function readVercelAuthFile(): Promise<string> {
  return readVercelAuthFileFromPaths(vercelCliAuthPaths());
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

  let raw: string;
  try {
    raw = await readFile();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      "No Vercel token available. Set VERCEL_TOKEN env var or run `vercel login`. " +
        `(fallback failed: ${reason})`
    );
  }

  let parsed: { token?: unknown };
  try {
    parsed = JSON.parse(raw) as { token?: unknown };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Corrupt vercel auth file: ${reason}`);
  }

  if (typeof parsed.token === "string" && parsed.token.length > 0) {
    return parsed.token;
  }
  throw new Error("Vercel auth file is missing the 'token' field");
}

export interface GetVercelTeamIdDeps {
  getEnv?: (name: string) => string | undefined;
}

export function getVercelTeamId(deps: GetVercelTeamIdDeps = {}): string | undefined {
  const getEnv = deps.getEnv ?? ((name: string) => process.env[name]);
  const value = getEnv("VERCEL_TEAM_ID");
  return value && value.length > 0 ? value : undefined;
}
