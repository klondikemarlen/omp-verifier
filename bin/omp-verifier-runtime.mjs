#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const GENERATION_ID = /^[a-f0-9-]{36}$/;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const execute = promisify(execFile);
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
    if (status !== 0) {
      throw new Error("Generation lock unavailable; install flock or finish the owning operation");
    }
    return await action();
  } finally {
    await handle.close();
  }
}

export function generationDirectory(root, id) {
  if (typeof id !== "string" || !GENERATION_ID.test(id)) {
    throw new Error("Invalid verifier generation identity");
  }
  return join(root, "generations", id);
}

export async function activeGeneration(root) {
  const pointer = await readJson(join(root, "active.json"));
  const directory = generationDirectory(root, pointer.id);
  const generation = await readJson(join(directory, "generation.json"));
  if (generation.id !== pointer.id || generation.protocol !== 1) {
    throw new Error("Incompatible verifier generation");
  }
  return generation;
}

async function directories(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function pendingReviews(root, id) {
  for (const project of await directories(join(root, "reviews", id))) {
    if (!project.isDirectory()) {
      return true;
    }
    const states = join(root, "reviews", id, project.name, "states");
    for (const entry of await directories(states)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        return true;
      }
      const state = await readJson(join(states, entry.name));
      if (state.consumed !== true) {
        return true;
      }
    }
  }
  return false;
}

// Caller holds the runtime lock: selection + lease creation cannot race disposal.
export async function collectGenerations(root) {
  const active = await activeGeneration(root);
  const removed = [];
  for (const entry of await directories(join(root, "generations"))) {
    if (!entry.isDirectory() || !GENERATION_ID.test(entry.name) || entry.name === active.id) {
      continue;
    }
    const directory = generationDirectory(root, entry.name);
    const generation = await readJson(join(directory, "generation.json"));
    if (!generation.activated) {
      continue;
    }
    // An abandoned lease can own surviving children. Retain it for explicit
    // operator recovery rather than guessing from a dead or reused PID.
    const leases = await directories(join(directory, "leases"));
    if (leases.length || await pendingReviews(root, entry.name)) {
      continue;
    }
    await rm(directory, { recursive: true });
    removed.push(entry.name);
  }
  return removed;
}

class InvalidReviewRequestPath extends Error {
  constructor(reason = "Invalid review request path or UUID.") {
    super(`${reason} Retry the last page footer's exact Next command, or copy the complete request path from the coordinator's response. Do not prepare a new review for this argument error.`);
  }
}

function reviewRequestArgument(args) {
  if (!["review", "evaluate", "diagnostics", "resume-checkpoint"].includes(args[0])) {
    return undefined;
  }
  for (const argument of args) {
    if (argument === "--") {
      break;
    }
    if (argument === "--help" || argument === "-h") {
      return undefined;
    }
  }
  if (!args[1]) {
    throw new InvalidReviewRequestPath();
  }
  return args[1];
}

function generationForRequestPath(root, requestPath) {
  const request = resolve(requestPath);
  const parts = relative(join(root, "reviews"), request).split("/");
  if (parts[0] === "..") {
    // A complete file from another runtime belongs to its original coordinator.
    if (!lstatSync(request, { throwIfNoEntry: false })?.isFile()) {
      throw new InvalidReviewRequestPath();
    }
    throw new Error("Request predates generation isolation or belongs to another runtime; use its original coordinator or prepare a fresh complete review");
  }
  // Only the generation prefix belongs to the launcher. Its coordinator owns the rest.
  if (!GENERATION_ID.test(parts[0]) || parts.length < 2) {
    throw new InvalidReviewRequestPath();
  }
  return parts[0];
}

async function checkoutNamespace() {
  // Match semantic-evaluations.js#currentRepositoryRoot and projectCacheDirectory.
  let root = await realpath(process.cwd());
  try {
    const { stdout } = await execute("git", ["-C", root, "rev-parse", "--show-toplevel"], {
      maxBuffer: 4_000_000,
    });
    root = await realpath(stdout.trim());
  } catch {
    // Non-git projects use the canonical working directory itself.
  }
  return createHash("sha256").update(root).digest("hex");
}

