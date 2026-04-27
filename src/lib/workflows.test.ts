import { buildWorkflowFiles, DEFAULT_PUBLISH_SCOPE } from "./workflows";

function findWorkflow(files: ReturnType<typeof buildWorkflowFiles>, name: string) {
  const wf = files.find((w) => w.path.endsWith(`/${name}.yml`));
  if (!wf) throw new Error(`workflow ${name}.yml not in WORKFLOW_FILES`);
  return wf;
}

describe("buildWorkflowFiles manifest", () => {
  it("includes the four expected workflows under .github/workflows/", () => {
    const files = buildWorkflowFiles();
    expect(files.map((w) => w.path)).toEqual([
      ".github/workflows/code-quality.yml",
      ".github/workflows/integration-tests.yml",
      ".github/workflows/prerelease.yml",
      ".github/workflows/release.yml",
    ]);
  });

  it("has non-empty content for each entry", () => {
    for (const w of buildWorkflowFiles()) {
      expect(w.content.trim().length).toBeGreaterThan(0);
    }
  });

  it("returns a deep-frozen array (entries cannot be mutated)", () => {
    const files = buildWorkflowFiles();
    expect(Object.isFrozen(files)).toBe(true);
    for (const f of files) {
      expect(Object.isFrozen(f)).toBe(true);
    }
  });

  it("defaults the publish scope to @leandrorojas", () => {
    expect(DEFAULT_PUBLISH_SCOPE).toBe("@leandrorojas");
  });
});

describe("code-quality.yml", () => {
  const wf = findWorkflow(buildWorkflowFiles(), "code-quality");

  it("runs Unit Tests + SonarQube jobs (CodeRabbit handled by the GitHub App, not this workflow)", () => {
    expect(wf.content).toContain("name: Code Quality");
    expect(wf.content).toContain("Unit Tests");
    expect(wf.content).toContain("SonarQube Analysis");
  });

  it("does NOT reference the deprecated coderabbitai/ai-pr-reviewer action", () => {
    expect(wf.content).not.toContain("coderabbitai/ai-pr-reviewer");
    expect(wf.content).not.toContain("CODERABBIT_API_KEY");
  });

  it("gates SonarQube on Unit Tests", () => {
    expect(wf.content).toContain("needs: [unit-tests]");
  });

  it("uploads coverage as an artifact for the Sonar job", () => {
    expect(wf.content).toContain("upload-artifact@v4");
    expect(wf.content).toContain("coverage-report");
  });
});

describe("integration-tests.yml", () => {
  const wf = findWorkflow(buildWorkflowFiles(), "integration-tests");

  it("triggers off the Code Quality workflow_run on main", () => {
    expect(wf.content).toContain('workflows: ["Code Quality"]');
    expect(wf.content).toContain("branches: [main]");
  });

  it("only runs when Code Quality concluded successfully", () => {
    expect(wf.content).toContain("github.event.workflow_run.conclusion == 'success'");
  });

  it("no-ops gracefully when test:integration script is absent", () => {
    expect(wf.content).toContain("test:integration");
    expect(wf.content).toContain("::warning::No test:integration script found");
  });
});

describe("prerelease.yml", () => {
  it("uses the default @leandrorojas scope when no scope is passed", () => {
    const wf = findWorkflow(buildWorkflowFiles(), "prerelease");
    expect(wf.content).toContain('scope: "@leandrorojas"');
  });

  it("uses the caller-provided scope when given", () => {
    const wf = findWorkflow(buildWorkflowFiles("@alice"), "prerelease");
    expect(wf.content).toContain('scope: "@alice"');
    expect(wf.content).not.toContain('scope: "@leandrorojas"');
  });

  it("publishes to GitHub Packages with the prerelease dist-tag", () => {
    const wf = findWorkflow(buildWorkflowFiles(), "prerelease");
    expect(wf.content).toContain("registry-url: https://npm.pkg.github.com");
    expect(wf.content).toContain("npm publish --tag prerelease");
  });

  it("appends -build-<run_number> as the prerelease version", () => {
    const wf = findWorkflow(buildWorkflowFiles(), "prerelease");
    expect(wf.content).toContain(
      "npm version ${BASE_VERSION}-build-${{ github.run_number }} --no-git-tag-version"
    );
  });
});

describe("release.yml (QA approval gate)", () => {
  it("runs only on tag pushes matching v*", () => {
    const wf = findWorkflow(buildWorkflowFiles(), "release");
    expect(wf.content).toContain('tags: ["v*"]');
  });

  it("includes a qa-approval job tied to the production environment", () => {
    const wf = findWorkflow(buildWorkflowFiles(), "release");
    expect(wf.content).toContain("qa-approval");
    expect(wf.content).toContain("environment: production");
  });

  it("gates publish-release on qa-approval", () => {
    const wf = findWorkflow(buildWorkflowFiles(), "release");
    expect(wf.content).toContain("needs: [qa-approval]");
  });

  it("verifies tag version matches package.json version before publishing", () => {
    const wf = findWorkflow(buildWorkflowFiles(), "release");
    expect(wf.content).toContain("TAG_VERSION=");
    expect(wf.content).toContain("PKG_VERSION=");
    expect(wf.content).toContain("does not match package.json version");
  });

  it("publishes to GitHub Packages without --tag prerelease", () => {
    const wf = findWorkflow(buildWorkflowFiles(), "release");
    expect(wf.content).toContain("npm publish");
    expect(wf.content).not.toContain("npm publish --tag prerelease");
  });

  it("uses the caller-provided scope", () => {
    const wf = findWorkflow(buildWorkflowFiles("@bob"), "release");
    expect(wf.content).toContain('scope: "@bob"');
  });
});
