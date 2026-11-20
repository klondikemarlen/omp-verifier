import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";

import { activeGeneration, generationDirectory, withRuntimeLock } from "#root/bin/omp-verifier-runtime.mjs";

import { activateGeneration, installRuntime, prepareGeneration, runtimePaths } from "#root/omp-plugin/runtime-generations.js";

const execute = promisify(execFile);

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function provider(root, version, verificationDependencies) {
  const packages = join(root, "plugins", "node_modules");
  const directory = join(packages, "probe-provider");
  await writeJson(join(directory, "package.json"), {
    name: "probe-provider",
    version,
    type: "module",
    main: "./index.js",
    dependencies: {
      "probe-dependency": version,
      "probe-unused": version,
    },
    optionalDependencies: {
      "probe-optional": version,
    },
    omp: {
      extensions: ["./index.js"],
      verificationDependencies,
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
  await writeFile(join(directory, "runtime-dependency.txt"), "probe-dependency\n");
  await writeFile(join(directory, "index.js"), `import { readFile } from 'node:fs/promises';
export async function capturedVersion() {
  const dependencyName = (await readFile(new URL('./runtime-dependency.txt', import.meta.url), 'utf8')).trim();
  const { version } = await import(dependencyName);
  return version;
}
`);
  await writeFile(join(directory, "version.mjs"), `import { access, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { capturedVersion } from './index.js';
if (process.env.PROBE_GATE) {
  await writeFile(process.env.PROBE_READY, 'ready');
  for (;;) {
    try { await access(process.env.PROBE_GATE); break; }
    catch { await setTimeout(10); }
  }
}
const version = await capturedVersion();
process.stdout.write(JSON.stringify({
  status: 'PASS',
  summary: version,
}));
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
  const dependency = join(packages, "probe-dependency");
  await writeJson(join(dependency, "package.json"), {
    name: "probe-dependency",
    version,
    type: "module",
    main: "./index.js",
    peerDependencies: {
      "probe-transitive": version,
    },
  });
  await writeFile(join(dependency, "index.js"), "export { version } from 'probe-transitive';\n");

  const transitive = join(packages, "probe-transitive");
  await writeJson(join(transitive, "package.json"), {
    name: "probe-transitive",
    version,
    type: "module",
    main: "./index.js",
  });
  await writeFile(join(transitive, "index.js"), `export const version = ${JSON.stringify(version)};\n`);

  const unused = join(packages, "probe-unused");
  await writeJson(join(unused, "package.json"), {
    name: "probe-unused",
    version,
    peerDependencies: {
      "probe-provider": version,
    },
  });

  return directory;
}

async function fixture(context, { verificationDependencies } = {}) {
  const root = await mkdtemp(join(tmpdir(), "omp-generations-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  await mkdir(join(project, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  await writeFile(join(project, "src", "value.js"), "export const value = 1;\n");
  const providerPath = await provider(root, "1.0.0", verificationDependencies);
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
    await rm(join(root, "plugins"), {
      recursive: true,
    });
    await provider(root, "2.0.0", verificationDependencies);
    return prepareGeneration({
      agentDir,
    });
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

test("when a provider is reinstalled during two checks, both retain their original dynamic dependencies", async context => {
  // Arrange
  const current = await fixture(context, {
    verificationDependencies: ["probe-dependency"],
  });
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

test("when a provider is reinstalled, its checks use only the selected dependency graph", async context => {
  // Arrange
  const current = await fixture(context, {
    verificationDependencies: ["probe-dependency", "probe-optional"],
  });
  await current.cli(["verify", "probe:version"]);
  const candidate = await current.replacement();

  // Act
  await activateGeneration(candidate.id, {
    agentDir: current.agentDir,
  });
  await rm(join(current.root, "plugins"), {
    recursive: true,
  });
  const results = JSON.parse(await current.cli(["verify", "probe:version"]));
  const directory = generationDirectory(current.paths.root, candidate.id);
  const dependencies = join(directory, "node_modules", "probe-provider", "node_modules");
  const snapshots = join(directory, "packages");
  const packageIds = await readdir(snapshots);
  const capturedPackages = await Promise.all(packageIds.map(async id => {
    const contents = await readFile(join(snapshots, id, "package.json"), "utf8");
    return JSON.parse(contents).name;
  }));

  // Assert
  assert.equal(results[0].summary, "2.0.0");
  assert.equal(results[0].generation.id, candidate.id);
  assert.equal(capturedPackages.includes("probe-unused"), false);
  await assert.rejects(lstat(join(dependencies, "probe-optional")), {
    code: "ENOENT",
  });
});

test("when a provider omits dependency selection, its unused runtime dependency is still captured", async context => {
  // Arrange
  const current = await fixture(context);

  const directory = generationDirectory(current.paths.root, current.initial.id);
  const unusedManifest = join(directory, "node_modules", "probe-provider", "node_modules", "probe-unused", "package.json");
  // Act
  const manifest = JSON.parse(await readFile(unusedManifest, "utf8"));

  // Assert
  assert.equal(manifest.name, "probe-unused");
});

test("when an opted-in provider is also a dependency, its consumer can use the full dependency graph", async context => {
  // Arrange
  const current = await fixture(context, {
    verificationDependencies: [],
  });
  const plugins = join(current.root, "plugins");
  const consumer = join(plugins, "node_modules", "probe-consumer");
  await writeJson(join(consumer, "package.json"), {
    name: "probe-consumer",
    version: "1.0.0",
    type: "module",
    peerDependencies: {
      "probe-provider": "1.0.0",
    },
    omp: {
      extensions: ["./index.mjs"],
      verificationDependencies: ["probe-provider"],
      verifications: [
        {
          id: "probe:consumer",
          label: "Consumer version",
          description: "Read a version through another provider's runtime dependencies",
          entry: "./index.mjs",
        },
      ],
    },
  });
  await writeFile(join(consumer, "index.mjs"), `import { capturedVersion } from 'probe-provider';
const version = await capturedVersion();
process.stdout.write(JSON.stringify({
  status: 'PASS',
  summary: version,
}));
`);
  await writeJson(join(plugins, "package.json"), {
    name: "omp-plugins",
    dependencies: {
      "probe-provider": "1.0.0",
      "probe-consumer": "1.0.0",
    },
  });

  // Act
  const candidate = await prepareGeneration({
    agentDir: current.agentDir,
  });
  await activateGeneration(candidate.id, {
    agentDir: current.agentDir,
  });
  await rm(plugins, {
    recursive: true,
  });
  const results = JSON.parse(await current.cli(["verify", "probe:consumer"]));

  // Assert
  const initialDirectory = generationDirectory(current.paths.root, current.initial.id);
  await assert.rejects(lstat(join(initialDirectory, "node_modules", "probe-provider", "node_modules", "probe-dependency")), {
    code: "ENOENT",
  });
  assert.equal(results[0].summary, "1.0.0");

  const candidateDirectory = generationDirectory(current.paths.root, candidate.id);
  const consumerProvider = join(candidateDirectory, "node_modules", "probe-consumer", "node_modules", "probe-provider");
  const cyclicProvider = join(consumerProvider, "node_modules", "probe-unused", "node_modules", "probe-provider");
  const cyclicManifest = JSON.parse(await readFile(join(cyclicProvider, "package.json"), "utf8"));
  assert.equal(cyclicManifest.name, "probe-provider");
});

test("when provider dependency selection is invalid, generation preparation rejects it", async context => {
  // Arrange
  const current = await fixture(context);
  const manifestPath = join(current.providerPath, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const invalidDeclarations = [
    "probe-dependency",
    [null],
    ["probe-dependency", "probe-dependency"],
    ["probe-transitive"],
  ];

  for (const declaration of invalidDeclarations) {
    await context.test(JSON.stringify(declaration), async () => {
      // Act
      manifest.omp.verificationDependencies = declaration;
      await writeJson(manifestPath, manifest);

      // Assert
      await assert.rejects(prepareGeneration({
        agentDir: current.agentDir,
      }), /verificationDependencies/);
    });
  }
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

test("when an opted-in provider is reinstalled during semantic review, evaluation and reporting retain the original standard", async context => {
  // Arrange
  const current = await fixture(context, {
    verificationDependencies: ["probe-dependency"],
  });
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
