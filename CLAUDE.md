# Bulma

Build Ultra-Light Micro-Apps — a CLI scaffolding tool for the Hoi-Poi micro-frontend platform.

## Agent configuration

This project uses [senzu](https://github.com/leandrorojas/senzu) as a shared AI config submodule. Cross-project workflows and rules live there.

### PR Workflow

Follow @senzu/workflows/pr-workflow.md for the full PR lifecycle on every PR.

### Keeping senzu up to date

The submodule is pinned to a specific commit. To pull the latest senzu changes: `git submodule update --remote senzu`, then commit the updated pointer.

## Repo Structure

- `src/` — TypeScript source (CLI entry, commands, lib modules)
- `src/commands/` — CLI command implementations (co-located tests)
- `src/lib/` — Shared utilities: auth, git, github API, fs helpers
- `dist/` — Compiled JS output (not committed)

## Architecture Decisions

- **Node.js + TypeScript** — matches the hoi-poi ecosystem
- **Trunk-based development** — single `main` branch, PR-based workflow
- **Published to GitHub Packages** as `@leandrorojas/bulma`
- **Tests are co-located** next to the code they test
- **Dependency injection** for I/O seams (no jest.mock needed)

## Coding Standards

- Zero SonarQube issues on PR code before merging
- No unresolved critical or major CodeRabbit findings on PR code before merging
- Unit tests required for all modules
