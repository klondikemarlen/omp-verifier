import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
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

async function pathInventory(path) {
  const entries = [];
  let contentBytes = 0;
  async function visit(current, name) {
    if (entries.length >= MAX_ENTRIES) throw new Error(`Filesystem inventory exceeds ${MAX_ENTRIES} entries`);
    const info = await lstat(current);
    let kind;
    let content;
    if (info.isSymbolicLink()) {
      kind = "symlink";
      content = await readlink(current);
    } else if (info.isDirectory()) {
      kind = "directory";
    } else if (info.isFile()) {
      kind = "file";
      contentBytes += info.size;
      if (contentBytes > MAX_CONTENT_BYTES) throw new Error(`Filesystem inventory exceeds ${MAX_CONTENT_BYTES} content bytes`);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(current)) hash.update(chunk);
      content = hash.digest("hex");
    } else {
      throw new Error(`Unsupported filesystem entry: ${name}`);
    }
    const after = await lstat(current);
    if (info.ino !== after.ino || info.dev !== after.dev || info.size !== after.size || info.mtimeMs !== after.mtimeMs) {
      throw new Error(`Filesystem entry changed during observation: ${name}`);
    }
    entries.push([name, kind, String(info.dev), String(info.ino), info.mode, info.uid, info.gid, content]);
    if (kind === "directory") {
      const children = (await readdir(current)).sort();
      for (const child of children) await visit(join(current, child), join(name, child));
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

async function observePath(resource) {
  try {
    try {
      await lstat(resource.path);
    } catch (error) {
      if (error.code === "ENOENT") return {
        id: resource.id,
        present: false,
        identity: null,
      };
      throw error;
    }
    const inventory = await pathInventory(resource.path);
    return {
      id: resource.id,
      present: true,
      identity: inventory.fingerprint,
      details: {
        entries: inventory.entries,
        contentBytes: inventory.contentBytes,
      },
    };
  } catch (error) {
    return {
      id: resource.id,
      error: error.message,
    };
  }
}

async function observeResources(declaration) {
  const filesystem = declaration.resources.filter(resource => resource.kind === "path");
  const git = declaration.resources.filter(resource => resource.kind.startsWith("git-"));
  const docker = declaration.resources.filter(resource => resource.kind.startsWith("docker-"));
  const observations = [];
  for (const resource of filesystem) observations.push(await observePath(resource));
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
