// Integration test for the `bulma create` flow.
//
// Unlike create.test.ts (which uses fully-mocked deps via injection), this
// test exercises the REAL filesystem operations end-to-end:
//   - real fs.mkdtemp / mkdir / writeFile / readFile / rm
//   - real copyDir traversal
//   - real path normalization
//
// What we still mock: the network/process boundaries that can't run safely
// in CI without external state — git operations, GitHub REST, Vercel REST.
// The fake `runGit` populates the temp clone directory with a minimal
// shell-template so the copyDir step has something real to traverse.
//
// What this catches that pure DI tests don't:
//   - Permission/path bugs (parent dir not created before writeFile)
//   - File contents actually round-tripping through the filesystem
//   - Cleanup races (tmpDir removed even on failure)
//   - Path-separator issues across the spawn → fs boundary

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeCreateSite, CreateSiteDeps, realDeps } from "./create";

interface RecordedGitCall {
  args: string[];
  cwd?: string;
}

const SHELL_TEMPLATE_FIXTURE: Record<string, string> = {
  "shell-template/package.json": JSON.stringify(
    {
      name: "shell-template",
      version: "1.0.0",
      private: true,
      scripts: {
        build: "webpack --mode production",
        test: "jest",
      },
    },
    null,
    2
  ),
  "shell-template/webpack.config.js":
    'module.exports = {\n  output: { path: "./dist" }\n};\n',
  "shell-template/src/index.js": "console.log('hello from shell');\n",
  "shell-template/README.md": "# shell-template\n",
};

