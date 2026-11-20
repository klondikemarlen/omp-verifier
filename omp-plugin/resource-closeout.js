import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { observeDockerResources, validateDockerResource } from "#root/omp-plugin/closeout-docker.js";
import { observeGitResources, validateGitResource } from "#root/omp-plugin/closeout-git.js";

const execute = promisify(execFile);
const STORAGE = join(tmpdir(), `omp-verifier-closeout-${process.getuid?.() ?? "user"}`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BYTES = 256_000;
const MAX_ENTRIES = 4_096;
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_LARGE_ARTIFACT_BYTES = 1024 ** 3;
const MAX_LARGE_ARTIFACT_MS = 60 * 1000;
const DEFAULT_BYTE_LIMIT = `Filesystem inventory exceeds ${MAX_CONTENT_BYTES} content bytes`;
const LARGE_ARTIFACT_BYTE_LIMIT = `Large artifact inventory exceeds ${MAX_LARGE_ARTIFACT_BYTES} content bytes across marked paths`;
const LARGE_ARTIFACT_TIME_LIMIT = `Large artifact inventory exceeded the ${MAX_LARGE_ARTIFACT_MS / 1000}-second observation limit across marked paths`;
const CHECK_ID = "verifier:resource-closeout";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 4_000) {
    throw new Error(`${name} must be nonempty bounded text`);
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 9 || (code > 10 && code < 32)) throw new Error(`${name} contains unsupported control characters`);
  }
}

function absolutePath(value, name) {
  text(value, name);
  if (!isAbsolute(value) || resolve(value) !== value) throw new Error(`${name} must be an absolute normalized path`);
}

function validateDeclaration(declaration) {
  if (declaration?.version !== 1) throw new Error("Closeout declaration must use version 1");
  text(declaration.taskId, "taskId");
  text(declaration.authorization, "authorization");
  absolutePath(declaration.repositoryRoot, "repositoryRoot");
  if (!Array.isArray(declaration.resources) || declaration.resources.length < 1 || declaration.resources.length > 64) {
    throw new Error("Declare between 1 and 64 exact resources, including resources that must be preserved");
  }
  const ids = new Set();
  const targets = new Set();
  for (const resource of declaration.resources) {
    text(resource?.id, "resource id");
    if (ids.has(resource.id)) throw new Error(`Duplicate resource id: ${resource.id}`);
    ids.add(resource.id);
    if (!["absent", "retained"].includes(resource.disposition)) throw new Error(`${resource.id}: invalid disposition`);
    if (!["task", "protected", "unknown"].includes(resource.ownership)) throw new Error(`${resource.id}: invalid ownership`);
    text(resource.ownershipEvidence, `${resource.id} ownership evidence`);
    text(resource.reason, `${resource.id} disposition reason`);
    if (resource.disposition === "absent" && resource.ownership !== "task") {
      throw new Error(`${resource.id}: absent disposition requires established task ownership; preserve uncertain/shared resources`);
    }
    if (resource.disposableContents !== undefined && resource.disposableContents !== true) {
      throw new Error(`${resource.id}: disposableContents must be true when explicitly authorized`);
    }
    if (Object.hasOwn(resource, "largeArtifact") && (resource.kind !== "path" || resource.largeArtifact !== true)) {
      throw new Error(`${resource.id}: largeArtifact must be true when supplied, and is only supported on path resources`);
    }
    if (resource.kind === "path") {
      absolutePath(resource.path, `${resource.id} path`);
    } else if (resource.kind?.startsWith("git-")) {
      validateGitResource(resource);
    } else if (resource.kind?.startsWith("docker-")) {
      validateDockerResource(resource);
    } else {
      throw new Error(`${resource.id}: unsupported resource kind`);
    }
    if (resource.path && resource.disposition === "absent") {
      const relativeRoot = relative(resource.path, declaration.repositoryRoot);
      if (!relativeRoot || (!relativeRoot.startsWith("..") && !isAbsolute(relativeRoot))) {
        throw new Error(`${resource.id}: the primary repository and its ancestors must be preserved`);
      }
      const relativeGit = relative(join(declaration.repositoryRoot, ".git"), resource.path);
      if (!relativeGit || (!relativeGit.startsWith("..") && !isAbsolute(relativeGit))) {
        throw new Error(`${resource.id}: repository metadata must be preserved`);
      }
    }
    const target = JSON.stringify([resource.kind, resource.path, resource.remote, resource.ref, resource.name]);
    if (targets.has(target)) throw new Error(`${resource.id}: resource identity is declared more than once`);
    targets.add(target);
  }
}

