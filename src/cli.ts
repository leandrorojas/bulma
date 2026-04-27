#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "./version";
import { createSite } from "./commands/create";
import { TOP_LEVEL_HELP, CREATE_HELP } from "./help";

// Constructs the Commander program. Extracted so tests can build the same
// program shape and exercise it with `exitOverride()` + a synthetic argv,
// without main()'s side effects (process.exitCode, process.exit, etc.).
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("bulma")
    .description("Build Ultra-Light Micro-Apps — CLI for the Hoi-Poi platform")
    .version(VERSION)
    .addHelpText("after", TOP_LEVEL_HELP);

  program
    .command("create <site-name>")
    .description("Scaffold a new micro-frontend site from the hoi-poi shell-template")
    .option("-d, --description <text>", "Repo description")
    .option("--skip-vercel", "Skip Vercel project setup (offline / dev only)")
    .option(
      "--skip-actions",
      "Skip generating GitHub Actions workflows + repo secrets + production environment"
    )
    .addHelpText("after", CREATE_HELP)
    .action(
      async (
        siteName: string,
        options: {
          description?: string;
          skipVercel?: boolean;
          skipActions?: boolean;
        }
      ) => {
        try {
          await createSite(siteName, options);
        } catch (err) {
          process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exitCode = 1;
        }
      }
    );

  return program;
}

export async function main(argv: string[]): Promise<number> {
  const program = buildProgram();
  await program.parseAsync(argv);
  return Number(process.exitCode ?? 0);
}

if (require.main === module) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
