import { createPrivateRepo } from "./github";

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
