import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveToken, resolveVercelToken, getVercelTeamId } from "../lib/auth";
import { createPrivateRepo, CreatedRepo } from "../lib/github";
import { runGit } from "../lib/git";
import { copyDir, pathExists, removeDir } from "../lib/fs-utils";
import {
  checkGitHubAppInstalled,
  createVercelProject,
  pollDeploymentReady,
  CreatedVercelProject,
  VercelDeployment,
  DeploymentTimeoutError,
} from "../lib/vercel";

export const HOI_POI_CLONE_URL = "https://github.com/leandrorojas/hoi-poi.git";
export const SHELL_TEMPLATE_SUBDIR = "shell-template";

// Build settings for Vercel projects scaffolded from the hoi-poi shell-template.
// Mirrors shell-template/webpack.config.js (output → dist) and package.json
// (build script → webpack --mode production).
const VERCEL_BUILD_COMMAND = "npm run build";
const VERCEL_OUTPUT_DIRECTORY = "dist";
const VERCEL_INSTALL_COMMAND = "npm install";
const VERCEL_NODE_VERSION = "20.x";
const VERCEL_DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;

const VERCEL_JSON_CONTENT =
  JSON.stringify(
    {
      buildCommand: VERCEL_BUILD_COMMAND,
      outputDirectory: VERCEL_OUTPUT_DIRECTORY,
      installCommand: VERCEL_INSTALL_COMMAND,
      framework: null,
    },
    null,
    2
  ) + "\n";

// GitHub repo name rules: 1–100 chars, alphanumerics + `-`, `_`, `.`
// Can't start/end with special chars. We apply a stricter lowercase
// constraint for consistency with the Hoi-Poi ecosystem.
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$/;

export interface CreateSiteOptions {
  description?: string;
  cwd?: string;
  hoiPoiCloneUrl?: string;
  logger?: (line: string) => void;
  skipVercel?: boolean;
}

export interface CreateSiteDeps {
  resolveToken: typeof resolveToken;
  resolveVercelToken: typeof resolveVercelToken;
  getVercelTeamId: typeof getVercelTeamId;
  createPrivateRepo: typeof createPrivateRepo;
  checkGitHubAppInstalled: typeof checkGitHubAppInstalled;
  createVercelProject: typeof createVercelProject;
  pollDeploymentReady: typeof pollDeploymentReady;
  runGit: typeof runGit;
  copyDir: typeof copyDir;
  removeDir: typeof removeDir;
  pathExists: typeof pathExists;
  writeFile: (filePath: string, content: string) => Promise<void>;
  mkdtemp: (prefix: string) => Promise<string>;
}

// Default dependency bundle — the real I/O implementations.
// Tests build their own bundle with fakes.
export const realDeps: CreateSiteDeps = {
  resolveToken,
  resolveVercelToken,
  getVercelTeamId,
  createPrivateRepo,
  checkGitHubAppInstalled,
  createVercelProject,
  pollDeploymentReady,
  runGit,
  copyDir,
  removeDir,
  pathExists,
  writeFile: (filePath, content) => fs.writeFile(filePath, content, "utf8"),
  mkdtemp: (prefix) => fs.mkdtemp(prefix),
};

// Extracts the GitHub owner from an html_url like
// "https://github.com/alice/my-site". Throws if the URL doesn't match.
function parseGitHubOwner(htmlUrl: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/[^/]+\/?$/.exec(htmlUrl);
  if (!match) {
    throw new Error(`Cannot parse GitHub owner from URL: ${htmlUrl}`);
  }
  return match[1];
}

