import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { acquireFileLease } from "#root/omp-plugin/file-lease.js";
import { verificationRestartIdentity } from "#root/omp-plugin/verification-restart-identity.js";

const restartContext = new AsyncLocalStorage();
const HASH = /^[a-f0-9]{64}$/;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const ATTEMPT_DIRECTORY = new RegExp(`^attempt-([a-f0-9]{64})-([0-9]{13})-${UUID}$`);
const TEMPORARY_FILE = new RegExp(`^\\.${UUID}\\.tmp$`);
const MAX_WORKSPACES = 32;
const MAX_UNITS = 256;
const MAX_UNIT_BYTES = 128 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const SAFE_OPEN = constants.O_NOFOLLOW | constants.O_NONBLOCK;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function owned(info, excludedMode = 0o077) {
  return info.uid === process.getuid() && (info.mode & excludedMode) === 0;
}

function requirePrivateFile(info, maxBytes) {
  if (!info.isFile() || !owned(info) || info.nlink !== 1 || info.size > maxBytes) {
    throw new Error("Not a private verifier restart file");
  }
}

async function requirePrivateDirectory(path, excludedMode = 0o077) {
  const info = await lstat(path);
  if (!info.isDirectory() || !owned(info, excludedMode) || await realpath(path) !== path) {
    throw new Error("Not a private verifier restart directory");
  }

  return info;
}

async function privateDirectory(path, excludedMode = 0o077) {
  await mkdir(path, {
    mode: 0o700,
    recursive: true,
  });
  return await requirePrivateDirectory(path, excludedMode);
}

function restartRoot() {
  const agent = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
  return resolve(agent, "verifier", "restarts");
}

async function requireOutsideCheckout(path) {
  let ancestor = path;
  for (;;) {
    try {
      if (await realpath(ancestor) !== ancestor) {
        throw new Error("Restart storage requires a canonical path");
      }

      break;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      ancestor = dirname(ancestor);
    }
  }
  for (;;) {
    try {
      await lstat(join(ancestor, ".git"));
      throw new Error("Restart storage must be outside a Git checkout");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return;

    ancestor = parent;
  }
}

async function takeLock(directory) {
  const flags = constants.O_RDWR | constants.O_CREAT | SAFE_OPEN;
  const file = await open(join(directory, "lock"), flags, 0o600);
  let held = false;
  try {
    requirePrivateFile(await file.stat(), 0);
    held = await acquireFileLease(file);
    if (held) {
      return file;
    }
  } finally {
    if (!held) {
      await file.close();
    }
  }
}

async function pruneWorkspaces(root, wanted) {
  const workspaces = [];
  for (const name of await readdir(root)) {
    if (name === wanted || !HASH.test(name)) {
      continue;
    }

    const path = join(root, name);
    try {
      const info = await requirePrivateDirectory(path);
      workspaces.push([path, info.mtimeMs]);
    } catch {
      // Do not operate on paths outside the restart directory contract.
    }
  }
  workspaces.sort((left, right) => left[1] - right[1]);
  let count = workspaces.length + 1;
  for (const [path, modified] of workspaces) {
    if (count <= MAX_WORKSPACES && Date.now() - modified <= MAX_AGE_MS) {
      break;
    }

    try {
      const lock = await takeLock(path);
      if (!lock) {
        continue;
      }

      try {
        await rm(path, {
          recursive: true,
          force: true,
        });
        count--;
      } finally {
        await lock.close();
      }
    } catch {
      // An unavailable workspace does not affect another workspace's verification.
    }
  }
  return count <= MAX_WORKSPACES;
}

async function openWorkspace(cwd) {
  const root = restartRoot();
  const key = digest(cwd);
  await requireOutsideCheckout(root);
  await privateDirectory(dirname(root), 0o022);
  await privateDirectory(root);
  const registry = await takeLock(root);
  if (!registry) return;

  try {
    const directory = join(root, key);
    await privateDirectory(directory);
    const lock = await takeLock(directory);
    if (!lock) return;

    let retained = false;
    try {
      retained = await pruneWorkspaces(root, key);
      if (retained) {
        return {
          directory,
          lock,
        };
      }
    } finally {
      if (!retained) {
        try {
          await rm(directory, {
            recursive: true,
            force: true,
          });
        } finally {
          await lock.close();
        }
      }
    }
  } finally {
    await registry.close();
  }
}

async function readFile(path, maxBytes) {
  const file = await open(path, constants.O_RDONLY | SAFE_OPEN);
  try {
    requirePrivateFile(await file.stat(), maxBytes);
    const data = await file.readFile("utf8");
    if (Buffer.byteLength(data) > maxBytes) {
      throw new Error("Verifier restart file exceeds size limit");
    }

    return data;
  } finally {
    await file.close();
  }
}

async function writePrivateFile(path, data) {
  await writeFile(path, data, {
    mode: 0o600,
    flag: "wx",
    flush: true,
  });
}

async function atomicWrite(directory, name, data) {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writePrivateFile(temporary, data);
    await rename(temporary, join(directory, name));
  } finally {
    await rm(temporary, {
      force: true,
    });
  }
}

