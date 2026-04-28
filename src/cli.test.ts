import { Command } from "commander";
import { buildProgram } from "./cli";

// Walks the command tree, replacing the default process.exit / stdio
// behavior with throw-on-error and silent output. Each Commander subcommand
// has its own callbacks, so the parent's `exitOverride` doesn't propagate
// — we have to apply per-command.
function silenceAndOverride(program: Command): Command {
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  for (const sub of program.commands) {
    silenceAndOverride(sub);
  }
  return program;
}

function testProgram() {
  return silenceAndOverride(buildProgram());
}

describe("bulma CLI — Commander integration", () => {
  it("rejects excess positional arguments on `create` (commander v13+ behavior)", async () => {
    // Commander 13 changed the default for `allowExcessArguments` from true
    // to false. With the previous default, `bulma create my-site oops` would
    // silently ignore `oops`. Now Commander throws — which is the better
    // behavior (catches typos), and we want a regression net so future
    // dependency bumps or our own option changes don't accidentally
    // re-enable the silent-ignore behavior.
    const program = testProgram();
    await expect(
      program.parseAsync(["create", "my-site", "extra-arg"], { from: "user" })
    ).rejects.toMatchObject({
      code: "commander.excessArguments",
    });
  });

  it("rejects unknown options on `create`", async () => {
    const program = testProgram();
    await expect(
      program.parseAsync(["create", "my-site", "--bogus-flag"], { from: "user" })
    ).rejects.toMatchObject({
      code: "commander.unknownOption",
    });
  });

  it("requires the <site-name> argument", async () => {
    const program = testProgram();
    await expect(program.parseAsync(["create"], { from: "user" })).rejects.toMatchObject({
      code: "commander.missingArgument",
    });
  });
});
