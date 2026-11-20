import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  activeGeneration,
  atomicJson,
  collectGenerations,
  generationDirectory,
  privateDirectory,
  readJson,
  withRuntimeLock,
} from "#root/bin/omp-verifier-runtime.mjs";
import { discoverVerificationChecks } from "#root/omp-plugin/verification-catalog.js";

const execute = promisify(execFile);
const sourcePackage = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

export function runtimePaths(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent")) {
  const directory = join(agentDir, "verifier");
  const root = join(directory, "runtime");
  const launcher = join(directory, "omp-verifier.mjs");
  const packageDirectory = join(dirname(agentDir), "plugins", "node_modules");
  return {
    root,
    launcher,
    packageDirectory,
  };
}

async function packageEntries(directory, coordinator) {
  const entries = await readdir(directory);
  if (!coordinator) {
    return entries.filter(name => name !== "node_modules" && name !== ".git").sort();
  }
  const manifest = await readJson(join(directory, "package.json"));
  const names = ["package.json", ...manifest.files.map(name => name.replace(/\/$/, ""))];
  if (names.some(name => name.includes("*") || name.includes("..") || isAbsolute(name))) {
    throw new Error("Coordinator package files must be explicit package-relative files or directories");
  }
  return [...new Set(names)].sort();
}

async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function inventory(directory, names) {
  names ??= await readdir(directory);
  const records = [];
  async function visit(name) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort()) {
        if (child !== "node_modules" && child !== ".git") {
          await visit(join(name, child));
        }
      }
    } else if (info.isSymbolicLink()) {
      const target = await readlink(path);
      const resolved = resolve(dirname(path), target);
      const boundary = relative(directory, resolved);
      if (isAbsolute(target) || boundary.startsWith("..") || isAbsolute(boundary)) {
        throw new Error(`Artifact symlink escapes its package: ${path}`);
      }
      records.push([name, "link", target]);
    } else if (info.isFile()) {
      const digest = await fileDigest(path);
      records.push([name, "file", digest, info.mode & 0o111]);
    } else {
      throw new Error(`Unsupported artifact file: ${path}`);
    }
  }
  for (const name of names.sort()) {
    await visit(name);
  }
  return records;
}

async function copyInventory(source, destination, records) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const [name, kind, target] of records) {
    const output = join(destination, name);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    if (kind === "link") {
      await symlink(target, output);
    } else {
      await copyFile(join(source, name), output);
    }
  }
}