async function repositoryIdentity(path) {
  const root = await realpath(path);
  const result = await execute("git", ["-c", "core.hooksPath=/dev/null", "-C", root, "rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 16_000,
  });
  const [top, common] = result.stdout.trim().split("\n");
  if (await realpath(top) !== root) throw new Error("repositoryRoot must identify the complete primary checkout");
  const commonDirectory = await realpath(common);
  const info = await lstat(commonDirectory);
  return {
    root,
    commonDirectory,
    device: String(info.dev),
    inode: String(info.ino),
  };
}

async function boundedJson(path, privateFile = false) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error("Closeout input must be a bounded regular file");
  if (privateFile && ((info.mode & 0o077) !== 0 || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid()))) {
    throw new Error("Closeout receipt must be privately owned");
  }
  return JSON.parse(await readFile(path, "utf8"));
}

async function privateDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid()) || await realpath(path) !== resolve(path)) {
    throw new Error("Closeout storage must be a canonical privately owned directory");
  }
}

function sameObservedEntry(before, after) {
  return before.ino === after.ino && before.dev === after.dev && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function fingerprintFile(path, name, info, budget, signal) {
  if (info.size > budget.remainingBytes) {
    throw new Error(budget.byteLimitMessage);
  }

  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    signal?.throwIfAborted();
    const opened = await file.stat();
    signal?.throwIfAborted();
    if (!opened.isFile() || !sameObservedEntry(info, opened)) {
      throw new Error(`Filesystem entry changed during observation: ${name}`);
    }

    const hash = createHash("sha256");
    // Probe for unexpected trailing data when there is room, without exceeding the shared read limit.
    const readLimit = Math.min(info.size + 1, budget.remainingBytes);
    let bytesRead = 0;
    if (readLimit > 0) {
      // A failed stream can have buffered bytes it never yielded. Refund only after a complete read.
      budget.remainingBytes -= readLimit;
      const stream = file.createReadStream({
        start: 0,
        end: readLimit - 1,
        signal,
      });
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        bytesRead += chunk.length;
        if (bytesRead > info.size) {
          throw new Error(`Filesystem entry exceeded its observed size during the read: ${name}`);
        }

        hash.update(chunk);
      }
      budget.remainingBytes += readLimit - bytesRead;
    }

    if (bytesRead !== info.size) {
      throw new Error(`Filesystem entry ended before its observed size: ${name}`);
    }

    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

async function pathInventory(path, budget, signal) {
  const entries = [];
  let contentBytes = 0;
  async function visit(current, name) {
    signal?.throwIfAborted();
    if (entries.length >= MAX_ENTRIES) {
      throw new Error(`Filesystem inventory exceeds ${MAX_ENTRIES} entries`);
    }

    const info = await lstat(current);
    signal?.throwIfAborted();
    let kind;
    let content;
    if (info.isSymbolicLink()) {
      kind = "symlink";
      content = await readlink(current);
    } else if (info.isDirectory()) {
      kind = "directory";
    } else if (info.isFile()) {
      kind = "file";
      content = await fingerprintFile(current, name, info, budget, signal);
      contentBytes += info.size;
    } else {
      throw new Error(`Unsupported filesystem entry: ${name}`);
    }
    entries.push([name, kind, String(info.dev), String(info.ino), info.mode, info.uid, info.gid, content]);
    if (kind === "directory") {
      signal?.throwIfAborted();
      const children = await readdir(current);
      if (entries.length + children.length > MAX_ENTRIES) {
        throw new Error(`Filesystem inventory exceeds ${MAX_ENTRIES} entries`);
      }

      for (const child of children.sort()) {
        await visit(join(current, child), join(name, child));
      }
    }
    signal?.throwIfAborted();
    const after = await lstat(current);
    signal?.throwIfAborted();
    if (!sameObservedEntry(info, after)) {
      throw new Error(`Filesystem entry changed during observation: ${name}`);
    }
  }
  await visit(path, ".");
  const serialized = JSON.stringify(entries);
  return {
    fingerprint: digest(serialized),
    entries: entries.length,
    contentBytes,
  };
}

async function observePath(resource, budget, signal) {
  try {
    await lstat(resource.path);
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === "ENOENT") {
      return {
        id: resource.id,
        present: false,
        identity: null,
      };
    }

    throw error;
  }

  const inventory = await pathInventory(resource.path, budget, signal);
  return {
    id: resource.id,
    present: true,
    identity: inventory.fingerprint,
    details: {
      entries: inventory.entries,
      contentBytes: inventory.contentBytes,
    },
  };
}

