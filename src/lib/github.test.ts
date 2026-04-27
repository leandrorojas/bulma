import { EventEmitter } from "node:events";
import {
  createPrivateRepo,
  getAuthenticatedUser,
  createEnvironment,
  setRepoSecret,
} from "./github";

type FetchArgs = Parameters<typeof fetch>;

function makeFetch(
  result: { ok: boolean; status?: number; statusText?: string; body: unknown }
): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (...args: FetchArgs) => {
    const [url, init] = args;
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: result.ok,
      status: result.status ?? (result.ok ? 201 : 500),
      statusText: result.statusText ?? (result.ok ? "Created" : "Server Error"),
      json: async () => result.body,
      text: async () =>
        typeof result.body === "string" ? result.body : JSON.stringify(result.body),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetch: fake, calls };
}

describe("createPrivateRepo", () => {
  it("POSTs to the user repos endpoint with private=true by default", async () => {
    const { fetch: fake, calls } = makeFetch({
      ok: true,
      body: {
        id: 12345,
        clone_url: "https://github.com/alice/my-site.git",
        html_url: "https://github.com/alice/my-site",
      },
    });

    const result = await createPrivateRepo(
      "ghp_token",
      "my-site",
      { description: "test" },
      { fetch: fake }
    );

    expect(result).toEqual({
      id: 12345,
      cloneUrl: "https://github.com/alice/my-site.git",
      htmlUrl: "https://github.com/alice/my-site",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/user/repos");

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghp_token");
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");

    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({
      name: "my-site",
      description: "test",
      private: true,
      auto_init: false,
    });
  });

  it("allows private=false override", async () => {
    const { fetch: fake, calls } = makeFetch({
      ok: true,
      body: {
        id: 99,
        clone_url: "https://github.com/alice/s.git",
        html_url: "https://github.com/alice/s",
      },
    });

    await createPrivateRepo("t", "s", { private: false }, { fetch: fake });

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.private).toBe(false);
  });

  it("throws with status and response body when GitHub returns non-2xx", async () => {
    const { fetch: fake } = makeFetch({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      body: { message: "name already exists on this account" },
    });

    await expect(
      createPrivateRepo("t", "existing", {}, { fetch: fake })
    ).rejects.toThrow(/422 Unprocessable Entity[\s\S]*name already exists/);
  });
});

describe("getAuthenticatedUser", () => {
  it("returns id and login from /user", async () => {
    const { fetch: fake, calls } = makeFetch({
      ok: true,
      body: { id: 42, login: "alice" },
    });
    const user = await getAuthenticatedUser("t", { fetch: fake });
    expect(user).toEqual({ id: 42, login: "alice" });
    expect(calls[0].url).toBe("https://api.github.com/user");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer t"
    );
  });

  it("throws when the response has no id", async () => {
    const { fetch: fake } = makeFetch({ ok: true, body: { login: "alice" } });
    await expect(getAuthenticatedUser("t", { fetch: fake })).rejects.toThrow(
      /missing id/
    );
  });

  it("throws when the response has no login", async () => {
    const { fetch: fake } = makeFetch({ ok: true, body: { id: 42 } });
    await expect(getAuthenticatedUser("t", { fetch: fake })).rejects.toThrow(
      /missing login/
    );
  });

  it("surfaces non-2xx responses", async () => {
    const { fetch: fake } = makeFetch({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      body: { message: "Bad credentials" },
    });
    await expect(getAuthenticatedUser("t", { fetch: fake })).rejects.toThrow(
      /401 Unauthorized[\s\S]*Bad credentials/
    );
  });
});

describe("createEnvironment", () => {
  it("PUTs the environment with the User reviewers", async () => {
    const { fetch: fake, calls } = makeFetch({
      ok: true,
      status: 200,
      body: { name: "production" },
    });
    await createEnvironment(
      "t",
      "alice",
      "my-site",
      "production",
      { reviewerUserIds: [42] },
      { fetch: fake }
    );
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/alice/my-site/environments/production"
    );
    expect(calls[0].init.method).toBe("PUT");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({ reviewers: [{ type: "User", id: 42 }] });
  });

  it("supports multiple reviewers", async () => {
    const { fetch: fake, calls } = makeFetch({ ok: true, body: {} });
    await createEnvironment(
      "t",
      "alice",
      "my-site",
      "production",
      { reviewerUserIds: [42, 77] },
      { fetch: fake }
    );
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.reviewers).toEqual([
      { type: "User", id: 42 },
      { type: "User", id: 77 },
    ]);
  });

  it("rejects malformed owner / repo / env names before any fetch", async () => {
    const fake = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    await expect(
      createEnvironment("t", "ev/il", "my-site", "production", { reviewerUserIds: [1] }, { fetch: fake })
    ).rejects.toThrow(/Invalid GitHub owner/);
    await expect(
      createEnvironment("t", "alice", "../etc", "production", { reviewerUserIds: [1] }, { fetch: fake })
    ).rejects.toThrow(/Invalid GitHub repo/);
    await expect(
      createEnvironment("t", "alice", "my-site", "../prod", { reviewerUserIds: [1] }, { fetch: fake })
    ).rejects.toThrow(/Invalid environment name/);
  });

  it("surfaces non-2xx responses", async () => {
    const { fetch: fake } = makeFetch({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      body: { message: "no admin" },
    });
    await expect(
      createEnvironment(
        "t",
        "alice",
        "my-site",
        "production",
        { reviewerUserIds: [1] },
        { fetch: fake }
      )
    ).rejects.toThrow(/403 Forbidden[\s\S]*no admin/);
  });
});

