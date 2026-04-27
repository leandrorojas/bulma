import { WORKFLOW_FILES } from "./workflows";

function findWorkflow(name: string) {
  const wf = WORKFLOW_FILES.find((w) => w.path.endsWith(`/${name}.yml`));
  if (!wf) throw new Error(`workflow ${name}.yml not in WORKFLOW_FILES`);
  return wf;
}

describe("WORKFLOW_FILES manifest", () => {
  it("includes the four expected workflows under .github/workflows/", () => {
    expect(WORKFLOW_FILES.map((w) => w.path)).toEqual([
      ".github/workflows/code-quality.yml",
      ".github/workflows/integration-tests.yml",
      ".github/workflows/prerelease.yml",
      ".github/workflows/release.yml",
    ]);
  });

  it("has non-empty content for each entry", () => {
    for (const w of WORKFLOW_FILES) {
      expect(w.content.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("code-quality.yml", () => {
  const wf = findWorkflow("code-quality");

  it("runs CodeRabbit, Unit Tests, and SonarQube jobs", () => {
    expect(wf.content).toContain("name: Code Quality");
    expect(wf.content).toContain("CodeRabbit Review");
    expect(wf.content).toContain("Unit Tests");
    expect(wf.content).toContain("SonarQube Analysis");
  });

  it("gates SonarQube on Unit Tests", () => {
    expect(wf.content).toContain("needs: [unit-tests]");
  });

  it("only runs CodeRabbit on same-repo PRs (not forks)", () => {
    expect(wf.content).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository"
    );
  });

  it("uploads coverage as an artifact for the Sonar job", () => {
    expect(wf.content).toContain("upload-artifact@v4");
    expect(wf.content).toContain("coverage-report");
  });
});

describe("integration-tests.yml", () => {
  const wf = findWorkflow("integration-tests");

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
  const wf = findWorkflow("prerelease");

  it("publishes to GitHub Packages under the @leandrorojas scope", () => {
    expect(wf.content).toContain("registry-url: https://npm.pkg.github.com");
    expect(wf.content).toContain('scope: "@leandrorojas"');
  });

  it("appends -build-<run_number> as the prerelease version", () => {
    expect(wf.content).toContain(
      "npm version ${BASE_VERSION}-build-${{ github.run_number }} --no-git-tag-version"
    );
  });

  it("publishes with the prerelease dist-tag", () => {
    expect(wf.content).toContain("npm publish --tag prerelease");
  });
});

describe("release.yml (QA approval gate)", () => {
  const wf = findWorkflow("release");

  it("runs only on tag pushes matching v*", () => {
    expect(wf.content).toContain('tags: ["v*"]');
  });

  it("includes a qa-approval job tied to the production environment", () => {
    expect(wf.content).toContain("qa-approval");
    expect(wf.content).toContain("environment: production");
  });

  it("gates publish-release on qa-approval", () => {
    expect(wf.content).toContain("needs: [qa-approval]");
  });

  it("verifies tag version matches package.json version before publishing", () => {
    expect(wf.content).toContain("TAG_VERSION=");
    expect(wf.content).toContain("PKG_VERSION=");
    expect(wf.content).toContain("does not match package.json version");
  });

  it("publishes to GitHub Packages without --tag prerelease", () => {
    expect(wf.content).toContain("npm publish");
    expect(wf.content).not.toContain("npm publish --tag prerelease");
  });
});