async function observeLargeArtifact(resource, budget) {
  if (budget.remainingMs <= 0) {
    throw new Error(LARGE_ARTIFACT_TIME_LIMIT);
  }

  const startedAt = performance.now();
  const deadline = startedAt + budget.remainingMs;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(LARGE_ARTIFACT_TIME_LIMIT);
      reject(error);
      controller.abort(error);
    }, Math.ceil(budget.remainingMs));
  });

  try {
    const observation = await Promise.race([observePath(resource, budget, controller.signal), timeout]);
    if (performance.now() >= deadline) {
      throw new Error(LARGE_ARTIFACT_TIME_LIMIT);
    }

    return observation;
  } finally {
    clearTimeout(timer);
    budget.remainingMs -= performance.now() - startedAt;
  }
}

async function observeResources(declaration) {
  const filesystem = declaration.resources.filter(resource => resource.kind === "path");
  const git = declaration.resources.filter(resource => resource.kind.startsWith("git-"));
  const docker = declaration.resources.filter(resource => resource.kind.startsWith("docker-"));
  const observations = [];
  const largeArtifactBudget = {
    remainingBytes: MAX_LARGE_ARTIFACT_BYTES,
    remainingMs: MAX_LARGE_ARTIFACT_MS,
    byteLimitMessage: LARGE_ARTIFACT_BYTE_LIMIT,
  };
  for (const resource of filesystem) {
    try {
      let observation;
      if (resource.largeArtifact) {
        observation = await observeLargeArtifact(resource, largeArtifactBudget);
      } else {
        observation = await observePath(resource, {
          remainingBytes: MAX_CONTENT_BYTES,
          byteLimitMessage: DEFAULT_BYTE_LIMIT,
        });
      }
      observations.push(observation);
    } catch (error) {
      observations.push({
        id: resource.id,
        error: error.message,
      });
    }
  }
  if (git.length > 0) {
    const gitObservations = await observeGitResources({
      repositoryRoot: declaration.repositoryRoot,
      resources: git,
    });
    observations.push(...gitObservations);
  }
  if (docker.length > 0) {
    const dockerObservations = await observeDockerResources({
      repositoryRoot: declaration.repositoryRoot,
      resources: docker,
    });
    observations.push(...dockerObservations);
  }
  const byId = new Map(observations.map(observation => [observation.id, observation]));
  return declaration.resources.map(resource => byId.get(resource.id));
}

function prerequisites(declaration, observations) {
  const errors = [];
  for (const [index, resource] of declaration.resources.entries()) {
    const observation = observations[index];
    if (!observation || observation.error) {
      errors.push(`${resource.id}: ${observation?.error ?? "observation unavailable"}`);
      continue;
    }
    if (resource.disposition === "retained" && !observation.present) errors.push(`${resource.id}: required preserved resource is already absent`);
    if (resource.disposition !== "absent" || !observation.present) continue;
    if (observation.details?.trackedChanges?.length) errors.push(`${resource.id}: preserve uncommitted tracked changes before cleanup`);
    if ((observation.details?.untrackedPaths?.length || observation.details?.ignoredPaths?.length) && !resource.disposableContents) {
      errors.push(`${resource.id}: inventoried untracked/ignored contents need explicit disposableContents authorization`);
    }
  }
  return errors;
}

function blocked(error) {
  return {
    id: CHECK_ID,
    status: "BLOCKED",
    summary: "Final resource disposition cannot be established",
    evidence: error.message,
    nextCheck: "Restore the named evidence or access prerequisite; preserve uncertain resources. Prepare a new declaration when ownership or disposition changes.",
  };
}

export async function prepareResourceCloseout({ cwd, declarationPath }) {
  try {
    const declaration = await boundedJson(resolve(cwd, declarationPath));
    validateDeclaration(declaration);
    const repository = await repositoryIdentity(declaration.repositoryRoot);
    const currentRepository = await repositoryIdentity(cwd);
    if (repository.commonDirectory !== currentRepository.commonDirectory) throw new Error("Closeout must be prepared in its declared repository");
    const wrappers = [];
    const wrapperPaths = new Set(declaration.resources.filter(resource => resource.kind.startsWith("docker-")).map(resource => resource.wrapper));
    for (const path of wrapperPaths) {
      absolutePath(path, "Docker project wrapper");
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error("Docker cleanup requires a bounded existing project wrapper");
      const content = await readFile(path);
      const sha256 = digest(content);
      wrappers.push({
        path,
        sha256,
      });
    }
    const observations = await observeResources(declaration);
    const errors = prerequisites(declaration, observations);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    await mkdir(STORAGE, {
      recursive: true,
      mode: 0o700,
    });
    await privateDirectory(STORAGE);
    const id = randomUUID();
    const receiptPath = join(STORAGE, `${id}.json`);
    const capturedAt = new Date().toISOString();
    const payload = {
      version: 1,
      id,
      capturedAt,
      repository,
      declaration,
      wrappers,
      observations,
    };
    const serialized = JSON.stringify(payload);
    const sha256 = digest(serialized);
    const receipt = JSON.stringify({
      payload,
      sha256,
    });
    if (Buffer.byteLength(receipt) > MAX_BYTES) throw new Error(`Closeout inventory exceeds ${MAX_BYTES} bytes`);
    await writeFile(receiptPath, receipt, {
      flag: "wx",
      mode: 0o600,
    });
    return {
      status: "PREPARED",
      taskId: declaration.taskId,
      receiptPath,
      capturedAt,
      resourceCount: observations.length,
      nextCheck: "After authorized cleanup or retention, run closeout verify with this receipt; preparation is not PASS.",
    };
  } catch (error) {
    return blocked(error);
  }
}

