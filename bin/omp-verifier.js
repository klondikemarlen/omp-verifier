#!/usr/bin/env node

import { runCurrentAutomaticVerification } from "../omp-plugin/verifications.js";

const [command] = process.argv.slice(2);

if (command !== "automatic" || process.argv.length !== 3) {
  process.stderr.write("Usage: omp-verifier automatic\n");
  process.exitCode = 2;
} else {
  const results = await runCurrentAutomaticVerification({ cwd: process.cwd() });
  process.stdout.write(`${JSON.stringify(results)}\n`);
  process.exitCode = results.some(result => result.status === "FAIL" || result.status === "BLOCKED") ? 1 : 0;
}
