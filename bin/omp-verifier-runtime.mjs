#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GENERATION_ID = /^[a-f0-9-]{36}$/;
const ownPath = fileURLToPath(import.meta.url);

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error(`Runtime directory must be private and owned by the current user: ${path}`);
  }
}

export async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// Linux flock binds the lock to this open file description. Kernel cleanup
// releases it after a crash; activation never depends on stale-lock deletion.
export async function withRuntimeLock(root, action) {
  await privateDirectory(root);
  const handle = await open(join(root, "lock"), "a", 0o600);
  try {
    const lock = spawn("flock", ["--exclusive", "--wait", "15", "3"], {
      stdio: ["ignore", "ignore", "ignore", handle.fd],
    });
    const status = await new Promise((accept, reject) => {
      lock.once("error", reject);
      lock.once("exit", accept);
    });
    if (status !== 0) throw new Error("Generation lock unavailable; install flock or finish the owning operation");
    return await action();
  } finally {
    await handle.close();
  }
}

export function generationDirectory(root, id) {
  if (typeof id !== "string" || !GENERATION_ID.test(id)) throw new Error("Invalid verifier generation identity");
  return join(root, "generations", id);
}

export async function activeGeneration(root) {
  const pointer = await readJson(join(root, "active.json"));
  const directory = generationDirectory(root, pointer.id);
  const generation = await readJson(join(directory, "generation.json"));
  if (generation.id !== pointer.id || generation.protocol !== 1) throw new Error("Incompatible verifier generation");
  return generation;
}

async function directories(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function pendingReviews(root, id) {
  for (const project of await directories(join(root, "reviews", id))) {
    if (!project.isDirectory()) return true;
    const states = join(root, "reviews", id, project.name, "states");
    for (const entry of await directories(states)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return true;
      const state = await readJson(join(states, entry.name));
      if (state.consumed !== true) return true;
    }
  }
  return false;
}

// Caller holds the runtime lock: selection + lease creation cannot race disposal.
export async function collectGenerations(root) {
  const active = await activeGeneration(root);
  const removed = [];
  for (const entry of await directories(join(root, "generations"))) {
    if (!entry.isDirectory() || !GENERATION_ID.test(entry.name) || entry.name === active.id) continue;
    const directory = generationDirectory(root, entry.name);
    const generation = await readJson(join(directory, "generation.json"));
    if (!generation.activated) continue;
    // An abandoned lease can own surviving children. Retain it for explicit
    // operator recovery rather than guessing from a dead or reused PID.
    const leases = await directories(join(directory, "leases"));
    if (leases.length || await pendingReviews(root, entry.name)) continue;
    await rm(directory, { recursive: true });
    removed.push(entry.name);
  }
  return removed;
}

function requestedGeneration(root, args) {
  if (!["review", "evaluate", "diagnostics"].includes(args[0])) return undefined;
  for (const argument of args) {
    if (argument === "--") break;
    if (argument === "--help" || argument === "-h") return undefined;
  }
  if (!args[1]) throw new Error("A review operation requires its request path");
  const request = resolve(args[1]);
  const parts = relative(join(root, "reviews"), request).split("/");
  if (parts.length !== 4 || !GENERATION_ID.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1]) || parts[2] !== "requests") {
    throw new Error("Request predates generation isolation or belongs to another runtime; use its original coordinator or prepare a fresh complete review");
  }
  return parts[0];
}

export async function dispatchGeneration(root, args) {
  let leasePath;
  let child;
  let completion;
  await withRuntimeLock(root, async () => {
    const requested = requestedGeneration(root, args);
    const active = await activeGeneration(root);
    const id = requested ?? active.id;
    const directory = generationDirectory(root, id);
    const generation = await readJson(join(directory, "generation.json"));
    if (generation.id !== id || generation.protocol !== 1 || !generation.activated) throw new Error("Unavailable verifier generation");
    const coordinator = join(directory, "node_modules", "omp-verifier", "bin", "omp-verifier.js");
    const cache = join(root, "reviews", id);
    const launcher = join(dirname(root), "omp-verifier.mjs");
    const identity = JSON.stringify(generation.identity);
    const packageDirectory = join(directory, "node_modules");
    const agentDir = dirname(dirname(root));
    const environment = {
      ...process.env,
      OMP_VERIFIER_RUNTIME_ROOT: root,
      OMP_VERIFIER_GENERATION: identity,
      OMP_VERIFIER_SEMANTIC_CACHE: cache,
      OMP_VERIFIER_COORDINATOR: launcher,
      OMP_VERIFIER_PACKAGE_DIRECTORY: packageDirectory,
      PI_CODING_AGENT_DIR: agentDir,
    };
    leasePath = join(directory, "leases", `${randomUUID()}.json`);
    await atomicJson(leasePath, {
      pid: process.pid,
    });
    child = spawn(process.execPath, [coordinator, ...args], {
      env: environment,
      stdio: "inherit",
    });
    completion = new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => accept(code ?? 1));
    });
    await new Promise((accept, reject) => {
      child.once("spawn", accept);
      child.once("error", reject);
    });
  });
  const status = await completion;
  await withRuntimeLock(root, async () => {
    await rm(leasePath, { force: true });
  });
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === ownPath) {
  const root = join(dirname(ownPath), "runtime");
  try {
    process.exitCode = await dispatchGeneration(root, process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`BLOCKED verifier:generation\n${error.message}\n`);
    process.exitCode = 1;
  }
}
