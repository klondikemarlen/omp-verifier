import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { privateDirectory } from "#root/bin/omp-verifier-runtime.mjs";
import { acquireFileLease } from "#root/omp-plugin/file-lease.js";

const IMPLICIT_STATUS = "implicit-status";
const MAX_RECORD_BYTES = 4096;
const LEASE_WAIT_MS = 1000;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export function createVerifierCommandUsage(commandNames) {
  const countKeys = [IMPLICIT_STATUS, ...commandNames];

  return {
    async record(agentDir, submittedAction) {
      const countKey = submittedAction ?? IMPLICIT_STATUS;
      if (submittedAction !== undefined && !commandNames.includes(submittedAction)) {
        return false;
      }

      try {
        const directory = await usageDirectory(agentDir);
        await privateDirectory(directory);
        const lockFlags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
        const lock = await open(join(directory, "lock"), lockFlags, 0o600);
        try {
          if (!await acquireFileLease(lock, LEASE_WAIT_MS)) {
            return false;
          }

          const countsPath = join(directory, "counts.json");
          const snapshot = await readCounts(countsPath, countKeys) ?? {
            version: 1,
            startedAt: Date.now(),
            counts: Object.fromEntries(countKeys.map(key => [key, 0])),
          };
          const count = snapshot.counts[countKey];
          if (count === Number.MAX_SAFE_INTEGER) {
            return false;
          }

          snapshot.counts[countKey] = count + 1;
          await replaceCounts(countsPath, snapshot);
          return true;
        } finally {
          await lock.close();
        }
      } catch {
        // Collection is best-effort; it cannot prevent the requested command.
        return false;
      }
    },

    async report(agentDir, { invocationRecorded }) {
      let snapshot;
      try {
        const directory = await usageDirectory(agentDir);
        snapshot = await readCounts(join(directory, "counts.json"), countKeys);
      } catch {
        return "Verifier command usage\nLocal usage counts are unavailable.";
      }

      const lines = ["Verifier command usage"];
      if (!snapshot) {
        if (invocationRecorded === false) {
          lines.push("Local usage counts are unavailable; this invocation could not be recorded.");
        } else {
          lines.push("Observation has not begun; no interactive invocations have been recorded.");
        }
        return lines.join("\n");
      }

      const startedAt = new Date(snapshot.startedAt).toISOString();
      const reportedAt = new Date(Math.max(Date.now(), snapshot.startedAt)).toISOString();
      lines.push(`Observation period: ${startedAt} to ${reportedAt}`);
      lines.push("Recorded invocations across projects in this OMP profile (not outcomes).", "");
      lines.push(`Bare /verifier (implicit status): ${snapshot.counts[IMPLICIT_STATUS]}`);

      for (const commandName of commandNames) {
        lines.push(`${commandName}: ${snapshot.counts[commandName]}`);
      }

      lines.push("", "0 = not observed in this period. Status includes uses of this report.");
      if (invocationRecorded === false) {
        lines.push("This invocation could not be recorded.");
      }
      return lines.join("\n");
    },
  };
}

async function usageDirectory(agentDir) {
  const verifierDirectory = join(agentDir, "verifier");
  const info = await lstat(verifierDirectory);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o022)) {
    throw new Error("Verifier usage storage is not privately controlled.");
  }

  const canonicalDirectory = await realpath(verifierDirectory);
  let ancestor = canonicalDirectory;
  for (;;) {
    try {
      await lstat(join(ancestor, ".git"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      const parent = dirname(ancestor);
      if (parent === ancestor) {
        return join(canonicalDirectory, "command-usage");
      }

      ancestor = parent;
      continue;
    }
    throw new Error("Verifier usage storage must be outside a Git checkout.");
  }
}

async function readCounts(path, countKeys) {
  let file;
  try {
    const directory = await lstat(dirname(path));
    if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid())
      || (directory.mode & 0o077)) {
      throw new Error("Verifier usage directory is not private.");
    }
    file = await open(path, READ_FLAGS);
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  let contents;
  try {
    const info = await file.stat();
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid())
      || (info.mode & 0o077) || info.size > MAX_RECORD_BYTES) {
      throw new Error("Invalid verifier usage file.");
    }
    contents = await file.readFile("utf8");
  } finally {
    await file.close();
  }

  const snapshot = JSON.parse(contents);
  if (snapshot?.version !== 1 || Object.keys(snapshot).length !== 3
    || !Number.isSafeInteger(snapshot.startedAt) || snapshot.startedAt < 0 || snapshot.startedAt > 8.64e15
    || !snapshot.counts || Object.keys(snapshot.counts).length !== countKeys.length
    || countKeys.some(key => !Object.hasOwn(snapshot.counts, key)
      || !Number.isSafeInteger(snapshot.counts[key]) || snapshot.counts[key] < 0)) {
    throw new Error("Invalid verifier usage counts.");
  }
  return snapshot;
}

async function replaceCounts(path, snapshot) {
  // Keep one staging file, even after a process is killed. Only the lease holder can replace it.
  const stagedPath = `${path}.next`;
  await rm(stagedPath, { force: true });
  try {
    await writeFile(stagedPath, JSON.stringify(snapshot), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(stagedPath, path);
  } finally {
    await rm(stagedPath, { force: true });
  }
}

export default createVerifierCommandUsage;
