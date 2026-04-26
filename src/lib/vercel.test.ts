import {
  checkGitHubAppInstalled,
  createVercelProject,
  getLatestProductionDeployment,
  pollDeploymentReady,
  DeploymentFailedError,
  DeploymentTimeoutError,
} from "./vercel";

type FetchArgs = Parameters<typeof fetch>;
interface FakeResponse {
  ok: boolean;
  status?: number;
  statusText?: string;
  body: unknown;
}

function makeFetch(...responses: FakeResponse[]): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fake = (async (...args: FetchArgs) => {
    const [url, init] = args;
    calls.push({ url: String(url), init: init ?? {} });
    if (i >= responses.length) {
      throw new Error(`makeFetch: unexpected fetch call #${i + 1}`);
    }
    const r = responses[i];
    i += 1;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      statusText: r.statusText ?? (r.ok ? "OK" : "Server Error"),
      json: async () => r.body,
      text: async () =>
        typeof r.body === "string" ? r.body : JSON.stringify(r.body),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetch: fake, calls };
}

describe("checkGitHubAppInstalled", () => {
  it("returns true when namespace has unrestricted access", async () => {
    const { fetch: fake, calls } = makeFetch({
      ok: true,
      body: [{ slug: "alice", isAccessRestricted: false }],
    });
    const ok = await checkGitHubAppInstalled("t", "alice", {}, { fetch: fake });
    expect(ok).toBe(true);
    expect(calls[0].url).toContain("/v1/integrations/git-namespaces");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer t"
    );
  });

  it("returns false when namespace has restricted access", async () => {
    const { fetch: fake } = makeFetch({
      ok: true,
      body: [{ slug: "alice", isAccessRestricted: true }],
    });
    expect(
      await checkGitHubAppInstalled("t", "alice", {}, { fetch: fake })
    ).toBe(false);
  });

  it("returns false when namespace is not present", async () => {
    const { fetch: fake } = makeFetch({
      ok: true,
      body: [{ slug: "bob", isAccessRestricted: false }],
    });
    expect(
      await checkGitHubAppInstalled("t", "alice", {}, { fetch: fake })
    ).toBe(false);
  });

  it("includes teamId in the query when scoped", async () => {
    const { fetch: fake, calls } = makeFetch({
      ok: true,
      body: [{ slug: "team-x", isAccessRestricted: false }],
    });
    await checkGitHubAppInstalled(
      "t",
      "team-x",
      { teamId: "team_abc" },
      { fetch: fake }
    );
    expect(calls[0].url).toContain("teamId=team_abc");
  });

  it("throws on non-2xx", async () => {
    const { fetch: fake } = makeFetch({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      body: { error: "bad token" },
    });
    await expect(
      checkGitHubAppInstalled("t", "alice", {}, { fetch: fake })
    ).rejects.toThrow(/401 Unauthorized/);
  });
});

