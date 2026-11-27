#!/usr/bin/env node
import { resolve } from "node:path";
import { Command, CommanderError } from "commander";

import { registerLifecycleCommands } from "#root/bin/lifecycle-commands.js";
import { registerSemanticCommands } from "#root/bin/semantic-commands.js";
import { registerVerificationCommands } from "#root/bin/verification-commands.js";
import { InvalidSemanticRequestFilename } from "#root/omp-plugin/semantic-evaluations.js";

const program = new Command()
  .name("omp-verifier")
  .description("Run declared verification checks and manage their evidence")
  .showHelpAfterError()
  .exitOverride();

registerVerificationCommands(program);
registerSemanticCommands(program);
registerLifecycleCommands(program);

// The fresh session owns an existing review, not another coordinator run.
program.hook("preAction", (_program, command) => {
  const boundRequest = process.env.OMP_VERIFIER_FRESH_REVIEWER;
  if (!boundRequest) return;

  const options = command.opts();
  if (!["review", "evaluate", "diagnostics"].includes(command.name())
    || resolve(command.args[0] ?? "") !== boundRequest
    || options.continue || options.request || options.maxContextPaths !== undefined
    || options.context?.length || options.callerContext?.length || options.externalContext?.length
    || options.removeContext?.length) {
    throw new Error("Fresh reviewer may only inspect or evaluate its handed-off request; return to the owning session for renewal");
  }
});

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  } else {
    process.stderr.write(`${error.message}\n`);
    if (error instanceof InvalidSemanticRequestFilename) {
      process.stderr.write("Retry the last page footer's exact Next command, or copy the complete request path from the coordinator's response.\n");
    }
    process.exitCode = 2;
  }
}
