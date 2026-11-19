import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";

import { activateGeneration, installRuntime, prepareGeneration, runtimePaths } from "#root/omp-plugin/runtime-generations.js";
import { activeGeneration, generationDirectory, withRuntimeLock } from "#root/bin/omp-verifier-runtime.mjs";

const execute = promisify(execFile);

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function provider(root, version) {
  const directory = join(root, "plugins", "node_modules", "probe-provider");
  await writeJson(join(directory, "package.json"), {
    name: "probe-provider",
    version,
    type: "module",
    dependencies: {
      "probe-dependency": version,
    },
    omp: {
      extensions: ["./index.js"],
      verifications: [
        {
          id: "probe:version",
          label: "Version",
          description: "Read the pinned executable dependency after a controlled wait",
          entry: "./version.mjs",
        },
        {
          id: "probe:semantic",
          label: "Positive value",
          description: "Review the supplied value standard",
          mode: "agentic",
          contract: "./contract.json",
        },
      ],
    },
  });
  await writeFile(join(directory, "version.mjs"), `import { access, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
if (process.env.PROBE_GATE) {
  await writeFile(process.env.PROBE_READY, 'ready');
  for (;;) {
    try { await access(process.env.PROBE_GATE); break; }
    catch { await setTimeout(10); }
  }
}
const { version } = await import('probe-dependency');
process.stdout.write(JSON.stringify({status: 'PASS', summary: version}));
`);
  await writeFile(join(directory, "standard.md"), "# Value\nThe exported value must be positive.\n");
  await writeJson(join(directory, "contract.json"), {
    version: 1,
    standardId: "probe:semantic",
    source: "./standard.md",
    gold: "The exported value is positive",
    requiredContext: ["changed-code"],
    rubric: [
      {
        id: "positive",
        question: "Is the value positive?",
      },
    ],
  });
  const dependency = join(root, "plugins", "node_modules", "probe-dependency");
  await writeJson(join(dependency, "package.json"), {
    name: "probe-dependency",
    version,
    type: "module",
    main: "./index.js",
  });
  await writeFile(join(dependency, "index.js"), `export const version = ${JSON.stringify(version)};\n`);
  return directory;
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "omp-generations-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  await mkdir(join(project, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  await writeFile(join(project, "src", "value.js"), "export const value = 1;\n");
  const providerPath = await provider(root, "1.0.0");
  const initial = await installRuntime(agentDir);
  const paths = runtimePaths(agentDir);
  async function cli(args, extraEnvironment = {}) {
    const environment = {
      ...process.env,
      ...extraEnvironment,
    };
    const result = await execute(process.execPath, [paths.launcher, ...args], {
      cwd: project,
      env: environment,
      timeout: 30_000,
      maxBuffer: 2_000_000,
    });
    return result.stdout;
  }
  async function replacement() {
    await provider(root, "2.0.0");
    return prepareGeneration({ agentDir });
  }
  return {
    root,
    agentDir,
    project,
    providerPath,
    paths,
    initial,
    cli,
    replacement,
  };
}

async function ready(path) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (error.code !== "ENOENT" || Date.now() >= deadline) throw error;
      await setTimeout(10);
    }
  }
}

test("when a replacement activates during two checks, both retain their original provider dependencies", async context => {
  // Arrange
  const current = await fixture(context);
  const gate = join(current.root, "continue");
  const firstReady = join(current.root, "first-ready");
  const secondReady = join(current.root, "second-ready");
  const first = current.cli(["verify", "probe:version"], {
    PROBE_GATE: gate,
    PROBE_READY: firstReady,
  });
  const second = current.cli(["verify", "probe:version"], {
    PROBE_GATE: gate,
    PROBE_READY: secondReady,
  });
  await Promise.all([ready(firstReady), ready(secondReady)]);

  // Act
  const candidate = await current.replacement();
  await activateGeneration(candidate.id, { agentDir: current.agentDir });
  await rm(join(current.root, "plugins"), { recursive: true });
  await writeFile(gate, "continue");
  const results = await Promise.all([first, second]);
  const versions = results.map(output => JSON.parse(output)[0].summary);

  // Assert
  assert.deepEqual(versions, ["1.0.0", "1.0.0"]);
});

test("when a replacement activates, the same launcher adopts it for subsequent work", async context => {
  // Arrange
  const current = await fixture(context);
  await current.cli(["verify", "probe:version"]);
  const candidate = await current.replacement();

  // Act
  await activateGeneration(candidate.id, { agentDir: current.agentDir });
  const results = JSON.parse(await current.cli(["verify", "probe:version"]));

  // Assert
  assert.equal(results[0].summary, "2.0.0");
  assert.equal(results[0].generation.id, candidate.id);
});

