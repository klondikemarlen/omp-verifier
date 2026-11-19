#!/usr/bin/env node
import { Command, CommanderError } from "commander";

import { registerLifecycleCommands } from "#root/bin/lifecycle-commands.js";
import { registerSemanticCommands } from "#root/bin/semantic-commands.js";
import { registerVerificationCommands } from "#root/bin/verification-commands.js";

const program = new Command()
  .name("omp-verifier")
  .description("Run declared verification checks and manage their evidence")
  .showHelpAfterError()
  .exitOverride();

registerVerificationCommands(program);
registerSemanticCommands(program);
registerLifecycleCommands(program);

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  } else {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
