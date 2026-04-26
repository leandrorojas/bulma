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

## Contributing

This repo includes a private submodule (`senzu`) for shared AI agent config. Cloning bulma for development requires access to the [senzu repo](https://github.com/leandrorojas/senzu) and an SSH key configured against GitHub:

```bash
git clone --recurse-submodules git@github.com:leandrorojas/bulma.git
# or, after a regular clone:
git submodule update --init
```

End users installing via `npm` / `npx` are not affected — the submodule is only consumed by maintainers and contributors.

## License

MIT