async function dependencyDirectory(source, name, optional) {
  if (!validPackageName(name)) {
    throw new Error(`Invalid dependency name: ${name}`);
  }
  let current = source;
  for (;;) {
    const candidate = join(current, "node_modules", name);
    try {
      await lstat(join(candidate, "package.json"));
      return await realpath(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  if (!optional) {
    throw new Error(`Required artifact dependency ${name} is unavailable from ${source}`);
  }
  return undefined;
}

async function copyPackageFiles(source, directory, coordinator) {
  const key = createHash("sha256").update(source).digest("hex");
  const destination = join(directory, "packages", key);
  const names = await packageEntries(source, coordinator);
  const before = await inventory(source, names);
  const serialized = JSON.stringify(before);
  await copyInventory(source, destination, before);
  const after = await inventory(source, names);
  const captured = await inventory(destination);
  if (serialized !== JSON.stringify(after) || serialized !== JSON.stringify(captured)) {
    throw new Error(`Package changed during capture: ${source}; finish installation before preparing a generation`);
  }
  return {
    destination,
    names,
    inventory: serialized,
  };
}

function verificationDependencySelection(manifest, dependencies, source) {
  const selection = manifest.omp?.verificationDependencies;
  if (selection === undefined) {
    return undefined;
  }

  const field = `${join(source, "package.json")}: omp.verificationDependencies`;
  if (!Array.isArray(selection)) {
    throw new Error(`${field} must be an array of dependency names`);
  }

  const names = new Set();
  for (const name of selection) {
    if (!validPackageName(name)) {
      throw new Error(`${field} must contain valid package names`);
    }
    if (names.has(name)) {
      throw new Error(`${field} contains duplicate dependency ${name}`);
    }
    if (!Object.hasOwn(dependencies, name)) {
      throw new Error(`${field} names ${name}, which is not a declared runtime dependency`);
    }

    names.add(name);
  }
  return names;
}

async function copyPackage(source, directory, copied, role = "dependency") {
  const existing = copied.get(source);
  if (existing && role !== "provider" && !existing.selectedDependencies) {
    return existing.destination;
  }

  let captured = existing;
  if (!captured) {
    captured = await copyPackageFiles(source, directory, role === "coordinator");
    copied.set(source, captured);
  }

  const { destination } = captured;
  const manifest = await readJson(join(destination, "package.json"));
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  };
  let selection;
  if (role === "provider") {
    selection = verificationDependencySelection(manifest, dependencies, source);
    if (existing) {
      return destination;
    }
  }

  // A cycle can promote a provider while its root traversal still owns the selected links.
  // Publish full expansion before recursing and let the original traversal finish those links.
  const previousSelection = captured.selectedDependencies;
  captured.selectedDependencies = selection;

  const names = selection ? [...selection] : Object.keys(dependencies);
  for (const name of names.sort()) {
    if (previousSelection?.has(name)) {
      continue;
    }

    const optional = Object.hasOwn(manifest.optionalDependencies ?? {}, name) || manifest.peerDependenciesMeta?.[name]?.optional === true;
    const dependency = await dependencyDirectory(source, name, optional);
    if (!dependency) {
      continue;
    }
    const target = await copyPackage(dependency, directory, copied);
    const link = join(destination, "node_modules", name);
    await mkdir(dirname(link), { recursive: true, mode: 0o700 });
    await symlink(relative(dirname(link), target), link);
  }
  return destination;
}

async function generationInventory(directory) {
  // Package inventories exclude dependency directories; capture those links
  // separately so activation also authenticates the executable dependency graph.
  const records = [];
  async function visit(path) {
    for (const name of (await readdir(path)).sort()) {
      if (path === directory && ["generation.json", "leases"].includes(name)) {
        continue;
      }
      const file = join(path, name);
      const info = await lstat(file);
      const key = relative(directory, file);
      if (info.isDirectory()) {
        await visit(file);
      } else if (info.isSymbolicLink()) {
        const target = await readlink(file);
        const resolved = relative(directory, resolve(dirname(file), target));
        if (isAbsolute(target) || resolved.startsWith("..")) {
          throw new Error("Generation contains an external symlink");
        }
        records.push([key, "link", target]);
      } else if (info.isFile()) {
        const digest = await fileDigest(file);
        records.push([key, digest, info.mode & 0o111]);
      } else {
        throw new Error("Generation contains a non-artifact file");
      }
    }
  }
  await visit(directory);
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

function validPackageName(name) {
  return typeof name === "string" && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name);
}

async function providerRegistry(packageDirectory) {
  const path = join(dirname(packageDirectory), "package.json");
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const registry = JSON.parse(contents);
  if (registry.name !== "omp-plugins") {
    return contents;
  }
  for (const name of Object.keys(registry.dependencies ?? {})) {
    if (!validPackageName(name)) {
      throw new Error(`Invalid registered package name: ${name}`);
    }
    if (name === "omp-verifier") {
      continue;
    }
    await readJson(join(packageDirectory, name, "package.json"));
  }
  return contents;
}

export async function prepareGeneration({ agentDir, packageDirectory, coordinatorPackage = sourcePackage } = {}) {
  const paths = runtimePaths(agentDir);
  const providersDirectory = packageDirectory ?? paths.packageDirectory;
  await privateDirectory(paths.root);
  await privateDirectory(join(paths.root, "generations"));
  const id = randomUUID();
  const directory = generationDirectory(paths.root, id);
  await privateDirectory(directory);
  const copied = new Map();
  try {
    const registryBefore = await providerRegistry(providersDirectory);
    const catalog = await discoverVerificationChecks({ packageDirectory: providersDirectory });
    if (catalog.blockedResults.length) {
      throw new Error(JSON.stringify(catalog.blockedResults));
    }
    const providers = new Map();
    for (const check of catalog.checks) {
      if (!validPackageName(check.packageName)) {
        throw new Error("Invalid verification provider package name");
      }
      if (providers.has(check.packageName) && providers.get(check.packageName) !== check.packagePath) {
        throw new Error(`Multiple installations declare provider ${check.packageName}`);
      }
      providers.set(check.packageName, check.packagePath);
    }
    providers.set("omp-verifier", coordinatorPackage);
    const identities = [];
    for (const [name, packageSource] of providers) {
      const source = await realpath(packageSource);
      const role = name === "omp-verifier" ? "coordinator" : "provider";
      const target = await copyPackage(source, directory, copied, role);
      const manifest = await readJson(join(target, "package.json"));
      const link = join(directory, "node_modules", name);
      await mkdir(dirname(link), { recursive: true, mode: 0o700 });
      await symlink(relative(dirname(link), target), link);
      identities.push({
        package: manifest.name,
        version: manifest.version,
      });
    }
    for (const [source, captured] of copied) {
      const current = await inventory(source, captured.names);
      if (JSON.stringify(current) !== captured.inventory) {
        throw new Error(`Provider changed while staging: ${source}`);
      }
    }
    const registryAfter = await providerRegistry(providersDirectory);
    if (registryBefore !== registryAfter) {
      throw new Error("Plugin registration changed while preparing the generation");
    }
    const dependencies = Object.fromEntries([...providers.keys()].map(name => [name, "snapshot"]));
    const sourcePackagePath = resolve(coordinatorPackage);
    const providerPackageDirectory = resolve(providersDirectory);
    const registry = {
      name: "omp-plugins",
      dependencies,
    };
    await atomicJson(join(directory, "package.json"), registry);
    await privateDirectory(join(directory, "leases"));
    const digest = await generationInventory(directory);
    const identity = {
      id,
      digest,
      packages: identities,
    };
    const generation = {
      protocol: 1,
      id,
      identity,
      sourcePackage: sourcePackagePath,
      packageDirectory: providerPackageDirectory,
      activated: false,
    };
    await atomicJson(join(directory, "generation.json"), generation);
    await validateGeneration(paths.root, generation);
    return generation;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function validateGeneration(root, generation) {
  const directory = generationDirectory(root, generation.id);
  const digest = await generationInventory(directory);
  if (digest !== generation.identity.digest) {
    throw new Error("Generation artifacts changed after preparation");
  }
  const coordinator = join(directory, "node_modules", "omp-verifier", "bin", "omp-verifier.js");
  const packageDirectory = join(directory, "node_modules");
  const environment = {
    ...process.env,
    OMP_VERIFIER_PACKAGE_DIRECTORY: packageDirectory,
  };
  const result = await execute(process.execPath, [coordinator, "checks"], {
    env: environment,
    timeout: 30_000,
    maxBuffer: 1_000_000,
  });
  const catalog = JSON.parse(result.stdout);
  if (result.stderr || catalog.blockedResults.length || !catalog.checks.some(check => check.id === "verifier:project-lint")) {
    throw new Error("Candidate verification catalog failed validation");
  }
  const captured = await discoverVerificationChecks({ packageDirectory });
  for (const check of captured.checks) {
    if (check.mode === "agentic") {
      continue;
    }
    await execute(process.execPath, ["--check", check.entryPath], {
      timeout: 30_000,
    });
  }
}

export async function activateGeneration(id, { agentDir, onlyIfAbsent = false } = {}) {
  const paths = runtimePaths(agentDir);
  const directory = generationDirectory(paths.root, id);
  const generation = await readJson(join(directory, "generation.json"));
  if (generation.id !== id || generation.identity?.id !== id || generation.protocol !== 1) {
    throw new Error("Candidate generation identity is invalid");
  }
  await validateGeneration(paths.root, generation);
  return withRuntimeLock(paths.root, async () => {
    if (onlyIfAbsent) {
      try {
        return await activeGeneration(paths.root);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    generation.activated = true;
    await atomicJson(join(directory, "generation.json"), generation);
    await atomicJson(join(paths.root, "active.json"), {
      id,
    });
    return generation;
  });
}

export async function installRuntime(agentDir) {
  const paths = runtimePaths(agentDir);
  const parent = dirname(paths.root);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.getuid() || (parentInfo.mode & 0o022)) {
    throw new Error(`Runtime parent must be owned by the current user and not writable by others: ${parent}`);
  }
  const launcherSource = await readFile(new URL("../bin/omp-verifier-runtime.mjs", import.meta.url));
  let installedSource;
  try {
    installedSource = await readFile(paths.launcher);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (!installedSource?.equals(launcherSource)) {
    const temporary = `${paths.launcher}.${randomUUID()}.tmp`;
    await writeFile(temporary, launcherSource, {
      flag: "wx",
      mode: 0o700,
    });
    try {
      await rename(temporary, paths.launcher);
    } finally {
      await rm(temporary, {
        force: true,
      });
    }
  }
  try {
    return await activeGeneration(paths.root);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  const prepared = await prepareGeneration({ agentDir });
  return activateGeneration(prepared.id, { agentDir, onlyIfAbsent: true });
}

export async function generationCommand(args, agentDir) {
  const [action = "status", id] = args;
  if (args.length > 2) {
    throw new Error("Too many generation arguments");
  }
  const paths = runtimePaths(agentDir);
  if (process.env.OMP_VERIFIER_RUNTIME_ROOT && action === "prepare" && !id) {
    const current = await activeGeneration(paths.root);
    return prepareGeneration({
      agentDir,
      coordinatorPackage: current.sourcePackage,
      packageDirectory: current.packageDirectory,
    });
  }
  if (action === "prepare" && !id) {
    return prepareGeneration({
      agentDir,
    });
  }
  if (action === "activate" && id) {
    return activateGeneration(id, {
      agentDir,
    });
  }
  if (action === "status" && !id) {
    return activeGeneration(paths.root);
  }
  if (action === "collect" && !id) {
    return withRuntimeLock(paths.root, () => collectGenerations(paths.root));
  }
  throw new Error("Use generation prepare | activate <id> | status | collect");
}
