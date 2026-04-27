import { TOP_LEVEL_HELP, CREATE_HELP } from "./help";

describe("TOP_LEVEL_HELP", () => {
  it("documents the prerequisite gh scopes", () => {
    expect(TOP_LEVEL_HELP).toContain("repo, workflow, delete_repo");
  });

  it("documents the Vercel GitHub App requirement with a setup URL", () => {
    expect(TOP_LEVEL_HELP).toContain("Vercel GitHub App");
    expect(TOP_LEVEL_HELP).toContain("https://vercel.com/integrations/github");
  });

  it("lists VERCEL_TOKEN as required", () => {
    expect(TOP_LEVEL_HELP).toContain("VERCEL_TOKEN");
  });

  it("lists optional env vars (BULMA_SONAR_TOKEN, VERCEL_TEAM_ID)", () => {
    expect(TOP_LEVEL_HELP).toContain("BULMA_SONAR_TOKEN");
    expect(TOP_LEVEL_HELP).toContain("VERCEL_TEAM_ID");
  });

  it("includes runnable examples for the create command", () => {
    expect(TOP_LEVEL_HELP).toContain("$ bulma create my-site");
    expect(TOP_LEVEL_HELP).toContain("--skip-vercel");
  });

  it("points to per-command help", () => {
    expect(TOP_LEVEL_HELP).toContain("bulma help <command>");
  });
});

describe("CREATE_HELP", () => {
  it("documents the full scaffold flow", () => {
    expect(CREATE_HELP).toContain("GitHub repo");
    expect(CREATE_HELP).toContain("Vercel project");
    expect(CREATE_HELP).toContain("initial deployment");
  });

  it("explains both skip flags with their tradeoffs", () => {
    expect(CREATE_HELP).toContain("--skip-vercel");
    expect(CREATE_HELP).toContain("--skip-actions");
  });

  it("explains how the working directory determines the site location", () => {
    expect(CREATE_HELP).toContain("current working directory");
    expect(CREATE_HELP).toContain("~/code/personal");
  });

  it("includes a -d / --description example", () => {
    expect(CREATE_HELP).toContain('-d "');
  });
});