interface FakeStdin extends EventEmitter {
  write: jest.Mock;
  end: jest.Mock;
}
interface FakeChild extends EventEmitter {
  stdin: FakeStdin;
  stderr: EventEmitter;
  kill: jest.Mock;
}

function makeFakeSpawn(
  exitCode: number,
  stderrChunks: string[] = []
): { spawn: typeof import("node:child_process").spawn; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawnFn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child = new EventEmitter() as FakeChild;
    const stdin = new EventEmitter() as FakeStdin;
    stdin.write = jest.fn();
    stdin.end = jest.fn();
    child.stdin = stdin;
    child.stderr = new EventEmitter();
    child.kill = jest.fn();
    setTimeout(() => {
      for (const chunk of stderrChunks) {
        child.stderr.emit("data", Buffer.from(chunk));
      }
      child.emit("close", exitCode);
    }, 0);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn: spawnFn, calls };
}

describe("setRepoSecret", () => {
  it("invokes `gh secret set` with --body - and pipes the value via stdin", async () => {
    const { spawn: fake, calls } = makeFakeSpawn(0);
    await setRepoSecret("alice", "my-site", "SONAR_TOKEN", "supersecret", { spawn: fake });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("gh");
    expect(calls[0].args).toEqual([
      "secret",
      "set",
      "SONAR_TOKEN",
      "--repo",
      "alice/my-site",
      "--body",
      "-",
    ]);
  });

  it("does not pass the secret value via argv", async () => {
    const { spawn: fake, calls } = makeFakeSpawn(0);
    await setRepoSecret("alice", "my-site", "SONAR_TOKEN", "supersecret", { spawn: fake });
    expect(calls[0].args.join(" ")).not.toContain("supersecret");
  });

  it("rejects malformed owner / repo / secret names before spawning", async () => {
    const spawnSpy = jest.fn() as unknown as typeof import("node:child_process").spawn;
    await expect(
      setRepoSecret("ev/il", "my-site", "SONAR_TOKEN", "x", { spawn: spawnSpy })
    ).rejects.toThrow(/Invalid GitHub owner/);
    await expect(
      setRepoSecret("alice", "../etc", "SONAR_TOKEN", "x", { spawn: spawnSpy })
    ).rejects.toThrow(/Invalid GitHub repo/);
    await expect(
      setRepoSecret("alice", "my-site", "lower-case", "x", { spawn: spawnSpy })
    ).rejects.toThrow(/Invalid secret name/);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("redacts the secret value from error messages on non-zero exit", async () => {
    const { spawn: fake } = makeFakeSpawn(1, [
      "gh: failed to authenticate token=supersecret\n",
    ]);
    await expect(
      setRepoSecret("alice", "my-site", "SONAR_TOKEN", "supersecret", { spawn: fake })
    ).rejects.toThrow(/exited 1.*token=\*\*\*/);
  });

  it("redacts EVERY occurrence of the secret in stderr (not just the first)", async () => {
    const { spawn: fake } = makeFakeSpawn(1, [
      "first: supersecret · second: supersecret · third: supersecret\n",
    ]);
    let caughtMessage = "";
    try {
      await setRepoSecret("alice", "my-site", "SONAR_TOKEN", "supersecret", {
        spawn: fake,
      });
    } catch (err) {
      caughtMessage = (err as Error).message;
    }
    expect(caughtMessage).toMatch(/first: \*\*\* · second: \*\*\* · third: \*\*\*/);
    expect(caughtMessage).not.toContain("supersecret");
  });

  it("rejects secret names that start with the reserved GITHUB_ prefix", async () => {
    const spawnSpy = jest.fn() as unknown as typeof import("node:child_process").spawn;
    await expect(
      setRepoSecret("alice", "my-site", "GITHUB_TOKEN", "x", { spawn: spawnSpy })
    ).rejects.toThrow(/reserved.*GITHUB_/);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
