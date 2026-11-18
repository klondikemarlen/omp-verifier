#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

import { installGlobalVerifier } from "#root/omp-plugin/global-verifier.js";
import { installRuntime, runtimePaths } from "#root/omp-plugin/runtime-generations.js";

const paths = runtimePaths();
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const environment = {
  ...process.env,
  OMP_VERIFIER_UPGRADE: "1",
};

// Preserve a complete generation before the package manager removes any files.
await installRuntime();
for (const args of [
  ["plugin", "uninstall", "omp-verifier"],
  ["plugin", "install", `github:klondikemarlen/omp-verifier#${revision}`],
]) {
  const result = spawnSync("omp", args, {
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Package replacement failed; the previous verifier generation remains active");
}

const coordinator = join(paths.packageDirectory, "omp-verifier", "bin", "omp-verifier.js");
const preparedOutput = execFileSync(process.execPath, [coordinator, "generation", "prepare"], {
  encoding: "utf8",
  maxBuffer: 1_000_000,
});
const prepared = JSON.parse(preparedOutput);
const activation = execFileSync(process.execPath, [coordinator, "generation", "activate", prepared.id], {
  encoding: "utf8",
  maxBuffer: 1_000_000,
});
await installGlobalVerifier({});
process.stdout.write(activation);