describe("createVercelProject", () => {
  it("POSTs the project body with framework=null and the git link", async () => {
    const { fetch: fake, calls } = makeFetch({
      ok: true,
      status: 201,
      body: { id: "prj_123", name: "my-site" },
    });
    const created = await createVercelProject(
      "t",
      {
        name: "my-site",
        gitRepoFullName: "alice/my-site",
        buildCommand: "npm run build",
        outputDirectory: "dist",
        installCommand: "npm install",
        nodeVersion: "20.x",
      },
      {},
      { fetch: fake }
    );
    expect(created).toEqual({ id: "prj_123", name: "my-site" });
    expect(calls[0].url).toContain("/v10/projects");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({
      name: "my-site",
      framework: null,
      gitRepository: { type: "github", repo: "alice/my-site" },
      buildCommand: "npm run build",
      outputDirectory: "dist",
      installCommand: "npm install",
      nodeVersion: "20.x",
    });
  });

  it("omits nodeVersion when not provided", async () => {
    const { fetch: fake, calls } = makeFetch({
      ok: true,
      status: 201,
      body: { id: "x", name: "x" },
    });
    await createVercelProject(
      "t",
      {
        name: "x",
        gitRepoFullName: "a/x",
        buildCommand: "b",
        outputDirectory: "o",
        installCommand: "i",
      },
      {},
      { fetch: fake }
    );
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.nodeVersion).toBeUndefined();
  });

  it("scopes to teamId when provided", async () => {
    const { fetch: fake, calls } = makeFetch({
      ok: true,
      body: { id: "x", name: "x" },
    });
    await createVercelProject(
      "t",
      {
        name: "x",
        gitRepoFullName: "a/x",
        buildCommand: "b",
        outputDirectory: "o",
        installCommand: "i",
      },
      { teamId: "team_abc" },
      { fetch: fake }
    );
    expect(calls[0].url).toContain("teamId=team_abc");
  });

  it("surfaces API errors with status and body", async () => {
    const { fetch: fake } = makeFetch({
      ok: false,
      status: 409,
      statusText: "Conflict",
      body: { error: { message: "name already exists" } },
    });
    await expect(
      createVercelProject(
        "t",
        {
          name: "x",
          gitRepoFullName: "a/x",
          buildCommand: "b",
          outputDirectory: "o",
          installCommand: "i",
        },
        {},
        { fetch: fake }
      )
    ).rejects.toThrow(/409 Conflict[\s\S]*name already exists/);
  });
});

describe("getLatestProductionDeployment", () => {
  it("returns null when no deployments yet", async () => {
    const { fetch: fake } = makeFetch({ ok: true, body: { deployments: [] } });
    const dep = await getLatestProductionDeployment(
      "t",
      "prj_1",
      {},
      { fetch: fake }
    );
    expect(dep).toBeNull();
  });

  it("uses readyState when state is absent (legacy shape)", async () => {
    const { fetch: fake } = makeFetch({
      ok: true,
      body: {
        deployments: [{ uid: "dpl_1", url: "x.vercel.app", readyState: "BUILDING" }],
      },
    });
    const dep = await getLatestProductionDeployment(
      "t",
      "prj_1",
      {},
      { fetch: fake }
    );
    expect(dep).toEqual({ uid: "dpl_1", url: "x.vercel.app", state: "BUILDING" });
  });

  it("scopes target=production and project filter", async () => {
    const { fetch: fake, calls } = makeFetch({
      ok: true,
      body: { deployments: [] },
    });
    await getLatestProductionDeployment(
      "t",
      "prj_1",
      { teamId: "team_abc" },
      { fetch: fake }
    );
    expect(calls[0].url).toContain("projectId=prj_1");
    expect(calls[0].url).toContain("target=production");
    expect(calls[0].url).toContain("teamId=team_abc");
  });
});

