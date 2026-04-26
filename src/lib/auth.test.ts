import { resolveToken, resolveVercelToken, getVercelTeamId } from "./auth";

describe("resolveToken", () => {
  it("returns GITHUB_TOKEN when set", async () => {
    const token = await resolveToken({
      getEnv: (n) => (n === "GITHUB_TOKEN" ? "ghp_env_token" : undefined),
      readGhToken: async () => {
        throw new Error("should not be called");
      },
    });
    expect(token).toBe("ghp_env_token");
  });

  it("returns GH_TOKEN when GITHUB_TOKEN is unset", async () => {
    const token = await resolveToken({
      getEnv: (n) => (n === "GH_TOKEN" ? "ghp_gh_token" : undefined),
      readGhToken: async () => "should not be used",
    });
    expect(token).toBe("ghp_gh_token");
  });

  it("falls back to gh auth token when env is empty", async () => {
    const token = await resolveToken({
      getEnv: () => undefined,
      readGhToken: async () => "ghp_gh_cli_token",
    });
    expect(token).toBe("ghp_gh_cli_token");
  });

  it("treats empty env as missing and falls back", async () => {
    const token = await resolveToken({
      getEnv: () => "",
      readGhToken: async () => "ghp_gh_cli_token",
    });
    expect(token).toBe("ghp_gh_cli_token");
  });

  it("skips empty GITHUB_TOKEN and picks GH_TOKEN", async () => {
    const token = await resolveToken({
      getEnv: (n) => (n === "GITHUB_TOKEN" ? "" : n === "GH_TOKEN" ? "ghp_from_gh" : undefined),
      readGhToken: async () => {
        throw new Error("should not be called");
      },
    });
    expect(token).toBe("ghp_from_gh");
  });

  it("throws an informative error when gh fallback fails", async () => {
    await expect(
      resolveToken({
        getEnv: () => undefined,
        readGhToken: async () => {
          throw new Error("gh not installed");
        },
      })
    ).rejects.toThrow(/No GitHub token available.*gh not installed/);
  });

  it("throws when gh returns empty output", async () => {
    await expect(
      resolveToken({
        getEnv: () => undefined,
        readGhToken: async () => "",
      })
    ).rejects.toThrow(/No GitHub token available.*gh auth token returned empty/);
  });
});

describe("resolveVercelToken", () => {
  it("returns VERCEL_TOKEN env when set", async () => {
    const token = await resolveVercelToken({
      getEnv: (n) => (n === "VERCEL_TOKEN" ? "vcp_env" : undefined),
      readVercelAuthFile: async () => {
        throw new Error("should not be called");
      },
    });
    expect(token).toBe("vcp_env");
  });

  it("falls back to vercel CLI auth.json when env is missing", async () => {
    const token = await resolveVercelToken({
      getEnv: () => undefined,
      readVercelAuthFile: async () => JSON.stringify({ token: "vcp_from_file" }),
    });
    expect(token).toBe("vcp_from_file");
  });

  it("treats empty env as missing and falls back to file", async () => {
    const token = await resolveVercelToken({
      getEnv: () => "",
      readVercelAuthFile: async () => JSON.stringify({ token: "vcp_from_file" }),
    });
    expect(token).toBe("vcp_from_file");
  });

  it("throws when file is unreadable", async () => {
    await expect(
      resolveVercelToken({
        getEnv: () => undefined,
        readVercelAuthFile: async () => {
          throw new Error("ENOENT");
        },
      })
    ).rejects.toThrow(/No Vercel token available.*ENOENT/);
  });

  it("throws when file lacks a token field", async () => {
    await expect(
      resolveVercelToken({
        getEnv: () => undefined,
        readVercelAuthFile: async () => JSON.stringify({ userId: "u_1" }),
      })
    ).rejects.toThrow(/No Vercel token available.*missing 'token' field/);
  });

  it("throws when file token is empty string", async () => {
    await expect(
      resolveVercelToken({
        getEnv: () => undefined,
        readVercelAuthFile: async () => JSON.stringify({ token: "" }),
      })
    ).rejects.toThrow(/No Vercel token available.*missing 'token' field/);
  });
});

describe("getVercelTeamId", () => {
  it("returns the env value when set", () => {
    expect(getVercelTeamId({ getEnv: () => "team_abc" })).toBe("team_abc");
  });

  it("returns undefined when unset", () => {
    expect(getVercelTeamId({ getEnv: () => undefined })).toBeUndefined();
  });

  it("returns undefined when empty", () => {
    expect(getVercelTeamId({ getEnv: () => "" })).toBeUndefined();
  });
});
