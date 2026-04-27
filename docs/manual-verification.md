---
name: Manual verification checklist
description: End-to-end smoke test for `bulma create` against real GitHub + Vercel
---

# Manual verification

Unit + integration tests in `src/**/*.test.ts` cover everything that can run hermetically. Some properties only show up in real cloud state — auto-deploy actually firing, secrets actually being set, the QA gate actually pausing the release pipeline. This checklist captures the smoke run we do by hand before merging risky changes to the create flow.

## Prerequisites (one-time setup)

Verify each of these before running the smoke test. If any are missing, the run will surface a clear error early — but it's faster to check first.

- [ ] `gh auth status` shows scopes: `repo`, `workflow`, `delete_repo`
- [ ] `vercel whoami` returns the expected account (`leandrorojas`)
- [ ] `VERCEL_TOKEN` env var is set (`echo "len=${#VERCEL_TOKEN}"` ≥ 60 chars)
- [ ] Vercel GitHub App installed with **All repositories** access:
      https://github.com/settings/installations
- [ ] `bulma` is built locally: `npm run build` in the bulma checkout

Optional:
- [ ] `BULMA_SONAR_TOKEN` set — needed only if you want the SonarQube workflow on the new site to actually run

## Smoke run

Use a disposable site name matching `^site-pr\d+$` so it's obvious which scaffolds are tests. Convention is `site-pr<PR-number>` for the PR that introduced the change being smoked.

```bash
# 0. Confirm clean preconditions on all three locations.
ls /tmp/site-prN
gh repo view leandrorojas/site-prN
curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v9/projects/site-prN" | head -c 80
# Expected: all three say "not found" / "no such file or directory".

# 1. Run create from /tmp so the new dir lands at /tmp/site-prN.
cd /tmp && node /Users/lrojas/code/personal/bulma/dist/cli.js create site-prN
```

Watch for these log lines (in order):

- `→ Resolving GitHub token`
- `→ Resolving Vercel token`
- `→ Resolving authenticated GitHub user`
- `→ Cloning https://github.com/leandrorojas/hoi-poi.git`
- `→ Scaffolding /private/tmp/site-prN`
- `→ Initializing local git repo`
- `→ Creating private GitHub repo site-prN`
- `⚠ BULMA_SONAR_TOKEN not set — ...` *(unless set)*
- `→ Creating production environment with QA approval gate`
- `⚠ Required-reviewer protection needs GitHub Pro/Team ...` *(expected on free-tier private repos)*
- `→ Pushing to https://github.com/leandrorojas/site-prN`
- `→ Verifying Vercel ↔ GitHub integration`
- `→ Creating Vercel project site-prN`
- `→ Triggering initial Vercel production deployment`
- `→ Waiting for first production deployment (up to 5 min)`
- `✓ site-prN created at https://github.com/leandrorojas/site-prN`
- `  Production: https://site-prN-<hash>.vercel.app`
- `  Previews: enabled per branch (Vercel auto)`

## Verify each location

```bash
# Local: site dir scaffolded with workflows + vercel.json
ls -la /tmp/site-prN/.github/workflows/
# Expected: code-quality.yml, integration-tests.yml, prerelease.yml, release.yml
cat /tmp/site-prN/vercel.json
# Expected: { buildCommand, outputDirectory, installCommand, framework: null }

# GitHub: repo exists, initial commit pushed, workflows present
gh api repos/leandrorojas/site-prN/contents/.github/workflows --jq '.[].name'
# Expected: 4 workflow files (same names as above)

# Vercel: project created, Node 20.x pinned, deployment reached READY
curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v9/projects/site-prN" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
    print('node:', d.get('nodeVersion'), \
          'production_branch:', d.get('link',{}).get('productionBranch'))"
# Expected: node: 20.x, production_branch: main
```

## Teardown

Manual teardown — three discrete commands by design (see PR comment thread on the deferred `bulma destroy` feature for rationale).

```bash
rm -rf /tmp/site-prN
gh repo delete leandrorojas/site-prN --yes
curl -s -X DELETE -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v9/projects/site-prN" \
  -o /dev/null -w "vercel: HTTP %{http_code}\n"
# Expected: vercel: HTTP 204
```

Verify all three are gone before considering teardown complete:

```bash
ls /tmp/site-prN 2>&1                      # No such file or directory
gh repo view leandrorojas/site-prN 2>&1     # Could not resolve
curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v9/projects/site-prN" | head -c 80
# Expected: {"error":{"code":"not_found",...}}
```

## When to run this

- Before merging any PR that touches `src/commands/create.ts`, `src/lib/github.ts`, or `src/lib/vercel.ts`
- Before bumping `commander`, `node:child_process`-touching deps, or the senzu submodule pointer
- After any `gh` CLI scope change (e.g., when adding a new required scope)
- Before announcing a stable release tag
