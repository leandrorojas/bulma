#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "./version";
import { createSite } from "./commands/create";

export async function main(argv: string[]): Promise<number> {
  const program = new Command();

  program
    .name("bulma")
    .description("Build Ultra-Light Micro-Apps — CLI for the Hoi-Poi platform")
    .version(VERSION);

  program
    .command("create <site-name>")
    .description("Scaffold a new micro-frontend site from the hoi-poi shell-template")
    .option("-d, --description <text>", "Repo description")
    .action(async (siteName: string, options: { description?: string }) => {
      try {
        await createSite(siteName, options);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exitCode = 1;
      }
    });

  await program.parseAsync(argv);
  return Number(process.exitCode ?? 0);
}

if (require.main === module) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(
        `Fatal: ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    });
}