describe("pollDeploymentReady", () => {
  function fakeClock(start = 0): {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    sleeps: number[];
  } {
    let t = start;
    const sleeps: number[] = [];
    return {
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      sleeps,
    };
  }

  it("returns the deployment when state is READY", async () => {
    const { fetch: fake } = makeFetch(
      { ok: true, body: { deployments: [{ uid: "d1", url: "u", state: "BUILDING" }] } },
      { ok: true, body: { deployments: [{ uid: "d1", url: "u", state: "READY" }] } }
    );
    const clock = fakeClock();
    const dep = await pollDeploymentReady(
      "t",
      "prj_1",
      { timeoutMs: 60_000, intervalMs: 1_000, ...clock },
      { fetch: fake }
    );
    expect(dep.state).toBe("READY");
    expect(clock.sleeps).toEqual([1_000]);
  });

  it("throws DeploymentFailedError on ERROR", async () => {
    const { fetch: fake } = makeFetch({
      ok: true,
      body: { deployments: [{ uid: "d1", url: "u", state: "ERROR" }] },
    });
    const clock = fakeClock();
    await expect(
      pollDeploymentReady(
        "t",
        "prj_1",
        { timeoutMs: 60_000, intervalMs: 1_000, ...clock },
        { fetch: fake }
      )
    ).rejects.toBeInstanceOf(DeploymentFailedError);
  });

  it("throws DeploymentFailedError on CANCELED", async () => {
    const { fetch: fake } = makeFetch({
      ok: true,
      body: { deployments: [{ uid: "d1", url: "u", state: "CANCELED" }] },
    });
    const clock = fakeClock();
    await expect(
      pollDeploymentReady(
        "t",
        "prj_1",
        { timeoutMs: 60_000, intervalMs: 1_000, ...clock },
        { fetch: fake }
      )
    ).rejects.toBeInstanceOf(DeploymentFailedError);
  });

  it("throws DeploymentTimeoutError when wall clock exceeds budget", async () => {
    const building = {
      ok: true,
      body: { deployments: [{ uid: "d1", url: "u", state: "BUILDING" }] },
    };
    const { fetch: fake } = makeFetch(building, building, building);
    const clock = fakeClock();
    await expect(
      pollDeploymentReady(
        "t",
        "prj_1",
        { timeoutMs: 3_000, intervalMs: 1_000, ...clock },
        { fetch: fake }
      )
    ).rejects.toBeInstanceOf(DeploymentTimeoutError);
  });

  it("keeps polling when no deployment exists yet (null result)", async () => {
    const { fetch: fake } = makeFetch(
      { ok: true, body: { deployments: [] } },
      { ok: true, body: { deployments: [{ uid: "d1", url: "u", state: "READY" }] } }
    );
    const clock = fakeClock();
    const dep = await pollDeploymentReady(
      "t",
      "prj_1",
      { timeoutMs: 60_000, intervalMs: 1_000, ...clock },
      { fetch: fake }
    );
    expect(dep.uid).toBe("d1");
    expect(clock.sleeps).toEqual([1_000]);
  });

  it("swallows transient API errors and keeps polling until READY", async () => {
    const { fetch: fake } = makeFetch(
      { ok: false, status: 503, statusText: "Service Unavailable", body: "down" },
      { ok: true, body: { deployments: [{ uid: "d1", url: "u", state: "READY" }] } }
    );
    const clock = fakeClock();
    const dep = await pollDeploymentReady(
      "t",
      "prj_1",
      { timeoutMs: 60_000, intervalMs: 1_000, ...clock },
      { fetch: fake }
    );
    expect(dep.state).toBe("READY");
  });

  it("includes the last transient error in the timeout message", async () => {
    const flaky = {
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      body: "upstream",
    };
    const { fetch: fake } = makeFetch(flaky, flaky, flaky);
    const clock = fakeClock();
    await expect(
      pollDeploymentReady(
        "t",
        "prj_1",
        { timeoutMs: 3_000, intervalMs: 1_000, ...clock },
        { fetch: fake }
      )
    ).rejects.toThrow(/within 3000ms.*last error.*502 Bad Gateway/s);
  });

  it("DeploymentFailedError short-circuits even if a transient blip preceded it", async () => {
    const { fetch: fake } = makeFetch(
      { ok: false, status: 500, statusText: "x", body: "y" },
      { ok: true, body: { deployments: [{ uid: "d1", url: "u", state: "ERROR" }] } }
    );
    const clock = fakeClock();
    await expect(
      pollDeploymentReady(
        "t",
        "prj_1",
        { timeoutMs: 60_000, intervalMs: 1_000, ...clock },
        { fetch: fake }
      )
    ).rejects.toBeInstanceOf(DeploymentFailedError);
  });
});

describe("getLatestProductionDeployment defensive shape", () => {
  it("returns null when the API omits the deployments array", async () => {
    const { fetch: fake } = makeFetch({ ok: true, body: {} });
    const dep = await getLatestProductionDeployment(
      "t",
      "prj_1",
      {},
      { fetch: fake }
    );
    expect(dep).toBeNull();
  });
});