async function isDirectory(path) {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function findReviewRequest(root, namespace, requestId) {
  const generations = join(root, "generations");
  const reviews = join(root, "reviews");
  if (!await isDirectory(generations) || !await isDirectory(reviews)) {
    throw new InvalidReviewRequestPath();
  }

  const fileName = new RegExp(`^[A-Za-z0-9_-]+\\.${requestId}\\.json$`);
  let match;
  for (const generation of await directories(generations)) {
    if (!generation.isDirectory() || !GENERATION_ID.test(generation.name)) continue;

    const generationReviews = join(reviews, generation.name);
    const checkoutReviews = join(generationReviews, namespace);
    const requests = join(checkoutReviews, "requests");
    if (!await isDirectory(generationReviews) || !await isDirectory(checkoutReviews) || !await isDirectory(requests)) {
      continue;
    }

    for (const entry of await directories(requests)) {
      if (!entry.isFile() || !fileName.test(entry.name)) continue;

      if (match) {
        throw new InvalidReviewRequestPath("Ambiguous review request UUID in this checkout.");
      }
      match = {
        id: generation.name,
        path: join(requests, entry.name),
      };
    }
  }

  if (!match) {
    throw new InvalidReviewRequestPath("No exact review request UUID found in this checkout.");
  }
  return match;
}

export async function dispatchGeneration(root, args) {
  const boundReviewer = Boolean(process.env.OMP_VERIFIER_FRESH_REVIEWER);
  const request = reviewRequestArgument(args);
  let namespace;
  let requestPathGeneration;
  if (request) {
    if (!boundReviewer && request.length === 36 && REQUEST_ID.test(request)) {
      namespace = await checkoutNamespace();
    } else {
      requestPathGeneration = generationForRequestPath(root, request);
    }
  }

  let leasePath;
  let child;
  let completion;
  let cancellationSignal;

  function forwardCancellation(signal) {
    if (cancellationSignal) return;

    cancellationSignal = signal;
    child.kill(signal);
  }

  async function startCoordinator() {
    let requested = requestPathGeneration;
    let coordinatorArgs = args;
    if (namespace) {
      const match = await findReviewRequest(root, namespace, request);
      requested = match.id;
      coordinatorArgs = [args[0], match.path, ...args.slice(2)];
    }

    const active = await activeGeneration(root);
    const id = requested ?? active.id;
    const directory = generationDirectory(root, id);
    const generation = await readJson(join(directory, "generation.json"));
    if (generation.id !== id || generation.protocol !== 1 || !generation.activated) {
      throw new Error("Unavailable verifier generation");
    }
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
      OMP_VERIFIER_REQUEST_ID_ARGUMENT: boundReviewer ? "0" : "1",
      OMP_VERIFIER_PACKAGE_DIRECTORY: packageDirectory,
      PI_CODING_AGENT_DIR: agentDir,
    };
    leasePath = join(directory, "leases", `${randomUUID()}.json`);
    await atomicJson(leasePath, {
      pid: process.pid,
    });
    child = spawn(process.execPath, [coordinator, ...coordinatorArgs], {
      env: environment,
      stdio: "inherit",
    });
    completion = new Promise(accept => {
      child.once("exit", (code, signal) => accept({
        code,
        signal,
      }));
    });
    process.on("SIGINT", forwardCancellation);
    process.on("SIGTERM", forwardCancellation);
    await new Promise((accept, reject) => {
      child.once("spawn", accept);
      child.once("error", reject);
    });
  }

  try {
    await withRuntimeLock(root, startCoordinator);
    const { code, signal } = await completion;
    if (signal === "SIGINT" || signal === "SIGTERM") {
      cancellationSignal ??= signal;
    }
    return code ?? 1;
  } finally {
    try {
      if (leasePath) {
        await withRuntimeLock(root, async () => {
          await rm(leasePath, {
            force: true,
          });
        });
      }
    } finally {
      process.off("SIGINT", forwardCancellation);
      process.off("SIGTERM", forwardCancellation);
      if (cancellationSignal) process.kill(process.pid, cancellationSignal);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === ownPath) {
  const root = join(dirname(ownPath), "runtime");
  try {
    process.exitCode = await dispatchGeneration(root, process.argv.slice(2));
  } catch (error) {
    if (error instanceof InvalidReviewRequestPath) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`BLOCKED verifier:generation\n${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
