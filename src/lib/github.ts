import { spawn as nodeSpawn } from "node:child_process";

// Validate repo names before they flow into URL paths. The loose form here
// matches GitHub's own constraints (alphanumerics + `-`, `_`, `.`, max 100).
const REPO_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const OWNER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const ENV_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
// Secret names: A-Z, 0-9, underscore; cannot start with a digit or GITHUB_.
const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

function assertOwnerRepo(owner: string, repo: string): void {
  if (!OWNER_NAME_PATTERN.test(owner)) {
    throw new Error(`Invalid GitHub owner: ${owner}`);
  }
  if (!REPO_NAME_PATTERN.test(repo)) {
    throw new Error(`Invalid GitHub repo: ${repo}`);
  }
}

export interface CreateRepoOptions {
  description?: string;
  private?: boolean;
}

export interface CreatedRepo {
  id: number;
  cloneUrl: string;
  htmlUrl: string;
}

export interface CreateRepoDeps {
  fetch?: typeof fetch;
}

const API_TIMEOUT_MS = 30_000;

// Creates a repo under the authenticated user via the GitHub REST API.
// https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user
export async function createPrivateRepo(
  token: string,
  name: string,
  options: CreateRepoOptions = {},
  deps: CreateRepoDeps = {}
): Promise<CreatedRepo> {
  const doFetch = deps.fetch ?? fetch;

  const res = await doFetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "bulma-cli",
    },
    body: JSON.stringify({
      name,
      description: options.description,
      private: options.private ?? true,
      auto_init: false,
    }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `GitHub API error creating repo "${name}": ${res.status} ${res.statusText}\n${body}`
    );
  }

  const data = (await res.json()) as { id: number; clone_url: string; html_url: string };
  return { id: data.id, cloneUrl: data.clone_url, htmlUrl: data.html_url };
}

const GH_API_BASE = "https://api.github.com";

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "bulma-cli",
  };
}

export async function getAuthenticatedUserId(
  token: string,
  deps: CreateRepoDeps = {}
): Promise<number> {
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(`${GH_API_BASE}/user`, {
    method: "GET",
    headers: ghHeaders(token),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error (get user): ${res.status} ${res.statusText}\n${body}`);
  }
  const data = (await res.json()) as { id?: number };
  if (typeof data.id !== "number") {
    throw new Error("GitHub API: /user response missing id");
  }
  return data.id;
}

export interface CreateEnvironmentOptions {
  /** Numeric GitHub user IDs allowed to approve deployments. */
  reviewerUserIds: number[];
}

// Creates (or updates) a repo Environment with required reviewers. Used to
// gate the `production` environment so the release.yml workflow pauses for
// human approval before publishing.
//
// API: PUT /repos/{owner}/{repo}/environments/{name}
export async function createEnvironment(
  token: string,
  owner: string,
  repo: string,
  envName: string,
  options: CreateEnvironmentOptions,
  deps: CreateRepoDeps = {}
): Promise<void> {
  assertOwnerRepo(owner, repo);
  if (!ENV_NAME_PATTERN.test(envName)) {
    throw new Error(`Invalid environment name: ${envName}`);
  }
  const doFetch = deps.fetch ?? fetch;
  const url = new URL(GH_API_BASE);
  url.pathname = `/repos/${owner}/${repo}/environments/${envName}`;
  const res = await doFetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      reviewers: options.reviewerUserIds.map((id) => ({ type: "User", id })),
    }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `GitHub API error (create environment "${envName}"): ${res.status} ${res.statusText}\n${body}`
    );
  }
}

// Sets a repo Actions secret using the `gh` CLI. We delegate to gh because it
// handles the libsodium-sealed-box encryption against the repo's public key
// for us (otherwise we'd need a crypto dep). Value is fed via stdin so it
// never touches argv or the shell history.
//
// `gh secret set <name> --repo <owner/repo> --body -` reads from stdin.
export interface SetRepoSecretDeps {
  spawn?: typeof nodeSpawn;
}

export async function setRepoSecret(
  owner: string,
  repo: string,
  secretName: string,
  secretValue: string,
  deps: SetRepoSecretDeps = {}
): Promise<void> {
  assertOwnerRepo(owner, repo);
  if (!SECRET_NAME_PATTERN.test(secretName)) {
    throw new Error(`Invalid secret name: ${secretName}`);
  }
  const spawn = deps.spawn ?? nodeSpawn;
  const child = spawn(
    "gh",
    ["secret", "set", secretName, "--repo", `${owner}/${repo}`, "--body", "-"],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  if (!child.stdin) {
    throw new Error("gh secret set: child stdin unavailable");
  }
  child.stdin.write(secretValue);
  child.stdin.end();
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        // Strip the secret value from any echoed errors defensively.
        const safe = stderr.replace(secretValue, "***");
        reject(new Error(`gh secret set ${secretName} exited ${code}: ${safe.trim()}`));
      }
    });
  });
}
