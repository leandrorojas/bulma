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
  updateProjectNodeVersion,
  triggerProductionDeployment,
  pollDeploymentReady,
  getAccountSlug,
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
const VERCEL_FALLBACK_DASHBOARD = "https://vercel.com/dashboard";

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
  updateProjectNodeVersion: typeof updateProjectNodeVersion;
  triggerProductionDeployment: typeof triggerProductionDeployment;
  pollDeploymentReady: typeof pollDeploymentReady;
  getAccountSlug: typeof getAccountSlug;
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
  updateProjectNodeVersion,
  triggerProductionDeployment,
  pollDeploymentReady,
  getAccountSlug,
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

// Discriminated union — when enabled is true, token is guaranteed non-null,
// so the rest of the flow can drop the `!` non-null assertions.
type VercelContext =
  | { enabled: false }
  | { enabled: true; token: string; teamId: string | undefined };

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

    let vercel: VercelContext = { enabled: false };
    if (!options.skipVercel) {
      log("→ Resolving Vercel token");
      const vercelToken = await deps.resolveVercelToken();
      vercel = {
        enabled: true,
        token: vercelToken,
        teamId: deps.getVercelTeamId(),
      };
    }

    // 4. Clone hoi-poi shallow into tmp, copy shell-template into target.
    // The inner cleanup catch covers both copyDir and the vercel.json write
    // so a partial scaffold is always rolled back.
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
        if (vercel.enabled) {
          await deps.writeFile(
            path.join(targetDir, "vercel.json"),
            VERCEL_JSON_CONTENT
          );
        }
      } catch (err) {
        await deps.removeDir(targetDir).catch(() => {});
        throw err;
      }
    } finally {
      await deps.removeDir(tmpDir).catch(() => {
        /* best-effort cleanup */
      });
    }

    // 5. Initialize local repo + initial commit. Set a default git identity so
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

    // 6. Create private GitHub repo (first external side effect).
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

    // 7. Push using http.extraheader for one-shot auth.
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

    if (!vercel.enabled) {
      log(`✓ ${siteName} created at ${created.htmlUrl} (Vercel skipped)`);
      return;
    }

    // 8. Vercel project. The repo must exist with code on `main` before we
    // ask Vercel to link, so the first deployment has something to build.
    const owner = parseGitHubOwner(created.htmlUrl);
    log("→ Verifying Vercel ↔ GitHub integration");
    const installed = await deps.checkGitHubAppInstalled(
      vercel.token,
      owner,
      { teamId: vercel.teamId }
    );
    if (!installed) {
      throw new Error(
        `Vercel GitHub App not installed (or restricted) for "${owner}". ` +
          `Install it with All-repos access at https://vercel.com/integrations/github, ` +
          `then either re-run with --skip-vercel, or delete ${created.htmlUrl} ` +
          `and re-run to redo the whole flow.`
      );
    }

    // 9. Resolve the Vercel account slug for dashboard URLs. Best-effort:
    // if the lookup fails, fall back to the generic dashboard so we never
    // surface a 404 link to the user.
    let accountSlug: string | undefined;
    try {
      accountSlug = await deps.getAccountSlug(vercel.token, { teamId: vercel.teamId });
    } catch {
      accountSlug = undefined;
    }
    const dashboard = accountSlug
      ? `https://vercel.com/${accountSlug}/${siteName}`
      : VERCEL_FALLBACK_DASHBOARD;

    // On Vercel-create failure: don't wipe the local dir — it's already in
    // sync with the GitHub repo, and the user can retry just the Vercel step.
    log(`→ Creating Vercel project ${siteName}`);
    const project: CreatedVercelProject = await deps.createVercelProject(
      vercel.token,
      {
        name: siteName,
        gitRepoFullName: `${owner}/${siteName}`,
        buildCommand: VERCEL_BUILD_COMMAND,
        outputDirectory: VERCEL_OUTPUT_DIRECTORY,
        installCommand: VERCEL_INSTALL_COMMAND,
      },
      { teamId: vercel.teamId }
    );
    // Vercel rejects nodeVersion in the create body — set it via PATCH after.
    // Best-effort: a 4xx here doesn't invalidate the project (Vercel just
    // falls back to its default Node version), so we log a warning rather
    // than abort the scaffold.
    try {
      await deps.updateProjectNodeVersion(
        vercel.token,
        project.id,
        VERCEL_NODE_VERSION,
        { teamId: vercel.teamId }
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`⚠ Failed to pin Node ${VERCEL_NODE_VERSION} on Vercel project: ${reason}`);
    }

    // Vercel does NOT automatically deploy on project creation — it only
    // reacts to push events that happen *after* the link is established.
    // Since we push to GitHub before creating the project, no event fires
    // and the project sits empty. Trigger an explicit deployment from the
    // linked repo's main branch HEAD.
    log("→ Triggering initial Vercel production deployment");
    try {
      await deps.triggerProductionDeployment(
        vercel.token,
        {
          projectName: siteName,
          gitRepoId: created.id,
          ref: "main",
        },
        { teamId: vercel.teamId }
      );
    } catch (err) {
      // Project + repo are already in place; surface the dashboard so the
      // user can retry the deploy (or check for a Vercel/GitHub link sync
      // issue) before re-throwing.
      log(`⚠ Failed to trigger initial deployment. Check ${dashboard}`);
      throw err;
    }

    // 10. Poll the first production deployment. Treat timeout as a warning,
    // not a fatal — the project is created and Vercel will keep building;
    // the user can check the dashboard.
    log("→ Waiting for first production deployment (up to 5 min)");
    let deployment: VercelDeployment | undefined;
    try {
      deployment = await deps.pollDeploymentReady(
        vercel.token,
        project.id,
        {
          timeoutMs: VERCEL_DEPLOY_TIMEOUT_MS,
          teamId: vercel.teamId,
        }
      );
    } catch (err) {
      // Both branches surface the dashboard URL — the project + repo are in
      // place either way, and the user needs the link regardless of whether
      // we treat this as fatal (DeploymentFailedError) or recoverable (timeout).
      if (err instanceof DeploymentTimeoutError) {
        log(`⚠ First deployment did not complete in 5 min. Check ${dashboard}`);
      } else {
        log(`⚠ Deployment failed. Check ${dashboard}`);
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
