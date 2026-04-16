import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveToken } from "../lib/auth";
import { createPrivateRepo, CreatedRepo } from "../lib/github";
import { runGit } from "../lib/git";
import { copyDir, pathExists, removeDir } from "../lib/fs-utils";

export const HOI_POI_CLONE_URL = "https://github.com/leandrorojas/hoi-poi.git";
export const SHELL_TEMPLATE_SUBDIR = "shell-template";

// GitHub repo name rules: 1–100 chars, alphanumerics + `-`, `_`, `.`
// Can't start/end with special chars. We apply a stricter lowercase
// constraint for consistency with the Hoi-Poi ecosystem.
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$/;

export interface CreateSiteOptions {
  description?: string;
  cwd?: string;
  hoiPoiCloneUrl?: string;
  logger?: (line: string) => void;
}

export interface CreateSiteDeps {
  resolveToken: typeof resolveToken;
  createPrivateRepo: typeof createPrivateRepo;
  runGit: typeof runGit;
  copyDir: typeof copyDir;
  removeDir: typeof removeDir;
  pathExists: typeof pathExists;
  mkdtemp: (prefix: string) => Promise<string>;
}

// Default dependency bundle — the real I/O implementations.
// Tests build their own bundle with fakes.
export const realDeps: CreateSiteDeps = {
  resolveToken,
  createPrivateRepo,
  runGit,
  copyDir,
  removeDir,
  pathExists,
  mkdtemp: (prefix) => fs.mkdtemp(prefix),
};

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

    // 3. Resolve token before any side effects
    log("→ Resolving GitHub token");
    const token = await deps.resolveToken();

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
      await deps.copyDir(templateSrc, targetDir);
    } finally {
      await deps.removeDir(tmpDir).catch(() => {
        /* best-effort cleanup */
      });
    }

    // 5. Initialize local repo + initial commit
    log("→ Initializing local git repo");
    await deps.runGit(["init", "-b", "main"], { cwd: targetDir });
    await deps.runGit(["add", "-A"], { cwd: targetDir });
    await deps.runGit(
      ["commit", "-m", "🩲 scaffold from hoi-poi shell-template"],
      { cwd: targetDir }
    );

    // 6. Create private GitHub repo (first external side effect)
    log(`→ Creating private GitHub repo ${siteName}`);
    const created: CreatedRepo = await deps.createPrivateRepo(token, siteName, {
      description:
        options.description ?? "Micro-frontend site scaffolded from hoi-poi",
      private: true,
    });

    // 7. Push. Embed token in the remote URL for the push only, then strip
    // it back to the clean URL so it doesn't end up in .git/config on disk
    // for subsequent pushes.
    log(`→ Pushing to ${created.htmlUrl}`);
    const authedUrl = created.cloneUrl.replace(
      "https://",
      `https://x-access-token:${token}@`
    );
    await deps.runGit(["remote", "add", "origin", authedUrl], {
      cwd: targetDir,
    });
    try {
      await deps.runGit(["push", "-u", "origin", "main"], { cwd: targetDir });
    } finally {
      // Always strip the token out of the remote URL, even on push failure.
      await deps
        .runGit(["remote", "set-url", "origin", created.cloneUrl], {
          cwd: targetDir,
        })
        .catch(() => {
          /* best-effort; don't mask original error */
        });
    }

    log(`✓ ${siteName} created at ${created.htmlUrl}`);
  };
}

// Default export — real implementation bound to real deps.
export const createSite = makeCreateSite(realDeps);
