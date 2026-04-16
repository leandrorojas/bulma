export interface CreateRepoOptions {
  description?: string;
  private?: boolean;
}

export interface CreatedRepo {
  cloneUrl: string;
  htmlUrl: string;
}

export interface CreateRepoDeps {
  fetch?: typeof fetch;
}

// Creates a repo under the authenticated user via the GitHub REST API.
// Uses the "Create a repository for the authenticated user" endpoint.
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
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `GitHub API error creating repo "${name}": ${res.status} ${res.statusText}\n${body}`
    );
  }

  const data = (await res.json()) as { clone_url: string; html_url: string };
  return { cloneUrl: data.clone_url, htmlUrl: data.html_url };
}
