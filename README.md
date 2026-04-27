# Bulma 🩲

**B**uild **U**ltra-**L**ight **M**icro-**A**pps — a CLI scaffolding tool for the [Hoi-Poi](https://github.com/leandrorojas/hoi-poi) micro-frontend platform.

A single command turns "I want a new site" into a fully wired micro-frontend: private GitHub repo, GitHub Actions pipeline (CodeRabbit + SonarQube + integration tests + tag-driven release with a QA approval gate), Vercel project linked to the repo with Node 20.x pinned, and a production deployment ready to inspect — all from one command.

## Install

```bash
npm install -g @leandrorojas/bulma
```

Or run without installing:

```bash
npx @leandrorojas/bulma create my-site
```

Both paths require auth against GitHub Packages — a GitHub PAT with `read:packages` in `NODE_AUTH_TOKEN` or `~/.npmrc`.

## Prerequisites

Before the first `bulma create`, complete this one-time setup. `bulma --help` documents this list with full URLs.

| | What | Why |
|---|---|---|
| **gh CLI** | `gh auth login` with scopes `repo`, `workflow`, `delete_repo` | Repo creation, pushing files under `.github/workflows/`, and post-scaffold cleanup |
| **Vercel CLI** | `vercel login` (cache fallback) **or** `VERCEL_TOKEN` env var | API-driven project creation + deployment |
| **Vercel GitHub App** | Installed on your account with **All repositories** access ([install](https://vercel.com/integrations/github)) | So Vercel can link to repos `bulma` creates moments after they exist |

Optional environment:

| | What |
|---|---|
| `BULMA_SONAR_TOKEN` | Stored as the `SONAR_TOKEN` repo secret on each new site so the scaffolded SonarQube workflow runs out of the box |
| `VERCEL_TEAM_ID` | Scope all Vercel API calls to a team account (default: personal) |

## Usage

### `bulma create <site-name>`

The main command. Scaffolds a new micro-frontend site end-to-end:

```bash
bulma create my-site
```

Site names must be lowercase alphanumeric + dashes, ≤40 chars, not starting or ending with a dash. The site is created at `./<site-name>/` under your current working directory.

Flags:

| | |
|---|---|
| `-d, --description <text>` | Repo description (default: "Micro-frontend site scaffolded from hoi-poi") |
| `--skip-vercel` | Skip Vercel project setup. Useful for offline scaffolding or before Vercel is configured. |
| `--skip-actions` | Skip writing `.github/workflows/`, setting repo secrets, and pre-creating the production environment. Useful for repos that manage CI/CD outside bulma's pattern. |

Examples:

```bash
bulma create acme-store                       # full scaffold
bulma create acme-store --skip-vercel         # GitHub-only scaffold
bulma create acme-store -d "Customer-facing storefront"
```

### `bulma help [command]`

Print usage, prereqs, and examples.

```bash
bulma --help                  # top-level: prereqs + env vars + quick examples
bulma help create             # per-command: every flag with rationale
```

## What gets scaffolded

Running `bulma create my-site` produces:

**Local directory** `./my-site/` containing:

```
my-site/
├── .github/workflows/
│   ├── code-quality.yml       # CodeRabbit + Unit Tests + SonarQube quality gate
│   ├── integration-tests.yml  # Runs after Code Quality on main
│   ├── prerelease.yml         # Publishes <pkg>-build-<run> to GitHub Packages on every main push
│   └── release.yml            # Tag-driven publish, gated on `production` environment (QA approval)
├── src/                       # Hoi-poi shell-template (React + Webpack + Module Federation)
├── package.json
├── webpack.config.js
├── vercel.json                # Pinned build/output/install commands, framework: null
└── (initial git commit on `main` branch)
```

**Private GitHub repo** at `github.com/<your-username>/my-site` with:
- Initial commit pushed to `main`
- `SONAR_TOKEN` repo secret (if `BULMA_SONAR_TOKEN` was set)
- `production` environment with you as required reviewer (the QA gate). On free-tier private repos this falls back to no-protection; the workflow file still references the env so it works once your plan supports reviewers.

**Vercel project** `my-site` linked to the GitHub repo:
- Framework: `null` (custom Webpack build)
- Node 20.x pinned via `PATCH /v9/projects/{id}` after creation
- Initial production deployment triggered explicitly (Vercel doesn't auto-deploy on link, only on push events that happen after linking)
- Per-branch preview deployments on for free

The command exits successfully when the production deployment reaches `READY` (5-min timeout). On timeout you get the dashboard URL as a warning rather than a failure — the build keeps running.

## Next steps after scaffolding

```bash
cd my-site
npm install
npm run dev               # local dev server (port 3000)
```

When you're ready to ship:

1. **Push commits to `main`** — every push triggers `prerelease.yml`, publishing `<pkg>-build-<run_number>` to GitHub Packages and a Vercel production deploy.
2. **Tag a stable release** — `git tag v0.1.0 && git push origin v0.1.0` runs `release.yml`, which pauses at the `production` environment for QA approval before publishing the stable tag to GitHub Packages.
3. **Approve the QA gate** when prompted — go to the workflow run page on GitHub and click *Review pending deployments*. Once approved, the stable publish proceeds.
4. **Verify the consumer** — install the published version in any app that depends on this site:
   ```bash
   npm install @<your-username>/my-site@<version>
   ```

For the broader micro-frontend setup (component library, shell wiring, federation config), see [hoi-poi's README](https://github.com/leandrorojas/hoi-poi).

## Development

Working on bulma itself:

```bash
git clone --recurse-submodules git@github.com:leandrorojas/bulma.git
cd bulma
npm install
npm run build      # tsc → dist/
npm test           # 163 unit + integration tests, jest with coverage
npm run lint       # eslint
```

The repo includes a `senzu/` submodule (private, contains shared AI agent config). End users installing via `npm`/`npx` are unaffected — only contributors need it.

End-to-end smoke verification: see [`docs/manual-verification.md`](docs/manual-verification.md) for the full checklist (prereq audit, expected log output per step, per-location verification commands, teardown).

## Contributing

PRs follow the workflow in [`senzu/workflows/pr-workflow.md`](senzu/workflows/pr-workflow.md) — branching, CI gates, CodeRabbit handling, SonarQube troubleshooting, rate-limit recovery, merge criteria. Please read it before opening your first PR; it captures non-obvious patterns we've collected across 8+ PRs.

Coding standards:
- Zero new SonarQube issues on PR code
- No unresolved Critical / Major CodeRabbit findings on PR code
- Tests required for every module; integration test for any change to the create flow
- Trunk-based — single `main`, no long-lived branches

## License

MIT
