import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  MAX_CLOSEOUT_PATH_LENGTH,
  MAX_CLOSEOUT_RECEIPTS,
  validateCloseoutInputs,
} from "#root/omp-plugin/closeout-summary.js";

// A JSON-escaped UTF-16 code unit needs at most six bytes, plus manifest framing.
const MAX_MANIFEST_BYTES = 6 * MAX_CLOSEOUT_PATH_LENGTH * (1 + MAX_CLOSEOUT_RECEIPTS) + 128;

export async function prepareCloseoutHandoff({ repositoryRoot, receiptPaths }) {
  const manifest = validatedManifest(repositoryRoot, receiptPaths);
  const content = serializeManifest(manifest);
  const id = digest(content);
  const { directory, uid } = await closeoutStorage({
    create: true,
  });
  const manifestPath = join(directory, `${id}.json`);
  const pendingPath = join(directory, `.pending-${randomUUID()}`);
  const pending = await open(pendingPath, "wx", 0o400);
  try {
    try {
      await pending.writeFile(content);
    } finally {
      await pending.close();
    }

    // Publish the completed bytes atomically without replacing a previous handoff.
    try {
      await link(pendingPath, manifestPath);
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      await readManifest(manifestPath, id, uid);
    }
  } finally {
    await unlink(pendingPath);
  }
  return id;
}

export async function readCloseoutHandoff(id) {
  if (typeof id !== "string" || id.length !== 64 || !/^[0-9a-f]{64}$/.test(id)) {
    throw new TypeError("Closeout handoff ID must be 64 lowercase hexadecimal characters");
  }

  try {
    const { directory, uid } = await closeoutStorage({
      create: false,
    });
    return await readManifest(join(directory, `${id}.json`), id, uid);
  } catch (error) {
    throw new Error("Could not resolve closeout handoff", {
      cause: error,
    });
  }
}

function validatedManifest(repositoryRoot, receiptPaths) {
  const exactReceiptPaths = validateCloseoutInputs(repositoryRoot, receiptPaths);
  return {
    repositoryRoot,
    receiptPaths: [...exactReceiptPaths],
  };
}

function serializeManifest(manifest) {
  return Buffer.from(JSON.stringify(manifest));
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function closeoutStorage({ create }) {
  if (typeof process.getuid !== "function" || !constants.O_NOFOLLOW || !constants.O_NONBLOCK) {
    throw new Error("Closeout handoffs require private POSIX filesystem storage");
  }

  const uid = process.getuid();
  const tempPath = tmpdir();
  if (!isAbsolute(tempPath)) {
    throw new Error("Closeout handoffs require an absolute temporary directory");
  }

  const tempDirectory = await realpath(tempPath);
  const parent = await lstat(tempDirectory);
  if (!parent.isDirectory() || (parent.uid !== 0 && parent.uid !== uid) ||
      ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0)) {
    throw new Error("Closeout handoff temporary directory is not trusted");
  }

  const directory = join(tempDirectory, `omp-verifier-closeouts-${uid}`);
  if (create) {
    try {
      await mkdir(directory, {
        mode: 0o700,
      });
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
  }

  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new Error("Closeout handoff directory is not privately owned");
  }

  return {
    directory,
    uid,
  };
}

async function readManifest(path, id, uid) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0 ||
        info.size < 1 || info.size > MAX_MANIFEST_BYTES) {
      throw new Error("Closeout handoff is not a bounded, privately owned regular file");
    }

    const buffer = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) {
        break;
      }

      size += bytesRead;
    }

    const content = buffer.subarray(0, size);
    if (size !== info.size || digest(content) !== id) {
      throw new Error("Closeout handoff does not match its ID");
    }

    const { repositoryRoot, receiptPaths } = JSON.parse(content.toString("utf8"));
    const manifest = validatedManifest(repositoryRoot, receiptPaths);
    if (!serializeManifest(manifest).equals(content)) {
      throw new Error("Closeout handoff has an invalid manifest");
    }

    return manifest;
  } finally {
    await file.close();
  }
}
