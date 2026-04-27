// Help-text appended after Commander's auto-generated usage. Kept as plain
// string constants so they can be unit-tested without invoking the CLI
// (Commander's --help calls process.exit, which is awkward in jest).

export const TOP_LEVEL_HELP = `
Examples:
  $ bulma create my-site
  $ bulma create my-site --skip-vercel
  $ bulma create my-site -d "Marketing landing page"
  $ bulma help create

Prerequisites:
  GitHub  gh CLI authenticated (\`gh auth status\`) with the scopes:
            repo, workflow, delete_repo
  Vercel  VERCEL_TOKEN env var (or \`vercel login\` so the CLI cache works as
            a fallback). Vercel GitHub App must be installed on your account
            with All repositories access:
            https://vercel.com/integrations/github

Optional environment:
  BULMA_SONAR_TOKEN   stored as the SONAR_TOKEN repo secret on each new
                      site so the SonarQube workflow runs out of the box
  VERCEL_TEAM_ID      scope all Vercel API calls to a team account
                      (default: personal account)

Run \`bulma help <command>\` for command-specific usage.
`;

export const CREATE_HELP = `
Examples:
  $ bulma create my-site
      Full scaffold: GitHub repo + initial commit with workflows +
      production environment + Vercel project + initial deployment.

  $ bulma create my-site --skip-vercel
      Skip Vercel project setup (no vercel.json, no API calls).
      Useful for offline scaffolding or when Vercel isn't set up yet.

  $ bulma create my-site --skip-actions
      Skip writing .github/workflows/, setting repo secrets, and
      pre-creating the production environment. Useful for repos that
      manage their CI/CD outside of bulma's pattern.

  $ bulma create my-site -d "Customer-facing storefront"
      Set the GitHub repo description.

The site is created under the current working directory:
  $ cd ~/code/personal && bulma create acme-store
      → ~/code/personal/acme-store/
`;
