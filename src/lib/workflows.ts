// Generates GitHub Actions workflow files for scaffolded sites. Mirrors the
// pattern used by bulma + hoi-poi: code-quality (CodeRabbit + Unit Tests +
// SonarQube) → integration-tests (gated on code-quality) → prerelease (every
// main push) → release (tag-triggered, gated on a `production` environment
// with required reviewers — the QA approval gate).

const CODE_QUALITY_YML = `name: Code Quality

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  coderabbit:
    name: CodeRabbit Review
    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: CodeRabbit AI Review
        uses: coderabbitai/ai-pr-reviewer@v1
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          CODERABBIT_API_KEY: \${{ secrets.CODERABBIT_API_KEY }}

  unit-tests:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: |
          if node -e "const p = require('./package.json'); process.exit(p.scripts && p.scripts.lint ? 0 : 1)"; then
            npm run lint
          else
            echo "::warning::No lint script — skipping"
          fi

      - name: Build
        run: npm run build

      - name: Run tests with coverage
        run: npm test -- --coverage

      - name: Upload coverage artifact
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: coverage/lcov.info
          if-no-files-found: warn

  sonarqube:
    name: SonarQube Analysis
    needs: [unit-tests]
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Download coverage artifact
        uses: actions/download-artifact@v4
        with:
          name: coverage-report
          path: coverage
        continue-on-error: true

      - name: SonarQube Scan
        uses: SonarSource/sonarqube-scan-action@v6
        env:
          SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}
          SONAR_HOST_URL: \${{ secrets.SONAR_HOST_URL }}

      - name: SonarQube Quality Gate
        uses: SonarSource/sonarqube-quality-gate-action@v1
        timeout-minutes: 10
        env:
          SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}
`;

const INTEGRATION_TESTS_YML = `name: Integration Tests

on:
  workflow_run:
    workflows: ["Code Quality"]
    types: [completed]
    branches: [main]

concurrency:
  group: integration-tests-\${{ github.event.workflow_run.head_branch }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  integration-tests:
    name: Run Integration Tests
    runs-on: ubuntu-latest
    if: github.event.workflow_run.conclusion == 'success'
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: \${{ github.event.workflow_run.head_sha }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Run integration tests
        run: |
          if node -e "const p = require('./package.json'); process.exit(p.scripts && p.scripts['test:integration'] ? 0 : 1)"; then
            npm run test:integration
          else
            echo "::warning::No test:integration script found in package.json — skipping"
          fi
`;

const PRERELEASE_YML = `name: Prerelease

on:
  push:
    branches: [main]

concurrency:
  group: prerelease-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
  packages: write

jobs:
  publish-prerelease:
    name: Publish Prerelease
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://npm.pkg.github.com
          scope: "@leandrorojas"

      - name: Install dependencies
        run: npm ci

      - name: Set prerelease version
        run: |
          BASE_VERSION=$(node -p "require('./package.json').version")
          npm version \${BASE_VERSION}-build-\${{ github.run_number }} --no-git-tag-version

      - name: Publish prerelease
        run: npm publish --tag prerelease
        env:
          NODE_AUTH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

// Stable release publishes ONLY after the QA approval gate clears. The
// `environment: production` line ties this job to a GitHub Environment that
// must be configured with required reviewers (bulma sets that up at scaffold
// time via the Environments API).
const RELEASE_YML = `name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: read
  packages: write

jobs:
  qa-approval:
    name: QA Approval
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Approval recorded
        run: echo "QA approval granted — proceeding to publish"

  publish-release:
    name: Publish Release
    needs: [qa-approval]
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://npm.pkg.github.com
          scope: "@leandrorojas"

      - name: Verify tag matches package version
        run: |
          TAG_VERSION="\${GITHUB_REF_NAME#v}"
          PKG_VERSION=$(node -p "require('./package.json').version")
          if [ "$TAG_VERSION" != "$PKG_VERSION" ]; then
            echo "Tag version ($TAG_VERSION) does not match package.json version ($PKG_VERSION)"
            exit 1
          fi

      - name: Install dependencies
        run: npm ci

      - name: Publish release
        run: npm publish
        env:
          NODE_AUTH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

export interface WorkflowFile {
  /** Path relative to the site root, e.g. ".github/workflows/code-quality.yml" */
  path: string;
  content: string;
}

export const WORKFLOW_FILES: readonly WorkflowFile[] = Object.freeze([
  { path: ".github/workflows/code-quality.yml", content: CODE_QUALITY_YML },
  { path: ".github/workflows/integration-tests.yml", content: INTEGRATION_TESTS_YML },
  { path: ".github/workflows/prerelease.yml", content: PRERELEASE_YML },
  { path: ".github/workflows/release.yml", content: RELEASE_YML },
]);
