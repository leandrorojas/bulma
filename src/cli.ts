#!/usr/bin/env node
import { VERSION } from "./version";

// Foundation-only CLI entry. Command parsing and implementations
// (e.g. `bulma create <site-name>`) land in subsequent PRs.
function main(argv: string[]): number {
  const [, , ...args] = argv;

  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  process.stdout.write(
    `bulma ${VERSION}\n` +
      "Build Ultra-Light Micro-Apps — CLI for the Hoi-Poi platform.\n" +
      "Commands are not yet implemented.\n"
  );
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

export { main };
