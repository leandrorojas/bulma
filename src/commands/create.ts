import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveToken,
  resolveVercelToken,
  getVercelTeamId,
  getBulmaSonarToken,
} from "../lib/auth";
import {
  createPrivateRepo,
  getAuthenticatedUser,
  createEnvironment,
  setRepoSecret,
  CreatedRepo,
} from "../lib/github";
import { runGit } from "../lib/git";
import { copyDir, pathExists, removeDir } from "../lib/fs-utils";
import { buildWorkflowFiles } from "../lib/workflows";
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
  skipActions?: boolean;
}

export interface CreateSiteDeps {
  resolveToken: typeof resolveToken;
  resolveVercelToken: typeof resolveVercelToken;
  getVercelTeamId: typeof getVercelTeamId;
  getBulmaSonarToken: typeof getBulmaSonarToken;
  createPrivateRepo: typeof createPrivateRepo;
  getAuthenticatedUser: typeof getAuthenticatedUser;
  createEnvironment: typeof createEnvironment;
  setRepoSecret: typeof setRepoSecret;
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
  mkdir: (dirPath: string) => Promise<void>;
  mkdtemp: (prefix: string) => Promise<string>;
}

// Default dependency bundle — the real I/O implementations.
// Tests build their own bundle with fakes.
export const realDeps: CreateSiteDeps = {
  resolveToken,
  resolveVercelToken,
  getVercelTeamId,
  getBulmaSonarToken,
  createPrivateRepo,
  getAuthenticatedUser,
  createEnvironment,
  setRepoSecret,
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
  mkdir: (dirPath) => fs.mkdir(dirPath, { recursive: true }).then(() => undefined),
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

    // Resolve the authenticated user once: we need both `id` (later, as the
    // production-environment reviewer) and `login` (now, as the npm scope
    // for prerelease.yml + release.yml — workflows publish to GitHub
    // Packages under @<login>/<site>). createPrivateRepo creates the repo
    // under the authenticated user, so login == owner deterministically.
    let ghUser: { id: number; login: string } | undefined;
    if (!options.skipActions) {
      log("→ Resolving authenticated GitHub user");
      ghUser = await deps.getAuthenticatedUser(token);
    }
    const publishScope = ghUser ? `@${ghUser.login}` : "@leandrorojas";

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
        if (!options.skipActions) {
          // Workflow files must land in the initial commit so they're active
          // from the first push. Each file lives under .github/workflows/ —
          // create the directory once, then write each entry.
          await deps.mkdir(path.join(targetDir, ".github", "workflows"));
          for (const wf of buildWorkflowFiles(publishScope)) {
            await deps.writeFile(path.join(targetDir, wf.path), wf.content);
          }
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

    // 7. Provision GitHub Actions secrets + the production approval gate.
    // All best-effort: the workflows are already in the initial commit, but
    // they'll fail until the secrets/environment exist. Failure here doesn't
    // abort the scaffold — we surface a warning and continue, and the user
    // can fix the gap manually before the next push.
    if (!options.skipActions) {
      const owner = parseGitHubOwner(created.htmlUrl);
      const sonarToken = deps.getBulmaSonarToken();
      if (sonarToken) {
        log("→ Setting SONAR_TOKEN repo secret");
        try {
          await deps.setRepoSecret(owner, siteName, "SONAR_TOKEN", sonarToken);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          log(`⚠ Failed to set SONAR_TOKEN: ${reason}`);
        }
      } else {
        log(
          "⚠ BULMA_SONAR_TOKEN not set — SonarQube workflow will fail until you " +
            `add a SONAR_TOKEN repo secret to ${created.htmlUrl}`
        );
      }

      log("→ Creating production environment with QA approval gate");
      try {
        if (!ghUser) {
          throw new Error("internal: ghUser must be resolved when skipActions is false");
        }
        await deps.createEnvironment(token, owner, siteName, "production", {
          reviewerUserIds: [ghUser.id],
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (/billing plan|protection rule/i.test(reason)) {
          // GitHub Free only allows required-reviewer protection on PUBLIC
          // repos. On private free-tier repos this 422s. Skip pre-creating
          // the environment — GitHub Actions auto-creates it on first
          // release.yml run (just without the QA gate).
          log(
            "⚠ Required-reviewer protection needs GitHub Pro/Team on private repos. " +
              "Skipping environment pre-creation — release.yml will run without a QA gate. " +
              "Upgrade and re-run, or add reviewers manually in repo Settings → Environments."
          );
        } else {
          log(
            `⚠ Failed to create production environment: ${reason}. ` +
              `release.yml will skip the QA gate until you configure it manually.`
          );
        }
      }
    }

    // 8. Push using http.extraheader for one-shot auth.
    //    The token never touches .git/config on disk.
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
      const reason = err instanceof Error ? err.message : String(err);
      if (/workflow.*scope/i.test(reason)) {
        throw new Error(
          `Push rejected: the gh OAuth token is missing the \`workflow\` scope, required for pushing files under .github/workflows/. ` +
            `Refresh with: gh auth refresh -h github.com -s workflow, then delete ${created.htmlUrl} and re-run.`
        );
      }
      throw err;
    }

    if (!vercel.enabled) {
      log(`✓ ${siteName} created at ${created.htmlUrl} (Vercel skipped)`);
      return;
    }

    // 9. Vercel project. The repo must exist with code on `main` before we
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
          `Install it with All repositories access at https://vercel.com/integrations/github, ` +
          `then either re-run with --skip-vercel, or delete ${created.htmlUrl} ` +
          `and re-run to redo the whole flow.`
      );
    }

    // 10. Resolve the Vercel account slug for dashboard URLs. Best-effort:
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
    // Best-effort: any failure here (4xx, 5xx, network) is non-fatal because
    // the project itself was created on the line above. The fallback is
    // Vercel's default Node version, which works for React 19 + Webpack 5,
    // so we log a warning rather than abort and force a full re-scaffold.
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

    // 11. Poll the first production deployment. Treat timeout as a warning,
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
