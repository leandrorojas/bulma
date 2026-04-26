import {
  resolveToken,
  resolveVercelToken,
  getVercelTeamId,
  vercelCliAuthPaths,
  readVercelAuthFileFromPaths,
} from "./auth";

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
    ).rejects.toThrow(/missing the 'token' field/);
  });

  it("throws when file token is empty string", async () => {
    await expect(
      resolveVercelToken({
        getEnv: () => undefined,
        readVercelAuthFile: async () => JSON.stringify({ token: "" }),
      })
    ).rejects.toThrow(/missing the 'token' field/);
  });

  it("throws a corrupt-auth-file error when JSON is malformed", async () => {
    await expect(
      resolveVercelToken({
        getEnv: () => undefined,
        readVercelAuthFile: async () => "{not json",
      })
    ).rejects.toThrow(/Corrupt vercel auth file/);
  });
});

describe("resolveVercelToken default env", () => {
  const original = process.env.VERCEL_TOKEN;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.VERCEL_TOKEN;
    } else {
      process.env.VERCEL_TOKEN = original;
    }
  });

  it("reads VERCEL_TOKEN from process.env when no override is given", async () => {
    process.env.VERCEL_TOKEN = "vcp_real_env";
    const token = await resolveVercelToken({
      readVercelAuthFile: async () => {
        throw new Error("should not be called");
      },
    });
    expect(token).toBe("vcp_real_env");
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

describe("vercelCliAuthPaths", () => {
  it("returns the macOS Application Support path on darwin", () => {
    const paths = vercelCliAuthPaths("darwin", "/Users/alice", {});
    expect(paths).toEqual([
      "/Users/alice/Library/Application Support/com.vercel.cli/auth.json",
    ]);
  });

  it("uses LOCALAPPDATA on win32 when set", () => {
    const paths = vercelCliAuthPaths("win32", "C:\\Users\\Alice", {
      LOCALAPPDATA: "D:\\AppData",
    });
    expect(paths[0]).toContain("D:\\AppData");
    expect(paths[0]).toContain("com.vercel.cli");
  });

  it("falls back to %HOME%/AppData/Local on win32 without LOCALAPPDATA", () => {
    const paths = vercelCliAuthPaths("win32", "C:\\Users\\Alice", {});
    expect(paths[0]).toContain("AppData");
    expect(paths[0]).toContain("Local");
  });

  it("uses XDG_DATA_HOME on linux when set", () => {
    const paths = vercelCliAuthPaths("linux", "/home/alice", {
      XDG_DATA_HOME: "/custom/data",
    });
    expect(paths).toEqual(["/custom/data/com.vercel.cli/auth.json"]);
  });

  it("falls back to ~/.local/share on linux without XDG_DATA_HOME", () => {
    const paths = vercelCliAuthPaths("linux", "/home/alice", {});
    expect(paths).toEqual(["/home/alice/.local/share/com.vercel.cli/auth.json"]);
  });
});

describe("readVercelAuthFileFromPaths", () => {
  it("returns the first path that reads successfully", async () => {
    const seen: string[] = [];
    const result = await readVercelAuthFileFromPaths(
      ["/a", "/b", "/c"],
      async (p) => {
        seen.push(p);
        if (p === "/b") return "found-content";
        throw new Error("ENOENT");
      }
    );
    expect(result).toBe("found-content");
    expect(seen).toEqual(["/a", "/b"]);
  });

  it("rethrows the last error when every path fails", async () => {
    await expect(
      readVercelAuthFileFromPaths(["/a", "/b"], async (p) => {
        throw new Error(`fail:${p}`);
      })
    ).rejects.toThrow(/fail:\/b/);
  });

  it("throws a generic error when given an empty path list", async () => {
    await expect(readVercelAuthFileFromPaths([])).rejects.toThrow(
      /no vercel auth file found/
    );
  });
});

describe("getVercelTeamId default env", () => {
  const original = process.env.VERCEL_TEAM_ID;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.VERCEL_TEAM_ID;
    } else {
      process.env.VERCEL_TEAM_ID = original;
    }
  });

  it("reads from process.env.VERCEL_TEAM_ID by default", () => {
    process.env.VERCEL_TEAM_ID = "team_real";
    expect(getVercelTeamId()).toBe("team_real");
  });

  it("returns undefined when env is empty by default", () => {
    process.env.VERCEL_TEAM_ID = "";
    expect(getVercelTeamId()).toBeUndefined();
  });
});
