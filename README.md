# Bulma 🩲

**B**uild **U**ltra-**L**ight **M**icro-**A**pps — a CLI scaffolding tool for the [Hoi-Poi](https://github.com/leandrorojas/hoi-poi) micro-frontend platform.

## What it does

```bash
npx @leandrorojas/bulma create <site-name>
```

When invoked, `bulma create` will:

1. Create a new private GitHub repo with the given site name
2. Clone the shell template from [Hoi-Poi](https://github.com/leandrorojas/hoi-poi)
3. Push the scaffolded code to the new GitHub repo
4. Create a Vercel project connected to the new repo
5. Generate GitHub Actions workflow files in the new site repo

> ⚠️ **Status:** foundation only — command implementation lands in subsequent PRs.

## Install

```bash
npm install -g @leandrorojas/bulma
```

Or run without installing:

```bash
npx @leandrorojas/bulma create my-site
```

Both paths require auth against GitHub Packages (a GitHub PAT with `read:packages` in `NODE_AUTH_TOKEN` or `.npmrc`).

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
