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
  redact?: string[];
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
      spies.gitCalls.push({ args, cwd: options.cwd, redact: options.redact });
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

    // clone → init → add → commit → remote add → push
    const cmdSequence = spies.gitCalls.map((c) =>
      c.args[0] === "-c" ? c.args.find((a) => ["init", "add", "commit", "push", "remote"].includes(a)) ?? c.args[0] : c.args[0]
    );
    expect(cmdSequence).toEqual([
      "clone",
      "init",
      "add",
      "commit",
      "remote",
      "push",
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
    expect(spies.removeCalls.length).toBeGreaterThanOrEqual(1);

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

    // Remote add uses the clean URL (no token)
    const remoteAdd = spies.gitCalls.find(
      (c) => c.args.includes("remote") && c.args.includes("add")
    )!;
    expect(remoteAdd.args).toContain("https://github.com/alice/my-site.git");
    expect(remoteAdd.args.join(" ")).not.toContain("x-access-token");

    // Push uses http.extraheader with base64 auth (token never in URL)
    const pushCall = spies.gitCalls.find((c) => c.args.includes("push"))!;
    const headerArg = pushCall.args.find((a) => a.startsWith("http.extraheader="));
    expect(headerArg).toBeDefined();
    expect(headerArg).toContain("Authorization: Basic ");
    // Redact list includes both raw token and base64 token
    expect(pushCall.redact).toBeDefined();
    expect(pushCall.redact!.length).toBe(2);
    expect(pushCall.redact).toContain("ghp_fake_token");
  });

  it("sets git author identity for commit", async () => {
    const { deps, spies } = makeDeps();
    const create = makeCreateSite(deps);
    await create("my-site", { cwd: "/w" });

    const commitCall = spies.gitCalls.find((c) => c.args.includes("commit"))!;
    expect(commitCall.args).toContain("user.name=bulma-cli");
    expect(commitCall.args).toContain("user.email=bulma@noreply");
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
    await expect(create("a", { cwd: "/w" })).resolves.toBeUndefined();
    await expect(create("a-b", { cwd: "/w" })).resolves.toBeUndefined();
    await expect(create("a".repeat(40), { cwd: "/w" })).resolves.toBeUndefined();
  });

  it("throws when target directory already exists", async () => {
    const { deps } = makeDeps({
      pathExists: async (p) => {
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
      pathExists: async () => false,
    });
    const create = makeCreateSite(deps);

    await expect(create("my-site", { cwd: "/w" })).rejects.toThrow(
      /Shell template not found/
    );
    expect(spies.removeCalls.length).toBeGreaterThan(0);
  });

  it("cleans up local dir when push fails", async () => {
    const { deps, spies } = makeDeps({
      runGit: async (args) => {
        spies.gitCalls.push({ args });
        if (args.includes("push")) {
          throw new Error("push rejected: auth failed");
        }
      },
    });
    const create = makeCreateSite(deps);

    await expect(create("my-site", { cwd: "/w" })).rejects.toThrow(/push rejected/);

    // Local dir was cleaned up on failure
    expect(spies.removeCalls).toContainEqual(path.join("/w", "my-site"));
  });

  it("cleans up local dir when GitHub repo creation fails", async () => {
    const { deps, spies } = makeDeps({
      createPrivateRepo: async () => {
        throw new Error("422 repo already exists");
      },
    });
    const create = makeCreateSite(deps);

    await expect(create("my-site", { cwd: "/w" })).rejects.toThrow(/422/);
    expect(spies.removeCalls).toContainEqual(path.join("/w", "my-site"));
  });

  it("uses an injected hoiPoiCloneUrl when provided", async () => {
    const { deps, spies } = makeDeps();
    const create = makeCreateSite(deps);
    await create("my-site", {
      cwd: "/w",
      hoiPoiCloneUrl: "https://example.com/fork.git",
    });
    expect(spies.gitCalls[0].args).toContain("https://example.com/fork.git");
  });
});
