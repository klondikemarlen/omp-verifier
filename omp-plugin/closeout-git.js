import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const maximumOutputBytes = 2 * 1024 * 1024;
const maximumInventoryPaths = 4096;
const outputDecoder = new TextDecoder("utf-8", {
  fatal: true,
});
const maximumFileBytes = 4 * 1024 * 1024;
const maximumInventoryBytes = 32 * 1024 * 1024;
const fullObjectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function validateGitResource(resource) {
  if (!resource || !["git-worktree", "git-ref", "git-remote-ref"].includes(resource.kind)) {
    throw new Error("Unsupported Git resource kind");
  }
  if (resource.kind === "git-worktree") {
    if (typeof resource.path !== "string" || !isAbsolute(resource.path) ||
        resource.path.length > 4096 || resource.path.includes("\0")) {
      throw new Error("Git worktree path must be a bounded absolute path");
    }
  } else {
    validateRef(resource.ref);
  }
  if (resource.kind === "git-remote-ref") validateRemote(resource.remote);
  if (resource.delivery !== undefined) {
    const delivery = resource.delivery;
    if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
      throw new Error("Git delivery must be an object");
    }
    for (const key of ["baseCommit", "tipCommit", "deliveredCommit"]) {
      if (typeof delivery[key] !== "string" || !fullObjectId.test(delivery[key])) {
        throw new Error(`Git delivery ${key} must be a full object ID`);
      }
    }
    if (delivery.deliveredBaseCommit !== undefined &&
        (typeof delivery.deliveredBaseCommit !== "string" || !fullObjectId.test(delivery.deliveredBaseCommit))) {
      throw new Error("Git delivery deliveredBaseCommit must be a full object ID");
    }
    validateRemote(delivery.remote);
    validateRef(delivery.targetRef);
  }
}

export async function observeGitResources({ repositoryRoot, resources }) {
  const observations = [];
  for (const resource of resources) {
    try {
      validateGitResource(resource);
      const commonDirectory = await repositoryCommonDirectory(repositoryRoot);
      const provenance = await repositoryProvenance(commonDirectory, repositoryRoot, resource);
      let observation;
      if (resource.kind === "git-worktree") {
        observation = await observeWorktree(repositoryRoot, commonDirectory, resource);
      } else if (resource.kind === "git-ref") {
        observation = await observeLocalRef(repositoryRoot, commonDirectory, resource);
      } else {
        observation = await observeRemoteRef(repositoryRoot, commonDirectory, resource);
      }
      observation.provenance = provenance;
      if (observation.present && resource.disposition === "absent" && !resource.delivery) {
        throw new Error("Present Git resource requires delivery proof before removal");
      }
      if (resource.delivery) {
        await verifyDelivery(repositoryRoot, resource.delivery, observation);
      }
      observations.push(observation);
    } catch (error) {
      observations.push({
        id: resource?.id,
        error: error.message,
      });
    }
  }
  return observations;
}

function validateRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith("refs/") || ref.length > 1024 ||
      /[~^:?*[\\]/.test(ref) || ref.includes("..") || ref.includes("@{") ||
      ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) {
    throw new Error("Git ref must be a fully qualified exact ref");
  }
  for (const character of ref) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) throw new Error("Git ref must be a fully qualified exact ref");
  }
}

function validateRemote(remote) {
  if (typeof remote !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(remote)) {
    throw new Error("Git remote must be a configured remote name");
  }
}

async function git(repositoryRoot, args, allowedExitCodes = [0]) {
  const env = {
    ...process.env,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  const argv = ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "protocol.ext.allow=never", "-C", repositoryRoot, ...args];
  try {
    const result = await execute("git", argv, {
      env,
      encoding: "buffer",
      timeout: 10000,
      maxBuffer: maximumOutputBytes,
    });
    return outputDecoder.decode(result.stdout);
  } catch (error) {
    if (typeof error.code === "number" && allowedExitCodes.includes(error.code)) return null;
    // Git's stderr can contain credential-bearing remote URLs or private file contents.
    throw new Error(`Git ${args[0]} observation unavailable (command failed or exceeded bounds)`, {
      cause: error,
    });
  }
}

