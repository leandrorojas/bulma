// Vercel REST API client. All functions accept an optional `teamId` to scope
// the request to a team account. The token is passed as a Bearer header.
//
// Docs: https://vercel.com/docs/rest-api

const API_BASE = "https://api.vercel.com";
const API_TIMEOUT_MS = 30_000;

// Vercel project IDs are `prj_` + base62 chars in practice. We accept the
// broader URL-safe set since the analyzer treats API responses as tainted —
// validating at the boundary lets us pass the ID into request URLs safely.
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function assertValidProjectId(projectId: string): void {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(`Invalid Vercel project ID: ${projectId}`);
  }
}

export interface VercelClientDeps {
  fetch?: typeof fetch;
}

export interface VercelTeamScope {
  teamId?: string;
}

function withTeam(url: string, teamId?: string): string {
  if (!teamId) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}teamId=${encodeURIComponent(teamId)}`;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "bulma-cli",
  };
}

async function vercelFetch(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  context: string
): Promise<Response> {
  const res = await doFetch(url, {
    ...init,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vercel API error (${context}): ${res.status} ${res.statusText}\n${body}`);
  }
  return res;
}

interface GitNamespace {
  slug: string;
  isAccessRestricted: boolean;
}

// Returns true when the Vercel GitHub App is installed AND has unrestricted
// access for `namespaceSlug` (or has it pre-granted to all repos). When the
// install is restricted to a subset, we treat it as "not installed" because
// the new repo we're about to create won't be in that subset yet.
export async function checkGitHubAppInstalled(
  token: string,
  namespaceSlug: string,
  scope: VercelTeamScope = {},
  deps: VercelClientDeps = {}
): Promise<boolean> {
  const doFetch = deps.fetch ?? fetch;
  const url = withTeam(
    `${API_BASE}/v1/integrations/git-namespaces?provider=github`,
    scope.teamId
  );
  const res = await vercelFetch(
    doFetch,
    url,
    { method: "GET", headers: authHeaders(token) },
    "list git namespaces"
  );
  const namespaces = (await res.json()) as GitNamespace[];
  const match = namespaces.find((n) => n.slug === namespaceSlug);
  if (!match) return false;
  return match.isAccessRestricted === false;
}

export interface CreateProjectOptions {
  name: string;
  // owner/repo on GitHub. Vercel will link the project and listen for pushes.
  gitRepoFullName: string;
  buildCommand: string;
  outputDirectory: string;
  installCommand: string;
  // e.g. "20.x"
  nodeVersion?: string;
}

export interface CreatedVercelProject {
  id: string;
  name: string;
}

export async function createVercelProject(
  token: string,
  options: CreateProjectOptions,
  scope: VercelTeamScope = {},
  deps: VercelClientDeps = {}
): Promise<CreatedVercelProject> {
  const doFetch = deps.fetch ?? fetch;
  const url = withTeam(`${API_BASE}/v10/projects`, scope.teamId);
  const body: Record<string, unknown> = {
    name: options.name,
    framework: null,
    gitRepository: { type: "github", repo: options.gitRepoFullName },
    buildCommand: options.buildCommand,
    outputDirectory: options.outputDirectory,
    installCommand: options.installCommand,
  };
  if (options.nodeVersion) {
    body.nodeVersion = options.nodeVersion;
  }
  const res = await vercelFetch(
    doFetch,
    url,
    {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    "create project"
  );
  const data = (await res.json()) as { id: string; name: string };
  assertValidProjectId(data.id);
  return { id: data.id, name: data.name };
}

export type DeploymentState =
  | "INITIALIZING"
  | "QUEUED"
  | "BUILDING"
  | "READY"
  | "ERROR"
  | "CANCELED";

export interface VercelDeployment {
  uid: string;
  url: string;
  state: DeploymentState;
}

interface DeploymentListItem {
  uid: string;
  url: string;
  state?: DeploymentState;
  readyState?: DeploymentState;
}

export async function getLatestProductionDeployment(
  token: string,
  projectId: string,
  scope: VercelTeamScope = {},
  deps: VercelClientDeps = {}
): Promise<VercelDeployment | null> {
  assertValidProjectId(projectId);
  const doFetch = deps.fetch ?? fetch;
  const url = withTeam(
    `${API_BASE}/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=1`,
    scope.teamId
  );
  const res = await vercelFetch(
    doFetch,
    url,
    { method: "GET", headers: authHeaders(token) },
    "list deployments"
  );
  const data = (await res.json()) as { deployments?: DeploymentListItem[] };
  const first = data.deployments?.[0];
  if (!first) return null;
  const state = first.state ?? first.readyState ?? "QUEUED";
  return { uid: first.uid, url: first.url, state };
}

export interface PollDeploymentOptions extends VercelTeamScope {
  timeoutMs: number;
  intervalMs?: number;
  // Test seams.
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;

export class DeploymentTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentTimeoutError";
  }
}

export class DeploymentFailedError extends Error {
  constructor(
    message: string,
    public readonly state: DeploymentState
  ) {
    super(message);
    this.name = "DeploymentFailedError";
  }
}

function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown error";
  }
}

function buildTimeoutMessage(timeoutMs: number, lastError: unknown): string {
  const base = `Deployment did not become READY within ${timeoutMs}ms`;
  if (!lastError) return base;
  return `${base} (last error: ${formatUnknownError(lastError)})`;
}

// Returns the deployment if it's READY, throws DeploymentFailedError on
// terminal failure, returns null on any non-terminal state (still pending).
function classifyDeployment(deployment: VercelDeployment | null): VercelDeployment | null {
  if (!deployment) return null;
  if (deployment.state === "READY") return deployment;
  if (deployment.state === "ERROR" || deployment.state === "CANCELED") {
    throw new DeploymentFailedError(
      `Deployment ${deployment.uid} ended in ${deployment.state}`,
      deployment.state
    );
  }
  return null;
}

// Polls until the latest production deployment reaches READY. Transient
// fetch errors (network blip, 429, 5xx) are swallowed and the loop keeps
// polling until the deadline. Only DeploymentFailedError (terminal state)
// short-circuits. On timeout, the last transient error is chained into the
// thrown DeploymentTimeoutError so callers can surface the real cause.
export async function pollDeploymentReady(
  token: string,
  projectId: string,
  options: PollDeploymentOptions,
  deps: VercelClientDeps = {}
): Promise<VercelDeployment> {
  assertValidProjectId(projectId);
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = now() + options.timeoutMs;
  let lastError: unknown;

  while (now() < deadline) {
    try {
      const deployment = await getLatestProductionDeployment(
        token,
        projectId,
        { teamId: options.teamId },
        deps
      );
      const ready = classifyDeployment(deployment);
      if (ready) return ready;
      lastError = undefined;
    } catch (err) {
      if (err instanceof DeploymentFailedError) throw err;
      lastError = err;
    }
    await sleep(interval);
  }
  throw new DeploymentTimeoutError(buildTimeoutMessage(options.timeoutMs, lastError));
}
