import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const RECORD_ID = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 8_000_000;

function recordId(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function owned(metadata) {
  return !process.getuid || metadata.uid === process.getuid();
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;

    return undefined;
  }
}

async function requireOutsideCheckout(path) {
  let ancestor = path;
  while (!(await lstatIfPresent(ancestor))) {
    ancestor = dirname(ancestor);
  }

  ancestor = await realpath(ancestor);
  for (;;) {
    if (await lstatIfPresent(join(ancestor, ".git"))) {
      throw new Error("Findings reports cannot be stored in a Git checkout");
    }

    const parent = dirname(ancestor);
    if (parent === ancestor) break;

    ancestor = parent;
  }
}

async function reportDirectory({ create }) {
  const agentPath = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"));
  const verifierPath = join(agentPath, "verifier");
  const directory = join(verifierPath, "findings-reports");
  await requireOutsideCheckout(verifierPath);
  if (create) {
    await mkdir(verifierPath, { mode: 0o700, recursive: true });
  }

  const verifier = await lstat(verifierPath);
  if (!verifier.isDirectory() || !owned(verifier) || (verifier.mode & 0o022)) {
    throw new Error("Unsafe Verifier data directory");
  }

  if (create) {
    await mkdir(directory, { mode: 0o700, recursive: true });
  }

  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || !owned(metadata) || (metadata.mode & 0o077)) {
    throw new Error("Findings report directory must be owner-only");
  }

  return directory;
}

export async function openFindingsReportStore({ create = false } = {}) {
  let directory;
  try {
    directory = await reportDirectory({ create });
  } catch {
    throw new Error("Private Verifier findings storage is unavailable in this OMP profile");
  }

  async function read(id, kind) {
    if (typeof id !== "string" || !RECORD_ID.test(id)) {
      throw new Error("Invalid findings identifier; copy the complete ID from Verifier");
    }

    try {
      const file = await open(join(directory, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || !owned(metadata) || (metadata.mode & 0o077) || metadata.size > MAX_RECORD_BYTES) {
          throw new Error("Unsafe findings record");
        }

        const bytes = await file.readFile();
        if (recordId(bytes) !== id) throw new Error("Findings record content changed");

        const record = JSON.parse(bytes);
        if (record.version !== 1 || record.kind !== kind) throw new Error("Unexpected findings record type");

        return record;
      } finally {
        await file.close();
      }
    } catch {
      throw new Error("Exact findings record is missing, unsafe, or invalid in this OMP profile");
    }
  }

  async function write(record) {
    const bytes = JSON.stringify(record);
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) throw new Error("Findings record exceeds the retention limit");

    const id = recordId(bytes);
    const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, bytes, { mode: 0o600, flag: "wx" });
    try {
      await link(temporaryPath, join(directory, `${id}.json`));
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw new Error("Couldn't retain the findings record", { cause: error });
      }

      await read(id, record.kind);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return id;
  }

  return { read, write };
}