test("when semantic command help is requested, the launcher does not require a review identity", async context => {
  // Arrange
  const current = await fixture(context);

  // Act / Assert
  for (const command of ["review", "evaluate", "diagnostics"]) {
    for (const flag of ["--help", "-h"]) {
      const output = await current.cli([command, flag]);
      assert.match(output, new RegExp(`Usage: omp-verifier ${command}`));
    }
  }
});

test("when installation refreshes an obsolete launcher, command help works without replacing its active generation", async context => {
  // Arrange
  const current = await fixture(context);
  await writeFile(current.paths.launcher, "process.exit(42);\n");

  // Act
  const installed = await installRuntime(current.agentDir);
  const output = await current.cli(["review", "--help"]);

  // Assert
  assert.match(output, /Usage: omp-verifier review/);
  assert.equal(installed.id, current.initial.id);
});

test("when a replacement activates during semantic review, evaluation and reporting retain the original standard", async context => {
  // Arrange
  const current = await fixture(context);
  const prepared = JSON.parse(await current.cli(["verify", "probe:semantic"]));
  const request = prepared[0].reviewRequest;
  const candidate = await current.replacement();
  await activateGeneration(candidate.id, { agentDir: current.agentDir });
  await rm(join(current.root, "plugins"), { recursive: true });
  const page = await current.cli(["review", request.path, "--reporter", "text"]);
  const pageCount = Number(page.match(/Page index: 0 of (\d+)/)[1]);
  for (let index = 1; index < pageCount; index++) {
    await current.cli(["review", request.path, "--reporter", "text", "--page", String(index)]);
  }
  const assessment = {
    requestId: request.requestId,
    status: "PASS",
    summary: "The value is positive",
    rationale: "The complete source exports one positive value",
    citations: [
      {
        path: "src/value.js",
        line: 1,
        quote: "export const value = 1;",
      },
    ],
  };

  // Act
  const result = JSON.parse(await current.cli(["evaluate", request.path, "--assessment", JSON.stringify(assessment)]))[0];
  const reported = JSON.parse(await current.cli(["review", request.path]))[0];

  // Assert
  assert.equal(result.status, "PASS");
  assert.equal(result.generation.id, current.initial.id);
  assert.equal(reported.status, "PASS");
});

test("when candidate contents change after preparation, activation preserves the working generation", async context => {
  // Arrange
  const current = await fixture(context);
  const candidate = await current.replacement();
  const directory = generationDirectory(current.paths.root, candidate.id);
  await writeFile(join(directory, "node_modules", "probe-provider", "version.mjs"), "throw Error('broken');\n");

  // Act
  let failure;
  try {
    await activateGeneration(candidate.id, { agentDir: current.agentDir });
  } catch (error) {
    failure = error.message;
  }
  const result = JSON.parse(await current.cli(["verify", "probe:version"]))[0];

  // Assert
  assert.equal(failure, "Generation artifacts changed after preparation");
  assert.equal(result.summary, "1.0.0");
  assert.equal(result.generation.id, current.initial.id);
});

test("when the activation lock owner is interrupted, the working generation remains usable", async context => {
  // Arrange
  const current = await fixture(context);
  const module = import.meta.resolve("#root/bin/omp-verifier-runtime.mjs");
  const script = `import { withRuntimeLock } from ${JSON.stringify(module)};
await withRuntimeLock(${JSON.stringify(current.paths.root)}, async () => {
  console.log('locked');
  await new Promise(() => setInterval(() => {}, 1000));
});`;
  const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", script]);
  context.after(() => process.kill("SIGKILL"));
  await once(process.stdout, "data");

  // Act
  process.kill("SIGKILL");
  await once(process, "exit");
  const result = JSON.parse(await current.cli(["verify", "probe:version"]))[0];

  // Assert
  assert.equal(result.summary, "1.0.0");
});

test("when finished generations are collected, the active artifact remains available", async context => {
  // Arrange
  const current = await fixture(context);
  const candidate = await current.replacement();

  // Act
  await activateGeneration(candidate.id, { agentDir: current.agentDir });
  await current.cli(["generation", "collect"]);
  const old = generationDirectory(current.paths.root, current.initial.id);
  let removed = false;
  try {
    await readFile(join(old, "generation.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    removed = true;
  }
  const active = await withRuntimeLock(current.paths.root, () => activeGeneration(current.paths.root));

  // Assert
  assert.equal(removed, true);
  assert.equal(active.id, candidate.id);
});
