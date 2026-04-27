# Contributing to bulma

Thanks for considering a contribution. This doc covers the practicalities; the design context lives in [README.md](README.md).

## Cloning

bulma includes a private submodule (`senzu/`) for shared AI-agent config. End users installing via `npm` / `npx` are unaffected — only contributors need it.

```bash
git clone --recurse-submodules git@github.com:leandrorojas/bulma.git
cd bulma
npm install
```

If you forgot `--recurse-submodules`, run `git submodule update --init` after the clone.

## Local checks

Before pushing:

```bash
npm test            # 158+ unit + integration tests, jest with coverage
npm run lint        # eslint
npm run build       # tsc → dist/
npm run format:check  # prettier (read-only)
```

`npm run format` writes prettier changes; the pre-commit hook (husky + lint-staged) runs `eslint --fix` and `prettier --write` on staged files automatically, so most contributors won't need to invoke these manually.

If you touch the create flow (`src/commands/create.ts`, `src/lib/github.ts`, `src/lib/vercel.ts`), also follow the manual smoke-test checklist in [`docs/manual-verification.md`](docs/manual-verification.md) before opening the PR.

## PR workflow

The PR lifecycle — branching, CI gates, CodeRabbit handling, SonarQube troubleshooting, rate-limit recovery, merge criteria — lives in the senzu submodule:

[`senzu/workflows/pr-workflow.md`](senzu/workflows/pr-workflow.md)

Read it before your first PR. It captures non-obvious patterns (CodeRabbit's incremental review behavior, the empty-commit force-trigger, `tssecurity` sanitization shapes Sonar recognizes) collected across many PRs.

### Quick start

```bash
git checkout main && git pull
git checkout -b feat/your-change
# ... make changes ...
git add <specific files>      # avoid `git add .` — keeps stray .env / .DS_Store out
git commit -m "feat: short, present-tense description"
git push -u origin feat/your-change
gh pr create --title "..." --body "..."
```

The PR template (`.github/PULL_REQUEST_TEMPLATE.md`) drives the `## Summary` + `## Test plan` format that maps directly to the senzu workflow's merge criteria.

## Coding standards

- **Zero new SonarQube issues** on PR code (CI gate)
- **No unresolved Critical or Major CodeRabbit findings** on PR code
- **Tests required** for every module; integration test for any change to the create flow
- **Trunk-based** — single `main`, no long-lived branches
- **Tests live next to the code they exercise** (`foo.ts` + `foo.test.ts`)
- **Dependency injection over `jest.mock`** — every external boundary takes a `Deps` interface so tests can swap real implementations for fakes deterministically

## Commits

- Conventional Commits prefix where it fits: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`
- Subject line under 70 chars; reasoning goes in the body
- Co-authored-by footer when an AI agent assisted

```
feat: short subject

Longer explanation focused on the *why*. Diff is self-documenting on
the *what*.

Co-Authored-By: ...
```

## Reviewing

CodeRabbit reviews automatically on PR creation and after each push. When it leaves Critical / Major findings:

1. Read each finding against the actual code (CodeRabbit occasionally flags false positives — verify before fixing)
2. Batch fixes into **one** commit to avoid hitting the hourly review rate limit
3. After pushing, resolve the addressed threads via the GitHub UI (or the GraphQL `resolveReviewThread` mutation)
4. Wait for CodeRabbit's incremental re-review — it confirms via the summary comment ("No actionable comments were generated") even when it doesn't post a fresh review-with-state

## Releasing

Maintainers only. Pushes to `main` auto-publish a prerelease (`<version>-build-<run_number>`) to GitHub Packages. Stable releases are tag-driven:

```bash
# Bump version in package.json, commit, then:
git tag v0.x.y
git push origin v0.x.y
```

The `release.yml` workflow verifies the tag matches `package.json`, pauses at the `production` environment for QA approval, then publishes.
