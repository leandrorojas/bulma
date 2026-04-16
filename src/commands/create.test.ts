import path from "node:path";
import {
  makeCreateSite,
  CreateSiteDeps,
  HOI_POI_CLONE_URL,
  SHELL_TEMPLATE_SUBDIR,
} from "./create";

interface GitCall {
  args: string[];
  cwd?: string;
}

interface Spies {
  gitCalls: GitCall[];
  copyCalls: Array<{ src: string; dest: string }>;
  removeCalls: string[];
  createRepoCalls: Array<{ token: string; name: string; options: unknown }>;
  logs: string[];
}

function makeDeps(overrides: Partial<CreateSiteDeps> = {}): {
  deps: CreateSiteDeps;
  spies: Spies;
} {
  const spies: Spies = {
    gitCalls: [],
    copyCalls: [],
    removeCalls: [],
    createRepoCalls: [],
    logs: [],
  };
  const deps: CreateSiteDeps = {
    resolveToken: async () => "ghp_fake_token",
    createPrivateRepo: async (token, name, options) => {
      spies.createRepoCalls.push({ token, name, options });
      return {
        cloneUrl: `https://github.com/alice/${name}.git`,
        htmlUrl: `https://github.com/alice/${name}`,
      };
    },
    runGit: async (args, options = {}) => {
      spies.gitCalls.push({ args, cwd: options.cwd });
    },
    copyDir: async (src, dest) => {
      spies.copyCalls.push({ src, dest });
    },
    removeDir: async (dir) => {
      spies.removeCalls.push(dir);
    },
    pathExists: async (_p) => {
      // default: target does not exist, template source DOES exist
      return _p.endsWith(SHELL_TEMPLATE_SUBDIR);
    },
    mkdtemp: async (prefix) => `${prefix}fake-tmp`,
    ...overrides,
  };
  return { deps, spies };
}

describe("createSite", () => {
  it("runs the full flow in the correct order", async () => {
    const { deps, spies } = makeDeps();
    const create = makeCreateSite(deps);

    await create("my-site", {
      cwd: "/work",
      logger: (l) => spies.logs.push(l),
    });

    // clone → copyDir → removeDir tmp → git init → add → commit → createRepo → remote add → push → remote set-url
    const cmdSequence = spies.gitCalls.map((c) => c.args[0]);
    expect(cmdSequence).toEqual([
      "clone",
      "init",
      "add",
      "commit",
      "remote", // add
      "push",
      "remote", // set-url (strip token)
    ]);

    // Clone args point at hoi-poi with --depth 1
    expect(spies.gitCalls[0].args).toEqual([
      "clone",
      "--depth",
      "1",
      HOI_POI_CLONE_URL,
      expect.stringContaining("bulma-"),
    ]);

    // Copy from <tmp>/shell-template to /work/my-site
    expect(spies.copyCalls).toHaveLength(1);
    expect(spies.copyCalls[0].src).toMatch(new RegExp(`${SHELL_TEMPLATE_SUBDIR}$`));
    expect(spies.copyCalls[0].dest).toBe(path.join("/work", "my-site"));

    // Tmp dir was cleaned up
    expect(spies.removeCalls).toHaveLength(1);

    // Repo created with private=true and the CLI default description
    expect(spies.createRepoCalls).toEqual([
      {
        token: "ghp_fake_token",
        name: "my-site",
        options: {
          description: "Micro-frontend site scaffolded from hoi-poi",
          private: true,
        },
      },
    ]);

    // `git remote add origin` uses the tokenized URL
    const remoteAdd = spies.gitCalls.find(
      (c) => c.args[0] === "remote" && c.args[1] === "add"
    )!;
    expect(remoteAdd.args[3]).toContain("x-access-token:ghp_fake_token@");

    // Final `git remote set-url` restores the plain URL (no token)
    const remoteSetUrl = spies.gitCalls.find(
      (c) => c.args[0] === "remote" && c.args[1] === "set-url"
    )!;
    expect(remoteSetUrl.args[3]).toBe("https://github.com/alice/my-site.git");
    expect(remoteSetUrl.args[3]).not.toContain("x-access-token");
  });

  it("uses a custom description when provided", async () => {
    const { deps, spies } = makeDeps();
    const create = makeCreateSite(deps);
    await create("my-site", { cwd: "/w", description: "Custom purpose" });
    expect(spies.createRepoCalls[0].options).toMatchObject({
      description: "Custom purpose",
      private: true,
    });
  });

  it("rejects invalid site names before touching any I/O", async () => {
    const { deps, spies } = makeDeps();
    const create = makeCreateSite(deps);

    await expect(create("Bad Name!", { cwd: "/w" })).rejects.toThrow(/Invalid site name/);
    await expect(create("-leading", { cwd: "/w" })).rejects.toThrow(/Invalid site name/);
    await expect(create("trailing-", { cwd: "/w" })).rejects.toThrow(/Invalid site name/);
    await expect(create("UPPER", { cwd: "/w" })).rejects.toThrow(/Invalid site name/);

    expect(spies.gitCalls).toHaveLength(0);
    expect(spies.createRepoCalls).toHaveLength(0);
  });

  it("accepts valid name edge cases", async () => {
    const { deps } = makeDeps();
    const create = makeCreateSite(deps);
    // single char, max length (40), with dashes
    await expect(create("a", { cwd: "/w" })).resolves.toBeUndefined();
    await expect(create("a-b", { cwd: "/w" })).resolves.toBeUndefined();
    await expect(create("a".repeat(40), { cwd: "/w" })).resolves.toBeUndefined();
  });

  it("throws when target directory already exists", async () => {
    const { deps } = makeDeps({
      pathExists: async (p) => {
        // target exists, template still present
        return p.endsWith("my-site") || p.endsWith(SHELL_TEMPLATE_SUBDIR);
      },
    });
    const create = makeCreateSite(deps);

    await expect(create("my-site", { cwd: "/w" })).rejects.toThrow(
      /already exists.*my-site/
    );
  });

  it("throws a helpful error if shell-template is missing from the clone", async () => {
    const { deps, spies } = makeDeps({
      pathExists: async (_p) => false,
    });
    const create = makeCreateSite(deps);

    await expect(create("my-site", { cwd: "/w" })).rejects.toThrow(
      /Shell template not found/
    );
    // Tmp dir is cleaned up even on failure
    expect(spies.removeCalls.length).toBeGreaterThan(0);
  });

  it("strips token from remote URL even when push fails", async () => {
    let pushCalls = 0;
    const { deps, spies } = makeDeps({
      runGit: async (args) => {
        spies.gitCalls.push({ args });
        if (args[0] === "push") {
          pushCalls++;
          throw new Error("push rejected: auth failed");
        }
      },
    });
    const create = makeCreateSite(deps);

    await expect(create("my-site", { cwd: "/w" })).rejects.toThrow(/push rejected/);
    expect(pushCalls).toBe(1);

    // The token-stripping set-url still ran
    const setUrl = spies.gitCalls.find(
      (c) => c.args[0] === "remote" && c.args[1] === "set-url"
    );
    expect(setUrl).toBeDefined();
    expect(setUrl!.args[3]).not.toContain("x-access-token");
  });

  it("uses an injected hoiPoiCloneUrl when provided (for local testing)", async () => {
    const { deps, spies } = makeDeps();
    const create = makeCreateSite(deps);
    await create("my-site", {
      cwd: "/w",
      hoiPoiCloneUrl: "https://example.com/fork.git",
    });
    expect(spies.gitCalls[0].args).toContain("https://example.com/fork.git");
  });
});