export function makeCreateSite(deps: CreateSiteDeps) {
  return async function createSite(
    siteName: string,
    options: CreateSiteOptions = {}
  ): Promise<void> {
    const log = options.logger ?? ((l: string) => process.stdout.write(l + "\n"));
    const cwd = options.cwd ?? process.cwd();
    const cloneUrl = options.hoiPoiCloneUrl ?? HOI_POI_CLONE_URL;

    // 1. Validate name
    if (!NAME_PATTERN.test(siteName)) {
      throw new Error(
        `Invalid site name "${siteName}". Must be lowercase alphanumeric with optional dashes (max 40 chars), not starting or ending with a dash.`
      );
    }

    // 2. Validate local target
    const targetDir = path.join(cwd, siteName);
    if (await deps.pathExists(targetDir)) {
      throw new Error(`Target directory already exists: ${targetDir}`);
    }

    // 3. Resolve tokens before any side effects so auth issues fail fast.
    log("→ Resolving GitHub token");
    const token = await deps.resolveToken();

    let vercelToken: string | undefined;
    let vercelTeamId: string | undefined;
    if (!options.skipVercel) {
      log("→ Resolving Vercel token");
      vercelToken = await deps.resolveVercelToken();
      vercelTeamId = deps.getVercelTeamId();
    }

    // 4. Clone hoi-poi shallow into tmp, copy shell-template into target
    const tmpDir = await deps.mkdtemp(path.join(os.tmpdir(), "bulma-"));
    try {
      log(`→ Cloning ${cloneUrl}`);
      await deps.runGit(["clone", "--depth", "1", cloneUrl, tmpDir]);

      const templateSrc = path.join(tmpDir, SHELL_TEMPLATE_SUBDIR);
      if (!(await deps.pathExists(templateSrc))) {
        throw new Error(
          `Shell template not found at ${SHELL_TEMPLATE_SUBDIR}/ in ${cloneUrl}`
        );
      }

      log(`→ Scaffolding ${targetDir}`);
      try {
        await deps.copyDir(templateSrc, targetDir);
      } catch (err) {
        await deps.removeDir(targetDir).catch(() => {});
        throw err;
      }
    } finally {
      await deps.removeDir(tmpDir).catch(() => {
        /* best-effort cleanup */
      });
    }

    // 5. Drop a vercel.json so the first deploy uses the right build settings
    // even if the GitHub-Vercel link races ahead of the project's CLI config.
    if (!options.skipVercel) {
      await deps.writeFile(path.join(targetDir, "vercel.json"), VERCEL_JSON_CONTENT);
    }

    // 6. Initialize local repo + initial commit. Set a default git identity so
    // this works in pristine / CI environments where user.name and user.email
    // may not be configured.
    log("→ Initializing local git repo");
    await deps.runGit(["init", "-b", "main"], { cwd: targetDir });
    await deps.runGit(["add", "-A"], { cwd: targetDir });
    await deps.runGit(
      ["-c", "user.name=bulma-cli", "-c", "user.email=bulma@noreply",
       "commit", "-m", "🩲 scaffold from hoi-poi shell-template"],
      { cwd: targetDir }
    );

    // 7. Create private GitHub repo (first external side effect).
    // If this or any subsequent step fails, clean up the local directory
    // so the user can re-run from a clean state. (The remote GitHub repo,
    // if created, will remain as an empty orphan — manual cleanup.)
    log(`→ Creating private GitHub repo ${siteName}`);
    let created: CreatedRepo;
    try {
      created = await deps.createPrivateRepo(token, siteName, {
        description:
          options.description ?? "Micro-frontend site scaffolded from hoi-poi",
        private: true,
      });
    } catch (err) {
      await deps.removeDir(targetDir).catch(() => {});
      throw err;
    }

    // 8. Push using http.extraheader for one-shot auth.
    // The token never touches .git/config on disk.
    log(`→ Pushing to ${created.htmlUrl}`);
    await deps.runGit(["remote", "add", "origin", created.cloneUrl], {
      cwd: targetDir,
    });
    const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");
    try {
      await deps.runGit(
        ["-c", `http.extraheader=Authorization: Basic ${basicAuth}`,
         "push", "-u", "origin", "main"],
        { cwd: targetDir, redact: [basicAuth, token] }
      );
    } catch (err) {
      // Push failed — clean up local dir so user can retry cleanly.
      // The remote GitHub repo may exist as an empty orphan.
      await deps.removeDir(targetDir).catch(() => {});
      throw err;
    }

    if (options.skipVercel) {
      log(`✓ ${siteName} created at ${created.htmlUrl} (Vercel skipped)`);
      return;
    }

    // 9. Vercel project. The repo must exist with code on `main` before we
    // ask Vercel to link, so the first deployment has something to build.
    const owner = parseGitHubOwner(created.htmlUrl);
    log("→ Verifying Vercel ↔ GitHub integration");
    const installed = await deps.checkGitHubAppInstalled(
      vercelToken!,
      owner,
      { teamId: vercelTeamId }
    );
    if (!installed) {
      throw new Error(
        `Vercel GitHub App not installed (or restricted) for "${owner}". ` +
          `Install it with All-repos access at https://vercel.com/integrations/github`
      );
    }

    // On Vercel-create failure: don't wipe the local dir — it's already in
    // sync with the GitHub repo, and the user can retry just the Vercel step.
    log(`→ Creating Vercel project ${siteName}`);
    const project: CreatedVercelProject = await deps.createVercelProject(
      vercelToken!,
      {
        name: siteName,
        gitRepoFullName: `${owner}/${siteName}`,
        buildCommand: VERCEL_BUILD_COMMAND,
        outputDirectory: VERCEL_OUTPUT_DIRECTORY,
        installCommand: VERCEL_INSTALL_COMMAND,
        nodeVersion: VERCEL_NODE_VERSION,
      },
      { teamId: vercelTeamId }
    );

    // 10. Poll the first production deployment. Treat timeout as a warning,
    // not a fatal — the project is created and Vercel will keep building;
    // the user can check the dashboard.
    log("→ Waiting for first production deployment (up to 5 min)");
    let deployment: VercelDeployment | undefined;
    try {
      deployment = await deps.pollDeploymentReady(
        vercelToken!,
        project.id,
        {
          timeoutMs: VERCEL_DEPLOY_TIMEOUT_MS,
          teamId: vercelTeamId,
        }
      );
    } catch (err) {
      if (err instanceof DeploymentTimeoutError) {
        log(
          `⚠ First deployment did not complete in 5 min. ` +
            `Check https://vercel.com/${owner}/${siteName}`
        );
      } else {
        throw err;
      }
    }

    log(`✓ ${siteName} created at ${created.htmlUrl}`);
    if (deployment) {
      log(`  Production: https://${deployment.url}`);
      log(`  Previews: enabled per branch (Vercel auto)`);
    }
  };
}

// Default export — real implementation bound to real deps.
export const createSite = makeCreateSite(realDeps);