function decodeUnit(name, text) {
  const { data, checksum } = JSON.parse(text);
  if (typeof data !== "string" || checksum !== digest(`${name}\0${data}`)) {
    throw new Error("Damaged verifier restart unit");
  }

  return JSON.parse(data);
}

function unitName(key) {
  if (typeof key !== "string" || !key.length) return;

  return `${digest(key)}.json`;
}

async function saveUnit(directory, name, value) {
  try {
    const data = JSON.stringify(value);
    if (data === undefined || Buffer.byteLength(data) > MAX_UNIT_BYTES) {
      return;
    }

    const text = JSON.stringify({
      data,
      checksum: digest(`${name}\0${data}`),
    });
    if (Buffer.byteLength(text) > MAX_UNIT_BYTES) return;

    // Reserve one slot for a simultaneous save by the built-in lint child.
    const names = await readdir(directory);
    if (names.length >= MAX_UNITS - 1 && !names.includes(name)) return;

    await atomicWrite(directory, name, text);
  } catch {
    // Running a real check must not depend on optional restart storage.
  }
}

function restartUnits(directory) {
  let lastSave = Promise.resolve();

  return {
    directory,
    async read(key) {
      const name = unitName(key);
      if (!name) return;

      try {
        return decodeUnit(name, await readFile(join(directory, name), MAX_UNIT_BYTES));
      } catch {
        return undefined;
      }
    },
    async save(key, value) {
      const name = unitName(key);
      if (!name) return;

      lastSave = lastSave.then(() => saveUnit(directory, name, value));
      await lastSave;
    },
  };
}

export function currentVerificationRestart() {
  return restartContext.getStore();
}

export async function openRestartUnits(directory) {
  if (typeof directory !== "string" || !ATTEMPT_DIRECTORY.test(basename(directory))) {
    return;
  }

  const workspace = dirname(directory);
  const root = restartRoot();
  if (dirname(workspace) !== root || !HASH.test(basename(workspace))) {
    return;
  }

  try {
    await requirePrivateDirectory(root);
    await requirePrivateDirectory(workspace);
    await requirePrivateDirectory(directory);
    return restartUnits(directory);
  } catch {
    return undefined;
  }
}

async function removeAttempts(workspace) {
  for (const name of await readdir(workspace)) {
    if (ATTEMPT_DIRECTORY.test(name)) {
      await rm(join(workspace, name), {
        recursive: true,
        force: true,
      });
    }
  }
}

async function beginAttempt(workspace, identity) {
  const names = (await readdir(workspace)).filter(name => ATTEMPT_DIRECTORY.test(name));
  const now = Date.now();
  if (names.length === 1) {
    const [name] = names;
    const [, previousIdentity, startedAt] = ATTEMPT_DIRECTORY.exec(name);
    const age = now - Number(startedAt);
    if (previousIdentity === identity && age >= 0 && age <= MAX_AGE_MS) {
      const previous = join(workspace, name);
      const directory = join(workspace, `attempt-${identity}-${startedAt}-${randomUUID()}`);
      await requirePrivateDirectory(previous);
      // A rename both preserves committed records and revokes the old child's
      // write path. Interruption before or after it leaves one recoverable name.
      await rename(previous, directory);
      for (const entry of await readdir(directory)) {
        if (TEMPORARY_FILE.test(entry)) {
          await rm(join(directory, entry), {
            force: true,
          });
        }
      }
      return restartUnits(directory);
    }
  }

  await removeAttempts(workspace);
  const directory = join(workspace, `attempt-${identity}-${now}-${randomUUID()}`);
  await mkdir(directory, {
    mode: 0o700,
  });
  return restartUnits(directory);
}

async function clearWorkspace(directory) {
  try {
    await removeAttempts(directory);
  } catch {
    // An inaccessible journal must not alter the check result.
  }
}

export async function withVerificationRestart({ cwd, command, scope, packageDirectory, signal, fresh = false }, execute) {
  let canonicalCwd;
  let workspace;
  try {
    canonicalCwd = await realpath(cwd);
    workspace = await openWorkspace(canonicalCwd);
  } catch {
    // No lease means this process must not read or modify restart data.
  }
  if (!workspace) {
    return await restartContext.run(undefined, execute);
  }

  try {
    let units;
    if (fresh) {
      await clearWorkspace(workspace.directory);
    }

    try {
      const identity = await verificationRestartIdentity({
        cwd: canonicalCwd,
        command,
        scope,
        packageDirectory,
      });
      units = await beginAttempt(workspace.directory, identity);
    } catch {
      if (!signal?.aborted) {
        await clearWorkspace(workspace.directory);
      }
    }
    return await restartContext.run(units, execute);
  } finally {
    try {
      if (!signal?.aborted) {
        await clearWorkspace(workspace.directory);
      }
    } finally {
      await workspace.lock.close().catch(() => {});
    }
  }
}