async function repositoryCommonDirectory(repositoryRoot) {
  const directory = await git(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  try {
    const directoryPath = directory.replace(/\n$/, "");
    return await realpath(directoryPath);
  } catch {
    throw new Error("Git common directory identity unavailable");
  }
}

async function repositoryProvenance(commonDirectory, repositoryRoot, resource) {
  const metadata = await lstat(commonDirectory);
  const remotes = [];
  if (resource.kind === "git-remote-ref") remotes.push(resource.remote);
  if (resource.delivery) remotes.push(resource.delivery.remote);
  const remoteIdentities = [];
  for (const remote of [...new Set(remotes)].sort()) {
    const names = await git(repositoryRoot, ["remote"]);
    if (!names.split("\n").includes(remote)) throw new Error("Git remote is not configured");
    const urls = await git(repositoryRoot, ["remote", "get-url", "--all", remote]);
    const configurationHash = createHash("sha256").update(urls).digest("hex");
    remoteIdentities.push({
      remote,
      configurationHash,
    });
  }
  return {
    commonDirectory,
    device: metadata.dev,
    inode: metadata.ino,
    remotes: remoteIdentities,
  };
}

async function exactLocalRef(repositoryRoot, ref) {
  const exists = await git(repositoryRoot, ["show-ref", "--verify", "--quiet", ref], [0, 1]);
  if (exists === null) return null;
  const output = await git(repositoryRoot, ["rev-parse", "--verify", ref]);
  const objectId = output.trim();
  if (!fullObjectId.test(objectId)) throw new Error("Git ref returned an invalid object ID");
  return objectId;
}

async function exactRemoteRef(repositoryRoot, remote, ref) {
  const names = await git(repositoryRoot, ["remote"]);
  if (!names.split("\n").includes(remote)) throw new Error("Git remote is not configured");
  const output = await git(repositoryRoot, ["ls-remote", "--refs", "--", remote, ref]);
  const matches = output.trim().split("\n").filter(Boolean).map((line) => line.split("\t"));
  const exactMatches = matches.filter((entry) => entry[1] === ref);
  if (exactMatches.length === 0) return null;
  if (exactMatches.length !== 1 || !fullObjectId.test(exactMatches[0][0])) {
    throw new Error("Git remote returned an ambiguous ref identity");
  }
  return exactMatches[0][0];
}

async function observeLocalRef(repositoryRoot, commonDirectory, resource) {
  const objectId = await exactLocalRef(repositoryRoot, resource.ref);
  return {
    id: resource.id,
    present: objectId !== null,
    identity: {
      commonDirectory,
      ref: resource.ref,
      objectId,
    },
    details: {},
  };
}

async function observeRemoteRef(repositoryRoot, commonDirectory, resource) {
  const objectId = await exactRemoteRef(repositoryRoot, resource.remote, resource.ref);
  return {
    id: resource.id,
    present: objectId !== null,
    identity: {
      commonDirectory,
      remote: resource.remote,
      ref: resource.ref,
      objectId,
    },
    details: {},
  };
}

function nulPaths(output) {
  const paths = [...new Set(output.split("\0").filter(Boolean))].sort();
  if (paths.length > maximumInventoryPaths) throw new Error("Git inventory exceeds path bound");
  return paths;
}

async function observeWorktree(repositoryRoot, commonDirectory, resource) {
  const output = await git(repositoryRoot, ["worktree", "list", "--porcelain", "-z"]);
  const records = output.split("\0\0").filter(Boolean).map((record) => record.split("\0"));
  const path = resolve(resource.path);
  const registration = records.find((record) => record[0] === `worktree ${path}`);
  let pathExists = false;
  try {
    await lstat(path);
    pathExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error("Git worktree path observation unavailable", {
        cause: error,
      });
    }
  }
  if (pathExists && !registration) throw new Error("Existing path is not the exact registered Git worktree");
  let head = null;
  let contentFingerprint = null;
  let trackedChanges = [];
  let untrackedPaths = [];
  let ignoredPaths = [];
  if (registration) {
    const headField = registration.find((field) => field.startsWith("HEAD "));
    if (headField) head = headField.slice(5);
  }
  if (pathExists) {
    const observedCommonDirectory = await repositoryCommonDirectory(path);
    const topLevel = await git(path, ["rev-parse", "--show-toplevel"]);
    const topLevelPath = topLevel.replace(/\n$/, "");
    const canonicalTopLevel = await realpath(topLevelPath);
    const canonicalPath = await realpath(path);
    if (observedCommonDirectory !== commonDirectory || canonicalTopLevel !== canonicalPath) {
      throw new Error("Git worktree belongs to a different repository or checkout");
    }
    const headOutput = await git(path, ["rev-parse", "--verify", "HEAD"]);
    head = headOutput.trim();
    const trackedOutput = await git(path, ["ls-files", "--cached", "-z"]);
    const trackedPaths = nulPaths(trackedOutput);
    const statusFlags = await git(path, ["ls-files", "-v", "-z"]);
    if (statusFlags.split("\0").some((entry) => /^[a-zS]/.test(entry))) {
      throw new Error("Git tracked inventory has assume-unchanged or skip-worktree flags");
    }
    if (trackedPaths.length > 0) {
      const attributes = await git(path, ["check-attr", "-z", "filter", "--", ...trackedPaths]);
      const fields = attributes.split("\0");
      for (let index = 2; index < fields.length; index += 3) {
        if (fields[index] !== "unspecified" && fields[index] !== "unset") {
          throw new Error("Git tracked inventory requires an external content filter");
        }
      }
    }
    const workingChanges = await git(path, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD", "--"]);
    const indexChanges = await git(path, ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--name-only", "-z", "HEAD", "--"]);
    trackedChanges = nulPaths(workingChanges + indexChanges);
    const untrackedOutput = await git(path, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const ignoredOutput = await git(path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
    untrackedPaths = nulPaths(untrackedOutput);
    ignoredPaths = nulPaths(ignoredOutput);
    const indexEntries = await git(path, ["ls-files", "--stage", "-z"]);
    const inventory = nulPaths(trackedOutput + untrackedOutput + ignoredOutput);
    contentFingerprint = await fingerprintInventory(path, inventory, indexEntries);
  }
  const present = pathExists || Boolean(registration);
  return {
    id: resource.id,
    present,
    identity: {
      path,
      commonDirectory,
      registered: Boolean(registration),
      pathExists,
      head,
      contentFingerprint,
    },
    details: {
      trackedChanges,
      untrackedPaths,
      ignoredPaths,
    },
  };
}

async function fingerprintInventory(root, paths, indexEntries) {
  const hash = createHash("sha256");
  hash.update(indexEntries);
  let totalBytes = 0;
  for (const path of paths) {
    const filename = join(root, path);
    const contentHash = createHash("sha256");
    let metadata;
    try {
      metadata = await lstat(filename);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error("Git inventory metadata unavailable", {
          cause: error,
        });
      }
      const missingEntry = JSON.stringify([path, "missing"]);
      hash.update(missingEntry);
      continue;
    }
    let contentIdentity;
    if (metadata.isSymbolicLink()) {
      const target = await readlink(filename);
      totalBytes += Buffer.byteLength(target);
      contentIdentity = target;
    } else if (metadata.isFile()) {
      if (metadata.size > maximumFileBytes) throw new Error("Git inventory file exceeds byte bound");
      totalBytes += metadata.size;
      if (totalBytes > maximumInventoryBytes) throw new Error("Git inventory exceeds byte bound");
      const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const openedMetadata = await file.stat();
        if (openedMetadata.size !== metadata.size || openedMetadata.ino !== metadata.ino) {
          throw new Error("Git inventory changed during observation");
        }
        const bytes = Buffer.alloc(metadata.size + 1);
        const result = await file.read(bytes, 0, bytes.length, 0);
        const finalMetadata = await file.stat();
        if (result.bytesRead !== metadata.size || finalMetadata.size !== metadata.size ||
            finalMetadata.mtimeMs !== metadata.mtimeMs || finalMetadata.ctimeMs !== metadata.ctimeMs) {
          throw new Error("Git inventory changed during observation");
        }
        contentHash.update(bytes.subarray(0, result.bytesRead));
        contentIdentity = contentHash.digest("hex");
      } finally {
        await file.close();
      }
    } else {
      throw new Error("Git inventory contains an unsupported directory, submodule, or special file");
    }
    if (totalBytes > maximumInventoryBytes) throw new Error("Git inventory exceeds byte bound");
    const entry = JSON.stringify([path, metadata.mode, contentIdentity]);
    hash.update(entry);
  }
  return hash.digest("hex");
}

async function requireCommit(repositoryRoot, commit) {
  const output = await git(repositoryRoot, ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (output.trim() !== commit) throw new Error("Git delivery requires locally available commit objects");
}

async function isAncestor(repositoryRoot, ancestor, descendant) {
  const result = await git(repositoryRoot, ["merge-base", "--is-ancestor", ancestor, descendant], [0, 1]);
  return result !== null;
}

async function changedTreeEntries(repositoryRoot, base, tip) {
  const output = await git(repositoryRoot, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--raw", "--abbrev=64", "-z", base, tip, "--"]);
  const fields = output.split("\0");
  if (fields.pop() !== "" || fields.length % 2 !== 0) {
    throw new Error("Git delivery tree inventory is malformed");
  }
  if (fields.length / 2 > maximumInventoryPaths) {
    throw new Error("Git delivery tree inventory exceeds path bound");
  }
  const entries = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index].split(" ");
    const path = fields[index + 1];
    if (header.length !== 5 || !/^:[0-7]{6}$/.test(header[0]) ||
        !/^[0-7]{6}$/.test(header[1]) || !fullObjectId.test(header[2]) ||
        !fullObjectId.test(header[3]) || !/^[ADMT]$/.test(header[4]) || !path) {
      throw new Error("Git delivery tree inventory is malformed");
    }
    // Compare complete changed paths and their exact destination modes/object IDs,
    // not patch text, commit messages, or a subset of the task's changes.
    entries.push([path, header[1], header[3]]);
  }
  return JSON.stringify(entries);
}

async function verifyDelivery(repositoryRoot, delivery, observation) {
  const currentTip = observation.identity.head ?? observation.identity.objectId;
  if (observation.present && currentTip !== delivery.tipCommit) {
    throw new Error("Git delivery tip does not match current resource identity");
  }
  for (const commit of [delivery.baseCommit, delivery.tipCommit, delivery.deliveredCommit]) {
    await requireCommit(repositoryRoot, commit);
  }
  if (!await isAncestor(repositoryRoot, delivery.baseCommit, delivery.tipCommit)) {
    throw new Error("Git delivery base is not an ancestor of the original tip");
  }
  const remoteTip = await exactRemoteRef(repositoryRoot, delivery.remote, delivery.targetRef);
  if (!remoteTip) throw new Error("Git delivery remote target is absent");
  await requireCommit(repositoryRoot, remoteTip);
  if (!await isAncestor(repositoryRoot, delivery.deliveredCommit, remoteTip)) {
    throw new Error("Git delivery commit is not contained in the fresh remote target");
  }
  if (delivery.deliveredBaseCommit) {
    await requireCommit(repositoryRoot, delivery.deliveredBaseCommit);
    if (!await isAncestor(repositoryRoot, delivery.deliveredBaseCommit, delivery.deliveredCommit)) {
      throw new Error("Git delivered base is not an ancestor of the delivered commit");
    }
  }
  if (await isAncestor(repositoryRoot, delivery.tipCommit, delivery.deliveredCommit)) return;
  if (!delivery.deliveredBaseCommit) throw new Error("Rewritten Git delivery requires deliveredBaseCommit");
  const originalEntries = await changedTreeEntries(repositoryRoot, delivery.baseCommit, delivery.tipCommit);
  const deliveredEntries = await changedTreeEntries(repositoryRoot, delivery.deliveredBaseCommit, delivery.deliveredCommit);
  if (originalEntries !== deliveredEntries) {
    throw new Error("Rewritten Git delivery changed paths or exact tree content differ");
  }
}
