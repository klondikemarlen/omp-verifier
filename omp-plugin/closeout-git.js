import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const maximumOutputBytes = 2 * 1024 * 1024;
const maximumInventoryPaths = 4096;
const maximumLargeInventoryPaths = 16_384;
const maximumLargeInventoryDirectories = 16_384;
const maximumInventoryRecordBytes = 4096 + 128;
const maximumLargeOutputBytes = maximumLargeInventoryPaths * maximumInventoryRecordBytes * 3;
const outputDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
const maximumFileBytes = 4 * 1024 * 1024;
const maximumInventoryBytes = 32 * 1024 * 1024;
const maximumLargeFileBytes = 512 * 1024 * 1024;
const maximumLargeInventoryBytes = 1024 * 1024 * 1024;
const maximumLargeInventoryMs = 120_000;
const fileReadBufferBytes = 128 * 1024;
const largeInventoryTimeError = "Git inventory exceeds time bound (shared large worktree budget)";
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
  const largeBudget = {
    remainingBytes: maximumLargeInventoryBytes,
    remainingMs: maximumLargeInventoryMs,
  };
  for (const resource of resources) {
    const started = performance.now();
    const largeWorktree = resource?.kind === "git-worktree" && resource.largeWorktree === true;
    const deadline = largeWorktree ? started + largeBudget.remainingMs : Infinity;
    const runGit = (root, args, allowedExitCodes) => git(root, args, allowedExitCodes, deadline);
    try {
      validateGitResource(resource);
      const commonDirectory = await repositoryCommonDirectory(repositoryRoot, runGit);
      const provenance = await repositoryProvenance(commonDirectory, repositoryRoot, resource, runGit);
      let observation;
      if (resource.kind === "git-worktree") {
        const inventory = {
          budget: largeWorktree ? largeBudget : {
            remainingBytes: maximumInventoryBytes,
          },
          deadline,
          largeWorktree,
          maximumPaths: largeWorktree ? maximumLargeInventoryPaths : maximumInventoryPaths,
          maximumFileBytes: largeWorktree ? maximumLargeFileBytes : maximumFileBytes,
        };
        observation = await observeWorktree(repositoryRoot, commonDirectory, resource, inventory, runGit);
      } else if (resource.kind === "git-ref") {
        observation = await observeLocalRef(repositoryRoot, commonDirectory, resource, runGit);
      } else {
        observation = await observeRemoteRef(repositoryRoot, commonDirectory, resource, runGit);
      }
      observation.provenance = provenance;
      if (observation.present && resource.disposition === "absent" && !resource.delivery) {
        throw new Error("Present Git resource requires delivery proof before removal");
      }
      if (resource.delivery) {
        await verifyDelivery(repositoryRoot, resource.delivery, observation, runGit);
      }
      remainingTime(deadline);
      observations.push(observation);
    } catch (error) {
      observations.push({
        id: resource?.id,
        error: error.message,
      });
    } finally {
      if (largeWorktree) largeBudget.remainingMs -= performance.now() - started;
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

function gitInvocation(repositoryRoot, args) {
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
  return {
    argv,
    env,
  };
}

function remainingTime(deadline) {
  if (deadline === Infinity) return 10_000;

  const remainingMs = Math.ceil(deadline - performance.now());
  if (remainingMs <= 0) throw new Error(largeInventoryTimeError);

  return remainingMs;
}

async function git(repositoryRoot, args, allowedExitCodes = [0], deadline = Infinity) {
  const { argv, env } = gitInvocation(repositoryRoot, args);
  const timeout = remainingTime(deadline);
  try {
    const result = await execute("git", argv, {
      env,
      encoding: "buffer",
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: maximumOutputBytes,
    });
    remainingTime(deadline);
    return outputDecoder.decode(result.stdout);
  } catch (error) {
    remainingTime(deadline);
    if (typeof error.code === "number" && allowedExitCodes.includes(error.code)) return null;
    // Git's stderr can contain credential-bearing remote URLs or private file contents.
    throw new Error(`Git ${args[0]} observation unavailable (command failed or exceeded bounds)`, {
      cause: error,
    });
  }
}

async function repositoryCommonDirectory(repositoryRoot, runGit) {
  const directory = await runGit(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  try {
    const directoryPath = directory.replace(/\n$/, "");
    return await realpath(directoryPath);
  } catch {
    throw new Error("Git common directory identity unavailable");
  }
}

async function repositoryProvenance(commonDirectory, repositoryRoot, resource, runGit) {
  const metadata = await lstat(commonDirectory);
  const remotes = [];
  if (resource.kind === "git-remote-ref") remotes.push(resource.remote);
  if (resource.delivery) remotes.push(resource.delivery.remote);
  const remoteIdentities = [];
  for (const remote of [...new Set(remotes)].sort()) {
    const names = await runGit(repositoryRoot, ["remote"]);
    if (!names.split("\n").includes(remote)) throw new Error("Git remote is not configured");
    const urls = await runGit(repositoryRoot, ["remote", "get-url", "--all", remote]);
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

async function* gitInventoryRecords(root, args, options, input) {
  const { argv, env } = gitInvocation(root, args);
  const { deadline, largeWorktree } = options;
  const child = spawn("git", argv, {
    env,
    stdio: [input ? "pipe" : "ignore", "pipe", "ignore"],
    timeout: remainingTime(deadline),
    killSignal: "SIGKILL",
  });
  const completed = new Promise((resolve) => {
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
  const inputWritten = input ? pipeline(Readable.from(input), child.stdin).then(() => true, () => false) : true;
  const outputLimit = largeWorktree ? maximumLargeOutputBytes : maximumOutputBytes;
  let outputBytes = 0;
  let partialRecord = null;
  try {
    for await (const chunk of child.stdout) {
      remainingTime(deadline);
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) throw new Error("Git inventory command output exceeds byte bound");

      const records = partialRecord ? Buffer.concat([partialRecord, chunk]) : chunk;
      let start = 0;
      for (let end = records.indexOf(0); end !== -1; end = records.indexOf(0, start)) {
        if (end - start > maximumInventoryRecordBytes) throw new Error("Git inventory record exceeds byte bound");

        yield outputDecoder.decode(records.subarray(start, end));
        start = end + 1;
      }
      partialRecord = start < records.length ? records.subarray(start) : null;
      if (partialRecord?.length > maximumInventoryRecordBytes) {
        throw new Error("Git inventory record exceeds byte bound");
      }
    }
    const succeeded = await completed && await inputWritten;
    remainingTime(deadline);
    if (!succeeded) throw new Error(`Git ${args[0]} inventory unavailable (command failed or exceeded bounds)`);
    if (partialRecord) throw new Error("Git inventory command returned an incomplete record");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await completed;
    await inputWritten;
  }
}

function addInventoryPath(paths, path, maximumPaths) {
  if (isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Git inventory contains an invalid or unsupported path");
  }
  paths.add(path);
  if (paths.size > maximumPaths) throw new Error("Git inventory exceeds path bound");
}

async function inventoryPaths(root, args, options, paths = new Set()) {
  for await (const path of gitInventoryRecords(root, args, options)) {
    addInventoryPath(paths, path, options.maximumPaths);
  }
  return paths;
}

async function observeIndex(root, hash, options) {
  const trackedPaths = new Set();
  const entries = gitInventoryRecords(root, ["ls-files", "--cached", "--stage", "-v", "-z"], options);
  for await (const entry of entries) {
    if (/^[a-zS]/.test(entry)) {
      throw new Error("Git tracked inventory has assume-unchanged or skip-worktree flags");
    }
    const header = /^[HM] ([0-7]{6}) (?:[a-f0-9]{40}|[a-f0-9]{64}) [0-3]\t/.exec(entry);
    if (!header) throw new Error("Git tracked index inventory is malformed");
    if (options.largeWorktree && header[1] === "160000") {
      throw new Error("Git inventory contains an unsupported directory, submodule, or special file");
    }

    const path = entry.slice(header[0].length);
    addInventoryPath(trackedPaths, path, options.maximumPaths);

    // Drop the status prefix to preserve the version 1 `ls-files --stage -z` fingerprint.
    hash.update(entry.slice(2));
    hash.update("\0");
  }
  return trackedPaths;
}

function* nulPathInput(paths) {
  for (const path of paths) yield `${path}\0`;
}

async function requireNoContentFilters(root, trackedPaths, options) {
  if (trackedPaths.size === 0) return;

  const paths = trackedPaths.values();
  const args = ["check-attr", "-z", "--stdin", "filter"];
  const attributes = gitInventoryRecords(root, args, options, nulPathInput(trackedPaths));
  let field = 0;
  for await (const value of attributes) {
    if ((field === 0 && value !== paths.next().value) || (field === 1 && value !== "filter")) {
      throw new Error("Git tracked attribute inventory is malformed");
    }
    if (field === 2 && value !== "unspecified" && value !== "unset") {
      throw new Error("Git tracked inventory requires an external content filter");
    }
    field = (field + 1) % 3;
  }
  if (field !== 0 || !paths.next().done) throw new Error("Git tracked attribute inventory is incomplete");
}

function worktreeDetails(largeWorktree, trackedChanges, untrackedPaths, ignoredPaths) {
  if (largeWorktree) {
    return {
      trackedChangeCount: trackedChanges.size,
      untrackedCount: untrackedPaths.size,
      ignoredCount: ignoredPaths.size,
    };
  }
  return {
    trackedChanges: [...trackedChanges].sort(),
    untrackedPaths: [...untrackedPaths].sort(),
    ignoredPaths: [...ignoredPaths].sort(),
  };
}

async function observeInventory(root, head, options) {
  const hash = createHash("sha256");
  const paths = await observeIndex(root, hash, options);
  await requireNoContentFilters(root, paths, options);

  const diff = ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z"];
  if (options.largeWorktree) diff.push("--no-renames");

  const trackedChanges = await inventoryPaths(root, [...diff, head, "--"], options);
  await inventoryPaths(root, [...diff, "--cached", head, "--"], options, trackedChanges);
  const untrackedPaths = await inventoryPaths(root, ["ls-files", "--others", "--exclude-standard", "-z"], options);
  const ignoredPaths = await inventoryPaths(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], options);
  if (options.largeWorktree) {
    for (const path of trackedChanges) addInventoryPath(paths, path, options.maximumPaths);
  }
  for (const path of untrackedPaths) addInventoryPath(paths, path, options.maximumPaths);
  for (const path of ignoredPaths) addInventoryPath(paths, path, options.maximumPaths);

  const sortedPaths = [...paths].sort();
  const capturedPaths = await fingerprintContents(root, hash, sortedPaths, untrackedPaths, ignoredPaths, options);
  if (capturedPaths) await requireCompleteInventory(root, capturedPaths, options.deadline);

  return {
    contentFingerprint: hash.digest("hex"),
    details: worktreeDetails(options.largeWorktree, trackedChanges, untrackedPaths, ignoredPaths),
  };
}

async function exactLocalRef(repositoryRoot, ref, runGit) {
  const exists = await runGit(repositoryRoot, ["show-ref", "--verify", "--quiet", ref], [0, 1]);
  if (exists === null) return null;
  const output = await runGit(repositoryRoot, ["rev-parse", "--verify", ref]);
  const objectId = output.trim();
  if (!fullObjectId.test(objectId)) throw new Error("Git ref returned an invalid object ID");
  return objectId;
}

async function exactRemoteRef(repositoryRoot, remote, ref, runGit) {
  const names = await runGit(repositoryRoot, ["remote"]);
  if (!names.split("\n").includes(remote)) throw new Error("Git remote is not configured");
  const output = await runGit(repositoryRoot, ["ls-remote", "--refs", "--", remote, ref]);
  const matches = output.trim().split("\n").filter(Boolean).map((line) => line.split("\t"));
  const exactMatches = matches.filter((entry) => entry[1] === ref);
  if (exactMatches.length === 0) return null;
  if (exactMatches.length !== 1 || !fullObjectId.test(exactMatches[0][0])) {
    throw new Error("Git remote returned an ambiguous ref identity");
  }
  return exactMatches[0][0];
}

async function observeLocalRef(repositoryRoot, commonDirectory, resource, runGit) {
  const objectId = await exactLocalRef(repositoryRoot, resource.ref, runGit);
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

async function observeRemoteRef(repositoryRoot, commonDirectory, resource, runGit) {
  const objectId = await exactRemoteRef(repositoryRoot, resource.remote, resource.ref, runGit);
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

async function observeWorktree(repositoryRoot, commonDirectory, resource, options, runGit) {
  const output = await runGit(repositoryRoot, ["worktree", "list", "--porcelain", "-z"]);
  if (!output.endsWith("\0\0")) throw new Error("Git worktree registrations are malformed");

  const path = resolve(resource.path);
  const records = output.split("\0\0").filter(Boolean).map(record => record.split("\0"));
  const registrations = records.filter(record => record[0] === `worktree ${path}`);
  if (registrations.length > 1) throw new Error("Git worktree registration is ambiguous");

  const [registration] = registrations;
  const pathMetadata = await inventoryMetadata(path);
  const pathExists = Boolean(pathMetadata);
  if (pathExists && (!registration || !pathMetadata.isDirectory())) {
    throw new Error("Existing path is not the exact registered Git worktree");
  }
  let head = null;
  let contentFingerprint = null;
  let details;
  if (registration) {
    const headField = registration.find((field) => field.startsWith("HEAD "));
    if (headField) head = headField.slice(5);
  }
  if (pathExists) {
    const observedCommonDirectory = await repositoryCommonDirectory(path, runGit);
    const topLevel = await runGit(path, ["rev-parse", "--show-toplevel"]);
    const topLevelPath = topLevel.replace(/\n$/, "");
    const canonicalTopLevel = await realpath(topLevelPath);
    const canonicalPath = await realpath(path);
    if (observedCommonDirectory !== commonDirectory || canonicalTopLevel !== canonicalPath) {
      throw new Error("Git worktree belongs to a different repository or checkout");
    }
    const headOutput = await runGit(path, ["rev-parse", "--verify", "HEAD"]);
    head = headOutput.trim();
    if (!fullObjectId.test(head)) throw new Error("Git worktree returned an invalid HEAD object ID");

    ({ contentFingerprint, details } = await observeInventory(canonicalPath, head, options));
    const finalHead = await runGit(path, ["rev-parse", "--verify", "HEAD"]);
    const finalMetadata = await inventoryMetadata(path);
    if (finalHead.trim() !== head || !finalMetadata || finalMetadata.dev !== pathMetadata.dev ||
        finalMetadata.ino !== pathMetadata.ino) {
      throw new Error("Git worktree changed during observation");
    }
  } else {
    const empty = new Set();
    details = worktreeDetails(options.largeWorktree, empty, empty, empty);
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
    details,
  };
}

function chargeInventoryBytes(options, bytes) {
  if (bytes > options.maximumFileBytes) throw new Error("Git inventory file exceeds byte bound");
  if (bytes > options.budget.remainingBytes) {
    const suffix = options.largeWorktree ? " (shared large worktree budget)" : "";
    throw new Error(`Git inventory exceeds byte bound${suffix}`);
  }
  options.budget.remainingBytes -= bytes;
}

function requireSameEntry(before, after) {
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mode !== after.mode || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new Error("Git inventory changed during observation");
  }
}

const inventoryMetadataOptions = {
  bigint: true,
};

async function inventoryMetadata(filename) {
  try {
    return await lstat(filename, inventoryMetadataOptions);
  } catch (error) {
    if (error.code === "ENOENT") return null;

    throw new Error("Git inventory metadata unavailable", {
      cause: error,
    });
  }
}

async function fingerprintFile(filename, metadata, buffer, deadline) {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await open(filename, flags);
  try {
    requireSameEntry(metadata, await file.stat(inventoryMetadataOptions));
    const contentHash = createHash("sha256");
    const size = Number(metadata.size);
    let offset = 0;
    while (offset <= size) {
      remainingTime(deadline);
      const length = Math.min(buffer.length, size + 1 - offset);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      if (offset + bytesRead > size || (bytesRead === 0 && offset < size)) {
        throw new Error("Git inventory changed during observation");
      }
      if (bytesRead === 0) break;

      contentHash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    requireSameEntry(metadata, await file.stat(inventoryMetadataOptions));
    return contentHash.digest("hex");
  } finally {
    await file.close();
  }
}

async function fingerprintContents(root, hash, paths, untrackedPaths, ignoredPaths, options) {
  const capturedPaths = options.largeWorktree ? new Set() : null;
  let buffer;
  for (const path of paths) {
    remainingTime(options.deadline);
    const filename = join(root, path);
    const metadata = await inventoryMetadata(filename);
    if (!metadata) {
      if (untrackedPaths.has(path) || ignoredPaths.has(path)) {
        throw new Error("Git inventory changed during observation");
      }
      hash.update(JSON.stringify([path, "missing"]));
      continue;
    }
    const parent = dirname(filename);
    if (await realpath(parent) !== parent) {
      throw new Error("Git inventory contains a path through a symbolic link");
    }

    let contentIdentity;
    if (metadata.isSymbolicLink()) {
      const target = await readlink(filename, {
        encoding: "buffer",
      });
      chargeInventoryBytes(options, target.length);
      contentIdentity = options.largeWorktree ? target.toString("hex") : outputDecoder.decode(target);
    } else if (metadata.isFile()) {
      chargeInventoryBytes(options, Number(metadata.size));
      buffer ??= Buffer.allocUnsafe(fileReadBufferBytes);
      contentIdentity = await fingerprintFile(filename, metadata, buffer, options.deadline);
    } else {
      throw new Error("Git inventory contains an unsupported directory, submodule, or special file");
    }
    const finalMetadata = await inventoryMetadata(filename);
    if (!finalMetadata) throw new Error("Git inventory changed during observation");

    requireSameEntry(metadata, finalMetadata);
    hash.update(JSON.stringify([path, Number(metadata.mode), contentIdentity]));
    capturedPaths?.add(path);
  }
  return capturedPaths;
}

async function requireCompleteInventory(root, capturedPaths, deadline) {
  const directories = [""];
  let subdirectoryCount = 0;
  while (directories.length > 0) {
    remainingTime(deadline);
    const relativeDirectory = directories.pop();
    const filename = join(root, relativeDirectory);
    if (await realpath(filename) !== filename) {
      throw new Error("Git inventory contains a path through a symbolic link");
    }

    // Git can silently omit special files and inaccessible directories.
    const directory = await opendir(filename);
    for await (const entry of directory) {
      remainingTime(deadline);
      if (entry.name === ".git" && relativeDirectory === "") continue;

      const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        subdirectoryCount++;
        if (subdirectoryCount > maximumLargeInventoryDirectories) {
          throw new Error("Git inventory exceeds directory bound");
        }
        directories.push(path);
      } else if (!entry.isFile() && !entry.isSymbolicLink()) {
        throw new Error("Git inventory contains an unsupported directory, submodule, or special file");
      } else if (!capturedPaths.delete(path)) {
        throw new Error("Git inventory is incomplete or changed during observation");
      }
    }
  }
  if (capturedPaths.size > 0) throw new Error("Git inventory is incomplete or changed during observation");
}

async function requireCommit(repositoryRoot, commit, runGit) {
  const output = await runGit(repositoryRoot, ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (output.trim() !== commit) throw new Error("Git delivery requires locally available commit objects");
}

async function isAncestor(repositoryRoot, ancestor, descendant, runGit) {
  const result = await runGit(repositoryRoot, ["merge-base", "--is-ancestor", ancestor, descendant], [0, 1]);
  return result !== null;
}

async function changedTreeEntries(repositoryRoot, base, tip, runGit) {
  const output = await runGit(repositoryRoot, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames",
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

async function verifyDelivery(repositoryRoot, delivery, observation, runGit) {
  const currentTip = observation.identity.head ?? observation.identity.objectId;
  if (observation.present && currentTip !== delivery.tipCommit) {
    throw new Error("Git delivery tip does not match current resource identity");
  }
  for (const commit of [delivery.baseCommit, delivery.tipCommit, delivery.deliveredCommit]) {
    await requireCommit(repositoryRoot, commit, runGit);
  }
  if (!await isAncestor(repositoryRoot, delivery.baseCommit, delivery.tipCommit, runGit)) {
    throw new Error("Git delivery base is not an ancestor of the original tip");
  }
  const remoteTip = await exactRemoteRef(repositoryRoot, delivery.remote, delivery.targetRef, runGit);
  if (!remoteTip) throw new Error("Git delivery remote target is absent");
  await requireCommit(repositoryRoot, remoteTip, runGit);
  if (!await isAncestor(repositoryRoot, delivery.deliveredCommit, remoteTip, runGit)) {
    throw new Error("Git delivery commit is not contained in the fresh remote target");
  }
  if (delivery.deliveredBaseCommit) {
    await requireCommit(repositoryRoot, delivery.deliveredBaseCommit, runGit);
    if (!await isAncestor(repositoryRoot, delivery.deliveredBaseCommit, delivery.deliveredCommit, runGit)) {
      throw new Error("Git delivered base is not an ancestor of the delivered commit");
    }
  }
  if (await isAncestor(repositoryRoot, delivery.tipCommit, delivery.deliveredCommit, runGit)) return;
  if (!delivery.deliveredBaseCommit) throw new Error("Rewritten Git delivery requires deliveredBaseCommit");
  const originalEntries = await changedTreeEntries(repositoryRoot, delivery.baseCommit, delivery.tipCommit, runGit);
  const deliveredEntries = await changedTreeEntries(repositoryRoot, delivery.deliveredBaseCommit, delivery.deliveredCommit, runGit);
  if (originalEntries !== deliveredEntries) {
    throw new Error("Rewritten Git delivery changed paths or exact tree content differ");
  }
}