// Writes a fake hoi-poi clone into `cloneTarget` so subsequent copyDir + path
// checks have real files to read.
async function writeFakeHoiPoiClone(cloneTarget: string): Promise<void> {
  for (const [relPath, content] of Object.entries(SHELL_TEMPLATE_FIXTURE)) {
    const full = path.join(cloneTarget, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
  }
}

interface IntegrationDeps {
  deps: CreateSiteDeps;
  gitCalls: RecordedGitCall[];
}

function buildIntegrationDeps(scratchRoot: string): IntegrationDeps {
  const gitCalls: RecordedGitCall[] = [];
  const deps: CreateSiteDeps = {
    // Real I/O — these are the seams under test.
    copyDir: realDeps.copyDir,
    removeDir: realDeps.removeDir,
    pathExists: realDeps.pathExists,
    writeFile: realDeps.writeFile,
    mkdir: realDeps.mkdir,
    // Use the scratch root for tmpdir so the test fully owns its cleanup.
    mkdtemp: (prefix) =>
      fs.mkdtemp(path.join(scratchRoot, path.basename(prefix))),

    // Mock all network/process boundaries.
    resolveToken: async () => "ghp_integration_token",
    resolveVercelToken: async () => "vcp_integration_token",
    getVercelTeamId: () => undefined,
    getBulmaSonarToken: () => undefined,
    runGit: async (args, options = {}) => {
      gitCalls.push({ args, cwd: options.cwd });
      // The clone step is the only one whose side effect the rest of the
      // flow depends on — populate the destination with a fake template.
      if (args[0] === "clone") {
        const cloneDest = args[args.length - 1];
        await writeFakeHoiPoiClone(cloneDest);
      }
    },
    createPrivateRepo: async (_token, name) => ({
      id: 12345,
      cloneUrl: `https://github.com/alice/${name}.git`,
      htmlUrl: `https://github.com/alice/${name}`,
    }),
    getAuthenticatedUser: async () => ({ id: 4242, login: "alice" }),
    createEnvironment: async () => undefined,
    setRepoSecret: async () => undefined,
    checkGitHubAppInstalled: async () => true,
    createVercelProject: async (_token, options) => ({
      id: "prj_int_test",
      name: options.name,
    }),
    updateProjectNodeVersion: async () => undefined,
    triggerProductionDeployment: async () => ({ uid: "dpl_int_test" }),
    pollDeploymentReady: async () => ({
      uid: "dpl_int_test",
      url: "site.vercel.app",
      state: "READY",
    }),
    getAccountSlug: async () => "alice-vercel",
  };
  return { deps, gitCalls };
}

describe("createSite — integration (real fs, mocked network)", () => {
  let scratchRoot: string;

  beforeEach(async () => {
    scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bulma-it-"));
  });

  afterEach(async () => {
    await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("scaffolds a complete site with workflows + vercel.json on real disk", async () => {
    const cwd = await fs.mkdtemp(path.join(scratchRoot, "cwd-"));
    const { deps } = buildIntegrationDeps(scratchRoot);
    const create = makeCreateSite(deps);

    await create("acme-store", { cwd, logger: () => {} });

    const siteDir = path.join(cwd, "acme-store");

    // Shell-template files copied.
    expect(await fs.readFile(path.join(siteDir, "package.json"), "utf8")).toContain(
      "shell-template"
    );
    expect(
      await fs.readFile(path.join(siteDir, "webpack.config.js"), "utf8")
    ).toContain("dist");

    // vercel.json written with valid JSON + expected shape.
    const vercelJson = JSON.parse(
      await fs.readFile(path.join(siteDir, "vercel.json"), "utf8")
    );
    expect(vercelJson).toEqual({
      buildCommand: "npm run build",
      outputDirectory: "dist",
      installCommand: "npm install",
      framework: null,
    });

    // All 4 workflow files materialized under .github/workflows/ — the
    // mkdir+writeFile sequence has to work for real to get here.
    const workflowsDir = path.join(siteDir, ".github", "workflows");
    const workflows = await fs.readdir(workflowsDir);
    expect(workflows.sort()).toEqual([
      "code-quality.yml",
      "integration-tests.yml",
      "prerelease.yml",
      "release.yml",
    ]);

    // Spot-check that the workflows reference the right account scope (not
    // the hardcoded default — should be derived from the authenticated user).
    const prerelease = await fs.readFile(
      path.join(workflowsDir, "prerelease.yml"),
      "utf8"
    );
    expect(prerelease).toContain('scope: "@alice"');
  });

  it("cleans up the cloned hoi-poi tmpdir after a successful scaffold", async () => {
    const cwd = await fs.mkdtemp(path.join(scratchRoot, "cwd-"));
    const { deps, gitCalls } = buildIntegrationDeps(scratchRoot);
    const create = makeCreateSite(deps);

    await create("cleanup-test", { cwd, logger: () => {} });

    const cloneArg = gitCalls.find((c) => c.args[0] === "clone");
    expect(cloneArg).toBeDefined();
    const tmpClonePath = cloneArg!.args[cloneArg!.args.length - 1];
    // The tmp clone dir was inside the scratch root and should be gone.
    await expect(fs.access(tmpClonePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back the partially-scaffolded target dir when a write fails", async () => {
    const cwd = await fs.mkdtemp(path.join(scratchRoot, "cwd-"));
    const { deps } = buildIntegrationDeps(scratchRoot);
    // Force a failure mid-scaffold by overriding writeFile to throw on
    // vercel.json. The flow's inner try/catch should remove the target dir.
    const realWriteFile = deps.writeFile;
    deps.writeFile = async (filePath, content) => {
      if (filePath.endsWith("vercel.json")) {
        throw new Error("simulated EACCES on vercel.json");
      }
      return realWriteFile(filePath, content);
    };
    const create = makeCreateSite(deps);

    await expect(create("rollback-test", { cwd, logger: () => {} })).rejects.toThrow(
      /simulated EACCES/
    );

    const targetDir = path.join(cwd, "rollback-test");
    await expect(fs.access(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("respects --skip-vercel: no vercel.json, but workflows still written", async () => {
    const cwd = await fs.mkdtemp(path.join(scratchRoot, "cwd-"));
    const { deps } = buildIntegrationDeps(scratchRoot);
    const create = makeCreateSite(deps);

    await create("no-vercel", { cwd, skipVercel: true, logger: () => {} });

    const siteDir = path.join(cwd, "no-vercel");
    await expect(fs.access(path.join(siteDir, "vercel.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const workflows = await fs.readdir(
      path.join(siteDir, ".github", "workflows")
    );
    expect(workflows).toHaveLength(4);
  });

  it("respects --skip-actions: no .github/, but vercel.json + template still present", async () => {
    const cwd = await fs.mkdtemp(path.join(scratchRoot, "cwd-"));
    const { deps } = buildIntegrationDeps(scratchRoot);
    const create = makeCreateSite(deps);

    await create("no-actions", { cwd, skipActions: true, logger: () => {} });

    const siteDir = path.join(cwd, "no-actions");
    await expect(fs.access(path.join(siteDir, ".github"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      JSON.parse(await fs.readFile(path.join(siteDir, "vercel.json"), "utf8"))
    ).toHaveProperty("framework", null);
    expect(
      await fs.readFile(path.join(siteDir, "package.json"), "utf8")
    ).toContain("shell-template");
  });
});
