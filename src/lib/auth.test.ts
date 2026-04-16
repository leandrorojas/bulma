import { resolveToken } from "./auth";

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
