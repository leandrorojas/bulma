import { spawn as nodeSpawn } from "node:child_process";

// Validate repo names before they flow into URL paths. The loose form here
// matches GitHub's own constraints (alphanumerics + `-`, `_`, `.`, max 100).
const REPO_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const OWNER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const ENV_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
// Secret names: must start with a letter or underscore, then alphanumerics +
// underscore. GitHub also reserves the `GITHUB_` prefix — we reject it here
// rather than letting the API 422 with a less-clear message.
const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const GH_RESERVED_SECRET_PREFIX = "GITHUB_";

const GH_SECRET_TIMEOUT_MS = 30_000;

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

export interface AuthenticatedUser {
  id: number;
  login: string;
}

export async function getAuthenticatedUser(
  token: string,
  deps: CreateRepoDeps = {}
): Promise<AuthenticatedUser> {
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
  const data = (await res.json()) as { id?: number; login?: string };
  if (typeof data.id !== "number") {
    throw new TypeError("GitHub API: /user response missing id");
  }
  if (typeof data.login !== "string" || data.login.length === 0) {
    throw new TypeError("GitHub API: /user response missing login");
  }
  return { id: data.id, login: data.login };
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
  // Defense-in-depth: validate every argument that flows into the spawn call.
  // spawn does not invoke a shell (no {shell: true}), so there's no
  // interpolation/injection vector — but Sonar's taint analyzer doesn't track
  // the regex assertions across helper boundaries. Re-validating each value
  // immediately before spawn gives the analyzer a recognizable sanitization
  // shape and makes the safety property locally obvious to readers.
  if (!OWNER_NAME_PATTERN.test(owner)) {
    throw new TypeError(`Invalid GitHub owner: ${owner}`);
  }
  if (!REPO_NAME_PATTERN.test(repo)) {
    throw new TypeError(`Invalid GitHub repo: ${repo}`);
  }
  if (!SECRET_NAME_PATTERN.test(secretName)) {
    throw new TypeError(`Invalid secret name: ${secretName}`);
  }
  if (secretName.startsWith(GH_RESERVED_SECRET_PREFIX)) {
    throw new TypeError(
      `Invalid secret name: ${secretName} (cannot start with reserved \`${GH_RESERVED_SECRET_PREFIX}\` prefix)`
    );
  }
  const repoArg: string = `${owner}/${repo}`;
  const safeSecretName: string = secretName;
  const spawn = deps.spawn ?? nodeSpawn;
  const child = spawn(
    "gh",
    ["secret", "set", safeSecretName, "--repo", repoArg, "--body", "-"],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  if (!child.stdin) {
    throw new Error("gh secret set: child stdin unavailable");
  }
  let stdinErr: Error | undefined;
  child.stdin.on("error", (err) => {
    stdinErr = err;
  });
  child.stdin.write(secretValue);
  child.stdin.end();
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const timer = setTimeout(() => {
    child.kill("SIGTERM");
  }, GH_SECRET_TIMEOUT_MS);

  await new Promise<void>((resolve, reject) => {
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (stdinErr) {
        reject(new Error(`gh secret set ${secretName} stdin failed: ${stdinErr.message}`));
        return;
      }
      if (signal === "SIGTERM") {
        reject(
          new Error(
            `gh secret set ${secretName} timed out after ${GH_SECRET_TIMEOUT_MS}ms`
          )
        );
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        // Strip every occurrence of the secret value from echoed errors.
        // replaceAll uses a literal pattern so regex-special chars in the
        // secret are treated as plain text.
        const safe = stderr.replaceAll(secretValue, "***");
        reject(new Error(`gh secret set ${secretName} exited ${code}: ${safe.trim()}`));
      }
    });
  });
}