async function readReceipt(cwd, receiptPath) {
  const path = resolve(cwd, receiptPath);
  if (dirname(path) !== STORAGE || !UUID.test(basename(path, ".json")) || !path.endsWith(".json")) {
    throw new Error("Closeout receipt is outside private closeout storage");
  }
  await privateDirectory(STORAGE);
  const record = await boundedJson(path, true);
  const serialized = JSON.stringify(record.payload);
  if (record.sha256 !== digest(serialized)) throw new Error("Closeout receipt changed after preparation");
  const payload = record.payload;
  if (payload.version !== 1 || payload.id !== basename(path, ".json") || !Array.isArray(payload.observations)) {
    throw new Error("Unsupported or incomplete closeout receipt");
  }
  validateDeclaration(payload.declaration);
  const repository = await repositoryIdentity(payload.declaration.repositoryRoot);
  if (JSON.stringify(repository) !== JSON.stringify(payload.repository)) throw new Error("Declared repository identity changed after capture");
  const currentRepository = await repositoryIdentity(cwd);
  if (currentRepository.commonDirectory !== repository.commonDirectory) throw new Error("Closeout must be checked in its declared repository");
  if (payload.observations.length !== payload.declaration.resources.length) throw new Error("Closeout baseline inventory is incomplete");
  return payload;
}

export async function verifyResourceCloseout({ cwd, receiptPath }) {
  try {
    const payload = await readReceipt(cwd, receiptPath);
    const observations = await observeResources(payload.declaration);
    const dispositions = [];
    let hasFailure = false;
    let hasBlocker = false;
    for (const [index, resource] of payload.declaration.resources.entries()) {
      const before = payload.observations[index];
      const current = observations[index];
      let status = "PASS";
      let disposition;
      let evidence;
      if (!before || before.id !== resource.id || !current || current.error) {
        status = "BLOCKED";
        evidence = current?.error ?? "Captured or current resource observation is unavailable";
      } else if (JSON.stringify(before.provenance) !== JSON.stringify(current.provenance)) {
        status = "BLOCKED";
        evidence = "Resource authority changed since capture; absence on another repository or Docker daemon is not disposal";
      } else if (resource.disposition === "absent") {
        if (current.present) {
          status = "FAIL";
          evidence = "Declared disposable resource remains present";
        } else {
          disposition = before.present ? "removed" : "already absent";
          evidence = resource.reason;
        }
      } else if (!current.present || JSON.stringify(before.identity) !== JSON.stringify(current.identity)) {
        status = "FAIL";
        evidence = "Required retained resource is missing or changed; investigate preservation before claiming closeout";
      } else {
        disposition = "intentionally retained";
        evidence = resource.reason;
      }
      if (status === "FAIL") hasFailure = true;
      if (status === "BLOCKED") hasBlocker = true;
      dispositions.push({
        id: resource.id,
        status,
        disposition,
        evidence,
      });
    }
    let status = "PASS";
    if (hasFailure) status = "FAIL";
    else if (hasBlocker) status = "BLOCKED";
    const evidence = dispositions.map(item => `${item.id}: ${item.disposition ?? item.status} — ${item.evidence}`).join("\n");
    const observedAt = new Date().toISOString();
    return {
      id: CHECK_ID,
      status,
      summary: status === "PASS" ? "Declared resource dispositions match fresh observations" : "Declared resource closeout is incomplete",
      evidence,
      taskId: payload.declaration.taskId,
      capturedAt: payload.capturedAt,
      observedAt,
      dispositions,
      ...(status === "PASS" ? {} : {
        nextCheck: "Resolve each resource finding through the authorized project workflow, then run a fresh closeout verify. Do not delete protected or uncertain resources.",
      }),
    };
  } catch (error) {
    return blocked(error);
  }
}
